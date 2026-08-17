import { useCallback, useEffect, useState } from 'react'
import type { BackgroundTaskKind } from '@shared/types'
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
          await startSync()
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

      <ul className="steps__list">
        {rows.map((row) => {
          const status = state[row.id]
          const active = row.locked || chosen.includes(row.id)
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
                {status === 'running' ? <span className="steps__bar" aria-hidden="true" /> : null}
                <span className="steps__cost">
                  {status === 'running' ? (
                    <span className="spinner" />
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
