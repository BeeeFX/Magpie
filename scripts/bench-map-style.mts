import Database from 'better-sqlite3'
import { libraryDbPath } from './library-path'
import { projectSync, TUNING } from '../src/main/tagging/projection-core'
import { blend, BLEND } from '../src/main/tagging/vision'

/**
 * À sujet égal, la carte range-t-elle par allure ? `npm run bench:map-style`
 *
 * C'est la promesse que la carte fait et que rien ne vérifiait : *ce qui parle de la même chose
 * est proche, et ce qui se ressemble l'est encore plus*. Les posts d'art ensemble, et dans l'art,
 * les mêmes gestes graphiques côte à côte. Le mélange y pourvoit en théorie — entre deux posts du
 * même sujet, les termes de texte s'annulent et c'est le bloc d'allure qui départage — mais son
 * poids vaut 0,10 contre 0,60 au texte, et personne n'avait mesuré si cela se voyait.
 *
 * **Le gain d'allure**, la mesure principale : pour chaque post, on prend ses dix plus proches
 * voisins *sur la carte et dans son propre sujet*, et on compare leur ressemblance d'allure à
 * celle de dix membres du sujet tirés au hasard. Un rapport de 1,00 dit que la carte n'ordonne
 * pas du tout par allure à l'intérieur d'un sujet ; 1,30 dit que les voisins immédiats se
 * ressemblent trente pour cent de plus que la moyenne du sujet.
 *
 * **Le gain de sujet** est le témoin, calculé de la même façon sur le bloc de sens. Il dit ce qui
 * gouverne réellement l'ordre fin : si lui monte pendant que l'allure stagne, c'est que le
 * voisinage proche continue de se décider sur le thème, et pas sur le trait.
 *
 * **La compacité** est le prix. Elle mesure si un sujet forme un seul îlot ou plusieurs taches,
 * et c'est elle qui se dégrade quand on donne trop de poids à l'allure : deux illustrations du
 * même style mais de sujets différents finissent voisines, et les îlots se mélangent.
 *
 * Les trois ensemble, sur le même tirage : sans le prix affiché à côté du gain, on choisirait
 * un réglage qui améliore la seule chose qu'on regarde.
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
  ).map((row) => [row.post_id, asVector(row.vector)])
)
const imageRows = db
  .prepare('SELECT post_id, hash, structure, meaning, frames FROM post_image_embeddings')
  .all() as { post_id: string; hash: string; structure: Buffer; meaning: Buffer; frames: number }[]
const images = new Map(
  imageRows.map((row) => [
    row.post_id,
    {
      postId: row.post_id,
      hash: row.hash,
      structure: row.structure,
      meaning: row.meaning,
      frames: row.frames
    }
  ])
)
const tagged = db
  .prepare(
    `SELECT pt.post_id, t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
      WHERE pt.source = 'rule'`
  )
  .all() as { post_id: string; name: string }[]
db.close()

/* Le sujet de chaque post : le mot-clé le plus rare qu'il porte, donc le plus spécifique.
   Même règle que le banc des îlots, pour que les deux parlent des mêmes groupes. */
const seen = new Map<string, number>()
for (const row of tagged) seen.set(row.name, (seen.get(row.name) ?? 0) + 1)
const topic = new Map<string, string>()
for (const row of tagged) {
  const current = topic.get(row.post_id)
  if (!current || (seen.get(row.name) ?? 0) < (seen.get(current) ?? 0)) topic.set(row.post_id, row.name)
}

/** Les blocs d'image, centrés : c'est l'écart à la moyenne qui distingue deux allures. */
function centredBlock(pick: (row: (typeof imageRows)[number]) => Buffer): Map<string, Float32Array> {
  const raw = imageRows.map((row) => asVector(pick(row)))
  const width = raw[0]?.length ?? 0
  const mean = new Float64Array(width)
  for (const vector of raw) for (let i = 0; i < width; i += 1) mean[i] += vector[i] / raw.length
  const out = new Map<string, Float32Array>()
  raw.forEach((vector, index) => {
    const centred = new Float32Array(width)
    let norm = 0
    for (let i = 0; i < width; i += 1) {
      centred[i] = vector[i] - mean[i]
      norm += centred[i] * centred[i]
    }
    norm = Math.sqrt(norm) || 1
    for (let i = 0; i < width; i += 1) centred[i] /= norm
    out.set(imageRows[index].post_id, centred)
  })
  return out
}

const style = centredBlock((row) => row.structure)
const subject = centredBlock((row) => row.meaning)

const cosine = (a: Float32Array, b: Float32Array): number => {
  let total = 0
  const width = Math.min(a.length, b.length)
  for (let i = 0; i < width; i += 1) total += a[i] * b[i]
  return total
}

/** Les sujets assez peuplés pour qu'« ordonner à l'intérieur » veuille dire quelque chose. */
const groups = new Map<string, string[]>()
for (const [id, name] of topic) {
  if (!text.has(id) || !style.has(id)) continue
  const list = groups.get(name)
  if (list) list.push(id)
  else groups.set(name, [id])
}
const subjects = [...groups].filter(([, ids]) => ids.length >= 25)

