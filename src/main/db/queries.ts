import type {
  LabelColor,
  LibraryStats,
  Platform,
  Post,
  PostKind,
  PostPage,
  PostQuery,
  TagSource,
  VideoQuality
} from '@shared/types'
import { PLATFORMS } from '@shared/types'
import { getDb } from './index'

interface PostRow {
  id: string
  platform: string
  native_id: string
  url: string
  author_handle: string | null
  author_name: string | null
  text: string | null
  ai_description: string | null
  kind: string
  media_count: number
  width: number | null
  height: number | null
  dominant_color: string | null
  published_at: number | null
  saved_at: number | null
  discovered_at: number
  saved_rank: number | null
  is_favorite: number
  is_archived: number
  label: string | null
}

/* ------------------------------------------------------------------ lecture */

const SELECT_POST = /* sql */ `
  SELECT p.id, p.platform, p.native_id, p.url, p.author_handle, p.author_name,
         p.text, p.ai_description, p.kind, p.media_count, p.width, p.height,
         p.dominant_color, p.published_at, p.saved_at, p.discovered_at,
         p.saved_rank, p.is_favorite, p.is_archived, p.label
  FROM posts p
`

export function listPostPage(query: PostQuery, rawOffset = 0, rawLimit = 300): PostPage {
  const db = getDb()
  const offset = Math.max(0, Math.floor(rawOffset))
  const limit = Math.min(500, Math.max(1, Math.floor(rawLimit)))
  const where: string[] = ['p.is_archived = 0']
  const params: unknown[] = []

  if (query.platforms.length > 0) {
    where.push(`p.platform IN (${query.platforms.map(() => '?').join(', ')})`)
    params.push(...query.platforms)
  }

  if (query.kinds.length > 0) {
    const kindClauses: string[] = []
    const directKinds = query.kinds.filter((kind) => kind !== 'video')
    if (directKinds.length > 0) {
      kindClauses.push(`p.kind IN (${directKinds.map(() => '?').join(', ')})`)
      params.push(...directKinds)
    }
    // Un carrousel peut contenir un clip. Le filtre « Vidéos » doit montrer le contenu
    // réellement regardable, pas seulement les posts dont le type principal est vidéo.
    if (query.kinds.includes('video')) {
      kindClauses.push("EXISTS (SELECT 1 FROM media vm WHERE vm.post_id = p.id AND vm.kind = 'video')")
    }
    where.push(`(${kindClauses.join(' OR ')})`)
  }

  if (query.favoritesOnly) where.push('p.is_favorite = 1')

  if (query.untaggedOnly) {
    where.push('NOT EXISTS (SELECT 1 FROM post_tags pt WHERE pt.post_id = p.id)')
  }

  if (query.label) {
    where.push('p.label = ?')
    params.push(query.label)
  }

  if (query.collectionId !== null) {
    where.push(
      'EXISTS (SELECT 1 FROM collection_posts cp WHERE cp.post_id = p.id AND cp.collection_id = ?)'
    )
    params.push(query.collectionId)
  }

  if (query.tag) {
    where.push(`EXISTS (
      SELECT 1 FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
      WHERE pt.post_id = p.id AND t.name = ? COLLATE NOCASE
    )`)
    params.push(query.tag)
  }

  const match = toFtsQuery(query.search)
  if (match) {
    where.push('p.rowid IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)')
    params.push(match)
  }

  const condition = where.join(' AND ')
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM posts p WHERE ${condition}`).get(...params) as { n: number }
  ).n
  const sql = `${SELECT_POST} WHERE ${condition} ORDER BY ${orderBy(query.sort, query.randomSeed)} LIMIT ? OFFSET ?`
  const rows = db.prepare(sql).all(...params, limit, offset) as PostRow[]

  const posts = rows.map(toPost)
  attachMedia(posts)
  attachTags(posts)

  return {
    posts,
    total,
    offset,
    hasMore: offset + posts.length < total
  }
}

/** Lecture exhaustive réservée aux outils hors interface, notamment l'instantané visuel. */
export function listPosts(query: PostQuery): Post[] {
  const posts: Post[] = []
  let hasMore = true
  while (hasMore) {
    const page = listPostPage(query, posts.length, 500)
    posts.push(...page.posts)
    hasMore = page.hasMore
  }
  return posts
}

/** Actualisation ciblée utilisée quand des vignettes viennent d'être préparées. */
export function getPostsByIds(rawIds: string[]): Post[] {
  const ids = [...new Set(rawIds)].slice(0, 100)
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = getDb()
    .prepare(`${SELECT_POST} WHERE p.is_archived = 0 AND p.id IN (${placeholders})`)
    .all(...ids) as PostRow[]
  const posts = rows.map(toPost)
  attachMedia(posts)
  attachTags(posts)
  return posts
}

function orderBy(sort: PostQuery['sort'], randomSeed: number): string {
  switch (sort) {
    case 'published':
      return 'COALESCE(p.published_at, 0) DESC, p.id'
    case 'author':
      return 'p.author_handle COLLATE NOCASE ASC, COALESCE(p.published_at, 0) DESC, p.id'
    case 'platform':
      return 'p.platform ASC, COALESCE(p.saved_at, p.discovered_at) DESC, p.id'
    case 'random':
      // Ordre pseudo-aléatoire déterministe et paginable : la première tranche apparaît
      // immédiatement sans charger toute la bibliothèque avant de la mélanger.
      return `((p.rowid * 1103515245 + ${Math.max(1, Math.floor(randomSeed))}) & 2147483647), p.id`
    case 'saved':
    default:
      return 'COALESCE(p.saved_at, p.discovered_at) DESC, p.saved_rank ASC, p.id'
  }
}

/**
 * Rattache tous les médias en une requête. Un carrousel en compte plusieurs : les
 * remonter tous permet à la carte de les parcourir au survol, et de connaître le clip
 * vidéo à lire sans second aller-retour.
 */
function attachMedia(posts: Post[]): void {
  if (posts.length === 0) return
  const byId = new Map(posts.map((p) => [p.id, p]))
  const rows: {
    post_id: string
    idx: number
    kind: string
    thumb_path: string | null
    video_path: string | null
    width: number | null
    height: number | null
    video_qualities: string | null
  }[] = []

  for (let offset = 0; offset < posts.length; offset += 500) {
    const ids = posts.slice(offset, offset + 500).map((post) => post.id)
    const placeholders = ids.map(() => '?').join(',')
    rows.push(
      ...(getDb()
        .prepare(
          `SELECT m.post_id, m.idx, m.kind, m.thumb_path, m.video_path, m.width, m.height,
                  GROUP_CONCAT(v.quality) AS video_qualities
             FROM media m
             LEFT JOIN media_variants v ON v.post_id = m.post_id AND v.idx = m.idx
            WHERE m.post_id IN (${placeholders})
            GROUP BY m.post_id, m.idx
            ORDER BY m.post_id, m.idx`
        )
        .all(...ids) as typeof rows)
    )
  }

  for (const row of rows) {
    const post = byId.get(row.post_id)
    if (!post) continue
    post.media.push({
      idx: row.idx,
      kind: row.kind === 'video' ? 'video' : 'image',
      thumbUrl: row.thumb_path ? `magpie://thumb/${row.thumb_path}` : null,
      videoUrl: row.video_path ? `magpie://video/${row.video_path}` : null,
      width: row.width,
      height: row.height
      ,videoQualities: row.video_qualities
        ? ([...new Set(row.video_qualities.split(','))] as VideoQuality[])
        : []
    })
  }

  for (const post of posts) post.thumbUrl = post.media[0]?.thumbUrl ?? null
}

