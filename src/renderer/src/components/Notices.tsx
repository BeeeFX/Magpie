import { useState } from 'react'
import { magpie } from '../bridge'
import { useNotices, type Notice } from '../notices'
import { useT } from '../store'
import { IconCheck, IconClose, IconCopy } from './Icons'

/**
 * Le calque des réponses.
 *
 * Deux listes plutôt qu'une, et ce n'est pas décoratif : ce qui est urgent s'annonce
 * autrement de ce qui ne l'est pas. Les erreurs vont dans une région `assertive`, qui
 * interrompt la lecture en cours ; le reste dans une région `polite`, qui attend son tour. On
 * ne met pas de `role="alert"` sur les entrées elles-mêmes — il ferait annoncer deux fois.
 *
 * Le relevé technique se replie derrière un bouton. Il n'aide pas à comprendre, il aide à
 * rapporter : c'est le même arbitrage que sur l'écran de dernier recours, qui offre lui aussi
 * de copier le détail plutôt que de l'imposer.
 */
function NoticeRow({ notice }: { notice: Notice }): React.JSX.Element {
  const t = useT()
  const dismiss = useNotices((s) => s.dismiss)
  const [copied, setCopied] = useState(false)

  return (
    <li className={`notice notice--${notice.tone}`}>
      <div className="notice__body">
        <p>
          {t(notice.key, notice.vars)}
          {/* Une répétition compte au lieu de s'empiler : un préchargement qui échoue à chaque
              image posait sinon quarante panneaux par seconde. */}
          {notice.count > 1 ? <span className="notice__count">×{notice.count}</span> : null}
        </p>
        {notice.detail ? <code className="notice__detail">{notice.detail}</code> : null}
        <div className="notice__actions">
          {notice.action ? (
            <button
              type="button"
              className="notice__action"
              onClick={() => {
                notice.action?.run()
                dismiss(notice.id)
              }}
            >
              {t(notice.action.key)}
            </button>
          ) : null}
          {notice.detail ? (
            <button
              type="button"
              className="notice__action"
              onClick={() => {
                /* « Copié » n'apparaît qu'une fois la copie faite. Il apparaissait **dans tous
                   les cas** : la confirmation partait avant la promesse, donc un échec du
                   presse-papier affichait « Copié » puis on collait le vide, sans jamais
                   pouvoir relier les deux.
                   Pas de notification en retour, en revanche : une copie qui échoue ne peut pas
                   s'annoncer dans le calque qu'elle occupe déjà, et le bouton qui reste au repos
                   dit déjà que rien ne s'est passé. */
                void magpie
                  .copyToClipboard(notice.detail ?? '')
                  .then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1600)
                  })
                  .catch(console.error)
              }}
            >
              {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
              {t(copied ? 'notice.copied' : 'notice.copyDetail')}
            </button>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        className="notice__close"
        onClick={() => dismiss(notice.id)}
        aria-label={t('notice.dismiss')}
        title={t('notice.dismiss')}
      >
        <IconClose size={13} />
      </button>
    </li>
  )
}

export function Notices(): React.JSX.Element {
  const items = useNotices((s) => s.items)
  const loud = items.filter((item) => item.tone === 'error')
  const quiet = items.filter((item) => item.tone !== 'error')

  return (
    <div className="notices">
      <ol className="notices__stack" aria-live="polite">
        {quiet.map((notice) => (
          <NoticeRow key={notice.id} notice={notice} />
        ))}
      </ol>
      <ol className="notices__stack" aria-live="assertive">
        {loud.map((notice) => (
          <NoticeRow key={notice.id} notice={notice} />
        ))}
      </ol>
    </div>
  )
}
