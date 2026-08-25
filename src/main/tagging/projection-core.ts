import { UMAP } from 'umap-js'

/**
 * Projection des vecteurs de sens en deux dimensions — le calcul, et rien d'autre.
 *
 * Séparé du lanceur à dessein : ce module est importé par le fil d'exécution, qui n'a accès
 * ni à Electron ni à quoi que ce soit du processus principal. Y laisser un `import 'electron'`
 * a produit « Cannot find module 'electron' » en version installée, sans que rien ne le
 * signale au développement, où le module se résout depuis node_modules.
 *
 * C'est ce qui donne ses coordonnées à la carte. Le choix qui compte : la position vient de
 * la projection, pas d'une simulation à ressorts. Une physique déciderait de l'emplacement
 * des points et les îles ne montreraient alors que la physique ; ici la distance à l'écran
 * *est* la proximité de sens, et les îles sont réelles.
 *
 * Le rebond de la carte est de l'interaction — inertie, zoom élastique, atterrissage amorti —
 * appliqué par-dessus des positions qui ne bougent pas.
 */

export interface ProjectedPoint {
  id: string
  x: number
  y: number
}

/**
 * Analyse en composantes principales, par la matrice de covariance.
 *
 * Mêmes directions principales qu'avant, dans le même ordre, mais on cesse de relire les
 * données. La version précédente extrayait les axes un par un, et chacun redemandait douze
 * passes sur les neuf mille vecteurs : trois mille parcours de soixante mégaoctets, soit deux
 * cents gigaoctets lus pour un calcul que la mémoire bridait bien avant le processeur.
 *
 * Ici la bibliothèque n'est lue **qu'une fois**, pour former `A^T A` — et c'est possible parce
 * que la largeur est plus petite que le nombre de posts : 1 536 contre 9 790. La covariance
 * tient alors dans 1 536 × 1 536, neuf mégaoctets qui restent au chaud, et toute l'itération
 * suivante travaille dessus sans jamais retoucher aux vecteurs.
 *
 * Mesuré sur la bibliothèque de référence (9 790 posts, 1 536 dimensions, 256 axes) : voir le
 * message de commit. La projection entière coûtait 91,6 s, dont 64,4 pour cette fonction.
 *
 * Les vecteurs propres de `A^T A` sont exactement ce que l'itération de puissance cherchait à
 * approcher : le sous-espace est le même, et mieux convergé. UMAP ne lit ensuite que des
 * distances, et une autre base orthonormée du même sous-espace les laisse inchangées.
 */
function reduce(
  vectors: Float32Array[],
  dims: number,
  onStep?: (fraction: number) => void
): Float32Array[] {
  const width = vectors[0].length
  const count = vectors.length
  const target = Math.min(dims, width, count)

  const mean = new Float32Array(width)
  for (const vector of vectors) {
    for (let i = 0; i < width; i += 1) mean[i] += vector[i] / count
  }

  /* Covariance accumulée par paquets de lignes, chaque paquet transposé d'abord.
     Le paquet transposé pèse 1 536 × 64 flottants — 400 Ko, donc il tient en cache de second
     niveau — et chaque case de la covariance devient le produit scalaire de deux colonnes
     contiguës. Sans ce découpage, une mise à jour de rang 1 par vecteur balaierait les neuf
     mégaoctets de la covariance neuf mille fois. En double précision : neuf mille termes
     s'additionnent, et le simple flottant y perdrait les axes de faible variance. */
  const BLOCK = 64
  const covariance = new Float64Array(width * width)
  const column = new Float32Array(width * BLOCK)
  for (let start = 0; start < count; start += BLOCK) {
    const rows = Math.min(BLOCK, count - start)
    for (let row = 0; row < rows; row += 1) {
      const vector = vectors[start + row]
      for (let i = 0; i < width; i += 1) column[i * BLOCK + row] = vector[i] - mean[i]
    }
    onStep?.((start / count) * 0.7)
    for (let i = 0; i < width; i += 1) {
      const left = i * BLOCK
      const target_ = i * width
      for (let j = i; j < width; j += 1) {
        const right = j * BLOCK
        let sum = 0
        for (let row = 0; row < rows; row += 1) sum += column[left + row] * column[right + row]
        covariance[target_ + j] += sum
      }
    }
  }
  // La moitié inférieure, par symétrie : le produit matrice-vecteur ci-dessous la parcourt.
  for (let i = 0; i < width; i += 1) {
    for (let j = i + 1; j < width; j += 1) covariance[j * width + i] = covariance[i * width + j]
  }

  /* Itération de sous-espace sur la covariance : les 256 directions avancent ensemble, et
     l'orthonormalisation entre deux passes les empêche de retomber toutes sur la dominante.
     Départ déterministe, comme avant — deux analyses de la même bibliothèque doivent donner
     la même carte. Rangé en lignes (i * target + axis) pour que le parcours des axes soit
     contigu. */
  let basis = new Float32Array(width * target)
  for (let axis = 0; axis < target; axis += 1) {
    for (let i = 0; i < width; i += 1) basis[i * target + axis] = Math.sin((axis + 1) * (i + 1))
  }
  orthonormalise(basis, width, target)

  const ITERATIONS = 12
  for (let pass = 0; pass < ITERATIONS; pass += 1) {
    onStep?.(0.7 + (pass / ITERATIONS) * 0.3)
    const next = new Float32Array(width * target)
    for (let i = 0; i < width; i += 1) {
      const row = i * width
      const out = i * target
      for (let j = 0; j < width; j += 1) {
        const weight = covariance[row + j]
        if (weight === 0) continue
        const from = j * target
        for (let axis = 0; axis < target; axis += 1) next[out + axis] += weight * basis[from + axis]
      }
    }
    orthonormalise(next, width, target)
    basis = next
  }

  const out: Float32Array[] = []
  for (let row = 0; row < count; row += 1) {
    const vector = vectors[row]
    const projected = new Float32Array(target)
    for (let i = 0; i < width; i += 1) {
      const value = vector[i] - mean[i]
      if (value === 0) continue
      const from = i * target
      for (let axis = 0; axis < target; axis += 1) projected[axis] += value * basis[from + axis]
    }
    out.push(projected)
  }
  return out
}

