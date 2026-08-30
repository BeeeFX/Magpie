import { BULK_MAX, DEFAULT_QUERY, type PostQuery } from '../src/shared/types'
import { activeFilterCount, clearedQuery, selectionSurvives } from '../src/renderer/src/query'
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

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} échec(s).`)
process.exitCode = failures === 0 ? 0 : 1
