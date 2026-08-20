import type { Vertex } from './map-boundaries'

/**
 * Les collections en cellules à parois partagées.
 *
 * Remplace les contours indépendants, et pour une raison de fond : chaque collection avait sa
 * propre ligne fermée, calculée sans savoir que les autres existaient. Il fallait donc un
 * plancher de densité pour éviter qu'elles ne se recouvrent — ce qui laissait des interstices,
 * et des posts dans aucune collection — puis, quand on poussait une frontière, repousser à la
 * main les sommets de la voisine, ce qui n'était qu'une approximation.
 *
 * Ici une paroi est **un seul objet**, désigné par ses deux cellules. La pousser les met à jour
 * toutes les deux du même geste : il n'y a rien à propager, et deux cellules ne peuvent pas se
 * chevaucher puisqu'elles partagent leur bord.
 *
 * Le pavage de départ vient d'un Voronoï — c'est ce qui garantit que **toute** la surface soit
 * couverte, sans réglage. Mais ce n'est qu'un point de départ : le maillage se déforme ensuite
 * librement, donc une cellule peut devenir concave, ce qu'un Voronoï n'autorise jamais.
 *
 * Plusieurs germes par collection, posés sur ses foyers : une collection en deux endroits
 * doit avoir une cellule à chaque endroit, sinon la moitié de ses posts se retrouve rangée à
 * l'autre bout de la carte.
 */

/** Un maillage : des sommets, et des cellules qui les désignent par indice. */
export interface CellMesh {
  /** Tous les sommets. Une jonction partagée n'y figure qu'une fois — c'est tout le principe. */
  vertices: Vertex[]
  /** Chaque cellule : sa collection, et sa boucle de sommets dans l'ordre. */
  cells: { group: string; loop: number[] }[]
}

/** Un demi-plan : ce qui est du bon côté de `ax + by <= c`. */
interface HalfPlane {
  a: number
  b: number
  c: number
}

/** Découpe un polygone par un demi-plan, façon Sutherland–Hodgman. */
function clip(polygon: Vertex[], plane: HalfPlane): Vertex[] {
  if (polygon.length === 0) return polygon
  const inside = (p: Vertex): boolean => plane.a * p.x + plane.b * p.y <= plane.c + 1e-12
  const out: Vertex[] = []
  for (let i = 0; i < polygon.length; i += 1) {
    const current = polygon[i]
    const next = polygon[(i + 1) % polygon.length]
    const currentIn = inside(current)
    const nextIn = inside(next)
    if (currentIn) out.push(current)
    if (currentIn !== nextIn) {
      const dx = next.x - current.x
      const dy = next.y - current.y
      const denominator = plane.a * dx + plane.b * dy
      if (Math.abs(denominator) > 1e-15) {
        const t = (plane.c - plane.a * current.x - plane.b * current.y) / denominator
        out.push({ x: current.x + dx * t, y: current.y + dy * t })
      }
    }
  }
  return out
}

/**
 * Les foyers d'une collection : les endroits où ses posts se concentrent.
 *
 * Un germe unique par collection rangerait une collection éparpillée d'un seul côté de la
 * carte. On prend donc les cases les plus fournies, en s'interdisant deux germes voisins —
 * sans quoi les vingt germes d'un même amas dense se partageraient un confetti chacun.
 *
 * **Un seul par défaut.** Une collection est une zone, pas quinze : plusieurs germes rendaient
 * la carte illisible et le rapport entre une collection et sa cellule incompréhensible. Le
 * paramètre reste, parce qu'une collection franchement coupée en deux peut mériter deux
 * cellules, mais ce n'est pas le comportement normal.
 */
export function collectionSeeds(
  points: Vertex[],
  most = 1,
  cell = 0.08,
  apart = 0.28
): Vertex[] {
  if (points.length === 0) return []
  const buckets = new Map<string, Vertex[]>()
  for (const point of points) {
    const key = `${Math.floor(point.x / cell)}:${Math.floor(point.y / cell)}`
    const list = buckets.get(key)
    if (list) list.push(point)
    else buckets.set(key, [point])
  }
  const ranked = [...buckets.values()].sort((a, b) => b.length - a.length)
  const seeds: Vertex[] = []
  for (const bucket of ranked) {
    if (seeds.length >= most) break
    let x = 0
    let y = 0
    for (const point of bucket) {
      x += point.x
      y += point.y
    }
    const centre = { x: x / bucket.length, y: y / bucket.length }
    if (seeds.some((seed) => Math.hypot(seed.x - centre.x, seed.y - centre.y) < apart)) continue
    seeds.push(centre)
  }
  // Une collection minuscule n'a pas de foyer qui se détache : son centre fera un germe.
  if (seeds.length === 0) {
    let x = 0
    let y = 0
    for (const point of points) {
      x += point.x
      y += point.y
    }
    seeds.push({ x: x / points.length, y: y / points.length })
  }
  return seeds
}

