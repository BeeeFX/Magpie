import type { BrowserWindow } from 'electron'
import type { PostKind, VideoQuality } from '@shared/types'
import { getJson } from '../http'
import { disconnect, isConnected, openLogin } from '../session'
import type { MediaInput, PostInput } from '../../db/queries'
import type { NormalizedPage, PlatformAdapter } from '../types'

const ORIGIN = 'https://www.reddit.com'

interface RedditImageSource {
  url?: string
  width?: number
  height?: number
}

interface RedditVideo {
  fallback_url?: string
  width?: number
  height?: number
  bitrate_kbps?: number
  dash_url?: string
  hls_url?: string
}

interface RedditMediaMetadata {
  e?: string
  status?: string
  s?: { u?: string; mp4?: string; gif?: string; x?: number; y?: number }
  p?: { u?: string; x?: number; y?: number }[]
}

interface RedditThing {
  id?: string
  name?: string
  author?: string
  subreddit?: string
  permalink?: string
  title?: string
  selftext?: string
  body?: string
  url?: string
  url_overridden_by_dest?: string
  thumbnail?: string
  created_utc?: number
  is_video?: boolean
  is_gallery?: boolean
  post_hint?: string
  link_title?: string
  link_permalink?: string
  preview?: {
    images?: {
      source?: RedditImageSource
      variants?: {
        gif?: { source?: RedditImageSource }
        mp4?: { source?: RedditImageSource }
      }
    }[]
    reddit_video_preview?: RedditVideo
  }
  media?: {
    reddit_video?: RedditVideo
    oembed?: { thumbnail_url?: string; html?: string }
  }
  secure_media?: {
    reddit_video?: RedditVideo
    oembed?: { thumbnail_url?: string; html?: string }
  }
  gallery_data?: { items?: { media_id?: string; id?: number }[] }
  media_metadata?: Record<string, RedditMediaMetadata>
  crosspost_parent_list?: RedditThing[]
}

interface RedditListing {
  data?: {
    after?: string | null
    children?: { kind?: string; data?: RedditThing }[]
  }
}

