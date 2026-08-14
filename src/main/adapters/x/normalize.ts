import type { PostKind } from '@shared/types'
import type { MediaInput, PostInput } from '../../db/queries'
import { readSettings } from '../../settings'
import type { VideoQuality } from '@shared/types'

/**
 * Normalisation de la timeline des signets de X.
 *
 * La réponse est profondément imbriquée et sa forme a changé plusieurs fois : les champs
 * sont donc lus défensivement, avec les emplacements successifs essayés dans l'ordre.
 * Un post qu'on ne sait pas lire est ignoré, jamais fatal — perdre une entrée vaut mieux
 * qu'interrompre un backfill de plusieurs milliers.
 */

interface XMediaEntity {
  type?: string
  media_url_https?: string
  original_info?: { width?: number; height?: number }
  video_info?: { variants?: { bitrate?: number; content_type?: string; url?: string }[] }
}

interface XTweetLegacy {
  id_str?: string
  full_text?: string
  created_at?: string
  entities?: { media?: XMediaEntity[] }
  extended_entities?: { media?: XMediaEntity[] }
}

interface XUser {
  legacy?: { screen_name?: string; name?: string }
  core?: { screen_name?: string; name?: string }
}

interface XTweet {
  __typename?: string
  rest_id?: string
  legacy?: XTweetLegacy
  tweet?: XTweet
  core?: { user_results?: { result?: XUser } }
  note_tweet?: { note_tweet_results?: { result?: { text?: string } } }
  quoted_status_result?: { result?: XTweet }
}

interface XEntry {
  entryId?: string
  content?: {
    entryType?: string
    itemContent?: {
      itemType?: string
      tweet_results?: { result?: XTweet }
    }
    cursorType?: string
    value?: string
  }
}

export interface XBookmarksResponse {
  data?: {
    bookmark_timeline_v2?: {
      timeline?: { instructions?: { type?: string; entries?: XEntry[] }[] }
    }
    [key: string]: unknown
  }
  errors?: { message?: string }[]
}

function timelineInstructions(value: unknown): { type?: string; entries?: XEntry[] }[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = timelineInstructions(item)
      if (found.length > 0) return found
    }
    return []
  }
  const object = value as Record<string, unknown>
  if (Array.isArray(object.instructions)) {
    return object.instructions as { type?: string; entries?: XEntry[] }[]
  }
  for (const child of Object.values(object)) {
    const found = timelineInstructions(child)
    if (found.length > 0) return found
  }
  return []
}

/** X enveloppe parfois le tweet dans un objet de visibilité ; on déballe. */
function unwrap(result?: XTweet): XTweet | null {
  if (!result) return null
  if (result.__typename === 'TweetWithVisibilityResults' && result.tweet) return result.tweet
  return result
}

function author(tweet: XTweet): { handle: string | null; name: string | null } {
  const user = tweet.core?.user_results?.result
  // L'ancien emplacement était `legacy`, le nouveau `core` — les deux circulent encore.
  const handle = user?.core?.screen_name ?? user?.legacy?.screen_name ?? null
  const name = user?.core?.name ?? user?.legacy?.name ?? null
  return { handle, name }
}

/**
 * Plafond de débit pour le clip mis en cache.
 *
 * X propose parfois des variantes en 4K. Les prendre remplirait le disque et ferait
 * expirer le téléchargement, pour un aperçu qui s'affiche dans une carte de 300 pixels.
 * On retient donc la meilleure variante sous le plafond, et la plus légère si toutes le
 * dépassent.
 */
function bestVideo(entity: XMediaEntity): string | null {
  const variants = (entity.video_info?.variants ?? []).filter(
    (v) => v.content_type === 'video/mp4' && v.url
  )
  if (variants.length === 0) return null

  const preference = readSettings().videoCacheQuality
  const maxBitrate =
    preference === '480p'
      ? 1_000_000
      : preference === '720p'
        ? 2_500_000
        : preference === '1080p'
          ? 5_000_000
          : Number.POSITIVE_INFINITY
  const affordable = variants.filter((v) => (v.bitrate ?? 0) <= maxBitrate)
  const pool = affordable.length > 0 ? affordable : variants
  const pick =
    affordable.length > 0
      ? pool.reduce((best, v) => ((v.bitrate ?? 0) > (best.bitrate ?? 0) ? v : best))
      : pool.reduce((best, v) => ((v.bitrate ?? Infinity) < (best.bitrate ?? Infinity) ? v : best))

  return pick.url ?? null
}

