import Database from 'better-sqlite3'
import { join } from 'node:path'
import { statSync } from 'node:fs'

/**
 * Deux encodeurs valent-ils mieux qu'un ?
 *
 * Même banc que `bench-vision`, même vérité de terrain : deux images d'un même carrousel
 * montrent presque toujours la même chose, deux posts d'un même auteur se ressemblent souvent.
 * Ici la comparaison est loyale — aucun des encodeurs ne lit le texte, ils sont donc tous
 * aveugles de la même manière.
 *
 * On mesure chaque modèle seul, puis les paires mises côte à côte après normalisation : la
 * ressemblance devient alors la moyenne des deux ressemblances, sans qu'ils aient besoin de
 * partager un espace.
 */

const APP = join(process.env['APPDATA'] ?? '', 'magpie')
const db = new Database(join(APP, 'magpie.db'), { readonly: true })
const rows = db
  .prepare(
    `SELECT m.post_id, m.thumb_path, p.author_handle AS author
       FROM media m JOIN posts p ON p.id = m.post_id
      WHERE m.thumb_path IS NOT NULL AND p.is_archived = 0`
  )
  .all() as { post_id: string; thumb_path: string; author: string | null }[]
db.close()

let seed = 1234
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const byPost = new Map<string, typeof rows>()
for (const r of rows) {
  const list = byPost.get(r.post_id)
  if (list) list.push(r)
  else byPost.set(r.post_id, [r])
}
const carousels = [...byPost.values()].filter((g) => g.length >= 2)
const byAuthor = new Map<string, string[]>()
for (const [id, group] of byPost) {
  const a = group[0].author
  if (!a) continue
  const list = byAuthor.get(a)
  if (list) list.push(id)
  else byAuthor.set(a, [id])
}
const authors = [...byAuthor.entries()].filter(([, ids]) => ids.length >= 4)
const picked: typeof rows = []
const seen = new Set<string>()
const take = (r: (typeof rows)[number]): void => {
  if (seen.has(r.thumb_path)) return
  seen.add(r.thumb_path)
  picked.push(r)
}
for (let i = 0; i < 90 && i < carousels.length; i++) {
  const g = carousels[Math.floor(rnd() * carousels.length)]
  take(g[0])
  take(g[1])
}
for (let i = 0; i < 70 && i < authors.length; i++) {
  const [, ids] = authors[Math.floor(rnd() * authors.length)]
  for (const id of ids.slice(0, 3)) take(byPost.get(id)![0])
}
while (picked.length < 400) take(rows[Math.floor(rnd() * rows.length)])
const files = picked.filter((p) => {
  try {
    statSync(join(APP, 'media', p.thumb_path))
    return true
  } catch {
    return false
  }
})

const tf = await import('@huggingface/transformers')
tf.env.cacheDir = join(APP, 'models')
tf.env.allowLocalModels = false

async function encode(id: string, family: 'siglip' | 'dino'): Promise<{ vecs: Float32Array[]; ms: number }> {
  const proc = await tf.AutoProcessor.from_pretrained(id)
  const model =
    family === 'siglip'
      ? await tf.SiglipVisionModel.from_pretrained(id, { dtype: 'q8' })
      : await tf.AutoModel.from_pretrained(id, { dtype: 'q8' })
  const vecs: Float32Array[] = []
  const t0 = Date.now()
  for (const f of files) {
    const image = await tf.RawImage.read(join(APP, 'media', f.thumb_path))
    const inputs = await proc(image)
    const out = (await model(inputs as never)) as Record<string, { data: Float32Array; dims: number[] }>
    let raw: Float32Array
    if (family === 'siglip') raw = out.pooler_output.data
    else {
      const h = out.last_hidden_state
      raw = h.data.slice(0, h.dims[h.dims.length - 1])
    }
    let n = 0
    for (let i = 0; i < raw.length; i++) n += raw[i] * raw[i]
    n = Math.sqrt(n) || 1
    const u = new Float32Array(raw.length)
    for (let i = 0; i < raw.length; i++) u[i] = raw[i] / n
    vecs.push(u)
  }
  return { vecs, ms: (Date.now() - t0) / files.length }
}

const score = (vecs: Float32Array[], label: string, ms: number): void => {
  const dim = vecs[0].length
  const cos = (a: number, b: number): number => {
    let s = 0
    for (let k = 0; k < dim; k++) s += vecs[a][k] * vecs[b][k]
    return s
  }
  const samePost: number[] = []
  const sameAuthor: number[] = []
  const random: number[] = []
  let s2 = seed
  const roll = (): number => ((s2 = (s2 * 1103515245 + 12345) % 2147483648) / 2147483648)
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      if (files[i].post_id === files[j].post_id) samePost.push(cos(i, j))
      else if (files[i].author && files[i].author === files[j].author) sameAuthor.push(cos(i, j))
      else if (roll() < 0.02) random.push(cos(i, j))
    }
  }
  const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length)
  const sd = (a: number[]): number => {
    const m = mean(a)
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length))
  }
  const gap = (a: number[]): number => (mean(a) - mean(random)) / (sd(random) || 1)
  console.log(
    `  ${label.padEnd(36)} ${String(dim).padStart(4)}d  ${ms.toFixed(0).padStart(3)} ms   ` +
      `même post ${gap(samePost).toFixed(2).padStart(5)} σ   même auteur ${gap(sameAuthor).toFixed(2).padStart(5)} σ`
  )
}

/** Deux blocs normalisés côte à côte, chacun ramené à la même longueur : la ressemblance
 *  totale est alors la moyenne exacte des deux, aucun ne pèse plus que l'autre. */
const blend = (a: Float32Array[], b: Float32Array[]): Float32Array[] =>
  a.map((va, i) => {
    const vb = b[i]
    const out = new Float32Array(va.length + vb.length)
    const w = Math.SQRT1_2
    for (let k = 0; k < va.length; k++) out[k] = va[k] * w
    for (let k = 0; k < vb.length; k++) out[va.length + k] = vb[k] * w
    return out
  })

console.log(`${files.length} vignettes réelles\n`)
const small = await encode('Xenova/dinov2-small', 'dino')
const base = await encode('Xenova/dinov2-base', 'dino')
const siglip = await encode('Xenova/siglip-base-patch16-224', 'siglip')

console.log('seuls :')
score(small.vecs, 'DINOv2-small', small.ms)
score(base.vecs, 'DINOv2-base', base.ms)
score(siglip.vecs, 'SigLIP base', siglip.ms)
console.log('\nà deux :')
score(blend(small.vecs, siglip.vecs), 'DINOv2-small + SigLIP', small.ms + siglip.ms)
score(blend(base.vecs, siglip.vecs), 'DINOv2-base + SigLIP', base.ms + siglip.ms)
score(blend(small.vecs, base.vecs), 'DINOv2-small + DINOv2-base', small.ms + base.ms)
