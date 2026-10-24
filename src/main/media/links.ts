import type { Platform } from '@shared/types'
import { PLATFORMS } from '@shared/types'
import { AuthExpired, ChallengeRequired, RateLimited } from '../adapters/http'
import type { NormalizedPage } from '../adapters/types'
import { THUMB_AWAITING_LINK } from '../db/media-upsert'
import type { ThumbnailLinkRow } from '../db/queries'
import { isMediaUrlExpired } from './freshness'

/**
 * Le renouvellement des liens média, à un seul endroit et à un rythme tenu.
 *
 * Instagram signe ses liens de CDN pour quelques jours ; `refreshPost` redemande le post et
 * rapporte des liens frais (voir SPEC.md §5). Deux défauts tenaient à la façon de l'appeler :
 *
 * - **la lecture le rappelait sans frein.** Le lecteur vidéo émet une requête par plage, et
 *   chacune revérifie le lien. Après un renouvellement raté, chacune relançait donc
 *   `/media/info` — des dizaines d'appels pour une seule vidéo, hors de toute temporisation, y
 *   compris sur un compte qu'Instagram venait de mettre en vérification ;
 * - **les vignettes ne l'appelaient jamais.** Un lien périmé devenait un 403, compté comme un
 *   échec ; trois échecs, et la vignette était abandonnée pour de bon.
 *
 * D'où un registre unique. La lecture, geste de l'utilisateur, passe tout de suite. Les
 * vignettes passent par une file courte — ce qui est à l'écran, pas l'historique entier —, une
 * requête à la fois, avec les pauses du moteur de synchronisation et un plafond horaire : faire
 * défiler un mur ancien ne déclenche pas des centaines d'appels. Et rien ne part vers un compte
 * en vérification de sécurité : c'est exactement le comportement qui transforme une
 * vérification en blocage (SPEC.md §6).
 */

type FreshPost = Pick<NormalizedPage, 'posts' | 'media'>

/**
 * Au plus autant d'appels par heure qu'une synchronisation complète fait de pages par session
 * (`SYNC_PAGE_LIMITS`). Chaque appel ne renouvelle qu'un post, là où une page en rapporte une
 * vingtaine : pour tout un historique, « Re-vérifier toute la bibliothèque » reste la voie.
 */
export const LINK_REFRESH_HOURLY_CAP = 120

/** Ce qui compte, c'est ce qu'on regarde : au-delà, l'utilisateur a déjà fait défiler. */
export const LINK_REFRESH_QUEUE = 40

/** La grille envoie jusqu'à mille identifiants, les plus proches d'abord. */
const REQUEST_WINDOW = 120

/** Court, pour qu'un réseau revenu se voie vite ; assez pour qu'un lecteur ne martèle pas. */
export const LINK_FAILURE_COOLDOWN_MS = 2 * 60 * 1000
/** Un lien tout juste renouvelé qui paraîtrait encore périmé ne se redemande pas en boucle. */
const SUCCESS_COOLDOWN_MS = 30 * 60 * 1000
/** Session expirée : chaque appel échouerait pareil, jusqu'à ce que l'utilisateur reconnecte. */
const AUTH_BACKOFF_MS = 10 * 60 * 1000
const RATE_BACKOFF_MIN_MS = 60 * 1000
const RATE_BACKOFF_MAX_MS = 15 * 60 * 1000
/** Une synchronisation en cours rapporte elle-même des liens frais, et a sa propre cadence. */
const SYNC_RETRY_MS = 30 * 1000
const HOUR_MS = 60 * 60 * 1000

export interface LinkRefresherDeps {
  /** Redemande le post ; `null` si sa plateforme ne sait pas renouveler un lien. */
  fetch(platform: Platform, nativeId: string): Promise<FreshPost | null>
  /** La plateforme sait-elle renouveler, et son compte est-il connecté ? */
  available(platform: Platform): Promise<boolean>
  /** Le dernier état de synchronisation du compte (`'challenge'`, `'ok'`…). */
  accountStatus(platform: Platform): string | null
  syncing(platform: Platform): boolean
  /** Les vignettes manquantes de ces posts, avec leur lien. */
  thumbnailLinks(postIds: string[]): ThumbnailLinkRow[]
  /** Réenregistre les liens, sans rien toucher d'autre du post. */
  save(fresh: FreshPost): void
  /** Retient la vérification de sécurité, pour que rien d'automatique ne revienne la heurter. */
  markChallenge(platform: Platform): void
  /** La pause entre deux renouvellements de fond. */
  pause(platform: Platform): Promise<void>
  now(): number
}

