import Database from 'better-sqlite3'
import { libraryDbPath } from './library-path'
import { projectSync, TUNING, type ProjectionTuning } from '../src/main/tagging/projection-core'
import { blend } from '../src/main/tagging/vision'
import type { ProjectedPoint } from '../src/main/tagging/projection-core'

/**
 * Une collection forme-t-elle **un** îlot, ou plusieurs taches éparpillées ?
 *
 * C'est la question que pose l'écran, et aucun banc n'y répondait. Celui des thèmes mesure un
 * *resserrement* — la distance moyenne entre deux posts d'un même thème, rapportée à deux
 * posts au hasard — qui vaut 44 % et qui peut très bien rester bon pendant qu'une collection
 * se scinde en deux moitiés compactes mais éloignées. Or c'est exactement ce qu'on voit.
 *
 * On mesure donc la **compacité** : la part des posts d'une collection qui tiennent dans sa
 * plus grosse tache. Cent pour cent, c'est un îlot unique ; cinquante, c'est coupé en deux.
 * Les taches sont trouvées par proximité, sur une grille — deux posts se touchent s'ils sont
 * dans la même case ou dans une case voisine — ce qui reproduit ce que l'œil appelle « une
 * tache » sans réglage arbitraire de distance.
 *
 * L'enjeu dépasse l'esthétique : on ne peut pas tracer une frontière autour d'un ensemble qui
 * n'est pas d'un seul tenant. La suite de la carte — les frontières qu'on déplace, et qui
 * doivent ensuite ranger les nouveaux posts — en dépend entièrement.
 */

/* La même porte que les contrôles : `MAGPIE_DATA_DIR` fait tourner le banc sur une copie de
   la vraie base plutôt que sur la bibliothèque installée, qu'on ne veut pas ouvrir pendant
   qu'on s'en sert. */
const db = new Database(libraryDbPath(), { readonly: true })

const asVector = (b: Buffer): Float32Array =>
  new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))

const text = new Map(
  (db.prepare('SELECT post_id, vector FROM post_embeddings').all() as
    { post_id: string; vector: Buffer }[]).map((r) => [r.post_id, asVector(r.vector)])
)
const images = new Map(
  (db.prepare('SELECT post_id, hash, structure, meaning, frames FROM post_image_embeddings').all() as
    { post_id: string; hash: string; structure: Buffer; meaning: Buffer; frames: number }[])
    .map((r) => [r.post_id, { postId: r.post_id, hash: r.hash, structure: r.structure, meaning: r.meaning, frames: r.frames }])
)
/* La catégorie de chaque post, telle que l'organiseur la décide. Reprise des règles de
   mots-clés en base : recalculer un plan complet demanderait les modèles, alors que la
   question posée ici ne porte que sur le placement. */
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
  /* Un post porte souvent plusieurs mots-clés : on retient le plus rare, qui est le plus
     spécifique — c'est aussi ce que fait le score de l'organiseur. */
  const current = group.get(row.post_id)
  if (!current || (seen.get(row.name) ?? 0) < (seen.get(current) ?? 0)) group.set(row.post_id, row.name)
}

console.log(`${text.size} vecteurs de texte, ${images.size} d'image, ${group.size} posts étiquetés`)

const vectors = blend(text, images)
console.log(`${vectors.size} vecteurs mélangés, ${vectors.values().next().value?.length} dimensions`)

/** Les collections assez grosses pour qu'« éparpillée » veuille dire quelque chose. */
const members = new Map<string, string[]>()
for (const [id, name] of group) {
  if (!vectors.has(id)) continue
  const list = members.get(name)
  if (list) list.push(id)
  else members.set(name, [id])
}
const collections = [...members].filter(([, ids]) => ids.length >= 25)
console.log(`${collections.length} collections de 25 posts ou plus\n`)

/**
 * Part des posts d'une collection qui tiennent dans sa plus grosse tache.
 *
 * Les taches se trouvent par cases voisines : deux posts appartiennent à la même tache s'ils
 * partagent une case ou en occupent deux adjacentes, de proche en proche. La taille de case
 * est relative à l'emprise de la carte, donc la mesure ne dépend pas de l'échelle.
 */
