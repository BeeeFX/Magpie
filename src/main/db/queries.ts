import type {
  ContentSource,
  LabelColor,
  LibraryStats,
  PlaybackQuality,
  Platform,
  Post,
  PostKind,
  PostPage,
  PostQuery,
  TagSource,
  VideoQuality
} from '@shared/types'
import { CONTENT_SOURCES, PLATFORMS, PUBLIC_PLATFORMS } from '@shared/types'
import { MEDIA_UPSERT_SQL } from './media-upsert'
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

/**
 * Traduit une requête d'interface en condition SQL, une seule fois pour tous ceux qui en
 * ont besoin. Le préchargement se limite ainsi exactement à ce que l'utilisateur voit —
 * un tag, une collection, une recherche — sans réécrire ni faire diverger ces filtres.
 */
export function postFilter(query: PostQuery): { condition: string; params: unknown[] } {
  const where: string[] = [
    `p.is_archived = 0`,
    `p.platform IN (${PUBLIC_PLATFORMS.map(() => '?').join(', ')})`
  ]
  const params: unknown[] = []
  params.push(...PUBLIC_PLATFORMS)

  if (query.platforms.length > 0) {
    where.push(`p.platform IN (${query.platforms.map(() => '?').join(', ')})`)
    params.push(...query.platforms)
  }

  if (query.sources.length > 0) {
    where.push(`EXISTS (
      SELECT 1 FROM post_sources ps
      WHERE ps.post_id = p.id AND ps.source IN (${query.sources.map(() => '?').join(', ')})
    )`)
    params.push(...query.sources)
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

  if (query.collectionIds.length > 0) {
    where.push(`EXISTS (
      SELECT 1 FROM collection_posts cp
      WHERE cp.post_id = p.id
        AND cp.collection_id IN (${query.collectionIds.map(() => '?').join(', ')})
    )`)
    params.push(...query.collectionIds)
  }

  if (query.tags.length > 0) {
    where.push(`EXISTS (
      SELECT 1 FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
      WHERE pt.post_id = p.id
        AND t.name COLLATE NOCASE IN (${query.tags.map(() => '?').join(', ')})
    )`)
    params.push(...query.tags)
  }

  const match = toFtsQuery(query.search)
  if (match) {
    where.push('p.rowid IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)')
    params.push(match)
  }

  return { condition: where.join(' AND '), params }
}

/**
 * Les seuls identifiants de ce que le filtre retient.
 *
 * La carte a besoin de la bibliothèque entière — neuf mille points — là où la grille se
 * contente d'une tranche de trois cents. Les demander comme des posts complets ferait
 * remonter les vignettes, les tags et les origines de chacun pour n'en garder que la clé, et
 * traverser le pont IPC avec tout ça. Une colonne, sans jointure et sans tri : on ne construit
 * qu'un ensemble d'appartenance, et l'ordre ne s'y voit pas.
 *
 * C'est ce qui manquait à l'écran carte. Il filtrait la projection sur la page chargée par la
 * grille, or la grille n'est même pas montée dans ce mode : rien n'appelait jamais la tranche
 * suivante, et la carte restait à trois cents points sur neuf mille sans que rien ne le dise.
 */
export function listPostIds(query: PostQuery): string[] {
  const { condition, params } = postFilter(query)
  return (
    getDb()
      .prepare(`SELECT p.id FROM posts p WHERE ${condition}`)
      .all(...params) as { id: string }[]
  ).map((row) => row.id)
}

export function listPostPage(query: PostQuery, rawOffset = 0, rawLimit = 300): PostPage {
  const db = getDb()
  const offset = Math.max(0, Math.floor(rawOffset))
  const limit = Math.min(500, Math.max(1, Math.floor(rawLimit)))
  const { condition, params } = postFilter(query)

  // Le COUNT parcourt tout le jeu de résultats : à 60 000 posts il pèse une trentaine de
  // millisecondes contre une fraction de milliseconde pour la page elle-même, et
  // better-sqlite3 étant synchrone, il gèle d'autant le processus principal. Le refaire à
  // chaque `loadMore` revenait donc à payer le mur entier à chaque palier de défilement.
  // On ne le calcule qu'à la première tranche ; le total ne varie pas d'une page à l'autre.
  const total =
    offset === 0
      ? (
          db.prepare(`SELECT COUNT(*) AS n FROM posts p WHERE ${condition}`).get(...params) as {
            n: number
          }
        ).n
      : null

  // Une ligne de plus que demandé : sa présence dit exactement s'il reste quelque chose
  // après cette tranche, sans avoir à connaître le total.
  const sql = `${SELECT_POST} WHERE ${condition} ORDER BY ${orderBy(query.sort, query.randomSeed)} LIMIT ? OFFSET ?`
  const rows = db.prepare(sql).all(...params, limit + 1, offset) as PostRow[]
  const hasMore = rows.length > limit

  const posts = rows.slice(0, limit).map(toPost)
  attachMedia(posts)
  attachTags(posts)
  attachSources(posts)

  return { posts, total, offset, hasMore }
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
    .prepare(`${SELECT_POST} WHERE p.is_archived = 0
      AND p.platform IN ('instagram', 'x') AND p.id IN (${placeholders})`)
    .all(...ids) as PostRow[]
  const posts = rows.map(toPost)
  attachMedia(posts)
  attachTags(posts)
  attachSources(posts)
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
    remote_url: string | null
    video_source: string | null
    source_path: string | null
    thumb_attempts: number
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
          `SELECT m.post_id, m.idx, m.kind, m.thumb_path, m.video_path, m.remote_url,
                  m.video_source, m.source_path, m.thumb_attempts, m.width, m.height,
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
      hasSource: Boolean(
        row.thumb_path || row.video_path || row.source_path || row.remote_url || row.video_source || row.video_qualities
      ),
      // Doit rester d'accord avec `PENDING_THUMBNAIL_WHERE`. Un média dont la seule source
      // est un clip n'entre jamais dans la file — sharp ne décode pas un mp4 — et se
      // déclarait pourtant « en préparation » : la carte tournait indéfiniment sur une
      // attente qui n'arriverait jamais. Mieux vaut annoncer qu'il n'y aura pas d'aperçu,
      // ce qui invite d'ailleurs à survoler pour lire.
      thumbStatus: row.thumb_path
        ? 'ready'
        : !(row.source_path || /^https?:/i.test(row.remote_url ?? '')) || row.thumb_attempts >= 3
          ? 'failed'
          : 'pending',
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

function attachSources(posts: Post[]): void {
  if (posts.length === 0) return
  const byId = new Map(posts.map((post) => [post.id, post]))
  for (let offset = 0; offset < posts.length; offset += 500) {
    const ids = posts.slice(offset, offset + 500).map((post) => post.id)
    const placeholders = ids.map(() => '?').join(',')
    const rows = getDb()
      .prepare(`SELECT post_id, source FROM post_sources WHERE post_id IN (${placeholders})`)
      .all(...ids) as { post_id: string; source: ContentSource }[]
    for (const row of rows) byId.get(row.post_id)?.sources.push(row.source)
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
    tags: [],
    sources: []
  }
}

const PUBLIC_PLATFORM_SLOTS = PUBLIC_PLATFORMS.map(() => '?').join(', ')

export function getStats(activeSources: ContentSource[] = ['saved', 'liked']): LibraryStats {
  const db = getDb()
  const sources = activeSources.length > 0 ? activeSources : ['saved']

  // Tout post porte au moins une origine. Quand elles sont toutes actives — le cas courant
  // dès qu'on suit signets *et* likes — la condition est vraie partout et ne fait que
  // payer une sous-requête corrélée par ligne : à elle seule, près de la moitié du temps
  // de cette fonction sur une grande bibliothèque.
  const filtersSources = sources.length < CONTENT_SOURCES.length
  const sourceSlots = sources.map(() => '?').join(', ')
  const sourceArgs = filtersSources ? sources : []

  // Une ligne par post : la sous-requête corrélée est ici évaluée 60 000 fois au plus, et
  // reste la forme la plus rapide.
  const activePost = filtersSources
    ? ` AND EXISTS (SELECT 1 FROM post_sources aps
         WHERE aps.post_id = p.id AND aps.source IN (${sourceSlots}))`
    : ''

  // Une ligne par *lien de tag* : la même sous-requête corrélée serait évaluée autant de
  // fois qu'il existe de liens — 135 000 sur une bibliothèque réellement taguée, soit
  // 350 ms à elle seule. Sous forme d'ensemble, elle n'est construite qu'une fois.
  const activeTagged = filtersSources
    ? ` AND p.id IN (SELECT post_id FROM post_sources WHERE source IN (${sourceSlots}))`
    : ''

  // Plateformes, favoris et étiquettes en une seule passe : trois requêtes parcouraient
  // trois fois la même table pour trois découpages du même décompte.
  const rollup = db
    .prepare(`SELECT p.platform, p.label, SUM(p.is_favorite) AS favorites, COUNT(*) AS n
        FROM posts p
       WHERE p.is_archived = 0 AND p.platform IN (${PUBLIC_PLATFORM_SLOTS})${activePost}
       GROUP BY p.platform, p.label`)
    .all(...PUBLIC_PLATFORMS, ...sourceArgs) as {
    platform: Platform
    label: LabelColor | null
    favorites: number
    n: number
  }[]

  const byPlatform = Object.fromEntries(PLATFORMS.map((p) => [p, 0])) as Record<Platform, number>
  const byLabel: Partial<Record<LabelColor, number>> = {}
  let total = 0
  let favorites = 0
  for (const row of rollup) {
    byPlatform[row.platform] += row.n
    total += row.n
    favorites += row.favorites
    if (row.label) byLabel[row.label] = (byLabel[row.label] ?? 0) + row.n
  }

  // Volontairement sans `active` : les deux compteurs d'origine restent affichés en entier,
  // c'est ce qui permet de choisir entre Signets et Likes en connaissance de cause.
  const bySource: Record<ContentSource, number> = { saved: 0, liked: 0 }
  const sourceRows = db
    .prepare(`SELECT source, COUNT(*) AS n FROM post_sources ps
      JOIN posts p ON p.id = ps.post_id
      WHERE p.is_archived = 0 AND p.platform IN (${PUBLIC_PLATFORM_SLOTS}) GROUP BY source`)
    .all(...PUBLIC_PLATFORMS) as { source: ContentSource; n: number }[]
  for (const row of sourceRows) bySource[row.source] = row.n

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
          AND p.platform IN (${PUBLIC_PLATFORM_SLOTS})
        WHERE 1 = 1${activeTagged}
        GROUP BY t.id
        ORDER BY count DESC, t.name COLLATE NOCASE
        LIMIT 40`
    )
    .all(...PUBLIC_PLATFORMS, ...sourceArgs) as {
    name: string
    count: number
    source: TagSource
  }[]

  return { total, favorites, byPlatform, bySource, byLabel, topTags }
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

export interface OrganizationItem {
  id: string
  platform: Platform
  kind: PostKind
  /** Signet, like, ou les deux — un post peut être les deux à la fois. Jamais un filtre :
   *  Magpie sert les deux à égalité, et l'organisateur doit voir toute la bibliothèque. */
  sources: ContentSource[]
  text: string | null
  authorHandle: string | null
  thumbPath: string | null
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

/**
 * Tout ce que l'organisateur peut ranger — c'est-à-dire toute la bibliothèque.
 *
 * La version précédente ne voyait que les vidéos Instagram et X, soit 46 % des posts sur une
 * bibliothèque réelle : le plus gros paquet, les images X, restait invisible alors qu'il porte
 * le texte du tweet, un excellent signal. Un post sans média ni texte ne sera de toute façon
 * rattaché à rien, il n'y a donc pas de raison de l'écarter en amont.
 *
 * La première vignette disponible suffit, quel que soit le type de média : le repli visuel par
 * centroïde ne demande rien d'autre.
 */
export function organizationItems(): OrganizationItem[] {
  const rows = getDb()
    .prepare(
      `SELECT p.id, p.platform, p.kind, p.text, p.author_handle,
              (SELECT m2.thumb_path FROM media m2
                WHERE m2.post_id = p.id AND m2.thumb_path IS NOT NULL
                ORDER BY m2.idx LIMIT 1) AS thumb_path,
              (SELECT GROUP_CONCAT(ps.source) FROM post_sources ps
                WHERE ps.post_id = p.id) AS sources,
              GROUP_CONCAT(DISTINCT CASE WHEN pt.source <> 'ai' THEN t.name END) AS tags
         FROM posts p
         LEFT JOIN post_tags pt ON pt.post_id = p.id
         LEFT JOIN tags t ON t.id = pt.tag_id
        WHERE p.is_archived = 0
        GROUP BY p.id
        ORDER BY p.discovered_at DESC`
    )
    .all() as {
    id: string
    platform: Platform
    kind: PostKind
    text: string | null
    author_handle: string | null
    thumb_path: string | null
    sources: string | null
    tags: string | null
  }[]
  return rows.map((row) => ({
    id: row.id,
    platform: row.platform,
    kind: row.kind,
    sources: (row.sources?.split(',').filter(Boolean) ?? []) as ContentSource[],
    text: row.text,
    authorHandle: row.author_handle,
    thumbPath: row.thumb_path,
    tags: row.tags?.split(',').filter(Boolean) ?? []
  }))
}

export interface LocalVideoFeature {
  postId: string
  thumbPath: string | null
  visual: Buffer | null
}

export function localVideoFeatures(): Map<string, LocalVideoFeature> {
  const rows = getDb()
    .prepare('SELECT post_id, thumb_path, visual FROM local_video_features')
    .all() as { post_id: string; thumb_path: string | null; visual: Buffer | null }[]
  return new Map(
    rows.map((row) => [
      row.post_id,
      { postId: row.post_id, thumbPath: row.thumb_path, visual: row.visual }
    ])
  )
}

export function saveLocalVideoFeatures(features: LocalVideoFeature[]): void {
  if (features.length === 0) return
  const statement = getDb().prepare(`
    INSERT INTO local_video_features (post_id, thumb_path, visual, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(post_id) DO UPDATE SET
      thumb_path = excluded.thumb_path,
      visual = excluded.visual,
      updated_at = excluded.updated_at
  `)
  const now = Date.now()
  getDb().transaction(() => {
    for (const feature of features) {
      statement.run(feature.postId, feature.thumbPath, feature.visual, now)
    }
  })()
}

export interface PostEmbedding {
  postId: string
  hash: string
  vector: Buffer
}

/**
 * Vecteurs de sens déjà calculés, indexés par post.
 *
 * Le hash porte sur le texte encodé : un post dont la légende n'a pas changé n'est jamais
 * réencodé. C'est ce qui rend la deuxième analyse d'une grande bibliothèque quasi gratuite,
 * comme le fait déjà la signature visuelle.
 */
export function postEmbeddings(): Map<string, PostEmbedding> {
  const rows = getDb()
    .prepare('SELECT post_id, hash, vector FROM post_embeddings')
    .all() as { post_id: string; hash: string; vector: Buffer }[]
  return new Map(
    rows.map((row) => [row.post_id, { postId: row.post_id, hash: row.hash, vector: row.vector }])
  )
}

export function savePostEmbeddings(embeddings: PostEmbedding[]): void {
  if (embeddings.length === 0) return
  const statement = getDb().prepare(`
    INSERT INTO post_embeddings (post_id, hash, vector, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(post_id) DO UPDATE SET
      hash = excluded.hash,
      vector = excluded.vector,
      updated_at = excluded.updated_at
  `)
  const now = Date.now()
  getDb().transaction(() => {
    for (const embedding of embeddings) {
      statement.run(embedding.postId, embedding.hash, embedding.vector, now)
    }
  })()
}

export interface PostImageEmbedding {
  postId: string
  hash: string
  /** DINOv2 : la structure et le style. */
  structure: Buffer
  /** SigLIP : le sujet. */
  meaning: Buffer
  /** Nombre d'images moyennées — trois pour une vidéo dont le clip est en cache. */
  frames: number
}

/**
 * Vecteurs d'image déjà calculés, indexés par post.
 *
 * Même économie que pour le texte : le hash porte sur la vignette et la version des
 * modèles, donc une deuxième analyse ne réencode que ce qui a changé.
 */
/**
 * Les empreintes seules, sans les vecteurs.
 *
 * Sert à décider, avant d'extraire quoi que ce soit, quels clips demandent encore une
 * lecture. `postImageEmbeddings()` répondrait aussi bien, mais il ramène deux blobs par
 * post — une quarantaine de mégaoctets sur la bibliothèque de référence — pour deux
 * colonnes qu'on lit.
 */
export function postImageHashes(): Map<string, { hash: string; frames: number }> {
  const rows = getDb()
    .prepare('SELECT post_id, hash, frames FROM post_image_embeddings')
    .all() as { post_id: string; hash: string; frames: number }[]
  return new Map(rows.map((row) => [row.post_id, { hash: row.hash, frames: row.frames }]))
}

export function postImageEmbeddings(): Map<string, PostImageEmbedding> {
  const rows = getDb()
    .prepare('SELECT post_id, hash, structure, meaning, frames FROM post_image_embeddings')
    .all() as {
    post_id: string
    hash: string
    structure: Buffer
    meaning: Buffer
    frames: number
  }[]
  return new Map(
    rows.map((row) => [
      row.post_id,
      {
        postId: row.post_id,
        hash: row.hash,
        structure: row.structure,
        meaning: row.meaning,
        frames: row.frames
      }
    ])
  )
}

export function savePostImageEmbeddings(embeddings: PostImageEmbedding[]): void {
  if (embeddings.length === 0) return
  const statement = getDb().prepare(`
    INSERT INTO post_image_embeddings (post_id, hash, structure, meaning, frames, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(post_id) DO UPDATE SET
      hash = excluded.hash,
      structure = excluded.structure,
      meaning = excluded.meaning,
      frames = excluded.frames,
      updated_at = excluded.updated_at
  `)
  const now = Date.now()
  getDb().transaction(() => {
    for (const item of embeddings) {
      statement.run(item.postId, item.hash, item.structure, item.meaning, item.frames, now)
    }
  })()
}

/** Les clips réellement présents sur le disque : les seuls dont on peut tirer des images. */
export function cachedVideoPaths(): { postId: string; videoPath: string }[] {
  return (
    getDb()
      .prepare(
        `SELECT m.post_id, m.video_path FROM media m JOIN posts p ON p.id = m.post_id
          WHERE m.video_path IS NOT NULL AND p.is_archived = 0
          GROUP BY m.post_id`
      )
      .all() as { post_id: string; video_path: string }[]
  ).map((row) => ({ postId: row.post_id, videoPath: row.video_path }))
}

/** Combien de posts illustrés attendent encore d'être lus. Sert à annoncer l'étape. */
export function countPendingImageEmbeddings(): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM posts p
          WHERE p.is_archived = 0
            AND EXISTS (SELECT 1 FROM media m WHERE m.post_id = p.id AND m.thumb_path IS NOT NULL)
            AND NOT EXISTS (SELECT 1 FROM post_image_embeddings e WHERE e.post_id = p.id)`
      )
      .get() as { n: number }
  ).n
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

export function upsertPosts(
  posts: PostInput[],
  media: MediaInput[],
  source: ContentSource = 'saved'
): void {
  const db = getDb()
  const post = upsertPostStmt()
  const mediaStmt = db.prepare(MEDIA_UPSERT_SQL)
  const deleteVariants = db.prepare('DELETE FROM media_variants WHERE post_id = ? AND idx = ?')
  // Compilées une fois, pas une fois par post : `prepare` reconstruit le plan à chaque
  // appel, et une page de synchronisation en faisait deux de plus par élément.
  const trimMedia = db.prepare('DELETE FROM media WHERE post_id = ? AND idx >= ?')
  const trimVariants = db.prepare('DELETE FROM media_variants WHERE post_id = ? AND idx >= ?')
  const variantStmt = db.prepare(/* sql */ `
    INSERT INTO media_variants (post_id, idx, quality, source, width, height, bitrate)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const sourceStmt = db.prepare(/* sql */ `
    INSERT INTO post_sources (post_id, source, source_rank, source_at, discovered_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(post_id, source) DO UPDATE SET
      source_rank = COALESCE(post_sources.source_rank, excluded.source_rank),
      source_at = COALESCE(post_sources.source_at, excluded.source_at)
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
      sourceStmt.run(p.id, source, p.savedRank ?? null, p.savedAt ?? null, now)

      // Une plateforme peut retirer un élément d'un carrousel ou remplacer une vidéo.
      // Les anciennes lignes ne doivent alors pas survivre au nouveau payload.
      trimMedia.run(p.id, p.mediaCount ?? 0)
      trimVariants.run(p.id, p.mediaCount ?? 0)
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
export function knownPostIds(platform: Platform, source: ContentSource = 'saved'): Set<string> {
  const rows = getDb()
    .prepare(`SELECT p.id FROM posts p JOIN post_sources ps ON ps.post_id = p.id
      WHERE p.platform = ? AND ps.source = ?`)
    .all(platform, source) as { id: string }[]
  return new Set(rows.map((row) => row.id))
}

export interface PlaybackMediaSource {
  platform: Platform
  source: string | null
  cachePath: string | null
}

/**
 * Résout un média au moment où le lecteur s'ouvre. L'URL distante ne traverse jamais le
 * pont vers l'interface : le protocole `magpie://remote` la diffuse depuis la session
 * isolée de la plateforme, avec ses cookies et son referer.
 */
export function playbackMediaSource(
  postId: string,
  idx: number,
  kind: 'image' | 'video',
  quality: PlaybackQuality
): PlaybackMediaSource | null {
  const row = getDb()
    .prepare(
      `SELECT p.platform, m.kind, m.remote_url, m.video_source, m.video_path
         FROM media m JOIN posts p ON p.id = m.post_id
        WHERE m.post_id = ? AND m.idx = ?`
    )
    .get(postId, idx) as
    | {
        platform: Platform
        kind: 'image' | 'video'
        remote_url: string | null
        video_source: string | null
        video_path: string | null
      }
    | undefined
  if (!row || row.kind !== kind) return null

  if (kind === 'image') {
    return { platform: row.platform, source: row.remote_url, cachePath: null }
  }

  if (quality === 'auto') {
    // Chromium desktop ne lit pas directement tous les manifestes HLS/DASH. Reddit
    // fournit aussi un MP4 de secours dans `media_variants` : en mode streaming il vaut
    // mieux une lecture immédiate que laisser un manifeste inutilisable au lecteur.
    if (row.video_source && /\.(?:m3u8|mpd)(?:\?|$)/i.test(row.video_source)) {
      const fallback = getDb()
        .prepare(
          `SELECT source, cache_path
             FROM media_variants
            WHERE post_id = ? AND idx = ?
            ORDER BY CASE quality
              WHEN '480p' THEN 1 WHEN '720p' THEN 2 WHEN '1080p' THEN 3 ELSE 4 END
            LIMIT 1`
        )
        .get(postId, idx) as { source: string; cache_path: string | null } | undefined
      if (fallback) {
        return { platform: row.platform, source: fallback.source, cachePath: row.video_path }
      }
    }
    return { platform: row.platform, source: row.video_source, cachePath: row.video_path }
  }

  const variant = getDb()
    .prepare(
      `SELECT source, cache_path
         FROM media_variants
        WHERE post_id = ? AND idx = ? AND quality = ?`
    )
    .get(postId, idx, quality) as { source: string; cache_path: string | null } | undefined
  return variant
    ? { platform: row.platform, source: variant.source, cachePath: variant.cache_path }
    : null
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

export interface AccountSourceRow {
  platform: Platform
  source: ContentSource
  lastSyncAt: number | null
  lastSyncStatus: string | null
  cursor: string | null
}

export function readAccountSource(
  platform: Platform,
  source: ContentSource
): AccountSourceRow | null {
  const row = getDb()
    .prepare('SELECT * FROM account_sync_sources WHERE platform = ? AND source = ?')
    .get(platform, source) as
    | {
        platform: Platform
        source: ContentSource
        last_sync_at: number | null
        last_sync_status: string | null
        cursor: string | null
      }
    | undefined
  return row
    ? {
        platform: row.platform,
        source: row.source,
        lastSyncAt: row.last_sync_at,
        lastSyncStatus: row.last_sync_status,
        cursor: row.cursor
      }
    : null
}

export function writeAccountSource(
  platform: Platform,
  source: ContentSource,
  patch: { lastSyncAt?: number; lastSyncStatus?: string; cursor?: string | null }
): void {
  getDb()
    .prepare(`INSERT INTO account_sync_sources
      (platform, source, last_sync_at, last_sync_status, cursor)
      VALUES (@platform, @source, @last_sync_at, @last_sync_status, @cursor)
      ON CONFLICT(platform, source) DO UPDATE SET
        last_sync_at = COALESCE(excluded.last_sync_at, account_sync_sources.last_sync_at),
        last_sync_status = COALESCE(excluded.last_sync_status, account_sync_sources.last_sync_status),
        cursor = CASE WHEN @has_cursor = 1 THEN @cursor ELSE account_sync_sources.cursor END`)
    .run({
      platform,
      source,
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
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM account_sync_sources WHERE platform = ?').run(platform)
    db.prepare('DELETE FROM accounts WHERE platform = ?').run(platform)
  })()
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
  // Un ajout est toujours un geste explicite — depuis la vue détaillée ou depuis un plan
  // d'organisation validé. Il lève donc le retrait précédent : le classement automatique a
  // de nouveau le droit de proposer ce post pour cette collection.
  const forget = db.prepare(
    'DELETE FROM collection_removals WHERE collection_id = ? AND post_id = ?'
  )
  const now = Date.now()
  db.transaction(() => {
    for (const id of postIds) forget.run(collectionId, id)
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
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM collection_posts WHERE collection_id = ? AND post_id = ?').run(
      collectionId,
      postId
    )
    // Le retrait est mémorisé, pas seulement appliqué. Le classement automatique repart
    // sinon des mêmes signaux à chaque synchronisation et remet le post exactement là où
    // il vient d'être enlevé — le seul endroit où Magpie défaisait un geste explicite.
    db.prepare(
      `INSERT INTO collection_removals (collection_id, post_id, removed_at) VALUES (?, ?, ?)
       ON CONFLICT(collection_id, post_id) DO UPDATE SET removed_at = excluded.removed_at`
    ).run(collectionId, postId, Date.now())
  })()
}

export interface OrganizerApplication {
  appliedAt: number
  collections: number
  posts: number
  /** Collections nées de ce classement : elles disparaissent si on l'annule. */
  createdCollectionIds: number[]
  /** Ce qu'il a réellement rangé — et donc tout ce que l'annulation doit retirer. */
  filed: Array<{ collectionId: number; postIds: string[] }>
}

/** Ne conserve que le dernier classement : « annuler » ne remonte pas un historique. */
export function recordOrganizerApplication(
  entry: Omit<OrganizerApplication, 'appliedAt'>
): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM organizer_applications').run()
    db.prepare(
      `INSERT INTO organizer_applications
         (applied_at, collections, posts, created_ids, filed)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      Date.now(),
      entry.collections,
      entry.posts,
      JSON.stringify(entry.createdCollectionIds),
      JSON.stringify(entry.filed)
    )
  })()
}

export function lastOrganizerApplication(): OrganizerApplication | null {
  const row = getDb()
    .prepare(
      `SELECT applied_at, collections, posts, created_ids, filed
         FROM organizer_applications ORDER BY applied_at DESC LIMIT 1`
    )
    .get() as
    | { applied_at: number; collections: number; posts: number; created_ids: string; filed: string }
    | undefined
  if (!row) return null
  try {
    return {
      appliedAt: row.applied_at,
      collections: row.collections,
      posts: row.posts,
      createdCollectionIds: JSON.parse(row.created_ids) as number[],
      filed: JSON.parse(row.filed) as OrganizerApplication['filed']
    }
  } catch {
    // Une trace illisible ne doit pas empêcher d'ouvrir l'organisateur.
    return null
  }
}


/**
 * Défait le dernier classement : les vidéos sortent des collections où il les avait mises,
 * et celles qu'il avait créées disparaissent si plus rien ne s'y trouve.
 *
 * Les retraits sont **mémorisés comme des retraits manuels**. Sans cela, le classement
 * automatique — dont les règles viennent justement d'être apprises — remettrait tout en
 * place à la synchronisation suivante, et l'annulation n'aurait tenu que quelques minutes.
 */
export function revertOrganizerApplication(): { removed: number; collectionsDeleted: number } {
  const application = lastOrganizerApplication()
  if (!application) return { removed: 0, collectionsDeleted: 0 }

  const db = getDb()
  return db.transaction(() => {
    const unfile = db.prepare(
      'DELETE FROM collection_posts WHERE collection_id = ? AND post_id = ?'
    )
    const remember = db.prepare(
      `INSERT INTO collection_removals (collection_id, post_id, removed_at) VALUES (?, ?, ?)
       ON CONFLICT(collection_id, post_id) DO UPDATE SET removed_at = excluded.removed_at`
    )
    const now = Date.now()
    let removed = 0
    for (const entry of application.filed) {
      for (const postId of entry.postIds) {
        if (unfile.run(entry.collectionId, postId).changes > 0) removed++
        remember.run(entry.collectionId, postId, now)
      }
    }

    // Une collection née de ce classement mais que l'utilisateur a depuis remplie lui-même
    // n'est pas la nôtre à supprimer.
    const isEmpty = db.prepare('SELECT COUNT(*) AS n FROM collection_posts WHERE collection_id = ?')
    const dropCollection = db.prepare('DELETE FROM collections WHERE id = ?')
    let collectionsDeleted = 0
    for (const collectionId of application.createdCollectionIds) {
      if ((isEmpty.get(collectionId) as { n: number }).n > 0) continue
      // La cascade emporte aussi les règles et les retraits qui la visaient.
      if (dropCollection.run(collectionId).changes > 0) collectionsDeleted++
    }

    db.prepare('DELETE FROM organizer_applications').run()
    return { removed, collectionsDeleted }
  })()
}

/** Posts retirés à la main, par collection. Lu avant tout classement automatique. */
export function collectionRemovals(): Map<number, Set<string>> {
  const rows = getDb()
    .prepare('SELECT collection_id, post_id FROM collection_removals')
    .all() as { collection_id: number; post_id: string }[]

  const byCollection = new Map<number, Set<string>>()
  for (const row of rows) {
    const posts = byCollection.get(row.collection_id) ?? new Set<string>()
    posts.add(row.post_id)
    byCollection.set(row.collection_id, posts)
  }
  return byCollection
}

export function collectionsForPost(postId: string): number[] {
  const rows = getDb()
    .prepare('SELECT collection_id FROM collection_posts WHERE post_id = ?')
    .all(postId) as { collection_id: number }[]
  return rows.map((row) => row.collection_id)
}

export interface OrganizerRuleRow {
  ruleKey: string
  collectionId: number | null
  ignored: boolean
}

export function organizerRules(): OrganizerRuleRow[] {
  return (
    getDb()
      .prepare(
        `SELECT rule_key AS ruleKey, collection_id AS collectionId, ignored
           FROM organizer_rules`
      )
      .all() as Array<{ ruleKey: string; collectionId: number | null; ignored: number }>
  ).map((row) => ({ ...row, ignored: row.ignored === 1 }))
}

/**
 * Met à jour uniquement les règles présentes dans le plan validé. Les anciennes restent
 * disponibles si une petite catégorie ne réapparaît pas lors d'une analyse ultérieure.
 */
export function rememberOrganizerRules(
  assigned: Array<{ ruleKey: string; collectionId: number }>,
  ignoredRuleKeys: string[]
): void {
  const db = getDb()
  const assignedKeys = new Set(assigned.map((entry) => entry.ruleKey))
  const upsert = db.prepare(
    `INSERT INTO organizer_rules (rule_key, collection_id, ignored, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(rule_key) DO UPDATE SET
       collection_id = excluded.collection_id,
       ignored = excluded.ignored,
       updated_at = excluded.updated_at`
  )
  const now = Date.now()
  for (const entry of assigned) upsert.run(entry.ruleKey, entry.collectionId, 0, now)
  for (const ruleKey of ignoredRuleKeys) {
    if (!assignedKeys.has(ruleKey)) upsert.run(ruleKey, null, 1, now)
  }
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
      `UPDATE media SET thumb_path = ?, thumb_attempts = 0, width = ?, height = ?
       WHERE post_id = ? AND idx = ?`
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
  thumb_attempts: number
}

/**
 * Médias dont la vignette reste à produire.
 *
 * ⚠️ La source peut être **locale ou distante**. Ne retenir que `source_path` — ce que
 * faisait la première version, à l'époque où tout venait de la fixture — laissait tous les
 * vrais signets sans vignette, puisqu'ils n'ont qu'une URL.
 */
/** Condition partagée par la file et son décompte : elles doivent rester d'accord. */
const PENDING_THUMBNAIL_WHERE = `m.thumb_path IS NULL
  AND m.thumb_attempts < 3
  AND (m.source_path IS NOT NULL OR m.remote_url LIKE 'http%')`

export function pendingThumbnails(
  rawLimit = 400,
  coverOnly = false,
  query?: PostQuery | null
): PendingMedia[] {
  const limit = Math.min(1000, Math.max(1, Math.floor(rawLimit)))
  const scope = query ? postFilter(query) : null
  return getDb()
    .prepare(
      `SELECT m.post_id, m.idx, p.platform, m.source_path, m.remote_url, m.video_source,
              m.thumb_attempts, m.video_attempts
         FROM media m JOIN posts p ON p.id = m.post_id
        WHERE ${PENDING_THUMBNAIL_WHERE}${coverOnly ? ' AND m.idx = 0' : ''}
          ${scope ? `AND ${scope.condition}` : ''}
        ORDER BY CASE WHEN m.idx = 0 THEN 0 ELSE 1 END,
                 CASE WHEN p.saved_rank IS NULL THEN 1 ELSE 0 END,
                 p.saved_rank ASC, p.discovered_at DESC, m.post_id, m.idx
        LIMIT ?`
    )
    .all(...(scope?.params ?? []), limit) as PendingMedia[]
}

/**
 * Ce qu'il reste à préparer. Sert à annoncer la taille avant de lancer un préchargement,
 * puis à en suivre l'avancement : un décompte recalculé est la seule mesure qui reste juste
 * quand un même média est réessayé plusieurs fois.
 */
export function countPendingThumbnails(coverOnly = false, query?: PostQuery | null): number {
  const scope = query ? postFilter(query) : null
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM media m
          WHERE ${PENDING_THUMBNAIL_WHERE}${coverOnly ? ' AND m.idx = 0' : ''}
          ${scope ? `AND EXISTS (SELECT 1 FROM posts p WHERE p.id = m.post_id AND ${scope.condition})` : ''}`
      )
      .get(...(scope?.params ?? [])) as { n: number }
  ).n
}

/**
 * Clips restant à télécharger, avec la variante la plus légère disponible.
 *
 * On préfère `media_variants` à `video_source` : ce dernier a été figé au moment de la
 * synchronisation, selon la qualité réglée à l'époque. Choisir ici permet de préparer une
 * bibliothèque entière en 480p sans avoir à tout resynchroniser.
 */
const PENDING_CLIP_WHERE = `m.kind = 'video'
  AND m.video_path IS NULL
  AND m.video_attempts < 3
  AND m.video_cache_state <> 'skipped'`

const CLIP_SOURCE = `COALESCE(
  (SELECT v.source FROM media_variants v
    WHERE v.post_id = m.post_id AND v.idx = m.idx
    ORDER BY CASE v.quality
      WHEN '480p' THEN 1 WHEN '720p' THEN 2 WHEN '1080p' THEN 3 ELSE 4 END
    LIMIT 1),
  m.video_source
)`

export function pendingClips(rawLimit = 40, query?: PostQuery | null): PendingMedia[] {
  const limit = Math.min(200, Math.max(1, Math.floor(rawLimit)))
  const scope = query ? postFilter(query) : null
  return getDb()
    .prepare(
      `SELECT m.post_id, m.idx, p.platform, m.source_path, m.remote_url,
              ${CLIP_SOURCE} AS video_source, m.video_attempts, m.thumb_attempts
         FROM media m JOIN posts p ON p.id = m.post_id
        WHERE ${PENDING_CLIP_WHERE}
          AND p.is_archived = 0
          AND ${CLIP_SOURCE} LIKE 'http%'
          ${scope ? `AND ${scope.condition}` : ''}
        ORDER BY p.saved_rank ASC, p.discovered_at DESC, m.post_id, m.idx
        LIMIT ?`
    )
    .all(...(scope?.params ?? []), limit) as PendingMedia[]
}

export function countPendingClips(query?: PostQuery | null): number {
  const scope = query ? postFilter(query) : null
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM media m JOIN posts p ON p.id = m.post_id
          WHERE ${PENDING_CLIP_WHERE}
            AND p.is_archived = 0
            AND ${CLIP_SOURCE} LIKE 'http%'
            ${scope ? `AND ${scope.condition}` : ''}`
      )
      .get(...(scope?.params ?? [])) as { n: number }
  ).n
}

/** Vignettes demandées par la portion visible de la grille, dans l'ordre d'affichage. */
export function pendingThumbnailsForPosts(postIds: string[], rawLimit = 400): PendingMedia[] {
  const ids = [...new Set(postIds)].filter(Boolean).slice(0, 1000)
  if (ids.length === 0) return []
  const limit = Math.min(1000, Math.max(1, Math.floor(rawLimit)))
  const placeholders = ids.map(() => '?').join(',')
  return getDb()
    .prepare(
      `SELECT m.post_id, m.idx, p.platform, m.source_path, m.remote_url, m.video_source,
              m.thumb_attempts, m.video_attempts
         FROM media m JOIN posts p ON p.id = m.post_id
        WHERE m.post_id IN (${placeholders})
          AND m.thumb_path IS NULL
          AND m.thumb_attempts < 3
          AND (m.source_path IS NOT NULL OR m.remote_url LIKE 'http%')
        ORDER BY instr(',' || ? || ',', ',' || m.post_id || ','), m.idx
        LIMIT ?`
    )
    .all(...ids, ids.join(','), limit) as PendingMedia[]
}

export function thumbnailPathsForPosts(postIds: string[]): string[] {
  const ids = [...new Set(postIds)].filter(Boolean).slice(0, 1000)
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  return (
    getDb()
      .prepare(`SELECT thumb_path FROM media
        WHERE post_id IN (${placeholders}) AND thumb_path IS NOT NULL`)
      .all(...ids) as { thumb_path: string }[]
  ).map((row) => row.thumb_path)
}

/**
 * Oublie des clips évincés du cache.
 *
 * Le pendant de `forgetThumbnailPaths`, qui manquait parce que rien n'évinçait jamais de clip.
 * L'état repasse en `pending` : le clip pourra revenir si son lien tient encore, et sinon la
 * file le saura.
 */
export function forgetVideoPaths(paths: string[]): void {
  const clean = [...new Set(paths)].filter(Boolean)
  if (clean.length === 0) return
  const placeholders = clean.map(() => '?').join(',')
  getDb()
    .prepare(`UPDATE media SET video_path = NULL, video_cache_state = 'pending', video_attempts = 0
      WHERE video_path IN (${placeholders})`)
    .run(...clean)
}

export function forgetThumbnailPaths(paths: string[]): void {
  const clean = [...new Set(paths)].filter(Boolean)
  if (clean.length === 0) return
  const placeholders = clean.map(() => '?').join(',')
  getDb()
    .prepare(`UPDATE media SET thumb_path = NULL, thumb_attempts = 0
      WHERE thumb_path IN (${placeholders})`)
    .run(...clean)
}

/**
 * Remet à zéro les références au cache média, en épargnant les fichiers réellement encore
 * présents. Une purge peut être partielle — sous Windows, un clip en cours de lecture
 * refuse d'être supprimé — et effacer sa référence en laisserait un orphelin sur le disque
 * qu'on retéléchargerait pour rien.
 */
export function resetCachedMediaPaths(survivors: string[] = []): void {
  const kept = [...new Set(survivors)].filter(Boolean)
  const slots = kept.map(() => '?').join(',')
  const db = getDb()
  db.transaction(() => {
    db.prepare(
      `UPDATE media SET thumb_path = NULL, thumb_attempts = 0
        WHERE thumb_path IS NOT NULL${kept.length > 0 ? ` AND thumb_path NOT IN (${slots})` : ''}`
    ).run(...kept)
    db.prepare(
      `UPDATE media SET video_path = NULL, video_cache_state = 'pending', video_attempts = 0
        WHERE video_path IS NOT NULL${kept.length > 0 ? ` AND video_path NOT IN (${slots})` : ''}`
    ).run(...kept)
    // Les clips restés en « skipped » faute de place doivent repartir en file d'attente :
    // la purge vient précisément de libérer de l'espace.
    db.prepare(
      "UPDATE media SET video_cache_state = 'pending' WHERE video_cache_state = 'skipped'"
    ).run()
  })()
}

export function markThumbnailFailure(postId: string, idx: number): void {
  getDb()
    .prepare(
      `UPDATE media SET thumb_attempts = thumb_attempts + 1 WHERE post_id = ? AND idx = ?`
    )
    .run(postId, idx)
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

export function pendingVideos(rawLimit = 150): PendingMedia[] {
  const limit = Math.min(500, Math.max(1, Math.floor(rawLimit)))
  return getDb()
    .prepare(
      `SELECT m.post_id, m.idx, p.platform, m.source_path, m.remote_url, m.video_source,
              m.video_attempts
         FROM media m JOIN posts p ON p.id = m.post_id
        WHERE m.video_path IS NULL AND m.video_source IS NOT NULL
          AND m.video_cache_state = 'pending' AND m.video_attempts < 3
        ORDER BY CASE WHEN m.idx = 0 THEN 0 ELSE 1 END,
                 CASE WHEN p.saved_rank IS NULL THEN 1 ELSE 0 END,
                 p.saved_rank ASC, p.discovered_at DESC, m.post_id, m.idx
        LIMIT ?`
    )
    .all(limit) as PendingMedia[]
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

/** Une position figée sur la carte, dans le repère unité. */
export interface MapPosition {
  postId: string
  x: number
  y: number
}

/**
 * Fige la projection courante.
 *
 * Sans elle, chaque analyse redistribue les neuf mille points et toute frontière tracée à la
 * main désignerait aussitôt autre chose. C'est ce qui rend le classement par frontières
 * possible : les positions ne bougent plus, les nouveaux posts viennent s'y ajouter.
 */
export function saveMapPositions(positions: MapPosition[]): void {
  if (positions.length === 0) return
  const insert = getDb().prepare(
    'INSERT INTO post_positions (post_id, x, y) VALUES (?, ?, ?)\n' +
      '  ON CONFLICT(post_id) DO UPDATE SET x = excluded.x, y = excluded.y'
  )
  getDb().transaction(() => {
    for (const position of positions) insert.run(position.postId, position.x, position.y)
  })()
}

export function mapPositions(): Map<string, { x: number; y: number }> {
  const rows = getDb().prepare('SELECT post_id, x, y FROM post_positions').all() as {
    post_id: string
    x: number
    y: number
  }[]
  return new Map(rows.map((row) => [row.post_id, { x: row.x, y: row.y }]))
}

/**
 * Efface la carte figée **et** les frontières, ensemble.
 *
 * Jamais l'une sans l'autre : une frontière ne veut rien dire sans les positions contre
 * lesquelles elle a été tracée. Les séparer laisserait des contours qui désignent d'anciens
 * emplacements — c'est-à-dire des collections fausses, sans que rien ne le signale. C'est
 * aussi ce que l'avertissement « cela effacera vos frontières » promet à l'utilisateur.
 */
export function clearFrozenMap(): void {
  getDb().transaction(() => {
    getDb().prepare('DELETE FROM post_positions').run()
    getDb().prepare('DELETE FROM map_state').run()
  })()
}

/**
 * L'empreinte des réglages qui ont produit les positions rangées, ou null.
 *
 * Lue avant de servir la carte figée : mêmes réglages, on relit ; réglages différents, on
 * reprojette. Sans elle, un changement de recette ou de voisinage aurait été servi depuis
 * l’ancienne carte indéfiniment, en silence.
 */
export function mapFingerprint(): string | null {
  const row = getDb().prepare('SELECT fingerprint FROM map_state WHERE id = 1').get() as
    | { fingerprint: string }
    | undefined
  return row?.fingerprint ?? null
}

export function saveMapFingerprint(fingerprint: string): void {
  getDb()
    .prepare(
      'INSERT INTO map_state (id, fingerprint, updated_at) VALUES (1, ?, ?)' +
        '  ON CONFLICT(id) DO UPDATE SET fingerprint = excluded.fingerprint,' +
        '    updated_at = excluded.updated_at'
    )
    .run(fingerprint, Date.now())
}

/** Une étiquette posée à la main sur la carte, accrochée aux posts qui l'entouraient. */
export interface MapLabel {
  id: string
  text: string
  anchors: string[]
}

/**
 * Range une étiquette.
 *
 * `anchors` plutôt qu'une position, et c'est tout l'intérêt : une reprojection déplace les neuf
 * mille points, donc une étiquette figée en coordonnées finirait par désigner autre chose.
 * Accrochée à ses voisins, elle les suit.
 */
export function saveMapLabel(label: MapLabel): void {
  getDb()
    .prepare(
      'INSERT INTO map_labels (id, text, anchors, created_at) VALUES (?, ?, ?, ?)\n' +
        '  ON CONFLICT(id) DO UPDATE SET text = excluded.text, anchors = excluded.anchors'
    )
    .run(label.id, label.text, JSON.stringify(label.anchors), Date.now())
}

export function mapLabels(): MapLabel[] {
  return (
    getDb().prepare('SELECT id, text, anchors FROM map_labels ORDER BY created_at').all() as {
      id: string
      text: string
      anchors: string
    }[]
  ).flatMap((row) => {
    try {
      const anchors = JSON.parse(row.anchors) as string[]
      return Array.isArray(anchors) ? [{ id: row.id, text: row.text, anchors }] : []
    } catch {
      // Une étiquette illisible ne doit pas emporter la carte : on la laisse de côté.
      console.warn('[magpie] Étiquette de carte illisible, ignorée :', row.id)
      return []
    }
  })
}

export function deleteMapLabel(id: string): void {
  getDb().prepare('DELETE FROM map_labels WHERE id = ?').run(id)
}
