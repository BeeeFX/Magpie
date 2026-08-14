import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema'

let db: Database.Database | null = null

function defaultDataDir(): string {
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

  db = new Database(join(dataDir(), 'magpie.db'))

  // WAL : lectures concurrentes pendant que le sync écrit. `normal` est le bon compromis
  // durabilité/vitesse pour une base locale qu'on peut de toute façon reconstruire.
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')

  const current = db.pragma('user_version', { simple: true }) as number
  if (current > 0 && current < SCHEMA_VERSION) {
    const backup = join(dataDir(), `magpie-before-v${SCHEMA_VERSION}-${Date.now()}.db`)
    db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`)
  }

  migrate(db)
  return db
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
  }
}

function migrate(conn: Database.Database): void {
  const current = conn.pragma('user_version', { simple: true }) as number

  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Base créée par une version plus récente de Magpie (schéma v${current}, cette version lit v${SCHEMA_VERSION}).`
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
