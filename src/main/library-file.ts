import type Database from 'better-sqlite3'
import { createReadStream } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import type {
  ContentSource,
  LabelColor,
  LibraryImportReport,
  Platform,
  PostKind,
  TagSource,
  VideoQuality
} from '@shared/types'
import { CONTENT_SOURCES, LABELS, PLATFORMS, POST_KINDS } from '@shared/types'
import { normalizeTagName, tagKey } from '@shared/tags'
import { fold } from './db/functions'

/**
 * La bibliothèque dans un seul fichier JSON, et le chemin du retour.
 *
 * SPEC §10 promettait que rien n'est captif, et §14 relevait que c'était faux : l'export pour
 * assistant écrit du texte à lire, pas des données à reprendre, et il n'existait aucun import.
 * Un changement d'ordinateur, une base abîmée sans sauvegarde, l'envie de fusionner deux
 * bibliothèques : aucun de ces cas n'avait de sortie.
 *
 * Ce module ne connaît ni Electron ni `getDb()` : il reçoit la base en paramètre. C'est ce qui
 * permet à `check:library-file` de rejouer l'aller-retour complet sur des bases en mémoire —
 * exporter, importer dans une base vide, réimporter, annuler — avec le vrai code.
 *
 * **Le fichier est une entrée non fiable.** Quelqu'un peut en écrire un à la main, le recevoir
 * d'un tiers, ou en tronquer un en le copiant. Tout ce qui en sort est donc borné, typé et
 * filtré avant de toucher la base : plateformes connues, identifiants cohérents, adresses web
 * en `http(s)` uniquement — une URL de post est ouverte par le navigateur du système, et un
 * `javascript:` ou un `file:` n'a rien à y faire.
 */

export const LIBRARY_FORMAT = 'magpie-library'
export const LIBRARY_VERSION = 1

/* ------------------------------------------------------------------ le format */

export interface FileSource {
  source: ContentSource
  rank: number | null
  at: string | null
  discoveredAt: string | null
}

export interface FileVariant {
  quality: VideoQuality
  url: string
  width: number | null
  height: number | null
  bitrate: number | null
}

export interface FileMedia {
  index: number
  kind: 'image' | 'video'
  width: number | null
  height: number | null
  /** L'image, telle que la plateforme la sert. Jamais un chemin local : il ne voyage pas. */
  url: string | null
  videoUrl: string | null
  variants: FileVariant[]
}

export interface FilePost {
  id: string
  platform: Platform
  nativeId: string
  url: string
  author: { handle: string | null; name: string | null; avatar: string | null }
  text: string | null
  /** `''` n'est pas une absence : « écouté, rien à en tirer », ce qui évite de réécouter. */
  transcript: string | null
  kind: PostKind
  mediaCount: number
  width: number | null
  height: number | null
  publishedAt: string | null
  savedAt: string | null
  discoveredAt: string | null
  savedRank: number | null
  sources: FileSource[]
  media: FileMedia[]
  tags: { name: string; source: TagSource }[]
  favorite: boolean
  label: LabelColor | null
  archived: boolean
  /** Présent et vrai seulement pour la fixture : elle reste retirable d'un geste après import. */
  demo?: boolean
  raw?: unknown
}

export interface FileCollection {
  name: string
  color: LabelColor | null
  kind: 'query' | 'manual'
  query: string | null
  targetSize: number
  keywords: { word: string; weight: number }[]
  /**
   * Pour une liste, son contenu. Pour une collection à mots-clés, **ce qu'elle retient à la date
   * de l'export** — `membersComputed` le dit — de quoi la remplir tout de suite chez celui qui
   * importe, en attendant que ses propres vecteurs la recalculent.
   */
  members: string[]
  membersComputed: boolean
  /** Les retraits faits à la main : sans eux, le rangement automatique y remettrait ces posts. */
  removed: string[]
}

export interface FileMapLabel {
  id: string
  text: string
  anchors: string[]
  createdAt: string | null
}

/* ------------------------------------------------------------------ les bornes */

/**
 * Ce qu'un fichier peut demander, au plus.
 *
 * Des bornes larges — dix fois ce qu'une vraie bibliothèque produit — mais des bornes : un
 * fichier fabriqué ne doit pas pouvoir faire écrire un gigaoctet de légende ni un million de
 * mots-clés.
 */
const LIMITS = {
  fileBytes: 4 * 1024 ** 3,
  /** Un post, `raw` compris. Un carrousel d'Instagram brut pèse quelques dizaines de ko. */
  elementChars: 4 * 1024 ** 2,
  /** Tout ce qui n'est pas un post : en-tête, collections et leurs appartenances, étiquettes. */
  headChars: 256 * 1024 ** 2,
  posts: 1_000_000,
  id: 300,
  nativeId: 200,
  url: 4096,
  author: 300,
  text: 100_000,
  transcript: 500_000,
  rawChars: 2 * 1024 ** 2,
  media: 60,
  variants: 12,
  tags: 200,
  collections: 2000,
  collectionName: 120,
  query: 500,
  keywords: 200,
  keyword: 120,
  members: 1_000_000,
  mapLabels: 10_000,
  mapLabelText: 120,
  anchors: 1000
} as const

const QUALITIES: VideoQuality[] = ['480p', '720p', '1080p', 'source']
const TAG_SOURCES: TagSource[] = ['user', 'rule', 'ai']

/** Une erreur qui dit **quoi** ne va pas, sous une forme que l'appelant traduit. */
export type LibraryFileProblem =
  | 'notMagpie'
  | 'newerVersion'
  | 'invalidJson'
  | 'tooLarge'
  | 'unreadable'

export class LibraryFileError extends Error {
  constructor(
    readonly problem: LibraryFileProblem,
    readonly vars: Record<string, string | number> = {}
  ) {
    super(`Fichier de bibliothèque refusé : ${problem}`)
    this.name = 'LibraryFileError'
  }
}

export class LibraryTransferCancelled extends Error {
  constructor() {
    super('Transfert interrompu')
    this.name = 'LibraryTransferCancelled'
  }
}

/* ------------------------------------------------------------------ petits outils */

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function iso(ms: number | null | undefined): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** Une adresse web, ou rien. Le reste — chemin local, `fixture://`, `javascript:` — ne sort pas. */
function webUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.url) return null
  if (!/^https?:\/\//i.test(value)) return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  return value.length > max ? value.slice(0, max) : value
}

/** Un nom lisible sur une ligne : pas de caractère de contrôle, pas d'espace en trop. */
function label(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, max) : null
}

function integer(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value)
  return rounded < min || rounded > max ? null : rounded
}

/** 1990 → 2100 : une date hors de cette plage est une donnée fabriquée, pas un signet. */
const DATE_MIN = Date.UTC(1990, 0, 1)
const DATE_MAX = Date.UTC(2100, 0, 1)

function date(value: unknown): number | null {
  const ms =
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(ms) && ms >= DATE_MIN && ms <= DATE_MAX ? Math.round(ms) : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function list(value: unknown, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : []
}

/* ------------------------------------------------------------------ export */

export interface WriteOptions {
  includeRaw: boolean
  appVersion: string
  /** Appelé entre deux tranches, avec l'avancement en posts. */
  progress?: (done: number, total: number) => void
  shouldStop?: () => boolean
}

export interface WriteResult {
  posts: number
  collections: number
  tags: number
  bytes: number
}

/** Posts lus et écrits par tranche. Assez pour amortir les requêtes, assez peu pour respirer. */
const EXPORT_PAGE = 500

interface PostRow {
  rid: number
  id: string
  platform: string
  native_id: string
  url: string
  author_handle: string | null
  author_name: string | null
  author_avatar: string | null
  text: string | null
  transcript: string | null
  kind: string
  media_count: number
  width: number | null
  height: number | null
  published_at: number | null
  saved_at: number | null
  discovered_at: number
  saved_rank: number | null
  is_favorite: number
  is_archived: number
  is_demo: number
  label: string | null
  raw?: string | null
}

function groupBy<T extends { post_id: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const row of rows) {
    const bucket = out.get(row.post_id)
    if (bucket) bucket.push(row)
    else out.set(row.post_id, [row])
  }
  return out
}

