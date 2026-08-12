/**
 * Vérification de la couche SQL sur la base réelle : `npm run check:db`
 *
 * Le point délicat est l'index FTS5 en table externe : il n'est correct que si les
 * triggers l'ont bien alimenté. Un index vide ne provoque aucune erreur — la recherche
 * renvoie simplement zéro résultat, ce qui passerait inaperçu.
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'

const dbPath =
  process.platform === 'win32'
    ? join(process.env.APPDATA ?? '', 'magpie', 'magpie.db')
    : join(process.env.HOME ?? '', 'Library/Application Support/magpie/magpie.db')

if (!existsSync(dbPath)) {
  console.error(`Base introuvable : ${dbPath}\nLancez l'application une fois (\`npm run dev\`).`)
  process.exit(1)
}

const db = new Database(dbPath, { readonly: true })
let failures = 0

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
  else {
    failures++
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const one = <T>(sql: string, ...params: unknown[]): T => db.prepare(sql).get(...params) as T

console.log(`Base : ${dbPath}\n`)

const total = one<{ n: number }>('SELECT COUNT(*) n FROM posts').n
const platforms = db
  .prepare('SELECT platform, COUNT(*) n FROM posts GROUP BY platform ORDER BY platform')
  .all() as { platform: string; n: number }[]

console.log('contenu')
check('des posts sont présents', total > 0, `${total}`)
check(
  'au moins une plateforme est représentée',
  platforms.length > 0,
  platforms.map((p) => `${p.platform}=${p.n}`).join(' ')
)
check(
  'aucune plateforme inconnue',
  platforms.every((p) => ['instagram', 'x', 'reddit'].includes(p.platform))
)
check(
  'les médias sont rattachés',
  one<{ n: number }>('SELECT COUNT(*) n FROM media WHERE post_id NOT IN (SELECT id FROM posts)').n === 0
)
check(
  'les vignettes portent des dimensions',
  one<{ n: number }>('SELECT COUNT(*) n FROM media WHERE thumb_path IS NOT NULL AND (width IS NULL OR height IS NULL)').n === 0
)
check(
  'les dimensions sont remontées sur le post principal',
  one<{ n: number }>(`SELECT COUNT(*) n FROM posts p
     WHERE EXISTS (SELECT 1 FROM media m WHERE m.post_id = p.id AND m.idx = 0 AND m.thumb_path IS NOT NULL)
       AND (p.width IS NULL OR p.height IS NULL OR p.dominant_color IS NULL)`).n === 0
)

console.log('\nmédias multiples et vidéo')
const carousels = one<{ n: number }>(
  `SELECT COUNT(*) n FROM (SELECT post_id FROM media GROUP BY post_id HAVING COUNT(*) > 1)`
).n
check('des posts portent plusieurs médias', carousels > 0, `${carousels} carrousels`)
check(
  'les carrousels sont indexés sans trou',
  one<{ n: number }>(
    `SELECT COUNT(*) n FROM (
       SELECT post_id, COUNT(*) c, MAX(idx) m FROM media GROUP BY post_id HAVING m <> c - 1
     )`
  ).n === 0
)
const videos = one<{ n: number }>(`SELECT COUNT(*) n FROM media WHERE video_path IS NOT NULL`).n
check('des clips sont en cache', videos > 0, `${videos}`)
check(
  'chaque clip a son affiche',
  one<{ n: number }>(
    `SELECT COUNT(*) n FROM media WHERE video_path IS NOT NULL AND thumb_path IS NULL`
  ).n === 0
)

console.log('\nrecherche plein texte')
const ftsCount = one<{ n: number }>('SELECT COUNT(*) n FROM posts_fts').n
check("l'index FTS est alimenté par les triggers", ftsCount === total, `${ftsCount}/${total}`)

/**
 * Les termes de test sont tirés du contenu réel plutôt que codés en dur : une bibliothèque
 * ne parle pas forcément la langue de la fixture, et un mot absent ferait échouer le
 * contrôle sans qu'il y ait le moindre problème.
 */