function attachTags(posts: Post[]): void {
  if (posts.length === 0) return
  const db = getDb()
  const byId = new Map(posts.map((p) => [p.id, p]))

  // Une seule requête pour tous les posts : le N+1 se voit tout de suite à 5 000 lignes.
  const rows: { post_id: string; name: string; source: string }[] = []
  for (let offset = 0; offset < posts.length; offset += 500) {
    const ids = posts.slice(offset, offset + 500).map((post) => post.id)
    const placeholders = ids.map(() => '?').join(',')
    rows.push(
      ...(db
        .prepare(
          `SELECT pt.post_id, t.name, pt.source
             FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
            WHERE pt.post_id IN (${placeholders})
            ORDER BY t.name COLLATE NOCASE`
        )
        .all(...ids) as typeof rows)
    )
  }

  for (const row of rows) {
    byId.get(row.post_id)?.tags.push({ name: row.name, source: row.source as TagSource })
  }
}

function toPost(row: PostRow): Post {
  return {
    id: row.id,
    platform: row.platform as Platform,
    nativeId: row.native_id,
    url: row.url,
    authorHandle: row.author_handle,
    authorName: row.author_name,
    text: row.text,
    aiDescription: row.ai_description,
    kind: row.kind as PostKind,
    mediaCount: row.media_count,
    width: row.width,
    height: row.height,
    dominantColor: row.dominant_color,
    thumbUrl: null, // renseigné par attachMedia
    media: [],
    publishedAt: row.published_at,
    savedAt: row.saved_at,
    discoveredAt: row.discovered_at,
    savedRank: row.saved_rank,
    isFavorite: row.is_favorite === 1,
    isArchived: row.is_archived === 1,
    label: (row.label as LabelColor | null) ?? null,
    tags: []
  }
}

