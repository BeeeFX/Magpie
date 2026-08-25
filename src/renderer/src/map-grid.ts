/**
 * Ranger des vignettes en damier sans qu'elles cessent d'être voisines.
 *
 * La carte place les posts là où le sens les met, et c'est ce qu'on lui demande. Mais au zoom,
 * quand les points deviennent des images, ce placement se retourne contre lui-même : là où le
 * nuage est dense les vignettes se recouvrent, et là où il est creux la page est vide. On ne
 * voit alors plus ni les unes ni les autres.
 *
 * Le damier est l'autre contrat. Il renonce aux distances exactes — deux cases voisines sont
 * toujours à la même distance, quelle que soit la ressemblance réelle — et garde en échange
 * l'**ordre** : ce qui est proche reste proche, et rien ne se recouvre. C'est le compromis que
 * la littérature sur les grilles triées appelle une *sorted grid layout*, et l'algorithme retenu
 * est celui de Barthel et al. (Computer Graphics Forum, 2023), FLAS — *Fast Linear Assignment
 * Sorting*.
 *
 * L'idée tient en une boucle. On lisse la grille — chaque case prend la moyenne de son
 * voisinage — ce qui donne, pour chaque case, « ce qu'il faudrait ici pour que la région soit
 * cohérente ». Puis on tire de petits paquets de cases au hasard et on **réaffecte
 * optimalement** les vignettes du paquet à ses cases, par une résolution exacte du problème
 * d'affectation. En répétant avec un lissage de plus en plus fin, l'arrangement descend du gros
 * grain vers le détail : les grandes masses se placent d'abord, les échanges de voisinage
 * ensuite.
 *
 * Ce qu'il rapporte, mesuré par `npm run bench:map-grid` sur trois carrés réels de la carte.
 * « Rangement direct » est ce qu'on ferait sans y penser : la position décide de la case, les
 * conflits glissent d'un cran. « Proche » compte, sur les huit voisins d'une vignette sur la
 * carte, ceux qui restent ses huit voisins de case :
 *
 *   carré              vignettes   arrangement          proche      loin    durée
 *   cœur du nuage            640   hasard                1,2 %     1,1 %     0 ms
 *                                  rangement direct     34,9 %    66,6 %     1 ms
 *                                  FLAS                 64,7 %    98,4 %    67 ms
 *   bord                     699   rangement direct     13,6 %    29,1 %     1 ms
 *                                  FLAS                 46,4 %    62,8 %    56 ms
 *   large                  1 878   rangement direct     17,4 %    44,8 %    26 ms
 *                                  FLAS                 43,4 %    76,5 %   185 ms
 *
 * Le rangement direct double le hasard ; FLAS double encore le rangement direct, et davantage
 * là où le nuage est irrégulier — c'est justement là que le rangement direct s'effondre, parce
 * que ses conflits de case le font glisser en cascade. Le prix est de l'ordre de la dizaine de
 * millisecondes pour ce qu'un écran montre, donc payable à l'intérieur d'une interaction.
 *
 * Ce que ce module *ne* fait pas : décider quand l'employer. Le damier est un autre point de vue
 * sur la même bibliothèque, pas une amélioration de la carte — la carte reste la carte, et le
 * principe qui la gouverne est qu'elle ne bouge pas sous les yeux de qui la regarde. Le damier
 * doit donc être un geste demandé, réversible et nommé, comme l'est déjà « Regrouper par style ».
 */

export interface GridItem {
  id: string
  /** La position sur la carte, en repère unité. C'est elle qu'on cherche à préserver. */
  x: number
  y: number
}

export interface GridCell {
  column: number
  row: number
}

export interface GridTuning {
  /** Rayon de lissage au départ, en cases. Il décroît jusqu'à disparaître. */
  radius: number
  /** De combien le rayon rétrécit à chaque passe. */
  cooling: number
  /** Côté d'une tuile, en cases. Une passe réaffecte `tile²` vignettes à la fois, en `tile⁶`. */
  tile: number
  seed: number
}

