import { findIslands, islandMembership, ISLAND_TUNING } from '../src/main/tagging/islands'
import { arrangeGrid, GRID_TUNING, assign } from '../src/renderer/src/map-grid'
import type { ProjectedPoint } from '../src/main/tagging/projection-core'

/**
 * Ce que les bancs ne vérifient pas : que le calcul soit juste.
 *
 * `bench:map-regions` et `bench:map-grid` mesurent une qualité sur la vraie bibliothèque, ce qui
 * demande une base et une minute de projection. Ils ne disent rien des cas limites — une région
 * vide, deux amas qu'on sait séparés, un damier plus petit que ce qu'on lui donne — et ils ne
 * peuvent pas tourner en intégration. Ce contrôle-là s'exécute en une seconde sur des amas
 * fabriqués, dont on connaît la réponse.
 */

function assertThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Échec : ${message}`)
  console.log(`  ✓ ${message}`)
}

/** Un amas rond de `count` points autour de (`x`, `y`), déterministe. */
function blob(name: string, x: number, y: number, radius: number, count: number): ProjectedPoint[] {
  const out: ProjectedPoint[] = []
  for (let i = 0; i < count; i += 1) {
    /* La spirale de Fermat : elle remplit un disque uniformément sans tirage au sort, donc le
       contrôle rend deux fois la même chose. */
    const angle = i * 2.399963
    const distance = radius * Math.sqrt((i + 0.5) / count)
    out.push({
      id: `${name}-${i}`,
      x: x + Math.cos(angle) * distance,
      y: y + Math.sin(angle) * distance
    })
  }
  return out
}

console.log('Vérification des régions et du damier')

console.log('\nrégions : deux amas nettement séparés')
const two = [...blob('gauche', 0.25, 0.5, 0.09, 300), ...blob('droite', 0.75, 0.5, 0.09, 300)]
const membership = islandMembership(two)
const found = new Set(membership.values())
assertThat(found.size === 2, `deux amas donnent deux régions (${found.size})`)
assertThat(
  membership.size === two.length,
  `tous les points sont attribués (${membership.size} sur ${two.length})`
)
const mixed = [...membership].filter(
  ([id, region]) => region !== membership.get(id.startsWith('gauche') ? 'gauche-0' : 'droite-0')
)
assertThat(mixed.length === 0, 'aucun point ne passe dans la région de l’autre amas')

console.log('\nrégions : un amas seul ne se fend pas')
const one = blob('seul', 0.5, 0.5, 0.16, 600)
assertThat(new Set(islandMembership(one).values()).size === 1, 'un amas rond reste une région')

console.log('\nrégions : le bruit isolé n’en fait pas une')
const noisy = [...blob('gros', 0.5, 0.5, 0.12, 500), ...blob('miette', 0.05, 0.05, 0.01, 4)]
const noisyRegions = new Set(islandMembership(noisy).values())
assertThat(
  noisyRegions.size === 1,
  `quatre points perdus ne forment pas une région (${noisyRegions.size})`
)

console.log('\nrégions : le nommage')
const named = findIslands(two, (id) => (id.startsWith('gauche') ? ['guitare', 'pedale'] : ['blender', 'rendu']))
assertThat(named.length === 2, 'deux régions nommées')
assertThat(
  named.every((island) => island.name.length > 0 && island.name !== 'Sans nom'),
  `les deux portent un nom (${named.map((island) => island.name).join(' / ')})`
)
assertThat(
  named.every((island) => island.x > 0 && island.x < 1 && island.y > 0 && island.y < 1),
  'les sommets tombent dans le carré unité'
)
const again = findIslands(two, (id) => (id.startsWith('gauche') ? ['guitare', 'pedale'] : ['blender', 'rendu']))
assertThat(
  JSON.stringify(again) === JSON.stringify(named),
  'deux appels sur la même carte rendent exactement la même chose'
)

console.log('\nrégions : les cas vides')
assertThat(findIslands([], () => []).length === 0, 'aucun point, aucune région')
assertThat(
  findIslands(blob('minuscule', 0.5, 0.5, 0.02, ISLAND_TUNING.minimum - 1), () => ['x']).length === 0,
  'sous le minimum, pas de région'
)

console.log('\ndamier : l’affectation exacte')
/* Une matrice dont la solution est connue : le coût est nul sur l’anti-diagonale. */
const size = 4
const cost = new Float64Array(size * size).fill(1)
for (let i = 0; i < size; i += 1) cost[i * size + (size - 1 - i)] = 0
const solved = assign(cost, size)
assertThat(
  Array.from(solved).every((column, row) => column === size - 1 - row),
  'la méthode hongroise retrouve l’anti-diagonale'
)

console.log('\ndamier : le rangement')
const items = blob('vignette', 0.5, 0.5, 0.4, 120)
const side = 12
const cells = arrangeGrid(items, side, side, GRID_TUNING)
assertThat(cells.size === items.length, 'chaque vignette a une case')
const taken = new Set([...cells.values()].map((cell) => `${cell.column}:${cell.row}`))
assertThat(taken.size === items.length, 'aucune case n’est occupée deux fois')
assertThat(
  [...cells.values()].every(
    (cell) => cell.column >= 0 && cell.column < side && cell.row >= 0 && cell.row < side
  ),
  'toutes les cases sont dans le damier'
)
const repeated = arrangeGrid(items, side, side, GRID_TUNING)
assertThat(
  [...cells].every(([id, cell]) => {
    const other = repeated.get(id)
    return other?.column === cell.column && other?.row === cell.row
  }),
  'deux rangements de la même sélection sont identiques'
)
let refused = false
try {
  arrangeGrid(items, 5, 5, GRID_TUNING)
} catch {
  refused = true
}
assertThat(refused, 'un damier trop petit est refusé plutôt que rempli à moitié')

console.log('\nTout est vert.')
