import type { PlaybackQuality } from '@shared/types'

export interface RemoteMediaRequest {
  postId: string
  mediaIndex: number
  kind: 'image' | 'video'
  quality: PlaybackQuality
}

const QUALITIES: PlaybackQuality[] = ['auto', '480p', '720p', '1080p', 'source']

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
