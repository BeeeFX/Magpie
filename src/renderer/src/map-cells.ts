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
 * Deux au plus, et séparés d'au moins un quart de la carte. À quatre germes espacés de 0,14,
 * vingt-quatre collections produisaient près de quatre-vingt-dix cellules : la carte devenait
 * une mosaïque où l'on ne retrouvait plus ses collections. Un deuxième foyer ne doit
 * apparaître que si la collection est vraiment coupée en deux, à l'autre bout de la carte — ce
 * que 94 % de compacité rend rare, et c'est bien pour cela qu'on a mesuré cette compacité.
 */
export function collectionSeeds(
  points: Vertex[],
  most = 2,
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
  seeds: { group: string; at: Vertex; reach?: number }[],
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

  const square: Vertex[] = [
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
    /* Et on borne la cellule autour de son foyer.
       Sans cela le Voronoï découpe le carré entier : les cellules du bord s'étendent jusqu'aux
       angles et la carte se termine par un rectangle de couleur qui ne contient rien. La portée
       vient des posts de la collection, pas d'une constante — une cellule doit s'arrêter là où
       s'arrête ce qu'elle contient. Approchée par un polygone à seize côtés : au-delà on ne
       distingue plus le cercle, en deçà les coins se voient. */
    if (seed.reach && seed.reach > 0) {
      const SIDES = 16
      for (let i = 0; i < SIDES; i += 1) {
        const angle = (i / SIDES) * Math.PI * 2
        const a = Math.cos(angle)
        const b = Math.sin(angle)
        polygon = clip(polygon, {
          a,
          b,
          c: a * seed.at.x + b * seed.at.y + seed.reach
        })
        if (polygon.length === 0) break
      }
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
