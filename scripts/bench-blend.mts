import Database from 'better-sqlite3'
import { join } from 'node:path'
import { statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'

/**
 * Quel équilibre entre les trois signaux ?
 *
 * Texte, structure visuelle (DINOv2) et sémantique visuelle (SigLIP) ne se mélangent pas
 * naïvement : leurs cosinus n'ont pas le même étalement — 0,026 contre 0,113 et 0,086 — donc
 * des poids égaux ne donnent pas une influence égale. On centre chaque bloc, ce qui les ramène
 * dans le même registre, puis on règle les poids sur une vérité de terrain propre.
 *
 * Propre, ici, veut dire : le texte est réembarqué **sans le handle de l'auteur**. Sans cette
 * précaution, « deux posts du même auteur » est une étiquette que le bloc texte lit
 * directement, et il gagne d'avance — c'est ce qui avait faussé la première tentative.
 */

const APP = join(process.env['APPDATA'] ?? '', 'magpie')
const CACHE = process.env['BLEND_CACHE'] ?? join(process.cwd(), '.blend-cache')
mkdirSync(CACHE, { recursive: true })

const db = new Database(join(APP, 'magpie.db'), { readonly: true })
const all = db
  .prepare(
    `SELECT p.id, p.text, p.author_handle AS author,
            (SELECT GROUP_CONCAT(DISTINCT t.name) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
              WHERE pt.post_id = p.id AND pt.source <> 'ai') AS tags,
            (SELECT m.thumb_path FROM media m
              WHERE m.post_id = p.id AND m.thumb_path IS NOT NULL ORDER BY m.idx LIMIT 1) AS thumb
       FROM posts p WHERE p.is_archived = 0`
  )
  .all() as { id: string; text: string | null; author: string | null; tags: string | null; thumb: string | null }[]
db.close()

const rows = all.filter((r) => {
  if (!r.thumb || !r.author) return false
  try {
    statSync(join(APP, 'media', r.thumb))
    return true
  } catch {
    return false
  }
})
console.log(`${rows.length} posts illustrés et attribués (sur ${all.length})`)

const tf = await import('@huggingface/transformers')
tf.env.cacheDir = join(APP, 'models')
tf.env.allowLocalModels = false

const unit = (raw: Float32Array): Float32Array => {
  let n = 0
  for (let i = 0; i < raw.length; i++) n += raw[i] * raw[i]
  n = Math.sqrt(n) || 1
  const u = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i++) u[i] = raw[i] / n
  return u
}

const cached = async (name: string, dim: number, make: () => Promise<Float32Array[]>): Promise<Float32Array[]> => {
  const file = join(CACHE, `${name}.bin`)
  if (existsSync(file)) {
    const buf = readFileSync(file)
    const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
    if (flat.length === rows.length * dim) {
      console.log(`  ${name} : repris du cache`)
      return rows.map((_, i) => flat.subarray(i * dim, (i + 1) * dim))
    }
  }
  const t0 = Date.now()
  const out = await make()
  const flat = new Float32Array(rows.length * dim)
  out.forEach((v, i) => flat.set(v, i * dim))
  writeFileSync(file, Buffer.from(flat.buffer))
  console.log(`  ${name} : calculé en ${Math.round((Date.now() - t0) / 1000)} s`)
  return out
}

// --- bloc texte, sans l'auteur : c'est ce qui rend l'étiquette « même auteur » honnête ----
const textOf = (r: (typeof rows)[number]): string =>
  [r.text?.trim(), r.tags ? r.tags.split(',').join(', ') : null].filter(Boolean).join('\n').slice(0, 512)

const text = await cached('text-no-author', 384, async () => {
  const pipe = await tf.pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8' })
  const out: Float32Array[] = []
  for (let i = 0; i < rows.length; i += 32) {
    const slice = rows.slice(i, i + 32)
    const res = await pipe(
      slice.map((r) => `query: ${textOf(r)}`),
      { pooling: 'mean', normalize: true }
    )
    const data = res.data as Float32Array
    const dim = res.dims[res.dims.length - 1]
    slice.forEach((_, k) => out.push(unit(data.slice(k * dim, (k + 1) * dim))))
    if (i % 1600 === 0) console.log(`    texte ${i}/${rows.length}`)
  }
  return out
})

