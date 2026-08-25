import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { libraryDbPath } from './library-path'
import { projectSync, type ProjectedPoint } from '../src/main/tagging/projection-core'
import { blend } from '../src/main/tagging/vision'
import { postTerms } from '../src/main/tagging/terms'
import { findIslands, islandMembership } from '../src/main/tagging/islands'
import { arrangeGrid, GRID_TUNING } from '../src/renderer/src/map-grid'

/**
 * De quoi *voir* les régions et le damier, hors de l'application.
 *
 * Écrit ce que la carte calcule — les points, leur région, les noms, et un carré rangé de deux
 * façons — pour qu'une page puisse le dessiner. Un tableau de nombres ne dit pas si une région
 * tombe au bon endroit ; une image le dit en une seconde.
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
console.log(`${vectors.size} posts — projection…`)
const points: ProjectedPoint[] = projectSync(vectors)

const islands = findIslands(points, (id) => postTerms(captions.get(id) ?? ''))
const membership = islandMembership(points)
const rank = new Map(islands.map((island, index) => [Number(island.id.replace('island-', '')), index]))
console.log(`${islands.length} régions`)

/* Le carré du cœur : la situation où le damier a un sens, celle où les vignettes se recouvrent. */
const HALF = 0.05
const window_ = points.filter(
  (point) => Math.abs(point.x - 0.5) <= HALF && Math.abs(point.y - 0.5) <= HALF
)
const lowX = Math.min(...window_.map((point) => point.x))
const highX = Math.max(...window_.map((point) => point.x))
const lowY = Math.min(...window_.map((point) => point.y))
const highY = Math.max(...window_.map((point) => point.y))
const framed = window_.map((point) => ({
  id: point.id,
  x: (point.x - lowX) / (highX - lowX || 1),
  y: (point.y - lowY) / (highY - lowY || 1)
}))
const side = Math.ceil(Math.sqrt(window_.length * 1.15))
const tidy = arrangeGrid(framed, side, side, GRID_TUNING)

/** Le rangement direct, pour la comparaison. */
const direct = new Map<string, { column: number; row: number }>()
{
  const at = new Int32Array(side * side).fill(-1)
  const order = [...framed.keys()].sort((left, right) => {
    const a = framed[left]
    const b = framed[right]
    return a.y - b.y || a.x - b.x
  })
  for (const index of order) {
    const item = framed[index]
    const column = Math.min(side - 1, Math.max(0, Math.floor(item.x * side)))
    const row = Math.min(side - 1, Math.max(0, Math.floor(item.y * side)))
    let cell = row * side + column
    while (at[cell] !== -1) cell = (cell + 1) % (side * side)
    at[cell] = index
    direct.set(item.id, { column: cell % side, row: Math.floor(cell / side) })
  }
}

const OUT = join(process.cwd(), 'map-regions.json')
writeFileSync(
  OUT,
  JSON.stringify({
    regions: islands.map((island) => ({
      name: island.name,
      x: Math.round(island.x * 1000),
      y: Math.round(island.y * 1000),
      size: island.size
    })),
    points: points.flatMap((point) => [
      Math.round(point.x * 1000),
      Math.round(point.y * 1000),
      rank.get(membership.get(point.id) ?? -1) ?? -1
    ]),
    grid: {
      side,
      count: window_.length,
      /* Pour chaque vignette : sa position d'origine dans le carré — c'est elle qui donne la
         teinte, car un damier bien rangé se lit comme un dégradé continu et un damier mal rangé
         comme du bruit —, puis sa case en rangement direct et sa case après FLAS. */
      cells: framed.flatMap((item) => {
        const a = direct.get(item.id) as { column: number; row: number }
        const b = tidy.get(item.id) as { column: number; row: number }
        return [
          Math.round(item.x * 1000),
          Math.round(item.y * 1000),
          a.column,
          a.row,
          b.column,
          b.row
        ]
      })
    }
  })
)
console.log(`écrit dans ${OUT} — damier ${side}×${side} pour ${window_.length} vignettes`)
