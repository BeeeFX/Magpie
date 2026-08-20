import { getDb } from '../db'
import { BLEND, blockMean, centreBy, encodeTopicPrompts, toVector } from './vision'
import { embedTexts } from './embeddings'

/**
 * Une collection est une requête, pas une région.
 *
 * Le pavage la définissait par sa surface sur la carte, et c'était trois fois faux. Une
 * appartenance est graduée — un post est plus ou moins « production musicale », il n'y entre
 * pas ou n'y entre pas. Elle est multiple — un reel de synthé modulaire filmé au macro est
 * dans deux collections, et l'obliger à choisir perd l'information. Et surtout la carte est
 * une **ombre** : UMAP écrase sept cent soixante-huit dimensions sur deux, donc deux points
 * voisins à l'écran peuvent être loin en sens. Toute définition géométrique hérite des erreurs
 * de la projection et les rend permanentes — c'est ce qui rendait les frontières fragiles bien
 * plus que leur dureté.
 *
 * Ici, une collection porte un **prototype** : un vecteur dans le même espace que les posts.
 * L'appartenance est la ressemblance à ce vecteur, l'ampleur est un seuil, et la carte ne fait
 * que le montrer. Reprojeter ne change plus rien, parce que rien n'est défini par la carte.
 *
 * Deux blocs, et pas trois. Une phrase se projette dans le bloc texte — même modèle que les
 * posts — et dans le bloc SigLIP, qui a justement été entraîné pour que mots et images vivent
 * dans un seul repère. Le bloc DINOv2 reste vide : il décrit une *allure*, une composition, une
 * palette, et aucune tour de texte ne mène là. C'est cohérent avec ce qu'on demande — un mot dit
 * un sujet, pas un grain d'image — et ça se voit dans les poids, renormalisés sur les seuls
 * blocs disponibles.
 */

/** Le vecteur d'une collection, bloc par bloc. `null` = ce bloc ne dit rien d'elle. */
export interface Prototype {
  text: Float32Array | null
  meaning: Float32Array | null
}

/**
 * Les scores de la bibliothèque entière pour un prototype.
 *
 * **Ce qu'ils ne disent pas**, et il faut le savoir avant de bâtir dessus : ils ne disent pas si
 * la collection existe. Mesuré (`scripts/bench-phrases`), sur la bibliothèque de référence :
 * « 3D et rendu » culmine à 0,264 de ressemblance brute et 5,51 écarts-types ; « comptabilité
 * fiscale » culmine à 0,294 et 5,98. La phrase absente note *plus haut* que la phrase présente.
 * L'espace est trop anisotrope pour qu'un seuil absolu sépare quoi que ce soit, et un seuil
 * standardisé retient mécaniquement la même fraction du nuage quelle que soit la phrase.
 *
 * Ce qu'ils disent, en revanche, est excellent : **l'ordre**. Les premiers d'une phrase lui
 * ressemblent vraiment, et une phrase étrangère à la bibliothèque dégrade vers son plus proche
 * voisin de façon visible — « élevage de moutons » ramène des paysages, et personne ne s'y
 * trompe en les regardant.
 *
 * D'où la seule décision honnête en aval : l'ampleur d'une collection est un **nombre de posts**
 * que l'utilisateur choisit en voyant le résultat, et non une confiance que le calcul prétendrait
 * mesurer. Un curseur de confiance aurait inventé quatre cents membres à toute phrase, y compris
 * à celles qui ne désignent rien.
 */
export interface Scores {
  ids: string[]
  /**
   * L'écart à la moyenne, en écarts-types de la distribution du prototype lui-même.
   *
   * Standardisé par collection et non par post, contrairement à `topicStandoff`. La différence
   * compte : standardiser sur les autres collections ferait dériver le seuil de chacune dès
   * qu'on en ajoute une, et une poignée qu'on doit rerégler après chaque création n'est pas une
   * poignée. Ici l'échelle de chaque collection ne dépend que d'elle, et le seuil se lit
   * toujours de la même façon — « à combien d'écarts-types s'arrête-t-elle ».
   */
  z: Float32Array
}