function compactness(points: Map<string, { x: number; y: number }>, ids: string[], cell: number): number {
  const cells = new Map<string, string[]>()
  const keyOf = (p: { x: number; y: number }): string =>
    `${Math.floor(p.x / cell)}:${Math.floor(p.y / cell)}`
  for (const id of ids) {
    const p = points.get(id)
    if (!p) continue
    const key = keyOf(p)
    const list = cells.get(key)
    if (list) list.push(id)
    else cells.set(key, [id])
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
      size += (cells.get(key) ?? []).length
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
  compact: number
  tight: number
  /** Cases occupées sur une grille 20 × 20, comme `check:map`. Dit si la carte se tasse. */
  spread: number
  seconds: number
}

function score(tuning: ProjectionTuning): Score {
  const started = Date.now()
  const projected: ProjectedPoint[] = projectSync(vectors, undefined, tuning)
  const seconds = (Date.now() - started) / 1000
  const points = new Map(projected.map((p) => [p.id, { x: p.x, y: p.y }]))
  const xs = projected.map((p) => p.x)
  const ys = projected.map((p) => p.y)
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  /* Une case pour un cinquantième de l'emprise : assez fine pour séparer deux amas voisins,
     assez large pour qu'un amas ne se fragmente pas sur ses propres trous. */
  const cell = span / 50

  let weighted = 0
  let count = 0
  for (const [, ids] of collections) {
    weighted += compactness(points, ids, cell) * ids.length
    count += ids.length
  }

  /* Le resserrement, pour garder le lien avec le banc existant : distance moyenne entre deux
     posts d'une même collection, rapportée à deux posts au hasard. */
  let within = 0
  let withinCount = 0
  for (const [, ids] of collections) {
    for (let i = 0; i < ids.length; i += 7) {
      for (let j = i + 1; j < ids.length; j += 7) {
        const a = points.get(ids[i])
        const b = points.get(ids[j])
        if (!a || !b) continue
        within += Math.hypot(a.x - b.x, a.y - b.y)
        withinCount += 1
      }
    }
  }
  let apart = 0
  let apartCount = 0
  const all = projected
  for (let i = 0; i < all.length; i += 97) {
    for (let j = i + 1; j < all.length; j += 97) {
      apart += Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y)
      apartCount += 1
    }
  }
  const tight =
    apartCount > 0 && withinCount > 0 ? 1 - within / withinCount / (apart / apartCount) : 0

  /* L'étalement, que la compacité ne voit pas : resserrer les collections jusqu'à ce que
     chacune devienne un point donnerait une compacité parfaite et une carte illisible, où
     l'on ne distingue plus rien à l'intérieur d'un îlot — donc où l'on ne peut plus placer
     une frontière. Les deux doivent tenir ensemble. */
  const cells = new Set(
    projected.map((p) => `${Math.round(p.x * 20)}:${Math.round(p.y * 20)}`)
  )

  return { compact: weighted / count, tight, spread: cells.size, seconds }
}

/* Le balayage entier, pour qu'il soit rejouable : c'est lui qui a retourné la note sur le
   voisinage dans `projection-core`, et une conclusion qu'on ne peut plus refaire n'est plus
   une mesure. Compter une quinzaine de minutes. */
const SEEDS = [0x5eed, 0x1234, 0xbeef]
const candidates: { label: string; tuning: ProjectionTuning }[] = SEEDS.flatMap((seed, index) => [
  { label: `PCA 256, graine ${index + 1}`, tuning: { ...TUNING, seed } },
  {
    label: `aléatoire 256, graine ${index + 1}`,
    tuning: { ...TUNING, reduction: 'random' as const, seed }
  }
])

console.log('réglage                              compacité   resserrement   étalement   durée')
for (const candidate of candidates) {
  const result = score(candidate.tuning)
  console.log(
    `${candidate.label.padEnd(36)} ${(result.compact * 100).toFixed(1).padStart(7)} %` +
      `${(result.tight * 100).toFixed(1).padStart(13)} %${String(result.spread).padStart(11)}${`${result.seconds.toFixed(0)} s`.padStart(9)}`
  )
}
