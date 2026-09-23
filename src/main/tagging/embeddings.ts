import { createHash } from 'node:crypto'
import {
  postEmbeddings,
  savePostEmbeddings,
  type OrganizationItem,
  type PostEmbedding
} from '../db/queries'
import { embedBatch } from './inference'
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
/** Au-delà, on n'ajoute plus de sens : on ajoute du hors-sujet et du temps de calcul. */
const MAX_CHARS = 512
const BATCH = 32

export interface EmbeddingProgress {
  done: number
  total: number
}

/**
 * Ce que la parole reçoit toujours, quand il y en a et qu'il reste la place.
 *
 * Une trentaine de mots : assez pour que « aujourd'hui je vous montre comment… » atteigne le
 * sujet, pas assez pour noyer une légende de douze mots — la médiane de la bibliothèque de
 * référence.
 */
const TRANSCRIPT_FLOOR = 160
/**
 * En deçà, une légende n'est pas de la prose, et la parole prend toute la place qui reste.
 *
 * Le même seuil que §8.3 : un tiers de la bibliothèque tient sous vingt-cinq lettres une fois
 * liens, emojis et arobases retirés — « wait for it 😂 », un lien, un handle. Il n'y a rien là
 * que la transcription puisse évincer.
 */
const PROSE_LETTERS = 25
/** Et en deçà, un bout de transcription n'est plus une phrase : on ne le glisse pas. */
const TRANSCRIPT_MIN = 48

/** Coupe au dernier espace plutôt qu'au milieu d'un mot, qui deviendrait un jeton inventé. */
function clipAtWord(value: string, room: number): string {
  if (value.length <= room) return value
  const cut = value.slice(0, room)
  const space = cut.lastIndexOf(' ')
  return (space > room * 0.6 ? cut.slice(0, space) : cut).trim()
}

/**
 * Le texte qui part au modèle, et la clé qui dit s'il a changé.
 *
 * Les tags et l'auteur comptent autant que la légende : un compte spécialisé est souvent le
 * signal le plus fiable, et c'est précisément ce que les Reels sans légende n'ont pas.
 *
 * **La transcription entre ici, et nulle part ailleurs dans le regroupement.** Elle était
 * annoncée comme une entrée du regroupement — §8.4, l'en-tête de `transcribe.ts` — sans
 * qu'aucune ligne ne la lise : `organizationItems` ne la sélectionnait même pas, et chaque
 * vidéo écoutée ne servait qu'à la recherche plein texte et à l'export. Elle vient après la
 * légende, dans le budget de `MAX_CHARS`, et c'est la légende qui garde la main : courte,
 * écrite par l'auteur, elle nomme le sujet plus sûrement qu'une parole reconnue par Whisper.
 * Le vecteur est une moyenne sur les jetons — un monologue de quatre cents caractères derrière
 * douze mots précis ferait de ces douze mots une note de bas de page. D'où le partage :
 *
 *   - la légende, les tags et l'auteur passent d'abord, tels qu'avant ;
 *   - une légende qui n'est pas de la prose (moins de `PROSE_LETTERS` lettres) ne se laisse pas
 *     évincer : la parole prend toute la place restante ;
 *   - sinon, la parole ne pèse pas plus que ce qui est écrit, avec `TRANSCRIPT_FLOOR` d'office
 *     pour qu'une légende de trois mots ne la réduise pas au silence.
 *
 * Un post sans transcription rend **exactement** le texte d'avant, donc la même empreinte :
 * seuls les posts qui ont effectivement une transcription repassent par le modèle, une fois —
 * 5,3 ms chacun avec e5-small (§8.2), une vingtaine de secondes pour quatre mille vidéos.
 *
 * Ce que ce réencodage ne fait **pas** : déplacer un point de la carte figée. `post_positions`
 * rend sa place à tout post qui en a une, quel que soit son vecteur (`placeAgainstFrozen`), et
 * l'empreinte de la carte ne porte que les réglages de projection. Un post transcrit reste donc
 * là où sa légende l'avait posé ; sa catégorie, elle, suit le nouveau vecteur dès l'analyse
 * suivante. Seuls les posts arrivés après, qui se posent contre leurs voisins, et une carte
 * refaite (« Refaire la carte », ou plus d'un quart de posts nouveaux) montrent la parole.
 *
 * Pourquoi pas dans les mots (`prepareTerms`, les noms de régions) : les catégories et les
 * étiquettes de la carte comptent des mots, et Whisper en produit de mauvais — un « Ableton »
 * entendu « able ton », les « gonna », « guys », « okay » d'une parole ordinaire, qu'aucune liste
 * de mots vides n'a été réglée pour écarter. Un mot faux devient un *nom* affiché, sûr de lui ; le
 * même mot dans un vecteur moyenné sur cinquante jetons ne le déplace qu'à peine.
 */
