/**
 * Le contour d'une collection sur la carte.
 *
 * Les couleurs disaient déjà à quel groupe appartient un point, mais rien ne délimitait les
 * ensembles : on devinait des zones sans jamais voir où l'une s'arrête. Or c'est la frontière
 * qui doit devenir manipulable — la déplacer, fusionner deux collections, en scinder une.
 *
 * Pas une enveloppe convexe : elle engloberait de larges vides et deux collections voisines
 * se chevaucheraient à s'en confondre. On passe par un **champ de densité** — chaque post
 * dépose une bosse autour de lui, les bosses s'additionnent — dont on trace la ligne de
 * niveau. Le contour épouse alors la forme réelle de l'amas, se referme tout seul autour de
 * plusieurs taches quand la collection est en morceaux, et ignore les points isolés au lieu
 * de s'étirer jusqu'à eux.
 *
 * Le champ sert deux fois, et c'est ce qui rend l'ensemble simple : il donne le tracé, et il
 * répond aussi à « ce point est-il dedans ? » sans qu'on ait à reconstituer un polygone
 * fermé. Un test d'appartenance se réduit à lire une case.
 */

/** Côté de la grille du champ, en cases. */
export const FIELD_SIZE = 192

/**
 * Rayon d'influence d'un post, en cases.
 *
 * C'est lui qui décide de la souplesse du contour : trop petit, la collection se hache en
 * archipel autour de chaque post ; trop grand, tout se rejoint en une seule masse.
 *
 * Balayé sur la vraie bibliothèque, une fois les régions rendues exclusives — « attribué »
 * est la part de la carte qui revient à une collection :
 *
 *   rayon 12 — 7,2 % attribué
 *   rayon 16 — 10,0 %   ← retenu
 *   rayon 22 — 14,2 %
 *
 * Seize donne aux régions de quoi se voir sans les faire déborder sur le vide. La marge de
 * litige, elle, ne change presque rien (6,4 % à 1,25 contre 7,2 % à 1,0) : c'est le rayon qui
 * commande, pas elle.
 */
export const FIELD_RADIUS = 16

/**
 * Niveau du tracé, en unités de densité — donc en nombre de bosses qui se recouvrent.
 *
 * La bosse d'un post culmine à 1 : sous ce niveau, un post isolé se dessine un anneau à lui
 * tout seul, ce qui pique la carte de bulles qui ne veulent rien dire. Il faut donc exiger un
 * recouvrement. Balayé sur des amas de synthèse — un dense, un clairsemé, et deux amas
 * séparés dont le vide entre eux ne doit pas se combler :
 *
 *   0,55 — un post isolé se trace         · 100 % des posts contenus
 *   1,40 — plus d'anneau isolé            · 100 %   ← retenu
 *   1,80 — deux posts voisins ne tracent plus rien
 *   3,20 — un amas clairsemé perd ses bords (90 %)
 *   4,50 — il en perd le quart (72 %)
 *
 * 1,4 est le seul point qui écarte le bruit sans rogner les amas maigres.
 */
export const FIELD_LEVEL = 1.4

export interface FieldPoint {
  x: number
  y: number
}

/** Un champ de densité carré, dans le repère unité de la carte. */
export interface Field {
  size: number
  values: Float32Array
}

/**
 * Le champ de densité d'un ensemble de points.
 *
 * Chaque post dépose une bosse qui décroît doucement jusqu'à son rayon. La bosse est en
 * `(1 - d²/r²)²` — nulle et plate au bord, donc les contours ne montrent pas les facettes de
 * chaque post, ce qu'un cône ou une gaussienne tronquée laisseraient voir.
 */
export function densityField(points: FieldPoint[], size = FIELD_SIZE, radius = FIELD_RADIUS): Field {
  const values = new Float32Array(size * size)
  const radiusSquared = radius * radius
  for (const point of points) {
    const cx = point.x * (size - 1)
    const cy = point.y * (size - 1)
    const left = Math.max(0, Math.floor(cx - radius))
    const right = Math.min(size - 1, Math.ceil(cx + radius))
    const top = Math.max(0, Math.floor(cy - radius))
    const bottom = Math.min(size - 1, Math.ceil(cy + radius))
    for (let y = top; y <= bottom; y += 1) {
      const dy = y - cy
      for (let x = left; x <= right; x += 1) {
        const dx = x - cx
        const distance = dx * dx + dy * dy
        if (distance >= radiusSquared) continue
        const falloff = 1 - distance / radiusSquared
        values[y * size + x] += falloff * falloff
      }
    }
  }
  return { size, values }
}

