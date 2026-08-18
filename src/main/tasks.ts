import type {
  BackgroundState,
  BackgroundTask,
  BackgroundTaskKind,
  LoadProfile,
  ThroughputSample
} from '@shared/types'
import { getCacheBreakdown } from './media/cache'
import { readSettings } from './settings'

/**
 * Registre du travail de fond.
 *
 * Synchronisation, vignettes, clips et organisation avançaient chacun avec son propre
 * événement, son propre coin d'interface, et aucun endroit où voir l'ensemble. Les réunir
 * ici donne une seule source à l'indicateur, à son survol et à l'icône de la barre système
 * — et un seul endroit où suspendre.
 *
 * Le registre ne travaille pas : il observe. Chaque activité continue de mener sa propre
 * boucle et se contente d'annoncer où elle en est.
 */

interface Entry extends BackgroundTask {
  /** Départ réel, pour estimer la durée restante sans que l'appelant s'en préoccupe. */
  startedAt: number
  /** Avancement au démarrage : une reprise ne doit pas fausser la cadence mesurée. */
  startedDone: number
  /** Avancement à la dernière seconde, pour la cadence instantanée. */
  lastDone?: number
}

type Listener = (state: BackgroundState) => void

const entries = new Map<string, Entry>()
const listeners = new Set<Listener>()
let paused = false
let cacheFull = false
let cacheThumbnailsCapped = false
let cacheThumbnailBytes = 0
let cacheThumbnailBudget = 0
let cacheBytes = 0
let cacheLimitBytes = 0

/** Deux minutes de courbe, une mesure par seconde. Au-delà, on ne lit plus rien. */
const HISTORY_LENGTH = 120
const history: ThroughputSample[] = []
let bytesThisSecond = 0
let bytesPerSecond = 0
let bandwidthLimit = 0
let loadProfile: LoadProfile = 'balanced'
let ticker: NodeJS.Timeout | null = null

/**
 * Combien de travailleurs simultanés pour chaque profil.
 *
 * C'est le seul levier honnête sur la charge : sans ordonnanceur, un plafond en pourcentage
 * de processeur ne veut rien dire. « Léger » laisse la machine disponible, « rapide » prend
 * ce qu'il peut.
 */
const WORKERS: Record<LoadProfile, number> = { light: 2, balanced: 6, fast: 12 }

/**
 * Seau à jetons pour le plafond de bande passante.
 *
 * Contrairement à la charge processeur, celui-ci est un vrai plafond : les lectures de flux
 * demandent leurs octets ici et attendent s'ils ne sont pas disponibles.
 */
let tokens = 0
let lastRefill = Date.now()

