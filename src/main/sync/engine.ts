import type { Platform, PlatformSync, SyncState } from '@shared/types'
import { idleSyncState, PLATFORMS } from '@shared/types'
import { AuthExpired, ChallengeRequired, RateLimited } from '../adapters/http'
import type { PlatformAdapter } from '../adapters/types'
import { instagramAdapter } from '../adapters/instagram'
import { redditAdapter } from '../adapters/reddit'
import { xAdapter } from '../adapters/x'
import { knownPostIds, readAccount, upsertPosts, writeAccount } from '../db/queries'
import { applyRuleTags } from '../tagging/rules'

/**
 * Moteur de synchronisation. Voir SPEC.md §6.
 *
 * **Les plateformes tournent en parallèle, chacune à son rythme.** La première version les
 * enchaînait, au motif que deux backfills simultanés doubleraient la trace laissée — c'était
 * faux : Instagram ne voit rien de ce qu'on demande à Reddit. La limitation de débit est
 * par plateforme, donc la prudence doit l'être aussi. Le séquentiel ne protégeait de rien
 * et ne faisait qu'imposer une attente.
 *
 * Ce qui reste prudent, et qui compte vraiment : à l'intérieur d'une plateforme, une page
 * à la fois, des pauses aléatoires, un arrêt dès qu'on retrouve du déjà-vu, un plafond de
 * pages, et un arrêt définitif sans reprise si la plateforme demande une vérification.
 */

export const ADAPTERS: Record<Platform, PlatformAdapter> = {
  instagram: instagramAdapter,
  x: xAdapter,
  reddit: redditAdapter
}

/** Instagram est la plus prompte à réagir : elle reçoit les pauses les plus longues. */
const PACING: Record<Platform, { minMs: number; maxMs: number; maxPages: number }> = {
  instagram: { minMs: 2500, maxMs: 5000, maxPages: 120 },
  x: { minMs: 2000, maxMs: 4000, maxPages: 120 },
  reddit: { minMs: 1200, maxMs: 2400, maxPages: 60 }
}

/** Pages consécutives sans nouveauté avant de considérer le rattrapage terminé. */
const STALE_PAGES_BEFORE_STOP = 3
const MAX_RATE_LIMIT_RETRIES = 5

interface ResumeCursor {
  cursor: string
  rank: number
}

function decodeResumeCursor(value: string | null): ResumeCursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<ResumeCursor>
    if (typeof parsed.cursor === 'string' && Number.isFinite(parsed.rank)) {
      return { cursor: parsed.cursor, rank: Math.max(0, Number(parsed.rank)) }
    }
  } catch {
    // Compatibilité avec un éventuel curseur brut écrit par une ancienne version.
  }
  return { cursor: value, rank: 0 }
}

function encodeResumeCursor(cursor: string, rank: number): string {
  return JSON.stringify({ cursor, rank } satisfies ResumeCursor)
}

type Listener = (state: SyncState) => void

class SyncEngine {
  private state: SyncState = idleSyncState()
  private listeners = new Set<Listener>()
  /** Une plateforme ne peut pas se synchroniser deux fois de front. */
  private inFlight = new Map<Platform, Promise<void>>()
  private cancelled = new Set<Platform>()

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  current(): SyncState {
    return this.state
  }

  isRunning(platform?: Platform): boolean {
    return platform ? this.inFlight.has(platform) : this.inFlight.size > 0
  }

  /** Sans plateforme, annule tout ce qui tourne. */
  cancel(platform?: Platform): void {
    for (const target of platform ? [platform] : [...this.inFlight.keys()]) {
      this.cancelled.add(target)
    }
  }

  private patch(platform: Platform, patch: Partial<PlatformSync>): void {
    const byPlatform = {
      ...this.state.byPlatform,
      [platform]: { ...this.state.byPlatform[platform], ...patch }
    }
    this.state = {
      byPlatform,
      // La première notification part avant que la Promise soit rangée dans `inFlight`.
      // Les phases constituent donc la source de vérité la plus fiable pour l'interface.
      running: PLATFORMS.some((p) => byPlatform[p].phase === 'running'),
      fetched: PLATFORMS.reduce((sum, p) => sum + byPlatform[p].fetched, 0),
      added: PLATFORMS.reduce((sum, p) => sum + byPlatform[p].added, 0)
    }
    for (const listener of this.listeners) listener(this.state)
  }

  private async pause(platform: Platform): Promise<void> {
    const { minMs, maxMs } = PACING[platform]
    await new Promise((resolve) => setTimeout(resolve, minMs + Math.random() * (maxMs - minMs)))
  }

  /**
   * Lance les plateformes demandées, ou toutes celles connectées. Retourne quand elles
   * ont toutes fini ; une plateforme déjà en cours n'est pas relancée mais son achèvement
   * est bien attendu.
   */
  async syncAll(platforms?: Platform[]): Promise<SyncState> {
    const targets = platforms ?? PLATFORMS
    const started: Promise<void>[] = []

    for (const platform of targets) {
      const existing = this.inFlight.get(platform)
      if (existing) {
        started.push(existing)
        continue
      }
      if (!(await ADAPTERS[platform].isConnected())) continue

      const run = this.syncOne(platform).finally(() => {
        this.inFlight.delete(platform)
        this.cancelled.delete(platform)
        // Recalcule `running` maintenant que cette plateforme a quitté la file.
        this.patch(platform, {})
      })
      this.inFlight.set(platform, run)
      started.push(run)
    }

    await Promise.allSettled(started)
    return this.state
  }

