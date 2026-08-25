import Database from 'better-sqlite3'
import { libraryDbPath } from './library-path'
import { projectSync, TUNING, type ProjectedPoint } from '../src/main/tagging/projection-core'
import { blend } from '../src/main/tagging/vision'
import { postTerms } from '../src/main/tagging/terms'
import { findIslands, islandMembership, ISLAND_TUNING } from '../src/main/tagging/islands'

/**
 * Les régions que la carte se donne — sont-elles réelles ?
 *
 * Une région est une promesse faite au lecteur : « ce qui est là, c'est ça ». La question n'est
 * donc pas esthétique. On la pose en deux temps.
 *
 * **Combien, et quelle couverture.** Une région par post ne dit rien, une seule région non plus.
 * On balaie la persistance — le dénivelé qu'un bassin doit creuser pour rester distinct — et on
 * regarde le nombre de régions, la part de la bibliothèque qu'elles couvrent, et la taille de la
 * plus grosse : c'est elle qui dit si une région avale les autres.
 *
 * **Contre quoi on les juge.** Un regroupement fait dans les vecteurs eux-mêmes, k-moyennes
 * sphériques sur les 1 536 dimensions — la meilleure idée disponible de « ce qui va avec quoi »,
 * indépendante de la projection. Une région pure est une région dont les membres appartiennent
 * au même groupe de sens. Et pour que la mesure veuille dire quelque chose, on la compare à un
 * **témoin** : un découpage k-moyennes du plan, au même nombre de régions. Si le relief ne bat
 * pas le découpage naïf, il n'apporte rien et il faut le dire.
 */

const db = new Database(libraryDbPath(), { readonly: true })
const asVector = (b: Buffer): Float32Array =>
  new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))

const text = new Map(
  (
    db.prepare('SELECT post_id, vector FROM post_embeddings').all() as {
      post_id: string
      vector: Buffer
    }[]
  ).map((r) => [r.post_id, asVector(r.vector)])
)
const images = new Map(
  (
    db.prepare('SELECT post_id, hash, structure, meaning, frames FROM post_image_embeddings').all() as {
      post_id: string
      hash: string
      structure: Buffer
      meaning: Buffer
      frames: number
    }[]
  ).map((r) => [
    r.post_id,
    { postId: r.post_id, hash: r.hash, structure: r.structure, meaning: r.meaning, frames: r.frames }
  ])
)
const captions = new Map(
  (
    db.prepare('SELECT id, text, author_handle AS author FROM posts WHERE is_archived = 0').all() as {
      id: string
      text: string | null
      author: string | null
    }[]
  ).map((r) => [r.id, `${r.text ?? ''} ${r.author ?? ''}`])
)
db.close()

const vectors = blend(text, images)
const ids = [...vectors.keys()]
const width = vectors.get(ids[0])?.length ?? 0
console.log(`${ids.length} posts, ${width} dimensions`)

const termsOf = (id: string): string[] => postTerms(captions.get(id) ?? '')

console.log('projection…')
const started = Date.now()
const points: ProjectedPoint[] = projectSync(vectors)
console.log(`  ${((Date.now() - started) / 1000).toFixed(0)} s, voisinage ${TUNING.neighbours}, départ ${TUNING.init}`)

/* ------------------------------------------------- le sens, comme juge indépendant */

const flat = new Float32Array(ids.length * width)
ids.forEach((id, index) => {
  const vector = vectors.get(id) as Float32Array
  let norm = 0
  for (let i = 0; i < width; i += 1) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm) || 1
  const at = index * width
  for (let i = 0; i < width; i += 1) flat[at + i] = vector[i] / norm
})

/** k-moyennes sphériques sur les vecteurs : le découpage de référence. */
function semanticClusters(k: number): Int32Array {
  let seed = 20260824
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const centres = new Float32Array(k * width)
  for (let c = 0; c < k; c += 1) {
    const pick = Math.floor(random() * ids.length)
    centres.set(flat.subarray(pick * width, (pick + 1) * width), c * width)
  }
  const label = new Int32Array(ids.length)
  for (let round = 0; round < 25; round += 1) {
    let moved = 0
    for (let i = 0; i < ids.length; i += 1) {
      const at = i * width
      let best = 0
      let bestScore = -Infinity
      for (let c = 0; c < k; c += 1) {
        let dot = 0
        const from = c * width
        for (let d = 0; d < width; d += 1) dot += flat[at + d] * centres[from + d]
        if (dot > bestScore) {
          bestScore = dot
          best = c
        }
      }
      if (label[i] !== best) moved += 1
      label[i] = best
    }
    if (moved === 0 && round > 0) break
    centres.fill(0)
    for (let i = 0; i < ids.length; i += 1) {
      const from = label[i] * width
      const at = i * width
      for (let d = 0; d < width; d += 1) centres[from + d] += flat[at + d]
    }
    for (let c = 0; c < k; c += 1) {
      const from = c * width
      let norm = 0
      for (let d = 0; d < width; d += 1) norm += centres[from + d] * centres[from + d]
      norm = Math.sqrt(norm) || 1
      for (let d = 0; d < width; d += 1) centres[from + d] /= norm
    }
  }
  return label
}

