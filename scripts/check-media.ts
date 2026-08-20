import type { VideoQuality } from '../src/shared/types'
import { parseByteRange } from '../src/main/media/range'
import { createRemoteMediaUrl, parseRemoteMediaUrl } from '../src/main/media/remote'
import { resolvePreferredQuality } from '../src/shared/quality'
import { isMediaUrlExpired, mediaUrlExpiry } from '../src/main/media/freshness'
import { mediaIdentity } from '../src/main/media/identity'

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

/*
 * Péremption des liens signés. Instagram inscrit la date d'expiration dans l'URL ; la lire
 * permet de renouveler avant d'essayer, plutôt que d'afficher une erreur sur une vidéo
 * dont la page, elle, s'ouvre parfaitement. La valeur ci-dessous vient d'un vrai lien.
 */
console.log('\nPéremption des liens média')
const REAL = 'https://scontent-lhr6-1.cdninstagram.com/o1/v/t2/f2/m86/x.mp4?_nc_cat=102&oe=6A842FFB'
assert(mediaUrlExpiry(REAL) === 0x6a842ffb * 1000, 'la date d’expiration est lue dans l’URL')
assert(
  isMediaUrlExpired(REAL, 0, 0x6a842ffb * 1000 + 1),
  'un lien dont la date est passée est déclaré périmé'
)
assert(
  !isMediaUrlExpired(REAL, 0, 0x6a842ffb * 1000 - 3_600_000),
  'une heure plus tôt, il est encore valide'
)
assert(
  isMediaUrlExpired(REAL, 120_000, 0x6a842ffb * 1000 - 60_000),
  'la marge évite de démarrer une lecture sur un lien qui expire dans la minute'
)
assert(
  mediaUrlExpiry('https://video.twimg.com/ext_tw_video/1/vid/avc1/1280x720/x.mp4?tag=12') === null,
  'une URL sans signature n’a pas de date'
)
assert(
  !isMediaUrlExpired('https://video.twimg.com/x.mp4?tag=12'),
  'et n’est donc jamais considérée périmée'
)
assert(mediaUrlExpiry('pas une url') === null, 'une URL illisible ne fait pas échouer la lecture')
assert(mediaUrlExpiry('https://e.test/x.mp4?oe=zzz') === null, 'une valeur non hexadécimale est ignorée')
assert(mediaUrlExpiry('https://e.test/x.mp4?oe=1') === null, 'une valeur aberrante est ignorée')

/*
 * Identité d'un média. Les paires ci-dessous viennent de la vraie bibliothèque : deux
 * signatures successives du même fichier, telles qu'Instagram les rend. Les prendre pour
 * deux médias différents est exactement ce qui vidait la bibliothèque de ses vignettes à
 * chaque page resynchronisée.
 */
console.log('\nIdentité d’un média')

const PHOTO_A =
  'https://scontent-lhr11-1.cdninstagram.com/v/t51.82787-15/760930005_18548507644073237_6911765959962523352_n.webp' +
  '?_nc_cat=100&ccb=7-5&_nc_sid=58cdad&_nc_ohc=6Fybaaz49hgQ7kNvwFG1FUv&_nc_ht=scontent-lhr11-1.cdninstagram.com' +
  '&_nc_gid=_yvq_LfOX-q5iSMOoRxSXA&oh=00_AQGPYAedkzUUPNw7ouROpxA1sGeEfFS-4JMXl0xNcaFy1g&oe=6A8D5E58'
const PHOTO_B =
  'https://scontent-lhr6-2.cdninstagram.com/v/t51.82787-15/760930005_18548507644073237_6911765959962523352_n.webp' +
  '?_nc_cat=109&ccb=7-5&_nc_sid=58cdad&_nc_ohc=3lcvXS3gU4AQ7kNvwH-r2kG&_nc_ht=scontent-lhr6-2.cdninstagram.com' +
  '&_nc_gid=9URpemhTieLHX4VhU0EFTg&oh=00_AQFwrBcObfE7qC03sSfh8VfpC8D20Jo3fA&oe=6A8D4F08'
