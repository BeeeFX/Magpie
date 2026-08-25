import Database from 'better-sqlite3'
import { libraryDbPath } from './library-path'
import { projectSync, TUNING, type ProjectionTuning } from '../src/main/tagging/projection-core'
import { blend } from '../src/main/tagging/vision'

/**
 * La carte dit-elle la vérité sur la bibliothèque ? — l'instrument qui manquait.
 *
 * Les deux bancs existants mesurent la *forme* du résultat : la compacité dit si une collection
 * tient en une tache, l'étalement si le nuage occupe la page. Aucun des deux ne compare la carte
 * à ce qu'elle prétend représenter, et c'est pourquoi ils ne tranchent rien : à configuration
 * identique, la seule graine d'UMAP fait bouger la compacité de vingt et un points. Un banc dont
 * le bruit dépasse l'effet cherché ne mesure pas, il tire au sort.
 *
 * On mesure donc les deux propriétés que la littérature sur la réduction de dimension sépare
 * depuis toujours, parce qu'une projection peut très bien réussir l'une en ratant l'autre :
 *
 *   **Le proche** — un post a-t-il les mêmes voisins à l'écran qu'en 1 536 dimensions ? C'est ce
 *   qui décide si « ce qui est à côté va avec ». On prend les vingt plus proches voisins d'un
 *   post dans les vecteurs, les vingt plus proches à l'écran, et on compte ceux qui sont dans
 *   les deux. Cent pour cent voudrait dire que la carte ne ment jamais sur le voisinage.
 *
 *   **Le loin** — deux posts éloignés dans le sens le sont-ils à l'écran ? C'est ce qui décide si
 *   traverser la carte veut dire quelque chose. On corrèle les rangs de toutes les distances
 *   entre paires d'un échantillon. C'est exactement la mesure sur laquelle Kobak et Linderman
 *   montrent, dans Nature Biotechnology, que le *départ* d'UMAP compte plus que ses réglages.
 *
 * Et une troisième, qui n'est pas une qualité mais une propriété du produit :
 *
 *   **La constance** — deux analyses de la même bibliothèque rendent-elles la même carte ? On
 *   corrèle les distances entre les mêmes paires d'une graine à l'autre. C'est ce qui décide si
 *   la carte est un lieu dont on se souvient ou une image différente à chaque fois.
 *
 * Le voisinage de référence est calculé **une fois** sur les vecteurs bruts, puis relu par
 * toutes les configurations : c'est la seule façon de comparer des cartes entre elles plutôt
 * que chacune à sa propre version de la vérité.
 *
 * Compter une dizaine de minutes.
 */

/* La même porte que les autres contrôles : `MAGPIE_DATA_DIR` fait tourner le banc sur une copie
   de la vraie base plutôt que sur la bibliothèque installée. */
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
/* Les catégories, reprises des règles en base comme le fait `bench:map-islands` — on garde la
   compacité au tableau pour que les deux bancs restent comparables. */
const tagged = db
  .prepare(
    `SELECT pt.post_id, t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
      WHERE pt.source = 'rule'`
  )
  .all() as { post_id: string; name: string }[]
db.close()

const group = new Map<string, string>()
const seen = new Map<string, number>()
for (const row of tagged) seen.set(row.name, (seen.get(row.name) ?? 0) + 1)
for (const row of tagged) {
  const current = group.get(row.post_id)
  if (!current || (seen.get(row.name) ?? 0) < (seen.get(current) ?? 0)) group.set(row.post_id, row.name)
}

const vectors = blend(text, images)
const ids = [...vectors.keys()]
const width = vectors.get(ids[0])?.length ?? 0
console.log(`${ids.length} posts, ${width} dimensions`)

const members = new Map<string, string[]>()
for (const [id, name] of group) {
  if (!vectors.has(id)) continue
  const list = members.get(name)
  if (list) list.push(id)
  else members.set(name, [id])
}
const collections = [...members].filter(([, list]) => list.length >= 25)

/* ------------------------------------------------------------------ la vérité de référence */

/**
 * Les vecteurs à plat, ramenés à la longueur 1.
 *
 * À plat parce que le voisinage de référence lit toute la bibliothèque une fois par post
 * échantillonné : neuf mille tableaux séparés feraient sauter le cache à chaque ligne, alors
 * qu'une seule bande de soixante mégaoctets se parcourt en séquence. À longueur 1 parce que le
 * sens se compare en cosinus, et qu'un produit scalaire suffit alors.
 */
