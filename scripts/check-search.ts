import Database from 'better-sqlite3'
import { performance } from 'node:perf_hooks'
import { DEFAULT_QUERY } from '../src/shared/types'
import { backfillFoldedNames, fold, registerFunctions } from '../src/main/db/functions'
import { postFilter } from '../src/main/db/queries'
import { SCHEMA_SQL } from '../src/main/db/schema'
import { searchClause, searchTerms, ftsQuery } from '../src/main/db/search'

/**
 * La recherche tient sa promesse : `npm run check:search`
 *
 * Le README, la présentation et SPEC annoncent tous trois une recherche « insensible aux
 * accents » **sur les légendes, les auteurs et les tags**. C'était vrai d'un seul des trois.
 * L'index FTS5 est déclaré `unicode61 remove_diacritics 2`, donc la légende, le pseudo et la
 * transcription répondaient bien — mais le nom affiché de l'auteur et les tags passaient par
 * `LIKE`, qui replie la casse ASCII et rien d'autre. « Beyonce » ne trouvait pas « Beyoncé »,
 * « Éducation » ne trouvait pas « éducation », et ce sont exactement les deux gisements que le
 * README met en avant.
 *
 * Puis la réparation a eu son propre défaut : `fold()`, une fonction JavaScript, s'évaluait
 * **sur chaque post à chaque frappe**. Mesuré sur cent mille posts, 321 ms par comptage, et
 * `listPostPage` en fait deux — le processus principal gelait six dixièmes de seconde par
 * touche. La dernière partie vérifie que la recherche ne coûte plus au prorata de la
 * bibliothèque, sans rien retirer de ce qu'elle trouve.
 *
 * Le contrôle exerce le **vrai** SQL sur une base en mémoire, avec les **vraies** fonctions —
 * `registerFunctions` est celle que l'application appelle, pas une copie, et la condition vient
 * de `postFilter`. C'est pour cela que `search.ts` et `functions.ts` n'importent ni Electron ni
 * la base : même déménagement, et même raison, que les migrations le jour où `check:schema` a
 * été écrit.
 */