/** Gram-Schmidt modifié, en place, sur une base rangée en lignes. */
function orthonormalise(basis: Float32Array, width: number, target: number): void {
  for (let axis = 0; axis < target; axis += 1) {
    for (let previous = 0; previous < axis; previous += 1) {
      let dot = 0
      for (let i = 0; i < width; i += 1) {
        dot += basis[i * target + axis] * basis[i * target + previous]
      }
      if (dot === 0) continue
      for (let i = 0; i < width; i += 1) {
        basis[i * target + axis] -= dot * basis[i * target + previous]
      }
    }
    let norm = 0
    for (let i = 0; i < width; i += 1) {
      const value = basis[i * target + axis]
      norm += value * value
    }
    norm = Math.sqrt(norm)
    /* Une direction épuisée : le sous-espace a moins de rang que d'axes demandés. On la laisse
       à zéro plutôt que de diviser par presque rien — elle ne porte de toute façon rien. */
    if (norm < 1e-9) continue
    for (let i = 0; i < width; i += 1) basis[i * target + axis] /= norm
  }
}

/** Ramène le nuage dans un carré unité, en gardant les proportions. */
/**
 * L'autre réduction : une projection aléatoire creuse, qui ne forme aucune covariance.
 *
 * La covariance coûte `n × largeur² / 2` — onze milliards d'opérations sur la bibliothèque de
 * référence — et l'itération de puissance qui la suit en coûte sept de plus. Mesuré : 37,5 s
 * des 43,8 que coûte la projection entière. Or UMAP ne lit ensuite que des **distances**, et le
 * lemme de Johnson-Lindenstrauss dit qu'une projection aléatoire les conserve à epsilon près
 * dès que la cible est de l'ordre de `log n / epsilon²` — 256 axes pour dix mille posts est
 * large. On ne cherche donc pas les directions de plus grande variance : on cherche un espace
 * plus petit où les voisinages sont les mêmes.
 *
 * Creuse au sens d'Achlioptas : chaque coefficient vaut +1 avec une chance sur six, -1 avec une
 * chance sur six, et zéro deux fois sur trois. Deux tiers des multiplications disparaîssent, et
 * celles qui restent sont des additions. La graine est fixe, comme celle d'UMAP : deux
 * ouvertures doivent rendre la même carte.
 *
 * **Mesurée, et non retenue.** Elle tient sa promesse de vitesse : 25 s contre 43, sur les trois
 * graines essayées, soit quarante pour cent de la projection. Mais la qualité ne se prononce pas.
 * Compacité, sur la bibliothèque de référence :
 *
 *   graine 1 — PCA 70,2 %   aléatoire 76,7 %
 *   graine 2 — PCA 91,5 %   aléatoire 81,6 %
 *   graine 3 — PCA 74,8 %   aléatoire 71,1 %
 *
 * Deux points d'écart entre les deux moyennes, pour vingt et un points d'écart entre les graines
 * d'une même configuration : l'instrument ne voit pas la différence qu'on lui demande de juger.
 * Et le prix de l'adoption, lui, est certain — l'empreinte change, donc la carte de chacun se
 * recalcule une fois et tous les points bougent. Dix-huit secondes gagnées sur un calcul qui,
 * depuis que les projections se rangent par regard, ne se paie plus qu'une fois par regard : le
 * marché n'est pas bon.
 *
 * Elle reste ici, et le banc garde son balayage à trois graines : c'est ce qui rend la
 * conclusion rejouable le jour où la réduction redeviendra le goulot.
 */
