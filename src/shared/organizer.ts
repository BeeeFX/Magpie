import type { AiCollectionRoute } from './types'

export interface OrganizerDestination {
  id: string
  ruleKeys: string[]
  included: boolean
  /**
   * Posts rattachés explicitement, hors de tout raisonnement par règle.
   *
   * C'est ce que produit un contour tracé à la main sur la carte : l'utilisateur a désigné
   * ces posts-là, aucune règle ne les décrit, et aucune route ne doit pouvoir les reprendre.
   * Sans cela, un groupe dessiné au lasso affichait « 0 posts » — il n'existait pour personne.
   */
  postIds?: string[]
}

/**
 * Attribue chaque post à sa première catégorie encore autorisée. Une catégorie fusionnée
 * expose plusieurs clés, tandis qu'une catégorie décochée n'en expose aucune. Si aucune
 * alternative ne convient, le post n'apparaît simplement dans aucune collection.
 *
 * Un post explicitement rattaché l'emporte toujours sur une route : le geste de
 * l'utilisateur passe avant la déduction de l'algorithme.
 */
export function redistributeOrganizerRoutes(
  destinations: OrganizerDestination[],
  routes: AiCollectionRoute[]
): Map<string, string[]> {
  const destinationByRule = new Map<string, string>()
  const postsByDestination = new Map<string, string[]>()
  const claimed = new Set<string>()

  for (const destination of destinations) {
    if (!destination.included) continue
    postsByDestination.set(destination.id, [])
    for (const ruleKey of destination.ruleKeys) destinationByRule.set(ruleKey, destination.id)
  }

  // Les rattachements manuels d'abord : ils réservent leurs posts avant tout arbitrage.
  for (const destination of destinations) {
    if (!destination.included || !destination.postIds) continue
    const list = postsByDestination.get(destination.id)
    if (!list) continue
    for (const postId of destination.postIds) {
      if (claimed.has(postId)) continue
      claimed.add(postId)
      list.push(postId)
    }
  }

  for (const route of routes) {
    if (claimed.has(route.postId)) continue
    const destinationId = route.rankedRuleKeys
      .map((ruleKey) => destinationByRule.get(ruleKey))
      .find((id): id is string => Boolean(id))
    if (destinationId) postsByDestination.get(destinationId)?.push(route.postId)
  }

  return postsByDestination
}