function readCollections(db: Database.Database): FileCollection[] {
  const rows = db
    .prepare(
      `SELECT id, name, color, kind, query, target_size FROM collections
        ORDER BY name COLLATE NOCASE, id`
    )
    .all() as {
    id: number
    name: string
    color: string | null
    kind: string
    query: string | null
    target_size: number
  }[]
  const words = db.prepare(
    'SELECT word, weight FROM collection_keywords WHERE collection_id = ? ORDER BY sort_index, word'
  )
  const members = db
    .prepare('SELECT post_id FROM collection_posts WHERE collection_id = ? ORDER BY post_id')
    .pluck()
  const removed = db
    .prepare('SELECT post_id FROM collection_removals WHERE collection_id = ? ORDER BY post_id')
    .pluck()
  return rows.map((row) => {
    const kind = row.kind === 'query' ? 'query' : 'manual'
    return {
      name: row.name,
      color: LABELS.includes(row.color as LabelColor) ? (row.color as LabelColor) : null,
      kind,
      query: row.query,
      targetSize: row.target_size,
      keywords: words.all(row.id) as { word: string; weight: number }[],
      members: members.all(row.id) as string[],
      membersComputed: kind === 'query',
      removed: removed.all(row.id) as string[]
    }
  })
}

function readMapLabels(db: Database.Database): FileMapLabel[] {
  const rows = db
    .prepare('SELECT id, text, anchors, created_at FROM map_labels ORDER BY created_at, id')
    .all() as { id: string; text: string; anchors: string; created_at: number }[]
  return rows.flatMap((row) => {
    try {
      const anchors = JSON.parse(row.anchors) as unknown
      if (!Array.isArray(anchors)) return []
      return [
        {
          id: row.id,
          text: row.text,
          anchors: anchors.filter((anchor): anchor is string => typeof anchor === 'string'),
          createdAt: iso(row.created_at)
        }
      ]
    } catch {
      /* Une étiquette illisible en base le serait aussi à l'arrivée : on ne la transporte pas. */
      return []
    }
  })
}

/** Une tranche de posts, avec ce qui les accompagne, sous la forme du fichier. */
function readPostPage(
  db: Database.Database,
  after: number,
  includeRaw: boolean
): { posts: FilePost[]; last: number } {
  const rows = db
    .prepare(
      `SELECT rowid AS rid, id, platform, native_id, url, author_handle, author_name,
              author_avatar, text, transcript, kind, media_count, width, height,
              published_at, saved_at, discovered_at, saved_rank, is_favorite, is_archived,
              is_demo, label${includeRaw ? ', raw' : ''}
         FROM posts WHERE rowid > ? ORDER BY rowid LIMIT ${EXPORT_PAGE}`
    )
    .all(after) as PostRow[]
  if (rows.length === 0) return { posts: [], last: after }

  const ids = rows.map((row) => row.id)
  const slots = ids.map(() => '?').join(',')
  const sources = groupBy(
    db
      .prepare(
        `SELECT post_id, source, source_rank, source_at, discovered_at FROM post_sources
          WHERE post_id IN (${slots}) ORDER BY post_id, source`
      )
      .all(...ids) as {
      post_id: string
      source: ContentSource
      source_rank: number | null
      source_at: number | null
      discovered_at: number
    }[]
  )
  const media = groupBy(
    db
      .prepare(
        `SELECT post_id, idx, kind, remote_url, video_source, width, height FROM media
          WHERE post_id IN (${slots}) ORDER BY post_id, idx`
      )
      .all(...ids) as {
      post_id: string
      idx: number
      kind: string
      remote_url: string | null
      video_source: string | null
      width: number | null
      height: number | null
    }[]
  )
  const variants = groupBy(
    db
      .prepare(
        `SELECT post_id, idx, quality, source, width, height, bitrate FROM media_variants
          WHERE post_id IN (${slots}) ORDER BY post_id, idx, quality`
      )
      .all(...ids) as {
      post_id: string
      idx: number
      quality: VideoQuality
      source: string
      width: number | null
      height: number | null
      bitrate: number | null
    }[]
  )
  const tags = groupBy(
    db
      .prepare(
        `SELECT pt.post_id, t.name, pt.source FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
          WHERE pt.post_id IN (${slots}) ORDER BY pt.post_id, t.name COLLATE NOCASE`
      )
      .all(...ids) as { post_id: string; name: string; source: string }[]
  )

  const posts = rows.map((row): FilePost => {
    const ownVariants = variants.get(row.id) ?? []
    const post: FilePost = {
      id: row.id,
      platform: row.platform as Platform,
      nativeId: row.native_id,
      url: row.url,
      author: {
        handle: row.author_handle,
        name: row.author_name,
        avatar: webUrl(row.author_avatar)
      },
      text: row.text,
      transcript: row.transcript,
      kind: row.kind as PostKind,
      mediaCount: row.media_count,
      width: row.width,
      height: row.height,
      publishedAt: iso(row.published_at),
      savedAt: iso(row.saved_at),
      discoveredAt: iso(row.discovered_at),
      savedRank: row.saved_rank,
      sources: (sources.get(row.id) ?? []).map((source) => ({
        source: source.source,
        rank: source.source_rank,
        at: iso(source.source_at),
        discoveredAt: iso(source.discovered_at)
      })),
      media: (media.get(row.id) ?? []).map((item) => ({
        index: item.idx,
        kind: item.kind === 'video' ? 'video' : 'image',
        width: item.width,
        height: item.height,
        url: webUrl(item.remote_url),
        videoUrl: webUrl(item.video_source),
        variants: ownVariants
          .filter((variant) => variant.idx === item.idx && webUrl(variant.source))
          .map((variant) => ({
            quality: variant.quality,
            url: variant.source,
            width: variant.width,
            height: variant.height,
            bitrate: variant.bitrate
          }))
      })),
      tags: (tags.get(row.id) ?? []).map((tag) => ({
        name: tag.name,
        source: TAG_SOURCES.includes(tag.source as TagSource) ? (tag.source as TagSource) : 'user'
      })),
      favorite: row.is_favorite === 1,
      label: LABELS.includes(row.label as LabelColor) ? (row.label as LabelColor) : null,
      archived: row.is_archived === 1
    }
    if (row.is_demo === 1) post.demo = true
    if (includeRaw && row.raw) {
      try {
        post.raw = JSON.parse(row.raw)
      } catch {
        /* Un `raw` illisible en base n'apprendrait rien à personne à l'arrivée. */
      }
    }
    return post
  })
  return { posts, last: rows[rows.length - 1].rid }
}

/**
 * Écrit la bibliothèque dans `target`, tranche par tranche.
 *
 * **Jamais une seule chaîne.** Soixante mille posts font une centaine de mégaoctets de JSON :
 * les assembler en mémoire puis les écrire d'un coup figerait le processus principal le temps
 * de la sérialisation, et avec lui tout ce qui passe par lui — le protocole des vignettes, l'IPC,
 * la barre système. On lit cinq cents posts, on les écrit, on rend la main.
 *
 * Un post par ligne, et c'est délibéré : le fichier reste lisible par `grep` et diffable, et un
 * fichier tronqué se voit à l'œil. Il reste un JSON ordinaire — l'import ne suppose pas cette
 * mise en page, il lit n'importe quel JSON valide.
 *
 * L'écriture se fait à côté puis se renomme : un export interrompu ne laisse pas, à la place
 * d'un bon fichier, un fichier à moitié écrit portant le même nom.
 */
