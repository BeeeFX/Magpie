import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { libraryDbPath } from './library-path'
import { projectSync, TUNING, type ProjectionTuning } from '../src/main/tagging/projection-core'
import { blend } from '../src/main/tagging/vision'

/**
 * Les trois cartes côte à côte, sur la vraie bibliothèque.
 *
 * Un banc rend des nombres, et les nombres ne disent pas si une carte est *lisible*. Celui-ci
 * rejoue la même projection trois fois — même graine, même mélange, même tout — en ne changeant
 * que le départ de la descente, et pose les résultats l'un à côté de l'autre.
 *
 * La teinte vient d'un regroupement fait **dans les vecteurs**, pas dans le plan : k-moyennes
 * sur les 1 536 dimensions, donc le même découpage pour les trois cartes, et aucune des trois
 * n'a d'avance. La question devient alors visible d'un coup d'œil — un groupe de sens tient-il
 * en une tache, ou se retrouve-t-il aux deux bouts de la page ?
 *
 * Les étiquettes de règle ne pouvaient pas jouer ce rôle : elles ne couvrent que 3 231 posts sur
 * 9 828, et sept d'entre elles seulement atteignent vingt-cinq membres. C'est aussi ce qui rend
 * la compacité du banc historique si bruyante — elle se mesure sur trois pour cent de la
 * bibliothèque.
 */

const OUT = join(process.cwd(), 'map-init-compare.html')
const CLUSTERS = 18

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
const words = new Map(
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

/* ---------------------------------------------- le regroupement, dans les vecteurs */

const flatVectors = new Float32Array(ids.length * width)
ids.forEach((id, index) => {
  const vector = vectors.get(id) as Float32Array
  let norm = 0
  for (let i = 0; i < width; i += 1) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm) || 1
  const at = index * width
  for (let i = 0; i < width; i += 1) flatVectors[at + i] = vector[i] / norm
})

/** k-moyennes sphériques : les vecteurs sont unitaires, le cosinus suffit donc à comparer. */
function cluster(k: number): Int32Array {
  let seed = 20260824
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const centres = new Float32Array(k * width)
  for (let c = 0; c < k; c += 1) {
    const pick = Math.floor(random() * ids.length)
    centres.set(flatVectors.subarray(pick * width, (pick + 1) * width), c * width)
  }
  const label = new Int32Array(ids.length)
  for (let round = 0; round < 25; round += 1) {
    let moved = 0
    for (let i = 0; i < ids.length; i += 1) {
      const at = i * width
      let best = 0
      let bestScore = -Infinity
      for (let c = 0; c < k; c += 1) {
        const from = c * width
        let dot = 0
        for (let d = 0; d < width; d += 1) dot += flatVectors[at + d] * centres[from + d]
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
    const counts = new Int32Array(k)
    for (let i = 0; i < ids.length; i += 1) {
      const c = label[i]
      counts[c] += 1
      const at = i * width
      const from = c * width
      for (let d = 0; d < width; d += 1) centres[from + d] += flatVectors[at + d]
    }
    for (let c = 0; c < k; c += 1) {
      const from = c * width
      let norm = 0
      for (let d = 0; d < width; d += 1) norm += centres[from + d] * centres[from + d]
      norm = Math.sqrt(norm) || 1
      for (let d = 0; d < width; d += 1) centres[from + d] /= norm
    }
    console.log(`  k-moyennes, passe ${round + 1} — ${moved} déplacements`)
  }
  return label
}

const started = Date.now()
const label = cluster(CLUSTERS)
console.log(`regroupé en ${((Date.now() - started) / 1000).toFixed(0)} s`)

/* ------------------------------------------------------------------- les noms, en c-TF-IDF */

const STOP = new Set(
  `the and for you your with this that from have are was but not all can out get how why who what when where a an de la le les des du un une et en est pas plus sur dans par pour qui que quoi avec sans nous vous ils elles son sa ses mon ma mes ce cet cette il elle on ne se au aux of to in it is on my me we they i s t d l n y http https www com instagram x video reel post like follow link bio new more just now day time make made using use used check out via про для это как так его она они был été être fait très tout tous plus bien aussi comme quand même donc alors`.split(
    /\s+/
  )
)

const termsOf = (id: string): Set<string> =>
  new Set(
    (words.get(id) ?? '')
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && word.length < 22 && !STOP.has(word))
  )

/**
 * c-TF-IDF, à la BERTopic — et c'est ce qui sépare un nom d'un comptage.
 *
 * Un comptage brut fait remonter dans chaque amas le vocabulaire commun à toute la
 * bibliothèque : « music » et « video » y gagnent partout, et deux amas voisins finissent par
 * porter le même nom. Ici la fréquence d'un mot *dans* l'amas est pondérée par sa rareté
 * *ailleurs* : `tf(t, c) / |c| × log(1 + A / f(t))`, où `f(t)` est le nombre total de posts qui
 * emploient le mot et `A` la taille moyenne d'un amas. Un mot qui est partout perd tout son
 * poids ; un mot qui n'est qu'ici le garde entier.
 */
function names(label: Int32Array, k: number): string[] {
  const inCluster: Map<string, number>[] = Array.from({ length: k }, () => new Map())
  const everywhere = new Map<string, number>()
  const size = new Int32Array(k)
  ids.forEach((id, index) => {
    const c = label[index]
    size[c] += 1
    for (const term of termsOf(id)) {
      inCluster[c].set(term, (inCluster[c].get(term) ?? 0) + 1)
      everywhere.set(term, (everywhere.get(term) ?? 0) + 1)
    }
  })
  const average = ids.length / k

  return inCluster.map((counts, c) => {
    const ranked = [...counts]
      .filter(([, count]) => count >= 3)
      .map(([term, count]) => {
        const weight = (count / Math.max(1, size[c])) * Math.log(1 + average / (everywhere.get(term) ?? 1))
        return [term, weight] as const
      })
      .sort((left, right) => right[1] - left[1])
    const kept: string[] = []
    for (const [term] of ranked) {
      // Deux mots dont l'un contient l'autre ne disent qu'une chose : « blender », « blender3d ».
      if (kept.some((word) => word.includes(term) || term.includes(word))) continue
      kept.push(term)
      if (kept.length === 2) break
    }
    return kept.map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1)).join(' · ') || '—'
  })
}

