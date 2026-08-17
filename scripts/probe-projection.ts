import { performance } from 'node:perf_hooks'
import { projectSync } from '../src/main/tagging/projection'

/** Mesure jetable : la projection tient-elle sur une vraie bibliothèque, et en combien. */

const DIMS = 384
const CLUSTERS = 20

function synthetic(count: number): Map<string, Float32Array> {
  const vectors = new Map<string, Float32Array>()
  const centres = Array.from({ length: CLUSTERS }, (_, c) => {
    const v = new Float32Array(DIMS)
    for (let i = 0; i < DIMS; i += 1) v[i] = Math.sin(c * 7.3 + i * 0.11)
    return v
  })
  for (let index = 0; index < count; index += 1) {
    const centre = centres[index % CLUSTERS]
    const v = new Float32Array(DIMS)
    let norm = 0
    for (let i = 0; i < DIMS; i += 1) {
      v[i] = centre[i] + (Math.sin(index * 3.1 + i * 0.7) * 0.6)
      norm += v[i] * v[i]
    }
    norm = Math.sqrt(norm) || 1
    for (let i = 0; i < DIMS; i += 1) v[i] /= norm
    vectors.set(`p${index}`, v)
  }
  return vectors
}

async function main(): Promise<void> {
  for (const count of [1000, 5000, 9738]) {
    const vectors = synthetic(count)
    /* Mesure du cœur synchrone : en production il tourne dans un fil, donc son blocage ne
       gèle rien. Ce qui compte ici, c'est le temps total. */
    const started = performance.now()
    const points = projectSync(vectors)
    const elapsed = performance.now() - started
    const spread = new Set(points.map((p) => `${Math.round(p.x * 12)},${Math.round(p.y * 12)}`)).size
    console.log(
      `${String(count).padStart(5)} points : ${(elapsed / 1000).toFixed(1)} s | ` +
        `${spread} cases occupées sur 169`
    )
  }
}

void main()
