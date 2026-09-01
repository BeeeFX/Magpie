import { read } from './source'
import { resolve } from 'node:path'
import { findIslands, ISLAND_LEVELS } from '../src/main/tagging/islands'
import type { ProjectedPoint } from '../src/main/tagging/projection-core'

/**
 * Les trois étages de régions se lisent-ils à trois distances ?
 *
 * Une carte qui montre les mêmes noms à tous les zooms ne dit plus rien une fois qu'on est
 * entrée dedans : c'est le reproche qui a fait naître les étages. Ce contrôle vérifie qu'ils
 * disent effectivement trois choses différentes — de moins en moins de monde, de plus en plus
 * d'endroits — sur la vraie projection de `map-sandbox.json`.
 *
 * Le vocabulaire est synthétique — le groupe de chaque point tient lieu de mot — parce que le
 * vrai nommage relit la bibliothèque, que ce banc n'a pas. Il faut néanmoins en fournir un :
 * une région dont aucun mot ne sort est écartée, et sans mots il ne resterait aucune région.
 */

let failures = 0

function assert(condition: unknown, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${message}`)
}

const sandbox = JSON.parse(read(resolve('map-sandbox.json'))) as {
  points: { x: number; y: number; g: number }[]
}
const points: ProjectedPoint[] = sandbox.points.map((point, index) => ({
  id: String(index),
  x: point.x,
  y: point.y
}))
/** Un mot par point : celui de son groupe, ce qui suffit à ce qu'une région ait un nom. */
const words = new Map(sandbox.points.map((point, index) => [String(index), [`sujet${point.g}`]]))
const termsOf = (id: string): string[] => words.get(id) ?? []

console.log(`Les étages du relief, sur ${points.length} points de la vraie projection\n`)
console.log('étage   régions   couverture   la plus grosse   médiane   ms')

const counts: number[] = []
const spans: number[] = []
const covers: number[] = []
for (const [level, tuning] of ISLAND_LEVELS.entries()) {
  const started = process.hrtime.bigint()
  const islands = findIslands(points, termsOf, tuning, level)
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  const held = islands.reduce((sum, island) => sum + island.size, 0)
  const sizes = islands.map((island) => island.size).sort((a, b) => a - b)
  counts.push(islands.length)
  spans.push(sizes.length > 0 ? sizes[sizes.length - 1] / points.length : 0)
  covers.push(held / points.length)
  console.log(
    `${String(level).padStart(5)}${String(islands.length).padStart(10)}` +
      `${`${((held / points.length) * 100).toFixed(1)} %`.padStart(13)}` +
      `${`${(((sizes[sizes.length - 1] ?? 0) / points.length) * 100).toFixed(1)} %`.padStart(17)}` +
      `${String(sizes[Math.floor(sizes.length / 2)] ?? 0).padStart(10)}` +
      `${ms.toFixed(0).padStart(5)}`
  )
}

console.log('')
/* Ce qu'un étage doit être : un étage. Sans écart franc entre les trois, la carte montrerait
   trois fois la même chose et le zoom n'apprendrait rien. */
const last = counts.length - 1
assert(
  counts.every((count, level) => level === 0 || count > counts[level - 1]),
  `de moins en moins de monde en s'approchant (${counts.join(' → ')} régions)`
)
assert(
  counts[last] >= counts[0] * 10,
  `et l'étage le plus fin en montre au moins dix fois plus (${counts[0]} → ${counts[last]})`
)
assert(
  spans[0] > spans[last] * 5,
  `la plus grosse région fond d'un bout à l'autre ` +
    `(${(spans[0] * 100).toFixed(0)} % → ${(spans[last] * 100).toFixed(1)} %)`
)
/* Un étage qui ne nomme presque personne ne sert à rien : le grain le plus fin doit encore
   couvrir la carte, sinon on aurait découpé du bruit. Le dernier a droit à un dixième de
   perte — à ce grain, les posts isolés tombent sous le plancher du relief, et il n'y a de
   toute façon rien à nommer là où il n'y a qu'un post. Au-delà l'affaire se gâte vite :
   descendre encore d'un cran fait tomber la couverture à 79 %. */
assert(
  covers.every((part, level) => part > (level === covers.length - 1 ? 0.85 : 0.9)),
  `chaque étage couvre encore la carte (${covers.map((p) => `${(p * 100).toFixed(0)} %`).join(' ')})`
)
/* Le relief se recalcule avec la projection, jamais entre deux : il doit être déterministe. */
const again = findIslands(points, termsOf, ISLAND_LEVELS[1], 1)
const once = findIslands(points, termsOf, ISLAND_LEVELS[1], 1)
assert(
  JSON.stringify(again.map((i) => [i.id, i.size])) ===
    JSON.stringify(once.map((i) => [i.id, i.size])),
  'deux relevés du même étage sont identiques'
)

if (failures > 0) {
  console.log(`\n${failures} contrôle(s) en échec.`)
  process.exit(1)
}
console.log('\nTout est vert.')
