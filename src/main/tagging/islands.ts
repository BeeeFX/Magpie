import type { ProjectedPoint } from './projection-core'

/**
 * Les régions de la carte, trouvées dans la carte.
 *
 * Jusqu'ici les noms affichés sur la carte venaient d'ailleurs : les catégories de l'organiseur,
 * décidées dans les 1 536 dimensions, puis posées sur le nuage. C'est une information juste, mais
 * ce n'est pas une **carte** — une carte nomme ce qu'on voit à l'endroit où on le voit, et une
 * catégorie qui se répartit en trois taches n'a pas d'endroit.
 *
 * On cherche donc les amas là où l'œil les cherche : dans le nuage projeté. C'est la méthode que
 * les atlas d'embeddings ont convergé à employer (Embedding Atlas, arXiv:2504.07285), et elle
 * tient en trois gestes.
 *
 * **Un champ de densité.** Chaque post dépose une bosse ; les bosses s'additionnent. Le relief
 * qui en résulte est exactement ce que l'œil lit comme « une tache ».
 *
 * **Une ligne de partage des eaux.** On descend le relief du sommet vers la mer, et chaque case
 * rejoint le bassin de ses voisines déjà visitées. Deux bassins qui se rencontrent forment un
 * col : c'est là que passe la frontière.
 *
 * **Une fusion par persistance.** Un relief réel est bosselé, et un col d'un centimètre ne sépare
 * pas deux montagnes. On ne garde donc un bassin distinct que si son sommet domine le col par
 * lequel il touche son voisin d'au moins `persistence`. Sans ce filtre, neuf mille posts donnent
 * des centaines de micro-amas ; avec, on obtient les quelques dizaines de régions qu'un lecteur
 * nommerait lui-même. C'est la même idée que la persistance en homologie : ne garder que les
 * structures qui survivent à un balayage de seuil.
 *
 * Rien ici ne définit une appartenance. Une collection reste une requête — voir la note en tête
 * de `prototypes` —, et une région ne sert qu'à **dire ce qu'il y a là**. C'est aussi pourquoi
 * les régions n'ont pas à être stables : elles se recalculent avec la carte, à partir d'elle.
 */

export interface Island {
  id: string
  name: string
  /** Le sommet du relief, en repère unité : c'est là que se pose l'étiquette. */
  x: number
  y: number
  size: number
}

export interface IslandTuning {
  /** Côté de la grille du relief, en cases. */
  field: number
  /** Rayon d'influence d'un post, en cases. */
  radius: number
  /** Sous ce niveau, c'est la mer : aucune région ne revendique la case. */
  floor: number
  /** Dénivelé minimal, en part du plus haut sommet, pour qu'un bassin reste distinct. */
  persistence: number
  /** En dessous de tant de posts, une région n'est pas une région. */
  minimum: number
}

/**
 * Réglages mesurés par `npm run bench:map-regions`, sur la bibliothèque de référence
 * (9 828 posts, projection à 30 voisins et départ spectral).
 *
 * Le juge est un regroupement fait **dans les vecteurs** — k-moyennes sphériques sur les 1 536
 * dimensions, indépendant de la projection. « Pureté » est la part des membres d'une région qui
 * appartiennent au même groupe de sens ; « info. » est l'information mutuelle normalisée, qui
 * pénalise le morcellement là où la pureté le récompense :
 *
 *   persistance   régions   couverture   la plus grosse   pureté   info.
 *          0,01        23       99,7 %           20,5 %   54,4 %   51,2 %
 *          0,02        22       99,7 %           20,5 %   54,2 %   51,1 %
 *          0,04        21       99,7 %           20,5 %   54,2 %   51,1 %   ← retenu
 *          0,08        19       99,7 %           20,5 %   52,7 %   50,4 %
 *          0,12        17       99,7 %           20,5 %   47,9 %   49,3 %
 *          0,20        13       99,7 %           22,3 %   38,7 %   45,2 %
 *          0,30         9       99,7 %           46,5 %   23,0 %   35,7 %
 *
 * Les deux mesures montent ensemble quand la persistance descend, puis se posent : entre 0,04 et
 * 0,01 il n'y a plus rien à gagner, seulement deux étiquettes de plus à lire. On prend donc la
 * **plus grande persistance qui tienne encore le plateau** — celle qui donne le moins de régions
 * sans rien perdre. Au-delà de 0,12 la dégradation est franche, et à 0,30 une seule région avale
 * la moitié de la bibliothèque.
 *
 * **Ce que le relief apporte, et où il ne l'apporte pas.** Comparé à un k-moyennes du plan au
 * même nombre de régions — vingt et une —, il ne gagne rien : 54,2 % de pureté contre 56,3 %,
 * 51,1 % d'information mutuelle contre 51,4 %. Découper le plan en cellules régulières range les
 * posts tout aussi bien, et il faut le dire.
 *
 * Ce qui change est **où passe la frontière**. La densité moyenne le long des bords vaut 84,0 %
 * de la densité habitée pour le relief, contre 98,9 % pour le k-moyennes : le relief coupe dans
 * les vallées, le découpage naïf coupe en plein milieu des amas. Deux moitiés parfaitement pures
 * séparées par une frontière qui ne veut rien dire — c'est ce défaut-là qu'un lecteur voit, et
 * aucune pureté ne l'attrape.
 */
