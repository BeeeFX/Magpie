import { createHash } from 'node:crypto'
import { app } from 'electron'
import { join } from 'node:path'
import {
  postEmbeddings,
  savePostEmbeddings,
  type OrganizationItem,
  type PostEmbedding
} from '../db/queries'
import type { Breathe } from './organize'

/**
 * Vecteurs de sens, calculés localement.
 *
 * Le vote par mots-clés ne rapprochait que ce qui partageait un mot : « donut tutorial » et
 * « geometry nodes workflow » restaient étrangers l'un à l'autre alors qu'ils parlent de la
 * même chose. Un modèle d'embedding place les textes dans un espace où la distance est de la
 * proximité de sens — c'est ce qui rend possible à la fois un meilleur regroupement et la
 * carte, dont les coordonnées *sont* cette projection.
 *
 * Le modèle est multilingue à dessein : une bibliothèque française et anglaise mélangées est
 * la norme ici, et un modèle anglais seul manquerait la moitié des légendes.
 *
 * Rien ne sort de la machine. Le modèle est téléchargé une fois puis lu depuis le disque.
 */

/**
 * Comparé à `paraphrase-multilingual-MiniLM-L12-v2` paire par paire (`probe-models.ts`).
 *
 * Sur des moyennes, paraphrase semblait dix fois meilleur ; le détail dit l'inverse. Il
 * échoue sur la parenté de domaine, qui est précisément ce qu'on lui demande ici :
 * « Blender donut tutorial » et « geometry nodes workflow » tombent à −0,09 une fois
 * recentrés, alors que e5 les tient à +0,125 au-dessus de ses paires étrangères. e5 est un
 * modèle de recherche, entraîné à rapprocher ce qui parle du même sujet ; l'autre rapproche
 * ce qui dit la même chose autrement, ce qui n'est pas le besoin.
 *
 * Le prix à payer est un espace très tassé — tout entre 0,78 et 0,88 — que `centreVectors`
 * corrige : l'écart moyen entre paires proches et lointaines passe de 0,042 à 0,231.
 * Le recentrage n'est donc pas un raffinement, il est indispensable.
 */
const MODEL = 'Xenova/multilingual-e5-small'
/** Préfixe attendu par la famille e5, des deux côtés pour une comparaison symétrique. */
const PREFIX = 'query: '
/** Au-delà, on n'ajoute plus de sens : on ajoute du hors-sujet et du temps de calcul. */
const MAX_CHARS = 512
const BATCH = 32
const BREATHE_EVERY = 8

export interface EmbeddingProgress {
  done: number
  total: number
}

type Extractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>

let extractor: Extractor | null = null
let loading: Promise<Extractor> | null = null

/**
 * Le texte qui part au modèle, et la clé qui dit s'il a changé.
 *
 * Les tags et l'auteur comptent autant que la légende : un compte spécialisé est souvent le
 * signal le plus fiable, et c'est précisément ce que les Reels sans légende n'ont pas.
 */
export function embeddingText(item: OrganizationItem): string {
  const parts = [
    item.text?.trim(),
    item.tags.length > 0 ? item.tags.join(', ') : null,
    item.authorHandle ? `@${item.authorHandle}` : null
  ].filter(Boolean)
  return parts.join('\n').slice(0, MAX_CHARS)
}

export function embeddingHash(text: string): string {
  return createHash('sha1').update(`${MODEL} ${text}`).digest('hex').slice(0, 16)
}

/**
 * Charge le modèle, une fois. Le premier appel le télécharge — d'où l'attente annoncée à
 * l'utilisateur avant de lancer une analyse.
 */
async function load(): Promise<Extractor> {
  if (extractor) return extractor
  if (loading) return loading
  loading = (async () => {
    const { env, pipeline } = await import('@huggingface/transformers')
    // Tout vit dans le dossier de données de Magpie : rien n'est écrit à côté du binaire, et
    // désinstaller l'application emporte le modèle avec elle.
    env.cacheDir = join(app.getPath('userData'), 'models')
    env.allowLocalModels = false
    const pipe = await pipeline('feature-extraction', MODEL, { dtype: 'q8' })
    extractor = pipe as unknown as Extractor
    return extractor
  })()
  try {
    return await loading
  } finally {
    loading = null
  }
}