/**
 * Le pavage de départ : un Voronoï des germes, découpé dans le carré unité.
 *
 * Les sommets sont soudés : deux cellules voisines qui se rencontrent au même endroit
 * partagent l'indice de ce sommet, et non deux copies. C'est ce qui fait qu'en déplacer un
 * bouge la paroi **des deux côtés à la fois** — la propriété pour laquelle tout ce module
 * existe.
 */
export function buildCellMesh(
  seeds: { group: string; at: Vertex }[],
  bounds?: Vertex[],
  weld = 1e-4
): CellMesh {
  const vertices: Vertex[] = []
  const index = new Map<string, number>()
  const keyOf = (point: Vertex): string =>
    `${Math.round(point.x / weld)}:${Math.round(point.y / weld)}`
  const share = (point: Vertex): number => {
    const key = keyOf(point)
    const found = index.get(key)
    if (found !== undefined) return found
    vertices.push(point)
    index.set(key, vertices.length - 1)
    return vertices.length - 1
  }

  /* La bordure est **commune à toutes les cellules**, et c'est indispensable.
     Borner chaque cellule par son propre cercle coupait la paroi que deux voisines partagent à
     deux endroits différents : leurs jonctions ne se rencontraient plus, et le partage des
     parois — la raison d'être de ce module — ne fonctionnait plus du tout. Mesuré : un seul
     sommet partagé sur cent quarante-quatre. Une seule bordure, découpée identiquement pour
     tout le monde, laisse les jonctions intérieures intactes. */
  const square: Vertex[] = bounds && bounds.length >= 3 ? bounds : [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 }
  ]
  const cells: { group: string; loop: number[] }[] = []
  for (const seed of seeds) {
    let polygon = square
    for (const other of seeds) {
      if (other === seed) continue
      const dx = other.at.x - seed.at.x
      const dy = other.at.y - seed.at.y
      if (dx === 0 && dy === 0) continue
      /* Le bisecteur : tout point plus proche de `seed` que de `other` vérifie
         2(o−s)·p ≤ |o|² − |s|². */
      polygon = clip(polygon, {
        a: 2 * dx,
        b: 2 * dy,
        c: other.at.x ** 2 + other.at.y ** 2 - seed.at.x ** 2 - seed.at.y ** 2
      })
      if (polygon.length === 0) break
    }
    if (polygon.length < 3) continue
    cells.push({ group: seed.group, loop: polygon.map(share) })
  }
  return { vertices, cells }
}

/** La boucle d'une cellule, en points. */
export function cellRing(mesh: CellMesh, cell: { loop: number[] }): Vertex[] {
  return cell.loop.map((at) => mesh.vertices[at])
}

/** Aire d'un polygone, par la formule du lacet. Sert à vérifier que le pavage couvre tout. */
export function ringArea(ring: Vertex[]): number {
  let total = 0
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    total += a.x * b.y - b.x * a.y
  }
  return Math.abs(total) / 2
}

/**
 * Déplace un sommet du maillage.
 *
 * Rien à propager : toutes les cellules qui le désignent suivent, puisqu'elles le désignent par
 * indice. C'est là toute la différence avec des contours indépendants, où il fallait repousser
 * la voisine à la main et où deux parois finissaient par se croiser.
 */
export function moveMeshVertex(mesh: CellMesh, at: number, to: Vertex): CellMesh {
  if (at < 0 || at >= mesh.vertices.length) return mesh
  const vertices = mesh.vertices.slice()
  vertices[at] = to
  return { vertices, cells: mesh.cells }
}


/**
 * Jusqu'où une cellule doit s'étendre autour de son foyer.
 *
 * On prend le quantile des distances des posts que ce foyer est le plus proche de servir, plus
 * une marge : la cellule englobe alors son île sans la serrer, et s'arrête avant le vide. Un
 * quantile plutôt que le maximum, parce qu'un seul post égaré à l'autre bout de la carte
 * ferait à lui seul retomber la cellule dans le rectangle qu'on cherche à éviter.
 */
export function seedReach(
  seeds: Vertex[],
  points: Vertex[],
  index: number,
  quantile = 0.9,
  margin = 0.04
): number {
  const mine: number[] = []
  for (const point of points) {
    let closest = 0
    let best = Infinity
    seeds.forEach((seed, at) => {
      const distance = Math.hypot(seed.x - point.x, seed.y - point.y)
      if (distance < best) {
        best = distance
        closest = at
      }
    })
    if (closest === index) mine.push(best)
  }
  if (mine.length === 0) return margin
  mine.sort((a, b) => a - b)
  return mine[Math.min(mine.length - 1, Math.floor(quantile * mine.length))] + margin
}

