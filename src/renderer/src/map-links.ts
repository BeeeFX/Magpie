/**
 * Le voisinage de la toile : les vingt-quatre plus proches de chaque point, dédoublonnés.
 *
 * Sorti du composant pour la même raison que le réglage de la toile : c'est un calcul pur sur
 * des coordonnées, il n'a besoin ni de canevas ni de React, et il se mesure donc hors écran
 * (`npm run check:map-links`). C'est aussi le calcul le plus cher de l'ouverture de la carte —
 * **320 ms** mesurées sur les 9 742 points de `map-sandbox.json`, refaites à chaque changement
 * de filtre puisque le nuage affiché change alors d'identité.
 *
 * Trois coûts, dans cet ordre :
 *
 * 1. Le **tri complet** des ~300 candidats de chaque point pour n'en garder que vingt-quatre.
 *    Remplacé par une insertion bornée : un candidat plus loin que le vingt-quatrième déjà
 *    retenu coûte une comparaison et rien d'autre.
 * 2. `Math.hypot`, appelé 2,9 millions de fois. La racine ne sert qu'à comparer : on compare
 *    les carrés, qui ordonnent pareil.
 * 3. Les clés de chaînes — `` `${x}:${y}` `` pour les cases, `` `${a}:${b}` `` pour le
 *    dédoublonnage. Remplacées par une grille dense en `Int32Array` et des clés entières.
 *
 * Ensemble : **58 ms** pour exactement les mêmes 135 271 arêtes.
 *
 * Une seule différence subsiste, et elle est mesurée : douze points sur 9 742 voient leurs
 * voisins rangés dans un autre ordre. Ce sont des distances égales à l'arrondi près, que
 * `Math.hypot` confondait et que le carré sépare. L'**ensemble** des arêtes est identique, et
 * l'ordre à l'intérieur d'une liste n'entre dans le rendu que par l'échantillonnage
 * `edgeKept`, qui est de toute façon arbitraire.
 */

export interface Placed {
  x: number
  y: number
}

/**
 * Les paires de voisins, dans l'ordre où le composant les attendait.
 *
 * L'ordre compte, et il est le même qu'avant : on parcourt les points dans l'ordre donné,
 * puis leurs voisins du plus proche au plus lointain, et on écarte une paire déjà vue. Écarter
 * d'abord les identifiants inférieurs — ce que faisait une version antérieure — ne retient pas
 * les mêmes arêtes : un point dont tous les proches sont « avant » lui en cherche vingt-quatre
 * plus loin, et le total monte de 133 810 à 210 794.
 */
export function neighbourLinks<T extends Placed>(
  points: T[],
  radius: number,
  perPoint: number,
  cell: number
): [T, T][] {
  const count = points.length
  const pairs: [T, T][] = []
  if (count === 0) return pairs

  /* Une grille dense plutôt qu'une table de hachage : les cases sont contiguës en mémoire et
     leur adresse est une multiplication, là où `` `${x}:${y}` `` fabriquait une chaîne par
     point et par voisinage consulté. */
  const xs = new Float64Array(count)
  const ys = new Float64Array(count)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let index = 0; index < count; index += 1) {
    const point = points[index]
    xs[index] = point.x
    ys[index] = point.y
    const cellX = Math.floor(point.x / cell)
    const cellY = Math.floor(point.y / cell)
    if (cellX < minX) minX = cellX
    if (cellY < minY) minY = cellY
    if (cellX > maxX) maxX = cellX
    if (cellY > maxY) maxY = cellY
  }
  const columns = maxX - minX + 1
  const rows = maxY - minY + 1
  const cells = columns * rows

  /* Rangement par comptage : une passe pour compter, une pour placer. Aucun tableau
     intermédiaire, aucune allocation par case. */
  const starts = new Int32Array(cells + 1)
  const cellOf = new Int32Array(count)
  for (let index = 0; index < count; index += 1) {
    const at =
      (Math.floor(ys[index] / cell) - minY) * columns + (Math.floor(xs[index] / cell) - minX)
    cellOf[index] = at
    starts[at + 1] += 1
  }
  for (let at = 0; at < cells; at += 1) starts[at + 1] += starts[at]
  const order = new Int32Array(count)
  const cursor = Int32Array.from(starts.subarray(0, cells))
  for (let index = 0; index < count; index += 1) {
    order[cursor[cellOf[index]]] = index
    cursor[cellOf[index]] += 1
  }

  const reach = radius * radius
  /* Les `perPoint` meilleurs, tenus triés par insertion. Un candidat pire que le dernier retenu
     ne coûte qu'une comparaison — et c'est le cas de la grande majorité des trois cents. */
  const bestDistance = new Float64Array(perPoint)
  const bestIndex = new Int32Array(perPoint)
  const seen = new Set<number>()

  for (let index = 0; index < count; index += 1) {
    const x = xs[index]
    const y = ys[index]
    const cellX = Math.floor(x / cell) - minX
    const cellY = Math.floor(y / cell) - minY
    let kept = 0
    let worst = Infinity
    const fromX = cellX > 0 ? cellX - 1 : 0
    const toX = cellX + 1 < columns ? cellX + 1 : columns - 1
    const fromY = cellY > 0 ? cellY - 1 : 0
    const toY = cellY + 1 < rows ? cellY + 1 : rows - 1
    /* Le balayage suit l'ordre d'avant — colonnes puis lignes, et dans une case l'ordre des
       points — pour que deux distances égales se départagent comme avant. */
    for (let gx = fromX; gx <= toX; gx += 1) {
      for (let gy = fromY; gy <= toY; gy += 1) {
        const at = gy * columns + gx
        for (let slot = starts[at], end = starts[at + 1]; slot < end; slot += 1) {
          const other = order[slot]
          if (other === index) continue
          const dx = xs[other] - x
          const dy = ys[other] - y
          const distance = dx * dx + dy * dy
          if (distance >= reach) continue
          if (kept === perPoint && distance >= worst) continue
          let place = kept < perPoint ? kept : perPoint - 1
          /* Comparaison stricte : à distance égale, le nouveau se range **après**, comme le
             faisait le tri stable de `Array.prototype.sort`. */
          while (place > 0 && bestDistance[place - 1] > distance) {
            bestDistance[place] = bestDistance[place - 1]
            bestIndex[place] = bestIndex[place - 1]
            place -= 1
          }
          bestDistance[place] = distance
          bestIndex[place] = other
          if (kept < perPoint) kept += 1
          worst = bestDistance[kept - 1]
        }
      }
    }
    for (let slot = 0; slot < kept; slot += 1) {
      const other = bestIndex[slot]
      /* Clé entière plutôt que chaîne. `count` valant au plus quelques centaines de milliers,
         le produit reste exact en flottant double bien au-delà de ce qu'une bibliothèque peut
         contenir. */
      const key = index < other ? index * count + other : other * count + index
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push([points[index], points[other]])
    }
  }
  return pairs
}