/**
 * Les blocs de la bibliothèque, centrés une fois.
 *
 * Recalculer les moyennes à chaque coup de curseur reviendrait à relire neuf mille vecteurs
 * pour une réponse identique. On les garde, et on les jette dès que le compte change — c'est
 * un signal grossier mais suffisant : une bibliothèque qui grandit change son centre, une
 * bibliothèque immobile ne le change pas.
 */
interface Blocks {
  ids: string[]
  text: Map<string, Float32Array>
  meaning: Map<string, Float32Array>
  textMean: Float64Array
  meaningMean: Float64Array
}

let blocks: Blocks | null = null

export function forgetBlocks(): void {
  blocks = null
}

function libraryBlocks(): Blocks {
  const db = getDb()
  const textRows = db
    .prepare(
      `SELECT e.post_id AS id, e.vector AS vector
         FROM post_embeddings e JOIN posts p ON p.id = e.post_id
        WHERE p.is_archived = 0`
    )
    .all() as { id: string; vector: Buffer }[]
  const meaningRows = db
    .prepare(
      `SELECT i.post_id AS id, i.meaning AS meaning
         FROM post_image_embeddings i JOIN posts p ON p.id = i.post_id
        WHERE p.is_archived = 0`
    )
    .all() as { id: string; meaning: Buffer }[]

  if (blocks && blocks.ids.length === textRows.length && blocks.meaning.size === meaningRows.length) {
    return blocks
  }

  const rawText = textRows.map((row) => toVector(row.vector))
  const rawMeaning = meaningRows.map((row) => toVector(row.meaning))
  const textMean = blockMean(rawText)
  const meaningMean = blockMean(rawMeaning)

  blocks = {
    ids: textRows.map((row) => row.id),
    text: new Map(textRows.map((row, at) => [row.id, centreBy(rawText[at], textMean)])),
    meaning: new Map(meaningRows.map((row, at) => [row.id, centreBy(rawMeaning[at], meaningMean)])),
    textMean,
    meaningMean
  }
  return blocks
}

/**
 * Une phrase, dans le repère des posts.
 *
 * Le libellé compte énormément, et c'est mesuré : « a photo of … » rend 43,7 % de justesse en
 * zéro-shot contre 24,1 % pour le nom du thème suivi de mots-clés. SigLIP a appris sur des
 * légendes de photos, pas sur des listes. On donne donc au bloc image la phrase habillée, et au
 * bloc texte la phrase nue — chacun reçoit ce qu'il sait lire.
 */
export async function encodePhrase(phrase: string): Promise<Prototype> {
  const clean = phrase.trim()
  if (!clean) return { text: null, meaning: null }
  const library = libraryBlocks()
  const [textVector] = await embedTexts([clean])
  const [meaningVector] = await encodeTopicPrompts([`a photo of ${clean.toLowerCase()}`])
  return {
    text: textVector ? centreBy(textVector, library.textMean) : null,
    meaning: meaningVector ? centreBy(meaningVector, library.meaningMean) : null
  }
}

const dot = (a: Float32Array, b: Float32Array): number => {
  let total = 0
  const width = Math.min(a.length, b.length)
  for (let i = 0; i < width; i += 1) total += a[i] * b[i]
  return total
}

function unit(raw: Float64Array | Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < raw.length; i += 1) norm += raw[i] * raw[i]
  norm = Math.sqrt(norm) || 1
  const out = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw[i] / norm
  return out
}

/**
 * Noter toute la bibliothèque contre un prototype.
 *
 * Les poids sont ceux du mélange qui classe — 0,6 pour le texte, 0,3 pour le sujet de l'image —
 * mais renormalisés sur les blocs réellement présents des deux côtés. Un post sans image est
 * donc noté sur son seul texte, à pleine force, plutôt que pénalisé pour un bloc absent : c'est
 * la même règle que `blend`, et pour la même raison. Sans elle, les posts sans image
 * s'agglutinaient par le vide.
 */
