import { useCallback, useEffect, useState } from 'react'
import type { BackgroundState, BackgroundTaskKind } from '@shared/types'
import { magpie, magpieEvents } from '../bridge'
import { CLIP_BYTES, THUMBNAIL_BYTES } from '../estimates'
import { formatBytes, formatDuration } from '../format'
import { STEP_ORDER, type StepId, type StepState } from '../steps'
import { useStore, useT } from '../store'
import { IconCheck, IconImage, IconMic, IconSync, IconTag, IconVideo } from './Icons'

/**
 * La préparation, enchaînée et visible.
 *
 * Le menu d'actions listait chaque étape séparément — images, vidéos, transcription,
 * regroupement — et laissait croire qu'il fallait cliquer sur chacune dans le bon ordre.
 * Or elles se suivent : on cherche les nouveautés, on descend ce qu'il faut, on écoute
 * l'audio, puis on regroupe. Ici on coche ce qu'on veut, on lance une fois, et on voit les
 * étapes défiler. Les actions unitaires restent dans le menu pour qui sait ce qu'il fait.
 *
 * Seul le regroupement est obligatoire : c'est le but de l'écran.
 */


interface Props {
  onFinished(): void
}

interface Counts {
  thumbnails: number
  clips: number
  transcripts: number
}

/** Cadence observée sur un seize cœurs. Grossière à dessein : elle situe, elle ne promet pas. */
const TRANSCRIPT_MS_EACH = 2_400