export async function writeLibraryFile(
  db: Database.Database,
  target: string,
  options: WriteOptions
): Promise<WriteResult> {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n
  /* Le vocabulaire, pour qui lit le fichier : l'import, lui, s'en tient aux tags des posts. */
  const tags = db
    .prepare(
      `SELECT t.name, COUNT(pt.post_id) AS count FROM tags t
         JOIN post_tags pt ON pt.tag_id = t.id
        GROUP BY t.id ORDER BY t.name COLLATE NOCASE, t.id`
    )
    .all() as { name: string; count: number }[]
  const collections = readCollections(db)
  const mapLabels = readMapLabels(db)

  const head =
    `{"format":${JSON.stringify(LIBRARY_FORMAT)},"version":${LIBRARY_VERSION},` +
    `"exportedAt":${JSON.stringify(new Date().toISOString())},` +
    `"app":${JSON.stringify({ name: 'Magpie', version: options.appVersion })},` +
    `"counts":${JSON.stringify({ posts: total, collections: collections.length, tags: tags.length, mapLabels: mapLabels.length })},` +
    `\n"tags":${block(tags)},\n"collections":${block(collections)},\n"mapLabels":${block(mapLabels)},\n"posts":[`

  const partial = `${target}.part`
  const file = await open(partial, 'w')
  let bytes = 0
  let written = 0
  const write = async (chunk: string): Promise<void> => {
    const buffer = Buffer.from(chunk, 'utf8')
    await file.write(buffer)
    bytes += buffer.byteLength
  }
  try {
    await write(head)
    options.progress?.(0, total)
    let after = 0
    for (;;) {
      if (options.shouldStop?.()) throw new LibraryTransferCancelled()
      const page = readPostPage(db, after, options.includeRaw)
      if (page.posts.length === 0) break
      after = page.last
      await write(`${written === 0 ? '\n' : ',\n'}${page.posts.map(line).join(',\n')}`)
      written += page.posts.length
      options.progress?.(written, total)
      await yieldToLoop()
    }
    await write('\n]}\n')
    await file.close()
    await rename(partial, target)
  } catch (error) {
    await file.close().catch(() => {})
    await rm(partial, { force: true }).catch(() => {})
    throw error
  }
  return { posts: written, collections: collections.length, tags: tags.length, bytes }
}

/**
 * Un élément sur une ligne, vraiment.
 *
 * `JSON.stringify` échappe `\n` mais laisse passer les séparateurs de ligne et de paragraphe
 * Unicode, valides en JSON — et que plusieurs éditeurs, eux, affichent comme des sauts de
 * ligne : une légende qui en contient coupait son post en deux à l'écran.
 */