console.log(
  `${text.size} vecteurs de texte, ${images.size} d'image · ` +
    `${subjects.length} sujets d'au moins 25 posts (${subjects.reduce((n, [, ids]) => n + ids.length, 0)} posts)`
)

const NEIGHBOURS = 10
/* Graine fixe pour le tirage témoin : le hasard doit être le même d'un réglage à l'autre,
   sinon on compare deux mesures qui n'ont pas tiré les mêmes cartes. */
function shuffler(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Lift {
  style: number
  subject: number
}

/** Ressemblance moyenne des dix plus proches sur la carte, rapportée à dix membres au hasard. */
function lift(points: Map<string, { x: number; y: number }>): Lift {
  let nearStyle = 0
  let nearSubject = 0
  let anyStyle = 0
  let anySubject = 0
  let pairs = 0
  let controls = 0
  const random = shuffler(0x51de)

  for (const [, ids] of subjects) {
    for (const id of ids) {
      const here = points.get(id)
      if (!here) continue
      const near: { id: string; d: number }[] = []
      for (const other of ids) {
        if (other === id) continue
        const there = points.get(other)
        if (!there) continue
        const d = Math.hypot(here.x - there.x, here.y - there.y)
        if (near.length < NEIGHBOURS) {
          near.push({ id: other, d })
          near.sort((a, b) => a.d - b.d)
        } else if (d < near[NEIGHBOURS - 1].d) {
          near[NEIGHBOURS - 1] = { id: other, d }
          near.sort((a, b) => a.d - b.d)
        }
      }
      const mine = style.get(id) as Float32Array
      const mineSubject = subject.get(id) as Float32Array
      for (const entry of near) {
        nearStyle += cosine(mine, style.get(entry.id) as Float32Array)
        nearSubject += cosine(mineSubject, subject.get(entry.id) as Float32Array)
        pairs += 1
      }
      /* Le témoin : autant de membres du même sujet, tirés au hasard. C'est lui qui transforme
         une ressemblance absolue — qui ne veut rien dire — en un gain lisible. */
      for (let k = 0; k < NEIGHBOURS; k += 1) {
        const other = ids[Math.floor(random() * ids.length)]
        if (other === id) continue
        anyStyle += cosine(mine, style.get(other) as Float32Array)
        anySubject += cosine(mineSubject, subject.get(other) as Float32Array)
        controls += 1
      }
    }
  }

  const meanNearStyle = nearStyle / Math.max(1, pairs)
  const meanAnyStyle = anyStyle / Math.max(1, controls)
  const meanNearSubject = nearSubject / Math.max(1, pairs)
  const meanAnySubject = anySubject / Math.max(1, controls)
  return {
    style: meanNearStyle / (meanAnyStyle || 1),
    subject: meanNearSubject / (meanAnySubject || 1)
  }
}

/** Part des posts d'un sujet qui tiennent dans sa plus grosse tache. Le prix du réglage. */
function compactness(points: Map<string, { x: number; y: number }>, ids: string[], cell: number): number {
  const cells = new Map<string, number>()
  for (const id of ids) {
    const p = points.get(id)
    if (!p) continue
    const key = `${Math.floor(p.x / cell)}:${Math.floor(p.y / cell)}`
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

/* Le balayage passe **par** le réglage actuel : le premier candidat reproduit exactement
   `BLEND`, pour que la ligne de référence soit la carte qu'on a et non une approximation. */
const WEIGHTS = [BLEND.structure, 0.15, 0.2, 0.25, 0.3]
const SEEDS = [0x5eed, 0x1234]

console.log('\nallure   texte  sens    graine   gain d’allure   gain de sujet   compacité   durée')
for (const structure of WEIGHTS) {
  const rest = 1 - structure
  /* Texte et sens gardent leur rapport de deux pour un : on ne fait bouger qu'une chose. */
  const recipe = { text: (rest * 2) / 3, structure, meaning: rest / 3 }
  const vectors = blend(text, images, recipe)
  for (const seed of SEEDS) {
    const started = Date.now()
    const projected = projectSync(vectors, undefined, { ...TUNING, seed })
    const seconds = (Date.now() - started) / 1000
    const points = new Map(projected.map((p) => [p.id, { x: p.x, y: p.y }]))

    const xs = projected.map((p) => p.x)
    const ys = projected.map((p) => p.y)
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    const cell = span / 50
    let weighted = 0
    let count = 0
    for (const [, ids] of subjects) {
      weighted += compactness(points, ids, cell) * ids.length
      count += ids.length
    }

    const gain = lift(points)
    const label = `${structure.toFixed(2)}    ${recipe.text.toFixed(2)}   ${recipe.meaning.toFixed(2)}`
    console.log(
      `${label}   ${seed === SEEDS[0] ? '1' : '2'}        ` +
        `${gain.style.toFixed(3).padStart(9)}       ${gain.subject.toFixed(3).padStart(9)}` +
        `      ${((weighted / count) * 100).toFixed(1).padStart(5)} %   ${seconds.toFixed(0).padStart(3)} s`
    )
  }
}
