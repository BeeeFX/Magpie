import { useEffect, useRef, useState } from 'react'
import { PUBLIC_PLATFORMS, SYNC_PAGE_LIMITS } from '@shared/types'
import { PLATFORM_LABEL } from '../format'
import { useStore, useT } from '../store'
import { IconChevronRight, IconSync } from './Icons'
import { PlatformIcon } from './PlatformIcon'

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

  return (
    <button
      type="button"
      className={`control control--primary ${attention.length > 0 ? 'is-warning' : ''}`}
      onClick={() => void startSync()}
      title={message || t('sync.fetchNew')}
    >
      <IconSync />
      <span>{attention.length > 0 ? t('sync.needsAttention') : t('sync.sync')}</span>
    </button>
  )
}
