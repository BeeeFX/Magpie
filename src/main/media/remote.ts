import type { PlaybackQuality } from '@shared/types'
import {
  playbackMediaSource,
  readAccount,
  refreshPostMedia,
  thumbnailLinksForPosts,
  writeAccount,
  type PlaybackMediaSource
} from '../db/queries'
import { ADAPTERS, syncEngine } from '../sync/engine'
import { isMediaUrlExpired } from './freshness'
import { LinkRefresher } from './links'

export interface RemoteMediaRequest {
  postId: string
  mediaIndex: number
  kind: 'image' | 'video'
  quality: PlaybackQuality
}

const QUALITIES: PlaybackQuality[] = ['auto', '480p', '720p', '1080p', 'source']

/**
 * Le registre des renouvellements, branché sur les vrais adaptateurs. Voir `links.ts`.
 *
 * La pause reprend celle du moteur de synchronisation pour Instagram — la plateforme la plus
 * prompte à réagir, et la seule dont les liens périment.
 */
export const linkRefresher = new LinkRefresher({
  fetch: async (platform, nativeId) => {
    const adapter = ADAPTERS[platform]
    return adapter.refreshPost ? adapter.refreshPost(nativeId) : null
  },
  available: async (platform) =>
    Boolean(ADAPTERS[platform].refreshPost) && (await ADAPTERS[platform].isConnected()),
  accountStatus: (platform) => readAccount(platform)?.lastSyncStatus ?? null,
  syncing: (platform) => syncEngine.isRunning(platform),
  thumbnailLinks: thumbnailLinksForPosts,
  save: (fresh) => {
    refreshPostMedia(fresh.posts, fresh.media)
  },
  markChallenge: (platform) => writeAccount(platform, { lastSyncStatus: 'challenge' }),
  pause: () => new Promise((resolve) => setTimeout(resolve, 2500 + Math.random() * 2500)),
  now: () => Date.now()
})

/**
 * Résout un média en renouvelant son lien si celui-ci a expiré.
 *
 * Instagram signe ses URLs pour quelques jours seulement. Celles enregistrées à la
 * synchronisation cessent donc de fonctionner, et l'utilisateur voyait « impossible de
 * diffuser » sur une vidéo dont la page, elle, s'ouvre parfaitement — puisque la page
 * regénère un lien à chaque affichage. On fait désormais la même chose : on redemande le
 * post, on réenregistre ses liens, et la lecture part sur un lien valide.
 *
 * Le renouvellement passe par `linkRefresher` : les requêtes concurrentes pour un même post le
 * partagent, un échec n'est pas rejoué à chaque requête par plage du lecteur, et rien ne part
 * vers un compte en vérification de sécurité. Un renouvellement raté laisse simplement l'ancien
 * lien tenter sa chance : le lecteur affichera son erreur habituelle plutôt qu'un écran vide.
 */
export async function resolveFreshMedia(
  request: RemoteMediaRequest
): Promise<PlaybackMediaSource | null> {
  const { postId, mediaIndex, kind, quality } = request
  const media = playbackMediaSource(postId, mediaIndex, kind, quality)
  if (!media?.source || !isMediaUrlExpired(media.source)) return media

  if (!(await linkRefresher.refreshNow(postId))) return media
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