export function scoreLibrary(prototype: Prototype): Scores {
  const library = libraryBlocks()
  const raw = new Float64Array(library.ids.length)
  const has = new Uint8Array(library.ids.length)

  library.ids.forEach((id, at) => {
    let total = 0
    let weight = 0
    if (prototype.text) {
      const post = library.text.get(id)
      if (post) {
        total += BLEND.text * dot(post, prototype.text)
        weight += BLEND.text
      }
    }
    if (prototype.meaning) {
      const post = library.meaning.get(id)
      if (post) {
        total += BLEND.meaning * dot(post, prototype.meaning)
        weight += BLEND.meaning
      }
    }
    if (weight > 0) {
      raw[at] = total / weight
      has[at] = 1
    }
  })

  let count = 0
  let sum = 0
  for (let i = 0; i < raw.length; i += 1) {
    if (!has[i]) continue
    count += 1
    sum += raw[i]
  }
  const mean = count > 0 ? sum / count : 0
  let variance = 0
  for (let i = 0; i < raw.length; i += 1) {
    if (has[i]) variance += (raw[i] - mean) ** 2
  }
  const spread = Math.sqrt(count > 0 ? variance / count : 0) || 1

  const z = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) {
    /* Un post que le prototype ne peut pas noter n'est pas « très loin » : il est hors sujet.
       Un très grand négatif le mettrait au fond de tous les classements, ce qui est vrai, mais
       il fausserait aussi l'échelle si on le comptait dans l'écart-type — d'où son exclusion
       plus haut. */
    z[i] = has[i] ? (raw[i] - mean) / spread : Number.NEGATIVE_INFINITY
  }
  return { ids: library.ids, z }
}

/**
 * Corriger un prototype par l'exemple.
 *
 * C'est la rétroaction de Rocchio, et c'est la raison de tout l'édifice : on ne déplace pas une
 * collection en peignant des pixels, on lui montre deux ou trois posts. Le prototype se déplace
 * dans l'espace où le sens vit, et non dans l'ombre qu'en donne la carte — une correction est
 * donc valable pour la bibliothèque entière, y compris pour les posts qui ne sont pas à l'écran,
 * et y compris après une reprojection.
 *
 * Les exemples pèsent moins que le prototype (`0,55`), et les rejets moins que les exemples
 * (`0,3`) : un « non » dit où ne pas aller, ce qui est une information plus faible que « c'est
 * ça ». Les prendre à poids égal faisait basculer la collection à l'opposé du premier rejet.
 */
export function nudge(
  prototype: Prototype,
  included: string[],
  excluded: string[]
): Prototype {
  const library = libraryBlocks()
  const shift = (
    base: Float32Array | null,
    block: Map<string, Float32Array>
  ): Float32Array | null => {
    const yes = included.map((id) => block.get(id)).filter(Boolean) as Float32Array[]
    const no = excluded.map((id) => block.get(id)).filter(Boolean) as Float32Array[]
    if (yes.length === 0 && no.length === 0) return base
    const dims = base?.length ?? yes[0]?.length ?? no[0]?.length ?? 0
    if (dims === 0) return base
    const out = new Float64Array(dims)
    if (base) for (let i = 0; i < dims; i += 1) out[i] = base[i]
    for (const vector of yes) {
      for (let i = 0; i < dims; i += 1) out[i] += (0.55 * vector[i]) / yes.length
    }
    for (const vector of no) {
      for (let i = 0; i < dims; i += 1) out[i] -= (0.3 * vector[i]) / no.length
    }
    return unit(out)
  }
  return {
    text: shift(prototype.text, library.text),
    meaning: shift(prototype.meaning, library.meaning)
  }
}

