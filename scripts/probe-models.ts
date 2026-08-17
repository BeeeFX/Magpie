import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { env, pipeline } from '@huggingface/transformers'

/** Comparatif jetable : quel modèle sépare vraiment, et le recentrage aide-t-il. */

env.cacheDir = join(tmpdir(), 'magpie-model-check')
env.allowLocalModels = false

const PAIRS: [string, string, 'proche' | 'loin'][] = [
  ['Blender donut tutorial', 'geometry nodes procedural workflow', 'proche'],
  ['recette de pâtes à la carbonara', 'pasta recipe from Rome', 'proche'],
  ['skateboard kickflip street session', 'ollie grind at the skatepark', 'proche'],
  ['DJ set on CDJs with Rekordbox', 'turntable routine and beatmatching', 'proche'],
  ['Blender donut tutorial', 'gym workout leg day routine', 'loin'],
  ['skateboard kickflip street session', 'guitar pedalboard riff', 'loin'],
  ['ComfyUI Stable Diffusion workflow', 'baking sourdough bread at home', 'loin'],
  ['street photography in Tokyo', 'gym workout leg day routine', 'loin']
]

// Un fond de textes variés pour estimer le centre du nuage.
const BACKGROUND = [
  'un chat qui dort sur un canapé',
  'nouvelle voiture de sport présentée au salon',
  'architecture brutaliste à Londres',
  'maquillage du soir en trois minutes',
  'analyse du dernier match de football',
  'comment investir son premier salaire',
  'randonnée en montagne au lever du soleil',
  'critique du dernier film de science-fiction',
  'apprendre le japonais en six mois',
  'meilleur casque audio sans fil de 2026'
]

async function evaluate(model: string, dtype: 'q8' | 'fp32'): Promise<void> {
  const started = performance.now()
  const encode = await pipeline('feature-extraction', model, { dtype })
  const prefix = model.includes('e5') ? 'query: ' : ''

  const embed = async (texts: string[]): Promise<Float32Array[]> => {
    const out = await encode(
      texts.map((t) => prefix + t),
      { pooling: 'mean', normalize: true }
    )
    const width = out.dims[out.dims.length - 1]
    return texts.map((_, i) => (out.data as Float32Array).slice(i * width, (i + 1) * width))
  }

  const texts = [...PAIRS.flatMap(([a, b]) => [a, b]), ...BACKGROUND]
  const vectors = await embed(texts)
  const width = vectors[0].length

  // Centre du nuage : les espaces d'embedding sont anisotropes, tout se serre dans un cône
  // étroit. Retirer le centre puis renormaliser étale les distances sans changer l'ordre.
  const centre = new Float32Array(width)
  for (const v of vectors) for (let i = 0; i < width; i++) centre[i] += v[i] / vectors.length
  const centred = vectors.map((v) => {
    const out = new Float32Array(width)
    let norm = 0
    for (let i = 0; i < width; i++) {
      out[i] = v[i] - centre[i]
      norm += out[i] * out[i]
    }
    norm = Math.sqrt(norm) || 1
    for (let i = 0; i < width; i++) out[i] /= norm
    return out
  })

  const dot = (a: Float32Array, b: Float32Array): number => {
    let t = 0
    for (let i = 0; i < a.length; i++) t += a[i] * b[i]
    return t
  }

  const report = (label: string, list: Float32Array[]): void => {
    console.log(`  --- ${label}`)
    const near: number[] = []
    const far: number[] = []
    PAIRS.forEach(([a, b, kind], index) => {
      const score = dot(list[index * 2], list[index * 2 + 1])
      ;(kind === 'proche' ? near : far).push(score)
      console.log(
        `    ${score.toFixed(3)}  ${kind.padEnd(7)} ${a.slice(0, 34).padEnd(35)} / ${b.slice(0, 34)}`
      )
    })
    const avg = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length
    console.log(
      `    → proche ${avg(near).toFixed(3)} | loin ${avg(far).toFixed(3)} | ` +
        `écart ${(avg(near) - avg(far)).toFixed(3)} | ` +
        `pire proche ${Math.min(...near).toFixed(3)} vs meilleur loin ${Math.max(...far).toFixed(3)}`
    )
  }

  console.log(`\n${model} (${dtype}) — chargé en ${Math.round(performance.now() - started)} ms`)
  report('brut', vectors)
  report('recentré', centred)
}

async function main(): Promise<void> {
  for (const model of [
    'Xenova/multilingual-e5-small',
    'Xenova/paraphrase-multilingual-MiniLM-L12-v2'
  ]) {
    try {
      await evaluate(model, 'q8')
    } catch (error) {
      console.log(`\n${model} — indisponible : ${error instanceof Error ? error.message : error}`)
    }
  }
}

void main()