function reduceRandom(vectors: Float32Array[], dims: number): Float32Array[] {
  const width = vectors[0].length
  const count = vectors.length
  const target = Math.min(dims, width, count)
  const random = mulberry32(0x5eed ^ 0x9e37)

  /* La matrice n'est jamais matérialisée : on garde, pour chaque axe, les indices à ajouter et
     ceux à retrancher. C'est la même chose, en trois fois moins de mémoire et sans multiplier
     par zéro deux mille fois par axe. */
  const plus: Int32Array[] = []
  const minus: Int32Array[] = []
  for (let axis = 0; axis < target; axis += 1) {
    const up: number[] = []
    const down: number[] = []
    for (let i = 0; i < width; i += 1) {
      const draw = random()
      if (draw < 1 / 6) up.push(i)
      else if (draw < 1 / 3) down.push(i)
    }
    plus.push(Int32Array.from(up))
    minus.push(Int32Array.from(down))
  }

  /* Le facteur d'échelle du lemme : racine de trois pour la densité d'un tiers, divisé par la
     racine de la cible pour que la longueur attendue soit conservée. Une constante commune à
     tous les points ne changerait rien aux voisinages, mais elle garde la carte à l'échelle où
     les réglages d'UMAP ont été mesurés. */
  const scale = Math.sqrt(3 / target)
  const out: Float32Array[] = []
  for (const vector of vectors) {
    const projected = new Float32Array(target)
    for (let axis = 0; axis < target; axis += 1) {
      let sum = 0
      const up = plus[axis]
      const down = minus[axis]
      for (let k = 0; k < up.length; k += 1) sum += vector[up[k]]
      for (let k = 0; k < down.length; k += 1) sum -= vector[down[k]]
      projected[axis] = sum * scale
    }
    out.push(projected)
  }
  return out
}

/**
 * Ce qu'on laisse aux points lointains, une fois le cadre pris sur le gros du nuage.
 *
 * UMAP détache volontiers quelques îlots à grande distance — des posts qui n'ont de voisins
 * nulle part. Le cadre les suivait, et une poignée de points fixait l'échelle de toute la
 * carte : mesuré sur la bibliothèque de référence, **92 % des posts tenaient dans le quart
 * central**, et le nuage n'occupait que 206 des 1 600 cases d'une grille 40 × 40.
 *
 * Ils gardent donc une marge à eux, où leur distance est compressée sans jamais être annulée :
 * un îlot deux fois plus loin qu'un autre reste plus loin, mais ne pousse plus le reste dans un
 * coin. Ce qui compte est préservé exactement : à l'intérieur du cadre, la mise à l'échelle
 * reste uniforme, donc les distances entre voisins restent proportionnelles à ce qu'UMAP a
 * calculé. C'est la seule chose qu'une carte doit à ses points.
 */
const OUTLIER_MARGIN = 0.08

/** Le quantile d'une liste déjà triée, sans interpolation : on cadre, on ne mesure pas. */
function quantile(sorted: number[], at: number): number {
  const index = Math.round((sorted.length - 1) * at)
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))]
}

function normalise(points: number[][]): { x: number; y: number }[] {
  const xs = points.map((point) => point[0]).sort((a, b) => a - b)
  const ys = points.map((point) => point[1]).sort((a, b) => a - b)
  const lowX = quantile(xs, 0.01)
  const highX = quantile(xs, 0.99)
  const lowY = quantile(ys, 0.01)
  const highY = quantile(ys, 0.99)

  // Une seule échelle pour les deux axes : sinon un nuage allongé serait étiré et les
  // distances affichées ne vaudraient plus rien.
  const span = Math.max(highX - lowX, highY - lowY) || 1
  const centreX = (lowX + highX) / 2
  const centreY = (lowY + highY) / 2
  const total = 1 + 2 * OUTLIER_MARGIN

  /* Identique à l'intérieur du cadre, amortie au-delà. L'exponentielle approche la marge sans
     jamais l'atteindre : deux îlots lointains ne se retrouvent donc pas empilés sur le bord. */
  const squash = (offset: number): number => {
    const magnitude = Math.abs(offset)
    if (magnitude <= 0.5) return offset
    const beyond = 1 - Math.exp(-(magnitude - 0.5) / OUTLIER_MARGIN)
    return Math.sign(offset) * (0.5 + OUTLIER_MARGIN * beyond)
  }

  return points.map(([x, y]) => ({
    x: (squash((x - centreX) / span) + 0.5 + OUTLIER_MARGIN) / total,
    y: (squash((y - centreY) / span) + 0.5 + OUTLIER_MARGIN) / total
  }))
}