export function OrganizerSteps({ onFinished }: Props): React.JSX.Element {
  const t = useT()
  const cacheQuality = useStore((state) => state.videoCacheQuality)
  const startSync = useStore((state) => state.startSync)
  /* La synchronisation publie son avancement dans le store, pas dans le registre de tâches :
     sans la lire ici, l'étape la plus lente du lot était aussi la seule muette. Et elle est
     lente par construction — le moteur pagine à trois secondes par page pour ne pas se faire
     bloquer, donc quinze à vingt-cinq secondes minimum par plateforme. */
  const sync = useStore((state) => state.sync)
  const [counts, setCounts] = useState<Counts | null>(null)
  /* Tout coché d'entrée : c'est la préparation complète qui donne le meilleur résultat, et
     l'utilisateur décoche ce qu'il ne veut pas payer plutôt que d'avoir à deviner ce qu'il
     faut ajouter. L'état vit dans le store pour survivre à la fermeture de la fenêtre —
     revenir dedans repartait de zéro alors que le travail, lui, continuait. */
  const chosen = useStore((state) => state.stepChoices)
  const setChosen = useStore((state) => state.setStepChoices)
  const state = useStore((s) => s.stepStates)
  const setState = useStore((s) => s.setStepStates)
  const running = useStore((s) => s.stepsRunning)
  const setRunning = useStore((s) => s.setStepsRunning)
  const [error, setError] = useState<string | null>(null)
  /* L'avancement vient du registre de tâches, seul endroit qui sache où en est un
     téléchargement. Sans lui l'étape disait « en cours » sans jamais dire jusqu'où. */
  const [live, setLive] = useState<{ kind: string; done: number; total: number } | null>(null)
  /* Une étape qui n'avance pas doit dire pourquoi là où on la regarde. L'avertissement vivait
     dans le panneau des téléchargements, qu'il faut penser à ouvrir : on restait devant un
     compteur figé sans rien pour l'expliquer. */
  const [cache, setCache] = useState<{
    full: boolean
    thumbsCapped: boolean
    thumbBytes: number
    thumbBudget: number
    bytes: number
    limit: number
  } | null>(null)

  useEffect(() => {
    const read = (snapshot: BackgroundState): void => {
      const task = snapshot.tasks.find((entry) =>
        ['thumbnails', 'clips', 'transcribe', 'sync'].includes(entry.kind)
      )
      setLive(task ? { kind: task.kind, done: task.done, total: task.total } : null)
      setCache({
        full: snapshot.cacheFull,
        thumbsCapped: snapshot.cacheThumbnailsCapped,
        thumbBytes: snapshot.cacheThumbnailBytes,
        thumbBudget: snapshot.cacheThumbnailBudget,
        bytes: snapshot.cacheBytes,
        limit: snapshot.cacheLimitBytes
      })
    }
    void magpie.getBackgroundState().then(read).catch(() => {})
    return magpieEvents.onBackgroundState(read)
  }, [])

  useEffect(() => {
    void Promise.all([magpie.pendingCounts(null), magpie.transcriptState()])
      .then(([pending, transcripts]) =>
        setCounts({
          thumbnails: pending.thumbnails,
          clips: pending.clips,
          transcripts: transcripts.pending
        })
      )
      .catch(() => {})
  }, [])

  /**
   * Attend qu'une tâche de fond disparaisse du registre.
   *
   * C'est le registre qui sait quand un préchargement se termine, pas l'appel qui le lance :
   * celui-ci rend la main aussitôt. On s'abonne donc plutôt que d'interroger en boucle.
   */
  const waitFor = useCallback((kind: BackgroundTaskKind): Promise<'done' | 'halted'> => {
    return new Promise((resolve) => {
      let seen = false
      let settled = false
      const finish = (outcome: 'done' | 'halted'): void => {
        if (settled) return
        settled = true
        stop()
        clearTimeout(startGuard)
        resolve(outcome)
      }
      const stop = magpieEvents.onBackgroundState((snapshot) => {
        const task = snapshot.tasks.find((entry) => entry.kind === kind)
        if (task) {
          seen = true
          /* Suspendu — cache plein, ou l'utilisateur a mis en pause — la tâche reste dans le
             registre sans jamais avancer. Attendre là serait attendre pour toujours : c'est
             ce qui bloquait l'enchaînement. On rend la main et on le dit. */
          if (snapshot.paused || task.paused) finish('halted')
          return
        }
        // On ne conclut qu'après avoir vu la tâche apparaître : sans cela, le premier état
        // reçu — encore vide — ferait croire que tout est déjà fini.
        if (seen) finish('done')
      })
      // Filet : une tâche qui ne démarre jamais ne doit pas figer l'enchaînement.
      const startGuard = setTimeout(() => {
        if (!seen) finish('done')
      }, 8000)
    })
  }, [])

  const run = async (): Promise<void> => {
    setRunning(true)
    setError(null)
    const mark = (id: StepId, value: StepState): void => setState({ [id]: value })

    for (const id of STEP_ORDER) {
      if (!chosen.includes(id)) {
        mark(id, 'skipped')
        continue
      }
      mark(id, 'running')
      try {
        let outcome: 'done' | 'halted' = 'done'
        if (id === 'sync') {
          /* L'application synchronise au démarrage : relancer par-dessus ferait attendre deux
             passes au lieu d'une. On se raccroche à celle qui tourne déjà. */
          if (useStore.getState().sync.running) {
            await new Promise<void>((resolve) => {
              const stop = useStore.subscribe((snapshot) => {
                if (snapshot.sync.running) return
                stop()
                resolve()
              })
            })
          } else {
            await startSync()
          }
        } else if (id === 'thumbnails') {
          await magpie.startPreload({ what: 'thumbnails' })
          outcome = await waitFor('thumbnails')
        } else if (id === 'clips') {
          await magpie.startPreload({ what: 'clips' })
          outcome = await waitFor('clips')
        } else if (id === 'transcribe') {
          await magpie.startTranscription()
          outcome = await waitFor('transcribe')
        }
        mark(id, outcome === 'halted' ? 'halted' : 'done')
      } catch (reason) {
        mark(id, 'failed')
        // Une étape ratée n'annule pas les suivantes : le regroupement reste possible avec
        // ce qu'on a. On le signale sans tout arrêter.
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    }
    setRunning(false)
    onFinished()
  }

  const toggle = (id: StepId): void =>
    setChosen(chosen.includes(id) ? chosen.filter((entry) => entry !== id) : [...chosen, id])

  // La page la plus avancée parmi les plateformes en cours : un seul chiffre à lire.
  const syncPage = Math.max(
    1,
    ...Object.values(sync.byPlatform).map((entry) => (entry.phase === 'running' ? entry.page : 0))
  )

  const rows: {
    id: StepId
    icon: React.JSX.Element
    cost: string
    locked?: boolean
  }[] = [
    { id: 'sync', icon: <IconSync size={15} />, cost: t('steps.syncCost') },
    {
      id: 'thumbnails',
      icon: <IconImage size={15} />,
      cost:
        (counts?.thumbnails ?? 0) === 0
          ? t('downloads.allDone')
          : t('downloads.amount', {
              count: counts?.thumbnails ?? 0,
              size: formatBytes((counts?.thumbnails ?? 0) * THUMBNAIL_BYTES)
            })
    },
    {
      id: 'clips',
      icon: <IconVideo size={15} />,
      cost:
        (counts?.clips ?? 0) === 0
          ? t('downloads.allDone')
          : t('downloads.amount', {
              count: counts?.clips ?? 0,
              size: formatBytes((counts?.clips ?? 0) * CLIP_BYTES[cacheQuality])
            })
    },
    {
      id: 'transcribe',
      icon: <IconMic size={15} />,
      cost:
        (counts?.transcripts ?? 0) === 0
          ? t('downloads.allDone')
          : t('steps.transcribeCost', {
              count: counts?.transcripts ?? 0,
              time: formatDuration((counts?.transcripts ?? 0) * TRANSCRIPT_MS_EACH)
            })
    },
    { id: 'group', icon: <IconTag size={15} />, cost: t('steps.groupCost'), locked: true }
  ]

  return (
    <div className="steps">
      <p className="steps__lead">{t('steps.lead')}</p>

      {cache?.thumbsCapped ? (
        <p className="steps__warning" role="alert">
          {t('downloads.thumbsCapped', {
            used: formatBytes(cache.thumbBytes),
            limit: formatBytes(cache.thumbBudget)
          })}
        </p>
      ) : null}
      {cache?.full ? (
        <p className="steps__warning" role="alert">
          {t('downloads.cacheFull', {
            used: formatBytes(cache.bytes),
            limit: formatBytes(cache.limit)
          })}
        </p>
      ) : null}

      <ul className="steps__list">
        {rows.map((row) => {
          const status = state[row.id]
          const active = row.locked || chosen.includes(row.id)
          const measured =
            status === 'running' && live && live.kind === row.id && live.total > 0 ? live : null
          const progress = measured
            ? Math.min(100, Math.round((measured.done / measured.total) * 100))
            : null
          return (
            <li key={row.id} className={`steps__row is-${status} ${active ? '' : 'is-off'}`}>
              <label>
                {/* Une vraie bascule plutôt qu'une case : elle dit « allumé / éteint », ce
                    qui est exactement le sens ici, et se voit d'un coup d'œil sur cinq lignes. */}
                <input
                  type="checkbox"
                  className="steps__switch"
                  checked={active}
                  disabled={row.locked || running}
                  onChange={() => toggle(row.id)}
                />
                <span className="steps__icon">
                  {status === 'done' ? <IconCheck size={15} /> : row.icon}
                </span>
                <span className="steps__body">
                  <strong>
                    {t(`steps.${row.id}` as Parameters<typeof t>[0])}
                    {row.id === 'clips' ? ` · ${t(`quality.${cacheQuality}`)}` : ''}
                  </strong>
                  <em>{t(`steps.${row.id}Hint` as Parameters<typeof t>[0])}</em>
                </span>
                {status === 'running' ? (
                  <span
                    className={`steps__bar ${progress !== null ? 'is-measured' : ''}`}
                    aria-hidden="true"
                    style={
                      progress !== null
                        ? ({ '--steps-progress': `${progress}%` } as React.CSSProperties)
                        : undefined
                    }
                  />
                ) : null}
                <span className="steps__cost">
                  {status === 'running' ? (
                    <>
                      <span className="spinner" />
                      {row.id === 'sync'
                        ? sync.running
                          ? t('sync.progress', {
                              fetched: sync.fetched,
                              added: sync.added,
                              page: syncPage
                            })
                          : null
                        : measured
                          ? t('downloads.progress', { done: measured.done, total: measured.total })
                          : null}
                    </>
                  ) : status === 'skipped' ? (
                    t('steps.skipped')
                  ) : status === 'halted' ? (
                    t('steps.halted')
                  ) : status === 'failed' ? (
                    t('steps.failed')
                  ) : (
                    row.cost
                  )}
                </span>
              </label>
            </li>
          )
        })}
      </ul>

      {error ? <p className="organizer-error">{error}</p> : null}

      <button type="button" className="btn btn--primary btn--wide" disabled={running} onClick={() => void run()}>
        {t(running ? 'steps.running' : 'steps.start')}
      </button>
    </div>
  )
}
