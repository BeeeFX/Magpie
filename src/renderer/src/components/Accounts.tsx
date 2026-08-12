import { useState } from 'react'
import type { Platform } from '@shared/types'
import { PLATFORMS } from '@shared/types'
import { formatDateTime, formatTime, PLATFORM_LABEL } from '../format'
import type { TranslationKey } from '../i18n'
import { useStore, useT } from '../store'
import { PlatformIcon } from './PlatformIcon'

const STATUS_NOTE: Record<string, TranslationKey> = {
  challenge: 'accounts.statusChallenge',
  expired: 'accounts.statusExpired',
  error: 'accounts.statusError'
}

interface Props {
  /** Met en avant le bouton « Connecter » : c'est l'action attendue pendant l'accueil. */
  emphasise?: boolean
}

export function Accounts({ emphasise = false }: Props): React.JSX.Element {
  const t = useT()
  const accounts = useStore((s) => s.accounts)
  const connect = useStore((s) => s.connectAccount)
  const disconnect = useStore((s) => s.disconnectAccount)
  const sync = useStore((s) => s.sync)
  const [busy, setBusy] = useState<Set<Platform>>(() => new Set())
  const [error, setError] = useState<string | null>(null)

  const lastSync = (ms: number | null): string => {
    if (!ms) return t('accounts.neverSynced')
    const sameDay = new Date(ms).toDateString() === new Date().toDateString()
    return sameDay ? t('accounts.today', { time: formatTime(ms) }) : formatDateTime(ms)
  }

  const run = async (platform: Platform, action: () => Promise<void>): Promise<void> => {
    setBusy((current) => new Set(current).add(platform))
    setError(null)
    try {
      await action()
    } catch (err) {
      const message = (err as Error).message ?? ''
      // Refermer la fenêtre de connexion est un choix délibéré, pas une panne.
      if (!/annulée|cancelled/i.test(message)) setError(message)
    } finally {
      setBusy((current) => {
        const next = new Set(current)
        next.delete(platform)
        return next
      })
    }
  }

  return (
    <div className="accounts">
      {PLATFORMS.map((platform) => {
        const account = accounts.find((a) => a.platform === platform)
        const connected = account?.connected ?? false
        const noteKey = account?.lastSyncStatus ? STATUS_NOTE[account.lastSyncStatus] : undefined
        const progress = sync.byPlatform[platform]
        const isSyncing = progress.phase === 'running'
        const isBusy = busy.has(platform)

        return (
          <div key={platform} className="account">
            <PlatformIcon platform={platform} size={18} coloured />
            <div className="account__text">
              <span className="account__name">{PLATFORM_LABEL[platform]}</span>
              <span className="account__meta">
                {connected
                  ? `${account?.handle ?? t('accounts.connected')} · ${
                      isSyncing ? t('accounts.syncing') : lastSync(account?.lastSyncAt ?? null)
                    }`
                  : t('accounts.notConnected')}
              </span>
              {connected && noteKey ? <span className="account__warn">{t(noteKey)}</span> : null}
              {isSyncing ? (
                <div className="account__sync" aria-live="polite">
                  <span className="sync-progress__track" aria-hidden="true">
                    <span className="sync-progress__bar" />
                  </span>
                  <span className="account__sync-meta">
                    {t('sync.progress', {
                      fetched: progress.fetched,
                      added: progress.added,
                      page: progress.page
                    })}
                  </span>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className={`btn ${emphasise && !connected ? 'btn--primary' : ''}`}
              /* Seule la plateforme concernée est bloquée : une synchronisation en cours
                 sur l'une ne doit pas empêcher d'en connecter une autre. */
              disabled={isBusy || isSyncing}
              onClick={() =>
                void run(platform, () => (connected ? disconnect(platform) : connect(platform)))
              }
            >
              {isBusy
                ? '…'
                : connected
                  ? t('accounts.disconnect')
                  : t('accounts.connect')}
            </button>
          </div>
        )
      })}

      {error ? <p className="account__error">{error}</p> : null}

      <p className="setting__note">{t('accounts.privacy')}</p>
    </div>
  )
}