export const ISLAND_TUNING: IslandTuning = {
  field: 160,
  /* Huit cases sur cent soixante, soit un vingtième de la carte : assez large pour qu'un amas
     clairsemé forme un relief continu, assez fin pour que deux amas voisins gardent leur col. */
  radius: 8,
  /* Presque nul, et c'est voulu : le plancher ne sépare pas les régions — la persistance s'en
     charge — il dit seulement où finit la terre. Le monter découpe des trous à l'intérieur des
     régions et laisse des milliers de posts sans nom. */
  floor: 0.05,
  persistence: 0.04,
  minimum: 25
}

/** Le relief : chaque post dépose une bosse qui s'éteint doucement à son rayon. */
function relief(points: ProjectedPoint[], field: number, radius: number): Float32Array {
  const grid = new Float32Array(field * field)
  const squared = radius * radius
  for (const point of points) {
    const cx = point.x * field
    const cy = point.y * field
    const lowX = Math.max(0, Math.floor(cx - radius))
    const highX = Math.min(field - 1, Math.ceil(cx + radius))
    const lowY = Math.max(0, Math.floor(cy - radius))
    const highY = Math.min(field - 1, Math.ceil(cy + radius))
    for (let y = lowY; y <= highY; y += 1) {
      const dy = y + 0.5 - cy
      for (let x = lowX; x <= highX; x += 1) {
        const dx = x + 0.5 - cx
        const distance = dx * dx + dy * dy
        if (distance >= squared) continue
        /* En `(1 - d²/r²)²` : nulle *et plate* au bord, donc les frontières ne montrent pas les
           facettes de chaque post, ce qu'un cône ou une gaussienne tronquée laisseraient voir. */
        const fall = 1 - distance / squared
        grid[y * field + x] += fall * fall
      }
    }
  }
  return grid
}

/** Union-find, avec compression de chemin. */
function rootOf(parent: Int32Array, cell: number): number {
  let root = cell
  while (parent[root] !== root) root = parent[root]
  let walk = cell
  while (parent[walk] !== root) {
    const next = parent[walk]
    parent[walk] = root
    walk = next
  }
  return root
}

/**
 * Les bassins du relief, du sommet vers la mer.
 *
 * Rend, pour chaque case, le bassin auquel elle appartient — ou -1 si elle est sous le niveau
 * de la mer. L'ordre décroissant est ce qui rend l'algorithme si simple : quand on arrive sur
 * une case, toutes ses voisines plus hautes sont déjà rangées, et il n'y a que trois cas.
 */
function basins(
  grid: Float32Array,
  field: number,
  floor: number,
  persistence: number
): Int32Array {
  const cells = grid.length
  const parent = new Int32Array(cells).fill(-1)
  const peak = new Float32Array(cells)

  let highest = 0
  for (let i = 0; i < cells; i += 1) if (grid[i] > highest) highest = grid[i]
  const sea = highest * floor
  const gap = highest * persistence

  const order: number[] = []
  for (let i = 0; i < cells; i += 1) if (grid[i] > sea) order.push(i)
  order.sort((left, right) => grid[right] - grid[left])

  for (const cell of order) {
    const x = cell % field
    const y = (cell - x) / field
    const found = new Set<number>()
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= field || ny >= field) continue
        const neighbour = ny * field + nx
        if (parent[neighbour] === -1) continue
        found.add(rootOf(parent, neighbour))
      }
    }

    if (found.size === 0) {
      // Un sommet : personne au-dessus, donc une région commence ici.
      parent[cell] = cell
      peak[cell] = grid[cell]
      continue
    }

    let deepest = -1
    for (const root of found) if (deepest === -1 || peak[root] > peak[deepest]) deepest = root
    /* Un col. Chaque bassin qui n'a pas creusé `gap` au-dessus de ce niveau n'était qu'une
       bosse du même relief : il rejoint le plus haut. Les autres restent, et la frontière
       passe ici. */
    for (const root of found) {
      if (root === deepest) continue
      if (peak[root] - grid[cell] < gap) parent[root] = deepest
    }
    parent[cell] = deepest
  }

  const label = new Int32Array(cells).fill(-1)
  for (let i = 0; i < cells; i += 1) if (parent[i] !== -1) label[i] = rootOf(parent, i)
  return label
}

