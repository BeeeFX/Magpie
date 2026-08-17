import { useEffect, useState } from 'react'
import type { BackgroundState, BackgroundTask } from '@shared/types'
import { magpie, magpieEvents } from '../bridge'
import { formatBytes, formatDuration } from '../format'
import { useStore, useT } from '../store'
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
export function Downloads(): React.JSX.Element {
  const t = useT()
  const query = useStore((s) => s.query)
  const [state, setState] = useState<BackgroundState | null>(null)
  const [counts, setCounts] = useState<{ thumbnails: number; clips: number } | null>(null)
  const [scoped, setScoped] = useState<{ thumbnails: number; clips: number } | null>(null)

  const filtered =
    query.tags.length > 0 ||
    query.collectionIds.length > 0 ||
    query.favoritesOnly ||
    query.platforms.length > 0 ||
    query.kinds.length > 0 ||
    query.label !== null ||
    query.search.trim().length > 0

  useEffect(() => {
    void magpie.getBackgroundState().then(setState).catch(() => {})
    return magpieEvents.onBackgroundState(setState)
  }, [])

  // Les compteurs se relisent à chaque changement d'état : un lot terminé fait baisser le
  // reste, et un bouton qui propose mille vignettes déjà faites ne veut plus rien dire.
  useEffect(() => {
    void magpie.pendingCounts(null).then(setCounts).catch(() => {})
    if (filtered) void magpie.pendingCounts(query).then(setScoped).catch(() => {})
    else setScoped(null)
  }, [query, filtered, state])

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

  const start = (what: 'thumbnails' | 'clips', scopedToView: boolean): void => {
    void magpie
      .startPreload({
        what,
        query: scopedToView ? query : null,
        scopeLabel: scopedToView ? t('downloads.scopeView') : null
      })
      .then(setState)
      .catch(() => {})
  }

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
      {(close) => (
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

          <div className="modal__sep" />
          <p className="downloads__hint">{t('downloads.prepareHint')}</p>

          <div className="downloads__actions">
            <button
              type="button"
              className="btn"
              disabled={(counts?.thumbnails ?? 0) === 0}
              onClick={() => {
                start('thumbnails', false)
                close()
              }}
            >
              {t('downloads.allThumbnails', { count: counts?.thumbnails ?? 0 })}
            </button>
            <button
              type="button"
              className="btn"
              disabled={(counts?.clips ?? 0) === 0}
              onClick={() => {
                start('clips', false)
                close()
              }}
            >
              {t('downloads.allClips', { count: counts?.clips ?? 0 })}
            </button>
          </div>

          {/* Le périmètre suit l'écran plutôt que d'imposer un second jeu de filtres :
              ce qu'on regarde est presque toujours ce qu'on veut préparer en premier. */}
          {filtered ? (
            <>
              <p className="downloads__hint">{t('downloads.scopeHint')}</p>
              <div className="downloads__actions">
                <button
                  type="button"
                  className="btn"
                  disabled={(scoped?.thumbnails ?? 0) === 0}
                  onClick={() => {
                    start('thumbnails', true)
                    close()
                  }}
                >
                  {t('downloads.viewThumbnails', { count: scoped?.thumbnails ?? 0 })}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={(scoped?.clips ?? 0) === 0}
                  onClick={() => {
                    start('clips', true)
                    close()
                  }}
                >
                  {t('downloads.viewClips', { count: scoped?.clips ?? 0 })}
                </button>
              </div>
            </>
          ) : null}
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
