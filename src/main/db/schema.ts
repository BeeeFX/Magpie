/**
 * Schéma SQLite. Voir SPEC.md §4.
 *
 * Le schéma complet est posé dès M0 même si tout n'est pas encore utilisé : ajouter une
 * colonne à une base vide ne coûte rien, la rétro-adapter une fois qu'elle contient
 * plusieurs milliers de posts coûte beaucoup plus.
 */
export const SCHEMA_VERSION = 10

export const MIGRATION_9_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS post_sources (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('saved', 'liked')),
  source_rank INTEGER,
  source_at INTEGER,
  discovered_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, source)
);
CREATE INDEX IF NOT EXISTS idx_post_sources_feed
  ON post_sources(source, source_at DESC, source_rank ASC, post_id);
CREATE TABLE IF NOT EXISTS account_sync_sources (
  platform TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('saved', 'liked')),
  last_sync_at INTEGER,
  last_sync_status TEXT,
  cursor TEXT,
  PRIMARY KEY (platform, source)
);
INSERT OR IGNORE INTO post_sources (post_id, source, source_rank, source_at, discovered_at)
  SELECT id, 'saved', saved_rank, saved_at, discovered_at FROM posts;
INSERT OR IGNORE INTO account_sync_sources (platform, source, last_sync_at, last_sync_status, cursor)
  SELECT platform, 'saved', last_sync_at, last_sync_status, cursor FROM accounts;
`

export const MIGRATION_10_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS organizer_rules (
  rule_key      TEXT PRIMARY KEY,
  collection_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,
  ignored       INTEGER NOT NULL DEFAULT 0 CHECK(ignored IN (0, 1)),
  updated_at    INTEGER NOT NULL,
  CHECK((ignored = 1 AND collection_id IS NULL) OR (ignored = 0 AND collection_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_organizer_rules_collection
  ON organizer_rules(collection_id) WHERE collection_id IS NOT NULL;
`

export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS posts (
  id              TEXT PRIMARY KEY,
  platform        TEXT NOT NULL,
  native_id       TEXT NOT NULL,
  url             TEXT NOT NULL,
  author_handle   TEXT,
  author_name     TEXT,
  author_avatar   TEXT,
  text            TEXT,
  ai_description  TEXT,
  kind            TEXT NOT NULL,
  media_count     INTEGER NOT NULL DEFAULT 0,
  width           INTEGER,
  height          INTEGER,
  dominant_color  TEXT,
  published_at    INTEGER,
  saved_at        INTEGER,
  discovered_at   INTEGER NOT NULL,
  saved_rank      INTEGER,
  is_favorite     INTEGER NOT NULL DEFAULT 0,
  is_archived     INTEGER NOT NULL DEFAULT 0,
  -- Données de démonstration issues de la fixture, à distinguer des vrais signets pour
  -- pouvoir les retirer d'un geste au premier compte connecté.
  is_demo         INTEGER NOT NULL DEFAULT 0,
  -- Étiquette de couleur façon Finder : un repère qu'on voit sans lire.
  label           TEXT,
  tag_status      TEXT NOT NULL DEFAULT 'pending',
  raw             TEXT,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_platform  ON posts(platform);
CREATE INDEX IF NOT EXISTS idx_posts_saved     ON posts(saved_at DESC, saved_rank ASC);
CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_favorite  ON posts(is_favorite) WHERE is_favorite = 1;
CREATE INDEX IF NOT EXISTS idx_posts_label     ON posts(label) WHERE label IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_feed      ON posts(
  is_archived, COALESCE(saved_at, discovered_at) DESC, saved_rank ASC, id
);

CREATE TABLE IF NOT EXISTS post_sources (
  post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  source        TEXT NOT NULL CHECK(source IN ('saved', 'liked')),
  source_rank   INTEGER,
  source_at     INTEGER,
  discovered_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, source)
);
CREATE INDEX IF NOT EXISTS idx_post_sources_feed ON post_sources(source, source_at DESC, source_rank ASC, post_id);

