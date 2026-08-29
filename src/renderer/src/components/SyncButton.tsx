import { useCallback, useEffect, useRef, useState } from 'react'
import type { AfterSyncStep } from '@shared/types'
import { AFTER_SYNC_STEPS, PUBLIC_PLATFORMS, SYNC_PAGE_LIMITS } from '@shared/types'
import { magpie, magpieEvents } from '../bridge'
import { CLIP_BYTES, THUMBNAIL_BYTES } from '../estimates'
import { formatBytes, PLATFORM_LABEL } from '../format'
import type { TranslationKey } from '../i18n'
import { useStore, useT } from '../store'
import { useClosing } from '../useClosing'
import { IconCheck,
  IconChevronRight,
  IconClock,
  IconEye,
  IconImage,
  IconMic,
  IconPlay,
  IconPlus,
  IconSend,
  IconSync,
  IconVideo
} from './Icons'
import { PlatformIcon } from './PlatformIcon'

/** Ce qu'il reste à préparer, par étape. Zéro veut dire « à jour », jamais « rien à faire ». */
interface Backlog {
  thumbnails: number
  clips: number
  images: number
  transcripts: number
}

/**
 * Ce que chaque préparation automatique montre d'elle-même.
 *
 * Icône et libellé sont ceux de l'écran de préparation : les deux endroits parlent de la même
 * étape, ils doivent la nommer pareil.
 */
const AFTER_SYNC_ROWS: {
  id: AfterSyncStep
  icon: (props: { size?: number }) => React.JSX.Element
  label: TranslationKey
  /** Ce que l'étape a besoin qu'on ait descendu avant elle. */
  needs?: AfterSyncStep
}[] = [
  { id: 'thumbnails', icon: IconImage, label: 'actions.prepareThumbs' },
  { id: 'clips', icon: IconVideo, label: 'actions.prepareClips' },
  { id: 'images', icon: IconEye, label: 'steps.images' },
  /* La transcription n'a rien à écouter tant que le son n'est pas là : la cocher coche donc
     aussi les clips, plutôt que de laisser allumée une étape qui ne ferait rien. */
  { id: 'transcribe', icon: IconMic, label: 'actions.transcribe', needs: 'clips' }
]

/**
 * Tout ce qui agit sur la bibliothèque, au même endroit.
 *
 * Ces préparations étaient des boutons : on les lançait à la main, une par une, et le clic
 * n'apprenait rien — la synchronisation suivante ramenait du contenu qui restait gris, muet
 * et non lu jusqu'au prochain passage manuel. Ce sont désormais des intentions : ce qui est
 * coché se refait tout seul derrière chaque synchronisation, et « Rattraper maintenant »
 * reste là pour qui ne veut pas attendre la suivante.
 *
 * Elles s'attachent au rangement automatique et s'éteignent avec lui : préparer sans ranger
 * n'a pas d'usage, c'est le classement qui donne leur raison d'être aux images lues et aux
 * clips écoutés.
 */