const clusterNames = names(label, CLUSTERS)
const order = [...clusterNames.keys()].sort((left, right) => {
  let a = 0
  let b = 0
  for (const value of label) {
    if (value === left) a += 1
    if (value === right) b += 1
  }
  return b - a
})
const rank = new Map(order.map((cluster, index) => [cluster, index]))
const shown = order.map((cluster) => clusterNames[cluster])
order.forEach((cluster) => {
  let count = 0
  for (const value of label) if (value === cluster) count += 1
  console.log(`  ${String(count).padStart(5)} — ${clusterNames[cluster]}`)
})

/* ------------------------------------------------------------------------- les trois cartes */

interface Panel {
  label: string
  note: string
  flat: number[]
  seconds: number
}

const at = new Map(ids.map((id, index) => [id, index]))

function run(name: string, note: string, tuning: ProjectionTuning): Panel {
  const started = Date.now()
  const projected = projectSync(vectors, undefined, tuning)
  const seconds = (Date.now() - started) / 1000
  console.log(`${name} — ${seconds.toFixed(0)} s`)
  const flat: number[] = []
  for (const point of projected) {
    const index = at.get(point.id) as number
    flat.push(
      Math.round(point.x * 1000),
      Math.round(point.y * 1000),
      rank.get(label[index]) ?? -1
    )
  }
  return { label: name, note, flat, seconds }
}

const SEED = 0x5eed
/* Chaque panneau nomme son départ, y compris celui d'avant : `TUNING` porte désormais le départ
   retenu, et s'y fier ferait dessiner deux fois la même carte sous deux titres différents. */
const panels = [
  run('Départ au hasard', 'ce que la version 0.34 calcule', {
    ...TUNING,
    seed: SEED,
    init: 'random'
  }),
  run('Départ sur les axes principaux', 'posé sur son ombre linéaire', {
    ...TUNING,
    seed: SEED,
    init: 'pca'
  }),
  run('Départ spectral', 'posé sur le graphe de voisinage', {
    ...TUNING,
    seed: SEED,
    init: 'spectral'
  })
]

writeFileSync(
  join(process.cwd(), 'map-init-points.json'),
  JSON.stringify({
    names: shown,
    panels: panels.map((panel) => ({ label: panel.label, flat: panel.flat }))
  })
)

