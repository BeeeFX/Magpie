import Database from 'better-sqlite3'
import { join } from 'node:path'
import {
  buildLocalCollectionPlan,
  TOPIC_DESCRIPTORS,
  TOPIC_KEYWORDS,
  TOPIC_PROMPTS
} from '../src/main/tagging/organize'
import type { SemanticInput } from '../src/main/tagging/organize'
import type { OrganizationItem } from '../src/main/db/queries'

/**
 * L'image doit-elle avoir voix au chapitre dans le classement ?
 *
 * Jusqu'ici non : les thèmes sont des phrases, le classement ne lisait donc que le texte, et
 * un post dont la légende se réduit à un lien partait au hasard — la vidéo de guitare rangée
 * dans « Cuisine ». SigLIP sait pourtant comparer une image à des mots ; c'est la raison pour
 * laquelle il avait été retenu, et sa tour texte n'avait jamais servi.
 *
 * Deux choses à mesurer, et la seconde compte autant que la première :
 *   — ce que l'image fait gagner là où le texte ne dit rien ;
 *   — ce qu'elle casse là où le texte tombait juste.
 *
 * Vérité de terrain : les posts dont les mots-clés désignent un thème et un seul. Elle est
 * imparfaite — un post étiqueté « art » peut légitimement relever de « animation » — donc les
 * pourcentages absolus valent moins que l'écart entre les deux passes.
 */

const APP = join(process.env['APPDATA'] ?? '', 'magpie')
const db = new Database(join(APP, 'magpie.db'), { readonly: true })

const posts = db
  .prepare(
    `SELECT p.id, p.text, p.author_handle AS author, p.platform, p.kind,
            (SELECT GROUP_CONCAT(t.name) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
              WHERE pt.post_id = p.id) AS tags
       FROM posts p WHERE p.is_archived = 0`
  )
  .all() as {
  id: string
  text: string | null
  author: string | null
  platform: string
  kind: string
  tags: string | null
}[]

const textVectors = new Map(
  (db.prepare('SELECT post_id, vector FROM post_embeddings').all() as
    { post_id: string; vector: Buffer }[])
    .map((r) => [r.post_id, new Float32Array(r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength))])
)
const meaning = new Map(
  (db.prepare('SELECT post_id, meaning FROM post_image_embeddings').all() as
    { post_id: string; meaning: Buffer }[])
    .map((r) => [r.post_id, new Float32Array(r.meaning.buffer.slice(r.meaning.byteOffset, r.meaning.byteOffset + r.meaning.byteLength))])
)
db.close()

console.log(`${posts.length} posts, ${textVectors.size} vecteurs de texte, ${meaning.size} vecteurs d'image`)

const items: OrganizationItem[] = posts.map((p) => ({
  id: p.id,
  platform: p.platform as OrganizationItem['platform'],
  kind: p.kind as OrganizationItem['kind'],
  sources: ['saved'],
  text: p.text,
  authorHandle: p.author,
  tags: p.tags ? p.tags.split(',') : [],
  thumbPath: null
}))

const tf = await import('@huggingface/transformers')
tf.env.cacheDir = join(APP, 'models')
tf.env.allowLocalModels = false

const unit = (v: Float32Array): Float32Array => {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return v.map((x) => x / n)
}

/* Les thèmes vus par le texte : mêmes modèle, préfixe et réduction que `embeddings.ts`. */
const pipe = await tf.pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8' })
const TOPIC_IDS = TOPIC_DESCRIPTORS.map((t) => t.id)
const topicText = await pipe(
  TOPIC_DESCRIPTORS.map((t) => `query: ${t.text}`),
  { pooling: 'mean', normalize: true }
)
const twidth = topicText.dims[topicText.dims.length - 1]
const topicTextVectors = TOPIC_IDS.map((_, i) =>
  topicText.data.slice(i * twidth, (i + 1) * twidth) as Float32Array
)

/* Les thèmes vus par l'image. */
const tok = await tf.AutoTokenizer.from_pretrained('Xenova/siglip-base-patch16-224')
const tower = await tf.SiglipTextModel.from_pretrained('Xenova/siglip-base-patch16-224', { dtype: 'q8' })
const encoded = await tower(tok(TOPIC_PROMPTS, { padding: 'max_length', max_length: 64, truncation: true }))
const vwidth = encoded.pooler_output.dims[1]
const topicVision = TOPIC_PROMPTS.map((_, i) =>
  unit(Float32Array.from(encoded.pooler_output.data.slice(i * vwidth, (i + 1) * vwidth)))
)

