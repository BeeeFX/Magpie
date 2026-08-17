import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { projectSync } from '../src/main/tagging/projection-core'

/**
 * Extrait une projection réelle pour comparer des présentations de carte.
 *
 * Sur des données inventées, toutes les maquettes sont belles : les amas sont ronds, bien
 * séparés, de tailles comparables. La vraie bibliothèque n'a rien de tel — c'est précisément
 * pourquoi la carte livrée était illisible. On juge donc sur les vrais vecteurs, déjà en
 * cache dans la base, et sur les vrais textes pour nommer les amas.
 */

const OUT = join(process.cwd(), 'map-sandbox.json')
const CLUSTERS = 22
/** Mots trop répandus pour distinguer quoi que ce soit dans cette bibliothèque. */
const STOP = new Set(
  `the and for you your with this that from have are was but not all can out get how why who what when where a an de la le les des du un une et en est pas plus sur dans par pour qui que quoi avec sans nous vous ils elles son sa ses mon ma mes ce cet cette il elle on ne se au aux of to in it is on my me we they i s t d l n y http https www com instagram x video reel post like follow link bio new more just now day time make made using use used check out via`.split(
    /\s+/
  )
)

function readVectors(): { ids: string[]; flat: Float32Array; width: number; text: Map<string, string> } {
  const db = new Database(join(process.env['APPDATA'] ?? '', 'magpie', 'magpie.db'), {
    readonly: true
  })
  const rows = db
    .prepare(
      `SELECT e.post_id AS id, e.vector, p.text, p.author_handle AS author
         FROM post_embeddings e JOIN posts p ON p.id = e.post_id
        WHERE p.is_archived = 0`
    )
    .all() as { id: string; vector: Buffer; text: string | null; author: string | null }[]
  db.close()
  if (rows.length === 0) throw new Error('Aucun embedding en cache : lancez une analyse dans Magpie.')

  const width = rows[0].vector.byteLength / 4
  const flat = new Float32Array(rows.length * width)
  const ids: string[] = []
  const text = new Map<string, string>()
  rows.forEach((row, index) => {
    const view = new Float32Array(
      row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength)
    )
    flat.set(view, index * width)
    ids.push(row.id)
    text.set(row.id, `${row.text ?? ''} ${row.author ?? ''}`)
  })
  return { ids, flat, width, text }
}

/** k-moyennes sur les coordonnées projetées : c'est ce que l'œil voit, donc ce qu'on groupe. */
function kmeans(points: { x: number; y: number }[], k: number): number[] {
  let seed = 12345
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const centres = Array.from({ length: k }, () => {
    const pick = points[Math.floor(random() * points.length)]
    return { x: pick.x, y: pick.y }
  })
  const labels = new Array<number>(points.length).fill(0)

  for (let round = 0; round < 40; round += 1) {
    let moved = false
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
      if (labels[index] !== best) {
        labels[index] = best
        moved = true
      }
    })
    const sums = centres.map(() => ({ x: 0, y: 0, n: 0 }))
    points.forEach((point, index) => {
      const sum = sums[labels[index]]
      sum.x += point.x
      sum.y += point.y
      sum.n += 1
    })
    sums.forEach((sum, cluster) => {
      if (sum.n > 0) centres[cluster] = { x: sum.x / sum.n, y: sum.y / sum.n }
    })
    if (!moved) break
  }
  return labels
}

function nameOf(members: string[], text: Map<string, string>): string {
  const counts = new Map<string, number>()
  for (const id of members) {
    const words = new Set(
      (text.get(id) ?? '')
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 2 && !STOP.has(word))
    )
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return (
    [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 2)
      .map(([word]) => word.charAt(0).toLocaleUpperCase() + word.slice(1))
      .join(' · ') || 'Sans nom'
  )
}

const { ids, flat, width, text } = readVectors()
console.log(`${ids.length} posts, ${width} dimensions — projection…`)
const started = Date.now()
const vectors = new Map<string, Float32Array>()
ids.forEach((id, index) => vectors.set(id, flat.subarray(index * width, (index + 1) * width)))
const points = projectSync(vectors)
console.log(`projeté en ${Math.round((Date.now() - started) / 1000)} s`)

const labels = kmeans(points, CLUSTERS)
const members = new Map<number, string[]>()
labels.forEach((cluster, index) => {
  const list = members.get(cluster) ?? []
  list.push(points[index].id)
  members.set(cluster, list)
})
const names = new Map<number, string>()
for (const [cluster, list] of members) names.set(cluster, nameOf(list, text))

writeFileSync(
  OUT,
  JSON.stringify({
    points: points.map((point, index) => ({
      x: Number(point.x.toFixed(4)),
      y: Number(point.y.toFixed(4)),
      g: labels[index]
    })),
    groups: [...members.entries()]
      .map(([cluster, list]) => ({ id: cluster, name: names.get(cluster), count: list.length }))
      .sort((left, right) => right.count - left.count)
  })
)
console.log(`écrit dans ${OUT}`)
for (const [cluster, list] of [...members.entries()].sort((l, r) => r[1].length - l[1].length)) {
  console.log(`  ${String(list.length).padStart(5)} — ${names.get(cluster)}`)
}
void readFileSync
