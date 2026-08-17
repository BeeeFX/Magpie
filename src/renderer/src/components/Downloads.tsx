import { useEffect, useState } from 'react'
import type { BackgroundState, BackgroundTask } from '@shared/types'
import { magpie, magpieEvents } from '../bridge'
import { formatBytes, formatDuration } from '../format'
import { useT } from '../store'
import { IconClose, IconDownload, IconPause, IconPlay } from './Icons'
import { Popover } from './Popover'

/**
 * Téléchargements : ce qu'on peut demander, et ce qui se passe déjà.
 *
 * Les deux tiennent dans le même bouton à dessein. Les séparer demandait deux icônes
 * voisines qui se ressemblaient, et obligeait à deviner laquelle répondait à « où en
 * est-ce ? ». Ici le bouton s'anime dès qu'il y a du travail et affiche son avancement,
 * tandis que le menu garde les mêmes actions à la même place.
 *
 * Auparavant il fallait rester dans les réglages pour voir avancer une préparation, et la
 * synchronisation ne se lisait qu'ailleurs encore — tout se regroupe ici.
 */
export function Downloads(): React.JSX.Element | null {
  const t = useT()
  const [state, setState] = useState<BackgroundState | null>(null)

  useEffect(() => {
    void magpie.getBackgroundState().then(setState).catch(() => {})
    return magpieEvents.onBackgroundState(setState)
  }, [])

  const tasks = state?.tasks ?? []
  const busy = tasks.length > 0
  const warning = state?.cacheFull === true
  const paused = state?.paused === true

  const overall = tasks.reduce(
    (sum, task) => {
      if (task.total <= 0) return sum
      return { done: sum.done + Math.min(task.done, task.total), total: sum.total + task.total }
    },
    { done: 0, total: 0 }
  )
  const percent = overall.total > 0 ? Math.round((overall.done / overall.total) * 100) : null

  /* Purement un indicateur d'état depuis que le menu d'actions porte les lancements : rien
     en cours et rien à signaler, il n'a aucune raison d'occuper la barre d'outils. */
  if (!busy && !warning) return null

  return (
    <Popover
      align="right"
      title={t('downloads.title')}
      label={
        <span
          className={`downloads__trigger ${busy ? 'is-busy' : ''} ${paused ? 'is-paused' : ''} ${
            warning ? 'is-warning' : ''
          }`}
        >
          <IconDownload size={15} />
          {busy && percent !== null && !paused ? (
            <span className="downloads__percent">{percent}%</span>
          ) : null}
          {warning ? <span className="downloads__alert" aria-hidden="true" /> : null}
        </span>
      }
    >
      {() => (
        <div className="downloads">
          <header className="downloads__head">
            <strong>{t('downloads.title')}</strong>
            {busy ? (
              <button
                type="button"
                className="btn"
                onClick={() => void magpie.setDownloadsPaused(!paused).then(setState)}
              >
                {paused ? <IconPlay size={12} /> : <IconPause size={12} />}
                {t(paused ? 'downloads.resume' : 'downloads.pauseAll')}
              </button>
            ) : null}
          </header>

          {warning ? (
            <p className="downloads__warning" role="alert">
              {t('downloads.cacheFull', {
                used: formatBytes(state?.cacheBytes ?? 0),
                limit: formatBytes(state?.cacheLimitBytes ?? 0)
              })}
            </p>
          ) : null}

          {busy ? (
            <ul className="downloads__list">
              {tasks.map((task) => (
                <TaskRow key={task.id} task={task} paused={paused} onStop={setState} />
              ))}
            </ul>
          ) : (
            <p className="downloads__idle">{t('downloads.idle')}</p>
          )}

        </div>
      )}
    </Popover>
  )
}

function TaskRow({
  task,
  paused,
  onStop
}: {
  task: BackgroundTask
  /** Pause générale : une tâche à l'arrêt ne doit pas continuer d'annoncer une échéance. */
  paused: boolean
  onStop: (state: BackgroundState) => void
}): React.JSX.Element {
  const t = useT()
  const halted = paused || task.paused
  const done = Math.min(task.done, task.total || task.done)
  const percent = task.total > 0 ? Math.min(100, (done / task.total) * 100) : null
  const stoppable = task.kind === 'thumbnails' || task.kind === 'clips'

  return (
    <li className={`downloads__task ${halted ? 'is-paused' : ''}`}>
      <div className="downloads__task-head">
        <span className="downloads__task-name">
          {t(`downloads.kind.${task.kind}` as Parameters<typeof t>[0])}
          {task.scope ? <em>{task.scope}</em> : null}
        </span>
        {stoppable ? (
          <button
            type="button"
            className="icon-btn-ghost"
            title={t('downloads.stop')}
            aria-label={t('downloads.stop')}
            onClick={() => void magpie.stopPreload(task.kind as 'thumbnails' | 'clips').then(onStop)}
          >
            <IconClose size={12} />
          </button>
        ) : null}
      </div>

      {/* Sans ampleur connue — c'est le cas d'une synchronisation — la barre se contente
          d'indiquer une activité plutôt que d'inventer un pourcentage. */}
      <div className={`downloads__bar ${percent === null && !halted ? 'is-indeterminate' : ''}`}>
        <span style={percent === null ? undefined : { width: `${percent}%` }} />
      </div>

      <span className="downloads__task-detail">
        {halted
          ? t('downloads.paused')
          : task.total > 0
            ? t('downloads.progress', { done, total: task.total })
            : t('downloads.working', { done })}
        {task.etaMs && !halted ? ` · ${t('downloads.eta', { eta: formatDuration(task.etaMs) })}` : ''}
      </span>
      {task.message ? <span className="downloads__task-message">{task.message}</span> : null}
    </li>
  )
}