/** La densité en un point du repère unité. Sert à savoir si un post est dans une frontière. */
export function sampleField(field: Field, x: number, y: number): number {
  const gx = Math.round(x * (field.size - 1))
  const gy = Math.round(y * (field.size - 1))
  if (gx < 0 || gy < 0 || gx >= field.size || gy >= field.size) return 0
  return field.values[gy * field.size + gx]
}

/** Un point est-il à l'intérieur du contour ? */
export function insideField(field: Field, x: number, y: number, level = FIELD_LEVEL): boolean {
  return sampleField(field, x, y) >= level
}

/** Un segment du contour, dans le repère unité. */
export interface Segment {
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * La ligne de niveau du champ, par carrés marchants.
 *
 * On rend des segments indépendants plutôt qu'un polygone fermé, et c'est délibéré : les
 * recoudre bout à bout est la partie fragile de l'algorithme — cas ambigus des diagonales,
 * contours emboîtés — alors qu'on n'en a besoin ni pour tracer, ni pour remplir en teinte
 * translucide, ni pour savoir si un point est dedans, puisque le champ répond déjà.
 */
export function isoContour(field: Field, level = FIELD_LEVEL): Segment[] {
  const { size, values } = field
  const segments: Segment[] = []
  const at = (x: number, y: number): number => values[y * size + x]
  /** Où, entre deux coins, la valeur franchit le niveau. */
  const cut = (a: number, b: number): number => {
    const span = b - a
    return Math.abs(span) < 1e-6 ? 0.5 : (level - a) / span
  }
  const unit = (v: number): number => v / (size - 1)

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const topLeft = at(x, y)
      const topRight = at(x + 1, y)
      const bottomRight = at(x + 1, y + 1)
      const bottomLeft = at(x, y + 1)
      let code = 0
      if (topLeft >= level) code |= 8
      if (topRight >= level) code |= 4
      if (bottomRight >= level) code |= 2
      if (bottomLeft >= level) code |= 1
      if (code === 0 || code === 15) continue

      // Les quatre points de passage possibles, sur les quatre côtés de la case.
      const top = { x: unit(x + cut(topLeft, topRight)), y: unit(y) }
      const right = { x: unit(x + 1), y: unit(y + cut(topRight, bottomRight)) }
      const bottom = { x: unit(x + cut(bottomLeft, bottomRight)), y: unit(y + 1) }
      const left = { x: unit(x), y: unit(y + cut(topLeft, bottomLeft)) }
      const push = (a: { x: number; y: number }, b: { x: number; y: number }): void => {
        segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })
      }

      switch (code) {
        case 1:
        case 14:
          push(left, bottom)
          break
        case 2:
        case 13:
          push(bottom, right)
          break
        case 3:
        case 12:
          push(left, right)
          break
        case 4:
        case 11:
          push(top, right)
          break
        case 6:
        case 9:
          push(top, bottom)
          break
        case 7:
        case 8:
          push(left, top)
          break
        /* Cas ambigus : les deux diagonales franchissent le niveau, et deux lectures sont
           possibles. On tranche par la moyenne des quatre coins — au-dessus du niveau, le
           centre appartient à l'intérieur et les coins opposés se rejoignent. */
        case 5:
        case 10: {
          const middle = (topLeft + topRight + bottomRight + bottomLeft) / 4
          const joined = code === 5 ? middle >= level : middle < level
          if (joined) {
            push(left, top)
            push(bottom, right)
          } else {
            push(left, bottom)
            push(top, right)
          }
          break
        }
      }
    }
  }
  return segments
}

/**
 * La région, en bits.
 *
 * Un masque plutôt qu'un polygone, pour la même raison qui fait rendre des segments plutôt
 * qu'un contour fermé : l'appartenance se lit en une case, et déformer la frontière revient à
 * peindre. Recoudre des polygones — emboîtés, une collection pouvant en cerner une autre —
 * aurait rendu chaque opération fragile pour aucun gain.
 *
 * 192 × 192 bits font 4 608 octets par collection : une bibliothèque à vingt collections tient
 * dans 92 Ko. Un polygone lissé n'aurait pas coûté beaucoup moins, et n'aurait pas survécu aux
 * déformations successives.
 */
