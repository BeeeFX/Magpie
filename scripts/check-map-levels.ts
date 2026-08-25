import { readFileSync } from 'node:fs'
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

const sandbox = JSON.parse(readFileSync(resolve('map-sandbox.json'), 'utf8')) as {
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
for (const [level, tuning] of ISLAND_LEVELS.entries()) {
  const started = process.hrtime.bigint()
  const islands = findIslands(points, termsOf, tuning, level)
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  const held = islands.reduce((sum, island) => sum + island.size, 0)
  const sizes = islands.map((island) => island.size).sort((a, b) => a - b)
  counts.push(islands.length)
  spans.push(sizes.length > 0 ? sizes[sizes.length - 1] / points.length : 0)
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
assert(
  counts[0] < counts[1] && counts[1] < counts[2],
  `de moins en moins de monde en s'approchant (${counts.join(' → ')} régions)`
)
assert(
  counts[2] >= counts[0] * 3,
  `et l'étage le plus fin en montre au moins trois fois plus (${counts[0]} → ${counts[2]})`
)
assert(
  spans[0] > spans[2],
  `la plus grosse région rétrécit d'un étage à l'autre ` +
    `(${(spans[0] * 100).toFixed(0)} % → ${(spans[2] * 100).toFixed(0)} %)`
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