/**
 * Le calcul lui-même. Synchrone, parce qu'il vit dans un fil séparé où bloquer ne gêne
 * personne — et exporté à part pour rester mesurable sans lancer de fil.
 */
/** Générateur déterministe, pour qu'une même bibliothèque donne toujours la même carte. */
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
 * L'amplitude où UMAP dépose ses points avant la première époque.
 *
 * `umap-js` tire dans `[-10, 10]` ; on garde exactement la même, sinon `minDist` et `spread`
 * ne voudraient plus dire ce qu'ils voulaient dire quand ils ont été mesurés.
 */
const INIT_SPAN = 10

/**
 * Poser le nuage sur ses deux axes principaux, plutôt que de le jeter au hasard.
 *
 * `umap-js` n'a pas d'autre départ que le tirage uniforme — pas de départ spectral comme
 * l'implémentation de référence. Or c'est le départ, et non l'algorithme, qui décide de ce
 * qu'une projection garde de la structure d'ensemble : deux amas voisins en 1 536 dimensions
 * n'ont aucune raison d'atterrir côte à côte s'ils sont partis chacun d'un coin, et la descente,
 * qui ne travaille que sur des voisinages, ne les rapproche jamais. C'est ce que mesure
 * `bench:map-quality`, et c'est ce qui explique l'écart de vingt et un points de compacité
 * d'une graine à l'autre relevé dans les notes de version.
 *
 * Les deux premiers axes de la réduction sont déjà là — on les a payés pour UMAP. Les réutiliser
 * ne coûte rien : le nuage part de sa propre ombre, mise à l'échelle du tirage qu'elle remplace.
 *
 * Le grain de bruit vient de l'implémentation de référence : deux posts au vecteur identique
 * partiraient sinon du même point exact, et aucune force ne les séparerait jamais.
 */
function seedFromAxes(
  embedding: number[][],
  axes: [Float64Array, Float64Array],
  random: () => number
): void {
  let extent = 0
  for (const axis of axes) {
    for (let index = 0; index < axis.length; index += 1) {
      const value = Math.abs(axis[index])
      if (value > extent) extent = value
    }
  }
  // Un nuage plat sur ses deux premiers axes : rien à poser, on laisse le tirage.
  if (extent < 1e-12) return

  const scale = INIT_SPAN / extent
  const GRAIN = 1e-4
  for (let index = 0; index < embedding.length; index += 1) {
    const row = embedding[index]
    row[0] = axes[0][index] * scale + (random() - 0.5) * GRAIN
    row[1] = axes[1][index] * scale + (random() - 0.5) * GRAIN
  }
}

/** Les deux premières colonnes de la réduction, sorties en lignes. */
function axesFromReduction(reduced: Float32Array[]): [Float64Array, Float64Array] {
  const x = new Float64Array(reduced.length)
  const y = new Float64Array(reduced.length)
  reduced.forEach((vector, index) => {
    x[index] = vector[0] ?? 0
    y[index] = vector[1] ?? 0
  })
  return [x, y]
}

/**
 * Le graphe de voisinage d'UMAP, tel qu'`umap-js` le garde.
 *
 * Il n'est pas dans les types publics du paquet, et c'est le seul endroit du projet qui aille
 * le chercher. On ne s'en sert qu'en lecture, et l'absence du champ est traitée comme un cas
 * normal juste en dessous : si une version future le déplace, le départ spectral se rabat sur
 * les axes principaux au lieu de casser la carte.
 */
interface NeighbourGraph {
  graph?: {
    nRows: number
    forEach(fn: (value: number, row: number, column: number) => void): void
  }
}

/**
 * Poser le nuage sur la forme du graphe de voisinage, et non sur les axes de plus grande
 * variance.
 *
 * C'est le départ de l'implémentation de référence d'UMAP, celui que Kobak et Linderman
 * mesurent dans Nature Biotechnology, et il dit quelque chose de différent des axes principaux :
 * ceux-ci cherchent les directions où la bibliothèque s'étale le plus — une notion linéaire,
 * qui ne sait rien des variétés repliées — quand les vecteurs propres du graphe suivent les
 * chemins de proche en proche que la carte prétend justement montrer.
 *
 * Le calcul est celui des cartes de diffusion : le laplacien normalisé `I - D^-½ A D^-½` a pour
 * plus petites valeurs propres les directions qui coupent le graphe en le moins d'arêtes
 * possible. Les chercher revient à chercher les **plus grandes** de `M = D^-½ A D^-½`, ce qu'une
 * itération de sous-espace fait sans jamais former de matrice : le graphe a douze millions
 * d'arêtes creuses, et chaque passe ne fait que les parcourir.
 *
 * La première direction est connue d'avance — `D^½ 1`, qui ne sépare rien — et on la retire de
 * l'espace à chaque passe pour que les deux qu'on garde soient les deux suivantes.
 */
