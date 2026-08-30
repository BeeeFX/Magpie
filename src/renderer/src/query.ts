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
    search: ''
  }
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
