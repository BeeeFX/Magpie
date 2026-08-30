/**
 * Ce qu'une page réussie ou manquée laisse derrière elle.
 *
 * Sorti du store parce que c'est là qu'était le défaut, et qu'un défaut de décision se vérifie
 * mieux qu'il ne se relit. `loadMore` était en `try/finally` sans `catch` : un rejet d'IPC
 * remontait à un `void loadMore()`, personne ne le voyait, `hasMore` restait vrai et
 * `loadingMore` retombait à faux. Trois conséquences, toutes silencieuses — le pied de grille
 * gardait son rond qui tourne pour toujours, le préchargement relançait l'appel à chaque frame
 * de défilement, et la restauration du scroll ne se terminait jamais.
 *
 * Ce qui coupe la boucle n'est pas le `catch` : c'est `hasMore: false`. Un `catch` qui se
 * contenterait de notifier laisserait la grille rappeler indéfiniment.
 */

export interface PageState {
  hasMore: boolean
  loadingMore: boolean
}

/** Après un échec : on cesse de demander, et on rend la décision à l'utilisateur. */
export function afterPageFailure(): PageState {
  return { hasMore: false, loadingMore: false }
}

/** Après une page reçue : il en reste si l'offset n'a pas rattrapé le total. */
export function afterPageSuccess(nextOffset: number, total: number): PageState {
  return { hasMore: nextOffset < total, loadingMore: false }
}

/**
 * Faut-il demander la suite ?
 *
 * La grille appelle ceci à chaque défilement et à chaque changement de disposition. Après un
 * échec, la réponse doit être non — sinon la boucle repart, et c'est exactement ce qui se
 * produisait.
 */
export function shouldPrefetch(
  state: PageState,
  loading: boolean,
  totalHeight: number,
  scroll: number,
  viewportHeight: number
): boolean {
  if (loading || state.loadingMore || !state.hasMore) return false
  return totalHeight < scroll + viewportHeight * 3
}