function spectralAxes(graph: NeighbourGraph['graph'], count: number): Float64Array[] | null {
  if (!graph || graph.nRows !== count) return null

  const degree = new Float64Array(count)
  graph.forEach((value, row) => {
    degree[row] += value
  })
  const inverse = new Float64Array(count)
  for (let i = 0; i < count; i += 1) inverse[i] = degree[i] > 0 ? 1 / Math.sqrt(degree[i]) : 0

  /* Le graphe recopié à plat, une fois pour toutes. `SparseMatrix` ne se parcourt qu'à coups de
     rappel sur une table de hachage : deux cents passes sur un million d'arêtes feraient deux
     cents millions d'appels de fonction, ce qui coûterait plus que l'arithmétique qu'ils portent.
     Trois bandes contiguës, et le poids normalisé pré-calculé, ramènent chaque passe à une
     lecture en séquence. */
  const rowOf: number[] = []
  const columnOf: number[] = []
  const weightOf: number[] = []
  graph.forEach((value, row, column) => {
    const weight = value * inverse[row] * inverse[column]
    if (weight === 0) return
    rowOf.push(row)
    columnOf.push(column)
    weightOf.push(weight)
  })
  const edgeRow = Int32Array.from(rowOf)
  const edgeColumn = Int32Array.from(columnOf)
  const edgeWeight = Float64Array.from(weightOf)
  const edges = edgeWeight.length

  /* La direction triviale, celle de valeur propre 1 : elle donne à chaque post un poids
     proportionnel à la racine de son degré et ne coupe le graphe nulle part. */
  const trivial = new Float64Array(count)
  let trivialNorm = 0
  for (let i = 0; i < count; i += 1) {
    trivial[i] = Math.sqrt(degree[i])
    trivialNorm += trivial[i] * trivial[i]
  }
  trivialNorm = Math.sqrt(trivialNorm)
  if (trivialNorm < 1e-12) return null
  for (let i = 0; i < count; i += 1) trivial[i] /= trivialNorm

  const AXES = 2
  const random = mulberry32(0x5eec)
  let basis = Array.from({ length: AXES }, () => {
    const vector = new Float64Array(count)
    for (let i = 0; i < count; i += 1) vector[i] = random() - 0.5
    return vector
  })

  const project = (vectors: Float64Array[]): void => {
    for (const vector of vectors) {
      let dot = 0
      for (let i = 0; i < count; i += 1) dot += vector[i] * trivial[i]
      for (let i = 0; i < count; i += 1) vector[i] -= dot * trivial[i]
    }
    // Gram-Schmidt entre les axes gardés, sans quoi ils retombent tous sur le dominant.
    for (let axis = 0; axis < vectors.length; axis += 1) {
      for (let previous = 0; previous < axis; previous += 1) {
        let dot = 0
        for (let i = 0; i < count; i += 1) dot += vectors[axis][i] * vectors[previous][i]
        for (let i = 0; i < count; i += 1) vectors[axis][i] -= dot * vectors[previous][i]
      }
      let norm = 0
      for (let i = 0; i < count; i += 1) norm += vectors[axis][i] * vectors[axis][i]
      norm = Math.sqrt(norm)
      if (norm < 1e-12) continue
      for (let i = 0; i < count; i += 1) vectors[axis][i] /= norm
    }
  }
  project(basis)

  /* Deux cents passes. Chacune ne coûte qu'un parcours des arêtes — le graphe est creux, et
     tout ce calcul pèse moins d'une seconde sur les quarante de la descente qui suit.

     On itère sur `M + I` et non sur `M` : une itération de puissance converge vers la valeur
     propre de plus grand **module**, or celles de `M` vivent dans `[-1, 1]` et une direction
     de valeur propre proche de -1 — celle qui alterne d'un post à l'autre, et qui ne veut rien
     dire sur une carte — l'emporterait sur celle qu'on cherche. Ajouter l'identité les décale
     toutes dans `[0, 2]` sans changer leur ordre, et le piège disparaît. */
  const PASSES = 200
  for (let pass = 0; pass < PASSES; pass += 1) {
    const nextX = Float64Array.from(basis[0])
    const nextY = Float64Array.from(basis[1])
    const fromX = basis[0]
    const fromY = basis[1]
    for (let edge = 0; edge < edges; edge += 1) {
      const row = edgeRow[edge]
      const column = edgeColumn[edge]
      const weight = edgeWeight[edge]
      nextX[row] += weight * fromX[column]
      nextY[row] += weight * fromY[column]
    }
    const next = [nextX, nextY]
    project(next)
    basis = next
  }

  /**
   * Un graphe en morceaux rend des vecteurs propres qui ne font que nommer les morceaux :
   * tous les posts d'une composante au même endroit, et rien à l'intérieur. Un tel départ
   * vaut moins que le hasard — on le refuse ici plutôt que de livrer une carte en trois tas.
   */
  for (const vector of basis) {
    const sorted = Array.from(vector).sort((a, b) => a - b)
    const span = sorted[sorted.length - 1] - sorted[0]
    const bulk = quantile(sorted, 0.99) - quantile(sorted, 0.01)
    if (span < 1e-12 || bulk < span * 0.01) return null
  }
  return basis
}

