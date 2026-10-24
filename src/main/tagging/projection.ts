import { Worker } from 'node:worker_threads'
import { app } from 'electron'
import { join } from 'node:path'
import type { ProjectedPoint } from './projection-core'

export { placeSync, projectSync, TUNING, type ProjectedPoint } from './projection-core'

/**
 * Où trouver le script du fil, quel que soit l'empaquetage.
 *
 * Surtout pas `__dirname` : le bundler extrait cette fonction dans `out/main/chunks/`, donc
 * `__dirname` y désigne le dossier des morceaux et non celui du script. C'est exactement
 * l'erreur qu'on a eue en version installée — « Cannot find module …/chunks/projection.worker.js ».
 *
 * On part donc de la racine de l'application, qui est stable dans les deux cas, et on vise la
 * copie déballée : un fil résout ses propres imports, sans la redirection asar du processus.
 */
export function workerScriptPath(appPath: string): string {
  const root = appPath.includes('app.asar')
    ? appPath.replace('app.asar', 'app.asar.unpacked')
    : appPath
  return join(root, 'out', 'main', 'projection.worker.js')
}

export function project(
  vectors: Map<string, Float32Array>,
  onProgress?: (done: number, total: number) => void
): Promise<ProjectedPoint[]> {
  const ids = [...vectors.keys()]
  if (ids.length === 0) return Promise.resolve([])
  const width = vectors.values().next().value?.length ?? 0
  const flat = new Float32Array(ids.length * width)
  ids.forEach((id, index) => flat.set(vectors.get(id) as Float32Array, index * width))

  const script = workerScriptPath(app.getAppPath())

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

/**
 * Au bout de combien de silence le fil de placement est tenu pour perdu.
 *
 * Pas une durée totale : le placement croît avec le carré de la bibliothèque, et ce qui prend
 * vingt secondes à dix mille posts en prendrait bien plus à trente mille. Le fil donne des
 * nouvelles toutes les deux cents millisecondes ; une minute sans rien, c'est qu'il ne répond
 * plus.
 */
const PLACEMENT_SILENCE_MS = 60_000

/**
 * Place les posts nouveaux contre la carte figée, hors du processus principal.
 *
 * Le calcul lui-même est `placeSync` — voir là-bas ce qu'il fait et pourquoi son résultat est
 * celui d'avant, au bit près. Il tournait ici, d'un seul tenant : 1,9 s de fenêtre figée pour
 * cinquante posts contre 9 500 ancres, et une minute et demie à la limite du quart de posts
 * nouveaux au-delà duquel on reprojette. Ne reste de ce côté que la mise à plat des vecteurs,
 * une copie mémoire.
 *
 * Rend un point par vecteur, dans l'ordre de `vectors` : les posts déjà placés à leur place
 * rangée, les autres là où leurs voisins les posent. Le script est un paramètre pour que les
 * contrôles le lancent depuis les sources, sans Electron.
 */
export function placeAgainstFrozen(
  vectors: Map<string, Float32Array>,
  frozen: Map<string, { x: number; y: number }>,
  onProgress?: (done: number, total: number) => void,
  script: string = workerScriptPath(app.getAppPath())
): Promise<ProjectedPoint[]> {
  const ids = [...vectors.keys()]
  const fresh = ids.flatMap((id, row) => (frozen.has(id) ? [] : [row]))
  const placed = (id: string, found?: Float64Array, index?: number): ProjectedPoint => {
    if (found && index !== undefined) return { id, x: found[index * 2], y: found[index * 2 + 1] }
    const place = frozen.get(id) as { x: number; y: number }
    return { id, x: place.x, y: place.y }
  }
  /* Le cas de tous les jours — rien de nouveau depuis la dernière ouverture — ne lance aucun
     fil et ne recopie aucun vecteur. */
  if (fresh.length === 0) return Promise.resolve(ids.map((id) => placed(id)))

  const width = vectors.values().next().value?.length ?? 0
  const flat = new Float32Array(ids.length * width)
  ids.forEach((id, index) => flat.set(vectors.get(id) as Float32Array, index * width))
  const rowOf = new Map(ids.map((id, row) => [id, row]))
  /* Dans l'ordre de la carte figée, et non de `vectors` : c'est l'ordre dans lequel l'ancienne
     version parcourait les ancres, et il départage les égalités de distance. */
  const anchors: number[] = []
  const anchorX: number[] = []
  const anchorY: number[] = []
  for (const [id, place] of frozen) {
    const row = rowOf.get(id)
    if (row === undefined) continue
    anchors.push(row)
    anchorX.push(place.x)
    anchorY.push(place.y)
  }
  const job = {
    mode: 'place' as const,
    flat,
    width,
    anchors: Int32Array.from(anchors),
    anchorX: Float64Array.from(anchorX),
    anchorY: Float64Array.from(anchorY),
    fresh: Int32Array.from(fresh)
  }
  const transfer = [job.flat, job.anchors, job.anchorX, job.anchorY, job.fresh].map(
    (array) => array.buffer as ArrayBuffer
  )

  return new Promise<ProjectedPoint[]>((done, fail) => {
    const worker = new Worker(script, { workerData: job, transferList: transfer })
    let heard = Date.now()
    let settled = false
    const guard = setInterval(() => {
      if (Date.now() - heard < PLACEMENT_SILENCE_MS) return
      void worker.terminate()
      finish(new Error(`Placement sur la carte sans nouvelles depuis une minute (${script}).`))
    }, 5_000)
    guard.unref?.()
    function finish(error: Error | null, points: ProjectedPoint[] = []): void {
      if (settled) return
      settled = true
      clearInterval(guard)
      if (error) fail(error)
      else done(points)
    }
    worker.on(
      'message',
      (message: { type: string; placed?: Float64Array; done?: number; total?: number }) => {
        heard = Date.now()
        if (message.type === 'progress') {
          onProgress?.(message.done ?? 0, message.total ?? 0)
          return
        }
        if (message.type !== 'placed' || !message.placed) return
        const found = message.placed
        const indexOf = new Map(fresh.map((row, index) => [row, index]))
        finish(
          null,
          ids.map((id, row) => placed(id, found, indexOf.get(row)))
        )
      }
    )
    worker.on('error', (error: Error) => finish(error))
    worker.on('exit', (code) => {
      if (code !== 0) finish(new Error(`Placement sur la carte interrompu (code ${code}).`))
    })
  })
}

