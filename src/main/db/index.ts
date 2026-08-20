import { app } from 'electron'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { mediaIdentity } from '../media/identity'
import {
  MIGRATION_9_SQL,
  MIGRATION_10_SQL,
  MIGRATION_11_SQL,
  MIGRATION_12_SQL,
  MIGRATION_13_SQL,
  MIGRATION_14_SQL,
  MIGRATION_15_SQL,
  MIGRATION_16_SQL,
  MIGRATION_17_SQL,
  MIGRATION_18_SQL,
  MIGRATION_19_SQL,
  MIGRATION_20_SQL,
  SCHEMA_SQL,
  SCHEMA_VERSION
} from './schema'

let db: Database.Database | null = null

/**
 * Où vit la bibliothèque, par défaut.
 *
 * `MAGPIE_DATA_DIR` passe devant, et ce n'est pas un réglage : c'est ce qui permet aux bancs et
 * aux diagnostics de faire tourner le vrai code sur une **copie** de la vraie base, sans
 * Electron autour. Sans cette porte, un banc n'a que deux choix — réécrire la couche base pour
 * lui seul, ce que faisait `scripts/library-path.ts`, ou écrire dans la bibliothèque de
 * quelqu'un. La condition est évaluée avant `app`, donc elle fonctionne là où `app` n'existe pas.
 */
function defaultDataDir(): string {
  const forced = process.env.MAGPIE_DATA_DIR
  if (forced && forced.trim()) return forced
  return app.getPath('userData')
}

function locationFile(): string {
  return join(defaultDataDir(), 'library-location.json')
}

export function configuredDataDir(): string | null {
  try {
    const value = JSON.parse(readFileSync(locationFile(), 'utf8')) as { path?: unknown }
    return typeof value.path === 'string' && value.path.trim() ? value.path : null
  } catch {
    return null
  }
}

export function writeDataDirLocation(path: string): void {
  const destination = locationFile()
  const temporary = `${destination}.tmp`
  writeFileSync(temporary, JSON.stringify({ path }, null, 2))
  renameSync(temporary, destination)
}

export function dataDir(): string {
  const dir = configuredDataDir() ?? defaultDataDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    throw new Error(
      `La bibliothèque Magpie est inaccessible : ${dir}. Reconnectez le disque ou restaurez ce dossier.`
    )
  }
  return dir
}