/** Réglages de la projection. Exposés pour pouvoir les mesurer, pas pour les régler à l'œil. */
export interface ProjectionTuning {
  /** Ramener chaque vecteur à la longueur 1 avant de projeter. */
  unit: boolean
  neighbours: number
  minDist: number
  spread: number
  pcaDims: number
  /**
   * Comment on descend de 1 536 dimensions à `pcaDims`.
   *
   * `pca` cherche les directions de plus grande variance ; `random` se contente de conserver
   * les distances. Le second est bien plus rapide, et c'est au banc des îlots de dire s'il
   * coûte quelque chose à la lecture de la carte.
   */
  reduction?: 'pca' | 'random'
  /**
   * D'où part la descente d'UMAP.
   *
   * `random` est ce que fait `umap-js` : chaque post est jeté au hasard dans un carré de côté
   * vingt, et la descente doit ensuite reconstituer *toute* la carte à partir de ce désordre.
   * `pca` le pose d'emblée sur les deux premiers axes de la réduction — le nuage a déjà sa
   * forme d'ensemble avant la première époque, et la descente n'a plus qu'à creuser le détail.
   *
   * `spectral` va plus loin : il pose le nuage sur les deux premiers vecteurs propres du
   * graphe de voisinage qu'UMAP vient de construire — c'est le départ de l'implémentation de
   * référence, et il suit la variété plutôt que les directions de plus grande variance.
   *
   * Ce n'est pas un réglage de confort : c'est le seul qui décide si la carte tient d'une
   * ouverture à l'autre. Voir la note de `TUNING.init`.
   */
  init?: 'random' | 'pca' | 'spectral'
  /**
   * La graine, fixe par défaut : deux ouvertures doivent rendre la même carte.
   *
   * Elle n'est là que pour les bancs. Compacité et resserrement bougent d'un réglage à l'autre
   * sans suivre la qualité, et un écart de quelques points ne veut rien dire tant qu'on ne sait
   * pas ce que la même configuration donne sous une autre graine. C'est la seule façon de
   * distinguer un gain d'un tirage.
   */
  seed?: number
}

/**
 * Réglages mesurés, pas choisis à l'œil.
 *
 * Banc : 9 751 posts réels, vingt-quatre thèmes découpés dans le sens lui-même — ce que les
 * collections devraient être — et une seule question : ces thèmes forment-ils des taches à
 * l'écran ? On mesure la distance moyenne entre deux posts d'un même thème, rapportée à deux
 * posts au hasard. Zéro pour cent voudrait dire « éparpillé comme au hasard ».
 *
 *   PCA  48, 30 voisins — 29 %, 15 s
 *   PCA  96, 15 voisins — 30 %, 14 s
 *   PCA 192, 15 voisins — 33 %, 22 s
 *   PCA 256, 15 voisins — 44 %, 27 s
 *   sans PCA, 15 voisins — 38 %, 47 s
 *   PCA 192, 10 voisins — 22 %, 25 s
 *
 * L'ancienne réduction à 48 dimensions était le vrai frein : elle jetait la structure qu'on
 * cherchait à voir. Douze secondes de plus valent bien un tiers de lisibilité gagné.
 *
 * Ce banc-là ne mesurait pourtant pas ce que l'écran montre. Une collection peut rester
 * « resserrée » tout en se coupant en deux moitiés compactes mais éloignées — et c'est
 * précisément ce qu'on voyait. `scripts/bench-map-islands` mesure donc la **compacité** : la
 * part des posts d'une collection qui tiennent dans sa plus grosse tache. À voisinage seul,
 * PCA 256 constante :
 *
 *   15 voisins — compacité 79,7 %, resserrement 61,5 %,  70 s
 *   25 voisins —           87,2 %,               67,4 %,  77 s
 *   40 voisins —           89,5 %,               68,8 %,  99 s
 *   60 voisins —           93,8 %,               76,5 %,  88 s   ← retenu
 *   80 voisins —           93,4 %,               72,6 %,  92 s
 *  100 voisins —           86,9 %,               65,5 %,  97 s
 *
 * Élargir le voisinage améliore les deux à la fois, jusqu'à 60 où les deux courbes se
 * retournent. `minDist` et `spread` n'apportent rien (0,05 : 85,9 % ; spread 2,4 : 73,4 %),
 * et réduire la PCA défait tout (192 dimensions à 80 voisins : 72,8 %).
 *
 * Une contrepartie, mesurée elle aussi : la carte se concentre. Cases occupées sur une grille
 * 20 × 20 — 123 à 15 voisins, 88 à 25, 74 à 40, 70 à 60. L'essentiel de cette perte se joue
 * tôt, et de 40 à 60 elle est négligeable alors que la compacité gagne encore quatre points.
 * C'est le sens du réglage : des îlots qu'on peut cerner d'une frontière, au prix d'un nuage
 * moins étalé.
 */