/* Recentrage commun, comme dans `organize.ts` : thèmes et posts doivent vivre dans le même
   repère, sans quoi la comparaison n'a pas de sens. */
const together = new Map(textVectors)
TOPIC_IDS.forEach((id, i) => together.set(`topic:${id}`, topicTextVectors[i]))
const { centreVectors } = await import('../src/main/tagging/embeddings')
const centred = centreVectors(together)

const base: SemanticInput = {
  items: new Map([...textVectors.keys()].map((id) => [id, centred.get(id) as Float32Array])),
  topics: new Map(TOPIC_IDS.map((id) => [id, centred.get(`topic:${id}`) as Float32Array]))
}
const withVision = (floor: number, weight: number): SemanticInput => ({
  ...base,
  vision: { topics: topicVision, ids: TOPIC_IDS, items: meaning, floor, weight }
})

const routesOf = async (semantic: SemanticInput): Promise<Map<string, string>> => {
  const plan = await buildLocalCollectionPlan(items, new Map(), 'fr', () => Promise.resolve(), semantic)
  /* La première clé de `rankedRuleKeys` est la catégorie retenue ; les suivantes sont les
     replis servant à redistribuer si l'utilisateur en exclut une. */
  const out = new Map<string, string>()
  for (const route of plan.routes) {
    const key = route.rankedRuleKeys[0]
    if (key) out.set(route.postId, key)
  }
  return out
}

const avant = await routesOf(base)

const illustres = items.filter((i) => meaning.has(i.id)).map((i) => i.id)
const muets = items
  .filter((i) => meaning.has(i.id) && (i.text ?? '').replace(/https?:\/\/\S+/g, '').trim().length < 25)
  .map((i) => i.id)

/* Vérité de terrain : les posts dont les mots-clés désignent un thème et un seul. C'est là
   que le texte sait de quoi il parle — donc là qu'un poids trop haut se verrait. */
const norm = (v: string): string =>
  v.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
const parTheme = new Map<string, string>()
for (const topic of TOPIC_KEYWORDS) for (const k of topic.keywords) parTheme.set(norm(k), topic.id)
const verite = new Map<string, string>()
for (const post of posts) {
  if (!meaning.has(post.id)) continue
  const vus = new Set(
    (post.tags ?? '').split(',').map(norm).map((k) => parTheme.get(k)).filter(Boolean) as string[]
  )
  if (vus.size === 1) verite.set(post.id, [...vus][0])
}

const compte = (m: Map<string, string>, ids: string[]): number => ids.filter((id) => m.has(id)).length
console.log('')
console.log(`illustrés ${illustres.length} · légende quasi vide ${muets.length} · vérité ${verite.size}`)
console.log('')
console.log('plancher  poids   classés   dont muets   réparés   cassés   juste/vérité')
const ligne = (a: string, b: string, c: string, d: string, e: string, f: string, g: string): string =>
  `${a.padStart(8)}${b.padStart(7)}${c.padStart(10)}${d.padStart(13)}${e.padStart(10)}${f.padStart(9)}${g.padStart(15)}`
let justeBase = 0
for (const [id, attendu] of verite) if (avant.get(id) === attendu) justeBase += 1
console.log(ligne('—', '—', String(compte(avant, illustres)), String(compte(avant, muets)), '—', '—',
  `${justeBase} (${((100 * justeBase) / verite.size).toFixed(1)} %)`))

for (const floor of [2, 2.5, 3]) {
  for (const weight of [2, 4, 6]) {
    const apres = await routesOf(withVision(floor, weight))
    let repare = 0
    let casse = 0
    let juste = 0
    for (const [id, attendu] of verite) {
      const a = avant.get(id)
      const b = apres.get(id)
      if (b === attendu) juste += 1
      if (a !== attendu && b === attendu) repare += 1
      if (a === attendu && b !== attendu) casse += 1
    }
    console.log(ligne(String(floor), String(weight), String(compte(apres, illustres)),
      String(compte(apres, muets)), String(repare), String(casse),
      `${juste} (${((100 * juste) / verite.size).toFixed(1)} %)`))
  }
}
