import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Platform, VideoQuality } from '../src/shared/types'
import { parseByteRange } from '../src/main/media/range'
import { createRemoteMediaUrl, parseRemoteMediaUrl } from '../src/main/media/remote'
import { resolvePreferredQuality } from '../src/shared/quality'
import { isMediaUrlExpired, mediaUrlExpiry } from '../src/main/media/freshness'
import { mediaIdentity } from '../src/main/media/identity'
import { CacheQuotaReached, thumbnailFailure, thumbnailLinkExpired } from '../src/main/media/cache'
import {
  LINK_REFRESH_HOURLY_CAP,
  LINK_REFRESH_QUEUE,
  LINK_FAILURE_COOLDOWN_MS,
  LinkRefresher,
  type LinkRefresherDeps
} from '../src/main/media/links'
import { ChallengeRequired, HttpError } from '../src/main/adapters/http'
import { THUMB_AWAITING_LINK } from '../src/main/db/media-upsert'
import * as queries from '../src/main/db/queries'
import type { ThumbnailLinkRow } from '../src/main/db/queries'
import { closeDb, getDb } from '../src/main/db/index'

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

/**
 * Ce qui suit attend des promesses : le banc est compilé en CommonJS, qui n'a pas d'`await` au
 * premier niveau.
 */