export function mediaDir(): string {
  const dir = join(dataDir(), 'media')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getDb(): Database.Database {
  if (db) return db
  db = openLibrary()
  return db
}

/**
 * Une bibliothèque écrite par une version plus récente que celle qui l'ouvre.
 *
 * Sa propre classe d'erreur, et ce n'est pas une coquetterie : c'est le seul échec d'ouverture
 * qui ne dénote **aucun** problème avec le fichier. Le confondre avec une base abîmée a coûté
 * cher — voir `openLibrary`.
 */
class LibraryFromTheFuture extends Error {}

/**
 * Ouvre la bibliothèque, et la remet debout si elle ne s'ouvre pas.
 *
 * Un cas réel : le fichier principal s'est retrouvé remplacé par une base bien plus
 * ancienne, restée à côté d'un journal appartenant à la vraie. SQLite refuse alors les
 * deux ensemble, et l'application n'avait pour toute réponse qu'une boîte d'erreur et un
 * arrêt — sans aucun moyen de s'en sortir depuis l'interface, alors qu'une sauvegarde
 * intacte dormait dans le même dossier.
 *
 * **Une base venue du futur est le contre-exemple, et il a fait des dégâts.** Une vieille
 * version lancée sur une bibliothèque déjà migrée levait ici, et le secours faisait exactement
 * ce qu'il ne fallait pas : il mettait de côté une base parfaitement saine, restaurait une
 * sauvegarde antérieure — donc perdait tout ce qui avait été fait depuis — puis échouait
 * quand même, la sauvegarde restant elle aussi trop récente pour ce lecteur. Relevé sur la
 * bibliothèque de référence : deux mises à l'écart de 285 Mo en dix secondes, vingt-sept
 * collections évaporées, et l'application toujours incapable de démarrer.
 *
 * Un fichier venu du futur n'a donc rien à réparer. On remonte l'erreur telle quelle et on ne
 * touche à rien : c'est l'application qui est en retard, pas la bibliothèque.
 */
function openLibrary(): Database.Database {
  const path = join(dataDir(), 'magpie.db')
  try {
    return openAndMigrate(path)
  } catch (error) {
    if (error instanceof LibraryFromTheFuture) throw error
    console.error('[magpie] Bibliothèque illisible :', error)
    quarantineLibrary(path)
    const restored = restoreNewestBackup(path)
    console.log(
      restored
        ? `[magpie] Bibliothèque restaurée depuis ${restored}.`
        : '[magpie] Aucune sauvegarde exploitable : nouvelle bibliothèque vide.'
    )
    // Une sauvegarde d'avant-migration est légitimement d'un schéma antérieur : lui
    // opposer le garde-fou de régression reviendrait à refuser le seul secours disponible.
    return openAndMigrate(path, { acceptOlderSchema: true })
  }
}

function openAndMigrate(
  path: string,
  options: { acceptOlderSchema?: boolean } = {}
): Database.Database {
  const conn = new Database(path)
  try {
    return prepareConnection(conn, options.acceptOlderSchema === true)
  } catch (error) {
    // Sous Windows, une connexion laissée ouverte garde la main sur les journaux : sans
    // cette fermeture, la mise à l'écart échouait et le journal dépareillé restait aux
    // côtés de la base restaurée, qui redevenait aussitôt illisible.
    try {
      conn.close()
    } catch {
      // Fermer une connexion déjà morte n'a rien à nous apprendre.
    }
    throw error
  }
}

function prepareConnection(
  conn: Database.Database,
  acceptOlderSchema: boolean
): Database.Database {
  // WAL : lectures concurrentes pendant que le sync écrit. `normal` est le bon compromis
  // durabilité/vitesse pour une base locale qu'on peut de toute façon reconstruire.
  conn.pragma('journal_mode = WAL')
  conn.pragma('synchronous = NORMAL')
  conn.pragma('foreign_keys = ON')

  /* Comparer deux liens de CDN dans une requête demande de savoir lequel des deux désigne
     le même fichier — ce que seul `mediaIdentity` sait dire. La fonction est déclarée sur
     la connexion plutôt que le calcul remonté en JavaScript : l'upsert de synchronisation
     reste ainsi une seule instruction, sans lecture préalable ligne à ligne. */
  conn.function('media_identity', { deterministic: true }, (value: unknown) =>
    mediaIdentity(typeof value === 'string' ? value : null)
  )

  const current = conn.pragma('user_version', { simple: true }) as number

  /*
   * Un schéma qui recule n'est jamais légitime : une version donnée ne sait qu'avancer.
   * Sans ce garde-fou, une base ancienne réapparue à la place de la vraie serait
   * simplement migrée jusqu'au schéma courant — et l'application repartirait sur neuf
   * cents posts au lieu de dix mille, en affichant tous les signes de la normalité.
   * Mieux vaut refuser d'ouvrir : l'appelant met alors le fichier de côté et restaure.
   */
  const seen = readLibraryState()
  if (!acceptOlderSchema && seen && current > 0 && current < seen.schemaVersion) {
    throw new Error(
      `Base en schéma v${current} alors que v${seen.schemaVersion} a déjà été ouvert ici ` +
        `(${seen.posts} posts connus). Fichier probablement remplacé par une copie plus ancienne.`
    )
  }

  if (current > 0 && current < SCHEMA_VERSION) {
    const name = `magpie-before-v${SCHEMA_VERSION}-${Date.now()}.db`
    conn.exec(`VACUUM INTO '${join(dataDir(), name).replaceAll("'", "''")}'`)
    console.log(`[magpie] Sauvegarde avant migration : ${name}.`)
    pruneMigrationBackups(name)
  }

  migrate(conn)
  rememberLibraryState(conn)
  return conn
}

/** Empreinte gardée hors de la base : c'est justement elle qu'on soupçonne. */
interface LibraryState {
  schemaVersion: number
  posts: number
  at: number
}

function libraryStateFile(): string {
  return join(dataDir(), 'library-state.json')
}

function readLibraryState(): LibraryState | null {
  try {
    const value = JSON.parse(readFileSync(libraryStateFile(), 'utf8')) as Partial<LibraryState>
    return typeof value.schemaVersion === 'number' && typeof value.posts === 'number'
      ? { schemaVersion: value.schemaVersion, posts: value.posts, at: Number(value.at) || 0 }
      : null
  } catch {
    return null
  }
}

function rememberLibraryState(conn: Database.Database): void {
  try {
    const posts = (conn.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n
    const temporary = `${libraryStateFile()}.tmp`
    writeFileSync(
      temporary,
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, posts, at: Date.now() } satisfies LibraryState)
    )
    renameSync(temporary, libraryStateFile())
  } catch (error) {
    // L'empreinte est un garde-fou, pas une dépendance : son absence ne bloque rien.
    console.warn('[magpie] Empreinte de bibliothèque non écrite', error)
  }
}

