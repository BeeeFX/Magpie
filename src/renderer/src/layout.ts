import type { GridMode, Post } from '@shared/types'

/**
 * Calcul de mise en page de la grille. Fonctions pures, sans React : c'est ce qui rend le
 * scroll fluide et le comportement vérifiable.
 *
 * Le point clé : la disposition se calcule à partir des dimensions stockées en base, pas
 * des images chargées. Aucune image n'a besoin d'être décodée pour savoir où va la
 * suivante, donc on peut scroller 5 000 posts sans à-coups ni reflows.
 */

export interface LayoutItem {
  post: Post
  x: number
  y: number
  width: number
  height: number
  /** Hauteur de la zone média ; le reste est le bandeau de métadonnées en mode cartes. */
  imageHeight: number
}

export interface Layout {
  items: LayoutItem[]
  /** Copie triée par `y`, pour la recherche dichotomique du premier élément visible. */
  byTop: LayoutItem[]
  totalHeight: number
  columns: number
  columnWidth: number
  maxItemHeight: number
}

export interface LayoutOptions {
  containerWidth: number
  targetColumnWidth: number
  gap: number
  mode: GridMode
}


/**
 * Un ratio aberrant (donnée corrompue, média sans dimensions) ferait une colonne de
 * plusieurs milliers de pixels. On borne au-delà du plus extrême des formats réels :
 * 1.91:1 en paysage (0.52) et 9:16 en reel (1.78).
 */
const MIN_RATIO = 0.5
const MAX_RATIO = 1.9

const EMPTY: Layout = {
  items: [],
  byTop: [],
  totalHeight: 0,
  columns: 1,
  columnWidth: 0,
  maxItemHeight: 0
}

function ratioOf(post: Post): number {
  if (!post.width || !post.height) return 1
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, post.height / post.width))
}

function hasMedia(post: Post): boolean {
  return post.kind !== 'text' && post.kind !== 'link'
}

/** Hauteur d'un post sans média : proportionnelle au texte, bornée pour rester lisible. */
function textHeight(post: Post, columnWidth: number): number {
  const chars = (post.text ?? '').length
  const charsPerLine = Math.max(18, Math.floor(columnWidth / 7.6))
  const lines = Math.min(9, Math.max(3, Math.ceil(chars / charsPerLine)))
  return 44 + lines * 20
}

function columnCount(containerWidth: number, target: number, gap: number): number {
  return Math.max(1, Math.floor((containerWidth + gap) / (target + gap)))
}

export function computeLayout(posts: Post[], options: LayoutOptions): Layout {
  const { containerWidth, targetColumnWidth, gap, mode } = options
  if (containerWidth <= 0 || posts.length === 0) return EMPTY

  const columns = columnCount(containerWidth, targetColumnWidth, gap)
  const columnWidth = (containerWidth - gap * (columns - 1)) / columns

  return mode === 'masonry'
    ? masonry(posts, columns, columnWidth, gap)
    : cards(posts, columns, columnWidth, gap)
}

/** Empilement gourmand : chaque post va dans la colonne la plus courte. */
function masonry(posts: Post[], columns: number, columnWidth: number, gap: number): Layout {
  const heights = new Array<number>(columns).fill(0)
  const items: LayoutItem[] = []
  let maxItemHeight = 0

  for (const post of posts) {
    const imageHeight = hasMedia(post)
      ? Math.round(columnWidth * ratioOf(post))
      : textHeight(post, columnWidth)

    let column = 0
    for (let i = 1; i < columns; i++) {
      if (heights[i] < heights[column]) column = i
    }

    items.push({
      post,
      x: column * (columnWidth + gap),
      y: heights[column],
      width: columnWidth,
      height: imageHeight,
      imageHeight
    })

    heights[column] += imageHeight + gap
    if (imageHeight > maxItemHeight) maxItemHeight = imageHeight
  }

  return finalize(items, columns, columnWidth, Math.max(...heights) - gap, maxItemHeight)
}

/* Mesures de la carte de contenu. Elles doivent suivre le CSS : une carte trop courte
   rognerait silencieusement son texte, qui est en `overflow: hidden`. */
const CARD_PADDING = 28
const CARD_AUTHOR_ROW = 46
const CARD_CHIPS_ROW = 34
const CARD_LINE_HEIGHT = 20
const CARD_MAX_TEXT_LINES = 9
const CARD_MEDIA_MAX = 380

/**
 * Cartes de contenu : l'auteur en tête, le texte lisible en entier, le média ensuite, les
 * puces de source en pied. La hauteur découle du contenu, donc l'empilement reste un
 * masonry — c'est ce qui évite les grands vides d'une grille régulière quand les textes
 * sont de longueurs très différentes.
 */
function cards(posts: Post[], columns: number, columnWidth: number, gap: number): Layout {
  const heights = new Array<number>(columns).fill(0)
  const items: LayoutItem[] = []
  let maxItemHeight = 0

  const charsPerLine = Math.max(16, Math.floor((columnWidth - CARD_PADDING) / 6.9))

  for (const post of posts) {
    const textLines = post.text
      ? Math.min(CARD_MAX_TEXT_LINES, Math.ceil(post.text.length / charsPerLine))
      : 0

    const imageHeight = hasMedia(post)
      ? Math.min(CARD_MEDIA_MAX, Math.round((columnWidth - CARD_PADDING) * ratioOf(post)))
      : 0

    const height =
      CARD_PADDING +
      CARD_AUTHOR_ROW +
      textLines * CARD_LINE_HEIGHT +
      (imageHeight > 0 ? imageHeight + 10 : 0) +
      CARD_CHIPS_ROW

    let column = 0
    for (let i = 1; i < columns; i++) {
      if (heights[i] < heights[column]) column = i
    }

    items.push({
      post,
      x: column * (columnWidth + gap),
      y: heights[column],
      width: columnWidth,
      height,
      imageHeight
    })

    heights[column] += height + gap
    if (height > maxItemHeight) maxItemHeight = height
  }

  return finalize(items, columns, columnWidth, Math.max(...heights) - gap, maxItemHeight)
}

function finalize(
  items: LayoutItem[],
  columns: number,
  columnWidth: number,
  totalHeight: number,
  maxItemHeight: number
): Layout {
  return {
    items,
    byTop: [...items].sort((a, b) => a.y - b.y),
    totalHeight: Math.max(0, totalHeight),
    columns,
    columnWidth,
    maxItemHeight
  }
}

/**
 * Sous-ensemble réellement visible. On cherche par dichotomie le premier élément qui peut
 * intersecter la fenêtre, puis on avance tant que les suivants commencent avant le bas.
 *
 * Le recul de `maxItemHeight` est ce qui rend la recherche exacte : un élément haut peut
 * commencer bien au-dessus du viewport tout en le traversant.
 */
export function visibleItems(
  layout: Layout,
  scrollTop: number,
  viewportHeight: number,
  overscan = 400
): LayoutItem[] {
  const top = scrollTop - overscan
  const bottom = scrollTop + viewportHeight + overscan
  const { byTop, maxItemHeight } = layout

  let low = 0
  let high = byTop.length
  const threshold = top - maxItemHeight
  while (low < high) {
    const mid = (low + high) >>> 1
    if (byTop[mid].y < threshold) low = mid + 1
    else high = mid
  }

  const visible: LayoutItem[] = []
  for (let i = low; i < byTop.length; i++) {
    const item = byTop[i]
    if (item.y > bottom) break
    if (item.y + item.height >= top) visible.push(item)
  }
  return visible
}
