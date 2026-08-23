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
function normalise(points: number[][]): { x: number; y: number }[] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  // Une seule échelle pour les deux axes : sinon un nuage allongé serait étiré et les
  // distances affichées ne vaudraient plus rien.
  const span = Math.max(maxX - minX, maxY - minY) || 1
  const offsetX = (span - (maxX - minX)) / 2
  const offsetY = (span - (maxY - minY)) / 2
  return points.map(([x, y]) => ({
    x: (x - minX + offsetX) / span,
    y: (y - minY + offsetY) / span
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

/** Réglages de la projection. Exposés pour pouvoir les mesurer, pas pour les régler à l'œil. */
export interface ProjectionTuning {
  /** Ramener chaque vecteur à la longueur 1 avant de projeter. */
  unit: boolean
  neighbours: number
  minDist: number
  spread: number
  pcaDims: number
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
     se lisse et les amas se confondent. */
  neighbours: 60,
  minDist: 0.015,
  spread: 1.6,
  pcaDims: 256
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
  const reduced = reduce(raw, tuning.pcaDims, (fraction) =>
    onProgress?.(Math.round(fraction * REDUCTION_SHARE * SCALE), SCALE)
  )
  const umap = new UMAP({
    nComponents: 2,
    /* Plus de voisins pour que la structure d'ensemble ressorte, et une distance minimale
       très faible pour que les amas se resserrent : sur neuf mille posts, les réglages par
       défaut donnaient une seule tache continue où l'on ne distinguait aucun îlot. */
    nNeighbors: Math.min(tuning.neighbours, ids.length - 1),
    minDist: tuning.minDist,
    spread: tuning.spread,
    // Graine fixe : la carte doit être la même d'une ouverture à l'autre.
    random: mulberry32(0x5eed)
  })
  const total = umap.initializeFit(reduced.map((vector) => Array.from(vector)))
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