function line(item: unknown): string {
  return JSON.stringify(item).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/** Un tableau, un élément par ligne : lisible, et `grep` y trouve une collection entière. */
function block(items: unknown[]): string {
  return items.length === 0 ? '[]' : `[\n${items.map(line).join(',\n')}\n]`
}

/* ------------------------------------------------------------------ lecture */

type ScanState =
  | 'start'
  | 'firstKey'
  | 'key'
  | 'colon'
  | 'value'
  | 'afterValue'
  | 'postsFirst'
  | 'postsNext'
  | 'postsAfter'
  | 'end'

const QUOTE = 34
const OPEN_OBJECT = 123
const CLOSE_OBJECT = 125
const OPEN_ARRAY = 91
const CLOSE_ARRAY = 93
const COMMA = 44
const COLON = 58

function isSpace(code: number): boolean {
  return code === 32 || code === 10 || code === 13 || code === 9 || code === 0xfeff
}

/**
 * Lit un fichier de bibliothèque morceau par morceau, et en rend les posts un à un.
 *
 * `JSON.parse` sur le fichier entier était la solution évidente, et la mauvaise : cent
 * mégaoctets analysés d'un bloc, c'est une à deux secondes de processus principal figé, puis
 * trois fois ce poids en objets gardés en mémoire jusqu'à la fin de l'import. Ici, seul le
 * tableau `posts` est découpé — chaque élément est isolé en suivant les chaînes et les
 * profondeurs, puis analysé seul ; les autres clés de premier niveau, petites, le sont d'un
 * bloc.
 *
 * Aucune mise en page n'est supposée : un fichier réindenté par un éditeur, reformaté par `jq`
 * ou aux clés réordonnées se lit pareil. `check:library-file` le vérifie avec des morceaux de
 * sept caractères, qui coupent les chaînes, les échappements et les caractères accentués.
 */
export class LibraryScanner {
  /** Les valeurs de premier niveau autres que `posts`, analysées. */
  readonly head: Record<string, unknown> = {}
  private state: ScanState = 'start'
  private key = ''
  private capturing: 'key' | 'value' | 'element' | null = null
  private pieces: string[] = []
  private captured = 0
  private headChars = 0
  private depth = 0
  private primitive = false
  private inString = false
  private escaped = false
  private offset = 0
  postsSeen = false

  /** Analyse un morceau ; rend les posts qu'il a complétés, dans l'ordre. */
  push(chunk: string): unknown[] {
    const out: unknown[] = []
    const n = chunk.length
    let start = this.capturing ? 0 : -1
    let i = 0
    /* -2 : pas encore cherchée ; -1 : plus aucune dans ce morceau. */
    let nextSlash = -2

    if (this.escaped && this.inString && n > 0) {
      this.escaped = false
      i = 1
    }

    const finish = (end: number): void => {
      const piece = chunk.slice(start, end)
      const raw = this.pieces.length > 0 ? this.pieces.join('') + piece : piece
      this.pieces = []
      this.captured = 0
      const what = this.capturing
      this.capturing = null
      start = -1
      let value: unknown
      try {
        value = JSON.parse(raw)
      } catch {
        throw new LibraryFileError('invalidJson', { at: this.offset + end })
      }
      if (what === 'key') {
        this.key = String(value)
        this.state = 'colon'
      } else if (what === 'value') {
        this.headChars += raw.length
        if (this.headChars > LIMITS.headChars) throw new LibraryFileError('tooLarge')
        this.head[this.key] = value
        this.state = 'afterValue'
      } else {
        out.push(value)
        this.state = 'postsAfter'
      }
    }

    const begin = (at: number, what: 'value' | 'element', code: number): void => {
      this.capturing = what
      start = at
      this.depth = 0
      this.primitive = code !== OPEN_OBJECT && code !== OPEN_ARRAY && code !== QUOTE
      if (code === QUOTE) this.inString = true
      else if (!this.primitive) this.depth = 1
    }

    while (i < n) {
      if (this.inString) {
        /* Le gros du fichier est fait de chaînes : on les traverse avec `indexOf`, en natif,
           plutôt que caractère par caractère.

           La position de la prochaine barre oblique inverse est **retenue**, pas recherchée à
           chaque chaîne. La rechercher à chaque fois parcourait le morceau jusqu'au bout pour
           chacune des dizaines de milliers de chaînes qu'il contient dès qu'il n'y en avait
           plus : mesuré sur soixante mille posts, trente secondes d'aperçu et des blocages de
           plus d'une seconde, pour un travail linéaire. */
        const quote = chunk.indexOf('"', i)
        if (nextSlash !== -1 && nextSlash < i) nextSlash = chunk.indexOf('\\', i)
        const slash = nextSlash
        if (quote < 0 && slash < 0) {
          i = n
          break
        }
        if (slash >= 0 && (quote < 0 || slash < quote)) {
          if (slash + 1 < n) i = slash + 2
          else {
            this.escaped = true
            i = n
          }
          continue
        }
        this.inString = false
        i = quote + 1
        if (this.capturing === 'key') finish(i)
        else if (this.capturing && this.depth === 0) finish(i)
        continue
      }

      const code = chunk.charCodeAt(i)

      if (this.capturing === 'value' || this.capturing === 'element') {
        if (this.primitive) {
          if (isSpace(code) || code === COMMA || code === CLOSE_OBJECT || code === CLOSE_ARRAY) {
            finish(i)
            continue
          }
          i += 1
          continue
        }
        if (code === QUOTE) this.inString = true
        else if (code === OPEN_OBJECT || code === OPEN_ARRAY) this.depth += 1
        else if (code === CLOSE_OBJECT || code === CLOSE_ARRAY) {
          this.depth -= 1
          if (this.depth === 0) {
            i += 1
            finish(i)
            continue
          }
        }
        i += 1
        continue
      }

      if (isSpace(code)) {
        i += 1
        continue
      }

      switch (this.state) {
        case 'start':
          if (code !== OPEN_OBJECT) throw new LibraryFileError('notMagpie')
          this.state = 'firstKey'
          i += 1
          break
        case 'firstKey':
        case 'key':
          if (code === QUOTE) {
            this.capturing = 'key'
            start = i
            this.inString = true
            i += 1
          } else if (code === CLOSE_OBJECT && this.state === 'firstKey') {
            this.state = 'end'
            i += 1
          } else throw new LibraryFileError('invalidJson', { at: this.offset + i })
          break
        case 'colon':
          if (code !== COLON) throw new LibraryFileError('invalidJson', { at: this.offset + i })
          this.state = 'value'
          i += 1
          break
        case 'value':
          if (this.key === 'posts') {
            if (code !== OPEN_ARRAY) throw new LibraryFileError('notMagpie')
            this.postsSeen = true
            this.state = 'postsFirst'
            i += 1
          } else {
            begin(i, 'value', code)
            i += 1
          }
          break
        case 'afterValue':
          if (code === COMMA) this.state = 'key'
          else if (code === CLOSE_OBJECT) this.state = 'end'
          else throw new LibraryFileError('invalidJson', { at: this.offset + i })
          i += 1
          break
        case 'postsFirst':
          if (code === CLOSE_ARRAY) {
            this.state = 'afterValue'
            i += 1
          } else {
            begin(i, 'element', code)
            i += 1
          }
          break
        case 'postsNext':
          if (code === CLOSE_ARRAY) throw new LibraryFileError('invalidJson', { at: this.offset + i })
          begin(i, 'element', code)
          i += 1
          break
        case 'postsAfter':
          if (code === COMMA) this.state = 'postsNext'
          else if (code === CLOSE_ARRAY) this.state = 'afterValue'
          else throw new LibraryFileError('invalidJson', { at: this.offset + i })
          i += 1
          break
        case 'end':
          throw new LibraryFileError('invalidJson', { at: this.offset + i })
      }
    }

    if (this.capturing && start >= 0) {
      const piece = chunk.slice(start)
      this.pieces.push(piece)
      this.captured += piece.length
      const limit = this.capturing === 'element' ? LIMITS.elementChars : LIMITS.headChars
      if (this.captured > limit) throw new LibraryFileError('tooLarge')
    }
    this.offset += n
    return out
  }

  /** Le fichier est fini : il doit l'être aussi pour l'analyse. */
  finish(): void {
    /* Un nombre en toute fin de fichier n'a pas de délimiteur après lui. */
    if (this.capturing && this.primitive && this.pieces.length > 0) this.push(' ')
    if (this.state !== 'end' || this.capturing || this.inString) {
      throw new LibraryFileError('invalidJson', { at: this.offset })
    }
  }
}

/** Ce qu'un fichier annonce de lui-même. */
export interface FileHead {
  exportedAt: number | null
  appVersion: string | null
  collections: FileCollection[]
  mapLabels: FileMapLabel[]
  declaredPosts: number | null
}

/**
 * Vérifie l'en-tête : c'est bien un export de Magpie, et d'un format qu'on sait lire.
 *
 * Un fichier d'un format plus récent est refusé plutôt que lu au mieux. Il peut porter un champ
 * dont le sens a changé, et un import approximatif dans la bibliothèque de quelqu'un est bien
 * pire qu'un message qui demande une mise à jour.
 */
export function readHead(head: Record<string, unknown>, strict = true): FileHead {
  if (strict || 'format' in head) {
    if (head.format !== LIBRARY_FORMAT) throw new LibraryFileError('notMagpie')
    const version = head.version
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      throw new LibraryFileError('notMagpie')
    }
    if (version > LIBRARY_VERSION) throw new LibraryFileError('newerVersion', { version })
  }
  const app = record(head.app)
  const counts = record(head.counts)
  return {
    exportedAt: date(head.exportedAt),
    appVersion: label(app?.version, 40),
    collections: validCollections(head.collections),
    mapLabels: list(head.mapLabels, LIMITS.mapLabels).flatMap((entry) => {
      const value = record(entry)
      const id = label(value?.id, 100)
      const words = text(value?.text, LIMITS.mapLabelText)
      if (!value || !id || !words?.trim()) return []
      const anchors = [
        ...new Set(
          list(value.anchors, LIMITS.anchors).filter(
            (anchor): anchor is string => typeof anchor === 'string' && anchor.length <= LIMITS.id
          )
        )
      ]
      return anchors.length > 0
        ? [{ id, text: words, anchors, createdAt: iso(date(value.createdAt)) }]
        : []
    }),
    declaredPosts: integer(counts?.posts, 0, LIMITS.posts)
  }
}

function validCollections(value: unknown): FileCollection[] {
  const seen = new Set<string>()
  const out: FileCollection[] = []
  for (const entry of list(value, LIMITS.collections)) {
    const collection = record(entry)
    const name = label(collection?.name, LIMITS.collectionName)
    if (!collection || !name) continue
    /* Deux collections homonymes à la casse près ne peuvent pas coexister en base (l'index est
       `NOCASE`) : la seconde rejoindrait la première, on la garde donc hors du fichier lu. */
    const key = tagKey(name)
    if (seen.has(key)) continue
    seen.add(key)
    const ids = (raw: unknown): string[] => [
      ...new Set(
        list(raw, LIMITS.members).filter(
          (id): id is string => typeof id === 'string' && id.length > 0 && id.length <= LIMITS.id
        )
      )
    ]
    const words = new Set<string>()
    const keywords: FileCollection['keywords'] = []
    for (const item of list(collection.keywords, LIMITS.keywords)) {
      const keyword = record(item)
      const word = label(keyword?.word, LIMITS.keyword)
      if (!word || words.has(word)) continue
      words.add(word)
      const weight =
        typeof keyword?.weight === 'number' && Number.isFinite(keyword.weight)
          ? Math.max(0, Math.min(3, keyword.weight))
          : 1
      keywords.push({ word, weight })
    }
    const kind = collection.kind === 'query' ? 'query' : 'manual'
    out.push({
      name,
      color: LABELS.includes(collection.color as LabelColor) ? (collection.color as LabelColor) : null,
      kind,
      query: label(collection.query, LIMITS.query),
      targetSize: integer(collection.targetSize, 10, 5000) ?? 300,
      keywords,
      members: ids(collection.members),
      membersComputed: kind === 'query' && collection.membersComputed !== false,
      removed: ids(collection.removed)
    })
  }
  return out
}

/**
 * Un post du fichier, vérifié champ par champ — ou `null` s'il n'est pas utilisable.
 *
 * Ce qui est facultatif et malformé est ramené à « absent » ; ce qui est indispensable et
 * malformé écarte le post entier. Un post sans adresse web ou dont l'identifiant ne correspond
 * pas à sa plateforme n'a pas de sens à l'écran, et l'insérer quand même produirait une carte
 * que rien ne peut ouvrir.
 */
