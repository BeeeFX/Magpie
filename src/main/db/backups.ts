import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { BackupStatus } from '@shared/types'
import {
  autoBackupName,
  BACKUPS_DIR,
  backupsToPrune,
  listAutomaticBackups,
  type BackupFile
} from './backup-files'
import { dataDir, getDb } from './index'

/**
 * Sauvegardes régulières de la base. Voir SPEC.md §10.
 *
 * Il n'y en avait pas : la seule copie était celle posée avant une migration, donc une par
 * changement de schéma — et le secours d'ouverture restaurait celle-là, qui pouvait dater de
 * plusieurs mois. Une base abîmée par une coupure de courant ou un disque fatigué emportait
 * tout ce qui avait été rangé depuis.
 *
 * **Une par jour, sans bloquer.** Au démarrage si la dernière a plus de vingt-quatre heures,
 * puis à la même condition toutes les heures tant que l'application tourne. La copie passe par
 * l'API de sauvegarde de SQLite (`db.backup()` de better-sqlite3), qui avance par paquets de
 * pages entre deux tours de boucle : l'interface ne gèle pas, et les écritures faites pendant
 * la copie y sont reportées puisque c'est la même connexion. `VACUUM INTO` — le filet d'avant
 * migration — donnerait un fichier plus compact, mais d'un seul bloc synchrone : plusieurs
 * secondes de fenêtre figée sur la bibliothèque de référence.
 *
 * **Une copie complète ou rien.** On écrit dans un `.part`, renommé une fois fini : une copie
 * interrompue — fermeture de l'application, disque plein — ne peut pas passer pour une
 * sauvegarde, ni être restaurée à la place d'une vraie.
 *
 * La rotation est décrite avec `backupsToPrune`.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const CHECK_EVERY_MS = 60 * 60 * 1000
/** Le démarrage a déjà assez à faire : cache réconcilié, première passe média, synchronisation. */
const STARTUP_DELAY_MS = 45 * 1000

let running: Promise<BackupFile> | null = null
let suspended = false
let lastError: string | null = null
let startupTimer: ReturnType<typeof setTimeout> | null = null
let hourlyTimer: ReturnType<typeof setInterval> | null = null

export function backupsDir(): string {
  const dir = join(dataDir(), BACKUPS_DIR)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Les restes d'une copie interrompue. Aucun n'est une sauvegarde. */
function sweepPartials(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (!/\.part(-journal|-wal|-shm)?$/.test(name)) continue
    try {
      rmSync(join(dir, name), { force: true })
    } catch (error) {
      console.warn(`[magpie] ${name} n’a pas pu être retiré`, error)
    }
  }
}

function prune(): void {
  for (const stale of backupsToPrune(listAutomaticBackups(dataDir()))) {
    /* Chaque fichier pour lui-même : un fichier verrouillé ne doit pas emporter le ménage des
       suivants — c'est la leçon des mises à l'écart, dans `db/index.ts`. */
    try {
      rmSync(stale.path, { force: true })
      console.log(`[magpie] Sauvegarde périmée retirée : ${stale.name}.`)
    } catch (error) {
      console.warn(`[magpie] ${stale.name} n’a pas pu être retirée`, error)
    }
  }
}

async function writeBackup(): Promise<BackupFile> {
  const dir = backupsDir()
  sweepPartials(dir)
  const at = Date.now()
  const name = autoBackupName(at)
  const target = join(dir, name)
  const partial = `${target}.part`
  try {
    await getDb().backup(partial)
    /* La copie hérite du mode WAL de la base : ouverte plus tard pour être contrôlée ou
       restaurée, elle ferait naître ses propres journaux à côté d'elle. Repassée en journal
       classique, elle tient en un seul fichier — ce qu'on attend d'une sauvegarde. */
    const copy = new Database(partial)
    try {
      copy.pragma('journal_mode = DELETE')
    } finally {
      copy.close()
    }
    renameSync(partial, target)
  } catch (error) {
    sweepPartials(dir)
    throw error
  }
  lastError = null
  console.log(`[magpie] Sauvegarde de la base : ${name}.`)
  prune()
  return listAutomaticBackups(dataDir()).find((backup) => backup.name === name) ?? {
    name,
    path: target,
    at,
    kind: 'auto',
    bytes: 0
  }
}

/**
 * Une copie maintenant. Deux demandes simultanées partagent la même copie ; rien ne part
 * pendant un déplacement de bibliothèque, qui recopie lui-même ce dossier.
 */
export function backupNow(): Promise<BackupFile> {
  if (running) return running
  if (suspended) {
    return Promise.reject(new Error('Déplacement de la bibliothèque en cours : sauvegarde reportée.'))
  }
  running = writeBackup().finally(() => {
    running = null
  })
  return running
}

export function backupStatus(): BackupStatus {
  const backups = listAutomaticBackups(dataDir())
  return {
    lastAt: backups[0]?.at ?? null,
    count: backups.length,
    bytes: backups.reduce((sum, backup) => sum + backup.bytes, 0),
    running: running !== null,
    lastError
  }
}

/** Une copie si la dernière a plus d'un jour — et s'il y a quelque chose à sauver. */
function backupIfDue(): void {
  if (suspended || running) return
  try {
    const newest = listAutomaticBackups(dataDir())[0]
    if (newest && Date.now() - newest.at < DAY_MS) return
    /* Une bibliothèque vide n'a rien à perdre, et sa copie compterait pour la journée : la
       première vraie sauvegarde attendrait alors le lendemain. */
    const posts = (getDb().prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n
    if (posts === 0) return
  } catch (error) {
    console.warn('[magpie] Sauvegarde automatique non évaluée', error)
    return
  }
  void backupNow().catch((error: unknown) => {
    /* L'échec reste dans l'état, que l'écran de la bibliothèque affiche à côté de la date de
       la dernière copie : une sauvegarde qui échoue en silence tous les jours, c'est
       exactement ce qu'on découvre le jour où on en a besoin. Une copie demandée à la main,
       elle, répond directement au geste. */
    lastError = error instanceof Error ? error.message : String(error)
    console.warn('[magpie] Sauvegarde automatique impossible', error)
  })
}

export function startBackupSchedule(): void {
  stopBackupSchedule()
  startupTimer = setTimeout(backupIfDue, STARTUP_DELAY_MS)
  startupTimer.unref?.()
  hourlyTimer = setInterval(backupIfDue, CHECK_EVERY_MS)
  hourlyTimer.unref?.()
}

export function stopBackupSchedule(): void {
  if (startupTimer) clearTimeout(startupTimer)
  if (hourlyTimer) clearInterval(hourlyTimer)
  startupTimer = null
  hourlyTimer = null
}

/**
 * Suspend les copies le temps d'un déplacement de bibliothèque : la copie en cours finit, et
 * aucune ne commence tant que le dossier est en train d'être recopié ailleurs.
 */
export async function suspendBackups(): Promise<void> {
  suspended = true
  if (running) await running.catch(() => {})
}

export function resumeBackups(): void {
  suspended = false
}