/** Une vignette attend-elle un lien neuf ? Soit on l'a déjà mise de côté, soit son lien a passé. */
export function needsFreshLink(row: ThumbnailLinkRow, now: number): boolean {
  return row.thumb_attempts === THUMB_AWAITING_LINK || isMediaUrlExpired(row.remote_url, 60_000, now)
}

function platformOf(postId: string): Platform | null {
  const prefix = postId.slice(0, postId.indexOf(':'))
  return PLATFORMS.includes(prefix as Platform) ? (prefix as Platform) : null
}

export class LinkRefresher {
  private readonly cooldown = new Map<string, number>()
  private readonly inFlight = new Map<string, Promise<boolean>>()
  private readonly queues = new Map<Platform, string[]>()
  private readonly pumping = new Set<Platform>()
  private readonly calls = new Map<Platform, number[]>()
  private readonly blockedUntil = new Map<Platform, number>()
  private readonly timers = new Map<Platform, ReturnType<typeof setTimeout>>()
  private readonly listeners = new Set<(postIds: string[]) => void>()
  private warnings = 0

  constructor(private readonly deps: LinkRefresherDeps) {}

  /** Prévenu après chaque renouvellement réussi : la file média peut reprendre ces posts. */
  onRefreshed(listener: (postIds: string[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Pour la lecture : un geste de l'utilisateur, donc tout de suite, hors file et hors plafond
   * — mais jamais vers un compte en vérification, et pas deux fois de suite après un échec.
   * Les appels concurrents pour un même post partagent le même renouvellement.
   */
  async refreshNow(postId: string): Promise<boolean> {
    const platform = platformOf(postId)
    if (!platform) return false
    const pending = this.inFlight.get(postId)
    if (pending) return pending
    if (!this.allowed(platform, postId)) return false
    if (!(await this.deps.available(platform))) return false
    return this.run(platform, postId)
  }

  /**
   * Pour les vignettes regardées : ne retient que celles dont le lien a passé, les place en
   * tête de file — la grille les envoie de la plus proche à la plus lointaine — et laisse la
   * file les renouveler au rythme de leur plateforme.
   */
  request(postIds: string[]): void {
    const candidates = postIds.slice(0, REQUEST_WINDOW)
    if (candidates.length === 0) return
    const now = this.deps.now()
    const wanted = new Set(
      this.deps
        .thumbnailLinks(candidates)
        .filter((row) => needsFreshLink(row, now))
        .map((row) => row.post_id)
    )
    if (wanted.size === 0) return

    const byPlatform = new Map<Platform, string[]>()
    for (const id of candidates) {
      if (!wanted.has(id) || this.inFlight.has(id)) continue
      const platform = platformOf(id)
      if (!platform || !this.allowed(platform, id)) continue
      const list = byPlatform.get(platform) ?? []
      if (!list.includes(id)) list.push(id)
      byPlatform.set(platform, list)
    }
    for (const [platform, ids] of byPlatform) {
      const previous = (this.queues.get(platform) ?? []).filter((id) => !ids.includes(id))
      this.queues.set(platform, [...ids, ...previous].slice(0, LINK_REFRESH_QUEUE))
      void this.pump(platform)
    }
  }

  /** Ce qui attend encore, par plateforme. */
  queued(platform: Platform): number {
    return this.queues.get(platform)?.length ?? 0
  }

  private allowed(platform: Platform, postId: string): boolean {
    if (this.deps.accountStatus(platform) === 'challenge') return false
    const now = this.deps.now()
    if ((this.blockedUntil.get(platform) ?? 0) > now) return false
    return (this.cooldown.get(postId) ?? 0) <= now
  }

  private async pump(platform: Platform): Promise<void> {
    if (this.pumping.has(platform)) return
    this.pumping.add(platform)
    try {
      for (;;) {
        const queue = this.queues.get(platform)
        if (!queue || queue.length === 0) return
        if (this.deps.accountStatus(platform) === 'challenge') {
          this.queues.delete(platform)
          return
        }
        const wait = this.waitBeforeNext(platform)
        if (wait > 0) {
          this.retryIn(platform, wait)
          return
        }
        if (!(await this.deps.available(platform))) {
          this.queues.delete(platform)
          return
        }
        const postId = queue.shift()!
        if (!this.allowed(platform, postId) || this.inFlight.has(postId)) continue
        /* Une synchronisation a pu rapporter un lien neuf pendant que le post attendait. */
        const now = this.deps.now()
        if (!this.deps.thumbnailLinks([postId]).some((row) => needsFreshLink(row, now))) continue
        await this.run(platform, postId)
        await this.deps.pause(platform)
      }
    } finally {
      this.pumping.delete(platform)
    }
  }

  private waitBeforeNext(platform: Platform): number {
    const now = this.deps.now()
    const blocked = (this.blockedUntil.get(platform) ?? 0) - now
    if (blocked > 0) return blocked
    if (this.deps.syncing(platform)) return SYNC_RETRY_MS
    const recent = this.recentCalls(platform, now)
    if (recent.length >= LINK_REFRESH_HOURLY_CAP) return recent[0] + HOUR_MS - now + 1000
    return 0
  }

  private retryIn(platform: Platform, ms: number): void {
    if (this.timers.has(platform)) return
    const timer = setTimeout(() => {
      this.timers.delete(platform)
      void this.pump(platform)
    }, ms)
    timer.unref?.()
    this.timers.set(platform, timer)
  }

  private recentCalls(platform: Platform, now: number): number[] {
    const kept = (this.calls.get(platform) ?? []).filter((at) => now - at < HOUR_MS)
    this.calls.set(platform, kept)
    return kept
  }

  private run(platform: Platform, postId: string): Promise<boolean> {
    const existing = this.inFlight.get(postId)
    if (existing) return existing
    const started = this.deps.now()
    /* La lecture compte aussi : elle passe devant, mais les vignettes lui cèdent la place. */
    this.recentCalls(platform, started).push(started)
    const nativeId = postId.slice(postId.indexOf(':') + 1)

    const pending = (async (): Promise<boolean> => {
      try {
        const fresh = await this.deps.fetch(platform, nativeId)
        if (!fresh) {
          this.cooldown.set(postId, this.deps.now() + LINK_FAILURE_COOLDOWN_MS)
          return false
        }
        if (fresh.posts.length > 0) this.deps.save(fresh)
        this.cooldown.set(postId, this.deps.now() + SUCCESS_COOLDOWN_MS)
        for (const listener of this.listeners) listener([postId])
        return true
      } catch (error) {
        const now = this.deps.now()
        this.cooldown.set(postId, now + LINK_FAILURE_COOLDOWN_MS)
        if (error instanceof ChallengeRequired) {
          /* Arrêt net, comme la synchronisation : on retient l'état sur le compte, ce qui coupe
             aussi la synchronisation planifiée, et l'écran des comptes dit quoi faire. */
          this.deps.markChallenge(platform)
          this.queues.delete(platform)
        } else if (error instanceof RateLimited) {
          const backoff = Math.min(
            RATE_BACKOFF_MAX_MS,
            Math.max(RATE_BACKOFF_MIN_MS, error.retryAfterMs || 0)
          )
          this.blockedUntil.set(platform, now + backoff)
        } else if (error instanceof AuthExpired) {
          this.blockedUntil.set(platform, now + AUTH_BACKOFF_MS)
        }
        this.warn(postId, error)
        return false
      } finally {
        this.inFlight.delete(postId)
      }
    })()
    this.inFlight.set(postId, pending)
    return pending
  }

  /** Les premiers diagnostics, puis un échantillon : un réseau coupé ne remplit pas le journal. */
  private warn(postId: string, error: unknown): void {
    this.warnings++
    if (this.warnings <= 10 || this.warnings % 50 === 0) {
      console.warn(`[magpie] Lien média non renouvelé pour ${postId} (${this.warnings}) :`, error)
    }
  }
}
