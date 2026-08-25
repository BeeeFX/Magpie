import Database from 'better-sqlite3'
import { libraryDbPath } from './library-path'
import { projectSync, type ProjectedPoint } from '../src/main/tagging/projection-core'
import { blend } from '../src/main/tagging/vision'
import { arrangeGrid, GRID_TUNING, type GridCell } from '../src/renderer/src/map-grid'

/**
 * Le damier tient-il la promesse qu'il fait ?
 *
 * Un rangement en grille renonce aux distances exactes. Il n'a donc qu'un seul argument : que
 * l'**ordre** survive — que ce qui était voisin sur la carte le reste dans le damier. On le
 * mesure avec les deux instruments du banc de qualité, pour que les chiffres se lisent dans la
 * même langue :
 *
 *   **proche** — sur les huit plus proches voisins d'une vignette sur la carte, combien restent
 *   ses huit plus proches cases dans le damier.
 *
 *   **loin** — la corrélation des rangs entre les distances sur la carte et les distances dans
 *   le damier, sur toutes les paires.
 *
 * Trois arrangements se disputent : le hasard, qui donne le plancher ; le rangement direct — la
 * position de chaque vignette décide de sa case, les conflits repoussés à la case libre
 * suivante —, qui est ce qu'on ferait sans y penser ; et FLAS, qui part du second et l'améliore
 * par affectations locales.
 *
 * On mesure sur un **carré de la carte**, et non sur la bibliothèque entière : c'est la
 * situation réelle du damier, celle où l'on a zoomé sur une région et où les vignettes se
 * recouvrent.
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
db.close()

const vectors = blend(text, images)
console.log(`${vectors.size} posts — projection…`)
const started = Date.now()
const points: ProjectedPoint[] = projectSync(vectors)
console.log(`  ${((Date.now() - started) / 1000).toFixed(0)} s`)

/** Un carré de la carte, tel qu'un zoom en montrerait un. */
function window_(centreX: number, centreY: number, half: number): ProjectedPoint[] {
  return points.filter(
    (point) =>
      Math.abs(point.x - centreX) <= half && Math.abs(point.y - centreY) <= half
  )
}

const K = 8

function neighbours(
  count: number,
  distance: (a: number, b: number) => number
): Int32Array[] {
  const out: Int32Array[] = []
  for (let i = 0; i < count; i += 1) {
    const best = new Int32Array(K).fill(-1)
    const score = new Float64Array(K).fill(Infinity)
    for (let j = 0; j < count; j += 1) {
      if (j === i) continue
      const value = distance(i, j)
      if (value >= score[K - 1]) continue
      let slot = K - 1
      while (slot > 0 && score[slot - 1] > value) {
        score[slot] = score[slot - 1]
        best[slot] = best[slot - 1]
        slot -= 1
      }
      score[slot] = value
      best[slot] = j
    }
    out.push(best)
  }
  return out
}

function ranks(values: Float64Array): Float64Array {
  const order = Array.from(values.keys()).sort((a, b) => values[a] - values[b])
  const out = new Float64Array(values.length)
  order.forEach((index, rank) => {
    out[index] = rank
  })
  return out
}

function correlation(left: Float64Array, right: Float64Array): number {
  const count = left.length
  let meanLeft = 0
  let meanRight = 0
  for (let i = 0; i < count; i += 1) {
    meanLeft += left[i] / count
    meanRight += right[i] / count
  }
  let covariance = 0
  let varianceLeft = 0
  let varianceRight = 0
  for (let i = 0; i < count; i += 1) {
    const a = left[i] - meanLeft
    const b = right[i] - meanRight
    covariance += a * b
    varianceLeft += a * a
    varianceRight += b * b
  }
  const spread = Math.sqrt(varianceLeft * varianceRight)
  return spread > 0 ? covariance / spread : 0
}

interface Score {
  near: number
  far: number
  ms: number
}

function judge(
  items: ProjectedPoint[],
  cells: Map<string, GridCell>,
  ms: number
): Score {
  const list = items.map((item) => cells.get(item.id) as GridCell)
  const onMap = neighbours(items.length, (a, b) =>
    (items[a].x - items[b].x) ** 2 + (items[a].y - items[b].y) ** 2
  )
  const onGrid = neighbours(items.length, (a, b) =>
    (list[a].column - list[b].column) ** 2 + (list[a].row - list[b].row) ** 2
  )
  let kept = 0
  for (let i = 0; i < items.length; i += 1) {
    const reference = new Set(Array.from(onMap[i]).filter((index) => index >= 0))
    for (const index of onGrid[i]) if (index >= 0 && reference.has(index)) kept += 1
  }

  const pairs = (items.length * (items.length - 1)) / 2
  const mapApart = new Float64Array(pairs)
  const gridApart = new Float64Array(pairs)
  let at = 0
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      mapApart[at] = Math.hypot(items[i].x - items[j].x, items[i].y - items[j].y)
      gridApart[at] = Math.hypot(list[i].column - list[j].column, list[i].row - list[j].row)
      at += 1
    }
  }

  return {
    near: kept / (items.length * K),
    far: correlation(ranks(mapApart), ranks(gridApart)),
    ms
  }
}

/** Le plancher : les mêmes cases, tirées au sort. */
function shuffled(items: ProjectedPoint[], columns: number, rows: number): Map<string, GridCell> {
  let seed = 4242
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const cells = Array.from({ length: columns * rows }, (_, cell) => cell)
  for (let i = cells.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const swap = cells[i]
    cells[i] = cells[j]
    cells[j] = swap
  }
  return new Map(
    items.map((item, index) => [
      item.id,
      { column: cells[index] % columns, row: Math.floor(cells[index] / columns) }
    ])
  )
}