/** k-moyennes sur le plan : le témoin, qui découpe sans regarder le relief. */
function flatClusters(k: number): Map<string, number> {
  let seed = 777
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const centres = Array.from({ length: k }, () => {
    const pick = points[Math.floor(random() * points.length)]
    return { x: pick.x, y: pick.y }
  })
  const label = new Int32Array(points.length)
  for (let round = 0; round < 40; round += 1) {
    let moved = 0
    points.forEach((point, index) => {
      let best = 0
      let bestDistance = Infinity
      centres.forEach((centre, cluster) => {
        const distance = (centre.x - point.x) ** 2 + (centre.y - point.y) ** 2
        if (distance < bestDistance) {
          bestDistance = distance
          best = cluster
        }
      })
      if (label[index] !== best) moved += 1
      label[index] = best
    })
    if (moved === 0 && round > 0) break
    const sums = centres.map(() => ({ x: 0, y: 0, n: 0 }))
    points.forEach((point, index) => {
      const sum = sums[label[index]]
      sum.x += point.x
      sum.y += point.y
      sum.n += 1
    })
    sums.forEach((sum, cluster) => {
      if (sum.n > 0) centres[cluster] = { x: sum.x / sum.n, y: sum.y / sum.n }
    })
  }
  return new Map(points.map((point, index) => [point.id, label[index]]))
}

/**
 * La pureté d'un découpage, et l'information qu'il partage avec le sens.
 *
 * La pureté seule se triche — une région par post serait pure à cent pour cent — donc on rend
 * aussi l'information mutuelle normalisée, qui pénalise le morcellement.
 */
function agreement(
  partition: Map<string, number>,
  truth: Map<string, number>
): { purity: number; mutual: number; covered: number } {
  const joint = new Map<string, number>()
  const left = new Map<number, number>()
  const right = new Map<number, number>()
  let total = 0
  for (const [id, region] of partition) {
    const group = truth.get(id)
    if (group === undefined) continue
    total += 1
    joint.set(`${region}:${group}`, (joint.get(`${region}:${group}`) ?? 0) + 1)
    left.set(region, (left.get(region) ?? 0) + 1)
    right.set(group, (right.get(group) ?? 0) + 1)
  }
  if (total === 0) return { purity: 0, mutual: 0, covered: 0 }

  const best = new Map<number, number>()
  for (const [key, count] of joint) {
    const region = Number(key.split(':')[0])
    if (count > (best.get(region) ?? 0)) best.set(region, count)
  }
  const purity = [...best.values()].reduce((sum, count) => sum + count, 0) / total

  let mutual = 0
  for (const [key, count] of joint) {
    const [region, group] = key.split(':').map(Number)
    const p = count / total
    mutual += p * Math.log(p / ((left.get(region) as number) / total) / ((right.get(group) as number) / total))
  }
  const entropy = (counts: Map<number, number>): number => {
    let out = 0
    for (const count of counts.values()) {
      const p = count / total
      out -= p * Math.log(p)
    }
    return out
  }
  const scale = Math.sqrt(entropy(left) * entropy(right))
  return { purity, mutual: scale > 0 ? mutual / scale : 0, covered: total }
}

/* ------------------------------------------------------------------ le balayage */

/* Dix-huit groupes de sens : l'ordre de grandeur de ce qu'un lecteur distingue dans une
   bibliothèque de dix mille posts, et le même nombre que la légende des cartes comparées. */
const SEMANTIC = 18
console.log(`regroupement de référence : ${SEMANTIC} groupes dans les vecteurs…`)
const semanticLabels = semanticClusters(SEMANTIC)
const semanticMap = new Map(ids.map((id, index) => [id, semanticLabels[index]]))

console.log('')
console.log('persistance   régions   couverture   la plus grosse   pureté   info. mutuelle')
const sweeps = [0.01, 0.02, 0.04, 0.08, 0.12, 0.2, 0.3]
const results: { persistence: number; regions: number }[] = []
for (const persistence of sweeps) {
  const membership = islandMembership(points, { ...ISLAND_TUNING, persistence })
  const sizes = new Map<number, number>()
  for (const region of membership.values()) sizes.set(region, (sizes.get(region) ?? 0) + 1)
  const score = agreement(membership, semanticMap)
  const biggest = Math.max(0, ...sizes.values())
  results.push({ persistence, regions: sizes.size })
  console.log(
    `${persistence.toFixed(2).padStart(11)}${String(sizes.size).padStart(10)}` +
      `${`${((100 * membership.size) / points.length).toFixed(1)} %`.padStart(13)}` +
      `${`${((100 * biggest) / points.length).toFixed(1)} %`.padStart(17)}` +
      `${`${(100 * score.purity).toFixed(1)} %`.padStart(9)}` +
      `${`${(100 * score.mutual).toFixed(1)} %`.padStart(17)}`
  )
}