export function getStats(): LibraryStats {
  const db = getDb()

  const byPlatform = Object.fromEntries(PLATFORMS.map((p) => [p, 0])) as Record<Platform, number>
  const platformRows = db
    .prepare(`SELECT platform, COUNT(*) AS n FROM posts WHERE is_archived = 0 GROUP BY platform`)
    .all() as { platform: Platform; n: number }[]
  for (const row of platformRows) byPlatform[row.platform] = row.n

  const total = platformRows.reduce((sum, row) => sum + row.n, 0)

  const favorites = db
    .prepare(`SELECT COUNT(*) AS n FROM posts WHERE is_archived = 0 AND is_favorite = 1`)
    .get() as { n: number }

  const topTags = db
    .prepare(
      `SELECT t.name,
              CASE
                WHEN SUM(CASE WHEN pt.source = 'user' THEN 1 ELSE 0 END) > 0 THEN 'user'
                WHEN SUM(CASE WHEN pt.source = 'ai' THEN 1 ELSE 0 END) > 0 THEN 'ai'
                ELSE 'rule'
              END AS source,
              COUNT(*) AS count
         FROM post_tags pt
         JOIN tags t ON t.id = pt.tag_id
         JOIN posts p ON p.id = pt.post_id AND p.is_archived = 0
        GROUP BY t.id
        ORDER BY count DESC, t.name COLLATE NOCASE
        LIMIT 40`
    )
    .all() as { name: string; count: number; source: TagSource }[]

  const byLabel: Partial<Record<LabelColor, number>> = {}
  const labelRows = db
    .prepare(
      `SELECT label, COUNT(*) AS n FROM posts
        WHERE is_archived = 0 AND label IS NOT NULL GROUP BY label`
    )
    .all() as { label: LabelColor; n: number }[]
  for (const row of labelRows) byLabel[row.label] = row.n

  return { total, favorites: favorites.n, byPlatform, byLabel, topTags }
}

export function toggleFavorite(id: string): boolean {
  const db = getDb()
  db.prepare(
    `UPDATE posts SET is_favorite = 1 - is_favorite, updated_at = ? WHERE id = ?`
  ).run(Date.now(), id)
  const row = db.prepare(`SELECT is_favorite FROM posts WHERE id = ?`).get(id) as
    | { is_favorite: number }
    | undefined
  return row?.is_favorite === 1
}

export function setFavoriteMany(ids: string[], value: boolean): void {
  if (ids.length === 0) return
  const db = getDb()
  const stmt = db.prepare('UPDATE posts SET is_favorite = ?, updated_at = ? WHERE id = ?')
  db.transaction(() => {
    const now = Date.now()
    for (const id of ids) stmt.run(value ? 1 : 0, now, id)
  })()
}

export function addTagMany(ids: string[], name: string): void {
  const clean = name.trim().slice(0, 80)
  if (!clean || ids.length === 0) return
  const db = getDb()
  db.transaction(() => {
    db.prepare(`INSERT INTO tags (name, source) VALUES (?, 'user') ON CONFLICT(name) DO NOTHING`).run(
      clean
    )
    const tag = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(clean) as {
      id: number
    }
    const stmt = db.prepare(
      `INSERT INTO post_tags (post_id, tag_id, source) VALUES (?, ?, 'user')
       ON CONFLICT(post_id, tag_id) DO UPDATE SET source = 'user'`
    )
    for (const id of ids) stmt.run(id, tag.id)
  })()
}

export interface AiCandidate {
  id: string
  platform: Platform
  text: string | null
  authorHandle: string | null
  thumbPath: string | null
}

export interface VideoOrganizationItem {
  id: string
  text: string | null
  description: string | null
  tags: string[]
}

export function videoAiCandidateIds(): string[] {
  return (
    getDb()
      .prepare(
        `SELECT DISTINCT p.id
           FROM posts p JOIN media m ON m.post_id = p.id
          WHERE p.is_archived = 0 AND m.kind = 'video' AND p.tag_status <> 'ai'
          ORDER BY p.discovered_at DESC`
      )
      .all() as { id: string }[]
  ).map((row) => row.id)
}

