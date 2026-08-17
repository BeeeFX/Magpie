import type { VideoQuality } from '@shared/types'

/**
 * Ordres de grandeur mesurés sur une bibliothèque réelle.
 *
 * Ils ne servent qu'à faire sentir l'écart entre deux actions avant de les lancer : annoncer
 * « 5 Mo » ou « 14 Go » ne conduit pas à la même décision. Une estimation grossière et honnête
 * vaut mieux qu'un compteur exact obtenu en interrogeant la base à chaque ouverture de menu.
 */
export const THUMBNAIL_BYTES = 40 * 1024

export const CLIP_BYTES: Record<VideoQuality, number> = {
  '480p': 3 * 1024 * 1024,
  '720p': 7 * 1024 * 1024,
  '1080p': 14 * 1024 * 1024,
  source: 20 * 1024 * 1024
}
