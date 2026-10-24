import { useEffect, useState } from 'react'
import type {
  BackgroundTask,
  LibraryExportResult,
  LibraryImportPreview,
  LibraryImportReport
} from '@shared/types'
import { magpie, magpieEvents } from '../bridge'
import { formatBytes, formatDate } from '../format'
import type { TranslationKey } from '../i18n'
import { describeError, notifySuccess } from '../notices'
import { useStore, useT } from '../store'
import { ConfirmButton } from './ConfirmButton'

/**
 * Exporter la bibliothèque dans un fichier, et l'y reprendre.
 *
 * SPEC §10 dit que rien n'est captif, et §14 relevait que c'était la seule promesse que le
 * produit contredisait : l'export pour assistant écrit du texte à lire, pas des données à
 * reprendre, et il n'existait aucun import. Changer d'ordinateur, garder une copie ou réunir
 * deux bibliothèques n'avait pas de chemin.
 *
 * Trois temps pour l'import, et c'est délibéré : choisir, **lire ce que ça ferait** — combien de
 * posts nouveaux, combien déjà là, quelles collections — puis confirmer. Il verse des milliers
 * de posts d'un geste ; la seule question utile, « est-ce le bon fichier, dans la bonne
 * bibliothèque ? », se pose sur des nombres. Et le geste reste réversible : le compte rendu
 * porte l'annulation, qui retire exactement ce que l'import a ajouté.
 */

type Busy = 'export' | 'preview' | 'import' | 'undo' | null

const BUSY_LABEL: Record<Exclude<Busy, null>, TranslationKey> = {
  export: 'transfer.exporting',
  preview: 'transfer.reading',
  import: 'transfer.importing',
  undo: 'transfer.undoing'
}

/** Un arrêt demandé n'est pas une panne — même règle que l'export pour assistant. */
function cancelled(error: unknown): boolean {
  return /LibraryTransferCancelled|Transfert interrompu/.test(describeError(error))
}