function qualityForBitrate(bitrate = 0): VideoQuality {
  if (bitrate <= 1_000_000) return '480p'
  if (bitrate <= 2_500_000) return '720p'
  if (bitrate <= 5_000_000) return '1080p'
  return 'source'
}

function videoVariants(entity: XMediaEntity): NonNullable<MediaInput['videoVariants']> {
  const grouped = new Map<VideoQuality, { bitrate?: number; url?: string }>()
  for (const variant of entity.video_info?.variants ?? []) {
    if (variant.content_type !== 'video/mp4' || !variant.url) continue
    const quality = qualityForBitrate(variant.bitrate)
    const current = grouped.get(quality)
    if (!current || (variant.bitrate ?? 0) > (current.bitrate ?? 0)) grouped.set(quality, variant)
  }
  return [...grouped.entries()].flatMap(([quality, variant]) =>
    variant.url ? [{ quality, source: variant.url, bitrate: variant.bitrate ?? null }] : []
  )
}

function kindOf(entities: XMediaEntity[]): PostKind {
  if (entities.length === 0) return 'text'
  if (entities.length > 1) return 'carousel'
  return entities[0].type === 'photo' ? 'image' : 'video'
}

export function normalizeBookmarks(
  response: XBookmarksResponse,
  startRank = 0
): { posts: PostInput[]; media: MediaInput[]; nextCursor: string | null } {
  const posts: PostInput[] = []
  const media: MediaInput[] = []
  let rank = startRank
  let nextCursor: string | null = null

  const instructions = timelineInstructions(response.data)

  for (const instruction of instructions) {
    for (const entry of instruction.entries ?? []) {
      const content = entry.content

      if (content?.entryType === 'TimelineTimelineCursor') {
        if (content.cursorType === 'Bottom' && content.value) nextCursor = content.value
        continue
      }

      const tweet = unwrap(content?.itemContent?.tweet_results?.result)
      const legacy = tweet?.legacy
      const id = legacy?.id_str ?? tweet?.rest_id
      if (!tweet || !id) continue

      const { handle, name } = author(tweet)
      let entities = legacy?.extended_entities?.media ?? legacy?.entities?.media ?? []

      /* Citation : sans elle, un « quote tweet » n'affiche que le commentaire, souvent
         une ligne, et perd tout ce qui lui donne son sens. On rattache donc le texte cité
         — et son média quand le tweet citant n'en a pas, ce qui est le cas le plus
         fréquent. */
      const quoted = unwrap(tweet.quoted_status_result?.result)
      let text = tweet.note_tweet?.note_tweet_results?.result?.text ?? legacy?.full_text ?? null

      if (quoted) {
        const quotedAuthor = author(quoted)
        const quotedText =
          quoted.note_tweet?.note_tweet_results?.result?.text ?? quoted.legacy?.full_text ?? ''
        const attribution = quotedAuthor.handle ? `@${quotedAuthor.handle}` : ''
        const block = [attribution, quotedText].filter(Boolean).join(' · ')
        if (block) text = [text, `“ ${block} ”`].filter(Boolean).join('\n\n')

        if (entities.length === 0) {
          entities =
            quoted.legacy?.extended_entities?.media ?? quoted.legacy?.entities?.media ?? []
        }
      }

      const postId = `x:${id}`

      posts.push({
        id: postId,
        platform: 'x',
        nativeId: id,
        url: `https://x.com/${handle ?? 'i'}/status/${id}`,
        authorHandle: handle ? `@${handle}` : null,
        authorName: name,
        // Les posts longs portent leur texte complet ailleurs que dans `full_text`, et
        // une citation y est rattachée juste au-dessus.
        text,
        kind: kindOf(entities),
        mediaCount: entities.length,
        publishedAt: legacy?.created_at ? Date.parse(legacy.created_at) || null : null,
        // Comme Instagram, X n'expose pas la date de mise en signet : seul l'ordre du flux
        // porte l'information, d'où le rang.
        savedAt: null,
        savedRank: rank++,
        raw: tweet
      })

      entities.forEach((entity, idx) => {
        const video = bestVideo(entity)
        if (!entity.media_url_https && !video) return
        media.push({
          postId,
          idx,
          kind: video ? 'video' : 'image',
          // Même pour une vidéo, `media_url_https` est l'affiche : c'est elle qu'on
          // transforme en vignette.
          remoteUrl: entity.media_url_https ?? null,
          videoSource: video,
          videoVariants: videoVariants(entity)
        })
      })
    }
  }

  return { posts, media, nextCursor }
}
