import type { PostKind } from '@shared/types'
import type { MediaInput, PostInput } from '../../db/queries'
import { readSettings } from '../../settings'
import type { VideoQuality } from '@shared/types'

/**
 * Normalisation d'une réponse `/api/v1/feed/saved/posts/`.
 *
 * Écrit contre la forme réelle de l'API, alimenté en M0 par une fixture figée : c'est
 * volontaire. Quand l'adaptateur réel arrivera en M1, ce fichier ne bougera pas.
 */

/** Les seuls champs qu'on lit. Le reste du payload part dans `raw`. */
interface IgCandidate {
  url: string
  width: number
  height: number
}

interface IgMediaNode {
  pk?: string | number
  media_type?: number
  image_versions2?: { candidates?: IgCandidate[] }
  video_versions?: { url: string; width?: number; height?: number }[]
}

interface IgMedia extends IgMediaNode {
  id?: string
  code?: string
  taken_at?: number
  caption?: { text?: string } | null
  user?: { username?: string; full_name?: string }
  carousel_media?: IgMediaNode[]
  carousel_media_count?: number
}

export interface IgSavedResponse {
  items?: { media?: IgMedia }[]
  more_available?: boolean
  next_max_id?: string | null
}

const MEDIA_TYPE_IMAGE = 1
const MEDIA_TYPE_VIDEO = 2
const MEDIA_TYPE_CAROUSEL = 8

/**
 * Instagram renvoie plusieurs tailles ; on prend la plus grande sous le plafond, parce
 * qu'au-delà de 1080 on paie de la bande passante pour une vignette qu'on réduit à 640.
 */
function bestCandidate(node: IgMediaNode, maxWidth = 1080): IgCandidate | null {
  const candidates = node.image_versions2?.candidates ?? []
  if (candidates.length === 0) return null
  const eligible = candidates.filter((c) => c.width <= maxWidth)
  const pool = eligible.length > 0 ? eligible : candidates
  return pool.reduce((best, c) => (c.width > best.width ? c : best))
}

/**
 * Variante vidéo la plus proche de 720 p sans la dépasser.
 *
 * Instagram sert plusieurs définitions ; prendre la première revient souvent à prendre la
 * plus lourde, pour un clip qu'on ne montre qu'en aperçu. On plafonne donc, en retombant
 * sur la plus petite disponible si toutes dépassent.
 */
function bestVideoVersion(node: IgMediaNode): { url: string; width?: number } | undefined {
  const versions = node.video_versions ?? []
  if (versions.length === 0) return undefined

  const preference = readSettings().videoCacheQuality
  if (preference === 'source') {
    return versions.reduce((best, v) => ((v.width ?? 0) > (best.width ?? 0) ? v : best))
  }
  const maxWidth = preference === '480p' ? 854 : preference === '1080p' ? 1920 : 1280

  const affordable = versions.filter((v) => (v.width ?? 0) <= maxWidth)
  if (affordable.length > 0) {
    return affordable.reduce((best, v) => ((v.width ?? 0) > (best.width ?? 0) ? v : best))
  }
  return versions.reduce((best, v) => ((v.width ?? Infinity) < (best.width ?? Infinity) ? v : best))
}

function qualityForWidth(width = 0): VideoQuality {
  if (width <= 854) return '480p'
  if (width <= 1280) return '720p'
  if (width <= 1920) return '1080p'
  return 'source'
}

function videoVariants(node: IgMediaNode): NonNullable<MediaInput['videoVariants']> {
  const grouped = new Map<VideoQuality, NonNullable<IgMediaNode['video_versions']>[number]>()
  for (const version of node.video_versions ?? []) {
    const quality = qualityForWidth(version.width)
    const current = grouped.get(quality)
    if (!current || (version.width ?? 0) > (current.width ?? 0)) grouped.set(quality, version)
  }
  return [...grouped.entries()].map(([quality, version]) => ({
    quality,
    source: version.url,
    width: version.width ?? null,
    height: version.height ?? null
  }))
}

function kindOf(media: IgMedia): PostKind {
  switch (media.media_type) {
    case MEDIA_TYPE_VIDEO:
      return 'video'
    case MEDIA_TYPE_CAROUSEL:
      return 'carousel'
    case MEDIA_TYPE_IMAGE:
    default:
      return 'image'
  }
}

function canonicalUrl(media: IgMedia): string {
  const code = media.code ?? media.pk ?? ''
  // Les reels vivent sous /reel/ ; ouvrir un reel via /p/ redirige, mais autant émettre
  // l'URL exacte — c'est elle qu'on copie et qu'on envoie à Nitrate.
  const path = media.media_type === MEDIA_TYPE_VIDEO ? 'reel' : 'p'
  return `https://www.instagram.com/${path}/${code}/`
}

export function normalizeSavedFeed(
  response: IgSavedResponse,
  startRank = 0
): { posts: PostInput[]; media: MediaInput[] } {
  const posts: PostInput[] = []
  const media: MediaInput[] = []
  let rank = startRank

  for (const item of response.items ?? []) {
    const node = item.media
    if (!node) continue

    const nativeId = String(node.pk ?? node.id ?? '')
    if (!nativeId) continue

    const kind = kindOf(node)
    const children = kind === 'carousel' ? (node.carousel_media ?? []) : [node]

    posts.push({
      id: `instagram:${nativeId}`,
      platform: 'instagram',
      nativeId,
      url: canonicalUrl(node),
      authorHandle: node.user?.username ?? null,
      authorName: node.user?.full_name ?? null,
      text: node.caption?.text ?? null,
      kind,
      mediaCount: children.length,
      publishedAt: node.taken_at ? node.taken_at * 1000 : null,
      // ⚠️ Instagram n'expose pas la date de sauvegarde — voir SPEC.md §5.1. On ne garde
      // que le rang dans le flux, qui est rendu dans l'ordre inverse de sauvegarde.
      savedAt: null,
      savedRank: rank++,
      raw: node
    })

    children.forEach((child, idx) => {
      const candidate = bestCandidate(child)
      if (!candidate) return
      // Un carrousel peut mélanger images et vidéos : le type se décide par média, pas
      // par post. `image_versions2` sert alors d'affiche au clip.
      const video = bestVideoVersion(child)
      media.push({
        postId: `instagram:${nativeId}`,
        idx,
        kind: video ? 'video' : 'image',
        remoteUrl: candidate.url,
        videoSource: video?.url ?? null,
        videoVariants: videoVariants(child)
      })
    })
  }

  return { posts, media }
}
