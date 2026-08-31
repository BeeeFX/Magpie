import type { PostQuery } from '@shared/types'

/**
 * Ce qu'on appelle « un filtre », dit une fois.
 *
 * Le bouton « Effacer les filtres » de l'état vide appelait `resetQuery`, qui ne remet à zéro
 * que la catégorie — provenance, favoris, tags, collections. C'est délibéré de sa part : c'est
 * aussi le bouton « Tous » de la barre latérale, et changer de catégorie ne doit pas jeter la
 * recherche ni le tri. Mais il laissait donc intacts `search`, `kinds`, `untaggedOnly`, `label`
 * et `platforms` — c'est-à-dire **exactement** ce que la barre d'outils compte comme filtres
 * actifs. On cliquait, la grille restait vide, le champ gardait son texte, le badge gardait son
 * chiffre : le bouton paraissait cassé.
 *
 * Les deux fonctions vivent donc dans le même module, et c'est tout l'intérêt : le compteur du
 * badge et le bouton qui efface ne peuvent plus décrire deux ensembles différents.
 */

/** Combien de filtres sont posés. C'est ce chiffre que porte le badge du menu Filtres. */
export function activeFilterCount(query: PostQuery): number {
  return (
    query.kinds.length +
    query.platforms.length +
    (query.untaggedOnly ? 1 : 0) +
    (query.label ? 1 : 0) +
    /* La plage compte pour **un** filtre même avec ses deux bornes : c'est une seule idée
       — « gardé entre » — et le badge doit dire combien de choses restreignent la vue, pas
       combien de champs sont remplis. */
    (query.savedFrom !== null || query.savedTo !== null ? 1 : 0) +
    (query.search.trim() ? 1 : 0)
  )
}

/**
 * La même requête, sans ses filtres.
 *
 * La catégorie survit — on n'efface pas la collection qu'on regarde en effaçant un filtre de
 * type — et le tri aussi : ce n'est pas un filtre, il ne retire rien.
 */
export function clearedQuery(query: PostQuery): PostQuery {
  return {
    ...query,
    kinds: [],
    platforms: [],
    untaggedOnly: false,
    label: null,
    /* La plage part avec les filtres, pas avec la catégorie. On la pose depuis le menu
       Filtres, à côté des types et des plateformes ; la garder ferait mentir « Effacer les
       filtres » exactement comme la recherche le faisait avant. */
    savedFrom: null,
    savedTo: null,
    search: ''
  }
}

/**
 * Ce qui restreint la vue sans être un filtre : la catégorie.
 *
 * `resetQuery` la remet à zéro, `clearedQuery` la laisse — et les deux ont raison. Naviguer
 * entre Tous, Favoris, une collection et un tag ne doit pas jeter la recherche ; effacer un
 * filtre de type ne doit pas quitter la collection qu'on regarde.
 */
export function activeCategoryCount(query: PostQuery): number {
  return (
    query.sources.length +
    (query.favoritesOnly ? 1 : 0) +
    (query.archived ? 1 : 0) +
    query.tags.length +
    query.collectionIds.length
  )
}

/**
 * Pourquoi l'écran est vide, et donc quelle sortie proposer.
 *
 * L'état vide offrait « Effacer les filtres » **sans condition**. Or ce bouton appelle
 * `clearedQuery`, qui garde délibérément la catégorie. Sur une installation neuve, trois
 * secondes suffisaient à s'enfermer : cliquer sur « Favoris » dans la barre latérale, avec
 * zéro favori, donnait « Aucun signet ne correspond à ces filtres » et un bouton qui ne
 * pouvait rien. Aucun filtre n'était posé — il n'y avait rien à effacer.
 *
 * Pire, `activeFilterCount` ne compte pas non plus la catégorie, donc le menu Filtres
 * n'affichait aucun badge et son entrée « Effacer les filtres » restait désactivée. Deux
 * boutons sous les yeux, aucun capable de sortir de là ; la seule issue était « Tous » dans la
 * barre latérale, que rien ne désignait.
 *
 * On nomme donc ce qui a vidé l'écran. Les filtres d'abord quand il y en a : c'est le geste le
 * plus récent, et l'effacement peut suffire. La catégorie ensuite, avec son propre mot — une
 * collection vide et une bibliothèque vide ne se disent pas pareil.
 */
export type EmptyReason =
  | { kind: 'filters'; count: number }
  | { kind: 'category'; axis: 'favorites' | 'archived' | 'collection' | 'tag' | 'source' }
  | { kind: 'library' }

export function emptyReason(query: PostQuery): EmptyReason {
  const filters = activeFilterCount(query)
  if (filters > 0) return { kind: 'filters', count: filters }
  /* Du plus précis au plus large : une collection dit mieux ce qu'on regarde qu'une
     provenance, et c'est celle-là qu'il faut nommer. */
  if (query.collectionIds.length > 0) return { kind: 'category', axis: 'collection' }
  if (query.tags.length > 0) return { kind: 'category', axis: 'tag' }
  if (query.favoritesOnly) return { kind: 'category', axis: 'favorites' }
  if (query.archived) return { kind: 'category', axis: 'archived' }
  if (query.sources.length > 0) return { kind: 'category', axis: 'source' }
  return { kind: 'library' }
}

/**
 * Une sélection appartient à un jeu de résultats.
 *
 * Ce qui **redéfinit** le jeu la vide ; ce qui ne fait que l'étendre ou le réordonner la garde.
 * Sans cette règle, on sélectionnait quarante posts, on changeait de collection, et la barre
 * annonçait toujours « 40 sélectionnés » alors qu'aucun des quarante n'était à l'écran — et les
 * actions groupées s'appliquaient bien à ces quarante invisibles.
 *
 * Trier ne vide pas : l'ordre change, pas l'ensemble, et trier pour relire sa sélection est un
 * geste réel.
 */
export function selectionSurvives(change: 'filter' | 'sort' | 'page'): boolean {
  return change !== 'filter'
}
