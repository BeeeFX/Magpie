import type { Platform } from '@shared/types'
import type { PostInput } from '../db/queries'
import { markTagged, pendingRuleTagging, setTags } from '../db/queries'

/**
 * Étage gratuit du tagging automatique — voir SPEC.md §8.1.
 *
 * Aucun modèle, aucun réseau : hashtags de la légende, subreddit, domaine d'un lien
 * partagé. C'est ce qui fait qu'une bibliothèque fraîchement rapatriée n'arrive pas
 * complètement nue, en attendant l'étage Claude.
 *
 * Vit ici plutôt que dans le chargeur de fixture, où il était enfermé : les vrais signets
 * en ont bien plus besoin que les faux.
 */

/** Hashtags trop génériques pour aider à retrouver quoi que ce soit. */
const IGNORED = new Set([
  'reels',
  'reel',
  'explore',
  'explorepage',
  'viral',
  'fyp',
  'foryou',
  'instagram',
  'instagood',
  'follow',
  'like',
  'likes',
  'love'
])

const MAX_TAGS_PER_POST = 8

function subredditOf(post: PostInput): string | null {
  const match = /^\[r\/([^\]]+)\]/.exec(post.text ?? '')
  if (match) return match[1]
  // Le nom de la communauté est rangé dans `authorName` par l'adaptateur Reddit.
  return post.authorName?.startsWith('r/') ? post.authorName.slice(2) : null
}

function linkDomain(post: PostInput): string | null {
  if (post.kind !== 'link') return null
  const match = /https?:\/\/([^/\s]+)/.exec(post.text ?? '')
  if (!match) return null
  return match[1].replace(/^www\./, '')
}

export function ruleTagsFor(post: PostInput): string[] {
  const tags = new Set<string>()

  for (const match of (post.text ?? '').matchAll(/#(\p{L}[\p{L}\p{N}_]{1,29})/gu)) {
    const tag = match[1].toLowerCase()
    if (!IGNORED.has(tag)) tags.add(tag)
  }

  const subreddit = subredditOf(post)
  if (subreddit) tags.add(subreddit.toLowerCase())

  const domain = linkDomain(post)
  if (domain) tags.add(domain.toLowerCase())

  // Un post couvert de hashtags n'apporte plus d'information passé une poignée : on garde
  // les premiers, qui sont presque toujours les plus spécifiques.
  return [...tags].slice(0, MAX_TAGS_PER_POST)
}

/** Applique les règles à un lot fraîchement ingéré. */
export function applyRuleTags(posts: PostInput[]): number {
  let tagged = 0
  for (const post of posts) {
    const tags = ruleTagsFor(post)
    if (tags.length > 0) {
      setTags(
        post.id,
        tags.map((name) => ({ name, source: 'rule' as const }))
      )
      tagged++
    }
  }
  // Marqué même sans résultat : « traité, rien trouvé » n'est pas « à traiter ».
  markTagged(posts.map((post) => post.id))
  return tagged
}

/**
 * Rattrape les posts entrés en base avant que les règles ne soient branchées sur le sync.
 * Ne touche que ceux marqués « pending », donc jamais un post dont l'utilisateur a retiré
 * les tags à la main.
 */
export function backfillRuleTags(): { posts: number; tagged: number } {
  const posts = pendingRuleTagging()
  if (posts.length === 0) return { posts: 0, tagged: 0 }
  return { posts: posts.length, tagged: applyRuleTags(posts) }
}

export type { Platform }