/** Le modèle est-il déjà sur le disque ? Sert à annoncer un téléchargement, pas à le faire. */
export function isModelLoaded(): boolean {
  return extractor !== null
}

function toBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

export function fromBuffer(buffer: Buffer): Float32Array {
  // La copie est nécessaire : le tampon de better-sqlite3 peut être réutilisé, et un
  // Float32Array qui pointerait dessus verrait ses valeurs changer sous lui.
  return new Float32Array(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  )
}

/**
 * Encode ce qui a changé, rend le reste depuis le cache.
 *
 * Comme le reste de l'analyse, cela tourne sur le processus principal : on rend donc la main
 * entre deux lots, sans quoi la fenêtre se fige pendant toute la passe.
 */
export async function embedItems(
  items: OrganizationItem[],
  breathe: Breathe,
  onProgress?: (progress: EmbeddingProgress) => void
): Promise<Map<string, Float32Array>> {
  const cached = postEmbeddings()
  const result = new Map<string, Float32Array>()
  const pending: { item: OrganizationItem; text: string; hash: string }[] = []

  for (const item of items) {
    const text = embeddingText(item)
    if (!text) continue
    const hash = embeddingHash(text)
    const known = cached.get(item.id)
    if (known && known.hash === hash) result.set(item.id, fromBuffer(known.vector))
    else pending.push({ item, text, hash })
  }

  if (pending.length === 0) return result

  const encode = await load()
  const fresh: PostEmbedding[] = []
  let done = 0
  onProgress?.({ done: 0, total: pending.length })

  for (let start = 0; start < pending.length; start += BATCH) {
    const slice = pending.slice(start, start + BATCH)
    const output = await encode(
      slice.map((entry) => `${PREFIX}${entry.text}`),
      { pooling: 'mean', normalize: true }
    )
    const width = output.dims[output.dims.length - 1]
    for (const [index, entry] of slice.entries()) {
      const vector = output.data.slice(index * width, (index + 1) * width)
      result.set(entry.item.id, vector)
      fresh.push({ postId: entry.item.id, hash: entry.hash, vector: toBuffer(vector) })
    }
    done += slice.length
    onProgress?.({ done, total: pending.length })

    // Écrit au fil de l'eau : une analyse interrompue à mi-course ne perd pas son travail.
    if (fresh.length >= 256) {
      savePostEmbeddings(fresh.splice(0, fresh.length))
    }
    if ((start / BATCH) % BREATHE_EVERY === BREATHE_EVERY - 1) await breathe()
  }
  savePostEmbeddings(fresh)
  return result
}

/**
 * Retire le centre du nuage, puis renormalise.
 *
 * Un espace d'embedding est anisotrope : tous les vecteurs se serrent dans un cône étroit, si
 * bien que deux textes sans rapport affichent déjà 0,8 de similarité. Soustraire le centre
 * étale les distances sans changer l'ordre — mesuré, l'écart entre paires proches et
 * lointaines passe de 0,042 à 0,231 — sans lui, le modèle est inutilisable pour regrouper.
 * Le centre dépend de la bibliothèque, donc il se recalcule à chaque analyse plutôt que d'être
 * figé dans le cache.
 */
export function centreVectors(vectors: Map<string, Float32Array>): Map<string, Float32Array> {
  if (vectors.size === 0) return vectors
  const width = vectors.values().next().value?.length ?? 0
  const centre = new Float32Array(width)
  for (const vector of vectors.values()) {
    for (let index = 0; index < width; index += 1) centre[index] += vector[index] / vectors.size
  }
  const out = new Map<string, Float32Array>()
  for (const [id, vector] of vectors) {
    const shifted = new Float32Array(width)
    let norm = 0
    for (let index = 0; index < width; index += 1) {
      shifted[index] = vector[index] - centre[index]
      norm += shifted[index] * shifted[index]
    }
    norm = Math.sqrt(norm) || 1
    for (let index = 0; index < width; index += 1) shifted[index] /= norm
    out.set(id, shifted)
  }
  return out
}

/** Produit scalaire de deux vecteurs déjà normalisés — donc leur similarité cosinus. */
export function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) return -1
  let total = 0
  for (let index = 0; index < left.length; index += 1) total += left[index] * right[index]
  return total
}
