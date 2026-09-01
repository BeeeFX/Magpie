import { read } from './source'
import { resolve } from 'node:path'
import { neighbourLinks, type Placed } from '../src/renderer/src/map-links'

/**
 * La toile relie exactement les mêmes points qu'avant.
 *
 * Le voisinage a été réécrit pour la vitesse — grille dense, carrés au lieu de racines,
 * insertion bornée au lieu d'un tri complet. Tout le rendu est réglé sur les arêtes que
 * l'ancienne version produisait ; ce contrôle rejoue les deux et exige le même ensemble, sur
 * les 9 742 points de la vraie projection rangée dans `map-sandbox.json`.
 *
 * Sur des points inventés il n'y aurait rien à mesurer : ce qui coûte, et ce qui départage les
 * deux versions, c'est la densité réelle — trois cents candidats par point là où un nuage
 * uniforme en donnerait vingt.
 */

const BUCKET = 0.02
const LINK_RADIUS = 0.022
const LINKS_PER_POINT = 24

let failures = 0

function assert(condition: unknown, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${message}`)
}

interface Point extends Placed {
  id: string
}

/** L'implémentation d'origine, recopiée telle quelle : c'est elle la référence. */
function reference(points: Point[]): [Point, Point][] {
  const buckets = new Map<string, Point[]>()
  for (const point of points) {
    const key = `${Math.floor(point.x / BUCKET)}:${Math.floor(point.y / BUCKET)}`
    const list = buckets.get(key)
    if (list) list.push(point)
    else buckets.set(key, [point])
  }
  const rank = new Map(points.map((point, index) => [point.id, index]))
  const seen = new Set<string>()
  const pairs: [Point, Point][] = []
  for (const point of points) {
    const near: { other: Point; distance: number }[] = []
    const cellX = Math.floor(point.x / BUCKET)
    const cellY = Math.floor(point.y / BUCKET)
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const other of buckets.get(`${cellX + dx}:${cellY + dy}`) ?? []) {
          if (other.id === point.id) continue
          const distance = Math.hypot(other.x - point.x, other.y - point.y)
          if (distance < LINK_RADIUS) near.push({ other, distance })
        }
      }
    }
    near.sort((left, right) => left.distance - right.distance)
    for (const entry of near.slice(0, LINKS_PER_POINT)) {
      const here = rank.get(point.id) ?? 0
      const there = rank.get(entry.other.id) ?? 0
      const key = here < there ? `${here}:${there}` : `${there}:${here}`
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push([point, entry.other])
    }
  }
  return pairs
}

const sandbox = JSON.parse(read(resolve('map-sandbox.json'))) as {
  points: { x: number; y: number; g: number }[]
}
const points: Point[] = sandbox.points.map((point, index) => ({
  id: String(index),
  x: point.x,
  y: point.y
}))

console.log(`La toile, sur ${points.length} points de la vraie projection`)

const slow = process.hrtime.bigint()
const before = reference(points)
const slowMs = Number(process.hrtime.bigint() - slow) / 1e6

const fast = process.hrtime.bigint()
const after = neighbourLinks(points, LINK_RADIUS, LINKS_PER_POINT, BUCKET)
const fastMs = Number(process.hrtime.bigint() - fast) / 1e6

assert(
  before.length === after.length,
  `même nombre d’arêtes (${before.length} contre ${after.length})`
)

const keyOf = (pair: [Point, Point]): string => {
  const here = Number(pair[0].id)
  const there = Number(pair[1].id)
  return here < there ? `${here}:${there}` : `${there}:${here}`
}
const wanted = new Set(before.map(keyOf))
let missing = 0
for (const pair of after) if (!wanted.has(keyOf(pair))) missing += 1
assert(missing === 0, `le même ensemble d’arêtes, au bit près (${missing} de différence)`)

/* Le départ de chaque arête compte aussi : c'est lui qui donne sa teinte au fil quand les deux
   points ne s'accordent pas, et c'est donc lui qui décide de quel paquet elle fait partie. */
const from = new Map(before.map((pair) => [keyOf(pair), pair[0].id]))
let flipped = 0
for (const pair of after) if (from.get(keyOf(pair)) !== pair[0].id) flipped += 1
assert(flipped === 0, `et le même sens de parcours (${flipped} inversées)`)

assert(
  fastMs < slowMs,
  `et c’est plus rapide : ${slowMs.toFixed(0)} ms → ${fastMs.toFixed(0)} ms ` +
    `(×${(slowMs / fastMs).toFixed(1)})`
)

if (failures > 0) {
  console.log(`\n${failures} contrôle(s) en échec.`)
  process.exit(1)
}
console.log('\nTout est vert.')
