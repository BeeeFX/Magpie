import { performance } from 'node:perf_hooks'
import type { VideoOrganizationItem } from '../src/main/db/queries'
import {
  buildLocalCollectionPlan,
  extractLocalVisualFeature,
  resolveLocalThumbnailPath
} from '../src/main/tagging/organize'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Échec : ${message}`)
  console.log(`  ✓ ${message}`)
}

function item(
  id: string,
  text: string | null,
  authorHandle: string | null = null,
  tags: string[] = []
): VideoOrganizationItem {
  return { id, platform: 'instagram', text, authorHandle, thumbPath: null, tags }
}

async function main(): Promise<void> {
console.log('Vérification de l’organisateur local')

const visual = await extractLocalVisualFeature('build/icon.png')
assert(visual !== null && visual.length > 100, 'une vignette produit une signature visuelle locale')
assert(
  resolveLocalThumbnailPath('thumbnail.webp', 'D:\\Magpie\\media') ===
    'D:\\Magpie\\media\\thumbnail.webp',
  'un nom de vignette stocké en base est résolu dans le dossier média'
)

const sample: VideoOrganizationItem[] = [
  item('g1', 'A new guitar riff and pedalboard setup', 'strings'),
  item('g2', 'Guitar lesson: unusual jazz chords', 'strings'),
  item('g3', '#guitartok fingerstyle practice', 'strings'),
  item('g4', null, 'strings'),
  item('s1', 'Skateboarding kickflip tutorial', 'wheels'),
  item('s2', 'Perfect skate line and a long grind', 'wheels'),
  item('s3', '#skateboard street session', 'wheels'),
  item('d1', 'DJ set on CDJs with Rekordbox', 'club'),
  item('d2', 'A smooth DJ mix from the club', 'club'),
  item('d3', '#deejay turntable routine', 'club'),
  item('b1', 'Blender geometry nodes material tutorial', 'render'),
  item('b2', '#b3d procedural rendering study', 'render'),
  item('b3', 'Cinema4D and Blender 3D workflow', 'render'),
  item('u1', null, 'unknown')
]

const plan = buildLocalCollectionPlan(sample, new Map(), 'en')
const names = new Set(plan.suggestions.map((suggestion) => suggestion.name))
assert(names.has('Guitar'), 'la guitare est reconnue')
assert(names.has('Skateboarding'), 'le skateboard est reconnu')
assert(names.has('DJ & mixing'), 'les contenus DJ sont reconnus')
assert(names.has('3D & Blender'), 'les contenus 3D sont reconnus')
assert(
  plan.suggestions.find((suggestion) => suggestion.name === '3D & Blender')?.ruleKeys.includes('3d'),
  'chaque catégorie conserve une règle stable pour les prochaines synchronisations'
)
assert(
  plan.suggestions.find((suggestion) => suggestion.name === 'Guitar')?.postIds.includes('g4'),
  'une vidéo sans légende hérite du thème fiable de son créateur'
)
assert(plan.unassignedVideos === 1, 'un contenu sans signal reste prudemment sans catégorie')
assert(
  new Set(plan.suggestions.flatMap((suggestion) => suggestion.postIds)).size ===
    plan.suggestions.flatMap((suggestion) => suggestion.postIds).length,
  'une vidéo ne figure jamais dans deux catégories proposées'
)

const large: VideoOrganizationItem[] = Array.from({ length: 10_000 }, (_, index) => {
  const kind = index % 4
  if (kind === 0) return item(`large-${index}`, 'guitar riff music lesson', `artist-${index % 200}`)
  if (kind === 1) return item(`large-${index}`, 'skateboard kickflip street skate', `artist-${index % 200}`)
  if (kind === 2) return item(`large-${index}`, 'blender3d geometry nodes render', `artist-${index % 200}`)
  return item(`large-${index}`, 'DJ mix rekordbox turntable', `artist-${index % 200}`)
})
const started = performance.now()
const largePlan = buildLocalCollectionPlan(large, new Map(), 'fr')
const elapsed = performance.now() - started
assert(largePlan.analysedVideos === 10_000, 'les 10 000 vidéos sont prises en compte')
assert(largePlan.unassignedVideos === 0, 'les signaux nets sont tous classés')
assert(elapsed < 5_000, `le regroupement de 10 000 vidéos reste rapide (${Math.round(elapsed)} ms)`)

console.log('\nTout est vert.')
}

void main()