export function validPost(value: unknown): FilePost | null {
  const post = record(value)
  if (!post) return null
  const platform = post.platform as Platform
  if (!PLATFORMS.includes(platform)) return null
  const nativeId = typeof post.nativeId === 'string' ? post.nativeId : null
  if (!nativeId || nativeId.length > LIMITS.nativeId || /[\s\u0000-\u001f]/.test(nativeId)) {
    return null
  }
  /* L'identifiant composite est la clé de toute la bibliothèque : il doit être exactement celui
     que l'adaptateur aurait produit, sans quoi le même post existerait deux fois après la
     prochaine synchronisation. */
  const id = `${platform}:${nativeId}`
  if (post.id !== undefined && post.id !== id) return null
  const url = webUrl(post.url)
  if (!url) return null
  const kind = post.kind as PostKind
  if (!POST_KINDS.includes(kind)) return null

  const author = record(post.author)
  const sources: FileSource[] = []
  for (const entry of list(post.sources, 4)) {
    const source = record(entry)
    if (!source || !CONTENT_SOURCES.includes(source.source as ContentSource)) continue
    if (sources.some((known) => known.source === source.source)) continue
    sources.push({
      source: source.source as ContentSource,
      rank: integer(source.rank, -1e12, 1e12),
      at: iso(date(source.at)),
      discoveredAt: iso(date(source.discoveredAt))
    })
  }

  const indexes = new Set<number>()
  const media: FileMedia[] = []
  for (const entry of list(post.media, LIMITS.media)) {
    const item = record(entry)
    const index = integer(item?.index, 0, LIMITS.media - 1)
    if (!item || index === null || indexes.has(index)) continue
    indexes.add(index)
    const qualities = new Set<string>()
    const variants: FileVariant[] = []
    for (const raw of list(item.variants, LIMITS.variants)) {
      const variant = record(raw)
      const quality = variant?.quality as VideoQuality
      const address = webUrl(variant?.url)
      if (!variant || !QUALITIES.includes(quality) || !address || qualities.has(quality)) continue
      qualities.add(quality)
      variants.push({
        quality,
        url: address,
        width: integer(variant.width, 1, 20_000),
        height: integer(variant.height, 1, 20_000),
        bitrate: integer(variant.bitrate, 1, 1e10)
      })
    }
    media.push({
      index,
      kind: item.kind === 'video' ? 'video' : 'image',
      width: integer(item.width, 1, 20_000),
      height: integer(item.height, 1, 20_000),
      url: webUrl(item.url),
      videoUrl: webUrl(item.videoUrl),
      variants
    })
  }
  media.sort((a, b) => a.index - b.index)

  const tagKeys = new Set<string>()
  const tags: FilePost['tags'] = []
  for (const entry of list(post.tags, LIMITS.tags)) {
    const tag = record(entry)
    const name = typeof tag?.name === 'string' ? normalizeTagName(tag.name) : ''
    if (!name || tagKeys.has(tagKey(name))) continue
    tagKeys.add(tagKey(name))
    tags.push({
      name,
      source: TAG_SOURCES.includes(tag?.source as TagSource) ? (tag?.source as TagSource) : 'user'
    })
  }

  let raw: unknown
  if (post.raw !== undefined && post.raw !== null) {
    const serialised = JSON.stringify(post.raw)
    if (serialised && serialised.length <= LIMITS.rawChars) raw = post.raw
  }

  const out: FilePost = {
    id,
    platform,
    nativeId,
    url,
    author: {
      handle: text(author?.handle, LIMITS.author),
      name: text(author?.name, LIMITS.author),
      avatar: webUrl(author?.avatar)
    },
    text: text(post.text, LIMITS.text),
    transcript: text(post.transcript, LIMITS.transcript),
    kind,
    mediaCount: Math.max(integer(post.mediaCount, 0, LIMITS.media) ?? 0, media.length === 0 ? 0 : media[media.length - 1].index + 1),
    width: integer(post.width, 1, 20_000),
    height: integer(post.height, 1, 20_000),
    publishedAt: iso(date(post.publishedAt)),
    savedAt: iso(date(post.savedAt)),
    discoveredAt: iso(date(post.discoveredAt)),
    savedRank: integer(post.savedRank, -1e12, 1e12),
    sources,
    media,
    tags,
    favorite: post.favorite === true,
    label: LABELS.includes(post.label as LabelColor) ? (post.label as LabelColor) : null,
    archived: post.archived === true
  }
  if (post.demo === true) out.demo = true
  if (raw !== undefined) out.raw = raw
  return out
}

/**
 * Lit le fichier et remet ses posts à `onPosts`, par paquets, en rendant la main entre deux.
 *
 * `onPosts` peut lever `LibraryTransferCancelled` : la lecture s'arrête alors proprement, le
 * flux refermé.
 */
export async function scanLibraryFile(
  path: string,
  onPosts: (posts: unknown[], head: Record<string, unknown>) => void | Promise<void>,
  options: { chunkBytes?: number; onBytes?: (read: number) => void } = {}
): Promise<Record<string, unknown>> {
  const scanner = new LibraryScanner()
  const stream = createReadStream(path, {
    encoding: 'utf8',
    highWaterMark: options.chunkBytes ?? 1024 * 1024
  })
  let read = 0
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      read += Buffer.byteLength(chunk, 'utf8')
      if (read > LIMITS.fileBytes) throw new LibraryFileError('tooLarge')
      const posts = scanner.push(chunk)
      if (posts.length > 0) await onPosts(posts, scanner.head)
      options.onBytes?.(read)
      await yieldToLoop()
    }
  } catch (error) {
    stream.destroy()
    /* Seules les pannes de lecture deviennent « illisible » : une erreur de la base, levée par
       `onPosts`, porte aussi un `code` — `SQLITE_…` — et doit remonter telle quelle. */
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) throw new LibraryFileError('unreadable')
    throw error
  }
  scanner.finish()
  if (!scanner.postsSeen) throw new LibraryFileError('notMagpie')
  return scanner.head
}

/* ------------------------------------------------------------------ aperçu */

export interface ImportPreviewCore {
  exportedAt: number | null
  appVersion: string | null
  posts: { total: number; fresh: number; existing: number; invalid: number }
  collections: { total: number; fresh: number; matched: number }
  tags: number
  mapLabels: number
}

/**
 * Ce que l'import ferait, sans rien écrire.
 *
 * Il faut le dire **avant** : importer ajoute des milliers de posts d'un geste, et la seule
 * question utile — « est-ce bien le bon fichier, et dans la bonne bibliothèque ? » — se pose
 * sur des nombres. Le fichier est lu en entier ; seuls les identifiants sont gardés, le temps
 * d'en demander l'existence à la base par paquets.
 */
