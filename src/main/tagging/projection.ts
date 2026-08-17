import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { UMAP } from 'umap-js'

/**
 * Projection des vecteurs de sens en deux dimensions.
 *
 * C'est ce qui donne ses coordonnées à la carte. Le choix qui compte : la position vient de
 * la projection, pas d'une simulation à ressorts. Une physique déciderait de l'emplacement
 * des points et les îles ne montreraient alors que la physique ; ici la distance à l'écran
 * *est* la proximité de sens, et les îles sont réelles.
 *
 * Le rebond de la carte est de l'interaction — inertie, zoom élastique, atterrissage amorti —
 * appliqué par-dessus des positions qui ne bougent pas.
 */

/** Au-delà, UMAP coûte beaucoup pour un gain nul : le bruit des dernières dimensions ne
 *  structure rien. Réduire d'abord accélère la suite d'un ordre de grandeur. */
const PCA_DIMS = 48

export interface ProjectedPoint {
  id: string
  x: number
  y: number
}

/**
 * Analyse en composantes principales, par itérations de puissance.
 *
 * Suffisante ici : on ne cherche pas une décomposition exacte, seulement à jeter les
 * directions qui ne portent rien avant de passer la main à UMAP. Sert aussi de repli complet
 * quand la bibliothèque est trop petite pour qu'UMAP ait du sens.
 */
function reduce(vectors: Float32Array[], dims: number): Float32Array[] {
  const width = vectors[0].length
  const target = Math.min(dims, width, vectors.length)
  const mean = new Float32Array(width)
  for (const vector of vectors) {
    for (let i = 0; i < width; i += 1) mean[i] += vector[i] / vectors.length
  }
  const centred = vectors.map((vector) => {
    const out = new Float32Array(width)
    for (let i = 0; i < width; i += 1) out[i] = vector[i] - mean[i]
    return out
  })

  const components: Float32Array[] = []
  for (let axis = 0; axis < target; axis += 1) {
    let direction = new Float32Array(width)
    // Départ déterministe : deux analyses de la même bibliothèque doivent donner la même
    // carte, sinon les points sautent d'une ouverture à l'autre sans que rien ait changé.
    for (let i = 0; i < width; i += 1) direction[i] = Math.sin((axis + 1) * (i + 1))
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const next = new Float32Array(width)
      for (const vector of centred) {
        let dot = 0
        for (let i = 0; i < width; i += 1) dot += vector[i] * direction[i]
        for (let i = 0; i < width; i += 1) next[i] += dot * vector[i]
      }
      // Orthogonalisation vis-à-vis des axes déjà trouvés.
      for (const previous of components) {
        let dot = 0
        for (let i = 0; i < width; i += 1) dot += next[i] * previous[i]
        for (let i = 0; i < width; i += 1) next[i] -= dot * previous[i]
      }
      let norm = 0
      for (let i = 0; i < width; i += 1) norm += next[i] * next[i]
      norm = Math.sqrt(norm)
      if (norm < 1e-9) break
      for (let i = 0; i < width; i += 1) next[i] /= norm
      direction = next
    }
    components.push(direction)
  }

  return centred.map((vector) => {
    const out = new Float32Array(components.length)
    for (const [axis, component] of components.entries()) {
      let dot = 0
      for (let i = 0; i < width; i += 1) dot += vector[i] * component[i]
      out[axis] = dot
    }
    return out
  })
}

/** Ramène le nuage dans un carré unité, en gardant les proportions. */
function normalise(points: number[][]): { x: number; y: number }[] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  // Une seule échelle pour les deux axes : sinon un nuage allongé serait étiré et les
  // distances affichées ne vaudraient plus rien.
  const span = Math.max(maxX - minX, maxY - minY) || 1
  const offsetX = (span - (maxX - minX)) / 2
  const offsetY = (span - (maxY - minY)) / 2
  return points.map(([x, y]) => ({
    x: (x - minX + offsetX) / span,
    y: (y - minY + offsetY) / span
  }))
}