function snapshot(): BackgroundState {
  return {
    paused,
    cacheFull,
    cacheThumbnailsCapped,
    cacheThumbnailBytes,
    cacheThumbnailBudget,
    cacheBytes,
    cacheLimitBytes,
    bytesPerSecond,
    bandwidthLimit,
    loadProfile,
    history: [...history],
    tasks: [...entries.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(({ startedAt: _startedAt, startedDone: _startedDone, lastDone: _lastDone, ...task }) => task)
  }
}

/**
 * Échantillonne une fois par seconde, et seulement quand il se passe quelque chose.
 *
 * Un minuteur qui tourne en permanence pour enregistrer des zéros réveillerait le processus
 * sans rien apprendre à personne.
 */
function ensureTicker(): void {
  if (ticker) return
  ticker = setInterval(() => {
    const items = [...entries.values()].reduce((sum, entry) => {
      const advanced = Math.max(0, entry.done - (entry.lastDone ?? entry.done))
      entry.lastDone = entry.done
      return sum + advanced
    }, 0)
    bytesPerSecond = bytesThisSecond
    bytesThisSecond = 0
    history.push({ at: Date.now(), bytesPerSecond, itemsPerSecond: items })
    if (history.length > HISTORY_LENGTH) history.shift()

    if (entries.size === 0 && bytesPerSecond === 0) {
      // Plus rien à mesurer : on s'arrête plutôt que de remplir la courbe de zéros.
      clearInterval(ticker as NodeJS.Timeout)
      ticker = null
      history.length = 0
    }
    publish()
  }, 1000)
  ticker.unref?.()
}

function publish(): void {
  const state = snapshot()
  for (const listener of listeners) listener(state)
}

export const backgroundTasks = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    listener(snapshot())
    return () => listeners.delete(listener)
  },

  current: snapshot,

  isPaused(): boolean {
    return paused
  },

  /**
   * Déclare ou met à jour une tâche. Une même clé rappelée met simplement à jour la
   * précédente, ce qui laisse l'appelant publier à la cadence qui l'arrange.
   */
  update(
    id: string,
    patch: Partial<Omit<BackgroundTask, 'id'>> & { kind: BackgroundTaskKind }
  ): void {
    const existing = entries.get(id)
    const now = Date.now()
    const next: Entry = {
      id,
      kind: patch.kind,
      scope: patch.scope ?? existing?.scope ?? null,
      done: patch.done ?? existing?.done ?? 0,
      total: patch.total ?? existing?.total ?? 0,
      etaMs: null,
      paused: patch.paused ?? paused,
      message: patch.message ?? existing?.message ?? null,
      startedAt: existing?.startedAt ?? now,
      startedDone: existing?.startedDone ?? patch.done ?? 0
    }

    // Estimation tirée de la cadence observée depuis le début de *cette* tâche. Elle
    // n'apparaît qu'une fois assez d'avancement mesuré : sur les premiers éléments elle
    // serait fantaisiste, et une durée fausse est pire que pas de durée du tout.
    const advanced = next.done - next.startedDone
    const elapsed = now - next.startedAt
    if (next.total > 0 && advanced >= 20 && elapsed > 3000 && !next.paused) {
      next.etaMs = Math.round((elapsed / advanced) * Math.max(0, next.total - next.done))
    }

    entries.set(id, next)
    ensureTicker()
    publish()
  },

  /**
   * Déclare des octets transférés. Appelé par les lectures de flux, c'est ce qui alimente
   * le débit affiché et la courbe.
   */
  countBytes(amount: number): void {
    if (amount > 0) bytesThisSecond += amount
  },

  /**
   * Réserve des octets avant de les lire. Résout aussitôt quand aucun plafond n'est fixé —
   * le cas courant ne paie donc rien.
   */
  async claimBandwidth(amount: number): Promise<void> {
    if (bandwidthLimit <= 0 || amount <= 0) return
    for (;;) {
      const now = Date.now()
      tokens = Math.min(bandwidthLimit, tokens + ((now - lastRefill) / 1000) * bandwidthLimit)
      lastRefill = now
      if (tokens >= amount) {
        tokens -= amount
        return
      }
      const waitMs = Math.min(500, Math.ceil(((amount - tokens) / bandwidthLimit) * 1000))
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  },

  /** Nombre de travailleurs simultanés autorisés par le profil courant. */
  workers(): number {
    return WORKERS[loadProfile]
  },

  setBandwidthLimit(bytesPerSecondLimit: number): void {
    const next = Math.max(0, Math.round(bytesPerSecondLimit))
    if (bandwidthLimit === next) return
    bandwidthLimit = next
    tokens = 0
    lastRefill = Date.now()
    publish()
  },

  setLoadProfile(profile: LoadProfile): void {
    if (loadProfile === profile) return
    loadProfile = profile
    publish()
  },

  /** Suspend ou reprend une seule tâche, sans toucher aux autres. */
  setTaskPaused(id: string, next: boolean): void {
    const entry = entries.get(id)
    if (!entry || entry.paused === next) return
    entry.paused = next
    publish()
  },

  isTaskPaused(id: string): boolean {
    return entries.get(id)?.paused ?? paused
  },

  /** Retire une tâche terminée ou abandonnée. */
  clear(id: string): void {
    if (entries.delete(id)) publish()
  },

  /**
   * Suspend ou reprend l'ensemble des téléchargements. Le drapeau vit ici pour que
   * l'interface et la barre système lisent le même état ; l'arrêt effectif appartient aux
   * boucles concernées, prévenues par les rappels ci-dessous.
   */
  setPaused(next: boolean): void {
    if (paused === next) return
    paused = next
    for (const entry of entries.values()) entry.paused = next
    publish()
  },

  /**
   * Signale que le disque alloué est plein. Poursuivre reviendrait à évincer les fichiers
   * qu'on vient d'écrire pour écrire les suivants : l'utilisateur doit trancher, en
   * libérant de la place ou en relevant la limite.
   */
  setCacheState(full: boolean, bytes: number, limitBytes: number): void {
    const changed = cacheFull !== full || cacheBytes !== bytes || cacheLimitBytes !== limitBytes
    cacheFull = full
    cacheBytes = bytes
    cacheLimitBytes = limitBytes
    if (changed) publish()
  },

  /**
   * Les vignettes ne tiennent plus dans la part qui leur est réservée : chaque nouvelle en
   * efface une ancienne, qui retourne aussitôt en file. L'étape ne peut pas finir, et le
   * seul remède est de relever le plafond — le dire vaut mieux que de télécharger en boucle.
   */
  setThumbnailsCapped(capped: boolean): void {
    if (cacheThumbnailsCapped === capped) return
    cacheThumbnailsCapped = capped
    publish()
  },

  /**
   * Relit l'occupation réelle du disque. À appeler après tout ce qui la change de
   * l'extérieur — une purge, une limite relevée — sans quoi l'avertissement resterait
   * affiché alors que la place est revenue.
   */
  async refreshCache(full = false): Promise<void> {
    const limit = readSettings().cacheLimitGb * 1024 * 1024 * 1024
    const parts = await getCacheBreakdown()
    const bytes = parts.thumbs + parts.other
    const changed =
      cacheThumbnailBytes !== parts.thumbs || cacheThumbnailBudget !== parts.thumbBudget
    cacheThumbnailBytes = parts.thumbs
    cacheThumbnailBudget = parts.thumbBudget
    /* Relever le plafond agrandit la part des vignettes : l'avertissement doit tomber de
       lui-même, sans quoi il resterait affiché alors que la place est revenue. */
    if (cacheThumbnailsCapped && parts.thumbs < parts.thumbBudget * 0.98) {
      cacheThumbnailsCapped = false
    }
    this.setCacheState(full && bytes >= limit, bytes, limit)
    if (changed) publish()
  }
}
