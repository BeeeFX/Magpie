import { useEffect, useState } from 'react'
import type { AfterSyncStep, BackgroundState, BackgroundTask, ThroughputSample } from '@shared/types'
import { AFTER_SYNC_STEPS } from '@shared/types'
import { magpie, magpieEvents } from '../bridge'
import { formatBytes, formatDuration } from '../format'
import { useStore, useT } from '../store'
import { IconClose, IconDownload, IconPause, IconPlay } from './Icons'
import { Popover } from './Popover'
import { reportFailure } from '../notices'

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
                onClick={() =>
                  void magpie
                    .setDownloadsPaused(!paused)
                    .then(setState)
                    .catch(reportFailure('notice.unexpected'))
                }
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
                    void magpie
                      .setTaskPaused(task.id, !task.paused)
                      .then(setState)
                      .catch(reportFailure('notice.unexpected'))
                  }
                />
              ))}
              <QueuedSteps running={tasks} />
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
                    onClick={() =>
                      void magpie
                        .setLoadProfile(profile)
                        .then(setState)
                        .catch(reportFailure('notice.unexpected'))
                    }
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
                aria-label={t('downloads.bandwidthOff')}
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
 * Ce qui attend derrière l'étape en cours.
 *
 * Le registre ne connaît que le travail qui tourne : une étape s'y déclare en démarrant et en
 * sort en finissant. Or les préparations d'après-synchronisation s'enchaînent — les vignettes,
 * puis les clips, puis la lecture des images, puis la transcription — et ce sont les dernières
 * qui coûtent des heures. On lisait donc « Images des tuiles · 412 / 1240 » sans rien qui dise
 * que trois étapes suivaient, dont deux très longues.
 *
 * On ne les inscrit pas au registre pour autant : elles y compteraient comme du travail en
 * cours, fausseraient l'avancement global et feraient s'agiter l'icône de la barre système. Ce
 * sont des lignes d'attente, et rien d'autre.
 */
function QueuedSteps({ running }: { running: BackgroundTask[] }): React.JSX.Element | null {
  const t = useT()
  const afterSync = useStore((s) => s.afterSync)
  const autoOrganize = useStore((s) => s.autoOrganizeEnabled)
  const [backlog, setBacklog] = useState<Record<AfterSyncStep, number> | null>(null)

  useEffect(() => {
    const read = (): void => {
      void Promise.all([
        magpie.pendingCounts(null),
        magpie.imageReadingState(),
        magpie.transcriptState()
      ])
        .then(([pending, images, transcripts]) =>
          setBacklog({
            thumbnails: pending.thumbnails,
            clips: pending.clips,
            images: images.pending,
            transcribe: transcripts.pending
          })
        )
        .catch(() => {})
    }
    read()
    return magpieEvents.onBackgroundState(read)
  }, [])

  /* La chaîne ne part que si le rangement automatique est allumé : sans lui, une étape qui
     tourne est un geste isolé et rien ne la suit. Annoncer une file serait mentir. */
  if (!autoOrganize || !backlog) return null
  /* Le pivot est la **dernière** étape en cours, pas la première : deux peuvent tourner de
     front — la file média sert les vignettes et les clips ensemble — et prendre la première
     réinscrivait la seconde en attente, sur la ligne d'en dessous, en train de tourner. */
  const running_ = AFTER_SYNC_STEPS.filter((step) => running.some((task) => task.kind === step))
  if (running_.length === 0) return null
  const pivot = AFTER_SYNC_STEPS.indexOf(running_[running_.length - 1])

  const queued = AFTER_SYNC_STEPS.slice(pivot + 1).filter(
    (step) =>
      afterSync.includes(step) && backlog[step] > 0 && !running.some((task) => task.kind === step)
  )
  if (queued.length === 0) return null

  return (
    <>
      {queued.map((step) => (
        <li className="downloads__task downloads__task--queued" key={step}>
          <div className="downloads__task-head">
            <span className="downloads__task-name">
              {t(`downloads.kind.${step}` as Parameters<typeof t>[0])}
            </span>
          </div>
          <span className="downloads__task-detail">
            {t('downloads.queued', { count: backlog[step] })}
          </span>
        </li>
      ))}
    </>
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
     regroupement et la synchronisation, eux, se terminent d'eux-mêmes en peu de temps.

     La lecture d'images manquait : `stopImageReading` existait dans le contrat, était
     implémentée côté principal, et **n'était appelée nulle part**. Dix minutes de travail sur
     une bibliothèque de neuf mille posts, dont la seule sortie était « Tout suspendre ». */
  const stoppable =
    task.kind === 'thumbnails' ||
    task.kind === 'clips' ||
    task.kind === 'transcribe' ||
    task.kind === 'images'

  /* Une pause qui ne suspend rien vaut moins qu'une pause absente : elle fait croire que le
     travail s'est arrêté. La synchronisation et le regroupement n'ont pas de boucle qui
     consulte ce drapeau — personne ne le lit pour elles — et rien ne serait gagné à leur en
     donner une : elles se terminent d'elles-mêmes en peu de temps, et une synchronisation
     suspendue à mi-course laisserait un curseur de pagination dans un état ambigu. */
  const pausable = task.kind === 'thumbnails' || task.kind === 'clips' || task.kind === 'images' || task.kind === 'transcribe'

  return (
    <li className={`downloads__task ${halted ? 'is-paused' : ''}`}>
      <div className="downloads__task-head">
        <span className="downloads__task-name">
          {t(`downloads.kind.${task.kind}` as Parameters<typeof t>[0])}
          {task.scope ? <em>{task.scope}</em> : null}
        </span>
        {pausable ? (
          <button
            type="button"
            className="icon-btn-ghost"
            title={t(task.paused ? 'downloads.resume' : 'downloads.pauseAll')}
            aria-label={t(task.paused ? 'downloads.resume' : 'downloads.pauseAll')}
            onClick={onToggle}
          >
            {task.paused ? <IconPlay size={12} /> : <IconPause size={12} />}
          </button>
        ) : null}
        {stoppable ? (
          <button
            type="button"
            className="icon-btn-ghost"
            title={t('downloads.stop')}
            aria-label={t('downloads.stop')}
            onClick={() =>
              void (task.kind === 'transcribe'
                ? magpie.stopTranscription()
                : task.kind === 'images'
                  ? magpie.stopImageReading()
                  : magpie.stopPreload(task.kind as 'thumbnails' | 'clips')
              )
                .then(onStop)
                .catch(reportFailure('notice.unexpected'))
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