/**
 * Réglages mesurés par `npm run bench:map-grid`, sur un carré réel du cœur de la carte —
 * 640 vignettes, damier 28 × 28. « Proche » compte, sur les huit voisins d'une vignette sur la
 * carte, ceux qui restent ses huit voisins de case ; « loin » corrèle les rangs de toutes les
 * distances.
 *
 *   rayon   refroid.   tuile     proche      loin    durée
 *    0,50       0,85       3     46,8 %    69,1 %    21 ms
 *    0,50       0,90       3     48,6 %    72,6 %    28 ms
 *    0,50       0,95       3     62,5 %    97,4 %    31 ms
 *    0,50       0,97       3     64,4 %    98,4 %    58 ms
 *    1,00       0,95       3     64,2 %    98,5 %    34 ms
 *    0,50       0,95       2     49,4 %    85,6 %    13 ms
 *    0,50       0,95       4     64,7 %    98,4 %    35 ms   ← retenu
 *    0,50       0,97       4     64,8 %    98,5 %    63 ms
 *
 * Le **refroidissement** est le réglage qui compte, et de loin : passer de 0,85 à 0,95 fait
 * gagner seize points de voisinage et vingt-huit de structure d'ensemble pour dix millisecondes.
 * Ce n'est pas une surprise — chaque passe ne peut déplacer une vignette que d'une tuile, donc
 * un refroidissement trop rapide arrête la descente avant qu'elle ait fini de traverser. Au-delà
 * de 0,95 il ne reste rien à gagner et le temps double.
 *
 * Le **rayon de départ** ne change rien au-dessus de la moitié du damier : à ce stade le champ
 * lissé est déjà uniforme, et les premières passes ne font que brasser.
 *
 * La **tuile** doit valoir au moins trois de côté. À deux, une affectation exacte ne vaut guère
 * mieux qu'un échange deux à deux et il manque quinze points ; à quatre elle rattrape les deux
 * derniers, pour le même temps.
 */
export const GRID_TUNING: GridTuning = {
  radius: 0.5,
  cooling: 0.95,
  /* Quatre de côté, soit seize vignettes réaffectées ensemble. Il en faut au moins trois pour
     défaire une inversion à trois, que nul échange deux à deux ne rattrape ; quatre rend deux
     points de plus pour le même temps. Au-delà, le problème d'affectation est cubique en le
     nombre de vignettes de la tuile, donc en la sixième puissance du côté. */
  tile: 4,
  seed: 0x9e37
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Le problème d'affectation, résolu exactement — méthode hongroise, forme à potentiels.
 *
 * Une heuristique d'échanges deux à deux suffirait presque, et c'est précisément ce que le
 * papier de FLAS mesure comme insuffisant : une inversion à trois vignettes ne se défait par
 * aucun échange de deux, et ces inversions-là sont exactement ce qu'on voit à l'écran. La
 * taille des paquets étant petite, l'exactitude ne coûte rien.
 *
 * Rend, pour chaque ligne (vignette), la colonne (case) qui lui revient.
 */
export function assign(cost: Float64Array, size: number): Int32Array {
  const INF = Infinity
  const u = new Float64Array(size + 1)
  const v = new Float64Array(size + 1)
  const match = new Int32Array(size + 1).fill(0)
  const way = new Int32Array(size + 1).fill(0)

  for (let i = 1; i <= size; i += 1) {
    match[0] = i
    let free = 0
    const minimum = new Float64Array(size + 1).fill(INF)
    const used = new Uint8Array(size + 1)
    do {
      used[free] = 1
      const row = match[free]
      let delta = INF
      let next = 0
      for (let j = 1; j <= size; j += 1) {
        if (used[j]) continue
        const current = cost[(row - 1) * size + (j - 1)] - u[row] - v[j]
        if (current < minimum[j]) {
          minimum[j] = current
          way[j] = free
        }
        if (minimum[j] < delta) {
          delta = minimum[j]
          next = j
        }
      }
      for (let j = 0; j <= size; j += 1) {
        if (used[j]) {
          u[match[j]] += delta
          v[j] -= delta
        } else {
          minimum[j] -= delta
        }
      }
      free = next
    } while (match[free] !== 0)
    do {
      const previous = way[free]
      match[free] = match[previous]
      free = previous
    } while (free !== 0)
  }

  const out = new Int32Array(size)
  for (let j = 1; j <= size; j += 1) out[match[j] - 1] = j - 1
  return out
}

/**
 * Lissage séparable, à poids uniformes, sur une grille qui peut avoir des trous.
 *
 * Les cases vides — il y en a dès que le nombre de vignettes n'est pas un rectangle plein — ne
 * doivent pas tirer la moyenne vers zéro, ce qui creuserait un puits autour d'elles et y
 * attirerait n'importe quoi. On lisse donc la *présence* en même temps que les valeurs, et on
 * divise l'une par l'autre : une case vide prend alors la couleur de son voisinage, ce qui est
 * exactement ce qu'on veut lui dire d'accueillir.
 */
function smooth(
  values: Float64Array,
  present: Float64Array,
  columns: number,
  rows: number,
  radius: number
): { values: Float64Array; present: Float64Array } {
  const span = Math.max(1, Math.round(radius))
  const pass = (source: Float64Array, horizontal: boolean, depth: number): Float64Array => {
    const out = new Float64Array(source.length)
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        for (let d = 0; d < depth; d += 1) {
          let sum = 0
          let count = 0
          for (let step = -span; step <= span; step += 1) {
            const x = horizontal ? column + step : column
            const y = horizontal ? row : row + step
            if (x < 0 || y < 0 || x >= columns || y >= rows) continue
            sum += source[(y * columns + x) * depth + d]
            count += 1
          }
          out[(row * columns + column) * depth + d] = count > 0 ? sum / count : 0
        }
      }
    }
    return out
  }
  return {
    values: pass(pass(values, true, 2), false, 2),
    present: pass(pass(present, true, 1), false, 1)
  }
}

