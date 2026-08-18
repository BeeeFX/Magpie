import Database from 'better-sqlite3'
import { join } from 'node:path'
import { statSync, readdirSync } from 'node:fs'

/**
 * Quel encodeur d'images pour la carte ?
 *
 * Départagés sur les vraies vignettes, avec une vérité de terrain qu'on possède déjà : deux
 * images d'un même post — un carrousel — montrent presque toujours la même chose, et deux
 * posts d'un même auteur se ressemblent souvent. Un bon encodeur doit rapprocher ces paires
 * bien plus que deux images au hasard. On mesure l'écart en écarts-types, pas l'impression.
 *
 * ⚠️ Chaque famille se lit différemment. Une première version passait par le pipeline
 * générique : SigLIP y renvoyait 150 528 valeurs — 3 × 224 × 224, c'est-à-dire les pixels
 * d'entrée — et DINOv2 ses 257 jetons non réduits. On comparait des images brutes, ce qui
 * flattait les carrousels sans rien dire du modèle. D'où l'accès explicite ci-dessous.
 */

const DIR = join(process.env['APPDATA'] ?? '', 'magpie', 'media')
const db = new Database(join(process.env['APPDATA'] ?? '', 'magpie', 'magpie.db'), { readonly: true })
const rows = db
  .prepare(
    `SELECT m.post_id, m.idx, m.thumb_path, p.author_handle AS author
       FROM media m JOIN posts p ON p.id = m.post_id
      WHERE m.thumb_path IS NOT NULL AND p.is_archived = 0`
  )
  .all() as { post_id: string; idx: number; thumb_path: string; author: string | null }[]
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
    statSync(join(DIR, p.thumb_path))
    return true
  } catch {
    return false
  }
})

const modelsDir = join(process.env['APPDATA'] ?? '', 'magpie', 'models')
const dirSize = (name: string): number => {
  let total = 0
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else total += statSync(full).size
    }
  }
  try {
    walk(join(modelsDir, name))
  } catch {
    return 0
  }
  return total
}

type Family = 'clip' | 'siglip' | 'dino'

async function bench(id: string, family: Family): Promise<void> {
  const tf = await import('@huggingface/transformers')
  tf.env.cacheDir = modelsDir
  tf.env.allowLocalModels = false
  let model: { (input: unknown): Promise<Record<string, { data: Float32Array; dims: number[] }>> }
  let processor: (image: unknown) => Promise<Record<string, unknown>>
  try {
    const proc = await tf.AutoProcessor.from_pretrained(id)
    processor = (image) => proc(image) as Promise<Record<string, unknown>>
    if (family === 'clip') {
      const m = await tf.CLIPVisionModelWithProjection.from_pretrained(id, { dtype: 'q8' })
      model = (input) => m(input as never) as never
    } else if (family === 'siglip') {
      const m = await tf.SiglipVisionModel.from_pretrained(id, { dtype: 'q8' })
      model = (input) => m(input as never) as never
    } else {
      const m = await tf.AutoModel.from_pretrained(id, { dtype: 'q8' })
      model = (input) => m(input as never) as never
    }
  } catch (err) {
    console.log(`  ${id.padEnd(42)} indisponible — ${(err as Error).message.slice(0, 60)}`)
    return
  }

  const vecs: Float32Array[] = []
  const t0 = Date.now()
  for (const f of files) {
    const image = await tf.RawImage.read(join(DIR, f.thumb_path))
    const inputs = await processor(image)
    const out = await model(inputs)
    let raw: Float32Array
    if (family === 'clip') raw = out.image_embeds.data
    else if (family === 'siglip') raw = out.pooler_output.data
    else {
      // DINOv2 : le jeton CLS porte le résumé de l'image, les suivants sont des zones.
      const hidden = out.last_hidden_state
      const width = hidden.dims[hidden.dims.length - 1]
      raw = hidden.data.slice(0, width)
    }
    let n = 0
    for (let i = 0; i < raw.length; i++) n += raw[i] * raw[i]
    n = Math.sqrt(n) || 1
    const u = new Float32Array(raw.length)
    for (let i = 0; i < raw.length; i++) u[i] = raw[i] / n
    vecs.push(u)
  }
  const ms = (Date.now() - t0) / files.length

  const cos = (a: number, b: number): number => {
    let s = 0
    for (let k = 0; k < vecs[a].length; k++) s += vecs[a][k] * vecs[b][k]
    return s
  }
  const samePost: number[] = []
  const sameAuthor: number[] = []
  const random: number[] = []
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      if (files[i].post_id === files[j].post_id) samePost.push(cos(i, j))
      else if (files[i].author && files[i].author === files[j].author) sameAuthor.push(cos(i, j))
      else if (rnd() < 0.02) random.push(cos(i, j))
    }
  }
  const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length)
  const sd = (a: number[]): number => {
    const m = mean(a)
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length))
  }
  const gap = (a: number[]): number => (mean(a) - mean(random)) / (sd(random) || 1)
  console.log(
    `  ${id.padEnd(42)} ${String(vecs[0].length).padStart(4)}d ${ms.toFixed(0).padStart(4)} ms  ` +
      `même post ${gap(samePost).toFixed(2).padStart(5)} σ   même auteur ${gap(sameAuthor).toFixed(2).padStart(5)} σ   ` +
      `${(dirSize(id) / 1048576).toFixed(0).padStart(3)} Mo`
  )
}

console.log(`${files.length} vignettes réelles — carrousels et auteurs répétés inclus\n`)
console.log('modèle                                       dim  vitesse   écart au hasard              poids')
for (const [id, family] of [
  ['Xenova/clip-vit-base-patch32', 'clip'],
  ['Xenova/siglip-base-patch16-224', 'siglip'],
  ['onnx-community/siglip2-base-patch16-224-ONNX', 'siglip'],
  ['onnx-community/siglip2-base-patch16-256-ONNX', 'siglip'],
  ['Xenova/dinov2-small', 'dino'],
  ['onnx-community/dinov2-with-registers-small', 'dino']
] as const) {
  await bench(id, family)
}
