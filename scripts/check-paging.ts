import { afterPageFailure, afterPageSuccess, shouldPrefetch } from '../src/renderer/src/paging'

/**
 * La grille ne reste pas suspendue : `npm run check:paging`
 *
 * `loadMore` était en `try/finally` sans `catch`. Un rejet d'IPC remontait à un `void
 * loadMore()` — rejet non géré, aucune trace — et laissait `hasMore` à vrai avec `loadingMore`
 * à faux. Trois symptômes, tous silencieux : le pied de grille gardait son rond qui tourne et
 * son « 300 / 9000 » pour toujours, le préchargement relançait le même appel à chaque frame de
 * défilement, et la restauration du scroll ne se terminait jamais.
 *
 * Le point qui compte, et qu'un `catch` seul n'aurait pas réglé : c'est `hasMore: false` qui
 * coupe la boucle. La propriété se dit alors en une phrase — après un échec, on ne redemande
 * plus — et c'est elle qu'on vérifie ici, sur les décisions elles-mêmes plutôt que sur le
 * store qui les applique.
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

console.log('Vérification de la pagination\n')

console.log('après un échec, la grille cesse de demander')
{
  const state = afterPageFailure()
  assert(state.hasMore === false, 'il n’y a plus de suite à réclamer')
  assert(state.loadingMore === false, 'et plus rien en vol')
  assert(
    !shouldPrefetch(state, false, 0, 0, 900),
    'le préchargement refuse, même sur une grille plus courte que la fenêtre'
  )
  assert(
    !shouldPrefetch(state, false, 0, 5000, 900),
    'et il refuse aussi au fil du défilement — c’est là que la boucle repartait'
  )
}

console.log('\naprès une page reçue, elle demande la suite quand il en reste')
{
  const middle = afterPageSuccess(300, 9000)
  assert(middle.hasMore, 'trois cents sur neuf mille : il en reste')
  assert(shouldPrefetch(middle, false, 400, 0, 900), 'une grille plus courte que trois écrans précharge')
  assert(!shouldPrefetch(middle, false, 9000, 0, 900), 'une grille assez longue attend le défilement')
  assert(!shouldPrefetch(middle, true, 400, 0, 900), 'et rien ne part pendant un rafraîchissement')

  const last = afterPageSuccess(9000, 9000)
  assert(!last.hasMore, 'la dernière page ferme la pagination')
  assert(!shouldPrefetch(last, false, 0, 0, 900), 'et plus rien n’est demandé ensuite')
}

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} échec(s).`)
process.exitCode = failures === 0 ? 0 : 1