/**
 * Le nom d'une région, par c-TF-IDF.
 *
 * Un comptage brut fait remonter dans chaque région le vocabulaire commun à toute la
 * bibliothèque : « video » et « art » y gagnent partout, et trois régions voisines finissent par
 * porter le même nom. La pondération de BERTopic corrige exactement ça — la fréquence d'un terme
 * *dans* la région, divisée par la taille de la région, multipliée par la rareté du terme
 * *ailleurs* : `tf(t, r) / |r| × log(1 + A / f(t))`, où `f(t)` compte les posts de toute la
 * bibliothèque qui emploient le terme et `A` la taille moyenne d'une région.
 *
 * Un terme présent partout voit son logarithme tomber à zéro et disparaît ; un terme qui n'est
 * qu'ici garde tout son poids même s'il n'apparaît que dix fois.
 */
function name(
  members: string[],
  termsOf: (id: string) => Iterable<string>,
  everywhere: Map<string, number>,
  average: number
): string {
  const counts = new Map<string, number>()
  for (const id of members) {
    for (const term of new Set(termsOf(id))) counts.set(term, (counts.get(term) ?? 0) + 1)
  }

  const ranked = [...counts]
    /* Trois occurrences au moins : en dessous, le terme le plus « rare ailleurs » est toujours
       une coquille ou un mot d'une seule légende, et il gagnerait à tous les coups.

       Trois lettres au moins aussi, et c'est une correction : « co » — le reste des liens
       `t.co` — nommait à lui seul la plus grosse région de la bibliothèque de référence. Deux
       lettres ne portent jamais un sujet, et la liste de mots vides ne peut pas les prévoir
       toutes. */
    .filter(([term, count]) => count >= 3 && term.length >= 3)
    .map(([term, count]) => {
      const spread = everywhere.get(term) ?? 1
      return [term, (count / members.length) * Math.log(1 + average / spread)] as const
    })
    .sort((left, right) => right[1] - left[1])

  const kept: string[] = []
  for (const [term] of ranked) {
    // « blender » et « blender3d » ne disent qu'une chose : on ne garde pas les deux.
    if (kept.some((word) => word.includes(term) || term.includes(word))) continue
    kept.push(term)
    if (kept.length === 2) break
  }
  return kept.map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1)).join(' · ')
}

/**
 * Les régions d'une carte, nommées.
 *
 * `termsOf` rend les mots d'un post — l'appelant décide de ce qui compte comme mot, ce qui garde
 * ce module testable sans base de données et sans réglage de langue.
 */
export function findIslands(
  points: ProjectedPoint[],
  termsOf: (id: string) => Iterable<string>,
  tuning: IslandTuning = ISLAND_TUNING
): Island[] {
  if (points.length === 0) return []
  const { field, radius, floor, persistence, minimum } = tuning

  const grid = relief(points, field, radius)
  const label = basins(grid, field, floor, persistence)

  const members = new Map<number, string[]>()
  for (const point of points) {
    const x = Math.min(field - 1, Math.max(0, Math.floor(point.x * field)))
    const y = Math.min(field - 1, Math.max(0, Math.floor(point.y * field)))
    const basin = label[y * field + x]
    if (basin < 0) continue
    const list = members.get(basin)
    if (list) list.push(point.id)
    else members.set(basin, [point.id])
  }

  const everywhere = new Map<string, number>()
  for (const point of points) {
    for (const term of new Set(termsOf(point.id))) {
      everywhere.set(term, (everywhere.get(term) ?? 0) + 1)
    }
  }

  const big = [...members].filter(([, list]) => list.length >= minimum)
  const average = big.length > 0 ? points.length / big.length : points.length

  return big
    .map(([basin, list]) => ({
      /* La case du sommet, qui *est* la racine de l'union-find : c'est la seule case du bassin
         que rien ne surplombe, donc l'endroit où poser le nom. */
      id: `island-${basin}`,
      name: name(list, termsOf, everywhere, average) || 'Sans nom',
      x: ((basin % field) + 0.5) / field,
      y: (Math.floor(basin / field) + 0.5) / field,
      size: list.length
    }))
    .sort((left, right) => right.size - left.size)
}

/** Les membres de chaque région — pour les bancs, qui mesurent l'accord avec le sens. */
export function islandMembership(
  points: ProjectedPoint[],
  tuning: IslandTuning = ISLAND_TUNING
): Map<string, number> {
  const { field, radius, floor, persistence, minimum } = tuning
  const label = basins(relief(points, field, radius), field, floor, persistence)
  const counts = new Map<number, number>()
  const at = new Map<string, number>()
  for (const point of points) {
    const x = Math.min(field - 1, Math.max(0, Math.floor(point.x * field)))
    const y = Math.min(field - 1, Math.max(0, Math.floor(point.y * field)))
    const basin = label[y * field + x]
    if (basin < 0) continue
    at.set(point.id, basin)
    counts.set(basin, (counts.get(basin) ?? 0) + 1)
  }
  for (const [id, basin] of at) if ((counts.get(basin) ?? 0) < minimum) at.delete(id)
  return at
}
