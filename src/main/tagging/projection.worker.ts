import { parentPort, workerData } from 'node:worker_threads'
import { projectSync, type ProjectedPoint } from './projection'

/**
 * Projection dans un fil séparé.
 *
 * Tout le reste du calcul lourd de Magpie se découpe avec `Breathe`, mais la construction du
 * graphe de voisins d'UMAP est une seule opération atomique : mesurée à 2,8 s de fenêtre
 * figée sur 9 738 posts, contre une barre de 250 ms tenue partout ailleurs. Un fil dédié est
 * la seule réponse honnête.
 */

interface Input {
  ids: string[]
  /** Vecteurs mis à plat : un seul transfert plutôt que des milliers de tableaux. */
  flat: Float32Array
  width: number
}

const { ids, flat, width } = workerData as Input
const vectors = new Map<string, Float32Array>()
ids.forEach((id, index) => {
  vectors.set(id, flat.subarray(index * width, (index + 1) * width))
})

const points: ProjectedPoint[] = projectSync(vectors, (done, total) => {
  parentPort?.postMessage({ type: 'progress', done, total })
})
parentPort?.postMessage({ type: 'done', points })
