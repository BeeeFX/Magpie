import type { AiCollectionPlan } from '@shared/types'
import { toVector } from './vision'
import type { PostImageEmbedding } from '../db/queries'

/**
 * Ce que les règles n'ont pas su classer, ses voisins d'image le savent.
 *
 * Le tri repose sur des mots : ceux de la légende, des tags, du nom de l'auteur. Un tiers de
 * la bibliothèque n'en a presque aucun — 9 % rien du tout — et ces posts-là ressortent « sans
 * catégorie » alors qu'ils montrent exactement la même chose que leurs voisins. On regarde
 * donc, pour chaque post orphelin, ce que ses plus proches voisins visuels ont reçu, et on
 * lui donne la catégorie majoritaire quand elle se dégage nettement.
 *
 * Deux garde-fous. La ressemblance doit dépasser un seuil : à faible similarité, le « plus
 * proche voisin » n'est proche de rien. Et la majorité doit être franche, sans quoi on
 * range un post dans une catégorie que ses voisins ne partagent qu'à peine — mieux vaut le
 * laisser sans catégorie, ce que l'écran sait déjà montrer.
 */

/** En deçà, deux images n'ont rien à voir : mesuré sur les résidus centrés. */
const MIN_SIMILARITY = 0.35
/** Voisins consultés. Plus large dilue le vote, plus étroit le rend anecdotique. */
const NEIGHBOURS = 12
/** Part des voisins étiquetés qui doivent s'accorder pour emporter la décision. */
const MAJORITY = 0.5

function centred(vectors: Float32Array[]): Float32Array[] {
  if (vectors.length === 0) return []
  const dims = vectors[0].length
  const mean = new Float64Array(dims)
  for (const vector of vectors) {
    for (let i = 0; i < dims; i += 1) mean[i] += vector[i] / vectors.length
  }
  return vectors.map((vector) => {
    const out = new Float32Array(dims)
    let norm = 0
    for (let i = 0; i < dims; i += 1) {
      out[i] = vector[i] - mean[i]
      norm += out[i] * out[i]
    }
    norm = Math.sqrt(norm) || 1
    for (let i = 0; i < dims; i += 1) out[i] /= norm
    return out
  })
}

export interface PropagationResult {
  plan: AiCollectionPlan
  /** Combien de posts ont trouvé une catégorie par leurs voisins d'image. */
  adopted: number
}

/**
 * Complète un plan par voisinage visuel.
 *
 * Ne retire jamais rien : un post déjà classé par une règle garde sa catégorie. La
 * propagation ne fait qu'ajouter, et seulement là où il n'y avait rien.
 */
export function propagateByImage(
  plan: AiCollectionPlan,
  images: Map<string, PostImageEmbedding>,
  candidates: string[]
): PropagationResult {
  if (plan.suggestions.length === 0 || images.size === 0) return { plan, adopted: 0 }

  const labelOf = new Map<string, string>()
  for (const suggestion of plan.suggestions) {
    for (const postId of suggestion.postIds) labelOf.set(postId, suggestion.id)
  }
  /* On ne parle que de posts illustrés : sans image, aucun voisinage visuel à consulter. */
  const known = candidates.filter((id) => images.has(id))
  if (known.length === 0) return { plan, adopted: 0 }

  /* Le sujet plutôt que le style : deux illustrations au même trait mais sur des thèmes
     éloignés ne vont pas dans la même collection. C'est aussi ce que la mesure disait — le
     bloc « sujet » pèse trois fois le bloc « structure ». */
  const block = centred(known.map((id) => toVector((images.get(id) as PostImageEmbedding).meaning)))
  const dims = block[0]?.length ?? 0
  const labelled = known
    .map((id, index) => ({ id, index, label: labelOf.get(id) }))
    .filter((entry): entry is { id: string; index: number; label: string } => Boolean(entry.label))
  if (labelled.length === 0) return { plan, adopted: 0 }

  const additions = new Map<string, string[]>()
  let adopted = 0
  known.forEach((id, index) => {
    if (labelOf.has(id)) return
    const self = block[index]
    const best: { label: string; score: number }[] = []
    for (const other of labelled) {
      let score = 0
      const w = block[other.index]
      for (let k = 0; k < dims; k += 1) score += self[k] * w[k]
      if (score < MIN_SIMILARITY) continue
      if (best.length < NEIGHBOURS) {
        best.push({ label: other.label, score })
        best.sort((a, b) => b.score - a.score)
      } else if (score > best[NEIGHBOURS - 1].score) {
        best[NEIGHBOURS - 1] = { label: other.label, score }
        best.sort((a, b) => b.score - a.score)
      }
    }
    if (best.length === 0) return
    const votes = new Map<string, number>()
    // Pondéré par la ressemblance : un voisin très proche compte plus qu'un voisin limite.
    for (const entry of best) votes.set(entry.label, (votes.get(entry.label) ?? 0) + entry.score)
    let winner = ''
    let top = 0
    let total = 0
    for (const [label, weight] of votes) {
      total += weight
      if (weight > top) {
        top = weight
        winner = label
      }
    }
    if (!winner || top / total < MAJORITY) return
    const list = additions.get(winner)
    if (list) list.push(id)
    else additions.set(winner, [id])
    adopted += 1
  })

  if (adopted === 0) return { plan, adopted: 0 }
  return {
    adopted,
    plan: {
      ...plan,
      suggestions: plan.suggestions.map((suggestion) => {
        const extra = additions.get(suggestion.id)
        if (!extra) return suggestion
        return { ...suggestion, postIds: [...suggestion.postIds, ...extra] }
      })
    }
  }
}