async function main(): Promise<void> {
  /*
   * Le compte des tentatives d'une vignette.
   *
   * Trois échecs, et une vignette est abandonnée. Or deux causes d'échec ne disaient rien du
   * média : un lien de CDN périmé — Instagram signe ses liens pour quelques jours — et un disque
   * plein. Les compter faisait finir l'historique ancien en carrés vides, pour toujours : une
   * synchronisation qui rapportait ensuite un lien valide gardait les tentatives perdues, puisque
   * le média, lui, n'avait pas changé.
   */
  console.log('\nTentatives d’une vignette')

  const now = Date.now()
  const oe = (ms: number): string => Math.floor(ms / 1000).toString(16).toUpperCase()
  const PHOTO_PATH = 'https://scontent-lhr6-1.cdninstagram.com/v/t51.82787-15/555_1854_n.webp'
  const EXPIRED = `${PHOTO_PATH}?_nc_ohc=a&oh=00_A&oe=${oe(now - 86_400_000)}`
  const FRESH = `${PHOTO_PATH}?_nc_ohc=b&oh=00_B&oe=${oe(now + 3 * 86_400_000)}`
  const TWEET = 'https://pbs.twimg.com/media/Gabc.jpg?name=small'

  assert(thumbnailLinkExpired(null, EXPIRED, now), 'un lien signé périmé n’est pas téléchargé')
  assert(!thumbnailLinkExpired(null, FRESH, now), 'un lien signé encore valide l’est')
  assert(!thumbnailLinkExpired(null, TWEET, now), 'un lien sans signature ne périme jamais')

  const scratch = mkdtempSync(join(tmpdir(), 'magpie-media-'))
  const localCopy = join(scratch, 'source.jpg')
  writeFileSync(localCopy, 'x')
  assert(!thumbnailLinkExpired(localCopy, EXPIRED, now), 'une copie locale passe devant le lien périmé')

  assert(thumbnailFailure(new CacheQuotaReached(), EXPIRED) === 'quota', 'un disque plein ne coûte pas de tentative')
  assert(
    thumbnailFailure(new HttpError(403, EXPIRED), EXPIRED) === 'link',
    'un 403 sur un lien signé attend un lien neuf'
  )
  assert(
    thumbnailFailure(new HttpError(403, FRESH), FRESH) === 'link',
    'même quand la date inscrite dans le lien court encore'
  )
  assert(thumbnailFailure(new HttpError(403, TWEET), TWEET) === 'attempt', 'un 403 sans signature compte')
  assert(thumbnailFailure(new HttpError(404, EXPIRED), EXPIRED) === 'attempt', 'un 404 compte')
  assert(thumbnailFailure(new Error('image illisible'), FRESH) === 'attempt', 'une image illisible compte')
  assert(THUMB_AWAITING_LINK >= 3, 'l’attente d’un lien sort bien la vignette de la file')

  /* La base réelle, sur un dossier jetable : ce sont les mêmes instructions que l'application. */
  process.env.MAGPIE_DATA_DIR = scratch

  const POST = 'instagram:777'
  const POST_INPUT = {
    id: POST,
    platform: 'instagram' as const,
    nativeId: '777',
    url: 'https://www.instagram.com/p/x/',
    kind: 'carousel' as const,
    mediaCount: 2
  }
  queries.upsertPosts(
    [{ ...POST_INPUT, savedRank: 41 }],
    [
      { postId: POST, idx: 0, kind: 'image', remoteUrl: EXPIRED },
      { postId: POST, idx: 1, kind: 'image', remoteUrl: EXPIRED.replace('555_', '556_') }
    ],
    'liked'
  )
  const attempts = (idx: number): number =>
    (
      getDb().prepare('SELECT thumb_attempts n FROM media WHERE post_id = ? AND idx = ?').get(POST, idx) as {
        n: number
      }
    ).n
  const status = (idx: number): string | undefined =>
    queries.getPostsByIds([POST])[0]?.media.find((media) => media.idx === idx)?.thumbStatus

  queries.awaitFreshThumbnailLink(POST, 0, EXPIRED)
  assert(attempts(0) === THUMB_AWAITING_LINK, 'un lien périmé met la vignette en attente, sans échec compté')
  assert(
    !queries.pendingThumbnailsForPosts([POST]).some((row) => row.idx === 0),
    'la vignette en attente quitte la file'
  )
  assert(status(0) === 'pending', 'et reste « en préparation » : la grille la redemandera')
  for (let i = 0; i < 3; i += 1) queries.markThumbnailFailure(POST, 1)
  assert(status(1) === 'failed', 'trois vrais échecs, eux, déclarent la vignette impossible')

  const placed = (): { discovered_at: number; saved_rank: number } =>
    getDb().prepare('SELECT discovered_at, saved_rank FROM posts WHERE id = ?').get(POST) as {
      discovered_at: number
      saved_rank: number
    }
  const before = placed()
  const updated = queries.refreshPostMedia(
    [{ ...POST_INPUT, savedRank: 0 }],
    [
      { postId: POST, idx: 0, kind: 'image', remoteUrl: FRESH },
      { postId: POST, idx: 1, kind: 'image', remoteUrl: FRESH.replace('555_', '556_') }
    ]
  )
  assert(updated === 1, 'le renouvellement réenregistre le post connu')
  assert(attempts(0) === 0 && attempts(1) === 0, 'un lien neuf rend leurs tentatives aux deux vignettes')
  const sources = (
    getDb().prepare('SELECT source FROM post_sources WHERE post_id = ?').all(POST) as { source: string }[]
  ).map((row) => row.source)
  assert(sources.join() === 'liked', `un post seulement liké le reste après renouvellement (${sources.join()})`)
  const after = placed()
  assert(
    after.discovered_at === before.discovered_at && after.saved_rank === before.saved_rank,
    'ni sa date de découverte ni son rang ne bougent'
  )

  queries.awaitFreshThumbnailLink(POST, 0, EXPIRED)
  assert(attempts(0) === 0, 'une attente posée sur un lien déjà remplacé ne s’applique pas')

  for (let i = 0; i < 3; i += 1) queries.markThumbnailFailure(POST, 0)
  queries.refreshPostMedia([POST_INPUT], [{ postId: POST, idx: 0, kind: 'image', remoteUrl: FRESH }])
  assert(attempts(0) === 3, 'le même lien, rapporté une seconde fois, ne rend rien')

  queries.upsertPosts(
    [POST_INPUT],
    [
      { postId: POST, idx: 0, kind: 'image', remoteUrl: FRESH.replace('oh=00_B', 'oh=00_C') },
      { postId: POST, idx: 1, kind: 'image', remoteUrl: FRESH.replace('555_', '556_') }
    ],
    'liked'
  )
  assert(attempts(0) === 0, 'une synchronisation qui rapporte un lien neuf rend aussi les tentatives')

  const GONE = 'instagram:disparu'
  assert(
    queries.refreshPostMedia(
      [{ ...POST_INPUT, id: GONE, nativeId: 'disparu', mediaCount: 1 }],
      [{ postId: GONE, idx: 0, kind: 'image', remoteUrl: FRESH }]
    ) === 0 && queries.getPostsByIds([GONE]).length === 0,
    'un post retiré entre-temps n’est pas recréé par un renouvellement'
  )

  getDb()
    .prepare(`INSERT INTO media (post_id, idx, kind, remote_url, video_source) VALUES (?, 2, 'video', ?, ?)`)
    .run(POST, FRESH, 'https://scontent.cdninstagram.com/o1/v/clip.mp4?oe=FFFFFFFF')
  const clipAttempts = (): number =>
    (getDb().prepare('SELECT video_attempts n FROM media WHERE post_id = ? AND idx = 2').get(POST) as { n: number }).n
  queries.markVideoCacheResult(POST, 2, 'skipped')
  assert(clipAttempts() === 0, 'un clip refusé faute de place ne perd pas de tentative')
  queries.markVideoCacheResult(POST, 2, 'pending')
  assert(clipAttempts() === 1, 'un clip qui échoue vraiment, si')

  closeDb()
  rmSync(scratch, { recursive: true, force: true })

  /*
   * Le rythme des renouvellements.
   *
   * Le lecteur vidéo rejouait `/media/info` à chaque requête par plage après un échec, hors de
   * toute temporisation — y compris sur un compte en vérification de sécurité, ce qui est
   * exactement ce qui transforme une vérification en blocage. Et faire défiler un mur ancien ne
   * devait pas partir en centaines d'appels.
   */
  console.log('\nRenouvellement des liens')
  /* Les échecs simulés ci-dessous se journalisent comme les vrais : on ne les montre pas. */
  const warn = console.warn
  console.warn = () => {}

  interface Scene {
    refresher: LinkRefresher
    fetched: string[]
    clock: { now: number }
    state: { status: string | null; challenged: boolean }
  }

  function scene(overrides: (fetched: string[]) => Partial<LinkRefresherDeps> = () => ({})): Scene {
    const fetched: string[] = []
    const clock = { now }
    const state = { status: null as string | null, challenged: false }
    const refresher = new LinkRefresher({
      fetch: async (_platform: Platform, nativeId: string) => {
        fetched.push(nativeId)
        return { posts: [], media: [] }
      },
      available: async () => true,
      accountStatus: () => state.status,
      syncing: () => false,
      thumbnailLinks: (postIds: string[]): ThumbnailLinkRow[] =>
        postIds.map((id) => ({
          post_id: id,
          platform: 'instagram',
          remote_url: id.endsWith('frais') ? FRESH : EXPIRED,
          thumb_attempts: 0
        })),
      save: () => {},
      markChallenge: () => {
        state.challenged = true
        state.status = 'challenge'
      },
      pause: async () => {},
      now: () => clock.now,
      ...overrides(fetched)
    })
    return { refresher, fetched, clock, state }
  }
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))
  const postIds = (count: number, from = 0): string[] =>
    Array.from({ length: count }, (_, index) => `instagram:${from + index}`)

  {
    const { refresher, fetched, state } = scene()
    state.status = 'challenge'
    refresher.request(postIds(10))
    const played = await refresher.refreshNow('instagram:1')
    await settle()
    assert(fetched.length === 0 && !played, 'un compte en vérification de sécurité n’est jamais sollicité')
  }
  {
    const { refresher, fetched } = scene()
    const [a, b] = await Promise.all([refresher.refreshNow('instagram:9'), refresher.refreshNow('instagram:9')])
    assert(a && b && fetched.length === 1, 'deux requêtes du lecteur partagent un seul renouvellement')
  }
  {
    const failing = scene((fetched) => ({
      fetch: async (_platform: Platform, nativeId: string) => {
        fetched.push(nativeId)
        throw new Error('réseau coupé')
      }
    }))
    const calls = (): number => failing.fetched.length
    for (let i = 0; i < 3; i += 1) await failing.refresher.refreshNow('instagram:5')
    assert(calls() === 1, 'après un échec, les requêtes par plage ne relancent pas l’appel')
    failing.clock.now += LINK_FAILURE_COOLDOWN_MS + 1000
    await failing.refresher.refreshNow('instagram:5')
    assert(calls() === 2, 'passé le délai, un nouvel essai est permis')
  }
  {
    const { refresher, fetched } = scene()
    refresher.request([...postIds(3), 'instagram:frais'])
    await settle()
    assert(
      fetched.length === 3 && !fetched.includes('frais'),
      'seules les vignettes dont le lien a passé sont renouvelées'
    )
  }
  {
    const { refresher, fetched } = scene()
    refresher.request(postIds(100))
    await settle()
    assert(
      fetched.length === LINK_REFRESH_QUEUE,
      `un mur entier ne renouvelle que ce qui est à l’écran (${fetched.length})`
    )
    assert(fetched[0] === '0', 'le plus proche d’abord')
  }
  {
    const { refresher, fetched } = scene()
    for (let batch = 0; batch < 8; batch += 1) {
      refresher.request(postIds(LINK_REFRESH_QUEUE, batch * LINK_REFRESH_QUEUE))
      await settle()
    }
    assert(
      fetched.length === LINK_REFRESH_HOURLY_CAP,
      `un long défilement s’arrête au plafond horaire (${fetched.length} appels)`
    )
  }
  {
    const { refresher, fetched } = scene(() => ({ syncing: () => true }))
    refresher.request(postIds(5))
    await settle()
    assert(fetched.length === 0, 'rien ne part pendant une synchronisation de la même plateforme')
  }
  {
    const challenged = scene((fetched) => ({
      fetch: async (_platform: Platform, nativeId: string) => {
        fetched.push(nativeId)
        if (nativeId === '2') throw new ChallengeRequired('instagram')
        return { posts: [], media: [] }
      }
    }))
    challenged.refresher.request(postIds(10))
    await settle()
    assert(challenged.state.challenged, 'une vérification rencontrée est retenue sur le compte')
    assert(
      challenged.fetched.length === 3 && challenged.refresher.queued('instagram') === 0,
      `et la file s’arrête net (${challenged.fetched.length} appels)`
    )
  }
  {
    const { refresher } = scene()
    let heard: string[] = []
    refresher.onRefreshed((ids) => {
      heard = ids
    })
    await refresher.refreshNow('instagram:42')
    assert(heard.join() === 'instagram:42', 'un renouvellement réussi relance la file média pour ce post')
  }

  console.warn = warn
  console.log('\nTout est vert.')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
