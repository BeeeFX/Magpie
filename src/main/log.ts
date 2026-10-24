import { app } from 'electron'
import { closeSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { formatWithOptions } from 'node:util'
import { redact } from './redact'

/**
 * Le journal sur disque de la version installée.
 *
 * L'application empaquetée n'a pas de console sous Windows : les `console.error` et
 * `console.warn` du processus principal — dont les deux filets de `index.ts`, qui n'existent
 * que « pour laisser une trace » — n'allaient **nulle part**. Quand quelqu'un signalait que la
 * synchronisation « s'était arrêtée toute seule », il n'y avait rien à lui demander.
 *
 * La console reste la source : on la double d'une écriture dans `app.getPath('logs')`, sans
 * toucher aux quarante appels existants. Deux fichiers d'un mégaoctet au plus — le courant et
 * le précédent, remplacé quand le courant déborde : de quoi couvrir des jours d'usage sans que
 * le dossier grossisse jamais, et sans dépendance de plus pour si peu.
 *
 * Le fichier est fait pour être joint à un ticket public : chaque ligne passe par
 * {@link redact}, qui retire cookies, jetons et requêtes d'URL signées, et `check:log` interdit
 * de passer une légende, un cookie ou des en-têtes à la console.
 *
 * L'écriture est synchrone, sur un descripteur gardé ouvert : quelques dizaines de
 * microsecondes par ligne, et la ligne est sur le disque même si le processus meurt juste
 * après — c'est précisément la ligne qu'on cherchera.
 */

const CURRENT = 'magpie.log'
const PREVIOUS = 'magpie.old.log'
const MAX_BYTES = 1024 * 1024
/** Une réponse entière recopiée dans un message d'erreur n'apprend rien de plus que son début. */
const MAX_ENTRY = 4000
/** Une boucle qui s'emballe ne doit ni geler le processus principal ni noyer le reste. */
const LINES_PER_SECOND = 200

type Level = 'info' | 'warn' | 'error'

let dir: string | null = null
let fd: number | null = null
let size = 0
let windowStart = 0
let windowLines = 0
let dropped = 0
const home = homedir()

/** Le dossier du journal — celui qu'ouvre le bouton des réglages. */
export function logsDir(): string {
  return dir ?? app.getPath('logs')
}

function openCurrent(folder: string): void {
  mkdirSync(folder, { recursive: true })
  const path = join(folder, CURRENT)
  fd = openSync(path, 'a')
  try {
    size = statSync(path).size
  } catch {
    size = 0
  }
}

function append(line: string): void {
  if (fd === null || dir === null) return
  try {
    const bytes = Buffer.byteLength(line)
    if (size > 0 && size + bytes > MAX_BYTES) {
      closeSync(fd)
      fd = null
      renameSync(join(dir, CURRENT), join(dir, PREVIOUS))
      openCurrent(dir)
    }
    writeSync(fd as number, line)
    size += bytes
  } catch {
    /* Disque plein, dossier retiré : le journal se tait, l'application continue. Écrire
       l'échec dans la console reviendrait ici. */
    fd = null
  }
}

function format(level: Level, args: unknown[]): string {
  let text = redact(
    formatWithOptions({ colors: false, depth: 4, breakLength: Infinity }, ...args),
    home
  )
  if (text.length > MAX_ENTRY) {
    text = `${text.slice(0, MAX_ENTRY)} … (${text.length - MAX_ENTRY} caractères coupés)`
  }
  // Les piles restent lisibles, et chaque entrée commence à la marge.
  return `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${text.replace(/\r?\n/g, '\n    ')}\n`
}

/** Écrit dans le fichier seulement — pour ce qui a déjà sa propre console, comme le renderer. */
export function writeLog(level: Level, ...args: unknown[]): void {
  if (fd === null) return
  const now = Date.now()
  if (now - windowStart >= 1000) {
    if (dropped > 0) {
      append(format('warn', [`[journal] ${dropped} ligne(s) omise(s) : plus de ${LINES_PER_SECOND} par seconde.`]))
      dropped = 0
    }
    windowStart = now
    windowLines = 0
  }
  if (++windowLines > LINES_PER_SECOND) {
    dropped++
    return
  }
  append(format(level, args))
}

/**
 * Ouvre le journal et y branche la console. À appeler une fois, aussi tôt que possible, mais
 * après que `userData` a été fixé — le dossier des journaux en dépend.
 */
export function installLogFile(): void {
  if (fd !== null) return
  try {
    dir = app.getPath('logs')
    openCurrent(dir)
  } catch (error) {
    console.warn('[magpie] Journal sur disque indisponible :', error)
    return
  }
  const methods = [
    ['log', 'info'],
    ['info', 'info'],
    ['warn', 'warn'],
    ['error', 'error']
  ] as const
  for (const [method, level] of methods) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]): void => {
      original(...args)
      /* Node écrit ses propres avertissements — « (node:1234) Warning: … » — par
         `console.error` : ce ne sont pas des erreurs, et les lire comme telles égare. */
      const nodeWarning = typeof args[0] === 'string' && /^\(node:\d+\) (\[\w+\] )?\w*Warning/.test(args[0])
      writeLog(nodeWarning ? 'warn' : level, ...args)
    }
  }
  writeLog(
    'info',
    `[magpie] Démarrage ${app.getVersion()} — Electron ${process.versions.electron}, ` +
      `${process.platform} ${process.arch}${app.isPackaged ? '' : ', développement'}`
  )
}

/**
 * Recopie, ligne à ligne, la sortie d'un processus enfant dans la console — donc aussi dans le
 * journal. Un `stdio: 'inherit'` l'envoyait sur une sortie standard qui, dans la version
 * installée, n'est reliée à rien.
 */
export function forwardOutput(
  stream: NodeJS.ReadableStream | null | undefined,
  label: string,
  level: 'info' | 'warn'
): void {
  if (!stream) return
  let rest = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    const lines = (rest + chunk).split(/\r?\n/)
    rest = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      if (level === 'warn') console.warn(`[${label}] ${line}`)
      else console.log(`[${label}] ${line}`)
    }
  })
}