const flat = new Float32Array(ids.length * width)
ids.forEach((id, index) => {
  const vector = vectors.get(id) as Float32Array
  let norm = 0
  for (let i = 0; i < width; i += 1) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm) || 1
  const at = index * width
  for (let i = 0; i < width; i += 1) flat[at + i] = vector[i] / norm
})

/** Combien de posts on interroge. Chacun coûte une lecture de toute la bibliothèque. */
const SAMPLE = 800
/** Combien de voisins on compare. Vingt : l'ordre de grandeur de ce qu'un écran montre autour. */
const K = 20

/* Échantillon régulier plutôt que tiré : la même bibliothèque doit donner le même banc. */
const step = Math.max(1, Math.floor(ids.length / SAMPLE))
const sample: number[] = []
for (let i = 0; i < ids.length && sample.length < SAMPLE; i += step) sample.push(i)

/** Les `K` plus proches d'un point, par force brute sur une bande contiguë. */
function nearest(
  at: number,
  count: number,
  distance: (index: number) => number
): Int32Array {
  const best = new Int32Array(K).fill(-1)
  const score = new Float64Array(K).fill(Infinity)
  for (let index = 0; index < count; index += 1) {
    if (index === at) continue
    const value = distance(index)
    if (value >= score[K - 1]) continue
    let slot = K - 1
    while (slot > 0 && score[slot - 1] > value) {
      score[slot] = score[slot - 1]
      best[slot] = best[slot - 1]
      slot -= 1
    }
    score[slot] = value
    best[slot] = index
  }
  return best
}

console.log(`voisinage de référence : ${sample.length} posts × ${ids.length} — patience…`)
const startedTruth = Date.now()
const truth: Set<number>[] = sample.map((at) => {
  const from = at * width
  const neighbours = nearest(at, ids.length, (index) => {
    const to = index * width
    let dot = 0
    for (let i = 0; i < width; i += 1) dot += flat[from + i] * flat[to + i]
    return -dot
  })
  return new Set(Array.from(neighbours).filter((index) => index >= 0))
})
console.log(`  ${((Date.now() - startedTruth) / 1000).toFixed(0)} s`)

/**
 * Les paires de l'échantillon, et leur distance dans le sens.
 *
 * Toutes les paires : trois cent mille, ce qui est à la fois calculable et assez pour que la
 * corrélation ne dépende plus du tirage.
 */
const pairs: [number, number][] = []
for (let i = 0; i < sample.length; i += 1) {
  for (let j = i + 1; j < sample.length; j += 1) pairs.push([sample[i], sample[j]])
}
const truthPairs = new Float64Array(pairs.length)
pairs.forEach(([a, b], index) => {
  const from = a * width
  const to = b * width
  let dot = 0
  for (let i = 0; i < width; i += 1) dot += flat[from + i] * flat[to + i]
  truthPairs[index] = 1 - dot
})

/** Les rangs d'une série, pour corréler des distances qui n'ont pas la même échelle. */
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

const truthRanks = ranks(truthPairs)

/* ------------------------------------------------------------------------------- la mesure */