/**
 * Le prototype d'un ensemble de posts, sans phrase.
 *
 * Sert à deux choses : reprendre une collection existante — celles que l'analyse a proposées
 * n'ont pas de phrase, elles ont des membres — et créer une collection à partir d'une seule
 * sélection au lasso, sans avoir à la nommer d'abord.
 */
export function prototypeOf(postIds: string[]): Prototype {
  return nudge({ text: null, meaning: null }, postIds, [])
}

/**
 * Combien de posts une collection retient, par défaut.
 *
 * Un nombre, et non un seuil de confiance : voir `Scores`. Trois cents est un ordre de grandeur
 * où les premiers sont sûrs et la queue encore défendable sur la bibliothèque de référence —
 * mais c'est un point de départ, pas une vérité : le curseur est là pour ça.
 */
export const DEFAULT_SIZE = 300

/**
 * Le score à partir duquel on retient, pour garder les `size` premiers.
 *
 * Rendu plutôt qu'appliqué, parce que la carte en a besoin : elle peint le dégradé de toute la
 * bibliothèque et n'allume que ce qui dépasse cette valeur. C'est ce qui permet de *voir* ce
 * qu'un cran de plus attraperait.
 */
export function cutFor(scores: Scores, size: number): number {
  const ranked = Array.from(scores.z).filter((value) => Number.isFinite(value)).sort((a, b) => b - a)
  if (ranked.length === 0) return Number.POSITIVE_INFINITY
  const at = Math.max(0, Math.min(ranked.length - 1, Math.round(size) - 1))
  return ranked[at]
}

/** Un mot-clé et ce qu'il pèse. Le vecteur est encodé une fois puis rangé en base. */
export interface Keyword {
  word: string
  weight: number
  vector: Prototype
}

/**
 * Les scores d'un mot, gardés le temps de la session.
 *
 * Régler un poids ne change pas ce qu'un mot ressemble : seul son facteur change. Sans ce
 * cache, bouger un curseur de poids relançait un produit scalaire sur neuf mille posts par mot
 * de la collection — pour un résultat identique à un facteur près.
 */
const wordScores = new Map<string, Float32Array>()

export function forgetWordScores(): void {
  wordScores.clear()
}

/**
 * Ce que vaut chaque post pour une collection décrite par des mots.
 *
 * Le **meilleur** des `poids × ressemblance`, et non leur moyenne. C'est la différence entre une
 * union et un centre de gravité, et elle décide du comportement : avec une moyenne, ajouter
 * « ableton » à « production musicale » déplace tout le thème vers Ableton et fait sortir des
 * posts qui n'avaient rien demandé ; avec un maximum, les posts Ableton entrent et les autres ne
 * bougent pas. C'est ainsi qu'on pense une catégorie — par une poignée de mots dont un seul
 * suffit.
 *
 * Chaque mot est standardisé pour lui-même avant d'être pesé, sans quoi les poids ne
 * signifieraient rien : deux mots n'ont ni la même moyenne ni le même étalement sur la
 * bibliothèque, et les comparer bruts reviendrait à comparer des degrés et des radians.
 */
export function scoreKeywords(keywords: Keyword[]): Scores {
  const library = libraryBlocks()
  const usable = keywords.filter((entry) => entry.vector.text || entry.vector.meaning)
  if (usable.length === 0) {
    return { ids: library.ids, z: new Float32Array(library.ids.length).fill(Number.NEGATIVE_INFINITY) }
  }

  const best = new Float32Array(library.ids.length).fill(Number.NEGATIVE_INFINITY)
  for (const entry of usable) {
    let scores = wordScores.get(entry.word)
    if (!scores || scores.length !== library.ids.length) {
      scores = scoreLibrary(entry.vector).z
      wordScores.set(entry.word, scores)
    }
    const weight = Math.max(0, entry.weight)
    for (let i = 0; i < best.length; i += 1) {
      const value = scores[i]
      if (!Number.isFinite(value)) continue
      const scaled = value * weight
      if (scaled > best[i]) best[i] = scaled
    }
  }
  return { ids: library.ids, z: best }
}
