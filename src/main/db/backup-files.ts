import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Les sauvegardes de la base, telles qu'elles vivent sur le disque.
 *
 * Isolé de `backups.ts` pour deux raisons : `db/index.ts` en a besoin pour choisir quoi
 * restaurer, alors que `backups.ts` a besoin de `db/index.ts` pour ouvrir la base — et
 * `check:library-guard` rejoue la rotation sans ouvrir quoi que ce soit.
 *
 * **Dans la bibliothèque, pas à côté.** Le dossier `backups/` suit `dataDir()` : déplacer la
 * bibliothèque l'emporte, et une restauration trouve ses sauvegardes là où est la base.
 *
 * **La date est dans le nom.** Le déplacement recopie les fichiers, ce qui leur donne à tous la
 * date du déplacement : trier sur `mtime` aurait alors restauré n'importe laquelle.
 */

export const BACKUPS_DIR = 'backups'

/** `magpie-2026-09-23T150210Z.db` — lisible dans un explorateur, triable, sans ambiguïté d'heure. */
const AUTO_PATTERN = /^magpie-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z\.db$/

/** Le filet posé avant une migration, à la racine de la bibliothèque. Voir `db/index.ts`. */
export const MIGRATION_BACKUP_PATTERN = /^magpie-before-v\d+-(\d+)\.db$/

export interface BackupFile {
  name: string
  path: string
  /** Le moment de la copie, lu dans le nom. */
  at: number
  kind: 'auto' | 'migration'
  bytes: number
}

export function autoBackupName(at: number): string {
  const iso = new Date(at).toISOString() // 2026-09-23T15:02:10.123Z
  return `magpie-${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z.db`
}

export function autoBackupTime(name: string): number | null {
  const match = AUTO_PATTERN.exec(name)
  if (!match) return null
  const [, year, month, day, hours, minutes, seconds] = match.map(Number)
  const at = Date.UTC(year, month - 1, day, hours, minutes, seconds)
  return Number.isFinite(at) ? at : null
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Les sauvegardes régulières, la plus récente d'abord. */
export function listAutomaticBackups(libraryDir: string): BackupFile[] {
  const dir = join(libraryDir, BACKUPS_DIR)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const found: BackupFile[] = []
  for (const name of names) {
    const at = autoBackupTime(name)
    if (at === null) continue
    const path = join(dir, name)
    found.push({ name, path, at, kind: 'auto', bytes: sizeOf(path) })
  }
  return found.sort((a, b) => b.at - a.at)
}

/**
 * Tout ce qui peut remplacer une base illisible, la plus récente d'abord : les sauvegardes
 * régulières **et** le filet d'avant migration.
 *
 * Seul ce dernier existait, et c'est lui que le secours restaurait — une copie qui pouvait
 * dater de plusieurs mois, puisqu'on n'en pose une qu'à chaque changement de schéma. Mêlées et
 * triées par date, les deux familles laissent gagner la plus récente, quelle qu'elle soit.
 */
export function listRestoreCandidates(libraryDir: string): BackupFile[] {
  const found = listAutomaticBackups(libraryDir)
  let names: string[] = []
  try {
    names = readdirSync(libraryDir)
  } catch {
    // Un dossier illisible n'a rien à offrir ; l'appelant le saura bien assez tôt.
  }
  for (const name of names) {
    const match = MIGRATION_BACKUP_PATTERN.exec(name)
    if (!match) continue
    const path = join(libraryDir, name)
    found.push({ name, path, at: Number(match[1]), kind: 'migration', bytes: sizeOf(path) })
  }
  return found.sort((a, b) => b.at - a.at)
}

/** Combien de jours récents gardent chacun leur copie. */
export const KEEP_DAILY = 7
/** Au-delà, combien de semaines gardent la leur. */
export const KEEP_WEEKLY = 4

function dayKey(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/** Le lundi de la semaine, en heure locale : c'est la semaine telle que l'utilisateur la vit. */
function weekKey(at: number): string {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  return dayKey(date.getTime())
}

/**
 * Ce que la rotation retire.
 *
 * On garde la plus récente de chacun des sept derniers jours où une copie a été faite, puis la
 * plus récente de chacune des quatre semaines d'avant : de quoi revenir sur une erreur
 * remarquée un mois plus tard, pour onze copies au plus. Chacune pèse la base
 * entière — 285 Mo sur la bibliothèque de référence, donc près de trois gigaoctets en régime
 * établi — : c'est le prix, et l'écran de la bibliothèque l'affiche.
 *
 * Par jour **où il y a eu une copie**, pas par jour du calendrier : une application restée
 * fermée deux semaines ne se réveille pas en effaçant tout ce qui date d'avant. Et plusieurs
 * copies le même jour — « Sauvegarder maintenant » — n'en gardent qu'une : cliquer n'use pas
 * l'historique.
 */
export function backupsToPrune<T extends { name: string; at: number }>(
  backups: T[],
  keepDaily = KEEP_DAILY,
  keepWeekly = KEEP_WEEKLY
): T[] {
  const ordered = [...backups].sort((a, b) => b.at - a.at)
  const keep = new Set<string>()
  const days = new Set<string>()
  const weeks = new Set<string>()
  for (const backup of ordered) {
    const day = dayKey(backup.at)
    if (days.has(day) || days.size >= keepDaily) continue
    days.add(day)
    keep.add(backup.name)
  }
  /* Les semaines que les copies quotidiennes couvrent déjà ne comptent pas : les quatre
     hebdomadaires remontent au-delà, sans quoi l'historique s'arrêtait à trois semaines. */
  for (const backup of ordered) {
    if (keep.has(backup.name)) weeks.add(weekKey(backup.at))
  }
  let weekly = 0
  for (const backup of ordered) {
    const week = weekKey(backup.at)
    if (weeks.has(week) || weekly >= keepWeekly) continue
    weeks.add(week)
    weekly += 1
    keep.add(backup.name)
  }
  return ordered.filter((backup) => !keep.has(backup.name))
}
