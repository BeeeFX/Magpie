import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { mediaDir } from '../db'
import {
  organizationItems,
  postImageEmbeddings,
  savePostImageEmbeddings,
  type PostImageEmbedding
} from '../db/queries'

/**
 * Ce que le post *montre*, quand sa légende ne dit rien.
 *
 * Un tiers de la bibliothèque de référence n'a aucun texte exploitable — 9 % rien du tout,
 * 26 % moins de vingt-cinq caractères une fois liens, emojis et arobases retirés. Ces posts
 * ne se ressemblent pas : ils se ressemblent *par le vide*, le modèle de texte lisant à peu
 * près la même chose pour tous. Mesuré : 0,894 de similarité moyenne entre eux, contre 0,836
 * dans la bibliothèque entière. Ils s'agglutinaient donc sur la carte sans rien avoir en
 * commun. Les vignettes, elles, sont déjà sur le disque.
 *
 * Deux encodeurs plutôt qu'un, parce qu'ils ne regardent pas la même chose et que la paire
 * mesure mieux que chacun seul — 3,85 écarts-types entre deux images d'un même carrousel et
 * deux images au hasard, contre 3,49 et 2,96 (cf. `scripts/bench-vision-mix`).
 */

/** La structure et le style. Le plus petit des candidats, et le meilleur : 23 Mo, 26 ms. */
const STRUCTURE_MODEL = 'Xenova/dinov2-small'
/** Le sujet. Sait aussi comparer une image à des mots, ce que DINOv2 ne sait pas faire. */
const MEANING_MODEL = 'Xenova/siglip-base-patch16-224'
/** Entre dans le hash : changer de modèle doit tout réencoder, et rien d'autre ne le doit. */
const VERSION = `${STRUCTURE_MODEL}|${MEANING_MODEL}|q8|v1`

export const STRUCTURE_DIMS = 384
export const MEANING_DIMS = 768

type Tensor = { data: Float32Array; dims: number[] }
type Vision = (input: unknown) => Promise<Record<string, Tensor>>
interface Encoders {
  process(image: unknown): Promise<{ structure: unknown; meaning: unknown }>
  structure: Vision
  meaning: Vision
}

let loaded: Encoders | null = null
let loading: Promise<Encoders> | null = null

/** Charge les deux modèles, une fois. Le premier appel les télécharge. */
async function load(): Promise<Encoders> {
  if (loaded) return loaded
  if (loading) return loading
  loading = (async () => {
    const { AutoModel, AutoProcessor, SiglipVisionModel, env } = await import(
      '@huggingface/transformers'
    )
    // Tout vit dans le dossier de données de Magpie, comme le modèle de texte.
    env.cacheDir = join(mediaDir(), '..', 'models')
    env.allowLocalModels = false
    const [structureProcessor, structureModel, meaningModel] = await Promise.all([
      AutoProcessor.from_pretrained(STRUCTURE_MODEL),
      AutoModel.from_pretrained(STRUCTURE_MODEL, { dtype: 'q8' }),
      SiglipVisionModel.from_pretrained(MEANING_MODEL, { dtype: 'q8' })
    ])
    const meaningProcessor = await AutoProcessor.from_pretrained(MEANING_MODEL)
    const encoders: Encoders = {
      process: async (image) => ({
        structure: await structureProcessor(image as never),
        meaning: await meaningProcessor(image as never)
      }),
      structure: (input) => structureModel(input as never) as never,
      meaning: (input) => meaningModel(input as never) as never
    }
    loaded = encoders
    loading = null
    return encoders
  })()
  return loading
}

function unit(raw: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < raw.length; i += 1) norm += raw[i] * raw[i]
  norm = Math.sqrt(norm) || 1
  const out = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw[i] / norm
  return out
}

function toBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

export function toVector(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))
}

/**
 * Encode une ou plusieurs images d'un même post, et rend la moyenne.
 *
 * Pour une vidéo, trois images valent bien mieux qu'une couverture : le début ne dit
 * souvent rien de la suite. Moyenner des vecteurs unitaires puis renormaliser donne le
 * centre de ce que le post montre.
 */
