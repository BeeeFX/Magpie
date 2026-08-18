import Database from 'better-sqlite3'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { projectSync, TUNING } from '../src/main/tagging/projection-core'

/**
 * Lire les images change-t-il la carte, ou seulement les vecteurs ?
 *
 * Vérité de terrain neutre — elle ne vient d'aucun embedding : deux posts d'un même auteur
 * devraient se retrouver proches. On projette avec le texte seul, puis avec le texte et
 * l'image, et on regarde de combien les posts d'un même auteur se resserrent.
 */

const APP = join(process.env['APPDATA'] ?? '', 'magpie')
const db = new Database(join(APP, 'magpie.db'), { readonly: true })
const rows = db
  .prepare(
    `SELECT p.id, p.author_handle AS author, e.vector,
            (SELECT m.thumb_path FROM media m
              WHERE m.post_id = p.id AND m.thumb_path IS NOT NULL
              ORDER BY m.idx LIMIT 1) AS thumb
       FROM posts p JOIN post_embeddings e ON e.post_id = p.id
      WHERE p.is_archived = 0`
  )
  .all() as { id: string; author: string | null; vector: Buffer; thumb: string | null }[]
db.close()

const width = rows[0].vector.byteLength / 4
const text = rows.map((r) => {
  const v = new Float32Array(r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength))
  let n = 0
  for (let i = 0; i < width; i++) n += v[i] * v[i]
  n = Math.sqrt(n) || 1
  const u = new Float32Array(width)
  for (let i = 0; i < width; i++) u[i] = v[i] / n
  return u
})

const tf = await import('@huggingface/transformers')
tf.env.cacheDir = join(APP, 'models')
tf.env.allowLocalModels = false
const proc = await tf.AutoProcessor.from_pretrained('Xenova/dinov2-small')
const vision = await tf.AutoModel.from_pretrained('Xenova/dinov2-small', { dtype: 'q8' })

const DIM = 384
const image: (Float32Array | null)[] = []
let done = 0
const t0 = Date.now()
for (const r of rows) {
  let vec: Float32Array | null = null
  if (r.thumb) {
    const path = join(APP, 'media', r.thumb)
    try {
      statSync(path)
      const raw = await tf.RawImage.read(path)
      const inputs = await proc(raw)
      const out = (await vision(inputs as never)) as { last_hidden_state: { data: Float32Array; dims: number[] } }
      const hidden = out.last_hidden_state
      const w = hidden.dims[hidden.dims.length - 1]
      const cls = hidden.data.slice(0, w)
      let n = 0
      for (let i = 0; i < w; i++) n += cls[i] * cls[i]
      n = Math.sqrt(n) || 1
      vec = new Float32Array(w)
      for (let i = 0; i < w; i++) vec[i] = cls[i] / n
    } catch {
      vec = null
    }
  }
  image.push(vec)
  if (++done % 500 === 0) {
    console.log(`  ${done}/${rows.length} images — ${Math.round((Date.now() - t0) / 1000)} s`)
  }
}
const withImage = image.filter(Boolean).length
console.log(`${withImage} posts illustrés sur ${rows.length}, encodés en ${Math.round((Date.now() - t0) / 1000)} s\n`)

let seed = 3
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const byAuthor = new Map<string, number[]>()
rows.forEach((r, i) => {
  if (!r.author) return
  const list = byAuthor.get(r.author)
  if (list) list.push(i)
  else byAuthor.set(r.author, [i])
})
const pairs: [number, number][] = []
for (const [, idx] of byAuthor) {
  if (idx.length < 2) continue
  for (let t = 0; t < Math.min(40, idx.length); t++) {
    const a = idx[Math.floor(rnd() * idx.length)]
    const b = idx[Math.floor(rnd() * idx.length)]
    if (a !== b) pairs.push([a, b])
  }
}

const evaluate = (label: string, build: (i: number) => Float32Array): void => {
  const vectors = new Map<string, Float32Array>()
  rows.forEach((r, i) => vectors.set(r.id, build(i)))
  const started = Date.now()
  const pts = projectSync(vectors, undefined, TUNING)
  const at = new Map(pts.map((p) => [p.id, p]))
  const xs = rows.map((r) => at.get(r.id)!.x)
  const ys = rows.map((r) => at.get(r.id)!.y)
  let same = 0
  for (const [a, b] of pairs) same += Math.hypot(xs[a] - xs[b], ys[a] - ys[b])
  same /= pairs.length
  let any = 0
  for (let t = 0; t < 20000; t++) {
    const a = Math.floor(rnd() * rows.length)
    const b = Math.floor(rnd() * rows.length)
    any += Math.hypot(xs[a] - xs[b], ys[a] - ys[b])
  }
  any /= 20000
  console.log(
    `  ${label.padEnd(34)} ${((1 - same / any) * 100).toFixed(0).padStart(3)} %  resserrement   (${Math.round((Date.now() - started) / 1000)} s)`
  )
}

// Deux blocs normalisés côte à côte : la distance devient la somme pondérée des deux
// ressemblances. Pas besoin que les deux modèles partagent un espace.
const mixed = (weight: number) => (i: number): Float32Array => {
  const out = new Float32Array(width + DIM)
  const img = image[i]
  // Sans image, le texte porte tout : sinon un post sans vignette dériverait vers zéro.
  const textWeight = img ? 1 - weight : 1
  for (let k = 0; k < width; k++) out[k] = text[i][k] * textWeight
  if (img) for (let k = 0; k < DIM; k++) out[width + k] = img[k] * weight
  return out
}

console.log('Posts d’un même auteur, resserrement sur la carte :')
evaluate('texte seul (aujourd’hui)', (i) => text[i])
evaluate('texte 70 % + image 30 %', mixed(0.3))
evaluate('texte 50 % + image 50 %', mixed(0.5))
evaluate('texte 30 % + image 70 %', mixed(0.7))
evaluate('image seule', (i) => image[i] ?? text[i].slice(0, DIM))