/**
 * Le calcul lui-même. Synchrone, parce qu'il vit dans un fil séparé où bloquer ne gêne
 * personne — et exporté à part pour rester mesurable sans lancer de fil.
 */
export function projectSync(
  vectors: Map<string, Float32Array>,
  onProgress?: (done: number, total: number) => void
): ProjectedPoint[] {
  const ids = [...vectors.keys()]
  if (ids.length === 0) return []
  const raw = ids.map((id) => vectors.get(id) as Float32Array)

  if (ids.length < 8) {
    // Trop peu de voisins pour qu'UMAP ait un sens : deux axes principaux suffisent.
    const reduced = reduce(raw, 2)
    const flat = reduced.map((vector) => [vector[0] ?? 0, vector[1] ?? 0])
    return normalise(flat).map((point, index) => ({ id: ids[index], ...point }))
  }

  const reduced = reduce(raw, PCA_DIMS)
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors: Math.min(15, ids.length - 1),
    minDist: 0.1,
    // Graine fixe : la carte doit être la même d'une ouverture à l'autre.
    random: mulberry32(0x5eed)
  })
  const total = umap.initializeFit(reduced.map((vector) => Array.from(vector)))
  for (let step = 0; step < total; step += 1) {
    umap.step()
    if (step % 64 === 63) onProgress?.(step + 1, total)
  }
  onProgress?.(total, total)
  return normalise(umap.getEmbedding()).map((point, index) => ({ id: ids[index], ...point }))
}

/**
 * Lance la projection dans un fil et rend la main tout du long.
 *
 * Les vecteurs partent à plat en un seul transfert : passer neuf mille tableaux séparés
 * coûterait plus cher en sérialisation que le calcul lui-même.
 */
export function project(
  vectors: Map<string, Float32Array>,
  onProgress?: (done: number, total: number) => void
): Promise<ProjectedPoint[]> {
  const ids = [...vectors.keys()]
  if (ids.length === 0) return Promise.resolve([])
  const width = vectors.values().next().value?.length ?? 0
  const flat = new Float32Array(ids.length * width)
  ids.forEach((id, index) => flat.set(vectors.get(id) as Float32Array, index * width))

  /* En version installée, `__dirname` pointe dans l'archive asar. Le fichier y est bien
     redirigé vers sa copie déballée pour les lectures, mais un fil d'exécution résout ses
     propres imports et cette redirection n'est pas garantie. On vise donc directement le
     chemin déballé : c'est le même fichier, sans la question. */
  const here = __dirname.includes('app.asar')
    ? __dirname.replace('app.asar', 'app.asar.unpacked')
    : __dirname
  const script = join(here, 'projection.worker.js')

  return new Promise<ProjectedPoint[]>((done, fail) => {
    const worker = new Worker(script, {
      workerData: { ids, flat, width },
      transferList: [flat.buffer]
    })
    /* Sans borne, un fil qui ne répond pas laisse l'écran sur son indicateur pour toujours —
       c'est exactement ce qui s'est produit en version installée. Mieux vaut échouer et le
       dire que faire attendre dix minutes devant un rond qui tourne. */
    const guard = setTimeout(() => {
      void worker.terminate()
      fail(new Error(`Projection sans réponse après trois minutes (${script}).`))
    }, 180_000)
    const resolve = (value: ProjectedPoint[]): void => {
      clearTimeout(guard)
      done(value)
    }
    const reject = (error: Error): void => {
      clearTimeout(guard)
      fail(error)
    }
    worker.on('message', (message: { type: string; points?: ProjectedPoint[]; done?: number; total?: number }) => {
      if (message.type === 'progress') onProgress?.(message.done ?? 0, message.total ?? 0)
      else if (message.type === 'done') resolve(message.points ?? [])
    })
    worker.on('error', reject)
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Projection interrompue (code ${code}).`))
    })
  })
}

/** Générateur déterministe, pour qu'une même bibliothèque donne toujours la même carte. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