export function maskFromField(field: Field, level = FIELD_LEVEL): Uint8Array {
  const mask = new Uint8Array(Math.ceil((field.size * field.size) / 8))
  for (let i = 0; i < field.values.length; i += 1) {
    if (field.values[i] >= level) mask[i >> 3] |= 1 << (i & 7)
  }
  return mask
}

/** Le point du repère unité est-il dans la région ? */
export function insideMask(mask: Uint8Array, x: number, y: number, size = FIELD_SIZE): boolean {
  const gx = Math.round(x * (size - 1))
  const gy = Math.round(y * (size - 1))
  if (gx < 0 || gy < 0 || gx >= size || gy >= size) return false
  const index = gy * size + gx
  return (mask[index >> 3] & (1 << (index & 7))) !== 0
}

/**
 * Pousse la frontière au pinceau, dans le repère unité.
 *
 * C'est la traduction de « tirer sur le contour » : on n'attrape pas une poignée sur une
 * ligne — il faudrait un polygone, et une poignée par sommet — on repousse la région ou on la
 * creuse. Le geste reste le même quel que soit l'endroit du contour, y compris là où il n'y
 * avait aucun sommet à saisir.
 */
export function paintMask(
  mask: Uint8Array,
  x: number,
  y: number,
  radius: number,
  add: boolean,
  size = FIELD_SIZE
): void {
  const cx = x * (size - 1)
  const cy = y * (size - 1)
  const reach = radius * (size - 1)
  const left = Math.max(0, Math.floor(cx - reach))
  const right = Math.min(size - 1, Math.ceil(cx + reach))
  const top = Math.max(0, Math.floor(cy - reach))
  const bottom = Math.min(size - 1, Math.ceil(cy + reach))
  for (let gy = top; gy <= bottom; gy += 1) {
    for (let gx = left; gx <= right; gx += 1) {
      if (Math.hypot(gx - cx, gy - cy) > reach) continue
      const index = gy * size + gx
      if (add) mask[index >> 3] |= 1 << (index & 7)
      else mask[index >> 3] &= ~(1 << (index & 7))
    }
  }
}

/** Le champ équivalent à un masque, pour retracer son contour après déformation. */
export function fieldFromMask(mask: Uint8Array, size = FIELD_SIZE): Field {
  const values = new Float32Array(size * size)
  for (let i = 0; i < values.length; i += 1) {
    values[i] = (mask[i >> 3] & (1 << (i & 7))) !== 0 ? 1 : 0
  }
  return { size, values }
}

/** Le niveau à passer à `isoContour` pour un champ issu d'un masque : entre dedans et dehors. */
export const MASK_LEVEL = 0.5

/**
 * Les régions de toutes les collections, découpées **les unes contre les autres**.
 *
 * Seuiller chaque champ dans son coin ne marche pas, et le voir suffit : les collections ne
 * sont pas des taches séparées, elles s'interpénètrent. Chacune franchissait alors son seuil
 * sur presque toute la carte, et vingt contours se superposaient jusqu'à ne plus rien montrer.
 *
 * Une case revient donc à **la collection qui y domine** — celle dont la densité y est la plus
 * forte — et à personne quand aucune n'y pèse assez. Les régions se partagent la surface au
 * lieu de la revendiquer chacune en entier : elles ne peuvent plus se chevaucher, par
 * construction, et deux voisines partagent une frontière commune plutôt que deux traits qui
 * se croisent.
 *
 * `margin` écarte les cases disputées : sous ce rapport entre la première et la deuxième
 * densité, on préfère ne rien attribuer. C'est ce qui laisse une respiration entre deux
 * régions au lieu d'une frontière arbitraire au milieu d'un mélange.
 */
