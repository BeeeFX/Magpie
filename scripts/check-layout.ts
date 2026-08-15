/**
 * Vérification du moteur de mise en page : `npm run check:layout`
 *
 * C'est le code le plus délicat de M0 — une erreur d'un pixel dans l'empilement ou dans la
 * fenêtre de virtualisation se voit immédiatement à l'écran, mais se debugue mal. On le
 * teste donc directement, sans DOM ni React.
 *
 * Trois propriétés, vraies quelles que soient les données :
 *   1. aucune carte n'en recouvre une autre ;
 *   2. tout tient dans la largeur et sous la hauteur annoncée ;
 *   3. la fenêtre de virtualisation contient exactement ce qu'une recherche naïve
 *      trouverait — c'est ce qui garantit qu'aucune carte ne « disparaît » au scroll.
 */
import type { GridMode, Post } from '../src/shared/types'
import {
  alignItemsToPosts,
  computeLayout,
  visibleItems,
  type Layout
} from '../src/renderer/src/layout'

let failures = 0

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures++
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/* Jeu de données volontairement hostile : ratios extrêmes, dimensions manquantes,
   posts sans média, texte de longueur très variable. */
function makePosts(count: number): Post[] {
  let seed = 7
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }

  return Array.from({ length: count }, (_, i) => {
    const roll = random()
    const kind = roll < 0.08 ? 'text' : roll < 0.12 ? 'link' : roll < 0.3 ? 'video' : 'image'
    const hasDims = kind !== 'text' && kind !== 'link' && random() > 0.05
    return {
      id: `p${i}`,
      platform: 'instagram',
      nativeId: `${i}`,
      url: `https://example.test/${i}`,
      authorHandle: `author${i % 11}`,
      authorName: null,
      text: 'lorem ipsum '.repeat(1 + Math.floor(random() * 24)),
      aiDescription: null,
      kind,
      mediaCount: 1,
      // Ratios extrêmes inclus : 5:1 et 1:9 ne devraient jamais exister, la mise en page
      // doit quand même rester bornée.
      width: hasDims ? 1080 : null,
      height: hasDims ? Math.round(1080 * (0.2 + random() * 8.8)) : null,
      dominantColor: '#333333',
      thumbUrl: hasDims ? `magpie://thumb/${i}.webp` : null,
      media: hasDims
        ? [
            {
              idx: 0,
              kind: 'image' as const,
              thumbUrl: `magpie://thumb/${i}.webp`,
              videoUrl: null,
              width: 1080,
              height: 1080,
              videoQualities: []
            }
          ]
        : [],
      publishedAt: Date.now() - i * 86400000,
      savedAt: null,
      discoveredAt: Date.now(),
      savedRank: i,
      isFavorite: false,
      isArchived: false,
      label: null,
      tags: []
      ,sources: ['saved']
    } satisfies Post
  })
}

function noOverlap(layout: Layout): string | null {
  const items = layout.items
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]
      const b = items[j]
      if (
        a.x < b.x + b.width - 0.01 &&
        a.x + a.width - 0.01 > b.x &&
        a.y < b.y + b.height - 0.01 &&
        a.y + a.height - 0.01 > b.y
      ) {
        return `${a.post.id} recouvre ${b.post.id}`
      }
    }
  }
  return null
}

function run(mode: GridMode, containerWidth: number, targetColumnWidth: number): void {
  const posts = makePosts(400)
  const layout = computeLayout(posts, { containerWidth, targetColumnWidth, gap: 12, mode })

  console.log(`\n${mode} · conteneur ${containerWidth}px · colonne cible ${targetColumnWidth}px`)
  console.log(`  ${layout.columns} colonnes de ${Math.round(layout.columnWidth)}px, hauteur ${Math.round(layout.totalHeight)}px`)

  check('toutes les cartes sont placées', layout.items.length === posts.length)
  check('aucun chevauchement', noOverlap(layout) === null, noOverlap(layout) ?? '')
  check(
    'rien ne déborde en largeur',
    layout.items.every((i) => i.x >= -0.01 && i.x + i.width <= containerWidth + 0.01)
  )
  check(
    'rien ne dépasse la hauteur totale',
    layout.items.every((i) => i.y + i.height <= layout.totalHeight + 0.01)
  )
  check(
    'aucune carte démesurée malgré les ratios aberrants',
    layout.items.every((i) => i.height <= layout.columnWidth * 1.9 + 200)
  )

  // La fenêtre de virtualisation doit coïncider avec une recherche exhaustive.
  const viewportHeight = 900
  const overscan = 400
  let mismatches = 0
  for (let scroll = 0; scroll <= layout.totalHeight; scroll += 137) {
    const fast = new Set(visibleItems(layout, scroll, viewportHeight, overscan).map((i) => i.post.id))
    const slow = layout.items.filter(
      (i) => i.y + i.height >= scroll - overscan && i.y <= scroll + viewportHeight + overscan
    )
    if (fast.size !== slow.length || !slow.every((i) => fast.has(i.post.id))) mismatches++
  }
  check('la fenêtre virtualisée est exacte à toutes les positions', mismatches === 0, `${mismatches} écarts`)

  const rendered = visibleItems(layout, Math.floor(layout.totalHeight / 2), viewportHeight, overscan)
  check(
    'la virtualisation rend une petite fraction du total',
    rendered.length < posts.length / 4,
    `${rendered.length}/${posts.length}`
  )
}

