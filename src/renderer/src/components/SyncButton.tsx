import { PLATFORMS } from '@shared/types'
import { PLATFORM_LABEL } from '../format'
import { useStore, useT } from '../store'
import { IconSync } from './Icons'
import { PlatformIcon } from './PlatformIcon'

/** Bouton de synchronisation et progression détaillée de chaque plateforme. */
export function SyncButton(): React.JSX.Element {
  const t = useT()
  const accounts = useStore((s) => s.accounts)
  const sync = useStore((s) => s.sync)
  const startSync = useStore((s) => s.startSync)
  const cancelSync = useStore((s) => s.cancelSync)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)

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
    const active = PLATFORMS.filter((p) => sync.byPlatform[p].phase === 'running')

    return (
      <div className="sync-control-wrap">
        <button
          type="button"
          className="control control--primary"
          onClick={() => void cancelSync()}
          title={t('sync.stop')}
        >
          <span className="spinner" />
          <span>
            {active.length === 1 ? PLATFORM_LABEL[active[0]] : t('sync.syncing')}
            {sync.fetched > 0 ? ` · ${sync.fetched}` : ''}
          </span>
        </button>

        <div className="sync-progress" aria-live="polite">
          {active.map((platform) => {
            const progress = sync.byPlatform[platform]
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
                  <span className="sync-progress__track" aria-hidden="true">
                    <span className="sync-progress__bar" />
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
        </div>
      </div>
    )
  }

  const attention = PLATFORMS.filter((p) => sync.byPlatform[p].needsAttention)
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
