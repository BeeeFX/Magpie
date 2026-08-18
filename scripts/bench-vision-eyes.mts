import Database from 'better-sqlite3'
import { join } from 'node:path'
import { statSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Le juge, faute de mieux : l'œil.
 *
 * Aucune vérité de terrain propre n'existe dans cette bibliothèque — collections vides, tags
 * tous dérivés du texte, auteur inclus dans le texte embarqué. Toute mesure automatique
 * avantage donc l'encodeur de texte par construction. On regarde alors ce qui compte
 * vraiment : pour les posts dont la légende ne dit rien, l'image trouve-t-elle des voisins
 * sensés ? Ces posts-là n'ont, aujourd'hui, aucun signal du tout.
 */

const APP = join(process.env['APPDATA'] ?? '', 'magpie')
const db = new Database(join(APP, 'magpie.db'), { readonly: true })
const rows = db
  .prepare(
    `SELECT p.id, p.text, p.author_handle AS author,
            (SELECT m.thumb_path FROM media m
              WHERE m.post_id = p.id AND m.thumb_path IS NOT NULL
              ORDER BY m.idx LIMIT 1) AS thumb
       FROM posts p
      WHERE p.is_archived = 0`
  )
  .all() as { id: string; text: string | null; author: string | null; thumb: string | null }[]
db.close()

const usable = (s: string | null): string =>
  (s ?? '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, ' ')
    .replace(/[#@]\w+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const withThumb = rows.filter((r) => {
  if (!r.thumb) return false
  try {
    statSync(join(APP, 'media', r.thumb))
    return true
  } catch {
    return false
  }
})

const tf = await import('@huggingface/transformers')
tf.env.cacheDir = join(APP, 'models')
tf.env.allowLocalModels = false
const proc = await tf.AutoProcessor.from_pretrained('Xenova/dinov2-small')
const vision = await tf.AutoModel.from_pretrained('Xenova/dinov2-small', { dtype: 'q8' })

const vecs: Float32Array[] = []
const t0 = Date.now()
for (const [i, r] of withThumb.entries()) {
  const raw = await tf.RawImage.read(join(APP, 'media', r.thumb as string))
  const inputs = await proc(raw)
  const out = (await vision(inputs as never)) as { last_hidden_state: { data: Float32Array; dims: number[] } }
  const h = out.last_hidden_state
  const w = h.dims[h.dims.length - 1]
  const cls = h.data.slice(0, w)
  let n = 0
  for (let k = 0; k < w; k++) n += cls[k] * cls[k]
  n = Math.sqrt(n) || 1
  const u = new Float32Array(w)
  for (let k = 0; k < w; k++) u[k] = cls[k] / n
  vecs.push(u)
  if ((i + 1) % 1000 === 0) console.log(`  ${i + 1}/${withThumb.length} — ${Math.round((Date.now() - t0) / 1000)} s`)
}
console.log(`${withThumb.length} images encodées en ${Math.round((Date.now() - t0) / 1000)} s`)

const mute = withThumb
  .map((r, i) => ({ r, i }))
  .filter(({ r }) => usable(r.text).length === 0)
console.log(`${mute.length} posts illustrés dont la légende ne dit rien`)

let seed = 21
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const dim = vecs[0].length
const cos = (a: number, b: number): number => {
  let s = 0
  for (let k = 0; k < dim; k++) s += vecs[a][k] * vecs[b][k]
  return s
}
const dataUri = (thumb: string): string =>
  `data:image/webp;base64,${readFileSync(join(APP, 'media', thumb)).toString('base64')}`

const blocks: string[] = []
for (let q = 0; q < 14; q++) {
  const { i } = mute[Math.floor(rnd() * mute.length)]
  const best: { j: number; s: number }[] = []
  for (let j = 0; j < vecs.length; j++) {
    if (j === i || withThumb[j].id === withThumb[i].id) continue
    const s = cos(i, j)
    if (best.length < 5) {
      best.push({ j, s })
      best.sort((a, b) => b.s - a.s)
    } else if (s > best[4].s) {
      best[4] = { j, s }
      best.sort((a, b) => b.s - a.s)
    }
  }
  const cell = (idx: number, score: string): string =>
    `<figure><img src="${dataUri(withThumb[idx].thumb as string)}" alt=""><figcaption>${score}<br><span>@${
      withThumb[idx].author ?? '—'
    }</span></figcaption></figure>`
  blocks.push(
    `<section><div class="row">${cell(i, '<b>départ</b>')}<div class="sep"></div>${best
      .map((b) => cell(b.j, b.s.toFixed(3)))
      .join('')}</div><p class="cap">légende lue par le modèle : <code>${
      (withThumb[i].text ?? '').slice(0, 90).replace(/[<>&]/g, '') || '(vide)'
    }</code></p></section>`
  )
}

writeFileSync(
  process.env['VISION_EYES_OUT'] ?? join(process.cwd(), 'vision-eyes.html'),
  `<title>Voisins par l'image — DINOv2</title>
<style>
body{margin:0;background:#0e0e12;color:#ececf2;font:14px/1.5 system-ui,sans-serif;padding:28px}
h1{font-size:20px;margin:0 0 6px}p.lead{color:#8a8a97;margin:0 0 26px;max-width:70ch}
section{margin:0 0 26px;padding:16px;background:#16161d;border:1px solid #25252f;border-radius:14px}
.row{display:flex;gap:12px;align-items:flex-start}
.sep{width:1px;background:#25252f;align-self:stretch;margin:0 6px}
figure{margin:0;width:132px;flex:none}
img{width:132px;height:132px;object-fit:cover;border-radius:9px;display:block;background:#000}
figcaption{font-size:11px;color:#8a8a97;margin-top:5px;font-variant-numeric:tabular-nums}
figcaption span{color:#6a6a77}
.cap{margin:12px 0 0;font-size:12px;color:#8a8a97}
code{background:#0c0c10;padding:2px 6px;border-radius:5px;color:#b9b9c6}
</style>
<h1>Ce que l'image trouve, là où le texte ne dit rien</h1>
<p class="lead">Quatorze posts dont la légende ne contient aucun mot exploitable — aujourd'hui, le
modèle n'en sait donc rien. À gauche le post de départ, à droite ses cinq plus proches voisins
selon l'image seule (DINOv2-small). Le chiffre est la similarité.</p>
${blocks.join('\n')}`
)
console.log('écrit :', process.env['VISION_EYES_OUT'] ?? 'vision-eyes.html')
