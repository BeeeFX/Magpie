import type { VideoQuality } from '../src/shared/types'
import { parseByteRange } from '../src/main/media/range'
import { createRemoteMediaUrl, parseRemoteMediaUrl } from '../src/main/media/remote'
import { resolvePreferredQuality } from '../src/shared/quality'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Échec : ${message}`)
  console.log(`  ✓ ${message}`)
}

console.log('Vérification du streaming vidéo')

assert(parseByteRange(null, 1000) === undefined, 'une lecture normale sert le fichier complet')
assert(
  JSON.stringify(parseByteRange('bytes=100-199', 1000)) === JSON.stringify({ start: 100, end: 199 }),
  'une plage fermée est conservée'
)
assert(
  JSON.stringify(parseByteRange('bytes=900-', 1000)) === JSON.stringify({ start: 900, end: 999 }),
  'une plage ouverte va jusqu’à la fin'
)
assert(
  JSON.stringify(parseByteRange('bytes=-100', 1000)) === JSON.stringify({ start: 900, end: 999 }),
  'une plage suffixe sert les derniers octets'
)
assert(parseByteRange('bytes=1000-', 1000) === null, 'une plage hors fichier est refusée')
assert(parseByteRange('bytes=0-10,20-30', 1000) === null, 'les plages multiples sont refusées')

const remoteRequest = { postId: 'x:post/42', mediaIndex: 3, kind: 'video' as const, quality: '720p' as const }
assert(
  JSON.stringify(parseRemoteMediaUrl(createRemoteMediaUrl(remoteRequest))) === JSON.stringify(remoteRequest),
  'une URL de streaming conserve exactement le média et la qualité'
)
assert(
  parseRemoteMediaUrl('magpie://remote/media?post=x&index=-1&kind=video&quality=720p') === null,
  'une URL de streaming invalide est refusée'
)

/*
 * Qualité de lecture préférée. Les plateformes ne servent que ce qu'elles ont : « source »
 * n'est étiquetée qu'au-delà de 1080p, donc presque jamais. Exiger la correspondance exacte
 * faisait silencieusement retomber le réglage sur « Auto ».
 */
console.log('\nQualité de lecture préférée')
const near = (preference: Parameters<typeof resolvePreferredQuality>[0], available: VideoQuality[]) =>
  resolvePreferredQuality(preference, available)

assert(near('auto', ['480p', '720p']) === 'auto', '« Auto » reste « Auto »')
assert(near('720p', ['480p', '720p']) === '720p', 'une définition disponible est respectée')
assert(
  near('source', ['480p', '720p']) === '720p',
  '« Source » prend la meilleure définition réellement offerte'
)
assert(
  near('1080p', ['480p', '720p']) === '720p',
  'une définition absente redescend d’un cran plutôt que d’abandonner'
)
assert(
  near('480p', ['720p', '1080p']) === '720p',
  'sous le plafond demandé, la plus modeste disponible est servie'
)
assert(near('source', ['source']) === 'source', 'une vraie source est reconnue')
assert(near('720p', []) === 'auto', 'sans aucune variante, on laisse le lecteur décider')
assert(
  near('source', ['1080p', '480p', '720p']) === '1080p',
  'l’ordre de la liste reçue n’influence pas le choix'
)

console.log('\nTout est vert.')