export function ownershipMasks(
  groups: { group: string; points: FieldPoint[] }[],
  level = FIELD_LEVEL,
  margin = 1.1,
  size = FIELD_SIZE,
  radius = FIELD_RADIUS
): Map<string, Uint8Array> {
  const fields = groups.map((entry) => ({
    group: entry.group,
    field: densityField(entry.points, size, radius)
  }))
  const masks = new Map<string, Uint8Array>()
  for (const entry of fields) masks.set(entry.group, new Uint8Array(Math.ceil((size * size) / 8)))
  const cells = size * size
  for (let i = 0; i < cells; i += 1) {
    let bestValue = 0
    let secondValue = 0
    let best = ''
    for (const entry of fields) {
      const value = entry.field.values[i]
      if (value > bestValue) {
        secondValue = bestValue
        bestValue = value
        best = entry.group
      } else if (value > secondValue) {
        secondValue = value
      }
    }
    if (!best || bestValue < level) continue
    // Case disputée : on la laisse vide plutôt que de trancher au hasard.
    if (secondValue > 0 && bestValue < secondValue * margin) continue
    const mask = masks.get(best)
    if (mask) mask[i >> 3] |= 1 << (i & 7)
  }
  return masks
}

/** Un point du plan, dans le repère unité de la carte. */
export interface Vertex {
  x: number
  y: number
}

/**
 * Recoud les segments d'une ligne de niveau en anneaux fermés.
 *
 * Les segments sortent des carrés marchants dans le désordre. Tant qu'on ne faisait que les
 * tracer, l'ordre n'importait pas ; il devient indispensable dès qu'on veut simplifier,
 * lisser, ou poser des poignées dessus — toutes opérations qui supposent de savoir ce qui
 * suit quoi.
 *
 * Les extrémités se recollent par leurs coordonnées : deux cases voisines produisent le même
 * point de passage sur leur arête commune, au bit près, puisqu'il vient du même calcul.
 */
export function stitchRings(segments: Segment[], size = FIELD_SIZE): Vertex[][] {
  const key = (x: number, y: number): string =>
    `${Math.round(x * (size - 1) * 64)}:${Math.round(y * (size - 1) * 64)}`
  const links = new Map<string, { point: Vertex; next: Vertex[] }>()
  const touch = (point: Vertex): { point: Vertex; next: Vertex[] } => {
    const id = key(point.x, point.y)
    let entry = links.get(id)
    if (!entry) {
      entry = { point, next: [] }
      links.set(id, entry)
    }
    return entry
  }
  for (const segment of segments) {
    const a = touch({ x: segment.x1, y: segment.y1 })
    const b = touch({ x: segment.x2, y: segment.y2 })
    a.next.push(b.point)
    b.next.push(a.point)
  }

  const rings: Vertex[][] = []
  const spent = new Set<string>()
  for (const [id, entry] of links) {
    if (spent.has(id)) continue
    const ring: Vertex[] = []
    let current = entry.point
    let previous: string | null = null
    for (let guard = 0; guard < links.size + 2; guard += 1) {
      const here = key(current.x, current.y)
      if (spent.has(here)) break
      spent.add(here)
      ring.push(current)
      const options = links.get(here)?.next ?? []
      const forward = options.find((candidate) => key(candidate.x, candidate.y) !== previous)
      if (!forward) break
      previous = here
      current = forward
    }
    // Un anneau de moins de quatre points n'est pas une forme : c'est un artefact de bord.
    if (ring.length >= 4) rings.push(ring)
  }
  return rings
}

/**
 * Retire les points qui ne disent rien de la forme, par Douglas–Peucker.
 *
 * Un contour de carrés marchants compte un point par case traversée — plusieurs centaines pour
 * une région, tous alignés par petits paquets. Les garder rendrait l'édition impraticable : on
 * ne pose pas de poignées sur trois cents sommets.
 */
export function simplifyRing(ring: Vertex[], tolerance: number): Vertex[] {
  if (ring.length < 4) return ring
  const keep = new Uint8Array(ring.length)
  keep[0] = 1
  keep[ring.length - 1] = 1
  const stack: [number, number][] = [[0, ring.length - 1]]
  while (stack.length > 0) {
    const [from, to] = stack.pop() as [number, number]
    let worst = 0
    let at = -1
    const a = ring[from]
    const b = ring[to]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length = Math.hypot(dx, dy) || 1
    for (let i = from + 1; i < to; i += 1) {
      const distance = Math.abs((ring[i].x - a.x) * dy - (ring[i].y - a.y) * dx) / length
      if (distance > worst) {
        worst = distance
        at = i
      }
    }
    if (at > 0 && worst > tolerance) {
      keep[at] = 1
      stack.push([from, at], [at, to])
    }
  }
  return ring.filter((_, index) => keep[index] === 1)
}

