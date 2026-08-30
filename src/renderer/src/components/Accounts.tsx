import { useState } from 'react'
import type { ConnectFailure, Platform } from '@shared/types'
import { PUBLIC_PLATFORMS, SYNC_PAGE_LIMITS } from '@shared/types'
import { formatDateTime, formatTime, PLATFORM_LABEL } from '../format'
import type { TranslationKey } from '../i18n'
import { describeError, reportFailure } from '../notices'
import { useStore, useT } from '../store'
import { ConfirmButton } from './ConfirmButton'
import { PlatformIcon } from './PlatformIcon'
import { magpie } from '../bridge'

const STATUS_NOTE: Record<string, TranslationKey> = {
  challenge: 'accounts.statusChallenge',
  expired: 'accounts.statusExpired',
  error: 'accounts.statusError'
}

/**
 * Ce qu'une ligne de compte montre quand la connexion ne s'est pas faite.
 *
 * L'échec était une exception dont on lisait la **phrase** — `/annulée|cancelled/i` — pour
 * savoir s'il fallait l'afficher. Deux conséquences : traduire les messages du processus
 * principal aurait cassé ce filtre en silence, et ce qu'on affichait était le texte brut
 * d'Electron, enveloppe d'IPC comprise. La cause est maintenant nommée, et `cancelled` n'a
 * délibérément aucune entrée ici : refermer une fenêtre ne mérite pas une alerte rouge.
 */
const CONNECT_HINT: Partial<Record<ConnectFailure, TranslationKey>> = {
  challenge: 'accounts.hintChallenge',
  network: 'accounts.hintNetwork',
  unknown: 'accounts.hintUnknown'
}

interface Trouble {
  message: string
  hint?: TranslationKey
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
  /* Une erreur par ligne, et non plus une seule pour les trois : le message s'affichait sous
     le bloc entier, sans jamais dire de quel compte il parlait. */
  const [trouble, setTrouble] = useState<Partial<Record<Platform, Trouble>>>({})

  const lastSync = (ms: number | null): string => {
    if (!ms) return t('accounts.neverSynced')
    const sameDay = new Date(ms).toDateString() === new Date().toDateString()
    return sameDay ? t('accounts.today', { time: formatTime(ms) }) : formatDateTime(ms)
  }

  const run = async (platform: Platform, action: () => Promise<Trouble | null>): Promise<void> => {
    setBusy((current) => new Set(current).add(platform))
    setTrouble(({ [platform]: _forgotten, ...rest }) => rest)
    try {
      const failure = await action()
      if (failure) setTrouble((current) => ({ ...current, [platform]: failure }))
    } catch (err) {
      // Le filet : une panne qu'aucune cause connue ne couvre reste visible plutôt que muette.
      setTrouble((current) => ({
        ...current,
        [platform]: { message: describeError(err), hint: 'accounts.hintUnknown' }
      }))
    } finally {
      setBusy((current) => {
        const next = new Set(current)
        next.delete(platform)
        return next
      })
    }
  }

  const attempt = (platform: Platform): Promise<Trouble | null> =>
    connect(platform).then((result) => {
      if (result.ok) return null
      const hint = CONNECT_HINT[result.reason]
      // Un abandon n'est pas une panne : rien à afficher, et la ligne reste propre.
      return hint ? { message: result.message, hint } : null
    })

  return (
    <div className="accounts">
      {PUBLIC_PLATFORMS.map((platform) => {
        const account = accounts.find((a) => a.platform === platform)
        const connected = account?.connected ?? false
        const noteKey = account?.lastSyncStatus ? STATUS_NOTE[account.lastSyncStatus] : undefined
        const progress = sync.byPlatform[platform]
        const isSyncing = progress.phase === 'running'
        const isBusy = busy.has(platform)
        const failure = trouble[platform]
        const syncPercent = Math.min(
          96,
          Math.max(5, (progress.page / SYNC_PAGE_LIMITS[platform]) * 100)
        )

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
              {failure ? (
                /* `role="alert"` : le message n'apparaît qu'après un geste, et sans lui les
                   lecteurs d'écran ne signalaient jamais l'échec d'une connexion. */
                <p className="account__error" role="alert">
                  {failure.message}
                  {failure.hint ? (
                    <span className="account__error-hint">{t(failure.hint)}</span>
                  ) : null}
                </p>
              ) : null}
              {isSyncing ? (
                <div className="account__sync" aria-live="polite">
                  <span
                    className="sync-progress__track"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={SYNC_PAGE_LIMITS[platform]}
                    aria-valuenow={progress.page}
                  >
                    <span
                      className="sync-progress__bar"
                      style={{ '--sync-progress': `${syncPercent}%` } as React.CSSProperties}
                    />
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
            {connected ? (
              <ConfirmButton
                className="btn btn--quiet"
                disabled={isBusy || isSyncing}
                title={t('accounts.fullSyncHint')}
                label="accounts.fullSync"
                confirm="accounts.fullSyncYes"
                onConfirm={() => {
                  void magpie.startFullSync(platform).catch(reportFailure('notice.syncFailed'))
                }}
              />
            ) : null}
            {connected ? (
              /* Déconnecter efface les cookies de session : il faut refaire toute
                 l'authentification, double facteur compris. « Tout revérifier », juste à côté
                 et sans conséquence, demandait pourtant confirmation — pas celui-ci. */
              <ConfirmButton
                className="btn"
                disabled={isBusy || isSyncing}
                label="accounts.disconnect"
                confirm="accounts.disconnectYes"
                onConfirm={() => void run(platform, () => disconnect(platform).then(() => null))}
              />
            ) : (
              <button
                type="button"
                className={`btn ${emphasise ? 'btn--primary' : ''}`}
                /* Seule la plateforme concernée est bloquée : une synchronisation en cours
                   sur l'une ne doit pas empêcher d'en connecter une autre. */
                disabled={isBusy || isSyncing}
                onClick={() => void run(platform, () => attempt(platform))}
              >
                {isBusy ? '…' : t('accounts.connect')}
              </button>
            )}
          </div>
        )
      })}

      <p className="setting__note">{t('accounts.privacy')}</p>
    </div>
  )
}