function ActionsMenu({ onDone }: { onDone(): void }): React.JSX.Element {
  const t = useT()
  const accounts = useStore((s) => s.accounts)
  const startSync = useStore((s) => s.startSync)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const autoOrganizeEnabled = useStore((s) => s.autoOrganizeEnabled)
  const setAutoOrganizeEnabled = useStore((s) => s.setAutoOrganizeEnabled)
  const afterSync = useStore((s) => s.afterSync)
  const setAfterSync = useStore((s) => s.setAfterSync)
  const setExportOpen = useStore((s) => s.setExportOpen)
  const cacheQuality = useStore((s) => s.videoCacheQuality)
  const [backlog, setBacklog] = useState<Backlog | null>(null)

  /* Relu à chaque changement du registre de tâches : un rattrapage qui tourne doit voir ses
     compteurs descendre sous les yeux, sinon rien ne dit qu'il travaille. */
  const readBacklog = useCallback((): void => {
    void Promise.all([
      magpie.pendingCounts(null),
      magpie.transcriptState(),
      magpie.imageReadingState()
    ])
      .then(([pending, transcripts, images]) =>
        setBacklog({
          thumbnails: pending.thumbnails,
          clips: pending.clips,
          images: images.pending,
          transcripts: transcripts.pending
        })
      )
      .catch(() => {})
  }, [])

  useEffect(() => {
    readBacklog()
    return magpieEvents.onBackgroundState(readBacklog)
  }, [readBacklog])

  const missing = accounts.filter((a) => !a.connected)
  const connected = accounts.filter((a) => a.connected)
  const run = (action: () => void): (() => void) => () => {
    action()
    onDone()
  }

  const remaining = (id: AfterSyncStep): number => {
    if (!backlog) return 0
    if (id === 'thumbnails') return backlog.thumbnails
    if (id === 'clips') return backlog.clips
    if (id === 'images') return backlog.images
    return backlog.transcripts
  }

  /** Ce qu'il reste à faire, dit dans l'unité qui compte pour l'étape. */
  const hint = (id: AfterSyncStep): string => {
    const count = remaining(id)
    if (count === 0) return t('downloads.allDone')
    if (id === 'thumbnails') {
      return t('downloads.amount', { count, size: formatBytes(count * THUMBNAIL_BYTES) })
    }
    if (id === 'clips') {
      return t('downloads.amount', { count, size: formatBytes(count * CLIP_BYTES[cacheQuality]) })
    }
    if (id === 'images') return t('steps.imagesCost', { count })
    return t('actions.transcribeHint', { count })
  }

  const toggleStep = (id: AfterSyncStep): void => {
    const row = AFTER_SYNC_ROWS.find((entry) => entry.id === id)
    const next = new Set(afterSync)
    if (next.has(id)) next.delete(id)
    else {
      next.add(id)
      if (row?.needs) next.add(row.needs)
    }
    void setAfterSync([...next])
  }

  /* Le rattrapage lance ce qui est coché puis rend la main : chaque étape s'annonce dans
     l'indicateur de la barre d'outils, qui sait déjà dire où elle en est et l'y suspendre. */
  const catchUp = (): void => {
    for (const step of AFTER_SYNC_STEPS) {
      if (!afterSync.includes(step) || remaining(step) === 0) continue
      if (step === 'thumbnails' || step === 'clips') void magpie.startPreload({ what: step })
      else if (step === 'images') void magpie.startImageReading()
      else void magpie.startTranscription()
    }
  }

  const late = AFTER_SYNC_STEPS.filter(
    (step) => afterSync.includes(step) && remaining(step) > 0
  ).length

  return (
    <>
      {/* Ranger a son propre bouton dans la barre : il n'a plus à se cacher ici. */}
      {/* Ranger tout seul après chaque synchronisation. Sa place est ici, à côté de l'action
          qu'il automatise, plutôt que perdu dans les réglages : c'est en lançant un rangement
          qu'on se demande s'il faut le refaire à la main la prochaine fois. Avec des
          frontières posées, le nouveau contenu tombe dans la région qui lui revient. */}
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={autoOrganizeEnabled}
        onClick={() => void setAutoOrganizeEnabled(!autoOrganizeEnabled)}
      >
        <span className="action-menu__tick" data-on={autoOrganizeEnabled ? 'yes' : 'no'}>
          <IconCheck size={15} />
        </span>
        <span>
          <strong>{t('actions.autoOrganize')}</strong>
          <em>{t('actions.autoOrganizeHint')}</em>
        </span>
      </button>

      {/* Le détail de ce que « ranger tout seul » fait avant de ranger. Éteint avec lui plutôt
          que masqué : un menu dont la hauteur change sous le curseur déplace ce qu'on visait. */}
      <div className="action-menu__nested">
        {AFTER_SYNC_ROWS.map((row) => {
          const Icon = row.icon
          const on = afterSync.includes(row.id)
          return (
            <button
              key={row.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={on}
              disabled={!autoOrganizeEnabled}
              onClick={() => toggleStep(row.id)}
            >
              <span className="action-menu__tick" data-on={on ? 'yes' : 'no'}>
                <IconCheck size={13} />
              </span>
              <span>
                <strong>
                  {t(row.label, { quality: t(`quality.${cacheQuality}` as TranslationKey) })}
                </strong>
                <em>{hint(row.id)}</em>
              </span>
              <Icon size={14} />
            </button>
          )
        })}
        <button
          type="button"
          role="menuitem"
          className="action-menu__catchup"
          disabled={!autoOrganizeEnabled || late === 0}
          onClick={run(catchUp)}
        >
          <IconPlay size={13} />
          <span>
            <strong>{t('actions.catchUp')}</strong>
            <em>{late === 0 ? t('downloads.allDone') : t('actions.catchUpHint')}</em>
          </span>
        </button>
      </div>

      <div className="action-menu__sep" />

      <button type="button" role="menuitem" onClick={run(() => setExportOpen(true))}>
        <IconSend size={15} />
        <span>
          <strong>{t('actions.export')}</strong>
          <em>{t('actions.exportHint')}</em>
        </span>
      </button>

      <div className="action-menu__sep" />

      {missing.length > 0 ? (
        <button type="button" role="menuitem" onClick={run(() => setSettingsOpen(true))}>
          <IconPlus size={15} />
          <span>
            <strong>{t('sync.connectAccount')}</strong>
          </span>
        </button>
      ) : null}
      {connected.length > 0 ? (
        <button
          type="button"
          role="menuitem"
          onClick={run(() => {
            /* La conjonction se traduit : « Instagram et X » arrivait tel quel dans une phrase
               anglaise par ailleurs traduite. */
            const names = connected.map((a) => PLATFORM_LABEL[a.platform]).join(` ${t('common.and')} `)
            if (!window.confirm(t('actions.recheckConfirm', { platforms: names }))) return
            for (const account of connected) void magpie.startFullSync(account.platform)
          })}
        >
          <IconClock size={15} />
          <span>
            <strong>{t('actions.recheck')}</strong>
            <em>{t('actions.recheckHint')}</em>
          </span>
        </button>
      ) : null}
      <button type="button" role="menuitem" onClick={run(() => void startSync())}>
        <IconSync size={15} />
        <span>
          <strong>{t('actions.fetchNew')}</strong>
          <em>{t('actions.fetchNewHint')}</em>
        </span>
      </button>
    </>
  )
}

/** Bouton de synchronisation et progression détaillée de chaque plateforme. */
export function SyncButton(): React.JSX.Element {
  const t = useT()
  const accounts = useStore((s) => s.accounts)
  const sync = useStore((s) => s.sync)
  const startSync = useStore((s) => s.startSync)
  const cancelSync = useStore((s) => s.cancelSync)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [expanded, setExpanded] = useState(false)
  /* Le menu reste monté le temps de refermer : sans ça il disparaissait d'un coup, alors
     qu'il s'était ouvert en fondu. Une ouverture soignée et une fermeture sèche se
     remarquent plus qu'aucune animation du tout. */
  const { mounted, closing } = useClosing(expanded, 150)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sync.running) setExpanded(false)
  }, [sync.running])

  const close = (): void => setExpanded(false)

  useEffect(() => {
    if (!expanded) return
    const closeOutside = (event: PointerEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) close()
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [expanded])

  const connected = accounts.filter((a) => a.connected)

  if (connected.length === 0) {
    return (
      <button
        type="button"
        className="control control--primary"
        onClick={() => setSettingsOpen(true)}
      >
        <IconSync />
        <span>{t('sync.connectAccount')}</span>
      </button>
    )
  }

  if (sync.running) {
    const active = PUBLIC_PLATFORMS.filter((p) => sync.byPlatform[p].phase === 'running')

    return (
      <div className="sync-control-wrap" ref={wrapRef}>
        <div className="sync-control">
          <button
            type="button"
            className="control control--primary sync-control__main"
            onClick={() => void cancelSync()}
            title={t('sync.stop')}
          >
            <span className="spinner" />
            <span>
              {active.length === 1 ? PLATFORM_LABEL[active[0]] : t('sync.syncing')}
              {sync.fetched > 0 ? ` · ${sync.fetched}` : ''}
            </span>
          </button>
          <button
            type="button"
            className="sync-control__toggle"
            aria-expanded={expanded}
            aria-label={t(expanded ? 'sync.hideDetails' : 'sync.showDetails')}
            title={t(expanded ? 'sync.hideDetails' : 'sync.showDetails')}
            onClick={() => setExpanded((open) => !open)}
          >
            <IconChevronRight
              size={14}
              className={`sync-control__chevron ${expanded ? 'is-open' : ''}`}
            />
          </button>
        </div>

        {mounted ? <div
          className={`sync-progress ${closing ? 'is-closing' : ''}`}
          aria-live="polite"
        >
          {active.map((platform) => {
            const progress = sync.byPlatform[platform]
            const percent = Math.min(
              96,
              Math.max(5, (progress.page / SYNC_PAGE_LIMITS[platform]) * 100)
            )
            return (
              <div className="sync-progress__row" key={platform}>
                <PlatformIcon platform={platform} size={17} coloured />
                <div className="sync-progress__body">
                  <div className="sync-progress__head">
                    <strong>{PLATFORM_LABEL[platform]}</strong>
                    <span>
                      {t('sync.progress', {
                        fetched: progress.fetched,
                        added: progress.added,
                        page: progress.page
                      })}
                    </span>
                  </div>
                  <span
                    className="sync-progress__track"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={SYNC_PAGE_LIMITS[platform]}
                    aria-valuenow={progress.page}
                  >
                    <span
                      className="sync-progress__bar"
                      style={{ '--sync-progress': `${percent}%` } as React.CSSProperties}
                    />
                  </span>
                </div>
                <button
                  type="button"
                  className="sync-progress__cancel"
                  onClick={() => void cancelSync(platform)}
                  aria-label={t('sync.cancelPlatform', { platform: PLATFORM_LABEL[platform] })}
                  title={t('sync.cancelPlatform', { platform: PLATFORM_LABEL[platform] })}
                >
                  ×
                </button>
              </div>
            )
          })}

          {/* Les actions restent joignables pendant une synchronisation : elle démarre à
              l'ouverture de l'application, et elle bloquait donc l'accès à l'organisation
              au moment précis où l'on vient de lancer Magpie. */}
          <div className="action-menu action-menu--inline" role="menu">
            <ActionsMenu onDone={close} />
          </div>
        </div> : null}
      </div>
    )
  }

  const attention = PUBLIC_PLATFORMS.filter((p) => sync.byPlatform[p].needsAttention)
  const message = attention.map((p) => sync.byPlatform[p].message).filter(Boolean).join('\n')

  /* Bouton scindé : l'action la plus fréquente reste à un clic, et tout ce qui « agit sur la
     bibliothèque » se range derrière le même chevron. Ces commandes vivaient jusqu'ici à
     quatre endroits — réglages, comptes, indicateur de téléchargement — et l'organisateur
     enfoui dans les réglages n'avait jamais servi une seule fois. */
  return (
    <div className="sync-control-wrap" ref={wrapRef}>
      <div className="sync-control">
        <button
          type="button"
          className={`control control--primary sync-control__main ${
            attention.length > 0 ? 'is-warning' : ''
          }`}
          onClick={() => void startSync()}
          title={message || t('sync.fetchNew')}
        >
          <IconSync />
          <span>{attention.length > 0 ? t('sync.needsAttention') : t('sync.sync')}</span>
        </button>
        <button
          type="button"
          className="sync-control__toggle"
          aria-expanded={expanded}
          aria-haspopup="menu"
          aria-label={t('actions.more')}
          title={t('actions.more')}
          onClick={() => setExpanded((open) => !open)}
        >
          <IconChevronRight
            size={14}
            className={`sync-control__chevron ${expanded ? 'is-open' : ''}`}
          />
        </button>
      </div>

      {mounted ? (
        <div className={`action-menu ${closing ? 'is-closing' : ''}`} role="menu">
          <ActionsMenu onDone={close} />
        </div>
      ) : null}
    </div>
  )
}
