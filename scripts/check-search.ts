import Database from 'better-sqlite3'
import { registerFunctions } from '../src/main/db/functions'
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
 * Le contrôle exerce le **vrai** SQL sur une base en mémoire, avec les **vraies** fonctions —
 * `registerFunctions` est celle que l'application appelle, pas une copie. C'est pour cela que
 * `search.ts` et `functions.ts` n'importent ni Electron ni la base : même déménagement, et même
 * raison, que les migrations le jour où `check:schema` a été écrit.
 */

let failures = 0
function assert(condition: unknown, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${message}`)
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
  { id: 'p5', text: 'sans rapport', author_handle: '@z', author_name: 'Nobody', tags: ['Ürsprung'] }
]

const insertPost = db.prepare(
  `INSERT INTO posts (id, platform, native_id, url, author_handle, author_name, text, kind,
                      media_count, discovered_at, updated_at)
   VALUES (?, 'x', ?, 'https://x.com/1', ?, ?, ?, 'text', 0, 0, 0)`
)
const insertTag = db.prepare(`INSERT INTO tags (name, source) VALUES (?, 'user')`)
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
assert(find('Éducation').includes('p3'), 'les tags : « Éducation » trouve le tag « éducation »')
assert(find('education').includes('p3'), 'et « education » sans accent aussi')
assert(find('ursprung').includes('p5'), 'un tréma se replie comme le reste')
assert(find('cafe').includes('p4'), 'la légende, déjà couverte par l’index, continue de répondre')

console.log('\nles trois bras cherchent la même chose')
assert(find('ghibli').includes('p2'), 'le nom affiché trouve ce que le pseudo ne dit pas')
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

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} échec(s).`)
process.exitCode = failures === 0 ? 0 : 1