export function embeddingText(item: OrganizationItem): string {
  /* Les liens ne disent rien du sujet et occupent la place : sur cette bibliothèque, une
     légende sur dix se réduit à un `t.co` et un handle. Les retirer ne fait perdre aucun
     sens et laisse le modèle lire le reste. */
  const text = item.text?.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim()
  /* Le handle porte souvent déjà son arobase — 7 444 sur 9 751 ici, tous côté X. On en
     ajoutait un second, si bien que le même signal s'écrivait `@@nom` sur une plateforme et
     `@nom` sur l'autre : deux jetons différents pour la même chose. */
  const handle = item.authorHandle?.replace(/^@+/, '')
  const tags = item.tags.length > 0 ? item.tags.join(', ') : null
  const written = [text, tags].filter(Boolean).join('\n')
  const spoken = item.transcript?.replace(/\s+/g, ' ').trim()
  let heard: string | null = null
  if (spoken) {
    const fixed = [written, handle ? `@${handle}` : null].filter(Boolean).join('\n')
    // Un séparateur de plus : la parole s'insère entre la légende et le reste.
    const room = MAX_CHARS - fixed.length - (fixed ? 1 : 0)
    const prose = (written.match(/[\p{L}\p{N}]/gu) ?? []).length >= PROSE_LETTERS
    const share = prose ? Math.min(room, Math.max(TRANSCRIPT_FLOOR, written.length)) : room
    if (share >= TRANSCRIPT_MIN) heard = clipAtWord(spoken, share)
  }
  const parts = [text, heard, tags, handle ? `@${handle}` : null].filter(Boolean)
  return parts.join('\n').slice(0, MAX_CHARS)
}

export function embeddingHash(text: string): string {
  return createHash('sha1').update(`${MODEL} ${text}`).digest('hex').slice(0, 16)
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
 * Combien de fois des vecteurs de texte ont été réécrits depuis le lancement.
 *
 * Le cache des blocs de `prototypes.ts` ne se refaisait que lorsque le **nombre** de vecteurs
 * changeait. Un post réencodé — sa transcription vient d'arriver, sa légende a été corrigée —
 * n'en change aucun : les collections continuaient de noter la bibliothèque sur l'ancien
 * vecteur jusqu'au redémarrage. Ce compteur est le signal qui manquait.
 */
let written = 0

export function textVectorsRevision(): number {
  return written
}

function store(rows: PostEmbedding[]): void {
  if (rows.length === 0) return
  savePostEmbeddings(rows)
  written += 1
}

/**
 * Encode ce qui a changé, rend le reste depuis le cache.
 *
 * Le calcul lui-même a quitté le processus principal — voir `inference.ts` — mais le tour de
 * boucle qui l'entoure, lui, y reste : la lecture du cache, l'écriture des vecteurs, le
 * découpage en lots. On rend donc toujours la main entre deux lots.
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

  const fresh: PostEmbedding[] = []
  let done = 0
  onProgress?.({ done: 0, total: pending.length })

  for (let start = 0; start < pending.length; start += BATCH) {
    const slice = pending.slice(start, start + BATCH)
    const vectors = await embedBatch(slice.map((entry) => entry.text))
    for (const [index, entry] of slice.entries()) {
      const vector = vectors[index]
      result.set(entry.item.id, vector)
      fresh.push({ postId: entry.item.id, hash: entry.hash, vector: toBuffer(vector) })
    }
    done += slice.length
    onProgress?.({ done, total: pending.length })

    // Écrit au fil de l'eau : une analyse interrompue à mi-course ne perd pas son travail.
    if (fresh.length >= 256) {
      store(fresh.splice(0, fresh.length))
    }
    /* Une respiration par lot, contre une sur huit auparavant : l'encodage attend désormais
       un autre processus, mais l'écriture en base et le découpage, eux, sont bien ici. */
    await breathe()
  }
  store(fresh)
  return result
}

/** Encode des textes libres, sans passer par le cache — sert aux descripteurs de thème. */
export function embedTexts(texts: string[]): Promise<Float32Array[]> {
  return embedBatch(texts)
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