export const TUNING: ProjectionTuning = {
  /* Les vecteurs de sens se comparent en cosinus, UMAP mesure en euclidien : les ramener à
     la longueur 1 rend les deux d'accord. Mesuré neutre — le modèle les rend déjà quasi
     unitaires — mais gratuit, et ça restera vrai si le modèle change. */
  unit: true,
  /* Soixante, et c'est une correction. La note précédente affirmait l'inverse — « quinze
     plutôt que trente, moins de voisins resserre le voisinage proche » — mais elle s'appuyait
     sur un banc qui changeait les dimensions PCA *en même temps* que le voisinage : 48
     dimensions à 30 voisins contre 256 à 15. C'est la PCA qui portait l'écart. À PCA
     constante, le voisinage large gagne franchement, sur les deux mesures, jusqu'à 60.
     En dessous, une collection sur cinq se scinde en plusieurs taches ; au-delà, le nuage
     se lisse et les amas se confondent.

     Rejoué le 2026-08-24 avec le départ spectral, sur le banc de qualité — et l'hypothèse qui
     motivait ce nouvel essai est démentie. On soupçonnait soixante d'être une *compensation* du
     départ au hasard : une collection qui se scinde ressemble à deux moitiés jetées dans deux
     coins, et un large voisinage aurait couvert la trace plutôt que soigné la cause. Ce n'est
     pas ça. Le voisinage arbitre un échange franc entre le proche et le loin, et l'échange
     reste entier une fois le départ corrigé :

       15 voisins — proche 23,4 % ±0,2, loin 36,4 % ±1,5, constance 82,2 %, 28 s
       30 voisins — proche 21,4 % ±0,2, loin 38,3 % ±0,7, constance 84,3 %, 44 s   ← retenu
       60 voisins — proche 18,6 % ±0,3, loin 41,1 % ±0,7, constance 87,1 %, 49 s

     Trente, et c'est un arbitrage tranché, pas une correction. Le repère est la version livrée :
     soixante voisins **partis au hasard** rendaient 38,1 % de lointain. Trente voisins partis du
     graphe en rendent 38,3 % — le même, à la mesure près — en gagnant 2,7 points sur le voisinage
     immédiat et cinq secondes. Personne ne perd donc rien par rapport à ce qu'il avait ; ce qui
     se décide, c'est où placer les trois points que le nouveau départ fait gagner. Ici on les
     dépense en justesse du proche, qui est ce qu'on lit sous le curseur, plutôt qu'en justesse
     de la traversée, qu'on lit plus rarement.

     La compacité est aussi, à trente, la plus stable des trois (81,7 % ±2,6 contre ±6,2), ce qui
     n'est pas un argument fort — le banc ne porte que sur 305 posts — mais qui ne contredit rien.
     Se rejoue par `npm run bench:map-quality -- --voisinage`. */
  neighbours: 30,
  minDist: 0.015,
  spread: 1.6,
  pcaDims: 256,
  /**
   * Spectral, et c'est le réglage le plus important de la liste.
   *
   * `umap-js` n'offrait qu'un départ : chaque post jeté dans un carré de côté vingt. La descente
   * ne travaille ensuite que sur des voisinages — deux amas proches en 1 536 dimensions mais
   * tombés dans deux coins opposés n'ont aucune force qui les rapproche et y restent. Ce que la
   * carte montrait du lointain était donc en partie le tirage, pas la bibliothèque. C'est le
   * résultat de Kobak et Linderman (Nature Biotechnology, 2021) : l'initialisation décide de la
   * structure d'ensemble bien plus que l'algorithme.
   *
   * Mesuré par `bench:map-quality` sur 9 828 posts réels, trois graines par configuration —
   * « proche » compte les voisins d'un post qui restent ses voisins à l'écran, « loin » corrèle
   * les rangs de toutes les distances entre paires, « constance » compare deux cartes de la même
   * bibliothèque tirées sous deux graines :
   *
   *   départ            proche          loin       compacité      constance
   *   au hasard      18,7 % ±0,2   38,1 % ±1,1   78,7 % ±1,8   76,0 % ±6,5
   *   axes (PCA)     18,8 % ±0,1   41,1 % ±0,8   71,7 % ±2,0   91,8 % ±2,9
   *   spectral       18,6 % ±0,3   41,1 % ±0,7   78,7 % ±6,2   87,1 % ±3,0   ← retenu
   *
   * Les deux départs informés gagnent les mêmes trois points sur le lointain, et ne coûtent rien
   * au voisinage proche. Ce qui les sépare est la compacité : partir des axes principaux impose
   * un cadre linéaire au nuage, et sept points de collections se scindent — le départ spectral,
   * lui, part du graphe de voisinage, donc de la variété elle-même, et rend la compacité intacte.
   *
   * La constance n'est pas une qualité mais une propriété de produit : elle dit à quel point la
   * carte dépend d'un tirage plutôt que de la bibliothèque. Elle monte parce que le tirage cesse
   * de décider — c'est le mécanisme, pas un effet de bord.
   *
   * Coût : moins d'une seconde de plus sur les quarante-trois que dure la projection.
   */
  init: 'spectral'
}

