import type { AiCollectionRoute } from './types'

export interface OrganizerDestination {
  id: string
  ruleKeys: string[]
  included: boolean
}

/**
 * Attribue chaque post à sa première catégorie encore autorisée. Une catégorie fusionnée
 * expose plusieurs clés, tandis qu'une catégorie décochée n'en expose aucune. Si aucune
 * alternative ne convient, le post n'apparaît simplement dans aucune collection.
 */
export function redistributeOrganizerRoutes(
  destinations: OrganizerDestination[],
  routes: AiCollectionRoute[]
): Map<string, string[]> {
  const destinationByRule = new Map<string, string>()
  const postsByDestination = new Map<string, string[]>()

  for (const destination of destinations) {
    if (!destination.included) continue
    postsByDestination.set(destination.id, [])
    for (const ruleKey of destination.ruleKeys) destinationByRule.set(ruleKey, destination.id)
  }

  for (const route of routes) {
    const destinationId = route.rankedRuleKeys
      .map((ruleKey) => destinationByRule.get(ruleKey))
      .find((id): id is string => Boolean(id))
    if (destinationId) postsByDestination.get(destinationId)?.push(route.postId)
  }

  return postsByDestination
}
