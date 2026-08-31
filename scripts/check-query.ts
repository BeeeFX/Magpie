import { BULK_MAX, DEFAULT_QUERY, type PostQuery } from '../src/shared/types'
import {
  activeCategoryCount,
  activeFilterCount,
  clearedQuery,
  emptyReason,
  selectionSurvives
} from '../src/renderer/src/query'
import { chunk } from '../src/renderer/src/selection'

/**
 * Les filtres et la sélection disent la vérité : `npm run check:query`
 *
 * Deux défauts livrés, énoncés ici comme des propriétés.
 *
 * **« Effacer les filtres » n'effaçait pas les filtres.** Le bouton appelait `resetQuery`, qui
 * ne remet à zéro que la catégorie — c'est délibéré, il sert aussi de bouton « Tous ». Il
 * laissait donc `search`, `kinds`, `untaggedOnly`, `label` et `platforms`, c'est-à-dire
 * exactement ce que la barre d'outils compte comme filtres actifs. La grille restait vide, le
 * badge gardait son chiffre. La propriété qui l'interdit tient en une ligne : effacer met le
 * compteur à zéro, quelle que soit la requête de départ.
 *
 * **La sélection mentait sur son périmètre.** Elle survivait à un changement de filtre — quarante
 * posts sélectionnés, on change de collection, la barre annonce toujours quarante et les actions
 * s'appliquent à quarante invisibles — et « Tout » ne prenait que la tranche chargée. Le
 * découpage qui l'accompagne ne doit ni perdre ni dupliquer un identifiant, et ne jamais
 * dépasser le plafond que le processus principal impose.
 */