/** La compacité de `bench:map-islands`, reprise telle quelle pour rester comparable. */
function compactness(
  points: Map<string, { x: number; y: number }>,
  list: string[],
  cell: number
): number {
  const cells = new Map<string, number>()
  for (const id of list) {
    const point = points.get(id)
    if (!point) continue
    const key = `${Math.floor(point.x / cell)}:${Math.floor(point.y / cell)}`
    cells.set(key, (cells.get(key) ?? 0) + 1)
  }
  const visited = new Set<string>()
  let biggest = 0
  let total = 0
  for (const start of cells.keys()) {
    if (visited.has(start)) continue
    let size = 0
    const queue = [start]
    visited.add(start)
    while (queue.length > 0) {
      const key = queue.pop() as string
      size += cells.get(key) ?? 0
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
    total += size
    if (size > biggest) biggest = size
  }
  return total > 0 ? biggest / total : 0
}

interface Score {
  near: number
  far: number
  compact: number
  spread: number
  seconds: number
  pairs: Float64Array
}

function score(tuning: ProjectionTuning): Score {
  const started = Date.now()
  const projected = projectSync(vectors, undefined, tuning)
  const seconds = (Date.now() - started) / 1000

  const place = new Float64Array(ids.length * 2)
  const at = new Map(ids.map((id, index) => [id, index]))
  for (const point of projected) {
    const index = at.get(point.id)
    if (index === undefined) continue
    place[index * 2] = point.x
    place[index * 2 + 1] = point.y
  }

  let kept = 0
  sample.forEach((from, slot) => {
    const x = place[from * 2]
    const y = place[from * 2 + 1]
    const neighbours = nearest(from, ids.length, (index) => {
      const dx = place[index * 2] - x
      const dy = place[index * 2 + 1] - y
      return dx * dx + dy * dy
    })
    const reference = truth[slot]
    for (const index of neighbours) if (index >= 0 && reference.has(index)) kept += 1
  })

  const seenPairs = new Float64Array(pairs.length)
  pairs.forEach(([a, b], index) => {
    const dx = place[a * 2] - place[b * 2]
    const dy = place[a * 2 + 1] - place[b * 2 + 1]
    seenPairs[index] = Math.sqrt(dx * dx + dy * dy)
  })

  const points = new Map(projected.map((point) => [point.id, { x: point.x, y: point.y }]))
  const xs = projected.map((point) => point.x)
  const ys = projected.map((point) => point.y)
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  const cell = span / 50
  let weighted = 0
  let count = 0
  for (const [, list] of collections) {
    weighted += compactness(points, list, cell) * list.length
    count += list.length
  }

  const grid = new Set(projected.map((point) => `${Math.round(point.x * 20)}:${Math.round(point.y * 20)}`))

  return {
    near: kept / (sample.length * K),
    far: correlation(truthRanks, ranks(seenPairs)),
    compact: weighted / count,
    spread: grid.size,
    seconds,
    pairs: seenPairs
  }
}

/* ------------------------------------------------------------------------------ le balayage */

const SEEDS = [0x5eed, 0x1234, 0xbeef]

/**
 * Deux balayages, parce qu'ils répondent à deux questions et que le second dépend du premier.
 *
 * `depart` compare les deux façons de commencer la descente, tout le reste égal.
 *
 * `voisinage` rejoue le réglage qui avait été choisi *pour compenser* le départ au hasard :
 * soixante voisins avaient été retenus parce qu'en dessous « une collection sur cinq se scinde
 * en plusieurs taches ». Or une collection qui se scinde est exactement le symptôme d'un départ
 * qui a jeté ses deux moitiés dans deux coins — un large voisinage ne soignait pas la cause, il
 * couvrait la trace. Si le départ sur les axes tient sa promesse, le voisinage peut redescendre,
 * et le proche — que soixante voisins écrase — remonter.
 */
const SWEEP = process.argv.includes('--voisinage')
  ? 'voisinage'
  : process.argv.includes('--croissance')
    ? 'croissance'
    : 'depart'
const CONFIGS: { label: string; tuning: Omit<ProjectionTuning, 'seed'> }[] =
  SWEEP === 'voisinage'
    ? [15, 30, 60].map((neighbours) => ({
        label: `${neighbours} voisins`,
        tuning: { ...TUNING, init: 'spectral' as const, neighbours }
      }))
    : [
        /* Le départ d'avant s'écrit en toutes lettres : `TUNING` porte désormais celui qu'on a
           retenu, et s'y fier ferait comparer une configuration à elle-même. */
        { label: 'départ au hasard', tuning: { ...TUNING, init: 'random' } },
        { label: 'départ sur les axes', tuning: { ...TUNING, init: 'pca' } },
        { label: 'départ spectral', tuning: { ...TUNING, init: 'spectral' } }
      ]

const average = (list: number[]): number => list.reduce((sum, value) => sum + value, 0) / list.length

/**
 * La question que le produit pose vraiment : la carte tient-elle quand la bibliothèque grossit ?
 *
 * « La carte ne change pas quand de nouveaux posts arrivent — ils s'ajoutent, les anciens ne
 * bougent pas » est le principe directeur écrit noir sur blanc. Entre deux reprojections il est
 * tenu par l'interpolation ; mais il arrive un moment où la couverture ne suffit plus et où la
 * carte se recalcule pour de bon. Ce jour-là, l'utilisateur retrouve-t-il son territoire ?
 *
 * On projette donc la bibliothèque amputée d'un post sur dix, puis la bibliothèque entière, et
 * on demande si les posts communs se retrouvent dans les mêmes positions relatives. C'est la
 * même corrélation de rangs que « loin », mais entre deux cartes au lieu d'entre une carte et
 * les vecteurs. Cent pour cent voudrait dire que les mille nouveaux posts se sont posés sans
 * rien déplacer.
 */
function growth(tuning: ProjectionTuning): number {
  const younger = new Map<string, Float32Array>()
  ids.forEach((id, index) => {
    if (index % 10 !== 0) younger.set(id, vectors.get(id) as Float32Array)
  })

  const place = (points: { id: string; x: number; y: number }[]): Map<string, [number, number]> =>
    new Map(points.map((point) => [point.id, [point.x, point.y]]))
  const before = place(projectSync(younger, undefined, tuning))
  const after = place(projectSync(vectors, undefined, tuning))

  const common = [...younger.keys()]
  const step = Math.max(1, Math.floor(common.length / SAMPLE))
  const watched: string[] = []
  for (let i = 0; i < common.length && watched.length < SAMPLE; i += step) watched.push(common[i])

  const count = (watched.length * (watched.length - 1)) / 2
  const wasApart = new Float64Array(count)
  const isApart = new Float64Array(count)
  let at = 0
  for (let i = 0; i < watched.length; i += 1) {
    for (let j = i + 1; j < watched.length; j += 1) {
      const a = before.get(watched[i]) as [number, number]
      const b = before.get(watched[j]) as [number, number]
      const c = after.get(watched[i]) as [number, number]
      const d = after.get(watched[j]) as [number, number]
      wasApart[at] = Math.hypot(a[0] - b[0], a[1] - b[1])
      isApart[at] = Math.hypot(c[0] - d[0], c[1] - d[1])
      at += 1
    }
  }
  return correlation(ranks(wasApart), ranks(isApart))
}

if (SWEEP === 'croissance') {
  console.log('')
  console.log(`un post sur dix retiré, puis remis — ${ids.length} posts au total`)
  console.log('réglage                  la carte tient')
  for (const config of CONFIGS) {
    const kept = growth({ ...config.tuning, seed: SEEDS[0] } as ProjectionTuning)
    console.log(`${config.label.padEnd(24)}${`${(kept * 100).toFixed(1)} %`.padStart(9)}`)
  }
  process.exit(0)
}

console.log('')
console.log('réglage                graine    proche      loin   compacité   étalement   durée')
const results = new Map<string, Score[]>()
for (const config of CONFIGS) {
  const runs: Score[] = []
  SEEDS.forEach((seed, index) => {
    const result = score({ ...config.tuning, seed } as ProjectionTuning)
    runs.push(result)
    console.log(
      `${(index === 0 ? config.label : '').padEnd(22)}${String(index + 1).padStart(6)}` +
        `${`${(result.near * 100).toFixed(1)} %`.padStart(10)}` +
        `${`${(result.far * 100).toFixed(1)} %`.padStart(10)}` +
        `${`${(result.compact * 100).toFixed(1)} %`.padStart(12)}` +
        `${String(result.spread).padStart(12)}${`${result.seconds.toFixed(0)} s`.padStart(8)}`
    )
  })
  results.set(config.label, runs)
}

console.log('')
console.log('réglage                  proche          loin      compacité     constance')
for (const [label, runs] of results) {
  const stability: number[] = []
  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      stability.push(correlation(ranks(runs[i].pairs), ranks(runs[j].pairs)))
    }
  }
  const show = (list: number[]): string => {
    const mean = average(list)
    const worst = Math.min(...list)
    const best = Math.max(...list)
    return `${(mean * 100).toFixed(1)} % ±${(((best - worst) / 2) * 100).toFixed(1)}`
  }
  console.log(
    `${label.padEnd(22)}${show(runs.map((run) => run.near)).padStart(14)}` +
      `${show(runs.map((run) => run.far)).padStart(14)}` +
      `${show(runs.map((run) => run.compact)).padStart(14)}` +
      `${show(stability).padStart(14)}`
  )
}
