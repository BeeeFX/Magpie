import { findIslands, islandMembership, ISLAND_TUNING } from '../src/main/tagging/islands'
import type { ProjectedPoint } from '../src/main/tagging/projection-core'

/**
 * Ce que les bancs ne vérifient pas : que le calcul soit juste.
 *
 * `bench:map-islands` mesure une qualité sur la vraie bibliothèque, ce qui demande une base et
 * une minute de projection. Il ne dit rien des cas limites — une région vide, deux amas qu'on
 * sait séparés — et il ne peut pas tourner en intégration. Ce contrôle-là s'exécute en une
 * seconde sur des amas
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

console.log('\nTout est vert.')
