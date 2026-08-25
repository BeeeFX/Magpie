import type { MapLabel, OrganizerMapPoint } from '@shared/types'

/**
 * Les noms qui apparaissent quand on zoome.
 *
 * La carte ne portait qu'un seul étage de noms : les vingt-quatre amas de l'analyse, posés une
 * fois pour toutes. Zoomer les grossissait sans jamais en révéler d'autres, alors que c'est
 * exactement le moment où l'on cherche à savoir *ce qu'il y a dedans*. Ici on découpe chaque amas
 * en sous-amas, et chacun prend le mot qui le distingue de son parent : dans « Musique »
 * apparaissent « guitare », « ableton », « vinyle ».
 *
 * **Ce sont des noms d'amas, et rien d'autre.** Trois planchers l'imposent, et ils sont durs :
 * un sous-amas doit peser au moins vingt posts, représenter au moins un huitième de son parent,
 * et son mot doit être porté par un cinquième de ses membres tout en y étant deux fois plus
 * fréquent que chez le parent. Sans quoi il n'a pas de nom — et un amas sans nom vaut mieux
 * qu'une étiquette sur trois posts, qui donnerait l'illusion d'une structure là où il n'y a que
 * du bruit. La descente s'arrête à deux étages sous les amas, et seuls les gros y ont droit.
 *
 * Le découpage suit les taches, pas une grille arbitraire : deux posts appartiennent au même
 * sous-amas s'ils se touchent de proche en proche. C'est ce que l'œil appelle « un paquet », et
 * ça évite de couper en deux un amas qui n'a qu'une seule masse — auquel cas on n'affine pas,
 * et c'est la bonne réponse.
 */

/** Un sous-amas porte un nom, ou il n'en porte pas. Vingt posts est le plancher. */
const MIN_POSTS = 20
/** Et il doit peser dans son parent : sinon un gros amas se couvrirait de miettes nommées. */
const MIN_SHARE = 0.125
/** Deux étages sous les amas, pas plus : au-delà on nomme des habitudes, pas des sujets. */
const MAX_LEVEL = 2
/** Seuls les sous-amas encore massifs se redécoupent. */
const MIN_FOR_DEEPER = 220
/**
 * Le mot doit être porté par un cinquième des membres, et être deux fois plus fréquent ici que
 * chez le parent.
 *
 * Les deux seuils sont mesurés, pas choisis à l'œil. Sur la bibliothèque de référence ils
 * donnent six noms, et six noms justes : b3d, c4d, anime, arcane, photo, model. Un cran plus bas
 * — 0,15 et 1,6 — en donnent treize, dont « final », « source », « real » et « now » : des mots
 * fréquents, pas des endroits. Le rendement double et la moitié ne veut rien dire, ce qui est
 * pire que rien : un nom sur la carte est une promesse qu'il y a quelque chose à voir.
 *
 * Six est donc maigre à dessein. Et ça montera tout seul : ces noms viennent des mots des
 * posts, et quatre mille cinq cents vidéos retrouvent les leurs avec la transcription réparée.
 */
const MIN_SUPPORT = 0.2
const MIN_LIFT = 2

interface Cluster {
  points: OrganizerMapPoint[]
  x: number
  y: number
}

/** Les taches d'un nuage à une finesse donnée, trouvées de proche en proche. */
function flood(points: OrganizerMapPoint[], cell: number): Cluster[] {
  const cells = new Map<string, OrganizerMapPoint[]>()
  for (const point of points) {
    const key = `${Math.floor(point.x / cell)}:${Math.floor(point.y / cell)}`
    const list = cells.get(key)
    if (list) list.push(point)
    else cells.set(key, [point])
  }

  const visited = new Set<string>()
  const clusters: Cluster[] = []
  for (const start of cells.keys()) {
    if (visited.has(start)) continue
    const members: OrganizerMapPoint[] = []
    const queue = [start]
    visited.add(start)
    while (queue.length > 0) {
      const key = queue.pop() as string
      members.push(...(cells.get(key) ?? []))
      const [cx, cy] = key.split(':').map(Number)
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const near = `${cx + dx}:${cy + dy}`
          if (!cells.has(near) || visited.has(near)) continue
          visited.add(near)
          queue.push(near)
        }
      }
    }
    let x = 0
    let y = 0
    for (const member of members) {
      x += member.x
      y += member.y
    }
    clusters.push({ points: members, x: x / members.length, y: y / members.length })
  }
  return clusters
}