const QUARANTINE_NAME_PATTERN = /^magpie-illisible-[\dTZ.:-]+\.db$/

/**
 * Combien de bases mises à l'écart on garde.
 *
 * Elles pèsent le poids de la bibliothèque entière — 285 Mo pièce sur la bibliothèque de
 * référence — et rien ne les nettoyait : quatre d'entre elles y dormaient, soit un gigaoctet
 * et demi que personne n'avait demandé. Deux suffisent : la dernière dit ce qui vient de mal
 * tourner, l'avant-dernière permet de comparer.
 */
const QUARANTINE_KEEP = 2

/** Écarte la base illisible et ses journaux, sans jamais supprimer ce qu'on vient d'écarter. */
function quarantineLibrary(path: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${path}${suffix}`
    if (!existsSync(source)) continue
    const target = join(dataDir(), `magpie-illisible-${stamp}.db${suffix}`)
    try {
      renameSync(source, target)
      console.log(`[magpie] Mis de côté : ${target}`)
    } catch (error) {
      console.warn(`[magpie] Impossible d'écarter ${source}`, error)
    }
  }
  pruneQuarantine()
}

/** Ne garde que les mises à l'écart les plus récentes. Voir `QUARANTINE_KEEP`. */
function pruneQuarantine(): void {
  try {
    const stale = readdirSync(dataDir())
      .filter((name) => QUARANTINE_NAME_PATTERN.test(name))
      .map((name) => ({ name, at: statSync(join(dataDir(), name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(QUARANTINE_KEEP)
    for (const { name } of stale) {
      for (const suffix of ['', '-wal', '-shm']) {
        rmSync(join(dataDir(), `${name}${suffix}`), { force: true })
      }
      console.log(`[magpie] Mise à l'écart périmée retirée : ${name}.`)
    }
  } catch (error) {
    // La place perdue est un désagrément ; refuser d'ouvrir la bibliothèque en serait un autre.
    console.warn('[magpie] Purge des mises à l’écart impossible', error)
  }
}

/** Remet en place la sauvegarde la plus récente qui passe un contrôle d'intégrité. */
function restoreNewestBackup(path: string): string | null {
  let candidates: string[]
  try {
    candidates = readdirSync(dataDir()).filter((name) => BACKUP_NAME_PATTERN.test(name))
  } catch {
    return null
  }

  const ordered = candidates
    .map((name) => ({ name, at: statSync(join(dataDir(), name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)

  for (const { name } of ordered) {
    const source = join(dataDir(), name)
    try {
      const probe = new Database(source, { readonly: true })
      const integrity = probe.pragma('integrity_check', { simple: true }) as string
      probe.close()
      if (integrity !== 'ok') continue
      copyFileSync(source, path)
      return name
    } catch {
      // Sauvegarde elle-même abîmée : on essaie la précédente.
    }
  }
  return null
}

const BACKUP_NAME_PATTERN = /^magpie-before-v\d+-\d+\.db$/

/**
 * Le filet posé avant chaque migration est une copie intégrale de la bibliothèque. Sans
 * purge, chaque palier de schéma en laissait une de plus dans le dossier, indéfiniment et
 * sans que personne le sache. On ne garde que la dernière : celle qui permet de revenir en
 * arrière si la migration qui vient de s'exécuter tourne mal. Les précédentes décrivent des
 * schémas que cette version ne sait de toute façon plus relire.
 */
function pruneMigrationBackups(keep: string): void {
  try {
    for (const name of readdirSync(dataDir())) {
      if (name === keep || !BACKUP_NAME_PATTERN.test(name)) continue
      rmSync(join(dataDir(), name), { force: true })
      console.log(`[magpie] Sauvegarde de migration périmée retirée : ${name}.`)
    }
  } catch (error) {
    // Un fichier verrouillé ne doit pas empêcher la migration : la place perdue est un
    // désagrément, une bibliothèque qui refuse de s'ouvrir en serait un autre.
    console.warn('[magpie] Purge des sauvegardes de migration impossible', error)
  }
}

/**
 * Une entrée par palier de version : la clé est la version que la migration produit.
 * Elles s'appliquent dans l'ordre, dans une transaction, avec `user_version` mis à jour
 * en même temps — une migration interrompue ne laisse donc jamais la base à moitié
 * migrée.
 */
const MIGRATIONS: Record<number, (conn: Database.Database) => void> = {
  2: (conn) => {
    conn.exec('ALTER TABLE media ADD COLUMN video_source TEXT')
    conn.exec('ALTER TABLE media ADD COLUMN video_path TEXT')
  },
  3: (conn) => {
    conn.exec('ALTER TABLE posts ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0')
    // Tout ce qui existait avant l'arrivée des vrais comptes vient de la fixture.
  },
  4: (conn) => {
    conn.exec('ALTER TABLE posts ADD COLUMN label TEXT')
    conn.exec('ALTER TABLE collections ADD COLUMN color TEXT')
    conn.exec(
      'CREATE INDEX IF NOT EXISTS idx_posts_label ON posts(label) WHERE label IS NOT NULL'
    )
  },
  5: (conn) => {
    conn.exec(`CREATE TABLE IF NOT EXISTS media_variants (
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      quality TEXT NOT NULL,
      source TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      bitrate INTEGER,
      cache_path TEXT,
      PRIMARY KEY (post_id, idx, quality)
    )`)
  },
  6: (conn) => {
    conn.exec("ALTER TABLE media ADD COLUMN video_cache_state TEXT NOT NULL DEFAULT 'pending'")
    conn.exec('ALTER TABLE media ADD COLUMN video_attempts INTEGER NOT NULL DEFAULT 0')
  },
  7: (conn) => {
    conn.exec('ALTER TABLE media ADD COLUMN thumb_attempts INTEGER NOT NULL DEFAULT 0')
    conn.exec(`CREATE INDEX IF NOT EXISTS idx_posts_feed ON posts(
      is_archived, COALESCE(saved_at, discovered_at) DESC, saved_rank ASC, id
    )`)
    conn.exec(
      'CREATE INDEX IF NOT EXISTS idx_media_thumb_queue ON media(thumb_path, thumb_attempts, post_id, idx)'
    )
    conn.exec(`CREATE INDEX IF NOT EXISTS idx_media_video_queue ON media(
      video_cache_state, video_attempts, video_path, post_id, idx
    )`)
  },
  8: (conn) => {
    conn.exec(`CREATE TABLE IF NOT EXISTS local_video_features (
      post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
      thumb_path TEXT,
      visual BLOB,
      updated_at INTEGER NOT NULL
    )`)
  },
  9: (conn) => {
    conn.exec(MIGRATION_9_SQL)
  },
  10: (conn) => {
    conn.exec(MIGRATION_10_SQL)
  },
  11: (conn) => {
    conn.exec(MIGRATION_11_SQL)
  },
  12: (conn) => {
    conn.exec(MIGRATION_12_SQL)
  },
  13: (conn) => {
    conn.exec(MIGRATION_13_SQL)
  },
  14: (conn) => {
    conn.exec(MIGRATION_14_SQL)
  },
  15: (conn) => {
    conn.exec(MIGRATION_15_SQL)
  },
  16: (conn) => {
    conn.exec(MIGRATION_16_SQL)
  },
  17: (conn) => {
    conn.exec(MIGRATION_17_SQL)
  },
  18: (conn) => {
    conn.exec(MIGRATION_18_SQL)
  },
  19: (conn) => {
    conn.exec(MIGRATION_19_SQL)
  },
  20: (conn) => {
    conn.exec(MIGRATION_20_SQL)
  }
}

function migrate(conn: Database.Database): void {
  const current = conn.pragma('user_version', { simple: true }) as number

  if (current > SCHEMA_VERSION) {
    /* Pas une base abîmée : une application en retard. La distinction est portée par le type,
       parce que c'est `openLibrary` qui doit la lire — et surtout ne pas tenter de « réparer »
       un fichier qui n'a rien. */
    throw new LibraryFromTheFuture(
      `Base créée par une version plus récente de Magpie (schéma v${current}, ` +
        `cette version lit v${SCHEMA_VERSION}). Installez la dernière version de Magpie : ` +
        `votre bibliothèque est intacte et n'a pas été modifiée.`
    )
  }

  if (current === 0) {
    conn.transaction(() => {
      conn.exec(SCHEMA_SQL)
      conn.pragma(`user_version = ${SCHEMA_VERSION}`)
    })()
    return
  }

  for (let version = current + 1; version <= SCHEMA_VERSION; version++) {
    const migration = MIGRATIONS[version]
    if (!migration) throw new Error(`Migration manquante vers le schéma v${version}.`)
    conn.transaction(() => {
      migration(conn)
      conn.pragma(`user_version = ${version}`)
    })()
    console.log(`[magpie] Base migrée en v${version}.`)
  }
}

export function closeDb(): void {
  db?.close()
  db = null
}
