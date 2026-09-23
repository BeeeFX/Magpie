import { app, dialog, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { appendFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  LibraryExportOptions,
  LibraryExportResult,
  LibraryImportPreview,
  LibraryImportReport,
  LibraryImportUndo
} from '@shared/types'
import { dataDir, getDb } from './db'
import {
  importLibraryFile,
  LibraryFileError,
  previewLibraryFile,
  summarise,
  undoImport,
  writeLibraryFile,
  type ImportJournal
} from './library-file'
import { say } from './messages'
import { backgroundTasks } from './tasks'

/**
 * Ce qui relie `library-file.ts` à l'application : les boîtes du système, le registre des
 * tâches, et le journal qui rend un import annulable.
 *
 * Le rendu ne donne jamais un chemin. Il demande d'exporter ou d'importer, et c'est ici qu'on
 * ouvre la boîte de dialogue : un rendu compromis ne peut ni faire lire un fichier arbitraire
 * ni faire écrire ailleurs que là où l'utilisateur l'a choisi. L'import d'un fichier passe par
 * son aperçu, qui rend un jeton ; seul ce jeton déclenche l'écriture.
 */

const EXPORT_TASK = 'export:json'
const IMPORT_TASK = 'import'

/** Un transfert à la fois : deux imports simultanés entrelaceraient leurs journaux. */
let busy = false
let stopRequested = false

/** Le fichier dont l'aperçu vient d'être montré, tel qu'il était à ce moment-là. */
let previewed: {
  token: string
  path: string
  fileName: string
  size: number
  mtimeMs: number
  declared: number
} | null = null

/** Demande l'arrêt. Il a lieu entre deux paquets, jamais au milieu d'une transaction. */
export function stopLibraryTransfer(): void {
  stopRequested = true
}

function claim(): void {
  if (busy) throw new Error(say('transfer.busy'))
  busy = true
  stopRequested = false
}

/** Une erreur de fichier devient une phrase, dans la langue de l'interface. */
function translated(error: unknown): unknown {
  if (error instanceof LibraryFileError) {
    return new Error(say(`transfer.${error.problem}`, error.vars))
  }
  return error
}

function today(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export async function exportLibraryJson(
  parent: BrowserWindow | null,
  options: LibraryExportOptions
): Promise<LibraryExportResult | null> {
  const dialogOptions = {
    title: say('transfer.exportTitle'),
    defaultPath: join(app.getPath('documents'), `magpie-library-${today()}.json`),
    filters: [{ name: say('transfer.fileFilter'), extensions: ['json'] }]
  }
  const choice = parent
    ? await dialog.showSaveDialog(parent, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions)
  if (choice.canceled || !choice.filePath) return null

  claim()
  try {
    backgroundTasks.update(EXPORT_TASK, { kind: 'export', scope: 'JSON', done: 0, total: 0 })
    const result = await writeLibraryFile(getDb(), choice.filePath, {
      includeRaw: options.includeRaw,
      appVersion: app.getVersion(),
      progress: (done, total) =>
        backgroundTasks.update(EXPORT_TASK, { kind: 'export', scope: 'JSON', done, total }),
      shouldStop: () => stopRequested
    })
    return { path: choice.filePath, ...result, at: Date.now() }
  } catch (error) {
    throw translated(error)
  } finally {
    backgroundTasks.clear(EXPORT_TASK)
    busy = false
  }
}

export async function previewLibraryImport(
  parent: BrowserWindow | null
): Promise<LibraryImportPreview | null> {
  const dialogOptions = {
    title: say('transfer.importTitle'),
    properties: ['openFile'] as Array<'openFile'>,
    filters: [{ name: say('transfer.fileFilter'), extensions: ['json'] }]
  }
  const choice = parent
    ? await dialog.showOpenDialog(parent, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)
  const path = choice.filePaths[0]
  if (choice.canceled || !path) return null

  claim()
  const fileName = basename(path)
  try {
    const info = await stat(path).catch(() => {
      throw new LibraryFileError('unreadable')
    })
    backgroundTasks.update(IMPORT_TASK, { kind: 'import', scope: fileName, done: 0, total: 0 })
    const preview = await previewLibraryFile(getDb(), path, {
      onPosts: (seen, declared) =>
        backgroundTasks.update(IMPORT_TASK, {
          kind: 'import',
          scope: fileName,
          done: seen,
          total: declared ?? 0
        })
    })
    const token = randomUUID()
    previewed = {
      token,
      path,
      fileName,
      size: info.size,
      mtimeMs: info.mtimeMs,
      declared: preview.posts.total + preview.posts.invalid
    }
    return { token, fileName, bytes: info.size, ...preview }
  } catch (error) {
    throw translated(error)
  } finally {
    backgroundTasks.clear(IMPORT_TASK)
    busy = false
  }
}

/* ------------------------------------------------------------------ le journal */

/**
 * Le journal du dernier import, une ligne par paquet.
 *
 * Un fichier et non une table : le schéma n'a pas à grandir pour un filet qui ne sert qu'au
 * dernier geste — c'est le même parti que `organizer_applications`, qui ne garde que le dernier
 * classement. Écrit **au fil de l'import**, paquet par paquet et après chaque transaction : un
 * import interrompu par une fermeture reste annulable jusqu'à son dernier paquet écrit.
 *
 * Il s'écrit d'abord à côté (`.part`) et ne remplace le précédent qu'à la fin, et seulement si
 * l'import a changé quelque chose. Réimporter le même fichier — ce qui ne change rien — ne doit
 * pas faire perdre l'annulation de l'import qui, lui, a tout apporté.
 */
/** Le nom du journal, que le déplacement de la bibliothèque emporte aussi. */
export const IMPORT_JOURNAL = 'last-import.jsonl'

function journalPath(): string {
  return join(dataDir(), IMPORT_JOURNAL)
}

type JournalLine =
  | { kind: 'header'; at: number; fileName: string }
  | { kind: 'batch'; entry: ImportJournal }
  | { kind: 'report'; report: LibraryImportReport }

async function readJournal(
  path: string
): Promise<{ header: { at: number; fileName: string }; entries: ImportJournal[]; report: LibraryImportReport | null } | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  let header: { at: number; fileName: string } | null = null
  let report: LibraryImportReport | null = null
  const entries: ImportJournal[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as JournalLine
      if (parsed.kind === 'header') header = { at: parsed.at, fileName: parsed.fileName }
      else if (parsed.kind === 'batch') entries.push(parsed.entry)
      else if (parsed.kind === 'report') report = parsed.report
    } catch {
      /* Une dernière ligne tronquée par une fermeture brutale : ce qui précède reste valable. */
    }
  }
  return header ? { header, entries, report } : null
}

