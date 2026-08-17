import type { BackgroundState, BackgroundTask, BackgroundTaskKind } from '@shared/types'
import { getCacheUsage } from './media/cache'
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
}

type Listener = (state: BackgroundState) => void

const entries = new Map<string, Entry>()
const listeners = new Set<Listener>()
let paused = false
let cacheFull = false
let cacheBytes = 0
let cacheLimitBytes = 0

function snapshot(): BackgroundState {
  return {
    paused,
    cacheFull,
    cacheBytes,
    cacheLimitBytes,
    tasks: [...entries.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(({ startedAt: _startedAt, startedDone: _startedDone, ...task }) => task)
  }
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
    publish()
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
   * Relit l'occupation réelle du disque. À appeler après tout ce qui la change de
   * l'extérieur — une purge, une limite relevée — sans quoi l'avertissement resterait
   * affiché alors que la place est revenue.
   */
  async refreshCache(full = false): Promise<void> {
    const limit = readSettings().cacheLimitGb * 1024 * 1024 * 1024
    const bytes = await getCacheUsage()
    this.setCacheState(full && bytes >= limit, bytes, limit)
  }
}
