import { Worker } from 'node:worker_threads'
import { app } from 'electron'
import { join } from 'node:path'
import type { ProjectedPoint } from './projection-core'

export { projectSync, type ProjectedPoint } from './projection-core'

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

