import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ContentSource, Platform, PostQuery } from '../src/shared/types'
import { DEFAULT_QUERY } from '../src/shared/types'
import { MIGRATION_14_SQL, MIGRATION_30_SQL } from '../src/main/db/schema'
import { decodeResumeCursor, encodeResumeCursor } from '../src/main/sync/resume'

/**
 * Le mur dans l'ordre de la plateforme : `npm run check:order`
 *
 * Ni Instagram ni X ne disent quand un post a été enregistré. Le tri par défaut retombe donc
 * sur `discovered_at`, puis sur le rang — et `upsertPosts` tamponnait `discovered_at` une fois
 * **par page**. La page deux, faite de signets plus anciens, passait devant la page un : au
 * bout d'un rattrapage complet, les plus anciens étaient en haut du mur.
 *
 * Le contrôle rejoue une histoire de synchronisation complète, par le **vrai** `upsertPosts` et
 * le **vrai** tri de `listPostPage`, sur une base neuve issue de SCHEMA_SQL : deux plateformes
 * en parallèle, un rattrapage interrompu puis repris par son curseur, les likes avec des posts
 * déjà enregistrés, deux synchronisations incrémentales, et un renouvellement de lien média.
 *
 * Puis la même histoire telle que l'ancienne écriture l'a laissée — un horodatage par page —,
 * sur une base ramenée en v29 et rouverte par `getDb()` : c'est l'échelle réelle qui applique la
 * migration 30. Elle doit rendre, ligne pour ligne, ce que la nouvelle écriture produit.
 *
 * `getDb()` mémorise sa connexion : on passe d'une base à l'autre par `closeDb()` et
 * `MAGPIE_DATA_DIR`, relu à chaque ouverture.
 */

const root = join(tmpdir(), `magpie-order-${process.pid}`)
rmSync(root, { recursive: true, force: true })
const dirFresh = join(root, 'neuve')
const dirLegacy = join(root, 'ancienne')
mkdirSync(dirFresh, { recursive: true })
mkdirSync(dirLegacy, { recursive: true })
process.env['MAGPIE_DATA_DIR'] = dirFresh

const { closeDb, getDb } = await import('../src/main/db/index')
const { listPostPage, runEpochBefore, upsertPosts } = await import('../src/main/db/queries')

let failures = 0
function assert(condition: unknown, message: string, detail = ''): void {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${message}${detail ? `\n      ${detail}` : ''}`)
}

/**
 * Une page telle que le moteur la range : tous ses éléments, connus ou non, avec le rang
 * cumulé depuis le début de la tournée. `resumes` désigne la tournée qu'une reprise continue.
 */
interface Step {
  run: string
  platform: Platform
  source: ContentSource
  at: number
  rank: number
  items: string[]
  resumes?: string
}

const STEPS: Step[] = [
  // Premier rattrapage, les deux plateformes de front.
  { run: 'ig-saved-1', platform: 'instagram', source: 'saved', at: 1000, rank: 0, items: ['s1', 's2', 's3', 's4', 's5'] },
  { run: 'x-saved-1', platform: 'x', source: 'saved', at: 1050, rank: 0, items: ['x1', 'x2', 'x3', 'x4', 'x5'] },
  { run: 'ig-saved-1', platform: 'instagram', source: 'saved', at: 1100, rank: 5, items: ['s6', 's7', 's8', 's9', 's10'] },
  { run: 'x-saved-1', platform: 'x', source: 'saved', at: 1150, rank: 5, items: ['x6', 'x7', 'x8'] },
  // Les likes d'Instagram, dont deux posts déjà enregistrés et un qui ne le sera qu'à la reprise.
  { run: 'ig-liked-1', platform: 'instagram', source: 'liked', at: 1200, rank: 0, items: ['l1', 's3', 'l2'] },
  { run: 'ig-liked-1', platform: 'instagram', source: 'liked', at: 1300, rank: 3, items: ['l3', 's7', 's12'] },
  // Le rattrapage des signets, interrompu au plafond de pages, reprend par son curseur.
  { run: 'ig-saved-2', resumes: 'ig-saved-1', platform: 'instagram', source: 'saved', at: 2000, rank: 10, items: ['s11', 's12', 's13', 's14', 's15'] },
  // Des nouveautés en haut de chaque liste : syncs incrémentaux.
  { run: 'ig-saved-3', platform: 'instagram', source: 'saved', at: 5000, rank: 0, items: ['n2', 'n1', 's1', 's2', 's3'] },
  { run: 'x-saved-2', platform: 'x', source: 'saved', at: 5100, rank: 0, items: ['x9', 'x1', 'x2'] },
  { run: 'ig-liked-2', platform: 'instagram', source: 'liked', at: 5200, rank: 0, items: ['n1', 'l0', 'l1'] },
  // `media/remote.ts` renouvelle un lien expiré par `upsertPosts` sans origine ni rang.
  { run: 'refresh', platform: 'instagram', source: 'saved', at: 6000, rank: 0, items: ['l2'] }
]

/** L'ordre attendu : les tournées de la plus récente à la plus ancienne, le rang dedans. */
const EXPECTED = [
  'l0', // likes, deuxième tournée (5200)
  'x9', // X, deuxième tournée (5100)
  'n2', 'n1', // signets Instagram, troisième tournée (5000)
  'l1', 'l2', 'l3', 's12', // likes, première tournée (1200) — s12 y a été vu en premier
  'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', // X, premier rattrapage (1050)
  's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 's13', 's14', 's15' // (1000)
]


function play(stamp: (step: Step) => number): void {
  for (const step of STEPS) {
    const posts = step.items.map((item, index) => ({
      id: `${step.platform}:${item}`,
      platform: step.platform,
      nativeId: item,
      url: `https://example.com/${step.platform}/${item}`,
      authorName: `Auteur ${item}`,
      text: `légende ${item}`,
      kind: 'image' as const,
      mediaCount: 0,
      savedAt: null,
      savedRank: step.rank + index
    }))
    upsertPosts(posts, [], step.source, stamp(step))
  }
}