async function encode(paths: string[]): Promise<{ structure: Float32Array; meaning: Float32Array }> {
  const { RawImage } = await import('@huggingface/transformers')
  const models = await load()
  const structure = new Float32Array(STRUCTURE_DIMS)
  const meaning = new Float32Array(MEANING_DIMS)
  let counted = 0
  for (const path of paths) {
    let image
    try {
      image = await RawImage.read(path)
    } catch {
      // Vignette évincée entre le relevé et la lecture : les autres suffisent.
      continue
    }
    const inputs = await models.process(image)
    const structureOut = await models.structure(inputs.structure)
    const meaningOut = await models.meaning(inputs.meaning)
    /* DINOv2 : le jeton CLS porte le résumé de l'image, les suivants décrivent des zones.
       SigLIP expose directement sa sortie réduite. */
    const hidden = structureOut.last_hidden_state
    const clsWidth = hidden.dims[hidden.dims.length - 1]
    const cls = unit(hidden.data.slice(0, clsWidth))
    const pooled = unit(meaningOut.pooler_output.data)
    for (let i = 0; i < STRUCTURE_DIMS; i += 1) structure[i] += cls[i]
    for (let i = 0; i < MEANING_DIMS; i += 1) meaning[i] += pooled[i]
    counted += 1
  }
  if (counted === 0) throw new Error('aucune image lisible')
  return { structure: unit(structure), meaning: unit(meaning) }
}

export interface VisionProgress {
  done: number
  total: number
}

/**
 * Lit les images de tous les posts qui en ont une et dont la lecture manque.
 *
 * Reprend là où elle s'est arrêtée : ce qui est déjà en base et dont la vignette n'a pas
 * changé n'est jamais relu. Une bibliothèque déjà lue coûte donc le temps d'une requête.
 */
export async function readImages(options: {
  framesFor?: (postId: string) => string[] | null
  onProgress?: (progress: VisionProgress) => void
  shouldStop?: () => boolean
}): Promise<{ done: number; total: number; stopped: boolean }> {
  const known = postImageEmbeddings()
  const items = organizationItems().filter((item) => item.thumbPath)
  /* Les chemins décidés une fois : la couverture, ou les images tirées du clip quand il est
     en cache. Le hash en découle, donc télécharger un clip fait relire le post — et lui
     seul. */
  const framesOf = (id: string, cover: string): string[] =>
    options.framesFor?.(id) ?? [join(mediaDir(), cover)]
  const pending = items.filter((item) => {
    const paths = framesOf(item.id, item.thumbPath as string)
    const hash = createHash('sha1').update(`${VERSION} ${paths.join(' ')}`).digest('hex').slice(0, 16)
    return known.get(item.id)?.hash !== hash
  })
  const total = pending.length
  if (total === 0) return { done: 0, total: 0, stopped: false }

  const batch: PostImageEmbedding[] = []
  let done = 0
  for (const item of pending) {
    if (options.shouldStop?.()) {
      savePostImageEmbeddings(batch)
      return { done, total, stopped: true }
    }
    const paths = framesOf(item.id, item.thumbPath as string)
    const hash = createHash('sha1').update(`${VERSION} ${paths.join(' ')}`).digest('hex').slice(0, 16)
    try {
      const { structure, meaning } = await encode(paths)
      batch.push({
        postId: item.id,
        hash,
        structure: toBuffer(structure),
        meaning: toBuffer(meaning),
        frames: paths.length
      })
    } catch {
      // Un post illisible ne doit pas arrêter la passe ; il repassera à la prochaine.
    }
    done += 1
    /* Écriture par paquets : une transaction par post rendait la passe deux fois plus
       lente que le calcul lui-même. */
    if (batch.length >= 64) {
      savePostImageEmbeddings(batch)
      batch.length = 0
    }
    if (done % 16 === 0 || done === total) options.onProgress?.({ done, total })
  }
  savePostImageEmbeddings(batch)
  return { done, total, stopped: false }
}

