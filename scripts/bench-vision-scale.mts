import Database from 'better-sqlite3'
import { join } from 'node:path'
import { statSync } from 'node:fs'

/**
 * Trois signaux, trois échelles — et c'est le piège.
 *
 * Mettre trois blocs normalisés côte à côte ne les fait pas peser pareil. Ce qui décide du
 * classement des voisins n'est pas la moyenne des ressemblances mais leur *étalement* : un
 * bloc dont les cosinus vont de 0,80 à 0,88 ne départage presque rien, tandis qu'un bloc
 * étalé de 0,1 à 0,9 impose son ordre. Des poids égaux ne donnent donc pas une influence
 * égale. On mesure ici l'étalement de chacun avant et après centrage — retirer le vecteur
 * moyen du bloc, ce qui enlève le fond commun et ne laisse que ce qui distingue.
 */

const APP = join(process.env['APPDATA'] ?? '', 'magpie')
const db = new Database(join(APP, 'magpie.db'), { readonly: true })
const rows = db
  .prepare(
    `SELECT p.id, p.text, e.vector,
            (SELECT m.thumb_path FROM media m
              WHERE m.post_id = p.id AND m.thumb_path IS NOT NULL ORDER BY m.idx LIMIT 1) AS thumb
       FROM posts p JOIN post_embeddings e ON e.post_id = p.id
      WHERE p.is_archived = 0`
  )
  .all() as { id: string; text: string | null; vector: Buffer; thumb: string | null }[]
db.close()

let seed = 5
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const sample = rows
  .filter((r) => {
    if (!r.thumb) return false
    try {
      statSync(join(APP, 'media', r.thumb))
      return true
    } catch {
      return false
    }
  })
  .sort(() => rnd() - 0.5)
  .slice(0, 400)

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

const text = sample.map((r) =>
  unit(new Float32Array(r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength)))
)

const encode = async (id: string, family: 'siglip' | 'dino'): Promise<Float32Array[]> => {
  const proc = await tf.AutoProcessor.from_pretrained(id)
  const model =
    family === 'siglip'
      ? await tf.SiglipVisionModel.from_pretrained(id, { dtype: 'q8' })
      : await tf.AutoModel.from_pretrained(id, { dtype: 'q8' })
  const out: Float32Array[] = []
  for (const r of sample) {
    const image = await tf.RawImage.read(join(APP, 'media', r.thumb as string))
    const inputs = await proc(image)
    const res = (await model(inputs as never)) as Record<string, { data: Float32Array; dims: number[] }>
    if (family === 'siglip') out.push(unit(res.pooler_output.data))
    else {
      const h = res.last_hidden_state
      out.push(unit(h.data.slice(0, h.dims[h.dims.length - 1])))
    }
  }
  return out
}
const dino = await encode('Xenova/dinov2-small', 'dino')
const siglip = await encode('Xenova/siglip-base-patch16-224', 'siglip')

/** Retire le fond commun : ce qui reste est ce qui distingue un post des autres. */
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

const spread = (block: Float32Array[]): { mean: number; sd: number } => {
  const dim = block[0].length
  const vals: number[] = []
  for (let t = 0; t < 8000; t++) {
    const a = block[Math.floor(rnd() * block.length)]
    const b = block[Math.floor(rnd() * block.length)]
    let s = 0
    for (let k = 0; k < dim; k++) s += a[k] * b[k]
    vals.push(s)
  }
  const m = vals.reduce((s, v) => s + v, 0) / vals.length
  return { mean: m, sd: Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length) }
}

console.log(`${sample.length} posts illustrés\n`)
console.log('Cosinus entre deux posts au hasard — c’est l’écart-type qui décide du classement :')
console.log('bloc            brut : moyenne / écart-type      centré : moyenne / écart-type')
for (const [name, block] of [
  ['texte  ', text],
  ['DINOv2 ', dino],
  ['SigLIP ', siglip]
] as const) {
  const raw = spread(block)
  const cen = spread(centre(block))
  console.log(
    `  ${name}        ${raw.mean.toFixed(3)} / ${raw.sd.toFixed(3)}` +
      `                 ${cen.mean.toFixed(3)} / ${cen.sd.toFixed(3)}`
  )
}
console.log('\nUn bloc dont l’écart-type est trois fois celui d’un autre impose trois fois plus')
console.log('son ordre, à poids égal. Le centrage ramène les trois dans le même registre.')
