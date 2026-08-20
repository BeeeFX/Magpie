import {
  buildCellMesh,
  cellRing,
  collectionSeeds,
  moveMeshVertex,
  ringArea
} from '../src/renderer/src/map-cells'
import { insideRing, type Vertex } from '../src/renderer/src/map-boundaries'

/**
 * Le maillage tient-il ses trois promesses ?
 *
 * Elles sont exactement les trois défauts des contours indépendants qu'il remplace :
 *
 *   — **il couvre tout.** Un post hors de toute cellule est un post hors de toute collection,
 *     et c'était le reproche principal : les îlots laissaient des interstices.
 *   — **rien ne se chevauche.** Deux cellules partagent leur bord, elles ne se superposent pas.
 *   — **une paroi bouge des deux côtés.** C'est la raison d'être du maillage : pousser une
 *     frontière faisait reculer la voisine par une rustine qui repoussait ses sommets un à un.
 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Échec : ${message}`)
  console.log(`  ✓ ${message}`)
}

function blob(cx: number, cy: number, radius: number, count: number, seed: number): Vertex[] {
  let state = seed
  const random = (): number => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648)
  return Array.from({ length: count }, () => {
    const angle = random() * Math.PI * 2
    const distance = Math.sqrt(random()) * radius
    return { x: cx + Math.cos(angle) * distance, y: cy + Math.sin(angle) * distance }
  })
}

const groups = [
  { group: 'art', points: blob(0.28, 0.3, 0.14, 400, 3) },
  { group: 'musique', points: blob(0.72, 0.32, 0.13, 350, 5) },
  { group: 'photo', points: blob(0.5, 0.74, 0.15, 380, 9) },
  { group: 'code', points: blob(0.14, 0.78, 0.1, 200, 13) }
]

console.log('Germes : une collection éparpillée doit avoir un foyer à chaque endroit')
{
  const split = [...blob(0.2, 0.2, 0.07, 150, 21), ...blob(0.82, 0.8, 0.07, 150, 23)]
  const seeds = collectionSeeds(split)
  assert(seeds.length >= 2, `deux foyers pour deux amas (${seeds.length})`)
  const near = (x: number, y: number): boolean =>
    seeds.some((seed) => Math.hypot(seed.x - x, seed.y - y) < 0.12)
  assert(near(0.2, 0.2) && near(0.82, 0.8), 'un foyer sur chacun des deux amas')

  const dense = collectionSeeds(blob(0.5, 0.5, 0.06, 400, 31))
  assert(dense.length <= 2, `un amas unique ne se fragmente pas en germes (${dense.length})`)
}

const seeds = groups.flatMap((entry) =>
  collectionSeeds(entry.points).map((at) => ({ group: entry.group, at }))
)
const mesh = buildCellMesh(seeds)

console.log('\nPavage')
{
  assert(mesh.cells.length === seeds.length, `une cellule par germe (${mesh.cells.length})`)
  const area = mesh.cells.reduce((total, cell) => total + ringArea(cellRing(mesh, cell)), 0)
  /* Les cellules pavent le carré unité : leur aire totale vaut 1. En dessous, il reste des
     interstices — donc des posts sans collection ; au-dessus, elles se chevauchent. */
  assert(Math.abs(area - 1) < 0.005, `les cellules couvrent tout le carré (aire ${area.toFixed(4)})`)

  let placed = 0
  let total = 0
  for (const entry of groups) {
    for (const point of entry.points) {
      total += 1
      if (mesh.cells.some((cell) => insideRing(cellRing(mesh, cell), point.x, point.y))) placed += 1
    }
  }
  assert(placed === total, `aucun post hors de toute cellule (${placed}/${total})`)

  let own = 0
  for (const entry of groups) {
    for (const point of entry.points) {
      const home = mesh.cells.find((cell) =>
        insideRing(cellRing(mesh, cell), point.x, point.y)
      )
      if (home?.group === entry.group) own += 1
    }
  }
  assert(own / total > 0.9, `chaque post tombe chez lui (${own}/${total})`)
}

console.log('\nParois partagées')
{
  /* La promesse centrale : un sommet appartient à plusieurs cellules, et le déplacer les bouge
     toutes. Sans cela, pousser une frontière laissait la voisine derrière — c'est ce que la
     rustine précédente rattrapait approximativement. */
  const shared = mesh.vertices
    .map((_, at) => ({ at, cells: mesh.cells.filter((cell) => cell.loop.includes(at)) }))
    .filter((entry) => entry.cells.length >= 2)
  assert(shared.length > 0, `des sommets sont partagés (${shared.length})`)

  const junction = shared.sort((a, b) => b.cells.length - a.cells.length)[0]
  assert(
    junction.cells.length >= 3,
    `une jonction réunit trois parois ou plus (${junction.cells.length})`
  )

  const before = junction.cells.map((cell) => ringArea(cellRing(mesh, cell)))
  const moved = moveMeshVertex(mesh, junction.at, {
    x: mesh.vertices[junction.at].x + 0.06,
    y: mesh.vertices[junction.at].y + 0.04
  })
  const after = junction.cells.map((cell) => ringArea(cellRing(moved, cell)))
  const changed = before.filter((value, index) => Math.abs(value - after[index]) > 1e-6).length
  assert(
    changed === junction.cells.length,
    `déplacer la jonction change les ${junction.cells.length} cellules d'un coup`
  )

  /* Et la surface reste couverte : ce qu'une cellule perd, sa voisine le gagne. C'est ce que
     « paroi partagée » veut dire, et c'est ce qu'un déplacement de contours indépendants ne
     pouvait pas garantir. */
  const areaAfter = moved.cells.reduce(
    (total, cell) => total + ringArea(cellRing(moved, cell)),
    0
  )
  assert(
    Math.abs(areaAfter - 1) < 0.005,
    `après déformation, le pavage couvre encore tout (aire ${areaAfter.toFixed(4)})`
  )
}

console.log('\nDéformation libre')
{
  /* Une cellule doit pouvoir devenir concave : c'est la différence entre un maillage qu'on
     déforme et un Voronoï, qui n'en produit jamais. */
  const cell = mesh.cells[0]
  const ring = cellRing(mesh, cell)
  const centre = ring.reduce((sum, v) => ({ x: sum.x + v.x / ring.length, y: sum.y + v.y / ring.length }), { x: 0, y: 0 })
  const pulled = moveMeshVertex(mesh, cell.loop[0], {
    x: centre.x + (mesh.vertices[cell.loop[0]].x - centre.x) * -0.4,
    y: centre.y + (mesh.vertices[cell.loop[0]].y - centre.y) * -0.4
  })
  const deformed = cellRing(pulled, cell)
  const convex = (poly: Vertex[]): boolean => {
    let sign = 0
    for (let i = 0; i < poly.length; i += 1) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      const c = poly[(i + 2) % poly.length]
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
      if (Math.abs(cross) < 1e-12) continue
      const here = cross > 0 ? 1 : -1
      if (sign === 0) sign = here
      else if (here !== sign) return false
    }
    return true
  }
  assert(convex(ring), 'le pavage de départ est convexe, comme un Voronoï')
  assert(!convex(deformed), 'tirer un sommet vers l’intérieur rend la cellule concave')
}

console.log('\nTout est vert.')
