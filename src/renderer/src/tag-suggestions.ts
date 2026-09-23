import { useEffect, useState } from 'react'
import type { TagTally } from '@shared/types'
import { normalizeTagName, tagKey } from '@shared/tags'
import { magpie } from './bridge'
import { useStore } from './store'

/**
 * Les tags qui existent déjà, proposés pendant qu'on en tape un.
 *
 * Le champ était libre, sans suggestion : un tag s'écrivait de mémoire, et « voyage »,
 * « voyages » et « Voyage » finissaient en trois tags voisins que rien ne réunissait ensuite.
 * Aucun appel ne listait d'ailleurs l'ensemble des tags — la barre latérale n'en recevait que
 * quarante.
 */

/**
 * Tous les tags, chargés quand on les demande.
 *
 * `enabled` retarde l'appel jusqu'au premier usage : la vue détaillée s'ouvre et se parcourt
 * post après post, et personne ne tape de tag sur la plupart d'entre eux. La liste se relit
 * quand les statistiques changent — un tag ajouté ou retiré les fait toujours recompter.
 */
export function useAllTags(enabled: boolean): TagTally[] | null {
  const stats = useStore((state) => state.stats)
  const [tags, setTags] = useState<TagTally[] | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void magpie
      .listTags()
      .then((list) => {
        if (!cancelled) setTags(list)
      })
      /* Une suggestion manquée ne coûte rien : le champ reste libre, et c'est tout ce qu'il
         était jusqu'ici. Un avertissement pour ça serait du bruit. */
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [enabled, stats])
  return tags
}

/**
 * Ce qu'on propose pour un brouillon : ce qui commence par lui d'abord, puis ce qui le contient,
 * chaque groupe du plus porté au moins porté. Le dièse tapé ne compte pas — il sera retiré.
 *
 * Borné : un `<datalist>` de cinq mille entrées se déroulerait sur tout l'écran, et au-delà
 * d'une trentaine plus personne ne lit.
 */
export function suggestTags(
  tags: readonly { name: string; count: number }[] | null,
  draft: string,
  exclude: Iterable<string> = [],
  limit = 30
): string[] {
  if (!tags) return []
  const skip = new Set([...exclude].map(tagKey))
  const needle = normalizeTagName(draft).toLocaleLowerCase()
  const starts: string[] = []
  const contains: string[] = []
  for (const tag of tags) {
    if (skip.has(tagKey(tag.name))) continue
    const hay = tag.name.toLocaleLowerCase()
    if (!needle || hay.startsWith(needle)) starts.push(tag.name)
    else if (hay.includes(needle)) contains.push(tag.name)
    if (starts.length >= limit) break
  }
  return [...starts, ...contains].slice(0, limit)
}