const PHOTO_AUTRE =
  'https://scontent-lhr6-2.cdninstagram.com/v/t51.82787-15/761216429_18548507653073237_6344853643655705751_n.webp?_nc_cat=109'

assert(
  mediaIdentity(PHOTO_A) === mediaIdentity(PHOTO_B),
  'une photo resignée sur un autre hôte reste la même photo'
)
assert(
  mediaIdentity(PHOTO_A) !== mediaIdentity(PHOTO_AUTRE),
  'une autre vue du même carrousel reste un autre média'
)

/* Le chemin d’un clip Instagram, lui, est jetable : l’asset permanent est dans `_nc_vs`. */
const NC_VS =
  'HBksFQIYUmlnX3hwdl9yZWVsc19wZXJtYW5lbnRfc3JfcHJvZC9EOTRBM0FBOTQzQzYwMjM5NTBGN0Y4ODY2MkZGODQ5QV92aWRlb19kYXNoaW5pdC5tcDQ'
const CLIP_A =
  'https://scontent-lhr6-2.cdninstagram.com/o1/v/t2/f2/m86/AQPOCLZOpt7aVHv8bEm-2YJ96tiCpGxO4N0gN6_5vuIWf7ye.mp4' +
  `?_nc_cat=104&_nc_ohc=_FrhUCwWNqIQ7kNvwFGUTqm&vs=1c3d0547a34541d9&_nc_vs=${NC_VS}` +
  '&oh=00_AQHDCNbrYrusuHyAAsY0VTG_8RBHfgITBcHq7SP_H7FfLw&oe=6A854B6D'
const CLIP_B =
  'https://scontent-lhr11-1.cdninstagram.com/o1/v/t2/f2/m86/AQMuneAutreSignatureCarLeCheminEstJetable.mp4' +
  `?_nc_cat=101&_nc_ohc=r6X3qyF0cvMQ7kNvwE9i1AM&vs=1c3d0547a34541d9&_nc_vs=${NC_VS}` +
  '&oh=00_AQGwo8BFB7cAgfZrKlYDcNlCYSMArkJMrLXbgn8QT7Ko0A&oe=6A895D7E'

assert(
  mediaIdentity(CLIP_A) === mediaIdentity(CLIP_B),
  'un clip dont le chemin signé a changé reste le même clip'
)
assert(
  mediaIdentity(CLIP_A) !== mediaIdentity(CLIP_A.replace('OTRBM0FB', 'OTRBM0FC')),
  'un autre asset permanent reste un autre clip'
)

/* Une affiche de clip porte elle aussi un `efg`, mais sans identifiant d’asset : elle doit
   retomber sur son chemin, sinon toutes les affiches se confondraient en une seule. */
const EFG_COUVERTURE =
  'eyJ2ZW5jb2RlX3RhZyI6IkNMSVBTLnhwaWRzLjY0MC5zZHIudmlkZW9fZGVmYXVsdF9jb3Zlcl9mcmFtZS5DMyJ9'
assert(
  mediaIdentity(
    `https://scontent.cdninstagram.com/v/t51.71878-15/768824264_1720203119202873_n.jpg?efg=${EFG_COUVERTURE}`
  ) !==
    mediaIdentity(
      `https://scontent.cdninstagram.com/v/t51.71878-15/767524791_1366744674995248_n.jpg?efg=${EFG_COUVERTURE}`
    ),
  'deux affiches de clips différents ne se confondent pas'
)

assert(
  mediaIdentity('https://video.twimg.com/amplify_video/2087375074949316608/vid/avc1/654x360/FyJW.mp4?tag=29') ===
    mediaIdentity('https://video.twimg.com/amplify_video/2087375074949316608/vid/avc1/654x360/FyJW.mp4?tag=31'),
  'X n’a besoin de rien de plus que son chemin'
)
assert(mediaIdentity(null) === null, 'un média sans URL n’a pas d’identité')
assert(
  mediaIdentity('C:\media\vignette.webp') === 'C:\media\vignette.webp',
  'un fichier local est déjà sa propre identité'
)
assert(mediaIdentity('pas une url') === 'pas une url', 'une URL illisible ne fait pas échouer l’upsert')

console.log('\nTout est vert.')