export function projectSync(
  vectors: Map<string, Float32Array>,
  onProgress?: (done: number, total: number) => void,
  tuning: ProjectionTuning = TUNING
): ProjectedPoint[] {
  const ids = [...vectors.keys()]
  if (ids.length === 0) return []
  const raw = ids.map((id) => {
    const vector = vectors.get(id) as Float32Array
    if (!tuning.unit) return vector
    let norm = 0
    for (let i = 0; i < vector.length; i += 1) norm += vector[i] * vector[i]
    norm = Math.sqrt(norm)
    if (norm < 1e-9) return vector
    const unit = new Float32Array(vector.length)
    for (let i = 0; i < vector.length; i += 1) unit[i] = vector[i] / norm
    return unit
  })

  if (ids.length < 8) {
    // Trop peu de voisins pour qu'UMAP ait un sens : deux axes principaux suffisent.
    const reduced = reduce(raw, 2)
    const flat = reduced.map((vector) => [vector[0] ?? 0, vector[1] ?? 0])
    return normalise(flat).map((point, index) => ({ id: ids[index], ...point }))
  }

  /* Deux phases sur une seule échelle. La réduction précède UMAP et pèse à peu près
     autant : sans compte rendu, la barre restait immobile une demi-minute avant de
     démarrer, ce qui se lit comme un blocage. Le millième est arbitraire — seul le
     rapport est affiché. */
  const SCALE = 1000
  const REDUCTION_SHARE = 0.5
  const reduced =
    tuning.reduction === 'random'
      ? reduceRandom(raw, tuning.pcaDims)
      : reduce(raw, tuning.pcaDims, (fraction) =>
          onProgress?.(Math.round(fraction * REDUCTION_SHARE * SCALE), SCALE)
        )
  onProgress?.(Math.round(REDUCTION_SHARE * SCALE), SCALE)
  const umap = new UMAP({
    nComponents: 2,
    /* Plus de voisins pour que la structure d'ensemble ressorte, et une distance minimale
       très faible pour que les amas se resserrent : sur neuf mille posts, les réglages par
       défaut donnaient une seule tache continue où l'on ne distinguait aucun îlot. */
    nNeighbors: Math.min(tuning.neighbours, ids.length - 1),
    minDist: tuning.minDist,
    spread: tuning.spread,
    // Graine fixe : la carte doit être la même d'une ouverture à l'autre.
    random: mulberry32(tuning.seed ?? 0x5eed)
  })
  const total = umap.initializeFit(reduced.map((vector) => Array.from(vector)))
  /* Après `initializeFit`, et pas avant : c'est lui qui remplit le tableau de départ. Le
     tableau qu'il rend est celui-là même que la descente déplace, case par case — on le
     réécrit sur place, sans le remplacer. */
  if (tuning.init && tuning.init !== 'random') {
    const spectral =
      tuning.init === 'spectral'
        ? spectralAxes((umap as unknown as NeighbourGraph).graph, ids.length)
        : null
    seedFromAxes(
      umap.getEmbedding(),
      spectral ? [spectral[0], spectral[1]] : axesFromReduction(reduced),
      mulberry32((tuning.seed ?? 0x5eed) ^ 0x1a1e)
    )
  }
  for (let step = 0; step < total; step += 1) {
    umap.step()
    /* Toutes les seize étapes : à 64, une projection d’une minute n’envoyait que trois
       nouvelles, et une barre qui ne bouge pas se lit comme un blocage. */
    if (step % 16 === 15) {
      onProgress?.(
        Math.round((REDUCTION_SHARE + ((step + 1) / total) * (1 - REDUCTION_SHARE)) * SCALE),
        SCALE
      )
    }
  }
  onProgress?.(SCALE, SCALE)
  return normalise(umap.getEmbedding()).map((point, index) => ({ id: ids[index], ...point }))
}

/**
 * Lance la projection dans un fil et rend la main tout du long.
 *
 * Les vecteurs partent à plat en un seul transfert : passer neuf mille tableaux séparés
 * coûterait plus cher en sérialisation que le calcul lui-même.
 */