function order(sort: PostQuery['sort'] = 'saved'): string[] {
  const page = listPostPage({ ...DEFAULT_QUERY, sort }, 0, 500)
  return page.posts.map((post) => post.id.slice(post.id.indexOf(':') + 1))
}

function snapshot(): string {
  const db = getDb()
  const posts = db
    .prepare('SELECT id, discovered_at AS at, saved_rank AS rank FROM posts ORDER BY id')
    .all() as { id: string; at: number; rank: number | null }[]
  const sources = db
    .prepare(
      `SELECT post_id AS id, source, discovered_at AS at, source_rank AS rank
         FROM post_sources ORDER BY post_id, source`
    )
    .all() as { id: string; source: string; at: number; rank: number | null }[]
  return JSON.stringify({ posts, sources })
}

const same = (a: string[], b: string[]): boolean => a.join(' ') === b.join(' ')

console.log('Vérification de l’ordre du mur\n')

console.log('la nouvelle écriture : un horodatage par tournée')
/* L'horodatage d'une tournée est celui de sa première page ; une reprise relit le sien dans
   le curseur écrit par la tournée qu'elle continue — comme le moteur. */
const epochs = new Map<string, number>()
play((step) => {
  const known = epochs.get(step.run)
  if (known !== undefined) return known
  let epoch = step.at
  if (step.resumes) {
    const written = encodeResumeCursor('curseur-plateforme', step.rank, epochs.get(step.resumes)!)
    epoch = decodeResumeCursor(written)?.epoch ?? step.at
  }
  epochs.set(step.run, epoch)
  return epoch
})
const fresh = order()
assert(same(fresh, EXPECTED), 'le tri par défaut suit les tournées, puis le rang', `reçu : ${fresh.join(' ')}`)
assert(
  fresh.indexOf('s1') < fresh.indexOf('s6') && fresh.indexOf('s6') < fresh.indexOf('s11'),
  'la page deux et la reprise restent sous la page un'
)
assert(same(order('added'), EXPECTED), '« ajoutés récemment » range une tournée par son rang, lui aussi')
const reference = snapshot()
closeDb()

console.log('\nles curseurs de reprise')
{
  const written = decodeResumeCursor(encodeResumeCursor('abc', 42, 1234))
  assert(
    written?.cursor === 'abc' && written.rank === 42 && written.epoch === 1234,
    'un curseur neuf garde son horodatage'
  )
  const legacy = decodeResumeCursor(JSON.stringify({ cursor: 'abc', rank: 42 }))
  assert(
    legacy?.cursor === 'abc' && legacy.rank === 42 && legacy.epoch === null,
    'un curseur d’avant l’horodatage se relit encore, sans en inventer un'
  )
  const raw = decodeResumeCursor('QVFIUmF3Q3Vyc29y')
  assert(
    raw?.cursor === 'QVFIUmF3Q3Vyc29y' && raw.rank === 0 && raw.epoch === null,
    'un curseur brut des toutes premières versions aussi'
  )
}

console.log('\nune bibliothèque écrite page par page, rouverte après la migration 30')
process.env['MAGPIE_DATA_DIR'] = dirLegacy
play((step) => step.at)
const broken = order()
assert(
  broken.indexOf('s11') < broken.indexOf('s1'),
  'le défaut est bien reproduit : la reprise passait devant le début du rattrapage'
)
{
  /* Ramenée en v29 : l'ancien déclencheur plein texte — MIGRATION_14_SQL est la dernière à
     l'avoir posé, sa colonne mise à part —, et le numéro de version. L'empreinte de bibliothèque se retire aussi, sans
     quoi la réouverture refuserait à raison une base « plus ancienne » que la dernière vue. */
  const db = getDb()
  db.exec(MIGRATION_14_SQL.slice(MIGRATION_14_SQL.indexOf('DROP TRIGGER')))
  db.pragma('user_version = 29')
  closeDb()
  rmSync(join(dirLegacy, 'library-state.json'), { force: true })
}
const migrated = getDb()
assert(migrated.pragma('user_version', { simple: true }) === 30, 'l’échelle a porté la base en v30')
assert(snapshot() === reference, 'la réparation rend, ligne pour ligne, ce que la nouvelle écriture produit')
assert(same(order(), EXPECTED), 'et le mur retrouve l’ordre attendu', `reçu : ${order().join(' ')}`)
assert(
  runEpochBefore('instagram', 'saved', 10) === 1000,
  'un curseur sans horodatage retrouve celui de la tournée qu’il interrompt'
)
{
  let intact = true
  try {
    migrated.exec("INSERT INTO posts_fts(posts_fts) VALUES('integrity-check')")
  } catch {
    intact = false
  }
  assert(intact, 'l’index plein texte est resté intact')
}
migrated.exec(MIGRATION_30_SQL)
assert(snapshot() === reference, 'rejouée une seconde fois, la migration ne change plus rien')
closeDb()
rmSync(root, { recursive: true, force: true })

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} échec(s).`)
process.exitCode = failures === 0 ? 0 : 1