/**
 * Range les vignettes en damier, en gardant les voisins voisins.
 *
 * `columns × rows` doit valoir au moins le nombre de vignettes ; les cases en trop restent vides
 * et servent de respiration — c'est d'ailleurs ce qui permet à une grille de ne pas déformer un
 * nuage très allongé.
 */
export function arrangeGrid(
  items: GridItem[],
  columns: number,
  rows: number,
  tuning: GridTuning = GRID_TUNING
): Map<string, GridCell> {
  const out = new Map<string, GridCell>()
  const count = items.length
  if (count === 0) return out
  if (columns * rows < count) throw new Error('damier trop petit pour le nombre de vignettes')

  const random = mulberry32(tuning.seed)

  /* Départ : chaque vignette dans la case que sa position lui désigne, les conflits repoussés
     à la case libre suivante. Partir de la carte plutôt que du hasard évite à la descente de
     refaire tout le travail que la projection a déjà fait — et rend l'arrangement stable d'une
     ouverture à l'autre, comme la carte elle-même. */
  const at = new Int32Array(columns * rows).fill(-1)
  const cellOf = new Int32Array(count)
  const ordered = [...items.keys()].sort((left, right) => {
    const a = items[left]
    const b = items[right]
    return a.y - b.y || a.x - b.x
  })
  for (const index of ordered) {
    const item = items[index]
    const column = Math.min(columns - 1, Math.max(0, Math.floor(item.x * columns)))
    const row = Math.min(rows - 1, Math.max(0, Math.floor(item.y * rows)))
    let cell = row * columns + column
    while (at[cell] !== -1) cell = (cell + 1) % (columns * rows)
    at[cell] = index
    cellOf[index] = cell
  }

  const values = new Float64Array(columns * rows * 2)
  const present = new Float64Array(columns * rows)
  const fill = (): void => {
    values.fill(0)
    present.fill(0)
    for (let cell = 0; cell < at.length; cell += 1) {
      const index = at[cell]
      if (index < 0) continue
      values[cell * 2] = items[index].x
      values[cell * 2 + 1] = items[index].y
      present[cell] = 1
    }
  }

  let radius = Math.max(columns, rows) * tuning.radius
  const tile = Math.max(2, Math.round(tuning.tile))
  const cost = new Float64Array(tile * tile * tile * tile)
  const cells: number[] = []
  while (radius >= 0.5) {
    fill()
    const blurred = smooth(values, present, columns, rows, radius)

    /* Des **tuiles contiguës**, décalées au hasard à chaque passe. C'est le point où une
       première version s'était trompée : en tirant les paquets au hasard sur toute la grille,
       une vignette pouvait traverser le damier d'un bout à l'autre en une affectation, et le
       voisinage — la seule chose qu'un damier promette — s'effondrait. Mesuré : 12,4 % de
       voisins gardés contre 34,9 % pour un rangement direct sans aucune optimisation.
       Une tuile limite chaque échange à son propre coin, et le décalage aléatoire fait que les
       frontières de tuiles ne tombent jamais deux fois au même endroit. */
    const offsetX = Math.floor(random() * tile)
    const offsetY = Math.floor(random() * tile)
    for (let top = -offsetY; top < rows; top += tile) {
      for (let left = -offsetX; left < columns; left += tile) {
        cells.length = 0
        for (let y = Math.max(0, top); y < Math.min(rows, top + tile); y += 1) {
          for (let x = Math.max(0, left); x < Math.min(columns, left + tile); x += 1) {
            const cell = y * columns + x
            if (at[cell] >= 0) cells.push(cell)
          }
        }
        const size = cells.length
        if (size < 2) continue
        for (let i = 0; i < size; i += 1) {
          const index = at[cells[i]]
          for (let j = 0; j < size; j += 1) {
            const cell = cells[j]
            /* La valeur lissée est une somme divisée par le nombre de cases de la fenêtre,
               vides comprises ; on la redivise par la présence, lissée de la même façon, pour
               obtenir la moyenne des seules cases habitées. Sans ça, un bord de damier tire le
               champ vers zéro et y attire tout ce qui est proche de l'origine. */
            const weight = Math.max(blurred.present[cell], 1e-6)
            const dx = items[index].x - blurred.values[cell * 2] / weight
            const dy = items[index].y - blurred.values[cell * 2 + 1] / weight
            cost[i * size + j] = dx * dx + dy * dy
          }
        }
        const solved = assign(cost.subarray(0, size * size), size)
        const before = cells.map((cell) => at[cell])
        for (let i = 0; i < size; i += 1) {
          const cell = cells[solved[i]]
          at[cell] = before[i]
          cellOf[before[i]] = cell
        }
      }
    }
    radius *= tuning.cooling
  }

  items.forEach((item, index) => {
    const cell = cellOf[index]
    out.set(item.id, { column: cell % columns, row: Math.floor(cell / columns) })
  })
  return out
}
