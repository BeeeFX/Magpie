import Database from 'better-sqlite3'
import { join } from 'node:path'
import { statSync, readFileSync } from 'node:fs'

/**
 * Faut-il renormaliser après centrage ?
 *
 * Retirer le vecteur moyen laisse un résidu dont la *longueur* dit quelque chose : un post
 * dont la légende ne contient rien tombe sur la moyenne du bloc texte, son résidu est
 * minuscule. Renormaliser ce résidu à la longueur 1 le remet à égalité avec un post
 * parfaitement informatif — et amplifie son bruit.
 *
 * On compare donc deux façons de préparer chaque bloc :
 *   A — centré puis renormalisé par post   (chaque post pèse pareil)
 *   B — centré puis mis à l'échelle du bloc (le résidu garde sa longueur, donc sa confiance)
 *
 * En B, la pondération par post tombe toute seule : aucun seuil, aucune règle.
 */

const APP = join(process.env['APPDATA'] ?? '', 'magpie')
const CACHE = process.env['BLEND_CACHE'] as string

const db = new Database(join(APP, 'magpie.db'), { readonly: true })
const all = db
  .prepare(
    `SELECT p.id, p.text, p.author_handle AS author,
            (SELECT GROUP_CONCAT(DISTINCT t.name) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
              WHERE pt.post_id = p.id AND pt.source <> 'ai') AS tags,
            (SELECT m.thumb_path FROM media m
              WHERE m.post_id = p.id AND m.thumb_path IS NOT NULL ORDER BY m.idx LIMIT 1) AS thumb
       FROM posts p WHERE p.is_archived = 0`
  )
  .all() as { id: string; text: string | null; author: string | null; tags: string | null; thumb: string | null }[]
db.close()
const rows = all.filter((r) => {
  if (!r.thumb || !r.author) return false
  try {
    statSync(join(APP, 'media', r.thumb))
    return true
  } catch {
    return false
  }
})

const load = (name: string, dim: number): Float32Array[] => {
  const buf = readFileSync(join(CACHE, `${name}.bin`))
  const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  return rows.map((_, i) => flat.subarray(i * dim, (i + 1) * dim))
}
const text = load('text-no-author', 384)
const dino = load('dinov2', 384)
const siglip = load('siglip', 768)
console.log(`${rows.length} posts, blocs repris du cache`)

const centred = (block: Float32Array[], keepLength: boolean): Float32Array[] => {
  const dim = block[0].length
  const mean = new Float64Array(dim)
  for (const v of block) for (let k = 0; k < dim; k++) mean[k] += v[k] / block.length
  const residual = block.map((v) => {
    const out = new Float32Array(dim)
    for (let k = 0; k < dim; k++) out[k] = v[k] - mean[k]
    return out
  })
  if (!keepLength) {
    return residual.map((v) => {
      let n = 0
      for (let k = 0; k < dim; k++) n += v[k] * v[k]
      n = Math.sqrt(n) || 1
      const out = new Float32Array(dim)
      for (let k = 0; k < dim; k++) out[k] = v[k] / n
      return out
    })
  }
  /* Une seule échelle pour tout le bloc : les blocs deviennent comparables entre eux, mais
     à l'intérieur d'un bloc les posts gardent leurs longueurs relatives — donc leur poids. */
  let avg = 0
  for (const v of residual) {
    let n = 0
    for (let k = 0; k < dim; k++) n += v[k] * v[k]
    avg += Math.sqrt(n) / residual.length
  }
  return residual.map((v) => {
    const out = new Float32Array(dim)
    for (let k = 0; k < dim; k++) out[k] = v[k] / (avg || 1)
    return out
  })
}

let seed = 17
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const byAuthor = new Map<string, number[]>()
rows.forEach((r, i) => {
  const list = byAuthor.get(r.author as string)
  if (list) list.push(i)
  else byAuthor.set(r.author as string, [i])
})
const queries: number[] = []
for (const [, idx] of byAuthor) {
  if (idx.length < 4 || idx.length > 60) continue
  queries.push(idx[Math.floor(rnd() * idx.length)])
}
const sampled = queries.sort(() => rnd() - 0.5).slice(0, 420)

const sims = (block: Float32Array[]): Float32Array => {
  const dim = block[0].length
  const out = new Float32Array(sampled.length * rows.length)
  sampled.forEach((q, qi) => {
    const v = block[q]
    for (let j = 0; j < rows.length; j++) {
      let s = 0
      const w = block[j]
      for (let k = 0; k < dim; k++) s += v[k] * w[k]
      out[qi * rows.length + j] = s
    }
  })
  return out
}

const K = 10
const evaluate = (mats: Float32Array[], weights: number[]): number => {
  let total = 0
  sampled.forEach((q, qi) => {
    const best: { j: number; s: number }[] = []
    for (let j = 0; j < rows.length; j++) {
      if (j === q) continue
      let s = 0
      for (let m = 0; m < mats.length; m++) s += weights[m] * mats[m][qi * rows.length + j]
      if (best.length < K) {
        best.push({ j, s })
        best.sort((a, b) => b.s - a.s)
      } else if (s > best[K - 1].s) {
        best[K - 1] = { j, s }
        best.sort((a, b) => b.s - a.s)
      }
    }
    const author = rows[q].author
    total += best.filter((b) => rows[b.j].author === author).length / K
  })
  return (total / sampled.length) * 100
}

const sweep = (label: string, keepLength: boolean): void => {
  const mats = [
    sims(centred(text, keepLength)),
    sims(centred(dino, keepLength)),
    sims(centred(siglip, keepLength))
  ]
  let bestScore = -1
  let bestW: number[] = []
  for (let a = 0; a <= 10; a++) {
    for (let b = 0; a + b <= 10; b++) {
      const w = [a / 10, b / 10, (10 - a - b) / 10]
      const s = evaluate(mats, w)
      if (s > bestScore) {
        bestScore = s
        bestW = w
      }
    }
  }
  console.log(
    `  ${label.padEnd(40)} texte ${(bestW[0] * 100).toFixed(0).padStart(3)} % · ` +
      `DINOv2 ${(bestW[1] * 100).toFixed(0).padStart(3)} % · SigLIP ${(bestW[2] * 100).toFixed(0).padStart(3)} %` +
      `  →  ${bestScore.toFixed(1)} %`
  )
}

console.log('\nprécision@10, meilleurs poids pour chaque préparation :\n')
sweep('A — centré, renormalisé par post', false)
sweep('B — centré, longueur conservée', true)
