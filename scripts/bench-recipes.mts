import Database from 'better-sqlite3'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'


/**
 * Laquelle des huit recettes place le mieux les posts ?
 *
 * Même méthode que `bench-blend`, et même vérité de terrain : deux posts du même auteur
 * devraient se retrouver voisins. C'est un substitut — il mesure « ces deux posts vont
 * ensemble », pas « ce voisinage a du sens » — donc l'écart entre recettes compte davantage
 * que le chiffre absolu.
 *
 * Deux précautions, et les deux sont indispensables :
 *
 *   — le texte est réencodé **sans le handle de l'auteur**. Celui de la base le contient
 *     (`embeddings.ts`), si bien que le bloc texte lirait directement la réponse et gagnerait
 *     d'avance ;
 *   — chaque bloc est centré avant mélange, comme en production : leurs cosinus n'ont pas le
 *     même étalement, et c'est l'étalement qui classe les voisins.
 *
 * Ce banc est rapide là où `bench-blend` était long : les vecteurs d'image ne sont plus
 * recalculés, ils sont lus dans `post_image_embeddings`.
 *
 * La table ci-dessous vit ici et nulle part ailleurs. Ces huit recettes ont été un réglage de
 * l'interface, faute de savoir laquelle valait le mieux ; la mesure a tranché et les sept
 * perdantes ont été retirées du produit. Elles restent ici parce qu'un choix qu'on ne peut
 * plus rejouer n'est pas un choix mesuré, c'est une opinion.
 */

const RECIPES = {
  /** Ce qui existait avant que Magpie regarde les images. Le point de comparaison. */
  texte: { text: 1, structure: 0, meaning: 0 },
  /** Retenue. C'est `BLEND`, dans `vision.ts`. */
  equilibre: { text: 0.6, structure: 0.1, meaning: 0.3 },
  /** Ce que l'image représente prend la main ; le texte n'est plus qu'un appoint. */
  image: { text: 0.25, structure: 0.15, meaning: 0.6 },
  /** Le sujet seul, sans le style : deux dessins au même trait mais sans rapport s'écartent. */
  sujet: { text: 0.4, structure: 0, meaning: 0.6 },
  /** Le style prend la main : regroupe ce qui *se ressemble*, plutôt que ce qui parle du même. */
  style: { text: 0.45, structure: 0.4, meaning: 0.15 },
  /** Rien que ce que l'image représente. Le texte ne compte plus du tout. */
  sujetSeul: { text: 0, structure: 0, meaning: 1 },
  /** Rien que l'allure : composition, palette, trait. Le sujet ne compte plus. */
  structureSeule: { text: 0, structure: 1, meaning: 0 },
  /** L'allure domine largement, sans que les deux autres disparaissent. */
  structureHaute: { text: 0.2, structure: 0.6, meaning: 0.2 }
} as const

type RecipeId = keyof typeof RECIPES

const APP = join(process.env['APPDATA'] ?? '', 'magpie')
const CACHE = process.env['RECIPE_CACHE'] ?? join(process.cwd(), '.recipe-cache')
mkdirSync(CACHE, { recursive: true })

const db = new Database(join(APP, 'magpie.db'), { readonly: true })
const rows = db
  .prepare(
    `SELECT p.id, p.text, p.author_handle AS author,
            (SELECT GROUP_CONCAT(t.name) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
              WHERE pt.post_id = p.id) AS tags,
            e.structure, e.meaning
       FROM posts p JOIN post_image_embeddings e ON e.post_id = p.id
      WHERE p.is_archived = 0 AND p.author_handle IS NOT NULL`
  )
  .all() as {
  id: string
  text: string | null
  author: string
  tags: string | null
  structure: Buffer
  meaning: Buffer
}[]
db.close()
console.log(`${rows.length} posts illustrés et attribués`)

const asVector = (b: Buffer): Float32Array =>
  new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))

const unit = (raw: Float32Array): Float32Array => {
  let n = 0
  for (const x of raw) n += x * x
  n = Math.sqrt(n) || 1
  const out = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw[i] / n
  return out
}

/* Texte sans le handle : c'est toute la précaution du banc. */
const textOf = (r: (typeof rows)[number]): string =>
  [r.text?.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim(), r.tags?.split(',').join(', ')]
    .filter(Boolean)
    .join('\n')
    .slice(0, 512)

