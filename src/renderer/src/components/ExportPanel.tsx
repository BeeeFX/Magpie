import { useEffect, useState } from 'react'
import type { ExportSummary } from '@shared/types'
import { magpie } from '../bridge'
import { formatBytes } from '../format'
import { useStore, useT } from '../store'
import { IconCheck, IconClose, IconCopy, IconSend } from './Icons'

/**
 * Exporter la bibliothèque pour en parler avec l'assistant de son choix.
 *
 * Magpie n'appelle aucun modèle : il écrit un dossier lisible et un prompt système,
 * l'utilisateur les donne à Claude, ChatGPT ou autre, et la conversation a lieu là-bas.
 * Aucune clé, aucun compte, rien à installer — et rien ne part sans un geste explicite.
 *
 * Découplé du reste : utilisable sans avoir jamais créé une collection ni transcrit une
 * vidéo, et on peut y revenir des semaines plus tard.
 */
export function ExportPanel(): React.JSX.Element | null {
  const t = useT()
  const open = useStore((state) => state.exportOpen)
  const setOpen = useStore((state) => state.setExportOpen)
  const [summary, setSummary] = useState<ExportSummary | null>(null)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setCopied(false)
    void magpie.exportPrompt().then(setPrompt).catch(() => {})
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open) return null

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setSummary(await magpie.exportLibrary())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal" onMouseDown={() => setOpen(false)}>
      <div className="modal__panel export-panel" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal__head">
          <div>
            <strong>{t('export.title')}</strong>
            <span>{t('export.subtitle')}</span>
          </div>
          <button
            type="button"
            className="icon-btn-ghost"
            aria-label={t('settings.close')}
            onClick={() => setOpen(false)}
          >
            <IconClose size={16} />
          </button>
        </header>

        <div className="modal__body export-panel__body">
          <p className="export-panel__lead">{t('export.lead')}</p>

          {/* La structure est montrée telle quelle : c'est elle qui rend le dossier
              consultable sans être lu en entier, et l'utilisateur doit pouvoir la vérifier. */}
          <pre className="export-panel__tree">{`export/
  PROMPT.md      ${t('export.treePrompt')}
  index.md       ${t('export.treeIndex')}
  collections/   ${t('export.treeCollections')}
  fiches/        ${t('export.treeSheets')}`}</pre>

          {summary ? (
            <p className="export-panel__done">
              <IconCheck size={14} />
              {t('export.done', {
                posts: summary.posts,
                collections: summary.collections,
                transcripts: summary.transcripts,
                size: formatBytes(summary.bytes)
              })}
            </p>
          ) : null}
          {error ? <p className="organizer-error">{error}</p> : null}

          <details className="export-panel__prompt">
            <summary>{t('export.showPrompt')}</summary>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={12}
              spellCheck={false}
            />
            <p>{t('export.promptHint')}</p>
          </details>
        </div>

        <footer className="modal__foot">
          <button
            type="button"
            className="btn"
            onClick={() => {
              void magpie.copyToClipboard(prompt)
              setCopied(true)
              setTimeout(() => setCopied(false), 1600)
            }}
          >
            <IconCopy size={13} />
            {t(copied ? 'export.copied' : 'export.copyPrompt')}
          </button>
          <button type="button" className="btn" onClick={() => void magpie.openExportFolder()}>
            {t('export.openFolder')}
          </button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void run()}>
            <IconSend size={13} />
            {t(busy ? 'export.running' : 'export.run')}
          </button>
        </footer>
      </div>
    </div>
  )
}