  private async syncOne(platform: Platform): Promise<void> {
    const adapter = ADAPTERS[platform]
    const { maxPages } = PACING[platform]

    this.patch(platform, {
      phase: 'running',
      fetched: 0,
      added: 0,
      page: 0,
      message: null,
      needsAttention: false
    })

    const known = knownPostIds(platform)
    const account = readAccount(platform)
    const resume = decodeResumeCursor(account?.cursor ?? null)
    const isBackfill = resume !== null || !account?.lastSyncAt || account?.lastSyncStatus === 'partial'
    let cursor: string | null = resume?.cursor ?? null
    let rank = resume?.rank ?? 0
    let fetched = 0
    let added = 0
    let stalePages = 0
    let backoffMs = 0
    let rateLimitRetries = 0
    let completed = false

    for (let page = 0; page < maxPages; page++) {
      if (this.cancelled.has(platform)) {
        writeAccount(platform, { lastSyncStatus: 'partial' })
        this.patch(platform, { phase: 'cancelled' })
        return
      }

      if (backoffMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs))
        backoffMs = 0
      }

      let result: Awaited<ReturnType<PlatformAdapter['fetchPage']>>
      try {
        result = await adapter.fetchPage(cursor, rank)
      } catch (err) {
        if (err instanceof ChallengeRequired) {
          // Arrêt définitif : réessayer une vérification de sécurité est exactement le
          // comportement qui aggrave la situation.
          this.patch(platform, {
            phase: 'error',
            needsAttention: true,
            message: `${label(platform)} demande une vérification de sécurité. Ouvrez le site dans votre navigateur, débloquez le compte, puis reconnectez-le ici.`
          })
          writeAccount(platform, { lastSyncStatus: 'challenge' })
          return
        }

        if (err instanceof AuthExpired) {
          this.patch(platform, {
            phase: 'error',
            needsAttention: true,
            message: `La session ${label(platform)} a expiré. Reconnectez le compte dans les réglages.`
          })
          writeAccount(platform, { lastSyncStatus: 'expired' })
          return
        }

        if (err instanceof RateLimited) {
          rateLimitRetries++
          if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
            this.patch(platform, {
              phase: 'error',
              message: `${label(platform)} limite toujours le débit après plusieurs tentatives.`
            })
            writeAccount(platform, { lastSyncStatus: 'error' })
            return
          }
          backoffMs = Math.min(err.retryAfterMs || 60000, 5 * 60000)
          this.patch(platform, {
            message: `${label(platform)} limite le débit, reprise dans ${Math.round(backoffMs / 1000)} s…`
          })
          page--
          continue
        }

        this.patch(platform, { phase: 'error', message: `${label(platform)} : ${(err as Error).message}` })
        writeAccount(platform, { lastSyncStatus: 'error' })
        return
      }

      rateLimitRetries = 0

      // Rang global continu : il sert de substitut à la date de sauvegarde, que ni
      // Instagram ni X n'exposent.
      rank += result.posts.length
      fetched += result.posts.length

      const fresh = result.posts.filter((post) => !known.has(post.id))
      added += fresh.length
      for (const post of fresh) known.add(post.id)

      if (result.posts.length > 0) {
        upsertPosts(result.posts, result.media)
        // Les règles ne s'appliquent qu'aux nouveaux : les re-jouer sur du déjà connu
        // ressusciterait des tags que l'utilisateur a pu retirer à la main.
        if (fresh.length > 0) applyRuleTags(fresh)

        // La date est écrite à chaque page, pas seulement à la fin : les posts sont
        // enregistrés au fil de l'eau, donc un rattrapage interrompu laissait des données
        // en base sans aucune trace de synchronisation — le compte s'affichait alors
        // « jamais synchronisé » alors qu'il l'avait été.
        writeAccount(platform, {
          lastSyncAt: Date.now(),
          lastSyncStatus: isBackfill ? 'partial' : 'ok',
          ...(isBackfill
            ? {
                cursor: result.nextCursor
                  ? encodeResumeCursor(result.nextCursor, rank)
                  : null
              }
            : {})
        })
      }

      this.patch(platform, { fetched, added, page: page + 1, message: null })

      // Rattrapage terminé : plusieurs pages d'affilée sans rien de neuf signifient qu'on
      // a rejoint ce qu'on avait déjà. Un sync incrémental s'arrête donc en une ou deux
      // requêtes au lieu de reparcourir tout l'historique.
      stalePages = fresh.length === 0 ? stalePages + 1 : 0
      if (!isBackfill && stalePages >= STALE_PAGES_BEFORE_STOP) {
        completed = true
        break
      }

      if (result.done || !result.nextCursor) {
        completed = true
        break
      }
      cursor = result.nextCursor

      await this.pause(platform)
    }

    writeAccount(platform, {
      handle: (await adapter.resolveHandle().catch(() => null)) ?? undefined,
      lastSyncAt: Date.now(),
      lastSyncStatus: completed ? 'ok' : 'partial',
      ...(isBackfill && completed ? { cursor: null } : {})
    })

    this.patch(platform, {
      phase: 'done',
      fetched,
      added,
      message: completed ? null : `${label(platform)} : import mis en pause, reprise disponible.`
    })
  }
}

function label(platform: Platform): string {
  return platform === 'x' ? 'X' : platform === 'reddit' ? 'Reddit' : 'Instagram'
}

export const syncEngine = new SyncEngine()

export async function connectedPlatforms(): Promise<Platform[]> {
  const entries = await Promise.all(
    PLATFORMS.map(async (platform) => [platform, await ADAPTERS[platform].isConnected()] as const)
  )
  return entries.filter(([, connected]) => connected).map(([platform]) => platform)
}

export function accountSummary(platform: Platform): ReturnType<typeof readAccount> {
  return readAccount(platform)
}