export async function previewLibraryFile(
  db: Database.Database,
  path: string,
  options: { onPosts?: (seen: number, declared: number | null) => void; chunkBytes?: number } = {}
): Promise<ImportPreviewCore> {
  const seen = new Set<string>()
  const tagNames = new Set<string>()
  let fresh = 0
  let existing = 0
  let invalid = 0
  let pending: string[] = []
  const known = (ids: string[]): Set<string> => {
    const found = new Set<string>()
    for (let at = 0; at < ids.length; at += 500) {
      const slice = ids.slice(at, at + 500)
      const rows = db
        .prepare(`SELECT id FROM posts WHERE id IN (${slice.map(() => '?').join(',')})`)
        .pluck()
        .all(...slice) as string[]
      for (const id of rows) found.add(id)
    }
    return found
  }
  const flush = (): void => {
    const present = known(pending)
    existing += present.size
    fresh += pending.length - present.size
    pending = []
  }
  let declared: number | null = null
  let checkedHead = false

  const head = await scanLibraryFile(
    path,
    (posts, early) => {
      if (!checkedHead) {
        checkedHead = true
        /* L'en-tête précède les posts dans ce qu'écrit Magpie : un fichier qui n'en est pas un
           est refusé avant d'en lire le reste. Un fichier aux clés réordonnées est vérifié à la
           fin, ce qui ne coûte que du temps : l'aperçu n'écrit rien. */
        declared = readHead(early, false).declaredPosts
      }
      for (const value of posts) {
        const post = validPost(value)
        if (!post || seen.has(post.id) || seen.size >= LIMITS.posts) {
          invalid += 1
          continue
        }
        seen.add(post.id)
        for (const tag of post.tags) tagNames.add(tagKey(tag.name))
        pending.push(post.id)
      }
      if (pending.length >= 2000) flush()
      options.onPosts?.(seen.size + invalid, declared)
    },
    { chunkBytes: options.chunkBytes }
  )
  flush()
  const parsed = readHead(head)

  const byName = db.prepare('SELECT 1 FROM collections WHERE name = ? COLLATE NOCASE').pluck()
  const matched = parsed.collections.filter((collection) => byName.get(collection.name) === 1).length
  return {
    exportedAt: parsed.exportedAt,
    appVersion: parsed.appVersion,
    posts: { total: seen.size, fresh, existing, invalid },
    collections: {
      total: parsed.collections.length,
      fresh: parsed.collections.length - matched,
      matched
    },
    tags: tagNames.size,
    mapLabels: parsed.mapLabels.length
  }
}

/* ------------------------------------------------------------------ import */

/**
 * Ce qu'un paquet de l'import a réellement changé — et donc tout ce que l'annulation défait.
 *
 * Un import n'écrit que des **ajouts** : il ne supprime rien, ne remplace aucune valeur posée.
 * C'est ce qui rend son annulation exacte : retirer ce qui est listé ici rend la bibliothèque
 * d'avant, sans rien avoir eu à en copier.
 */
export interface ImportJournal {
  /** Posts insérés. Leur suppression emporte, en cascade, médias, origines, tags et appartenances. */
  posts: string[]
  /** Posts existants qu'il a enrichis, pour le compte rendu. */
  merged: string[]
  unchanged: number
  invalid: number
  sources: [string, ContentSource][]
  tagLinks: [string, string][]
  /** Tags créés : retirés à l'annulation s'il ne leur reste aucun post. */
  tags: string[]
  favourites: string[]
  labels: [string, LabelColor][]
  /** L'état d'avant — `null` pas encore écouté, `''` écouté sans rien — pour y revenir. */
  transcripts: [string, '' | null][]
  collections: number[]
  memberships: [number, string][]
  colours: [number, LabelColor][]
  mapLabels: string[]
}

export function emptyJournal(): ImportJournal {
  return {
    posts: [],
    merged: [],
    unchanged: 0,
    invalid: 0,
    sources: [],
    tagLinks: [],
    tags: [],
    favourites: [],
    labels: [],
    transcripts: [],
    collections: [],
    memberships: [],
    colours: [],
    mapLabels: []
  }
}

/** Le compte rendu d'un import, tiré de son journal : ce qui est écrit est ce qui est dit. */
export function summarise(
  entries: ImportJournal[],
  meta: { at: number; fileName: string; stopped: boolean }
): LibraryImportReport {
  const sum = (pick: (entry: ImportJournal) => number): number =>
    entries.reduce((total, entry) => total + pick(entry), 0)
  const created = new Set(entries.flatMap((entry) => entry.collections))
  const completed = new Set([
    ...entries.flatMap((entry) => entry.memberships.map(([id]) => id)),
    ...entries.flatMap((entry) => entry.colours.map(([id]) => id))
  ])
  for (const id of created) completed.delete(id)
  return {
    ...meta,
    postsAdded: sum((entry) => entry.posts.length),
    postsMerged: new Set(entries.flatMap((entry) => entry.merged)).size,
    postsUnchanged: sum((entry) => entry.unchanged),
    invalid: sum((entry) => entry.invalid),
    tagsLinked: sum((entry) => entry.tagLinks.length),
    favourites: sum((entry) => entry.favourites.length),
    labels: sum((entry) => entry.labels.length),
    transcripts: sum((entry) => entry.transcripts.length),
    sources: sum((entry) => entry.sources.length),
    collectionsCreated: created.size,
    collectionsCompleted: completed.size,
    memberships: sum((entry) => entry.memberships.length),
    mapLabels: sum((entry) => entry.mapLabels.length)
  }
}

export interface ImportHooks {
  /** Appelé après chaque paquet validé, avec le nombre de posts traités. */
  progress?: (done: number, declared: number | null) => void
  shouldStop?: () => boolean
  /** Chaque paquet, **après** sa transaction : le journal ne décrit que ce qui a eu lieu. */
  journal?: (entry: ImportJournal) => void | Promise<void>
  chunkBytes?: number
}

/** Posts par transaction. Une transaction par post serait lente ; une seule figerait tout. */
const IMPORT_BATCH = 250

/**
 * Verse le fichier dans la bibliothèque, sans rien y détruire.
 *
 * Un post nouveau entre avec ses origines, ses médias et ses tags ; ses vignettes se
 * construisent ensuite par la file ordinaire — l'appelant la relance. Un post déjà présent
 * garde tout ce qu'il a, et reçoit ce qui lui manque : les tags s'unissent, le favori tient si
 * l'un des deux l'a posé, une étiquette ou une transcription absente se comble, une étiquette
 * ou un retrait déjà posés restent tels quels. Le contenu venu de la plateforme — légende,
 * médias, adresse — n'est jamais remplacé par celui du fichier : la synchronisation locale est
 * plus fraîche que n'importe quel export.
 *
 * Importer deux fois le même fichier ne change rien la seconde fois : chaque écriture est
 * conditionnée à l'absence de ce qu'elle apporte. `check:library-file` le vérifie.
 */
export async function importLibraryFile(
  db: Database.Database,
  path: string,
  hooks: ImportHooks = {}
): Promise<{ journal: ImportJournal[]; stopped: boolean }> {
  const writer = new ImportWriter(db)
  const entries: ImportJournal[] = []
  const seen = new Set<string>()
  let queue: FilePost[] = []
  let invalid = 0
  let done = 0
  let declared: number | null = null
  let checkedHead = false
  let stopped = false

  const commit = async (batch: FilePost[], extraInvalid: number): Promise<void> => {
    const entry = db.transaction(() => writer.posts(batch))()
    entry.invalid = extraInvalid
    entries.push(entry)
    await hooks.journal?.(entry)
    done += batch.length + extraInvalid
    hooks.progress?.(done, declared)
    await yieldToLoop()
  }

  try {
    const head = await scanLibraryFile(
      path,
      async (values, early) => {
        if (!checkedHead) {
          checkedHead = true
          /* L'import ne se lance que sur un fichier dont l'aperçu est passé — `library-transfer`
             y veille, taille et date comprises. Ce contrôle n'est donc qu'un second filet. */
          declared = readHead(early, false).declaredPosts
        }
        for (const value of values) {
          const post = validPost(value)
          if (!post || seen.has(post.id) || seen.size >= LIMITS.posts) {
            invalid += 1
            continue
          }
          seen.add(post.id)
          queue.push(post)
          if (queue.length >= IMPORT_BATCH) {
            if (hooks.shouldStop?.()) throw new LibraryTransferCancelled()
            const batch = queue
            queue = []
            await commit(batch, invalid)
            invalid = 0
          }
        }
      },
      { chunkBytes: hooks.chunkBytes }
    )
    if (queue.length > 0 || invalid > 0) {
      if (hooks.shouldStop?.()) throw new LibraryTransferCancelled()
      await commit(queue, invalid)
      queue = []
    }
    const parsed = readHead(head)
    if (hooks.shouldStop?.()) throw new LibraryTransferCancelled()
    const entry = db.transaction(() => writer.rest(parsed))()
    entries.push(entry)
    await hooks.journal?.(entry)
  } catch (error) {
    if (!(error instanceof LibraryTransferCancelled)) throw error
    stopped = true
  }
  return { journal: entries, stopped }
}

