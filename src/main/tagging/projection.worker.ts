import { parentPort, workerData } from 'node:worker_threads'
// Surtout pas `./projection` : il importe Electron, indisponible dans un fil.
import { placeSync, projectSync, type PlacementInput, type ProjectedPoint } from './projection-core'

/**
 * Projection dans un fil séparé.
 *
 * Tout le reste du calcul lourd de Magpie se découpe avec `Breathe`, mais la construction du
 * graphe de voisins d'UMAP est une seule opération atomique : mesurée à 2,8 s de fenêtre
 * figée sur 9 738 posts, contre une barre de 250 ms tenue partout ailleurs. Un fil dédié est
 * la seule réponse honnête.
 *
 * Le placement contre la carte figée y vit aussi, pour une raison voisine : il comparait chaque
 * post nouveau à chaque ancre sur le processus principal, d'un seul tenant — 1,9 s de fenêtre
 * figée pour cinquante posts, une minute et demie à la limite du quart de posts nouveaux.
 */

interface Input {
  ids: string[]
  /** Vecteurs mis à plat : un seul transfert plutôt que des milliers de tableaux. */
  flat: Float32Array
  width: number
}

type Job = ({ mode?: 'project' } & Input) | ({ mode: 'place' } & PlacementInput)

const job = workerData as Job

if (job.mode === 'place') {
  const placed = placeSync(job, (done, total) => {
    parentPort?.postMessage({ type: 'progress', done, total })
  })
  parentPort?.postMessage({ type: 'placed', placed }, [placed.buffer as ArrayBuffer])
} else {
  const { ids, flat, width } = job
  const vectors = new Map<string, Float32Array>()
  ids.forEach((id, index) => {
    vectors.set(id, flat.subarray(index * width, (index + 1) * width))
  })

  const points: ProjectedPoint[] = projectSync(vectors, (done, total) => {
    parentPort?.postMessage({ type: 'progress', done, total })
  })
  parentPort?.postMessage({ type: 'done', points })
}