export function videoOrganizationItems(): VideoOrganizationItem[] {
  const rows = getDb()
    .prepare(
      `SELECT p.id, p.text, p.ai_description,
              GROUP_CONCAT(DISTINCT t.name) AS tags
         FROM posts p
         JOIN media m ON m.post_id = p.id AND m.kind = 'video'
         LEFT JOIN post_tags pt ON pt.post_id = p.id
         LEFT JOIN tags t ON t.id = pt.tag_id
        WHERE p.is_archived = 0
        GROUP BY p.id
        ORDER BY p.discovered_at DESC`
    )
    .all() as {
    id: string
    text: string | null
    ai_description: string | null
    tags: string | null
  }[]
  return rows.map((row) => ({
    id: row.id,
    text: row.text,
    description: row.ai_description,
    tags: row.tags?.split(',').filter(Boolean) ?? []
  }))
}

export function aiCandidates(postIds?: string[], limit = 500): AiCandidate[] {
  const db = getDb()
  const params: unknown[] = []
  let where = `p.is_archived = 0 AND p.tag_status <> 'ai'`
  if (postIds && postIds.length > 0) {
    where += ` AND p.id IN (${postIds.map(() => '?').join(',')})`
    params.push(...postIds)
  }
  params.push(Math.min(1000, Math.max(1, limit)))
  return db
    .prepare(
      `SELECT p.id, p.platform, p.text, p.author_handle,
              (SELECT thumb_path FROM media m WHERE m.post_id = p.id AND m.idx = 0) thumb_path
         FROM posts p WHERE ${where}
        ORDER BY p.discovered_at DESC LIMIT ?`
    )
    .all(...params)
    .map((row: any) => ({
      id: row.id,
      platform: row.platform as Platform,
      text: row.text as string | null,
      authorHandle: row.author_handle as string | null,
      thumbPath: row.thumb_path as string | null
    }))
}

export function recentAiCandidateIds(platform: Platform, since: number): string[] {
  return (
    getDb()
      .prepare(
        `SELECT id FROM posts
          WHERE platform = ? AND discovered_at >= ? AND tag_status <> 'ai'
          ORDER BY discovered_at DESC`
      )
      .all(platform, since) as { id: string }[]
  ).map((row) => row.id)
}

export function applyAiResult(postId: string, description: string, tags: string[]): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare(
      `UPDATE posts SET ai_description = ?, tag_status = 'ai', updated_at = ? WHERE id = ?`
    ).run(description.slice(0, 1000), Date.now(), postId)
    for (const raw of tags.slice(0, 8)) {
      const name = raw.trim().replace(/^#/, '').slice(0, 60)
      if (!name) continue
      db.prepare(`INSERT INTO tags (name, source) VALUES (?, 'ai') ON CONFLICT(name) DO NOTHING`).run(
        name
      )
      const tag = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(name) as {
        id: number
      }
      db.prepare(
        `INSERT INTO post_tags (post_id, tag_id, source, confidence)
         VALUES (?, ?, 'ai', 0.8)
         ON CONFLICT(post_id, tag_id) DO NOTHING`
      ).run(postId, tag.id)
    }
  })()
}

/**
 * Posts jamais passés par les règles de tagging.
 *
 * `tag_status` sert exactement à ça : distinguer « pas encore traité » de « traité, sans
 * résultat ». Sans lui, un rattrapage au démarrage ressusciterait les tags que
 * l'utilisateur a retirés à la main.
 */
export function pendingRuleTagging(): PostInput[] {
  const rows = getDb()
    .prepare(
      `SELECT id, platform, native_id, url, author_handle, author_name, text, kind
         FROM posts WHERE tag_status = 'pending'`
    )
    .all() as {
    id: string
    platform: Platform
    native_id: string
    url: string
    author_handle: string | null
    author_name: string | null
    text: string | null
    kind: PostKind
  }[]

  return rows.map((row) => ({
    id: row.id,
    platform: row.platform,
    nativeId: row.native_id,
    url: row.url,
    authorHandle: row.author_handle,
    authorName: row.author_name,
    text: row.text,
    kind: row.kind
  }))
}

export function markTagged(postIds: string[]): void {
  const db = getDb()
  const stmt = db.prepare(`UPDATE posts SET tag_status = 'rules_only' WHERE id = ?`)
  db.transaction(() => {
    for (const id of postIds) stmt.run(id)
  })()
}

export function setLabel(postId: string, label: LabelColor | null): void {
  getDb()
    .prepare('UPDATE posts SET label = ?, updated_at = ? WHERE id = ?')
    .run(label, Date.now(), postId)
}