/** Le rangement direct : la position décide de la case, les conflits glissent d'un cran. */
function direct(items: ProjectedPoint[], columns: number, rows: number): Map<string, GridCell> {
  const lowX = Math.min(...items.map((item) => item.x))
  const highX = Math.max(...items.map((item) => item.x))
  const lowY = Math.min(...items.map((item) => item.y))
  const highY = Math.max(...items.map((item) => item.y))
  const at = new Int32Array(columns * rows).fill(-1)
  const out = new Map<string, GridCell>()
  const order = [...items.keys()].sort((left, right) => {
    const a = items[left]
    const b = items[right]
    return a.y - b.y || a.x - b.x
  })
  for (const index of order) {
    const item = items[index]
    const column = Math.min(
      columns - 1,
      Math.max(0, Math.floor(((item.x - lowX) / (highX - lowX || 1)) * columns))
    )
    const row = Math.min(
      rows - 1,
      Math.max(0, Math.floor(((item.y - lowY) / (highY - lowY || 1)) * rows))
    )
    let cell = row * columns + column
    while (at[cell] !== -1) cell = (cell + 1) % (columns * rows)
    at[cell] = index
    out.set(item.id, { column: cell % columns, row: Math.floor(cell / columns) })
  }
  return out
}

/** Le même cadrage que `direct`, pour que FLAS parte des mêmes cases. */
function framed(items: ProjectedPoint[]): ProjectedPoint[] {
  const lowX = Math.min(...items.map((item) => item.x))
  const highX = Math.max(...items.map((item) => item.x))
  const lowY = Math.min(...items.map((item) => item.y))
  const highY = Math.max(...items.map((item) => item.y))
  return items.map((item) => ({
    id: item.id,
    x: (item.x - lowX) / (highX - lowX || 1),
    y: (item.y - lowY) / (highY - lowY || 1)
  }))
}

/* Trois carrés, choisis pour couvrir des densités différentes : le cœur du nuage, un bord, et
   un entre-deux. Un damier qui ne marche que là où c'est dense ne servirait à rien. */
const spots: [string, number, number, number][] = [
  ['cœur', 0.5, 0.5, 0.05],
  ['bord', 0.3, 0.35, 0.07],
  ['large', 0.5, 0.5, 0.09]
]

/** Le carré du cœur, gardé pour le balayage des réglages qui suit. */
let knobs: { items: ProjectedPoint[]; frame: ProjectedPoint[]; side: number } | null = null

console.log('')
console.log('carré     vignettes   damier   arrangement       proche      loin     durée')
for (const [label, centreX, centreY, half] of spots) {
  const items = window_(centreX, centreY, half)
  if (items.length < 40) {
    console.log(`${label.padEnd(10)}${String(items.length).padStart(9)}   — trop peu de posts`)
    continue
  }
  const side = Math.ceil(Math.sqrt(items.length * 1.15))
  const frame = framed(items)

  const runs: [string, () => { cells: Map<string, GridCell>; ms: number }][] = [
    [
      'hasard',
      () => {
        const at = Date.now()
        const cells = shuffled(items, side, side)
        return { cells, ms: Date.now() - at }
      }
    ],
    [
      'rangement direct',
      () => {
        const at = Date.now()
        const cells = direct(items, side, side)
        return { cells, ms: Date.now() - at }
      }
    ],
    [
      'FLAS',
      () => {
        const at = Date.now()
        const cells = arrangeGrid(frame, side, side, GRID_TUNING)
        return { cells, ms: Date.now() - at }
      }
    ]
  ]

  if (label === 'cœur') {
    knobs = { items, frame, side }
  }

  runs.forEach(([name, run], index) => {
    const { cells, ms } = run()
    const score = judge(items, cells, ms)
    console.log(
      `${(index === 0 ? label : '').padEnd(10)}` +
        `${(index === 0 ? String(items.length) : '').padStart(9)}` +
        `${(index === 0 ? `${side}×${side}` : '').padStart(9)}   ${name.padEnd(18)}` +
        `${`${(score.near * 100).toFixed(1)} %`.padStart(7)}` +
        `${`${(score.far * 100).toFixed(1)} %`.padStart(10)}` +
        `${`${score.ms} ms`.padStart(10)}`
    )
  })
}

/* ------------------------------------------------------------------ les réglages de FLAS */

if (knobs) {
  const { items, frame, side } = knobs
  console.log('')
  console.log(`réglages de FLAS, sur le carré du cœur (${items.length} vignettes)`)
  console.log('rayon   refroid.   tuile     proche      loin     durée')
  const sweep: [number, number, number][] = [
    [0.5, 0.85, 3],
    [0.5, 0.9, 3],
    [0.5, 0.95, 3],
    [0.5, 0.97, 3],
    [1.0, 0.95, 3],
    [0.5, 0.95, 2],
    [0.5, 0.95, 4],
    [0.5, 0.97, 4]
  ]
  for (const [radius, cooling, tile] of sweep) {
    const at = Date.now()
    const cells = arrangeGrid(frame, side, side, { ...GRID_TUNING, radius, cooling, tile })
    const score = judge(items, cells, Date.now() - at)
    console.log(
      `${radius.toFixed(2).padStart(5)}${cooling.toFixed(2).padStart(11)}${String(tile).padStart(8)}` +
        `${`${(score.near * 100).toFixed(1)} %`.padStart(11)}` +
        `${`${(score.far * 100).toFixed(1)} %`.padStart(10)}` +
        `${`${score.ms} ms`.padStart(10)}`
    )
  }
}