let failures = 0
function assert(condition: unknown, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${message}`)
}

/** Des requêtes tordues, pour que la propriété ne tienne pas par hasard sur un seul cas. */
const QUERIES: PostQuery[] = [
  DEFAULT_QUERY,
  { ...DEFAULT_QUERY, kinds: ['video'] },
  { ...DEFAULT_QUERY, search: 'blender', untaggedOnly: true },
  { ...DEFAULT_QUERY, label: 'red', platforms: ['instagram'] },
  {
    ...DEFAULT_QUERY,
    kinds: ['image', 'video'],
    platforms: ['instagram', 'x'],
    untaggedOnly: true,
    label: 'blue',
    search: '  des espaces  ',
    tags: ['b3d'],
    collectionIds: [3],
    favoritesOnly: true,
    sort: 'random',
    randomSeed: 42
  }
]

console.log('Vérification des filtres et de la sélection\n')

console.log('effacer les filtres les efface')
assert(
  QUERIES.every((query) => activeFilterCount(clearedQuery(query)) === 0),
  'après effacement, aucun filtre n’est plus compté'
)
assert(
  QUERIES.every((query) => {
    const cleared = clearedQuery(query)
    return cleared.sort === query.sort && cleared.randomSeed === query.randomSeed
  }),
  'le tri n’est pas un filtre et survit'
)
assert(
  QUERIES.every((query) => {
    const cleared = clearedQuery(query)
    return (
      cleared.tags.length === query.tags.length &&
      cleared.collectionIds.length === query.collectionIds.length &&
      cleared.favoritesOnly === query.favoritesOnly
    )
  }),
  'la catégorie regardée non plus — on n’efface pas la collection ouverte'
)
assert(
  activeFilterCount({ ...DEFAULT_QUERY, search: '   ' }) === 0,
  'une recherche de blancs ne compte pas comme un filtre'
)

console.log('\nune sélection appartient à un jeu de résultats')
assert(!selectionSurvives('filter'), 'changer de filtre la vide')
assert(selectionSurvives('sort'), 'changer de tri la garde : l’ordre change, pas l’ensemble')
assert(selectionSurvives('page'), 'charger la suite la garde aussi')

console.log('\nle découpage ne perd rien')
{
  const ids = Array.from({ length: BULK_MAX * 2 + 137 }, (_, i) => `p${i}`)
  const slices = chunk(ids)
  assert(slices.flat().length === ids.length, `${ids.length} identifiants, aucun perdu`)
  assert(new Set(slices.flat()).size === ids.length, 'et aucun dupliqué')
  assert(slices.every((slice) => slice.length <= BULK_MAX), 'aucune tranche ne dépasse le plafond')
  assert(slices.flat().join() === ids.join(), 'l’ordre est conservé')
  assert(chunk([]).length === 0, 'une sélection vide ne produit aucun envoi')
}

console.log('\nla plage de dates est un filtre, pas une catégorie')
{
  /* On la pose depuis le menu Filtres, à côté des types et des plateformes : la garder à
     travers « Effacer les filtres » ferait mentir ce bouton exactement comme la recherche le
     faisait avant lui. */
  const ranged = { ...DEFAULT_QUERY, savedFrom: 1_700_000_000_000, savedTo: 1_800_000_000_000 }
  assert(activeFilterCount(ranged) === 1, 'ses deux bornes comptent pour un seul filtre')
  assert(
    activeFilterCount(clearedQuery(ranged)) === 0,
    'et « Effacer les filtres » les emporte'
  )
  assert(
    clearedQuery(ranged).savedFrom === null && clearedQuery(ranged).savedTo === null,
    'les deux bornes, pas seulement l’une'
  )
  assert(
    activeFilterCount({ ...DEFAULT_QUERY, savedFrom: 1_700_000_000_000 }) === 1,
    'une seule borne suffit à compter'
  )
  assert(
    emptyReason(ranged).kind === 'filters',
    'un écran vide sous une plage parle de filtres, et l’effacement peut donc en sortir'
  )
}

console.log('\nl’écran vide nomme ce qui l’a vidé')
{
  /* Le défaut, énoncé comme propriété : un écran vide sans aucun filtre posé ne doit **jamais**
     proposer d'effacer les filtres, puisque `clearedQuery` garde la catégorie et qu'il n'y a
     donc rien à effacer. Sur une installation neuve, cliquer sur « Favoris » avec zéro favori
     donnait exactement cela — un message sur les filtres et un bouton incapable d'en sortir. */
  assert(
    emptyReason({ ...DEFAULT_QUERY, favoritesOnly: true }).kind === 'category',
    'des favoris vides sont une catégorie, pas un filtre trop strict'
  )
  assert(
    emptyReason({ ...DEFAULT_QUERY, collectionIds: [3] }).kind === 'category',
    'une collection vide aussi'
  )
  assert(
    emptyReason({ ...DEFAULT_QUERY, tags: ['blender'] }).kind === 'category',
    'un tag sans post aussi'
  )
  assert(
    emptyReason({ ...DEFAULT_QUERY, sources: ['liked'] }).kind === 'category',
    'une provenance vide aussi'
  )
  assert(emptyReason(DEFAULT_QUERY).kind === 'library', 'sans rien de posé, c’est la bibliothèque')

  /* La propriété qui lie les deux fonctions : là où l'écran parle de filtres, effacer les
     filtres change vraiment quelque chose. */
  const withFilters = { ...DEFAULT_QUERY, favoritesOnly: true, untaggedOnly: true, search: 'x' }
  const reason = emptyReason(withFilters)
  assert(reason.kind === 'filters', 'un filtre posé passe avant la catégorie : c’est le geste récent')
  assert(
    activeFilterCount(clearedQuery(withFilters)) === 0,
    'et l’effacer mène bien à zéro filtre'
  )
  /* Puis, une fois les filtres levés, l'écran bascule sur la catégorie et propose l'autre
     sortie. C'est la progression qui manquait : deux boutons morts au lieu d'un chemin. */
  assert(
    emptyReason(clearedQuery(withFilters)).kind === 'category',
    'et l’écran nomme alors la catégorie, qui est la sortie suivante'
  )

  /* Une catégorie ne se compte pas comme un filtre : c'est ce qui garde le badge honnête. */
  assert(
    activeFilterCount({ ...DEFAULT_QUERY, favoritesOnly: true, collectionIds: [1] }) === 0,
    'la catégorie ne gonfle pas le badge du menu Filtres'
  )
  assert(
    activeCategoryCount({ ...DEFAULT_QUERY, favoritesOnly: true, collectionIds: [1] }) === 2,
    'elle se compte à part'
  )
}

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} échec(s).`)
process.exitCode = failures === 0 ? 0 : 1
