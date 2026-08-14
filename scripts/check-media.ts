import { parseByteRange } from '../src/main/media/range'
import { createRemoteMediaUrl, parseRemoteMediaUrl } from '../src/main/media/remote'

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

console.log('\nTout est vert.')
