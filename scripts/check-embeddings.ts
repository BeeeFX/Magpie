import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { env, pipeline } from '@huggingface/transformers'

/**
 * Éprouve le modèle d'embedding sur la vraie bibliothèque.
 *
 * À part des autres vérifications parce qu'il télécharge ~120 Mo au premier lancement : on ne
 * l'impose pas à chaque `npm run typecheck`. Il répond à deux questions qu'on ne peut pas
 * trancher sur le papier — combien de temps pour toute une bibliothèque, et le modèle
 * rapproche-t-il vraiment ce qui parle du même sujet sans partager un mot.
 *
 * La similarité mesurée est la similarité **recentrée**, celle que l'application utilise.
 * Brute, e5 tasse tout entre 0,78 et 0,88 et ne sépare rien d'exploitable.
 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Échec : ${message}`)
  console.log(`  ✓ ${message}`)
}

const MODEL = 'Xenova/multilingual-e5-small'
const SAMPLE = 200

/** Un fond de sujets variés : sans lui, le centre du nuage n'a aucun sens. */
const BACKGROUND = [
  'un chat qui dort sur un canapé',
  'nouvelle voiture de sport au salon',
  'architecture brutaliste à Londres',
  'analyse du dernier match de football',
  'comment investir son premier salaire',
  'randonnée en montagne au lever du soleil',
  'critique du dernier film de science-fiction',
  'meilleur casque audio sans fil'
]

const PAIRS: [string, string, 'proche' | 'loin'][] = [
  ['Blender donut tutorial', 'geometry nodes procedural workflow', 'proche'],
  ['recette de pâtes à la carbonara', 'pasta recipe from Rome', 'proche'],
  ['skateboard kickflip street session', 'ollie grind at the skatepark', 'proche'],
  ['Blender donut tutorial', 'gym workout leg day routine', 'loin'],
  ['ComfyUI Stable Diffusion workflow', 'baking sourdough bread at home', 'loin'],
  ['street photography in Tokyo', 'gym workout leg day routine', 'loin']
]

function centre(vectors: Float32Array[]): Float32Array[] {
  const width = vectors[0].length
  const mean = new Float32Array(width)
  for (const vector of vectors) {
    for (let i = 0; i < width; i += 1) mean[i] += vector[i] / vectors.length
  }
  return vectors.map((vector) => {
    const out = new Float32Array(width)
    let norm = 0
    for (let i = 0; i < width; i += 1) {
      out[i] = vector[i] - mean[i]
      norm += out[i] * out[i]
    }
    norm = Math.sqrt(norm) || 1
    for (let i = 0; i < width; i += 1) out[i] /= norm
    return out
  })
}

function dot(a: Float32Array, b: Float32Array): number {
  let total = 0
  for (let i = 0; i < a.length; i += 1) total += a[i] * b[i]
  return total
}

const average = (list: number[]): number => list.reduce((sum, x) => sum + x, 0) / list.length

async function main(): Promise<void> {
  console.log('Vérification des embeddings locaux')
  env.cacheDir = join(tmpdir(), 'magpie-model-check')
  env.allowLocalModels = false

  let started = performance.now()
  const encode = await pipeline('feature-extraction', MODEL, { dtype: 'q8' })
  console.log(`  modèle prêt en ${Math.round(performance.now() - started)} ms`)

  const embed = async (texts: string[]): Promise<Float32Array[]> => {
    const output = await encode(
      texts.map((text) => `query: ${text}`),
      { pooling: 'mean', normalize: true }
    )
    const width = output.dims[output.dims.length - 1]
    const data = output.data as Float32Array
    return texts.map((_, index) => data.slice(index * width, (index + 1) * width))
  }

  console.log('\nsens')
  const flat = [...PAIRS.flatMap(([a, b]) => [a, b]), ...BACKGROUND]
  const raw = await embed(flat)
  const centred = centre(raw)

  const score = (list: Float32Array[], index: number): number =>
    dot(list[index * 2], list[index * 2 + 1])
  const near: number[] = []
  const far: number[] = []
  const rawNear: number[] = []
  const rawFar: number[] = []
  PAIRS.forEach(([, , kind], index) => {
    ;(kind === 'proche' ? near : far).push(score(centred, index))
    ;(kind === 'proche' ? rawNear : rawFar).push(score(raw, index))
  })

  const rawGap = average(rawNear) - average(rawFar)
  const gap = average(near) - average(far)
  console.log(`  brut : écart ${rawGap.toFixed(3)} — recentré : écart ${gap.toFixed(3)}`)
  assert(gap > rawGap * 2, 'le recentrage sépare nettement mieux que la similarité brute')
  assert(gap > 0.15, `l'écart recentré dépasse 0,15 (${gap.toFixed(3)})`)
  assert(
    Math.min(...near) > Math.max(...far),
    `aucune paire étrangère ne dépasse une paire proche ` +
      `(${Math.min(...near).toFixed(3)} contre ${Math.max(...far).toFixed(3)})`
  )
  assert(score(centred, 1) > 0.2, `le même sujet se retrouve d'une langue à l'autre`)

  console.log('\ncadence')
  const path = join(process.env['APPDATA'] ?? '', 'magpie', 'magpie.db')
  let texts: string[] = []
  try {
    const db = new Database(path, { readonly: true })
    texts = (
      db
        .prepare(
          `SELECT p.text FROM posts p
            WHERE p.is_archived = 0 AND p.text IS NOT NULL AND length(trim(p.text)) > 20
            ORDER BY p.discovered_at DESC LIMIT ?`
        )
        .all(SAMPLE) as { text: string }[]
    ).map((row) => row.text.slice(0, 512))
    db.close()
  } catch {
    console.log('  (pas de bibliothèque locale : mesure sur des textes synthétiques)')
  }
  if (texts.length < SAMPLE) {
    texts = Array.from(
      { length: SAMPLE },
      (_, index) => `Un post de démonstration numéro ${index} qui parle de cuisine et de voyage.`
    )
  }

  started = performance.now()
  for (let start = 0; start < texts.length; start += 32) {
    await embed(texts.slice(start, start + 32))
  }
  const elapsed = performance.now() - started
  const perPost = elapsed / texts.length
  console.log(`  ${texts.length} posts en ${Math.round(elapsed)} ms → ${perPost.toFixed(1)} ms/post`)
  console.log(`  extrapolation 10 000 posts : ${((perPost * 10_000) / 1000).toFixed(0)} s`)
  assert(perPost < 60, `l'encodage reste sous 60 ms par post (${perPost.toFixed(1)} ms)`)

  console.log('\nTout est vert.')
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