/**
 * Découpe un nuage en sous-amas nommables, ou renonce.
 *
 * On descend en finesse jusqu'à trouver **au moins deux** taches qui tiennent les planchers, et
 * on s'arrête à la première finesse qui y parvient : c'est le découpage le plus grossier qui
 * dise quelque chose, donc celui dont les morceaux sont les plus gros et les noms les plus
 * larges. Descendre plus loin donnerait des paquets plus fins et des noms plus pointus — c'est
 * exactement ce que le niveau suivant fera, sur chacun d'eux.
 *
 * Deux, et pas un : un seul sous-amas qui passe les planchers, c'est le parent sous un autre nom.
 * Et si aucune finesse n'y arrive, cet amas n'a pas de structure interne lisible — on ne lui en
 * invente pas.
 */
function split(points: OrganizerMapPoint[]): Cluster[] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }
  const extent = Math.max(maxX - minX, maxY - minY)
  if (extent <= 0) return []

  for (let attempt = 0; attempt < 7; attempt += 1) {
    const cell = extent / (4 * 1.45 ** attempt)
    const viable = flood(points, cell).filter(
      (cluster) =>
        cluster.points.length >= MIN_POSTS && cluster.points.length >= points.length * MIN_SHARE
    )
    if (viable.length >= 2) return viable
  }
  return []
}

/**
 * Le mot qui distingue un sous-amas de son parent.
 *
 * Pas le plus fréquent — ce serait le mot du parent, présent partout — mais celui dont la
 * présence ici s'écarte le plus de ce qu'elle est chez le parent. Un mot porté par la moitié du
 * sous-amas alors qu'il ne touche qu'un dixième du parent dit quelque chose ; un mot porté par
 * tout le monde ne dit rien.
 */
function distinctiveTerm(
  members: OrganizerMapPoint[],
  parent: OrganizerMapPoint[],
  terms: Map<string, Set<string>>,
  taken: Set<string>
): string | null {
  const here = new Map<string, number>()
  for (const point of members) {
    for (const term of terms.get(point.id) ?? []) here.set(term, (here.get(term) ?? 0) + 1)
  }
  const above = new Map<string, number>()
  for (const point of parent) {
    for (const term of terms.get(point.id) ?? []) above.set(term, (above.get(term) ?? 0) + 1)
  }

  let best: string | null = null
  let bestScore = 0
  for (const [term, count] of here) {
    if (taken.has(term)) continue
    const support = count / members.length
    if (support < MIN_SUPPORT) continue
    const parentRate = (above.get(term) ?? count) / parent.length
    const lift = parentRate > 0 ? support / parentRate : 0
    if (lift < MIN_LIFT) continue
    /* Le soutien décide de l'ampleur, l'écart décide de la pertinence : le produit garde un mot
       porté par beaucoup **et** propre à cet endroit. */
    const score = support * Math.log(lift)
    if (score > bestScore) {
      bestScore = score
      best = term
    }
  }
  return best
}

function walk(
  points: OrganizerMapPoint[],
  group: string,
  level: number,
  terms: Map<string, Set<string>>,
  taken: Set<string>,
  out: MapLabel[]
): void {
  if (level > MAX_LEVEL) return
  const clusters = split(points)
  for (const cluster of clusters) {
    if (cluster.points.length < MIN_POSTS) continue
    if (cluster.points.length < points.length * MIN_SHARE) continue
    const term = distinctiveTerm(cluster.points, points, terms, taken)
    if (!term) continue
    taken.add(term)
    out.push({
      id: `${level}:${term}:${out.length}`,
      group,
      level,
      text: term,
      x: cluster.x,
      y: cluster.y,
      count: cluster.points.length
    })
    if (cluster.points.length >= MIN_FOR_DEEPER) {
      walk(cluster.points, group, level + 1, terms, taken, out)
    }
  }
}

/**
 * Les étages de noms, sous ceux des amas.
 *
 * Le niveau 0 reste ce que la carte affiche déjà — les amas de l'analyse. On ne produit donc que
 * ce qui vient en dessous, à partir du niveau 1, et le renderer décide à quel zoom chaque étage
 * apparaît.
 */
export function buildMapLabels(
  points: OrganizerMapPoint[],
  terms: Map<string, Set<string>>
): MapLabel[] {
  const groups = new Map<string, OrganizerMapPoint[]>()
  for (const point of points) {
    if (!point.group) continue
    const list = groups.get(point.group)
    if (list) list.push(point)
    else groups.set(point.group, [point])
  }

  const out: MapLabel[] = []
  /* Les mots déjà pris ne se reprennent pas, et le compteur traverse les amas : deux endroits
     de la carte qui portent le même nom ne s'expliquent pas l'un l'autre, ils se contredisent.
     Le premier sous-amas qui mérite « guitare » le garde. */
  const taken = new Set<string>()
  for (const [group, members] of groups) {
    if (members.length < MIN_POSTS * 2) continue
    walk(members, group, 1, terms, taken, out)
  }
  return out
}