const encode = (name: string, id: string, family: 'siglip' | 'dino', dim: number): Promise<Float32Array[]> =>
  cached(name, dim, async () => {
    const proc = await tf.AutoProcessor.from_pretrained(id)
    const model =
      family === 'siglip'
        ? await tf.SiglipVisionModel.from_pretrained(id, { dtype: 'q8' })
        : await tf.AutoModel.from_pretrained(id, { dtype: 'q8' })
    const out: Float32Array[] = []
    for (const [i, r] of rows.entries()) {
      const image = await tf.RawImage.read(join(APP, 'media', r.thumb as string))
      const inputs = await proc(image)
      const res = (await model(inputs as never)) as Record<string, { data: Float32Array; dims: number[] }>
      if (family === 'siglip') out.push(unit(res.pooler_output.data))
      else {
        const h = res.last_hidden_state
        out.push(unit(h.data.slice(0, h.dims[h.dims.length - 1])))
      }
      if (i % 2000 === 0 && i > 0) console.log(`    ${name} ${i}/${rows.length}`)
    }
    return out
  })

const dino = await encode('dinov2', 'Xenova/dinov2-small', 'dino', 384)
const siglip = await encode('siglip', 'Xenova/siglip-base-patch16-224', 'siglip', 768)

/** Retire le fond commun d'un bloc : ne reste que ce qui distingue un post des autres. */
const centre = (block: Float32Array[]): Float32Array[] => {
  const dim = block[0].length
  const mean = new Float64Array(dim)
  for (const v of block) for (let k = 0; k < dim; k++) mean[k] += v[k] / block.length
  return block.map((v) => {
    const out = new Float32Array(dim)
    for (let k = 0; k < dim; k++) out[k] = v[k] - mean[k]
    return unit(out)
  })
}

writeFileSync(join(CACHE, 'rows.json'), JSON.stringify(rows.map((r) => ({ a: r.author, t: textOf(r).length }))))
console.log('\nblocs prêts — passage au réglage des poids')

// --- vérité de terrain : deux posts du même auteur devraient se retrouver voisins --------
const byAuthor = new Map<string, number[]>()
rows.forEach((r, i) => {
  const list = byAuthor.get(r.author as string)
  if (list) list.push(i)
  else byAuthor.set(r.author as string, [i])
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
/** `mats` : une matrice de similarités par bloc, requêtes × posts, à plat. */
const evaluate = (mats: Float32Array[], weights: number[], label: string): number => {
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
  const score = (total / sampled.length) * 100
  if (label) console.log(`  ${label.padEnd(46)} ${score.toFixed(1).padStart(5)} %`)
  return score
}

console.log('\nprécision@10 — part des 10 plus proches voisins qui partagent l’auteur\n')
console.log('sans centrage (ce que donnerait un mélange naïf) :')
const rawMats = [sims(text), sims(dino), sims(siglip)]
evaluate(rawMats, [1, 0, 0], 'texte seul')
evaluate(rawMats, [0, 1, 0], 'DINOv2 seul')
evaluate(rawMats, [0, 0, 1], 'SigLIP seul')
evaluate(rawMats, [1 / 3, 1 / 3, 1 / 3], 'les trois à poids égaux, non centrés')

console.log('\navec centrage :')
const cMats = [sims(centre(text)), sims(centre(dino)), sims(centre(siglip))]
evaluate(cMats, [1, 0, 0], 'texte seul')
evaluate(cMats, [0, 1, 0], 'DINOv2 seul')
evaluate(cMats, [0, 0, 1], 'SigLIP seul')
evaluate(cMats, [1 / 3, 1 / 3, 1 / 3], 'les trois à poids égaux, centrés')

console.log('\nbalayage des poids (centrés) :')
let bestScore = -1
let bestW: number[] = []
for (let a = 0; a <= 10; a++) {
  for (let b = 0; a + b <= 10; b++) {
    const c = 10 - a - b
    const w = [a / 10, b / 10, c / 10]
    const s = evaluate(cMats, w, '')
    if (s > bestScore) {
      bestScore = s
      bestW = w
    }
  }
}
console.log(
  `  meilleur : texte ${(bestW[0] * 100).toFixed(0)} % · DINOv2 ${(bestW[1] * 100).toFixed(0)} % · ` +
    `SigLIP ${(bestW[2] * 100).toFixed(0)} %  →  ${bestScore.toFixed(1)} %`
)
