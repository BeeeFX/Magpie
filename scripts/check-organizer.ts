import { performance } from 'node:perf_hooks'
import type { VideoOrganizationItem } from '../src/main/db/queries'
import { redistributeOrganizerRoutes } from '../src/shared/organizer'
import {
  buildLocalCollectionPlan,
  extractLocalVisualFeature,
  rememberedOrganizerDestinations,
  resolveLocalThumbnailPath,
  withoutRemovedPosts
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
  item('a1', 'ComfyUI workflow for generative AI images', 'latent'),
  item('a2', 'Stable Diffusion ControlNet experiment', 'latent'),
  item('a3', '#aiart made with Flux and LoRA', 'latent'),
  item('l1', 'Blender tutorial explained for beginners'),
  item('l2', 'Generative AI tutorial explained with ComfyUI'),
  item('l3', 'Guitar tutorial explained step by step'),
  item('l4', 'Tutorial explained for beginners'),
  item('u1', null, 'unknown')
]

const plan = await buildLocalCollectionPlan(sample, new Map(), 'en')
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

const learning = plan.suggestions.find((suggestion) => suggestion.name === 'Learning & ideas')
assert(Boolean(learning), 'la catégorie transversale apprentissage est proposée')
const redistributed = redistributeOrganizerRoutes(
  plan.suggestions.map((suggestion) => ({
    id: suggestion.id,
    ruleKeys: suggestion.ruleKeys,
    included: suggestion.id !== learning?.id
  })),
  plan.routes
)
const suggestionById = new Map(plan.suggestions.map((suggestion) => [suggestion.id, suggestion]))
const postsFor = (name: string): string[] => {
  const destination = plan.suggestions.find((suggestion) => suggestion.name === name)
  return destination ? redistributed.get(destination.id) ?? [] : []
}
assert(postsFor('3D & Blender').includes('l1'), 'un tutoriel Blender quitte apprentissage pour rejoindre la 3D')
assert(postsFor('Generative AI').includes('l2'), 'un tutoriel IA rejoint la catégorie IA générative')
assert(postsFor('Guitar').includes('l3'), 'un tutoriel musical rejoint la guitare')
assert(
  ![...redistributed.values()].some((postIds) => postIds.includes('l4')),
  'sans alternative fiable, une vidéo reste simplement sans collection'
)
assert(
  [...redistributed].every(([id]) => suggestionById.has(id)),
  'la redistribution ne crée aucune catégorie de secours'
)

const rememberedRules = plan.suggestions.flatMap((suggestion, index) =>
  suggestion.ruleKeys.map((ruleKey) => ({
    ruleKey,
    collectionId: suggestion.id === learning?.id ? null : index + 1,
    ignored: suggestion.id === learning?.id
  }))
)
const rememberedDestinations = rememberedOrganizerDestinations(plan.routes, rememberedRules)
const collectionIdFor = (name: string): number | undefined => {
  const index = plan.suggestions.findIndex((suggestion) => suggestion.name === name)
  return index < 0 ? undefined : index + 1
}
assert(
  rememberedDestinations.get(collectionIdFor('3D & Blender') ?? -1)?.includes('l1'),
  'la redistribution mémorisée envoie aussi les nouveaux tutoriels Blender vers la 3D'
)
assert(
  ![...rememberedDestinations.values()].some((postIds) => postIds.includes('l4')),
  'la redistribution automatique ne force pas les nouveaux contenus ambigus'
)

// Le classement automatique repart des mêmes signaux à chaque synchronisation. Sans mémoire
// des retraits, il remettait le post exactement là où l'utilisateur venait de l'enlever.
const threeD = collectionIdFor('3D & Blender') ?? -1
const afterRemoval = rememberedOrganizerDestinations(
  plan.routes,
  rememberedRules,
  new Map([[threeD, new Set(['l1'])]])
)
assert(
  !afterRemoval.get(threeD)?.includes('l1'),
  'un post retiré à la main ne retourne pas dans sa collection au sync suivant'
)
assert(
  ![...afterRemoval.values()].some((postIds) => postIds.includes('l1')),
  'il n’est pas non plus reversé dans la destination suivante'
)
assert(
  (afterRemoval.get(threeD)?.length ?? 0) > 0,
  'les autres vidéos de la collection continuent d’être classées'
)

const large: VideoOrganizationItem[] = Array.from({ length: 10_000 }, (_, index) => {
  const kind = index % 4
  if (kind === 0) return item(`large-${index}`, 'guitar riff music lesson', `artist-${index % 200}`)
  if (kind === 1) return item(`large-${index}`, 'skateboard kickflip street skate', `artist-${index % 200}`)
  if (kind === 2) return item(`large-${index}`, 'blender3d geometry nodes render', `artist-${index % 200}`)
  return item(`large-${index}`, 'DJ mix rekordbox turntable', `artist-${index % 200}`)
})
const started = performance.now()
const largePlan = await buildLocalCollectionPlan(large, new Map(), 'fr')
const elapsed = performance.now() - started
assert(largePlan.analysedVideos === 10_000, 'les 10 000 vidéos sont prises en compte')
assert(largePlan.unassignedVideos === 0, 'les signaux nets sont tous classés')
assert(elapsed < 5_000, `le regroupement de 10 000 vidéos reste rapide (${Math.round(elapsed)} ms)`)

/*
 * Le regroupement tourne sur le processus principal. Découpé, il doit rendre la main
 * régulièrement — sinon la fenêtre reste figée après chaque synchronisation. On mesure donc
 * le plus long créneau pendant lequel la boucle d'événements n'a pas pu tourner.
 */
let longestBlock = 0
let lastTick = performance.now()
const heartbeat = setInterval(() => {
  longestBlock = Math.max(longestBlock, performance.now() - lastTick)
  lastTick = performance.now()
}, 10)
await buildLocalCollectionPlan(large, new Map(), 'fr', () =>
  new Promise<void>((resolve) => setImmediate(resolve))
)
clearInterval(heartbeat)
assert(
  longestBlock < 250,
  `le regroupement rend la main au fil de l'eau (plus long blocage : ${Math.round(longestBlock)} ms)`
)

console.log('\nretraits manuels dans la proposition')
const removedPlan = withoutRemovedPosts(
  plan,
  (ruleKeys, name) => (ruleKeys.includes('3d') || name === '3D & Blender' ? 7 : null),
  new Map([[7, new Set(['b1'])]])
)
const threeDBefore = plan.suggestions.find((s) => s.name === '3D & Blender')
const threeDAfter = removedPlan.suggestions.find((s) => s.name === '3D & Blender')
assert(
  threeDBefore?.postIds.includes('b1') && !threeDAfter?.postIds.includes('b1'),
  'une vidéo retirée à la main n’est plus reproposée pour cette collection'
)
assert(
  (threeDAfter?.postIds.length ?? 0) === (threeDBefore?.postIds.length ?? 0) - 1,
  'les autres vidéos de la catégorie sont conservées'
)
assert(
  !removedPlan.routes.find((route) => route.postId === 'b1')?.rankedRuleKeys.includes('3d'),
  'la redistribution ne peut pas l’y ramener par la bande'
)
assert(
  removedPlan.unassignedVideos === plan.unassignedVideos + 1,
  'elle est recomptée parmi les vidéos sans catégorie'
)
assert(
  withoutRemovedPosts(plan, () => 7, new Map()) === plan,
  'sans aucun retrait, le plan n’est pas retouché'
)

console.log('\nTout est vert.')
}

void main()