/** Les écritures de l'import, compilées une fois. */
class ImportWriter {
  private readonly tagIds = new Map<string, number>()
  private readonly compiled = new Map<string, Database.Statement>()

  constructor(private readonly db: Database.Database) {}

  /* Une instruction compilée par texte, réutilisée d'un paquet à l'autre : `prepare` refait le
     plan à chaque appel, et un import en ferait sinon une douzaine par paquet. */
  private statements(sql: string): Database.Statement {
    let statement = this.compiled.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.compiled.set(sql, statement)
    }
    return statement
  }

  /** Le tag, créé au besoin. Rend son identifiant, et s'il vient d'être créé. */
  private tag(name: string, source: TagSource, journal: ImportJournal): number {
    const key = tagKey(name)
    const cached = this.tagIds.get(key)
    if (cached !== undefined) return cached
    const inserted = this.statements(
      'INSERT INTO tags (name, source) VALUES (?, ?) ON CONFLICT(name) DO NOTHING'
    ).run(name, source)
    if (inserted.changes > 0) journal.tags.push(name)
    const row = this.statements('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(name) as {
      id: number
    }
    this.tagIds.set(key, row.id)
    return row.id
  }

  posts(batch: FilePost[]): ImportJournal {
    const journal = emptyJournal()
    const now = Date.now()
    const find = this.statements(
      'SELECT is_favorite, label, transcript FROM posts WHERE id = ?'
    )
    const insertPost = this.statements(`
      INSERT INTO posts (id, platform, native_id, url, author_handle, author_name,
                         author_name_folded, author_avatar,
                         text, transcript, kind, media_count, width, height, published_at,
                         saved_at, discovered_at, saved_rank, is_favorite, is_archived, is_demo,
                         label, tag_status, raw, updated_at)
      VALUES (@id, @platform, @native_id, @url, @author_handle, @author_name,
              @author_name_folded, @author_avatar,
              @text, @transcript, @kind, @media_count, @width, @height, @published_at,
              @saved_at, @discovered_at, @saved_rank, @is_favorite, @is_archived, @is_demo,
              @label, 'rules_only', @raw, @updated_at)`)
    const insertSource = this.statements(`
      INSERT INTO post_sources (post_id, source, source_rank, source_at, discovered_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(post_id, source) DO NOTHING`)
    const insertMedia = this.statements(`
      INSERT INTO media (post_id, idx, kind, remote_url, video_source, width, height)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(post_id, idx) DO NOTHING`)
    const insertVariant = this.statements(`
      INSERT INTO media_variants (post_id, idx, quality, source, width, height, bitrate)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(post_id, idx, quality) DO NOTHING`)
    const link = this.statements(`
      INSERT INTO post_tags (post_id, tag_id, source) VALUES (?, ?, ?)
      ON CONFLICT(post_id, tag_id) DO NOTHING`)
    const favourite = this.statements(
      'UPDATE posts SET is_favorite = 1, updated_at = ? WHERE id = ? AND is_favorite = 0'
    )
    const setLabel = this.statements(
      'UPDATE posts SET label = ?, updated_at = ? WHERE id = ? AND label IS NULL'
    )
    const setTranscript = this.statements(
      `UPDATE posts SET transcript = ? WHERE id = ? AND COALESCE(transcript, '') = ''`
    )

    for (const post of batch) {
      const local = find.get(post.id) as
        | { is_favorite: number; label: string | null; transcript: string | null }
        | undefined
      const ms = (value: string | null): number | null => (value === null ? null : Date.parse(value))

      if (!local) {
        /* Le rang et la date d'enregistrement du post suivent ceux de sa première origine,
           comme le fait la synchronisation. */
        const discovered = ms(post.discoveredAt) ?? now
        insertPost.run({
          id: post.id,
          platform: post.platform,
          native_id: post.nativeId,
          url: post.url,
          author_handle: post.author.handle,
          author_name: post.author.name,
          /* La recherche compare les noms d'auteur repliés d'avance (voir `searchClause`) : un
             post importé sans eux resterait introuvable par son auteur jusqu'au prochain
             démarrage, qui les rattrape. */
          author_name_folded: post.author.name ? fold(post.author.name) : null,
          author_avatar: post.author.avatar,
          text: post.text,
          transcript: post.transcript,
          kind: post.kind,
          media_count: post.mediaCount,
          width: post.width,
          height: post.height,
          published_at: ms(post.publishedAt),
          saved_at: ms(post.savedAt),
          discovered_at: discovered,
          saved_rank: post.savedRank,
          is_favorite: post.favorite ? 1 : 0,
          is_archived: post.archived ? 1 : 0,
          is_demo: post.demo ? 1 : 0,
          label: post.label,
          raw: post.raw === undefined ? null : JSON.stringify(post.raw),
          updated_at: now
        })
        journal.posts.push(post.id)
        /* « Tout post porte au moins une origine » : un fichier écrit à la main peut l'omettre,
           et un post sans origine serait invisible dans toutes les vues filtrées par origine. */
        const sources =
          post.sources.length > 0
            ? post.sources
            : [{ source: 'saved' as const, rank: post.savedRank, at: post.savedAt, discoveredAt: post.discoveredAt }]
        for (const source of sources) {
          insertSource.run(post.id, source.source, source.rank, ms(source.at), ms(source.discoveredAt) ?? discovered)
        }
        for (const item of post.media) {
          if (item.index >= post.mediaCount) continue
          insertMedia.run(post.id, item.index, item.kind, item.url, item.videoUrl, item.width, item.height)
          for (const variant of item.variants) {
            insertVariant.run(post.id, item.index, variant.quality, variant.url, variant.width, variant.height, variant.bitrate)
          }
        }
        for (const tag of post.tags) {
          link.run(post.id, this.tag(tag.name, tag.source, journal), tag.source)
        }
        continue
      }

      /* Un post déjà là : on n'ajoute que ce qui manque, et chaque ajout est noté. */
      let changed = false
      for (const source of post.sources) {
        const added = insertSource.run(post.id, source.source, source.rank, ms(source.at), ms(source.discoveredAt) ?? now)
        if (added.changes > 0) {
          journal.sources.push([post.id, source.source])
          changed = true
        }
      }
      for (const tag of post.tags) {
        const added = link.run(post.id, this.tag(tag.name, tag.source, journal), tag.source)
        if (added.changes > 0) {
          journal.tagLinks.push([post.id, tag.name])
          changed = true
        }
      }
      if (post.favorite && favourite.run(now, post.id).changes > 0) {
        journal.favourites.push(post.id)
        changed = true
      }
      if (post.label && setLabel.run(post.label, now, post.id).changes > 0) {
        journal.labels.push([post.id, post.label])
        changed = true
      }
      if (post.transcript && post.transcript.trim()) {
        const before = local.transcript === '' ? '' : null
        if (setTranscript.run(post.transcript, post.id).changes > 0) {
          journal.transcripts.push([post.id, before])
          changed = true
        }
      }
      if (changed) journal.merged.push(post.id)
      else journal.unchanged += 1
    }
    return journal
  }

  /** Collections et étiquettes de la carte : après les posts, qu'elles désignent. */
  rest(head: FileHead): ImportJournal {
    const journal = emptyJournal()
    const now = Date.now()
    const exists = this.statements('SELECT 1 FROM posts WHERE id = ?').pluck()
    const byName = this.statements(
      'SELECT id, kind, color FROM collections WHERE name = ? COLLATE NOCASE'
    )
    const create = this.statements(
      `INSERT INTO collections (name, color, kind, query, target_size, sort_index)
       VALUES (?, ?, ?, ?, ?, 0)`
    )
    const keyword = this.statements(
      `INSERT INTO collection_keywords (collection_id, word, weight, sort_index)
       VALUES (?, ?, ?, ?) ON CONFLICT(collection_id, word) DO NOTHING`
    )
    /* Un membre calculé reçoit un degré neutre plutôt que `NULL` : `NULL` veut dire « posé à la
       main », et ferait passer ces posts devant tous les autres sur la carte. */
    const member = this.statements(
      `INSERT INTO collection_posts (collection_id, post_id, added_at, degree)
       VALUES (?, ?, ?, ?) ON CONFLICT(collection_id, post_id) DO NOTHING`
    )
    const removal = this.statements(
      `INSERT INTO collection_removals (collection_id, post_id, removed_at)
       VALUES (?, ?, ?) ON CONFLICT(collection_id, post_id) DO NOTHING`
    )
    const colour = this.statements('UPDATE collections SET color = ? WHERE id = ? AND color IS NULL')

    for (const collection of head.collections) {
      const local = byName.get(collection.name) as
        | { id: number; kind: string; color: string | null }
        | undefined
      if (!local) {
        const id = Number(
          create.run(
            collection.name,
            collection.color,
            collection.kind,
            collection.query,
            collection.targetSize
          ).lastInsertRowid
        )
        journal.collections.push(id)
        /* Sans vecteur : il se calcule à la prochaine analyse. D'ici là, `recompute` garde
           l'appartenance importée plutôt que de la vider — voir `tagging/collections.ts`. */
        collection.keywords.forEach((word, order) => keyword.run(id, word.word, word.weight, order))
        for (const postId of collection.members) {
          if (exists.get(postId) === 1) {
            member.run(id, postId, now, collection.membersComputed ? 0 : null)
          }
        }
        for (const postId of collection.removed) {
          if (exists.get(postId) === 1) removal.run(id, postId, now)
        }
        continue
      }
      /* Une collection du même nom existe : elle garde sa définition. Une liste reçoit les
         membres de la liste homonyme ; une collection à mots-clés ne reçoit rien — ce qu'elle
         retient se calcule chez elle, et y épingler l'appartenance d'une autre bibliothèque la
         ferait mentir jusqu'au prochain recalcul. */
      if (collection.color && colour.run(collection.color, local.id).changes > 0) {
        journal.colours.push([local.id, collection.color])
      }
      if (local.kind === 'manual' && collection.kind === 'manual') {
        for (const postId of collection.members) {
          if (exists.get(postId) !== 1) continue
          if (member.run(local.id, postId, now, null).changes > 0) {
            journal.memberships.push([local.id, postId])
          }
        }
      }
    }

    const knownLabel = this.statements('SELECT 1 FROM map_labels WHERE id = ?').pluck()
    const insertLabel = this.statements(
      'INSERT INTO map_labels (id, text, anchors, created_at) VALUES (?, ?, ?, ?)'
    )
    for (const entry of head.mapLabels) {
      if (knownLabel.get(entry.id) === 1) continue
      insertLabel.run(entry.id, entry.text, JSON.stringify(entry.anchors), date(entry.createdAt) ?? now)
      journal.mapLabels.push(entry.id)
    }
    return journal
  }
}