let failures = 0
function assert(condition: unknown, message: string, detail = ''): void {
  if (condition) {
    console.log(`  ✓ ${message}${detail ? ` — ${detail}` : ''}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${message}${detail ? ` — ${detail}` : ''}`)
}

const db = new Database(':memory:')
registerFunctions(db)
db.exec(SCHEMA_SQL)

interface Seed {
  id: string
  text: string | null
  author_handle: string | null
  author_name: string | null
  tags?: string[]
}

const SEEDS: Seed[] = [
  { id: 'p1', text: 'live at the arena', author_handle: '@bey', author_name: 'Beyoncé' },
  { id: 'p2', text: 'donut tutorial', author_handle: '@ghibli_intl', author_name: 'Studio Ghibli' },
  { id: 'p3', text: 'rien de particulier', author_handle: '@x', author_name: 'Anon', tags: ['éducation'] },
  { id: 'p4', text: 'un café serré', author_handle: '@y', author_name: 'Zed' },
  { id: 'p5', text: 'sans rapport', author_handle: '@z', author_name: 'Nobody', tags: ['Ürsprung'] },
  { id: 'p6', text: 'une recette', author_handle: '@chef', author_name: 'ÉMILE Brûlé', tags: ['Crème', 'Pâtisserie'] },
  { id: 'p7', text: 'rien', author_handle: '@anon', author_name: null, tags: ['NatGeo'] }
]

/* Des lignes écrites sans leur repli, comme les laisse la migration 31 : c'est
   `backfillFoldedNames` — le passage que l'ouverture fait après l'échelle — qui les complète. */
const insertPost = db.prepare(
  `INSERT INTO posts (id, platform, native_id, url, author_handle, author_name, text, kind,
                      media_count, discovered_at, updated_at)
   VALUES (?, 'x', ?, 'https://x.com/1', ?, ?, ?, 'text', 0, 0, 0)`
)
const insertTag = db.prepare(`INSERT OR IGNORE INTO tags (name, source) VALUES (?, 'user')`)
const linkTag = db.prepare(
  `INSERT INTO post_tags (post_id, tag_id, source) VALUES (?, (SELECT id FROM tags WHERE name = ?), 'user')`
)
for (const seed of SEEDS) {
  insertPost.run(seed.id, seed.id, seed.author_handle, seed.author_name, seed.text)
  for (const tag of seed.tags ?? []) {
    insertTag.run(tag)
    linkTag.run(seed.id, tag)
  }
}
const backfilled = backfillFoldedNames(db)

/** Ce que la recherche rend, en passant par la clause réellement utilisée par l'application. */
function find(raw: string): string[] {
  const clause = searchClause(raw)
  if (!clause) return SEEDS.map((seed) => seed.id)
  const rows = db
    .prepare(`SELECT p.id FROM posts p WHERE ${clause.sql} ORDER BY p.id`)
    .all(...(clause.params as never[])) as { id: string }[]
  return rows.map((row) => row.id)
}

console.log('Vérification de la recherche\n')

console.log('insensibilité aux accents')
assert(find('Beyonce').includes('p1'), 'le nom d’auteur : « Beyonce » trouve « Beyoncé »')
assert(find('beyoncé').includes('p1'), 'et réciproquement, « beyoncé » trouve le même post')
assert(find('emile brule').includes('p6'), 'des capitales accentuées se replient : « emile brule » trouve « ÉMILE Brûlé »')
assert(find('Éducation').includes('p3'), 'les tags : « Éducation » trouve le tag « éducation »')
assert(find('education').includes('p3'), 'et « education » sans accent aussi')
assert(find('ursprung').includes('p5'), 'un tréma se replie comme le reste')
assert(find('CREME').includes('p6'), 'un tag accentué répond à une saisie en capitales sans accent')
assert(find('cafe').includes('p4'), 'la légende, déjà couverte par l’index, continue de répondre')

console.log('\nce que chaque bras accepte')
assert(find('ghibli').includes('p2'), 'le nom affiché trouve ce que le pseudo ne dit pas')
assert(find('hibli').includes('p2'), 'le nom affiché se cherche par sous-chaîne, au milieu d’un mot')
assert(find('stud ghib').includes('p2'), 'chaque mot est une sous-chaîne du nom, pas seulement le dernier')
assert(find('educ').includes('p3'), 'un tag se cherche par sous-chaîne lui aussi')
assert(find('geo').includes('p7'), 'jusqu’au milieu d’un tag')
assert(find('creme patiss').includes('p6'), 'deux mots peuvent répondre par deux tags différents')
assert(!find('arena').includes('p2') && find('arena').includes('p1'), 'et un mot absent ne ramène rien d’autre')
assert(backfilled === SEEDS.filter((seed) => seed.author_name).length, 'le repli comble chaque nom, et seulement les noms', `${backfilled} repliés`)
assert(backfillFoldedNames(db) === 0, 'rejoué, il ne trouve plus rien à faire')
{
  const plan = (
    db
      .prepare(`EXPLAIN QUERY PLAN UPDATE posts SET author_name_folded = fold(author_name)
                 WHERE author_name_folded IS NULL AND author_name IS NOT NULL`)
      .all() as { detail: string }[]
  ).map((row) => row.detail)
  assert(
    plan.some((detail) => detail.includes('idx_posts_author_folded')),
    'à l’ouverture, les lignes restantes se trouvent par l’index, sans relire la table',
    plan.join(' | ')
  )
}

console.log('\nles trois bras cherchent la même chose')
{
  const tordues = ['art 3', 'a', 'un deux trois quatre cinq six sept huit', "l'été", '100 % pur', 'a_b']
  const same = tordues.every((raw) => {
    const terms = searchTerms(raw)
    const query = ftsQuery(raw)
    return query === null ? terms.length === 0 : query.split(' AND ').length === terms.length
  })
  assert(same, 'l’index et les comparaisons découpent la saisie identiquement')
}

console.log('\nles jokers ne s’échappent pas de la saisie')
/* Une saisie qui ne porte aucun mot est une saisie vide, et une recherche vide montre tout :
   c'est le comportement voulu, pas une fuite. Ce qu'on vérifie, c'est qu'un `%` tapé par
   l'utilisateur ne devient jamais le joker de `LIKE` — sans quoi « zzz% » ramènerait la
   bibliothèque entière au lieu de rien. */
assert(find('%').length === SEEDS.length, 'une saisie sans mot ne filtre rien, et ne prend pas tout')
assert(find('zzz%').length === 0, 'un pour-cent collé à un mot ne l’élargit pas')
assert(find('zzz_').length === 0, 'ni le tiret bas, l’autre joker de LIKE')

console.log('\nl’index plein texte suit ce qu’il indexe, et rien d’autre')
{
  /* `posts_fts_au` réindexait jusqu'aux transcriptions à **chaque** `UPDATE` de `posts` : un
     favori, un retrait, un compteur de vignette, chaque upsert d'un post déjà connu. Les
     écritures des déclencheurs comptent dans `total_changes()` : un favori doit n'en faire
     qu'une. */
  const changes = (sql: string, ...params: unknown[]): number => {
    const before = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    db.prepare(sql).run(...params)
    return (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n - before
  }
  assert(changes("UPDATE posts SET is_favorite = 1 WHERE id = 'p4'") === 1, 'un favori ne touche pas l’index')
  assert(
    changes("UPDATE posts SET text = text, author_name = author_name WHERE id = 'p4'") === 1,
    'un upsert qui réécrit la même légende non plus'
  )
  assert(
    changes("UPDATE posts SET text = 'un thé glacé' WHERE id = 'p4'") > 1,
    'une légende qui change est réindexée'
  )
  assert(find('the glace').includes('p4') && !find('cafe').includes('p4'), 'et la recherche suit la nouvelle')
  let intact = true
  try {
    db.exec("INSERT INTO posts_fts(posts_fts) VALUES('integrity-check')")
  } catch {
    intact = false
  }
  assert(intact, 'l’index reste intègre')
}

console.log('\nà l’échelle : trente mille posts')
{
  /* Déterministe : un générateur à graine, pour que deux passages cherchent la même chose. */
  let seed = 0x2f6b1d
  const random = (): number => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 4294967296
  }
  const WORDS = (
    'photo art design café montagne musique studio lumière recette cuisine voyage plage ville ' +
    'nuit film danse sport peinture dessin architecture maison jardin fleur chat chien mode ' +
    'vintage néon synthwave ableton production mixage guitare piano concert festival été hiver'
  ).split(' ')
  const pick = (): string => WORDS[Math.floor(random() * WORDS.length)]
  const POSTS = 30_000
  const TAGS = 3_000
  const big = new Database(':memory:')
  registerFunctions(big)
  big.exec(SCHEMA_SQL)
  const raw = JSON.stringify({ payload: 'x'.repeat(600) })
  const post = big.prepare(
    `INSERT INTO posts (id, platform, native_id, url, author_handle, author_name, text, kind,
                        media_count, discovered_at, saved_rank, raw, updated_at)
     VALUES (?, ?, ?, 'https://example.com', ?, ?, ?, 'image', 1, 0, ?, ?, 0)`
  )
  const tag = big.prepare(`INSERT INTO tags (id, name, source) VALUES (?, ?, 'rule')`)
  const link = big.prepare(`INSERT OR IGNORE INTO post_tags (post_id, tag_id, source) VALUES (?, ?, 'rule')`)
  big.transaction(() => {
    /* Un tag sur trois porte le même mot : c'est le cas qui faisait sonder la clé de
       `post_tags` une fois par post et par tag retenu — quatorze secondes sur cent mille posts. */
    for (let i = 1; i <= TAGS; i += 1) tag.run(i, i % 3 === 0 ? `étiquette${i}` : `${pick()}${i}`)
    for (let i = 0; i < POSTS; i += 1) {
      const author = Math.floor(random() * 12_000)
      post.run(
        `p${i}`,
        i % 2 ? 'instagram' : 'x',
        String(i),
        `@compte${author}`,
        `${pick()} Créatrice ${author}`,
        Array.from({ length: 18 }, pick).join(' '),
        i,
        raw
      )
      for (let k = Math.floor(random() * 3); k > 0; k -= 1) {
        link.run(`p${i}`, 1 + Math.floor(random() * TAGS))
      }
    }
  })()
  backfillFoldedNames(big)

  /* Le repli compté : c'est la propriété qui compte, et elle ne dépend d'aucune horloge. */
  let folds = 0
  big.function('fold', { deterministic: true }, (value: unknown) => {
    folds += 1
    return fold(value)
  })

  const count = (search: string): { n: number; ms: number; folds: number; plan: string[] } => {
    const { condition, params } = postFilter({ ...DEFAULT_QUERY, search })
    const sql = `SELECT COUNT(*) AS n FROM posts p WHERE ${condition}`
    const statement = big.prepare(sql)
    const times: number[] = []
    let n = 0
    folds = 0
    statement.get(...params)
    const perRun = folds
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now()
      n = (statement.get(...params) as { n: number }).n
      times.push(performance.now() - started)
    }
    times.sort((a, b) => a - b)
    const plan = (big.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map(
      (row) => row.detail
    )
    return { n, ms: times[2], folds: perRun, plan }
  }

  for (const search of ['zzz', 'synthwave', 'créatrice 42', 'etiquette', 'a']) {
    const result = count(search)
    const terms = searchTerms(search).length
    assert(
      result.folds <= TAGS * terms,
      `« ${search} » : le repli ne tourne que sur les tags, jamais sur les posts`,
      `${result.folds} appels pour ${TAGS} tags et ${POSTS} posts`
    )
    assert(
      !result.plan.some((detail) => detail.startsWith('CORRELATED')),
      `« ${search} » : aucune sous-requête réévaluée post par post`,
      result.plan.filter((detail) => /^(SCAN|SEARCH|MULTI)/.test(detail)).slice(0, 3).join(' | ')
    )
    /* Un budget large, qui ne prétend pas mesurer finement : six contrôles partagent le
       processeur. Il est là pour les effondrements — l'ancienne clause mettait plus d'une
       seconde, ici, à compter « etiquette ». Ce que ce contrôle garantit vraiment, ce sont les
       deux propriétés au-dessus, qui ne dépendent d'aucune horloge. */
    assert(
      result.ms <= 250,
      `« ${search} » : compté en ${result.ms.toFixed(1)} ms`,
      `${result.n} posts, budget 250 ms`
    )
  }
  big.close()
}

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} échec(s).`)
process.exitCode = failures === 0 ? 0 : 1