const page = `<!doctype html><meta charset="utf-8">
<title>Carte sémantique — le départ d'UMAP</title>
<style>
:root{--bg:#0e0e12;--panel:#16161d;--line:#25252f;--text:#ececf2;--faint:#8a8a97;--accent:#7c5cfc;
  --ui:"Inter Tight","Segoe UI Variable Display","Segoe UI",Roboto,system-ui,sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 var(--ui)}
.wrap{max-width:1700px;margin:0 auto;padding:38px 22px 70px}
h1{font-size:27px;margin:0 0 6px;letter-spacing:-.025em;font-weight:650}
.lead{color:var(--faint);margin:0 0 24px;max-width:80ch}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(430px,1fr));gap:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:15px;overflow:hidden}
.card header{padding:13px 17px;border-bottom:1px solid var(--line)}
.card h2{font-size:16px;margin:0;letter-spacing:-.015em;font-weight:600}
.card header p{margin:2px 0 0;color:var(--faint);font-size:12.5px}
canvas{display:block;width:100%;height:auto;background:#08080c}
.legend{display:flex;flex-wrap:wrap;gap:5px 14px;padding:0 0 18px;font-size:11.5px;color:var(--faint)}
.legend span{display:inline-flex;align-items:center;gap:5px}
.legend i{width:8px;height:8px;border-radius:2px;display:inline-block}
</style>
<div class="wrap">
<h1>Le départ d'UMAP, sur ${ids.length.toLocaleString('fr-FR')} posts</h1>
<p class="lead">Trois fois la même projection : mêmes vecteurs, même graine, mêmes réglages. Seule
change la position d'où part la descente. Les couleurs sont ${CLUSTERS} groupes trouvés
<strong>dans les vecteurs</strong> — le même découpage pour les trois cartes, nommé en c-TF-IDF.</p>
<div class="legend" id="legend"></div>
<div class="grid" id="grid"></div>
</div>
<script>
const PANELS = ${JSON.stringify(panels.map((panel) => ({ label: panel.label, note: panel.note, flat: panel.flat, seconds: Math.round(panel.seconds) })))}
const NAMES = ${JSON.stringify(shown)}
const PAL = ['#ff5c5c','#ff9f43','#ffd93d','#4ade80','#38bdf8','#a78bfa','#f472b6','#2dd4bf','#c9a227','#818cf8','#fb7185','#34d399','#e879f9','#a3e635','#60a5fa','#fde047','#c084fc','#22d3ee']
const SIDE = 800, PAD = 24
document.getElementById('legend').innerHTML = NAMES.map((name, i) =>
  '<span><i style="background:' + PAL[i % PAL.length] + '"></i>' + name + '</span>').join('')
const grid = document.getElementById('grid')
for (const panel of PANELS) {
  const card = document.createElement('div'); card.className = 'card'
  card.innerHTML = '<header><h2>' + panel.label + '</h2><p>' + panel.note + ' · ' + panel.seconds + ' s</p></header>'
  const canvas = document.createElement('canvas')
  canvas.width = SIDE; canvas.height = SIDE
  card.appendChild(canvas); grid.appendChild(card)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#08080c'; ctx.fillRect(0, 0, SIDE, SIDE)
  const at = v => PAD + (v / 1000) * (SIDE - 2 * PAD)
  const n = panel.flat.length / 3
  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < n; i++) {
    const g = panel.flat[i * 3 + 2]
    ctx.fillStyle = g < 0 ? 'rgba(120,120,135,.30)' : PAL[g % PAL.length] + '99'
    ctx.beginPath()
    ctx.arc(at(panel.flat[i * 3]), at(panel.flat[i * 3 + 1]), 1.5, 0, 6.2832)
    ctx.fill()
  }
  ctx.globalCompositeOperation = 'source-over'
  const CELL = 40
  NAMES.forEach((name, g) => {
    const cells = new Map()
    for (let i = 0; i < n; i++) {
      if (panel.flat[i * 3 + 2] !== g) continue
      const x = at(panel.flat[i * 3]), y = at(panel.flat[i * 3 + 1])
      const key = Math.floor(x / CELL) + ':' + Math.floor(y / CELL)
      const cell = cells.get(key) || { x: 0, y: 0, n: 0 }
      cell.x += x; cell.y += y; cell.n++
      cells.set(key, cell)
    }
    let best = null
    for (const cell of cells.values()) if (!best || cell.n > best.n) best = cell
    if (!best) return
    ctx.font = '600 12.5px system-ui, sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.lineWidth = 3.4; ctx.strokeStyle = 'rgba(4,4,8,.92)'
    ctx.strokeText(name, best.x / best.n, best.y / best.n)
    ctx.fillStyle = PAL[g % PAL.length]
    ctx.fillText(name, best.x / best.n, best.y / best.n)
  })
}
</script>`

writeFileSync(OUT, page)
console.log(`écrit dans ${OUT}`)
