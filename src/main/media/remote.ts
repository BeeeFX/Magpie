import type { PlaybackQuality } from '@shared/types'
import { playbackMediaSource, upsertPosts, type PlaybackMediaSource } from '../db/queries'
import { ADAPTERS } from '../sync/engine'
import { isMediaUrlExpired } from './freshness'

export interface RemoteMediaRequest {
  postId: string
  mediaIndex: number
  kind: 'image' | 'video'
  quality: PlaybackQuality
}

const QUALITIES: PlaybackQuality[] = ['auto', '480p', '720p', '1080p', 'source']

/**
 * Résout un média en renouvelant son lien si celui-ci a expiré.
 *
 * Instagram signe ses URLs pour quelques jours seulement. Celles enregistrées à la
 * synchronisation cessent donc de fonctionner, et l'utilisateur voyait « impossible de
 * diffuser » sur une vidéo dont la page, elle, s'ouvre parfaitement — puisque la page
 * regénère un lien à chaque affichage. On fait désormais la même chose : on redemande le
 * post, on réenregistre ses liens, et la lecture part sur un lien valide.
 *
 * Les requêtes concurrentes pour un même post partagent le même renouvellement : ouvrir
 * une vidéo déclenche plusieurs résolutions, il n'y a aucune raison de solliciter la
 * plateforme plusieurs fois.
 */
const refreshing = new Map<string, Promise<void>>()

export async function resolveFreshMedia(
  request: RemoteMediaRequest
): Promise<PlaybackMediaSource | null> {
  const { postId, mediaIndex, kind, quality } = request
  const media = playbackMediaSource(postId, mediaIndex, kind, quality)
  if (!media?.source || !isMediaUrlExpired(media.source)) return media

  const adapter = ADAPTERS[media.platform]
  if (!adapter.refreshPost) return media

  const nativeId = postId.slice(postId.indexOf(':') + 1)
  let pending = refreshing.get(postId)
  if (!pending) {
    pending = (async () => {
      const fresh = await adapter.refreshPost!(nativeId)
      if (fresh.posts.length > 0) upsertPosts(fresh.posts, fresh.media)
    })()
      .catch((error: unknown) => {
        // Un renouvellement raté laisse simplement l'ancien lien tenter sa chance : le
        // lecteur affichera son erreur habituelle plutôt qu'un écran vide.
        console.warn(`[magpie] Lien média non renouvelé pour ${postId}`, error)
      })
      .finally(() => refreshing.delete(postId))
    refreshing.set(postId, pending)
  }
  await pending

  return playbackMediaSource(postId, mediaIndex, kind, quality) ?? media
}

export function createRemoteMediaUrl(request: RemoteMediaRequest): string {
  const params = new URLSearchParams({
    post: request.postId,
    index: String(request.mediaIndex),
    kind: request.kind,
    quality: request.quality
  })
  return `magpie://remote/media?${params.toString()}`
}

export function parseRemoteMediaUrl(rawUrl: string): RemoteMediaRequest | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'magpie:' || url.host !== 'remote' || url.pathname !== '/media') return null

  const postId = url.searchParams.get('post') ?? ''
  const mediaIndex = Number(url.searchParams.get('index'))
  const kind = url.searchParams.get('kind')
  const quality = url.searchParams.get('quality') as PlaybackQuality | null
  if (
    postId.length === 0 ||
    postId.length > 300 ||
    !Number.isInteger(mediaIndex) ||
    mediaIndex < 0 ||
    (kind !== 'image' && kind !== 'video') ||
    !quality ||
    !QUALITIES.includes(quality)
  ) {
    return null
  }
  return { postId, mediaIndex, kind, quality }
}
