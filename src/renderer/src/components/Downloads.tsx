import { useEffect, useState } from 'react'
import type { BackgroundState, BackgroundTask, ThroughputSample } from '@shared/types'
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
export function Downloads(): React.JSX.Element {
  const t = useT()
  const [state, setState] = useState<BackgroundState | null>(null)

  useEffect(() => {
    void magpie.getBackgroundState().then(setState).catch(() => {})
    return magpieEvents.onBackgroundState(setState)
  }, [])

  const tasks = state?.tasks ?? []
  const busy = tasks.length > 0
  const warning = state?.cacheFull === true
  const thumbsCapped = state?.cacheThumbnailsCapped === true
  /* Le badge du bouton porte les deux : sans lui, l'avertissement n'existe qu'une fois le
     panneau ouvert, et rien n'invite à l'ouvrir. */
  const alerting = warning || thumbsCapped
  const paused = state?.paused === true

  const overall = tasks.reduce(
    (sum, task) => {
      if (task.total <= 0) return sum
      return { done: sum.done + Math.min(task.done, task.total), total: sum.total + task.total }
    },
    { done: 0, total: 0 }
  )
  const percent = overall.total > 0 ? Math.round((overall.done / overall.total) * 100) : null
  const recent = (state?.history ?? []).slice(-60)
  const items = Math.round(recent.reduce((sum, sample) => sum + sample.itemsPerSecond, 0))

  /* Il reste en place même au repos : voir un bouton disparaître et réapparaître dans une
     barre d'outils décale tout le reste, et on perd le seul endroit où consulter l'historique
     de débit. Au repos il devient gris et cesse de bouger — c'est la couleur et le mouvement
     qui portent l'information, pas la présence. */

  return (
    <Popover
      align="right"
      title={t('downloads.title')}
      label={
        <span
          className={`downloads__trigger ${busy ? 'is-busy' : ''} ${paused ? 'is-paused' : ''} ${
            alerting ? 'is-warning' : ''
          }`}
        >
          <IconDownload size={15} />
          {busy && percent !== null && !paused ? (
            <span className="downloads__percent">{percent}%</span>
          ) : null}
          {alerting ? <span className="downloads__alert" aria-hidden="true" /> : null}
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

          {/* Distinct du cache plein : là, il reste de la place — mais pas pour les
              vignettes, qui se remplacent entre elles sans jamais rattraper leur retard. */}
          {thumbsCapped ? (
            <p className="downloads__warning" role="alert">
              {t('downloads.thumbsCapped', {
                used: formatBytes(state?.cacheThumbnailBytes ?? 0),
                limit: formatBytes(state?.cacheThumbnailBudget ?? 0)
              })}
            </p>
          ) : null}

          {/* Débit et courbe : « ça avance » est une chose, « à quelle vitesse et depuis
              quand » en est une autre — c'est elle qui permet de décider s'il faut brider. */}
          {busy ? (
            <div className="downloads__meter">
              <Sparkline samples={state?.history ?? []} />
              <span>
                {formatBytes(state?.bytesPerSecond ?? 0)}/s
                {items > 0 ? ` · ${t('downloads.perMinute', { count: items })}` : ''}
              </span>
            </div>
          ) : null}

          {busy ? (
            <ul className="downloads__list">
              {tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  paused={paused}
                  onStop={setState}
                  onToggle={() =>
                    void magpie.setTaskPaused(task.id, !task.paused).then(setState)
                  }
                />
              ))}
            </ul>
          ) : (
            <p className="downloads__idle">{t('downloads.idle')}</p>
          )}

          <div className="modal__sep" />
          <div className="downloads__limits">
            <label>
              <span>{t('downloads.loadProfile')}</span>
              <div className="segmented segmented--quiet">
                {(['light', 'balanced', 'fast'] as const).map((profile) => (
                  <button
                    key={profile}
                    type="button"
                    className={state?.loadProfile === profile ? 'is-active' : ''}
                    onClick={() => void magpie.setLoadProfile(profile).then(setState)}
                  >
                    {t(`downloads.load.${profile}` as Parameters<typeof t>[0])}
                  </button>
                ))}
              </div>
            </label>
            <label>
              <span>
                {(state?.bandwidthLimit ?? 0) > 0
                  ? t('downloads.bandwidthOn', {
                      rate: `${formatBytes(state?.bandwidthLimit ?? 0)}/s`
                    })
                  : t('downloads.bandwidthOff')}
              </span>
              <input
                type="range"
                min={0}
                max={20}
                step={1}
                value={Math.round((state?.bandwidthLimit ?? 0) / (1024 * 1024))}
                onChange={(event) =>
                  void magpie
                    .setBandwidthLimit(Number(event.target.value) * 1024 * 1024)
                    .then(setState)
                }
              />
            </label>
          </div>
        </div>
      )}
    </Popover>
  )
}

/**
 * Courbe du débit des dernières minutes.
 *
 * Un chiffre dit la vitesse à l'instant ; la courbe dit si elle tient, si elle s'effondre,
 * ou si un plafond mord. C'est ce qui permet de décider de brider — ou de ne pas le faire.
 */
function Sparkline({ samples }: { samples: ThroughputSample[] }): React.JSX.Element | null {
  if (samples.length < 2) return null
  const peak = Math.max(...samples.map((sample) => sample.bytesPerSecond), 1)
  const width = 100
  const height = 26
  const step = width / (samples.length - 1)
  const line = samples
    .map((sample, index) => {
      const x = index * step
      const y = height - (sample.bytesPerSecond / peak) * (height - 2) - 1
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg className="downloads__spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${line} L${width} ${height} L0 ${height} Z`} className="downloads__spark-fill" />
      <path d={line} className="downloads__spark-line" />
    </svg>
  )
}

function TaskRow({
  task,
  paused,
  onStop,
  onToggle
}: {
  task: BackgroundTask
  /** Pause générale : une tâche à l'arrêt ne doit pas continuer d'annoncer une échéance. */
  paused: boolean
  onStop: (state: BackgroundState) => void
  onToggle: () => void
}): React.JSX.Element {
  const t = useT()
  const halted = paused || task.paused
  const done = Math.min(task.done, task.total || task.done)
  const percent = task.total > 0 ? Math.min(100, (done / task.total) * 100) : null
  /* La transcription dure des heures : ne pas pouvoir l'arrêter était le pire cas. Le
     regroupement et la synchronisation, eux, se terminent d'eux-mêmes en peu de temps. */
  const stoppable =
    task.kind === 'thumbnails' || task.kind === 'clips' || task.kind === 'transcribe'

  return (
    <li className={`downloads__task ${halted ? 'is-paused' : ''}`}>
      <div className="downloads__task-head">
        <span className="downloads__task-name">
          {t(`downloads.kind.${task.kind}` as Parameters<typeof t>[0])}
          {task.scope ? <em>{task.scope}</em> : null}
        </span>
        <button
          type="button"
          className="icon-btn-ghost"
          title={t(task.paused ? 'downloads.resume' : 'downloads.pauseAll')}
          aria-label={t(task.paused ? 'downloads.resume' : 'downloads.pauseAll')}
          onClick={onToggle}
        >
          {task.paused ? <IconPlay size={12} /> : <IconPause size={12} />}
        </button>
        {stoppable ? (
          <button
            type="button"
            className="icon-btn-ghost"
            title={t('downloads.stop')}
            aria-label={t('downloads.stop')}
            onClick={() =>
              void (task.kind === 'transcribe'
                ? magpie.stopTranscription()
                : magpie.stopPreload(task.kind as 'thumbnails' | 'clips')
              ).then(onStop)
            }
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