/** Le journal le plus récent : celui d'un import interrompu passe devant celui d'avant. */
async function currentJournal(): Promise<{
  path: string
  header: { at: number; fileName: string }
  entries: ImportJournal[]
  report: LibraryImportReport
} | null> {
  for (const path of [`${journalPath()}.part`, journalPath()]) {
    const journal = await readJournal(path)
    if (!journal) continue
    const report =
      journal.report ??
      summarise(journal.entries, { ...journal.header, stopped: true })
    return { path, ...journal, report }
  }
  return null
}

function changedSomething(report: LibraryImportReport): boolean {
  return (
    report.postsAdded +
      report.postsMerged +
      report.collectionsCreated +
      report.collectionsCompleted +
      report.mapLabels >
    0
  )
}

export async function importLibrary(token: string): Promise<LibraryImportReport> {
  const file = previewed
  if (!file || file.token !== token) throw new Error(say('transfer.changed'))
  /* Le fichier doit être celui de l'aperçu : on a montré des nombres, on importe ces nombres. */
  const info = await stat(file.path).catch(() => null)
  if (!info || info.size !== file.size || info.mtimeMs !== file.mtimeMs) {
    previewed = null
    throw new Error(say('transfer.changed'))
  }

  claim()
  const partial = `${journalPath()}.part`
  const at = Date.now()
  try {
    /* Un `.part` resté là est le journal d'un import que l'application n'a pas vu finir : il
       devient le dernier import connu avant que le nouveau ne commence le sien. */
    await rename(partial, journalPath()).catch(() => {})
    await writeFile(partial, `${JSON.stringify({ kind: 'header', at, fileName: file.fileName })}\n`)
    backgroundTasks.update(IMPORT_TASK, {
      kind: 'import',
      scope: file.fileName,
      done: 0,
      total: file.declared
    })
    const { journal, stopped } = await importLibraryFile(getDb(), file.path, {
      progress: (done) =>
        backgroundTasks.update(IMPORT_TASK, {
          kind: 'import',
          scope: file.fileName,
          done,
          total: file.declared
        }),
      shouldStop: () => stopRequested,
      journal: (entry) => appendFile(partial, `${JSON.stringify({ kind: 'batch', entry })}\n`)
    })
    const report = summarise(journal, { at, fileName: file.fileName, stopped })
    if (changedSomething(report)) {
      await appendFile(partial, `${JSON.stringify({ kind: 'report', report })}\n`)
      await rename(partial, journalPath())
    } else {
      await rm(partial, { force: true })
    }
    previewed = null
    return report
  } catch (error) {
    throw translated(error)
  } finally {
    backgroundTasks.clear(IMPORT_TASK)
    busy = false
  }
}

export async function lastLibraryImport(): Promise<LibraryImportReport | null> {
  const journal = await currentJournal()
  return journal && changedSomething(journal.report) ? journal.report : null
}

export async function undoLibraryImport(): Promise<LibraryImportUndo> {
  claim()
  try {
    const journal = await currentJournal()
    if (!journal) throw new Error(say('transfer.noUndo'))
    const scope = journal.header.fileName
    backgroundTasks.update(IMPORT_TASK, { kind: 'import', scope, done: 0, total: 0 })
    const counts = await undoImport(getDb(), journal.entries, (done, total) =>
      backgroundTasks.update(IMPORT_TASK, { kind: 'import', scope, done, total })
    )
    await rm(journal.path, { force: true })
    return counts
  } finally {
    backgroundTasks.clear(IMPORT_TASK)
    busy = false
  }
}