export function LibraryTransfer(): React.JSX.Element {
  const t = useT()
  const refresh = useStore((state) => state.refresh)
  const [busy, setBusy] = useState<Busy>(null)
  const [includeRaw, setIncludeRaw] = useState(false)
  const [exported, setExported] = useState<LibraryExportResult | null>(null)
  const [preview, setPreview] = useState<LibraryImportPreview | null>(null)
  const [report, setReport] = useState<LibraryImportReport | null>(null)
  /** Le compte rendu vient d'un import de cette session, et pas du journal d'une précédente. */
  const [fresh, setFresh] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [task, setTask] = useState<BackgroundTask | null>(null)

  /* Le dernier import reste annulable d'une ouverture des réglages à l'autre, et même après un
     redémarrage : son journal vit à côté de la base. */
  useEffect(() => {
    void magpie
      .lastLibraryImport()
      .then(setReport)
      .catch(() => {
        /* Sans journal lisible, il n'y a simplement rien à annuler : rien à signaler. */
      })
  }, [])

  /* L'avancement vient du registre des tâches, comme pour tous les travaux longs : le panneau
     des téléchargements et l'icône de la barre système le montrent aussi. */
  useEffect(
    () =>
      magpieEvents.onBackgroundState((state) =>
        setTask(state.tasks.find((entry) => entry.id === 'import' || entry.id === 'export:json') ?? null)
      ),
    []
  )

  const start = (next: Busy): void => {
    setBusy(next)
    setError(null)
    setNotice(null)
  }

  const runExport = async (): Promise<void> => {
    start('export')
    setExported(null)
    try {
      const result = await magpie.exportLibraryJson({ includeRaw })
      if (result) setExported(result)
    } catch (reason) {
      if (cancelled(reason)) setNotice(t('transfer.exportStopped'))
      else setError(describeError(reason))
    } finally {
      setBusy(null)
    }
  }

  const choose = async (): Promise<void> => {
    start('preview')
    setPreview(null)
    try {
      setPreview(await magpie.previewLibraryImport())
    } catch (reason) {
      setError(describeError(reason))
    } finally {
      setBusy(null)
    }
  }

  const runImport = async (): Promise<void> => {
    if (!preview) return
    start('import')
    try {
      const result = await magpie.importLibrary(preview.token)
      setPreview(null)
      setReport(result)
      setFresh(true)
      /* Des milliers de posts peuvent arriver : le mur se reconstruit plutôt que de les
         ajouter à la suite de ce qui était affiché. */
      await refresh(true, true)
    } catch (reason) {
      setError(describeError(reason))
    } finally {
      setBusy(null)
    }
  }

  const undo = async (): Promise<void> => {
    start('undo')
    try {
      const result = await magpie.undoLibraryImport()
      setReport(null)
      setFresh(false)
      notifySuccess('transfer.undone', { count: result.postsRemoved })
      await refresh(true, true)
      /* Un import plus ancien peut redevenir le dernier : on le repropose tel quel. */
      setReport(await magpie.lastLibraryImport())
    } catch (reason) {
      setError(describeError(reason))
    } finally {
      setBusy(null)
    }
  }

  const running = busy !== null
  const percent =
    task && task.total > 0 ? Math.min(100, Math.round((task.done / task.total) * 100)) : null
  const changed = report
    ? report.postsAdded + report.postsMerged + report.collectionsCreated + report.collectionsCompleted + report.mapLabels
    : 0

  return (
    <section className="setting setting--stack">
      <div className="setting__label">
        <h3>{t('transfer.title')}</h3>
        <p>{t('transfer.lead')}</p>
      </div>

      {busy !== null ? (
        <div className="library-move" aria-live="polite">
          <div className="library-move__status">
            <span className="spinner" />
            <strong>{t(BUSY_LABEL[busy])}</strong>
            {task && task.total > 0 ? (
              <span>{t('transfer.progress', { done: task.done, total: task.total })}</span>
            ) : null}
          </div>
          <div
            className="library-move__progress"
            role="progressbar"
            aria-label={t(BUSY_LABEL[busy])}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
          >
            <span style={{ width: `${percent ?? 8}%` }} />
          </div>
        </div>
      ) : null}

      {preview && !running ? (
        <div className="transfer-card">
          <strong>
            {preview.exportedAt
              ? t('transfer.previewFile', {
                  file: preview.fileName,
                  date: formatDate(preview.exportedAt),
                  version: preview.appVersion ?? '?'
                })
              : preview.fileName}
          </strong>
          <ul>
            <li>{t('transfer.previewNew', { count: preview.posts.fresh })}</li>
            {preview.posts.existing > 0 ? (
              <li>{t('transfer.previewExisting', { count: preview.posts.existing })}</li>
            ) : null}
            {preview.collections.total > 0 ? (
              <li>
                {t('transfer.previewCollections', {
                  count: preview.collections.total,
                  fresh: preview.collections.fresh,
                  matched: preview.collections.matched
                })}
              </li>
            ) : null}
            {preview.posts.invalid > 0 ? (
              <li>{t('transfer.previewInvalid', { count: preview.posts.invalid })}</li>
            ) : null}
          </ul>
          <div className="setting__actions">
            <button type="button" className="btn btn--primary" onClick={() => void runImport()}>
              {t('transfer.confirm', { count: preview.posts.fresh })}
            </button>
            <button type="button" className="btn" onClick={() => setPreview(null)}>
              {t('transfer.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {report && !preview && !running ? (
        <div className="transfer-card" aria-live="polite">
          <strong>
            {fresh
              ? t(report.stopped ? 'transfer.stopped' : 'transfer.done')
              : t('transfer.lastImport', { file: report.fileName, date: formatDate(report.at) })}
          </strong>
          {changed === 0 ? (
            <p>{t('transfer.reportNothing')}</p>
          ) : (
            <ul>
              <li>{t('transfer.reportAdded', { count: report.postsAdded })}</li>
              {report.postsMerged > 0 ? (
                <li>
                  {t('transfer.reportMerged', { count: report.postsMerged })}
                  {' — '}
                  {t('transfer.reportDetail', {
                    tags: report.tagsLinked,
                    favourites: report.favourites,
                    labels: report.labels,
                    transcripts: report.transcripts
                  })}
                </li>
              ) : null}
              {report.collectionsCreated + report.collectionsCompleted > 0 ? (
                <li>
                  {t('transfer.reportCollections', {
                    created: report.collectionsCreated,
                    completed: report.collectionsCompleted
                  })}
                </li>
              ) : null}
              {report.invalid > 0 ? (
                <li>{t('transfer.previewInvalid', { count: report.invalid })}</li>
              ) : null}
            </ul>
          )}
          {changed > 0 ? (
            <div className="setting__actions">
              {/* Le seul geste de l'écran qui retire des posts : il le dit, avec le nombre. */}
              <ConfirmButton
                className="btn"
                label="transfer.undo"
                confirm="transfer.undoYes"
                confirmVars={{ count: report.postsAdded }}
                onConfirm={() => void undo()}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {exported && !running ? (
        <p className="setting__note" aria-live="polite">
          {t('transfer.exported', {
            count: exported.posts,
            path: exported.path,
            size: formatBytes(exported.bytes)
          })}
        </p>
      ) : null}
      {notice ? <p className="setting__note">{notice}</p> : null}
      {error ? (
        <p className="setting__error" role="alert">
          {error}
        </p>
      ) : null}

      <label className="transfer-raw">
        <input
          type="checkbox"
          checked={includeRaw}
          disabled={running}
          onChange={(event) => setIncludeRaw(event.target.checked)}
        />
        <span>{t('transfer.includeRaw')}</span>
      </label>
      <div className="setting__actions">
        <button type="button" className="btn" disabled={running} onClick={() => void runExport()}>
          {t('transfer.export')}
        </button>
        <button type="button" className="btn" disabled={running} onClick={() => void choose()}>
          {t('transfer.import')}
        </button>
        {/* L'arrêt tombe entre deux paquets : un import arrêté garde ce qui précède, et
            s'annule pareil ; un export arrêté n'écrit aucun fichier. */}
        {busy === 'export' || busy === 'import' ? (
          <button
            type="button"
            className="btn"
            onClick={() =>
              void magpie.stopLibraryTransfer().catch((reason: unknown) => setError(describeError(reason)))
            }
          >
            {t('transfer.stop')}
          </button>
        ) : null}
      </div>
    </section>
  )
}