console.log('Vérification du moteur de mise en page')
run('masonry', 1200, 240)
run('masonry', 1920, 160)
run('masonry', 420, 400)
run('cards', 1200, 240)
run('cards', 640, 300)

// Charge réaliste d'une très grande bibliothèque : les 10 000 objets participent au
// calcul, mais seule une poignée de cartes doit atteindre React autour du viewport.
const largePosts = makePosts(10_000)
const largeStarted = performance.now()
const largeLayout = computeLayout(largePosts, {
  containerWidth: 1920,
  targetColumnWidth: 220,
  gap: 12,
  mode: 'cards'
})
const largeElapsed = performance.now() - largeStarted
const largeVisible = visibleItems(largeLayout, largeLayout.totalHeight / 2, 1080, 500)
console.log('\nbibliothèque de 10 000 posts')
check('les 10 000 cartes sont indexées', largeLayout.items.length === 10_000)
check('moins de 100 cartes sont rendues à la fois', largeVisible.length < 100, `${largeVisible.length}`)
check('le calcul reste sous 100 ms', largeElapsed < 100, `${largeElapsed.toFixed(1)} ms`)

/*
 * Identité des éléments entre deux frames. C'est la propriété dont dépend `memo(Card)` :
 * si le réalignement fabrique de nouveaux objets à chaque défilement, les cartes visibles
 * se re-rendent toutes pour un simple mouvement du curseur, et la mémoïsation ne sert plus
 * à rien. Elle ne se voit pas à l'écran, seulement au compteur d'images — d'où ce contrôle.
 */
console.log('\nidentité des éléments (mémoïsation des cartes)')
const alignPosts = makePosts(500)
const alignLayout = computeLayout(alignPosts, {
  containerWidth: 1200,
  targetColumnWidth: 240,
  gap: 12,
  mode: 'cards'
})
const alignedOnce = alignItemsToPosts(alignLayout, alignPosts)
const alignedTwice = alignItemsToPosts(alignLayout, alignPosts)
check(
  'un lot inchangé rend exactement les mêmes objets',
  alignPosts.every((post) => alignedOnce.get(post.id) === alignedTwice.get(post.id))
)
check(
  'et ces objets sont ceux de la mise en page, sans copie inutile',
  alignLayout.items.every((item) => alignedOnce.get(item.post.id) === item)
)

// Une vignette qui arrive remplace un seul post : lui seul doit changer d'identité.
const touchedId = alignPosts[42].id
const nextPosts = alignPosts.map((post) =>
  post.id === touchedId ? { ...post, thumbUrl: 'magpie://thumb/nouvelle.webp' } : post
)
const afterThumb = alignItemsToPosts(alignLayout, nextPosts)
check(
  'une vignette produite ne renouvelle que la carte concernée',
  afterThumb.get(touchedId) !== alignedOnce.get(touchedId) &&
    alignPosts
      .filter((post) => post.id !== touchedId)
      .every((post) => afterThumb.get(post.id) === alignedOnce.get(post.id))
)
check(
  'la carte renouvelée porte le post à jour sans bouger de place',
  afterThumb.get(touchedId)?.post.thumbUrl === 'magpie://thumb/nouvelle.webp' &&
    afterThumb.get(touchedId)?.y === alignedOnce.get(touchedId)?.y
)
check(
  'un post disparu du lot conserve la place que la mise en page lui connaît',
  alignItemsToPosts(alignLayout, alignPosts.slice(0, 100)).size === alignLayout.items.length
)

const empty = computeLayout([], { containerWidth: 1200, targetColumnWidth: 240, gap: 12, mode: 'masonry' })
console.log('\ncas limites')
check('liste vide', empty.items.length === 0 && empty.totalHeight === 0)
const zeroWidth = computeLayout(makePosts(5), {
  containerWidth: 0,
  targetColumnWidth: 240,
  gap: 12,
  mode: 'masonry'
})
check('conteneur de largeur nulle', zeroWidth.items.length === 0)

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} vérification(s) en échec.`)
process.exit(failures === 0 ? 0 : 1)