/** Une courbe cubique, telle qu'on la trace et qu'on la manipule. */
export interface Curve {
  /** Le sommet où la courbe arrive. */
  to: Vertex
  /** Poignée sortante du sommet précédent, puis entrante de celui-ci. */
  c1: Vertex
  c2: Vertex
}

/**
 * Transforme un anneau de sommets en courbes lisses fermées.
 *
 * Les poignées viennent d'une spline de Catmull–Rom convertie en Bézier cubique : la courbe
 * passe **par** les sommets — ce qui est indispensable pour que déplacer un point fasse ce
 * qu'on attend — tout en arrondissant les angles que les carrés marchants laissent partout.
 *
 * `tension` à 1/6 est la conversion exacte ; en dessous la courbe se raidit vers le polygone,
 * au-dessus elle boucle et se recroise dans les virages serrés.
 */
export function ringToCurves(ring: Vertex[], tension = 1 / 6): Curve[] {
  const count = ring.length
  if (count < 3) return []
  const curves: Curve[] = []
  for (let i = 0; i < count; i += 1) {
    const previous = ring[(i - 1 + count) % count]
    const current = ring[i]
    const next = ring[(i + 1) % count]
    const after = ring[(i + 2) % count]
    curves.push({
      c1: {
        x: current.x + (next.x - previous.x) * tension,
        y: current.y + (next.y - previous.y) * tension
      },
      c2: {
        x: next.x - (after.x - current.x) * tension,
        y: next.y - (after.y - current.y) * tension
      },
      to: next
    })
  }
  return curves
}

/** Le point est-il dans l'anneau ? Lancer de rayon, comme pour le lasso. */
export function insideRing(ring: Vertex[], x: number, y: number): boolean {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    const straddles = a.y > y !== b.y > y
    if (straddles && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}

/**
 * Repousse les sommets d'une région hors d'une autre.
 *
 * Pousser une frontière doit faire reculer celle d'en face : sans cela, avancer sur son voisin
 * produit deux contours qui se recouvrent, et un post pris dans les deux n'a plus de
 * propriétaire — exactement ce que le découpage par domination évitait au premier tracé.
 *
 * On ne calcule pas une soustraction de polygones : chaque sommet pris à l'intérieur est
 * ramené sur l'arête la plus proche de l'envahisseur, avec un cheveu de marge. Le résultat
 * suit le geste au pixel près là où on pousse, ce qui est ce qu'on regarde, et laisse le reste
 * du contour intact.
 */
export function carveOutside(rings: Vertex[][], invader: Vertex[][]): Vertex[][] {
  if (invader.length === 0) return rings
  const nearestOnRing = (ring: Vertex[], point: Vertex): { at: Vertex; distance: number } => {
    let best = ring[0]
    let bestDistance = Infinity
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const lengthSquared = dx * dx + dy * dy || 1
      let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared
      t = Math.max(0, Math.min(1, t))
      const at = { x: a.x + dx * t, y: a.y + dy * t }
      const distance = Math.hypot(at.x - point.x, at.y - point.y)
      if (distance < bestDistance) {
        bestDistance = distance
        best = at
      }
    }
    return { at: best, distance: bestDistance }
  }
  return rings.map((ring) =>
    ring.map((vertex) => {
      const swallowed = invader.some((other) => insideRing(other, vertex.x, vertex.y))
      if (!swallowed) return vertex
      let moved = vertex
      let bestDistance = Infinity
      for (const other of invader) {
        const near = nearestOnRing(other, vertex)
        if (near.distance < bestDistance) {
          bestDistance = near.distance
          moved = near.at
        }
      }
      /* Un cheveu au-delà de l'arête : posé exactement dessus, le sommet retomberait dedans au
         prochain test selon l'arrondi, et la région se ferait ronger geste après geste. */
      const dx = moved.x - vertex.x
      const dy = moved.y - vertex.y
      const length = Math.hypot(dx, dy) || 1
      return { x: moved.x + (dx / length) * 0.002, y: moved.y + (dy / length) * 0.002 }
    })
  )
}