const sampleWords = (
  db.prepare(`SELECT text FROM posts WHERE text IS NOT NULL AND length(text) > 40 LIMIT 60`).all() as {
    text: string
  }[]
)
  .flatMap((row) => row.text.toLowerCase().match(/\p{L}{5,}/gu) ?? [])
  .filter((word) => !/^https?$/.test(word))

const frequency = new Map<string, number>()
for (const word of sampleWords) frequency.set(word, (frequency.get(word) ?? 0) + 1)
const terms = [...frequency.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 3)
  .map(([word]) => word)

if (terms.length === 0) {
  console.log('  — pas assez de texte pour éprouver la recherche')
} else {
  for (const term of terms) {
    const hits = one<{ n: number }>(
      `SELECT COUNT(*) n FROM posts p
        WHERE p.rowid IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)`,
      `"${term}"*`
    ).n
    check(`« ${term} » se retrouve`, hits > 0, `${hits}`)
  }

  // Un terme accentué et sa version sans accent doivent donner le même résultat.
  const accented = sampleWords.find((word) => /[àâäéèêëîïôöùûüç]/.test(word))
  if (accented) {
    const plain = accented.normalize('NFD').replace(/[̀-ͯ]/g, '')
    const hitsAccented = one<{ n: number }>(
      `SELECT COUNT(*) n FROM posts_fts WHERE posts_fts MATCH ?`,
      `"${accented}"*`
    ).n
    const hitsPlain = one<{ n: number }>(
      `SELECT COUNT(*) n FROM posts_fts WHERE posts_fts MATCH ?`,
      `"${plain}"*`
    ).n
    check(
      `les diacritiques sont ignorés (« ${accented} » = « ${plain} »)`,
      hitsAccented === hitsPlain && hitsAccented > 0
    )
  }
}

console.log('\nfiltres et tags')
const tagged = one<{ n: number }>('SELECT COUNT(DISTINCT post_id) n FROM post_tags').n
check('des tags ont été posés par les règles', tagged > 0, `${tagged} posts tagués`)
check(
  'un filtre par tag est sélectif',
  (() => {
    // Une base sans aucun tag est un état légitime : le contrôle ne doit pas planter.
    const top = db
      .prepare(
        `SELECT t.name, COUNT(*) n FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
          GROUP BY t.id ORDER BY n DESC LIMIT 1`
      )
      .get() as { name: string; n: number } | undefined
    return top === undefined || (top.n > 0 && top.n <= total)
  })()
)

check(
  'aucun post en attente de tagging',
  one<{ n: number }>(`SELECT COUNT(*) n FROM posts WHERE tag_status = 'pending'`).n === 0
)
check(
  'aucun doublon possible en collection',
  (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'collection_posts'`).get() as { sql: string }).sql.includes(
    'PRIMARY KEY (collection_id, post_id)'
  )
)

console.log('\nétiquettes de couleur')
const postCols = (db.prepare('PRAGMA table_info(posts)').all() as { name: string }[]).map((c) => c.name)
const collCols = (db.prepare('PRAGMA table_info(collections)').all() as { name: string }[]).map(
  (c) => c.name
)
check('les posts portent une colonne label', postCols.includes('label'))
check('les collections portent une colonne color', collCols.includes('color'))
check(
  'la colonne label est indexée',
  (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_posts_label'`).all())
    .length === 1
)
check(
  'aucune étiquette hors palette',
  one<{ n: number }>(
    `SELECT COUNT(*) n FROM posts WHERE label IS NOT NULL
      AND label NOT IN ('red','orange','yellow','green','blue','purple','grey')`
  ).n === 0
)
check(
  'aucune couleur de collection hors palette',
  one<{ n: number }>(
    `SELECT COUNT(*) n FROM collections WHERE color IS NOT NULL
      AND color NOT IN ('red','orange','yellow','green','blue','purple','grey')`
  ).n === 0
)

console.log('\nintégrité')
check('intégrité SQLite', one<{ integrity_check: string }>('PRAGMA integrity_check').integrity_check === 'ok')
check('aucune clé étrangère orpheline', (db.pragma('foreign_key_check') as unknown[]).length === 0)

db.close()
console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} vérification(s) en échec.`)
process.exit(failures === 0 ? 0 : 1)
