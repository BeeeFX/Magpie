import Database from 'better-sqlite3'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { blend, BLEND, MEANING_DIMS, STRUCTURE_DIMS } from '../src/main/tagging/vision'
import type { PostImageEmbedding } from '../src/main/db/queries'

/**
 * Le code de production rend-il bien ce que le banc a mesuré ?
 *
 * `scripts/bench-blend` a trouvé 16,8 % de précision@10 avec des blocs centrés puis
 * renormalisés et des poids 60 / 10 / 30. Rien ne garantit que `blend()` fasse la même
 * chose — c'est une réécriture. On rejoue donc la mesure en passant par la fonction livrée,
 * sur les mêmes vecteurs en cache, et on vérifie qu'on retombe dessus.
 */

const APP = join(process.env['APPDATA'] ?? '', 'magpie')
const CACHE = process.env['BLEND_CACHE'] ?? ''
if (!CACHE || !existsSync(join(CACHE, 'siglip.bin'))) {
  console.log('Vecteurs de banc absents — lancez d’abord scripts/bench-blend.mts.')
  console.log('(BLEND_CACHE doit pointer sur le dossier qu’il a écrit.)')
  process.exit(0)
}

const db = new Database(join(APP, 'magpie.db'), { readonly: true })
const all = db
  .prepare(
    `SELECT p.id, p.author_handle AS author,
            (SELECT m.thumb_path FROM media m
              WHERE m.post_id = p.id AND m.thumb_path IS NOT NULL ORDER BY m.idx LIMIT 1) AS thumb
       FROM posts p WHERE p.is_archived = 0`
  )
  .all() as { id: string; author: string | null; thumb: string | null }[]
db.close()
const rows = all.filter((r) => r.thumb && r.author)

/* La taille du fichier, comparée au nombre de posts : c'est le seul garde-fou qui marche.
   Comparer la longueur du tableau *après* découpage ne pouvait rien détecter — il fait
   toujours `rows.length`, puisqu'on le construit à partir de `rows`. La bibliothèque ayant
   gagné treize posts entre le banc et la vérification, tout se décalait d'un cran et le
   contrôle annonçait 0 % au lieu de dire que son cache était périmé. */
const load = (name: string, dims: number): Float32Array[] => {
  const buf = readFileSync(join(CACHE, `${name}.bin`))
  const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  const counted = flat.length / dims
  if (counted !== rows.length) {
    console.log(
      `Cache périmé : ${counted} vecteurs pour ${rows.length} posts.` +
        ' Relancez scripts/bench-blend.mts avant ce contrôle.'
    )
    process.exit(0)
  }
  return rows.map((_, i) => flat.slice(i * dims, (i + 1) * dims))
}
const text = load('text-no-author', 384)
const structure = load('dinov2', STRUCTURE_DIMS)
const meaning = load('siglip', MEANING_DIMS)
const asBuffer = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength)
const textMap = new Map(rows.map((r, i) => [r.id, text[i]]))
const imageMap = new Map<string, PostImageEmbedding>(
  rows.map((r, i) => [
    r.id,
    { postId: r.id, hash: '', structure: asBuffer(structure[i]), meaning: asBuffer(meaning[i]), frames: 1 }
  ])
)

console.log(`${rows.length} posts — mélange par le code de production`)
console.log(`poids : texte ${BLEND.text} · structure ${BLEND.structure} · sujet ${BLEND.meaning}`)
const blended = blend(textMap, imageMap)

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

const vectors = rows.map((r) => blended.get(r.id) as Float32Array)
const dims = vectors[0].length
const K = 10
let total = 0
for (const q of sampled) {
  const v = vectors[q]
  const best: { j: number; s: number }[] = []
  for (let j = 0; j < rows.length; j += 1) {
    if (j === q) continue
    let s = 0
    const w = vectors[j]
    for (let k = 0; k < dims; k += 1) s += v[k] * w[k]
    if (best.length < K) {
      best.push({ j, s })
      best.sort((a, b) => b.s - a.s)
    } else if (s > best[K - 1].s) {
      best[K - 1] = { j, s }
      best.sort((a, b) => b.s - a.s)
    }
  }
  total += best.filter((b) => rows[b.j].author === rows[q].author).length / K
}
const score = (total / sampled.length) * 100
console.log(`\nprécision@10 par le code livré : ${score.toFixed(1)} %`)
console.log('attendu par le banc            : 16.8 %')
/* Un demi-point de tolérance : à un point, la version qui oubliait la racine des poids
   — donc pesait 0,36 / 0,01 / 0,09 — passait le contrôle. */
const ok = Math.abs(score - 16.8) < 0.5
console.log(ok ? '\n✓ le code de production reproduit la mesure.' : '\n✗ écart inattendu — le mélange livré ne fait pas ce que le banc a mesuré.')
process.exit(ok ? 0 : 1)