export function countPosts(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM posts`).get() as { n: number }
  return row.n
}

/* ------------------------------------------------------------------ écriture */

export interface PostInput {
  id: string
  platform: Platform
  nativeId: string
  url: string
  authorHandle?: string | null
  authorName?: string | null
  text?: string | null
  kind: PostKind
  mediaCount?: number
  publishedAt?: number | null
  savedAt?: number | null
  savedRank?: number | null
  raw?: unknown
  /** Vrai uniquement pour les posts de la fixture de démonstration. */
  isDemo?: boolean
}

export interface MediaInput {
  postId: string
  idx: number
  kind: 'image' | 'video'
  remoteUrl?: string | null
  sourcePath?: string | null
  /** Chemin local ou URL du clip, pour les médias vidéo. */
  videoSource?: string | null
  videoVariants?: {
    quality: VideoQuality
    source: string
    width?: number | null
    height?: number | null
    bitrate?: number | null
  }[]
}

const upsertPostStmt = () =>
  getDb().prepare(/* sql */ `
    INSERT INTO posts (id, platform, native_id, url, author_handle, author_name, text,
                       kind, media_count, published_at, saved_at, discovered_at,
                       saved_rank, raw, is_demo, updated_at)
    VALUES (@id, @platform, @native_id, @url, @author_handle, @author_name, @text,
            @kind, @media_count, @published_at, @saved_at, @discovered_at,
            @saved_rank, @raw, @is_demo, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      url          = excluded.url,
      author_handle= excluded.author_handle,
      author_name  = excluded.author_name,
      text         = excluded.text,
      kind         = excluded.kind,
      media_count  = excluded.media_count,
      published_at = excluded.published_at,
      saved_at     = COALESCE(posts.saved_at, excluded.saved_at),
      saved_rank   = COALESCE(posts.saved_rank, excluded.saved_rank),
      raw          = excluded.raw,
      updated_at   = excluded.updated_at
  `)

export function upsertPosts(posts: PostInput[], media: MediaInput[]): void {
  const db = getDb()
  const post = upsertPostStmt()
  const mediaStmt = db.prepare(/* sql */ `
    INSERT INTO media (post_id, idx, kind, remote_url, source_path, video_source)
    VALUES (@post_id, @idx, @kind, @remote_url, @source_path, @video_source)
    ON CONFLICT(post_id, idx) DO UPDATE SET
      kind         = excluded.kind,
      thumb_path   = CASE
                       WHEN media.remote_url IS excluded.remote_url THEN media.thumb_path
                       ELSE NULL
                     END,
      video_path   = CASE
                       WHEN media.video_source IS excluded.video_source THEN media.video_path
                       ELSE NULL
                     END,
      video_cache_state = CASE
                            WHEN media.video_source IS excluded.video_source
                              THEN media.video_cache_state
                            ELSE 'pending'
                          END,
      video_attempts = CASE
                         WHEN media.video_source IS excluded.video_source
                           THEN media.video_attempts
                         ELSE 0
                       END,
      remote_url   = excluded.remote_url,
      source_path  = excluded.source_path,
      video_source = excluded.video_source
  `)
  const deleteVariants = db.prepare('DELETE FROM media_variants WHERE post_id = ? AND idx = ?')
  const variantStmt = db.prepare(/* sql */ `
    INSERT INTO media_variants (post_id, idx, quality, source, width, height, bitrate)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  const now = Date.now()
  const run = db.transaction(() => {
    for (const p of posts) {
      post.run({
        id: p.id,
        platform: p.platform,
        native_id: p.nativeId,
        url: p.url,
        author_handle: p.authorHandle ?? null,
        author_name: p.authorName ?? null,
        text: p.text ?? null,
        kind: p.kind,
        media_count: p.mediaCount ?? 0,
        published_at: p.publishedAt ?? null,
        saved_at: p.savedAt ?? null,
        discovered_at: now,
        saved_rank: p.savedRank ?? null,
        raw: p.raw === undefined ? null : JSON.stringify(p.raw),
        is_demo: p.isDemo ? 1 : 0,
        updated_at: now
      })

      // Une plateforme peut retirer un élément d'un carrousel ou remplacer une vidéo.
      // Les anciennes lignes ne doivent alors pas survivre au nouveau payload.
      db.prepare('DELETE FROM media WHERE post_id = ? AND idx >= ?').run(
        p.id,
        p.mediaCount ?? 0
      )
      db.prepare('DELETE FROM media_variants WHERE post_id = ? AND idx >= ?').run(
        p.id,
        p.mediaCount ?? 0
      )
    }
    for (const m of media) {
      mediaStmt.run({
        post_id: m.postId,
        idx: m.idx,
        kind: m.kind,
        remote_url: m.remoteUrl ?? null,
        source_path: m.sourcePath ?? null,
        video_source: m.videoSource ?? null
      })
      deleteVariants.run(m.postId, m.idx)
      for (const variant of m.videoVariants ?? []) {
        variantStmt.run(
          m.postId,
          m.idx,
          variant.quality,
          variant.source,
          variant.width ?? null,
          variant.height ?? null,
          variant.bitrate ?? null
        )
      }
    }
  })

  run()
}

/**
 * Identifiants déjà connus pour une plateforme. Le moteur de sync s'en sert pour savoir
 * quand il a rejoint l'historique déjà rapatrié, et s'arrêter là plutôt que de tout
 * reparcourir à chaque fois.
 */
export function knownPostIds(platform: Platform): Set<string> {
  const rows = getDb()
    .prepare('SELECT id FROM posts WHERE platform = ?')
    .all(platform) as { id: string }[]
  return new Set(rows.map((row) => row.id))
}

export function videoVariant(
  postId: string,
  idx: number,
  quality: VideoQuality
): { platform: Platform; source: string; cachePath: string | null } | null {
  const row = getDb()
    .prepare(
      `SELECT p.platform, v.source, v.cache_path
         FROM media_variants v JOIN posts p ON p.id = v.post_id
        WHERE v.post_id = ? AND v.idx = ? AND v.quality = ?`
    )
    .get(postId, idx, quality) as
    | { platform: Platform; source: string; cache_path: string | null }
    | undefined
  return row ? { platform: row.platform, source: row.source, cachePath: row.cache_path } : null
}

export function setVideoVariantCache(
  postId: string,
  idx: number,
  quality: VideoQuality,
  cachePath: string
): void {
  getDb()
    .prepare(
      'UPDATE media_variants SET cache_path = ? WHERE post_id = ? AND idx = ? AND quality = ?'
    )
    .run(cachePath, postId, idx, quality)
}

export interface AccountRow {
  platform: Platform
  handle: string | null
  connectedAt: number | null
  lastSyncAt: number | null
  lastSyncStatus: string | null
  /** Curseur de reprise opaque, sérialisé par le moteur de synchronisation. */
  cursor: string | null
}

export function readAccount(platform: Platform): AccountRow | null {
  const row = getDb().prepare('SELECT * FROM accounts WHERE platform = ?').get(platform) as
    | {
        platform: Platform
        handle: string | null
        connected_at: number | null
        last_sync_at: number | null
        last_sync_status: string | null
        cursor: string | null
      }
    | undefined

  if (!row) return null
  return {
    platform: row.platform,
    handle: row.handle,
    connectedAt: row.connected_at,
    lastSyncAt: row.last_sync_at,
    lastSyncStatus: row.last_sync_status,
    cursor: row.cursor
  }
}

export function writeAccount(
  platform: Platform,
  patch: {
    handle?: string
    connectedAt?: number
    lastSyncAt?: number
    lastSyncStatus?: string
    cursor?: string | null
  }
): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO accounts (platform, handle, connected_at, last_sync_at, last_sync_status, cursor)
     VALUES (@platform, @handle, @connected_at, @last_sync_at, @last_sync_status, @cursor)
     ON CONFLICT(platform) DO UPDATE SET
       handle           = COALESCE(excluded.handle, accounts.handle),
       connected_at     = COALESCE(excluded.connected_at, accounts.connected_at),
       last_sync_at     = COALESCE(excluded.last_sync_at, accounts.last_sync_at),
       last_sync_status = COALESCE(excluded.last_sync_status, accounts.last_sync_status),
       cursor           = CASE WHEN @has_cursor = 1 THEN @cursor ELSE accounts.cursor END`
  ).run({
    platform,
    handle: patch.handle ?? null,
    connected_at: patch.connectedAt ?? null,
    last_sync_at: patch.lastSyncAt ?? null,
    last_sync_status: patch.lastSyncStatus ?? null,
    cursor: patch.cursor ?? null,
    has_cursor: Object.prototype.hasOwnProperty.call(patch, 'cursor') ? 1 : 0
  })
}

/**
 * Répare les comptes qui ont des posts mais aucune date de synchronisation — cas d'un
 * rattrapage interrompu par une fermeture de l'application. La date est déduite de
 * l'arrivée réelle des posts, ce qui est exactement ce que « dernière synchronisation »
 * veut dire.
 */
export function repairMissingSyncDates(): number {
  const rows = getDb()
    .prepare(
      `SELECT platform, MAX(discovered_at) AS last
         FROM posts WHERE is_demo = 0 GROUP BY platform`
    )
    .all() as { platform: Platform; last: number }[]

  let repaired = 0
  for (const row of rows) {
    const account = readAccount(row.platform)
    if (account && account.lastSyncAt === null) {
      writeAccount(row.platform, { lastSyncAt: row.last, lastSyncStatus: 'ok' })
      repaired++
    }
  }
  return repaired
}

export function forgetAccount(platform: Platform): void {
  getDb().prepare('DELETE FROM accounts WHERE platform = ?').run(platform)
}

export function countDemoPosts(): number {
  const row = getDb().prepare('SELECT COUNT(*) n FROM posts WHERE is_demo = 1').get() as {
    n: number
  }
  return row.n
}

/** Retire la fixture. Les vrais signets, leurs tags et leurs favoris ne sont pas touchés. */
export function deleteDemoPosts(): number {
  const removed = countDemoPosts()
  getDb().prepare('DELETE FROM posts WHERE is_demo = 1').run()
  return removed
}

export function setTags(postId: string, tags: { name: string; source: TagSource }[]): void {
  const db = getDb()
  const insertTag = db.prepare(
    `INSERT INTO tags (name, source) VALUES (?, ?) ON CONFLICT(name) DO NOTHING`
  )
  const findTag = db.prepare(`SELECT id FROM tags WHERE name = ? COLLATE NOCASE`)
  const link = db.prepare(
    `INSERT INTO post_tags (post_id, tag_id, source) VALUES (?, ?, ?)
     ON CONFLICT(post_id, tag_id) DO NOTHING`
  )

  db.transaction(() => {
    for (const tag of tags) {
      insertTag.run(tag.name, tag.source)
      const row = findTag.get(tag.name) as { id: number } | undefined
      if (row) link.run(postId, row.id, tag.source)
    }
  })()
}

export function addTag(postId: string, name: string, source: TagSource = 'user'): void {
  const clean = name.trim().replace(/^#/, '')
  if (!clean) return
  setTags(postId, [{ name: clean, source }])
}

export function removeTag(postId: string, name: string): void {
  getDb()
    .prepare(
      `DELETE FROM post_tags
        WHERE post_id = ?
          AND tag_id = (SELECT id FROM tags WHERE name = ? COLLATE NOCASE)`
    )
    .run(postId, name)
}

export interface CollectionRow {
  id: number
  name: string
  count: number
  color: LabelColor | null
}

export function listCollections(): CollectionRow[] {
  return getDb()
    .prepare(
      `SELECT c.id, c.name, c.color, COUNT(cp.post_id) AS count
         FROM collections c
         LEFT JOIN collection_posts cp ON cp.collection_id = c.id
        GROUP BY c.id
        ORDER BY c.sort_index, c.name COLLATE NOCASE`
    )
    .all() as CollectionRow[]
}

export function createCollection(name: string, color: LabelColor | null = null): CollectionRow {
  const clean = name.trim()
  if (!clean) throw new Error('Nom de collection vide')
  const info = getDb()
    .prepare('INSERT INTO collections (name, color, sort_index) VALUES (?, ?, 0)')
    .run(clean, color)
  return { id: Number(info.lastInsertRowid), name: clean, count: 0, color }
}

export function setCollectionColor(collectionId: number, color: LabelColor | null): void {
  getDb().prepare('UPDATE collections SET color = ? WHERE id = ?').run(color, collectionId)
}

export interface AddToCollectionResult {
  added: number
  /** Posts déjà présents. La clé primaire composite rend le doublon impossible : on ne
   *  peut donc pas « réajouter », seulement rendre compte de ce qui existait déjà. */
  alreadyThere: string[]
  collectionName: string
}

export function addToCollection(
  collectionId: number,
  postIds: string[],
  readd = false
): AddToCollectionResult {
  const db = getDb()
  const collection = db.prepare('SELECT name FROM collections WHERE id = ?').get(collectionId) as
    | { name: string }
    | undefined
  if (!collection) throw new Error('Collection introuvable')

  const existing = new Set(
    (
      db
        .prepare('SELECT post_id FROM collection_posts WHERE collection_id = ?')
        .all(collectionId) as { post_id: string }[]
    ).map((row) => row.post_id)
  )

  const fresh = postIds.filter((id) => !existing.has(id))
  const insert = db.prepare(
    'INSERT INTO collection_posts (collection_id, post_id, added_at) VALUES (?, ?, ?)'
  )
  const now = Date.now()
  db.transaction(() => {
    for (const id of fresh) insert.run(collectionId, id, now)
    if (readd) {
      const touch = db.prepare(
        'UPDATE collection_posts SET added_at = ? WHERE collection_id = ? AND post_id = ?'
      )
      for (const id of postIds.filter((postId) => existing.has(postId))) {
        touch.run(now, collectionId, id)
      }
    }
  })()

  return {
    added: fresh.length + (readd ? postIds.filter((id) => existing.has(id)).length : 0),
    alreadyThere: postIds.filter((id) => existing.has(id)),
    collectionName: collection.name
  }
}

export function removeFromCollection(collectionId: number, postId: string): void {
  getDb()
    .prepare('DELETE FROM collection_posts WHERE collection_id = ? AND post_id = ?')
    .run(collectionId, postId)
}

export function collectionsForPost(postId: string): number[] {
  const rows = getDb()
    .prepare('SELECT collection_id FROM collection_posts WHERE post_id = ?')
    .all(postId) as { collection_id: number }[]
  return rows.map((row) => row.collection_id)
}

/** Renseigne les dimensions et la vignette une fois le média traité par le cache. */
export function setThumbnail(
  postId: string,
  idx: number,
  info: { thumbPath: string; width: number; height: number; dominantColor: string }
): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare(
      `UPDATE media SET thumb_path = ?, width = ?, height = ? WHERE post_id = ? AND idx = ?`
    ).run(info.thumbPath, info.width, info.height, postId, idx)

    // Les dimensions du média principal remontent sur le post : c'est ce que lit le
    // masonry pour se disposer sans charger d'image.
    if (idx === 0) {
      db.prepare(
        `UPDATE posts SET width = ?, height = ?, dominant_color = ?, updated_at = ? WHERE id = ?`
      ).run(info.width, info.height, info.dominantColor, Date.now(), postId)
    }
  })()
}

export interface PendingMedia {
  post_id: string
  idx: number
  platform: Platform
  source_path: string | null
  remote_url: string | null
  video_source: string | null
  video_attempts: number
}

/**
 * Médias dont la vignette reste à produire.
 *
 * ⚠️ La source peut être **locale ou distante**. Ne retenir que `source_path` — ce que
 * faisait la première version, à l'époque où tout venait de la fixture — laissait tous les
 * vrais signets sans vignette, puisqu'ils n'ont qu'une URL.
 */
export function pendingThumbnails(): PendingMedia[] {
  return getDb()
    .prepare(
      `SELECT m.post_id, m.idx, p.platform, m.source_path, m.remote_url, m.video_source
         FROM media m JOIN posts p ON p.id = m.post_id
        WHERE m.thumb_path IS NULL
          AND (m.source_path IS NOT NULL OR m.remote_url LIKE 'http%')
        ORDER BY CASE WHEN m.idx = 0 THEN 0 ELSE 1 END,
                 CASE WHEN p.saved_rank IS NULL THEN 1 ELSE 0 END,
                 p.saved_rank ASC, p.discovered_at DESC, m.post_id, m.idx`
    )
    .all() as PendingMedia[]
}

export function setVideo(postId: string, idx: number, videoPath: string): void {
  getDb()
    .prepare(
      `UPDATE media SET video_path = ?, video_cache_state = 'cached', video_attempts = 0
       WHERE post_id = ? AND idx = ?`
    )
    .run(videoPath, postId, idx)
}

export function markVideoCacheResult(postId: string, idx: number, state: 'skipped' | 'pending'): void {
  getDb()
    .prepare(
      `UPDATE media SET video_cache_state = ?, video_attempts = video_attempts + 1
       WHERE post_id = ? AND idx = ?`
    )
    .run(state, postId, idx)
}

export function pendingVideos(): PendingMedia[] {
  return getDb()
    .prepare(
      `SELECT m.post_id, m.idx, p.platform, m.source_path, m.remote_url, m.video_source,
              m.video_attempts
         FROM media m JOIN posts p ON p.id = m.post_id
        WHERE m.video_path IS NULL AND m.video_source IS NOT NULL
          AND m.video_cache_state = 'pending' AND m.video_attempts < 3
        ORDER BY CASE WHEN m.idx = 0 THEN 0 ELSE 1 END,
                 CASE WHEN p.saved_rank IS NULL THEN 1 ELSE 0 END,
                 p.saved_rank ASC, p.discovered_at DESC, m.post_id, m.idx`
    )
    .all() as PendingMedia[]
}

/* ------------------------------------------------------------------ utilitaires */

/**
 * Transforme une saisie libre en requête FTS5 sûre. On retire les caractères qui ont un
 * sens dans la syntaxe FTS pour qu'une apostrophe ou un guillemet ne fasse pas planter la
 * recherche, et on ajoute `*` au dernier terme pour chercher au fil de la frappe.
 */
function toFtsQuery(raw: string): string | null {
  const terms = raw
    .replace(/["'()*:^-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)

  if (terms.length === 0) return null
  return terms.map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`)).join(' AND ')
}