/* ------------------------------------------------------- le témoin, à découpage égal */

const chosen = islandMembership(points)
const chosenRegions = new Set(chosen.values()).size
const relief = agreement(chosen, semanticMap)
const flatCut = flatClusters(chosenRegions)
const naive = agreement(flatCut, semanticMap)

/**
 * Où tombe la frontière — la mesure que la pureté ne fait pas.
 *
 * Deux découpages peuvent être aussi purs l'un que l'autre et n'avoir rien à voir : un
 * k-moyennes du plan trace ses frontières là où ses centres tombent, y compris **en plein
 * milieu d'un amas dense**, et les deux moitiés restent pures puisqu'elles contiennent la même
 * chose. C'est précisément le défaut qu'un lecteur voit et qu'aucune pureté n'attrape.
 *
 * On mesure donc la densité moyenne le long de la frontière, rapportée à la densité moyenne des
 * cases habitées. Un découpage qui coupe dans les vallées rend un chiffre bas ; un découpage qui
 * coupe n'importe où rend un chiffre proche de 1.
 */
function boundaryDepth(partition: Map<string, number>): number {
  const FIELD = 160
  const grid = new Float32Array(FIELD * FIELD)
  const owner = new Int32Array(FIELD * FIELD).fill(-1)
  const RADIUS = 8
  const squared = RADIUS * RADIUS
  for (const point of points) {
    const cx = point.x * FIELD
    const cy = point.y * FIELD
    for (let y = Math.max(0, Math.floor(cy - RADIUS)); y <= Math.min(FIELD - 1, Math.ceil(cy + RADIUS)); y += 1) {
      for (let x = Math.max(0, Math.floor(cx - RADIUS)); x <= Math.min(FIELD - 1, Math.ceil(cx + RADIUS)); x += 1) {
        const distance = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2
        if (distance >= squared) continue
        const fall = 1 - distance / squared
        grid[y * FIELD + x] += fall * fall
      }
    }
  }
  /* La région d'une case est celle de la majorité des posts qui y tombent : c'est ce qu'un
     lecteur lirait en regardant la case. */
  const votes = new Map<number, Map<number, number>>()
  for (const point of points) {
    const region = partition.get(point.id)
    if (region === undefined) continue
    const cell =
      Math.min(FIELD - 1, Math.max(0, Math.floor(point.y * FIELD))) * FIELD +
      Math.min(FIELD - 1, Math.max(0, Math.floor(point.x * FIELD)))
    const tally = votes.get(cell) ?? new Map<number, number>()
    tally.set(region, (tally.get(region) ?? 0) + 1)
    votes.set(cell, tally)
  }
  for (const [cell, tally] of votes) {
    let best = -1
    let most = 0
    for (const [region, count] of tally) {
      if (count > most) {
        most = count
        best = region
      }
    }
    owner[cell] = best
  }

  let edge = 0
  let edgeCells = 0
  let lived = 0
  let livedCells = 0
  for (let cell = 0; cell < owner.length; cell += 1) {
    if (owner[cell] < 0) continue
    lived += grid[cell]
    livedCells += 1
    const x = cell % FIELD
    const y = (cell - x) / FIELD
    let borders = false
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= FIELD || ny >= FIELD) continue
      const other = owner[ny * FIELD + nx]
      if (other >= 0 && other !== owner[cell]) borders = true
    }
    if (!borders) continue
    edge += grid[cell]
    edgeCells += 1
  }
  if (edgeCells === 0 || livedCells === 0) return 0
  return edge / edgeCells / (lived / livedCells)
}

console.log('')
console.log(`à ${chosenRegions} régions, contre un découpage k-moyennes du plan`)
console.log('découpage              pureté   info. mutuelle   densité au bord   posts jugés')
console.log(
  `relief + persistance ${`${(100 * relief.purity).toFixed(1)} %`.padStart(8)}` +
    `${`${(100 * relief.mutual).toFixed(1)} %`.padStart(17)}` +
    `${`${(100 * boundaryDepth(chosen)).toFixed(1)} %`.padStart(18)}${String(relief.covered).padStart(14)}`
)
console.log(
  `k-moyennes du plan   ${`${(100 * naive.purity).toFixed(1)} %`.padStart(8)}` +
    `${`${(100 * naive.mutual).toFixed(1)} %`.padStart(17)}` +
    `${`${(100 * boundaryDepth(flatCut)).toFixed(1)} %`.padStart(18)}${String(naive.covered).padStart(14)}`
)

/* ------------------------------------------------------------------------ les noms */

console.log('')
console.log('les régions, telles que la carte les nommera')
for (const island of findIslands(points, termsOf)) {
  console.log(`  ${String(island.size).padStart(5)} — ${island.name}`)
}
