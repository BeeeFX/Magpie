import { useEffect, useRef, useState } from 'react'
import { PUBLIC_PLATFORMS, SYNC_PAGE_LIMITS } from '@shared/types'
import { magpie } from '../bridge'
import { CLIP_BYTES, THUMBNAIL_BYTES } from '../estimates'
import { formatBytes, PLATFORM_LABEL } from '../format'
import { useStore, useT } from '../store'
import {
  IconChevronRight,
  IconCollections,
  IconImage,
  IconMic,
  IconPlus,
  IconSync,
  IconVideo
} from './Icons'
import { PlatformIcon } from './PlatformIcon'

/**
 * Tout ce qui agit sur la bibliothèque, au même endroit.
 *
 * Chaque entrée dit ce qu'elle rapporte plutôt que sa catégorie technique, et annonce ce
 * qu'il reste à faire : un bouton qui propose de préparer mille images déjà préparées ne
 * veut rien dire.
 */
function ActionsMenu({ onDone }: { onDone(): void }): React.JSX.Element {
  const t = useT()
  const accounts = useStore((s) => s.accounts)
  const startSync = useStore((s) => s.startSync)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setOrganizerOpen = useStore((s) => s.setOrganizerOpen)
  const cacheQuality = useStore((s) => s.videoCacheQuality)
  const [counts, setCounts] = useState<{ thumbnails: number; clips: number } | null>(null)
  const [transcripts, setTranscripts] = useState<{ pending: number; running: boolean } | null>(null)

  useEffect(() => {
    void magpie.pendingCounts(null).then(setCounts).catch(() => {})
    void magpie.transcriptState().then(setTranscripts).catch(() => {})
  }, [])

  const missing = accounts.filter((a) => !a.connected)
  const connected = accounts.filter((a) => a.connected)
  const run = (action: () => void): (() => void) => () => {
    action()
    onDone()
  }

  return (
    <>
      <button type="button" role="menuitem" onClick={run(() => setOrganizerOpen(true))}>
        <IconCollections size={15} />
        <span>
          <strong>{t('actions.organize')}</strong>
          <em>{t('actions.organizeHint')}</em>
        </span>
      </button>

      <div className="action-menu__sep" />

      <button
        type="button"
        role="menuitem"
        disabled={(counts?.thumbnails ?? 0) === 0}
        onClick={run(() => void magpie.startPreload({ what: 'thumbnails' }))}
      >
        <IconImage size={15} />
        <span>
          <strong>{t('downloads.thumbsName')}</strong>
          <em>
            {(counts?.thumbnails ?? 0) === 0
              ? t('downloads.allDone')
              : t('downloads.amount', {
                  count: counts?.thumbnails ?? 0,
                  size: formatBytes((counts?.thumbnails ?? 0) * THUMBNAIL_BYTES)
                })}
          </em>
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={(counts?.clips ?? 0) === 0}
        onClick={run(() => void magpie.startPreload({ what: 'clips' }))}
      >
        <IconVideo size={15} />
        <span>
          <strong>{t('downloads.clipsName', { quality: t(`quality.${cacheQuality}`) })}</strong>
          <em>
            {(counts?.clips ?? 0) === 0
              ? t('downloads.allDone')
              : t('downloads.amount', {
                  count: counts?.clips ?? 0,
                  size: formatBytes((counts?.clips ?? 0) * CLIP_BYTES[cacheQuality])
                })}
          </em>
        </span>
      </button>

      {/* Dire l'état réel des clips, pas une catégorie. Une vignette est une image fixe et ne
          contient aucun son : c'est la présence des vidéos qui décide s'il y a 14 Go à
          descendre ou rien du tout. La confusion s'est produite en conditions réelles. */}
      <button
        type="button"
        role="menuitem"
        disabled={(transcripts?.pending ?? 0) === 0}
        onClick={run(() => {
          const clipsMissing = counts?.clips ?? 0
          const message =
            clipsMissing > 0
              ? t('actions.transcribeAskDownload', {
                  count: transcripts?.pending ?? 0,
                  size: formatBytes(clipsMissing * CLIP_BYTES[cacheQuality])
                })
              : t('actions.transcribeAskReady', { count: transcripts?.pending ?? 0 })
          if (window.confirm(message)) void magpie.startTranscription()
        })}
      >
        <IconMic size={15} />
        <span>
          <strong>{t('actions.transcribe')}</strong>
          <em>
            {(transcripts?.pending ?? 0) === 0
              ? t('downloads.allDone')
              : t('actions.transcribeHint', { count: transcripts?.pending ?? 0 })}
          </em>
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
      {connected.map((account) => (
        <button
          key={account.platform}
          type="button"
          role="menuitem"
          onClick={run(() => {
            if (
              window.confirm(
                t('accounts.fullSyncConfirm', { platform: PLATFORM_LABEL[account.platform] })
              )
            ) {
              void magpie.startFullSync(account.platform)
            }
          })}
        >
          <PlatformIcon platform={account.platform} size={15} />
          <span>
            <strong>
              {t('actions.recheck', { platform: PLATFORM_LABEL[account.platform] })}
            </strong>
            <em>{t('accounts.fullSyncHint')}</em>
          </span>
        </button>
      ))}
      <button type="button" role="menuitem" onClick={run(() => void startSync())}>
        <IconSync size={15} />
        <span>
          <strong>{t('sync.fetchNew')}</strong>
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
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sync.running) setExpanded(false)
  }, [sync.running])

  useEffect(() => {
    if (!expanded) return
    const closeOutside = (event: PointerEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setExpanded(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExpanded(false)
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
            onClick={() => setExpanded((value) => !value)}
          >
            <IconChevronRight
              size={14}
              className={`sync-control__chevron ${expanded ? 'is-open' : ''}`}
            />
          </button>
        </div>

        {expanded ? <div className="sync-progress" aria-live="polite">
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
          onClick={() => setExpanded((value) => !value)}
        >
          <IconChevronRight
            size={14}
            className={`sync-control__chevron ${expanded ? 'is-open' : ''}`}
          />
        </button>
      </div>

      {expanded ? (
        <div className="action-menu" role="menu">
          <ActionsMenu onDone={() => setExpanded(false)} />
        </div>
      ) : null}
    </div>
  )
}