/** Les parois du maillage, chacune une seule fois. */
export function meshWalls(mesh: CellMesh): { from: number; to: number; groups: string[] }[] {
  const walls = new Map<string, { from: number; to: number; groups: string[] }>()
  for (const cell of mesh.cells) {
    for (let i = 0; i < cell.loop.length; i += 1) {
      const a = cell.loop[i]
      const b = cell.loop[(i + 1) % cell.loop.length]
      if (a === b) continue
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      const found = walls.get(key)
      /* Deux cellules voisines décrivent la même paroi, chacune dans son sens. La tracer depuis
         les boucles la peignait donc deux fois, dans deux couleurs : ce sont les doubles traits
         qu'on prenait pour un chevauchement. Ici elle n'existe qu'une fois, et sait à qui elle
         appartient des deux côtés. */
      if (found) {
        if (!found.groups.includes(cell.group)) found.groups.push(cell.group)
      } else {
        walls.set(key, { from: Math.min(a, b), to: Math.max(a, b), groups: [cell.group] })
      }
    }
  }
  return [...walls.values()]
}


/**
 * La bordure du pavage : l'enveloppe du nuage, dilatée d'une marge.
 *
 * Sans elle, le Voronoï découpe le carré entier et les cellules du bord filent jusqu'aux
 * angles, en grands aplats qui ne contiennent rien. Avec elle, le pavage s'arrête où s'arrête
 * la bibliothèque.
 *
 * Une seule bordure pour toutes les cellules — jamais une par cellule. C'est ce qui préserve
 * les jonctions : deux voisines coupées par la même ligne se rencontrent encore dessus.
 */
export function outerBounds(points: Vertex[], margin = 0.02): Vertex[] {
  if (points.length < 3) return []
  // Enveloppe convexe, par balayage de Graham sur les points triés.
  const sorted = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x))
  const cross = (o: Vertex, a: Vertex, b: Vertex): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const half = (list: Vertex[]): Vertex[] => {
    const out: Vertex[] = []
    for (const point of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], point) <= 0) {
        out.pop()
      }
      out.push(point)
    }
    return out
  }
  const lower = half(sorted)
  const upper = half([...sorted].reverse())
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)]
  if (hull.length < 3) return []
  let cx = 0
  let cy = 0
  for (const point of hull) {
    cx += point.x / hull.length
    cy += point.y / hull.length
  }
  /* Dilatée depuis le centre : la bordure passe un peu au large des points extrêmes, sinon les
     cellules du pourtour seraient tranchées au ras de leurs propres posts. */
  return hull.map((point) => {
    const dx = point.x - cx
    const dy = point.y - cy
    const length = Math.hypot(dx, dy) || 1
    return { x: point.x + (dx / length) * margin, y: point.y + (dy / length) * margin }
  })
}

/**
 * Scinde une cellule par une droite.
 *
 * Les deux moitiés partagent la coupe : ses deux extrémités sont soudées comme n'importe quelle
 * autre jonction, donc déplacer l'une déplace la frontière des deux — la scission ne crée pas
 * deux cellules étrangères posées côte à côte, elle crée une paroi de plus dans le maillage.
 *
 * Rend `null` quand la droite ne traverse pas la cellule : mieux vaut ne rien faire que rendre
 * une moitié vide et une cellule inchangée sous un nom nouveau.
 */
export function splitCell(
  mesh: CellMesh,
  cellIndex: number,
  from: Vertex,
  to: Vertex,
  newGroup: string,
  weld = 1e-4
): CellMesh | null {
  const cell = mesh.cells[cellIndex]
  if (!cell) return null
  const ring = cellRing(mesh, cell)
  if (ring.length < 3) return null

  /* La droite, en demi-plan. Le sens choisi importe peu : on garde les deux côtés, et c'est
     le côté positif qui prend le nouveau nom. */
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return null
  const plane: HalfPlane = { a: dy, b: -dx, c: dy * from.x - dx * from.y }
  const opposite: HalfPlane = { a: -dy, b: dx, c: -(dy * from.x - dx * from.y) }

  const keep = clip(ring, plane)
  const other = clip(ring, opposite)
  // Une coupe qui ne traverse pas laisse une moitié vide : on refuse plutôt que de bricoler.
  if (keep.length < 3 || other.length < 3) return null

  const vertices = mesh.vertices.slice()
  const index = new Map<string, number>()
  vertices.forEach((point, at) => {
    index.set(`${Math.round(point.x / weld)}:${Math.round(point.y / weld)}`, at)
  })
  const share = (point: Vertex): number => {
    const key = `${Math.round(point.x / weld)}:${Math.round(point.y / weld)}`
    const found = index.get(key)
    if (found !== undefined) return found
    vertices.push(point)
    index.set(key, vertices.length - 1)
    return vertices.length - 1
  }

  const cells = mesh.cells.slice()
  cells[cellIndex] = { group: cell.group, loop: keep.map(share) }
  cells.splice(cellIndex + 1, 0, { group: newGroup, loop: other.map(share) })
  return { vertices, cells }
}