CREATE TABLE IF NOT EXISTS media (
  id          INTEGER PRIMARY KEY,
  post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  remote_url  TEXT,
  source_path TEXT,
  thumb_path  TEXT,
  thumb_attempts INTEGER NOT NULL DEFAULT 0,
  -- Source du clip : chemin local ou URL distante, résolue comme celle de l'image.
  video_source TEXT,
  -- Clip en cache, servi au survol. Distinct de full_path, qui est l'archivage en
  -- pleine résolution demandé explicitement par l'utilisateur.
  video_path  TEXT,
  video_cache_state TEXT NOT NULL DEFAULT 'pending',
  video_attempts INTEGER NOT NULL DEFAULT 0,
  full_path   TEXT,
  width       INTEGER,
  height      INTEGER,
  UNIQUE (post_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_media_post ON media(post_id);
CREATE INDEX IF NOT EXISTS idx_media_thumb_queue ON media(thumb_path, thumb_attempts, post_id, idx);
CREATE INDEX IF NOT EXISTS idx_media_video_queue ON media(
  video_cache_state, video_attempts, video_path, post_id, idx
);

CREATE TABLE IF NOT EXISTS media_variants (
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  quality    TEXT NOT NULL,
  source     TEXT NOT NULL,
  width      INTEGER,
  height     INTEGER,
  bitrate    INTEGER,
  cache_path TEXT,
  PRIMARY KEY (post_id, idx, quality)
);

CREATE TABLE IF NOT EXISTS tags (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color  TEXT,
  source TEXT NOT NULL DEFAULT 'user'
);

CREATE TABLE IF NOT EXISTS post_tags (
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source     TEXT NOT NULL DEFAULT 'user',
  confidence REAL,
  PRIMARY KEY (post_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags(tag_id);

CREATE TABLE IF NOT EXISTS collections (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  cover_post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
  source        TEXT NOT NULL DEFAULT 'local',
  color         TEXT,
  sort_index    INTEGER NOT NULL DEFAULT 0
);

-- La clé primaire composite rend le doublon structurellement impossible : c'est ce qui
-- fonde le comportement du dialogue d'ajout décrit dans SPEC.md §9.
CREATE TABLE IF NOT EXISTS collection_posts (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  added_at      INTEGER NOT NULL,
  PRIMARY KEY (collection_id, post_id)
);

CREATE TABLE IF NOT EXISTS accounts (
  platform         TEXT PRIMARY KEY,
  handle           TEXT,
  connected_at     INTEGER,
  last_sync_at     INTEGER,
  last_sync_status TEXT,
  cursor           TEXT
);

CREATE TABLE IF NOT EXISTS account_sync_sources (
  platform         TEXT NOT NULL,
  source           TEXT NOT NULL CHECK(source IN ('saved', 'liked')),
  last_sync_at     INTEGER,
  last_sync_status TEXT,
  cursor           TEXT,
  PRIMARY KEY (platform, source)
);

-- Petite signature visuelle calculée localement à partir de la vignette. Elle permet à
-- l'organisateur de ne retraiter que les nouveaux médias lors des analyses suivantes.
CREATE TABLE IF NOT EXISTS local_video_features (
  post_id     TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  thumb_path  TEXT,
  visual      BLOB,
  updated_at  INTEGER NOT NULL
);

-- Préférences apprises lors du premier tri local. Plusieurs clés peuvent pointer vers
-- la même collection : c'est ainsi qu'une fusion « 3D + Blender » reste valable pour les
-- prochains posts, même si la collection est ensuite renommée.
CREATE TABLE IF NOT EXISTS organizer_rules (
  rule_key       TEXT PRIMARY KEY,
  collection_id  INTEGER REFERENCES collections(id) ON DELETE CASCADE,
  ignored        INTEGER NOT NULL DEFAULT 0 CHECK(ignored IN (0, 1)),
  updated_at     INTEGER NOT NULL,
  CHECK((ignored = 1 AND collection_id IS NULL) OR (ignored = 0 AND collection_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_organizer_rules_collection
  ON organizer_rules(collection_id) WHERE collection_id IS NOT NULL;

-- Table externe : le contenu vit dans la table posts, l'index FTS ne stocke que ce qu'il
-- faut pour chercher. Les triggers ci-dessous la maintiennent synchronisée.
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  text,
  ai_description,
  author_handle,
  content='posts',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS posts_fts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, text, ai_description, author_handle)
  VALUES (new.rowid, new.text, new.ai_description, new.author_handle);
END;

CREATE TRIGGER IF NOT EXISTS posts_fts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, text, ai_description, author_handle)
  VALUES ('delete', old.rowid, old.text, old.ai_description, old.author_handle);
END;

CREATE TRIGGER IF NOT EXISTS posts_fts_au AFTER UPDATE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, text, ai_description, author_handle)
  VALUES ('delete', old.rowid, old.text, old.ai_description, old.author_handle);
  INSERT INTO posts_fts(rowid, text, ai_description, author_handle)
  VALUES (new.rowid, new.text, new.ai_description, new.author_handle);
END;
`