/* ------------------------------------------------------------------ annulation */

export interface UndoCounts {
  postsRemoved: number
  collectionsRemoved: number
  reverted: number
}

/**
 * Défait un import à partir de son journal.
 *
 * Chaque retour arrière vérifie que la valeur est encore celle que l'import avait posée : un
 * favori ou une étiquette changés depuis appartiennent à l'utilisateur, pas à l'import, et ne
 * sont pas touchés. Les posts insérés, eux, repartent — avec ce qu'on leur a fait depuis, ce que
 * la confirmation annonce.
 */
export async function undoImport(
  db: Database.Database,
  entries: ImportJournal[],
  progress?: (done: number, total: number) => void
): Promise<UndoCounts> {
  const all = <T>(pick: (entry: ImportJournal) => T[]): T[] => entries.flatMap(pick)
  const posts = all((entry) => entry.posts)
  let reverted = 0
  let collectionsRemoved = 0

  db.transaction(() => {
    const dropMember = db.prepare('DELETE FROM collection_posts WHERE collection_id = ? AND post_id = ?')
    for (const [collectionId, postId] of all((entry) => entry.memberships)) {
      reverted += dropMember.run(collectionId, postId).changes
    }
    const dropCollection = db.prepare('DELETE FROM collections WHERE id = ?')
    for (const id of all((entry) => entry.collections)) {
      collectionsRemoved += dropCollection.run(id).changes
    }
    const uncolour = db.prepare('UPDATE collections SET color = NULL WHERE id = ? AND color = ?')
    for (const [id, colour] of all((entry) => entry.colours)) reverted += uncolour.run(id, colour).changes
    const unlabel = db.prepare('UPDATE posts SET label = NULL WHERE id = ? AND label = ?')
    for (const [id, value] of all((entry) => entry.labels)) reverted += unlabel.run(id, value).changes
    const unfavourite = db.prepare('UPDATE posts SET is_favorite = 0 WHERE id = ? AND is_favorite = 1')
    for (const id of all((entry) => entry.favourites)) reverted += unfavourite.run(id).changes
    const untranscribe = db.prepare('UPDATE posts SET transcript = ? WHERE id = ?')
    for (const [id, before] of all((entry) => entry.transcripts)) {
      reverted += untranscribe.run(before, id).changes
    }
    const unlink = db.prepare(
      `DELETE FROM post_tags WHERE post_id = ?
          AND tag_id = (SELECT id FROM tags WHERE name = ? COLLATE NOCASE)`
    )
    for (const [postId, name] of all((entry) => entry.tagLinks)) reverted += unlink.run(postId, name).changes
    const unsource = db.prepare(
      /* Jamais la dernière origine d'un post : un post sans origine disparaît de toutes les vues. */
      `DELETE FROM post_sources WHERE post_id = ? AND source = ?
          AND (SELECT COUNT(*) FROM post_sources WHERE post_id = ?) > 1`
    )
    for (const [postId, source] of all((entry) => entry.sources)) {
      reverted += unsource.run(postId, source, postId).changes
    }
    const unlabelMap = db.prepare('DELETE FROM map_labels WHERE id = ?')
    for (const id of all((entry) => entry.mapLabels)) reverted += unlabelMap.run(id).changes
  })()

  /* Les posts par paquets : leur suppression déclenche l'index plein texte et les cascades, et
     soixante mille d'un bloc figeraient la fenêtre. */
  let postsRemoved = 0
  const drop = db.prepare('DELETE FROM posts WHERE id = ?')
  for (let at = 0; at < posts.length; at += 500) {
    const slice = posts.slice(at, at + 500)
    db.transaction(() => {
      for (const id of slice) postsRemoved += drop.run(id).changes
    })()
    progress?.(Math.min(posts.length, at + slice.length), posts.length)
    await yieldToLoop()
  }

  const orphan = db.prepare(
    'DELETE FROM tags WHERE name = ? COLLATE NOCASE AND NOT EXISTS (SELECT 1 FROM post_tags WHERE tag_id = tags.id)'
  )
  db.transaction(() => {
    for (const name of all((entry) => entry.tags)) orphan.run(name)
  })()

  return { postsRemoved, collectionsRemoved, reverted }
}