function webUrl(value?: string | null): string | null {
  if (!value || !/^https?:\/\//i.test(value)) return null
  return value.replace(/&amp;/g, '&')
}

function directImage(thing: RedditThing): string | null {
  const value = webUrl(thing.url_overridden_by_dest ?? thing.url)
  return value && /\.(?:avif|gif|jpe?g|png|webp)(?:\?|$)/i.test(value) ? value : null
}

function redditQuality(video: RedditVideo | undefined): VideoQuality {
  const width = video?.width ?? 0
  if (width > 1920) return 'source'
  if (width > 1280) return '1080p'
  if (width > 854) return '720p'
  return '480p'
}

/**
 * Reddit répartit le média entre six formes de payload. Cette fonction les ramène toutes
 * à la même liste ordonnée, y compris les galeries et le contenu d'un crosspost.
 */
function mediaFor(postId: string, outer: RedditThing): MediaInput[] {
  const thing = outer.crosspost_parent_list?.[0] ?? outer
  const result: MediaInput[] = []

  for (const item of thing.gallery_data?.items ?? []) {
    if (!item.media_id) continue
    const meta = thing.media_metadata?.[item.media_id]
    if (!meta || meta.status === 'failed') continue
    const video = webUrl(meta.s?.mp4 ?? meta.s?.gif)
    const image = webUrl(meta.s?.u ?? meta.p?.at(-1)?.u)
    if (!image && !video) continue
    result.push({
      postId,
      idx: result.length,
      kind: video ? 'video' : 'image',
      remoteUrl: image,
      videoSource: video,
      videoVariants: video
        ? [
            {
              quality: redditQuality({ width: meta.s?.x, height: meta.s?.y }),
              source: video,
              width: meta.s?.x ?? null,
              height: meta.s?.y ?? null,
              bitrate: null
            }
          ]
        : []
    })
  }

  if (result.length > 0) return result

  const preview = thing.preview?.images?.[0]
  const redditVideo =
    thing.secure_media?.reddit_video ??
    thing.media?.reddit_video ??
    thing.preview?.reddit_video_preview
  const animatedPreview = webUrl(
    preview?.variants?.mp4?.source?.url ?? preview?.variants?.gif?.source?.url
  )
  // Le fallback MP4 de Reddit est souvent une piste vidéo muette. Le manifeste HLS
  // contient aussi l'audio ; le cache le remuxe localement avec ffmpeg.
  const video = webUrl(redditVideo?.hls_url) ?? webUrl(redditVideo?.fallback_url) ?? animatedPreview
  const image =
    webUrl(preview?.source?.url) ??
    webUrl(thing.secure_media?.oembed?.thumbnail_url) ??
    webUrl(thing.media?.oembed?.thumbnail_url) ??
    directImage(thing) ??
    (thing.thumbnail !== 'self' && thing.thumbnail !== 'default'
      ? webUrl(thing.thumbnail)
      : null)

  if (image || video) {
    result.push({
      postId,
      idx: 0,
      kind: video ? 'video' : 'image',
      remoteUrl: image,
      videoSource: video,
      videoVariants: video
        ? [
            {
              quality: redditQuality(redditVideo),
              source: webUrl(redditVideo?.fallback_url) ?? video,
              width: redditVideo?.width ?? null,
              height: redditVideo?.height ?? null,
              bitrate: redditVideo?.bitrate_kbps ? redditVideo.bitrate_kbps * 1000 : null
            }
          ]
        : []
    })
  }

  return result
}

function kindOf(thing: RedditThing, isComment: boolean, media: MediaInput[]): PostKind {
  if (isComment) return 'text'
  if (media.length > 1) return 'carousel'
  if (media[0]?.kind === 'video') return 'video'
  if (media[0]?.kind === 'image') return 'image'
  if (thing.url_overridden_by_dest || thing.url) return 'link'
  return 'text'
}

export const redditAdapter: PlatformAdapter = {
  platform: 'reddit',
  isConnected: () => isConnected('reddit'),
  connect: (parent?: BrowserWindow) => openLogin('reddit', parent),
  disconnect: () => disconnect('reddit'),

  async resolveHandle(): Promise<string | null> {
    const me = await getJson<{ data?: { name?: string } }>('reddit', `${ORIGIN}/api/me.json`, {
      referer: `${ORIGIN}/`
    })
    return me.data?.name ? `u/${me.data.name}` : null
  },

  async fetchPage(source, cursor: string | null, startRank: number): Promise<NormalizedPage> {
    const handle = await this.resolveHandle()
    const username = handle?.replace(/^u\//, '')
    if (!username) throw new Error("Nom d'utilisateur Reddit introuvable")

    const feed = source === 'liked' ? 'upvoted' : 'saved'
    const url = new URL(`${ORIGIN}/user/${username}/${feed}.json`)
    url.searchParams.set('limit', '100')
    url.searchParams.set('raw_json', '1')
    if (cursor) url.searchParams.set('after', cursor)

    const listing = await getJson<RedditListing>('reddit', url.toString(), {
      referer: `${ORIGIN}/`
    })

    const posts: PostInput[] = []
    const media: MediaInput[] = []
    let rank = startRank

    for (const child of listing.data?.children ?? []) {
      const thing = child.data
      if (!thing?.name) continue

      const isComment = child.kind === 't1'
      const id = `reddit:${thing.name}`
      const permalink = thing.permalink ?? thing.link_permalink ?? ''
      const postMedia = isComment ? [] : mediaFor(id, thing)

      posts.push({
        id,
        platform: 'reddit',
        nativeId: thing.name,
        url: permalink.startsWith('http') ? permalink : `${ORIGIN}${permalink}`,
        authorHandle: thing.author ? `u/${thing.author}` : null,
        authorName: thing.subreddit ? `r/${thing.subreddit}` : null,
        text: isComment
          ? [thing.link_title ? `↳ ${thing.link_title}` : null, thing.body]
              .filter(Boolean)
              .join('\n\n')
          : [thing.title, thing.selftext].filter(Boolean).join('\n\n'),
        kind: kindOf(thing, isComment, postMedia),
        mediaCount: postMedia.length,
        publishedAt: thing.created_utc ? thing.created_utc * 1000 : null,
        savedAt: null,
        savedRank: rank++,
        raw: thing
      })

      media.push(...postMedia)
    }

    const nextCursor = listing.data?.after ?? null
    return { posts, media, nextCursor, done: !nextCursor || posts.length === 0 }
  }
}