/**
 * Les trois signaux réunis en un seul vecteur, pour la carte et pour le regroupement.
 *
 * Deux précautions, toutes deux mesurées (cf. `scripts/bench-blend`).
 *
 * **Centrer chaque bloc.** Leurs ressemblances n'ont pas le même étalement — 0,026 pour le
 * texte, 0,113 pour la structure, 0,086 pour le sujet. Or ce qui classe les voisins est
 * l'étalement, pas la moyenne : à poids égaux, l'image imposait quatre fois plus son ordre
 * que le texte. Retirer le vecteur moyen du bloc enlève ce fond commun et ramène les trois
 * dans le même registre — 0,103 / 0,106 / 0,116.
 *
 * **Puis renormaliser par post.** Garder la longueur du résidu ferait office de confiance —
 * une légende vide tombe sur la moyenne, son résidu est minuscule — mais ne rapporte rien à
 * la mesure (17,0 % contre 16,8) et coûte un défaut : la projection travaillant en distance
 * euclidienne, tous les posts peu informatifs se retrouveraient près de l'origine, donc
 * agglutinés au centre de la carte. C'est exactement le défaut qu'on corrige.
 *
 * Sans ces deux précautions, le mélange fait *moins bien que le texte seul* : 9,2 % contre
 * 12,3. Avec, et aux poids ci-dessous : 16,8 %.
 */
export const BLEND = { text: 0.6, structure: 0.1, meaning: 0.3 }

function centred(vectors: Float32Array[]): Float32Array[] {
  if (vectors.length === 0) return []
  const dims = vectors[0].length
  const mean = new Float64Array(dims)
  for (const vector of vectors) {
    for (let i = 0; i < dims; i += 1) mean[i] += vector[i] / vectors.length
  }
  return vectors.map((vector) => {
    const out = new Float32Array(dims)
    for (let i = 0; i < dims; i += 1) out[i] = vector[i] - mean[i]
    return unit(out)
  })
}

/**
 * Un vecteur par post, prêt pour la projection et le regroupement.
 *
 * Un post sans image garde son texte à pleine force : lui coller un bloc image nul le
 * rapprocherait de tous les autres posts sans image, ce qui recréerait l'agglutination par
 * le vide qu'on cherche à défaire.
 */
export function blend(
  text: Map<string, Float32Array>,
  images: Map<string, PostImageEmbedding>
): Map<string, Float32Array> {
  const ids = [...text.keys()]
  if (ids.length === 0) return new Map()
  const illustrated = ids.filter((id) => images.has(id))
  const textBlock = centred(ids.map((id) => text.get(id) as Float32Array))
  const structureBlock = centred(
    illustrated.map((id) => toVector((images.get(id) as PostImageEmbedding).structure))
  )
  const meaningBlock = centred(
    illustrated.map((id) => toVector((images.get(id) as PostImageEmbedding).meaning))
  )
  const structureAt = new Map(illustrated.map((id, index) => [id, structureBlock[index]]))
  const meaningAt = new Map(illustrated.map((id, index) => [id, meaningBlock[index]]))

  const width = textBlock[0].length
  const out = new Map<string, Float32Array>()
  /* La racine, et non le poids lui-même : mettre deux blocs côte à côte fait que leur
     ressemblance est la *somme des produits*, donc chaque bloc multiplié par `w` contribue
     en `w²`. Appliquer 0,6 / 0,1 / 0,3 directement revenait à peser 0,36 / 0,01 / 0,09 —
     mesuré à 15,9 % au lieu de 16,8. */
  const share = {
    text: Math.sqrt(BLEND.text),
    structure: Math.sqrt(BLEND.structure),
    meaning: Math.sqrt(BLEND.meaning)
  }
  ids.forEach((id, index) => {
    const structure = structureAt.get(id)
    const meaning = meaningAt.get(id)
    const vector = new Float32Array(width + STRUCTURE_DIMS + MEANING_DIMS)
    // Sans image, le texte reprend tout le poids plutôt que de laisser deux blocs à zéro.
    const textWeight = structure && meaning ? share.text : 1
    for (let i = 0; i < width; i += 1) vector[i] = textBlock[index][i] * textWeight
    if (structure) {
      for (let i = 0; i < STRUCTURE_DIMS; i += 1) {
        vector[width + i] = structure[i] * share.structure
      }
    }
    if (meaning) {
      for (let i = 0; i < MEANING_DIMS; i += 1) {
        vector[width + STRUCTURE_DIMS + i] = meaning[i] * share.meaning
      }
    }
    out.set(id, vector)
  })
  return out
}