const TEXT_CACHE = join(CACHE, `text-${rows.length}.bin`)
let text: Float32Array[]
if (existsSync(TEXT_CACHE)) {
  const raw = readFileSync(TEXT_CACHE)
  const flat = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
  const dim = flat.length / rows.length
  text = rows.map((_, i) => flat.slice(i * dim, (i + 1) * dim))
  console.log(`texte relu du cache (${dim} dimensions)`)
} else {
  const tf = await import('@huggingface/transformers')
  tf.env.cacheDir = join(APP, 'models')
  tf.env.allowLocalModels = false
  const pipe = await tf.pipeline('feature-extraction', 'Xenova/multilingual-e5-small', {
    dtype: 'q8'
  })
  text = []
  const BATCH = 64
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH)
    const out = await pipe(
      slice.map((r) => `query: ${textOf(r)}`),
      { pooling: 'mean', normalize: true }
    )
    const dim = out.dims[out.dims.length - 1]
    slice.forEach((_, j) => text.push(out.data.slice(j * dim, (j + 1) * dim) as Float32Array))
    if (i % 1280 === 0) console.log(`  texte ${i}/${rows.length}`)
  }
  const dim = text[0].length
  const flat = new Float32Array(rows.length * dim)
  text.forEach((v, i) => flat.set(v, i * dim))
  writeFileSync(TEXT_CACHE, Buffer.from(flat.buffer))
  console.log(`texte encodé sans handle (${dim} dimensions)`)
}

const structure = rows.map((r) => asVector(r.structure))
const meaning = rows.map((r) => asVector(r.meaning))

const centre = (block: Float32Array[]): Float32Array[] => {
  const dim = block[0].length
  const mean = new Float32Array(dim)
  for (const v of block) for (let k = 0; k < dim; k++) mean[k] += v[k] / block.length
  return block.map((v) => {
    const out = new Float32Array(dim)
    for (let k = 0; k < dim; k++) out[k] = v[k] - mean[k]
    return unit(out)
  })
}

// --- vérité de terrain : deux posts du même auteur devraient se retrouver voisins --------
const byAuthor = new Map<string, number[]>()
rows.forEach((r, i) => {
  const list = byAuthor.get(r.author)
  if (list) list.push(i)
  else byAuthor.set(r.author, [i])
})
let seed = 17
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const queries: number[] = []
for (const [, idx] of byAuthor) {
  if (idx.length < 4 || idx.length > 60) continue
  queries.push(idx[Math.floor(rnd() * idx.length)])
}
const sampled = queries.sort(() => rnd() - 0.5).slice(0, 420)
console.log(`${sampled.length} requêtes, auteurs de 4 à 60 posts`)

const sims = (block: Float32Array[]): Float32Array => {
  const dim = block[0].length
  const out = new Float32Array(sampled.length * rows.length)
  sampled.forEach((q, qi) => {
    const v = block[q]
    for (let j = 0; j < rows.length; j++) {
      let s = 0
      const w = block[j]
      for (let k = 0; k < dim; k++) s += v[k] * w[k]
      out[qi * rows.length + j] = s
    }
  })
  return out
}

const K = 10
/* Les poids s'appliquent linéairement aux similarités, ce qui est *exactement* ce que fait
   `blend()` : concaténer des blocs unitaires multipliés par la racine du poids donne un
   cosinus égal à la somme pondérée des cosinus de chaque bloc. */
const evaluate = (mats: Float32Array[], weights: number[]): number => {
  let total = 0
  sampled.forEach((q, qi) => {
    const best: { j: number; s: number }[] = []
    for (let j = 0; j < rows.length; j++) {
      if (j === q) continue
      let s = 0
      for (let m = 0; m < mats.length; m++) s += weights[m] * mats[m][qi * rows.length + j]
      if (best.length < K) {
        best.push({ j, s })
        best.sort((a, b) => b.s - a.s)
      } else if (s > best[K - 1].s) {
        best[K - 1] = { j, s }
        best.sort((a, b) => b.s - a.s)
      }
    }
    const author = rows[q].author
    total += best.filter((b) => rows[b.j].author === author).length / K
  })
  return (total / sampled.length) * 100
}

console.log('\nblocs centrés, calcul des similarités…')
const mats = [sims(centre(text)), sims(centre(structure)), sims(centre(meaning))]

console.log('\nprécision@10 — part des 10 plus proches voisins qui partagent l’auteur\n')
const scored = (Object.keys(RECIPES) as RecipeId[])
  .map((id) => {
    const w = RECIPES[id]
    return { id, score: evaluate(mats, [w.text, w.structure, w.meaning]) }
  })
  .sort((a, b) => b.score - a.score)

for (const [rank, entry] of scored.entries()) {
  const w = RECIPES[entry.id]
  const poids = `${w.text} / ${w.structure} / ${w.meaning}`
  console.log(
    `  ${String(rank + 1).padStart(2)}. ${entry.id.padEnd(17)} ${poids.padEnd(18)} ${entry.score.toFixed(1).padStart(5)} %`
  )
}
console.log(`\nla meilleure : ${scored[0].id}`)
