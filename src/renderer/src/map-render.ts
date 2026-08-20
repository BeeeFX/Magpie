/**
 * Le réglage de la toile, sorti du composant pour pouvoir être éprouvé.
 *
 * Il ne dépend que de deux nombres — l'empan de la carte à l'écran et le nombre d'arêtes — donc
 * il n'a besoin ni d'un canevas, ni de React, ni d'une bibliothèque. C'est ce qui permet à
 * `npm run check:map-density` de vérifier l'invariant qui a été violé deux fois : **le rendu ne
 * dépend que de l'empan**, jamais du couple (taille du cadre, échelle) pris séparément.
 */

/**
 * Le cadre sur lequel le rendu de la toile a été réglé à l'œil : la bande de l'organisateur,
 * 460 px de haut.
 *
 * Sans ce repère, tout le réglage de la toile ne dépendait que de `view.scale` — or ce qui
 * décide de l'aspect n'est pas l'échelle, c'est l'**empan à l'écran**, `min(largeur, hauteur) ×
 * échelle`. Les deux se confondent tant que le cadre ne change pas de taille, et divergent dès
 * qu'il change : la carte plein écran a un petit côté de l'ordre de 1 100 px contre 460 dans
 * l'organisateur, donc le même nuage y est étalé sur près de six fois plus de surface. La toile
 * étant peinte en `lighter`, l'accumulation par pixel s'effondre d'autant : mêmes points de
 * 0,5 px, même opacité d'arête, six fois moins de superpositions — la carte paraissait délavée
 * là où l'autre paraissait nette, pour exactement le même dessin.
 *
 * On raisonne donc en **échelle apparente** : `empan / 460`. À cadre égal, le comportement est
 * identique au précédent, au flottant près — l'organisateur ne bouge pas.
 */
export const REFERENCE_FRAME = 460

/**
 * Rendu de la toile, réglé à l'œil sur la vraie bibliothèque.
 *
 * Deux régimes : ce que vaut chaque grandeur de loin, et ce qu'elle gagne en approchant. La
 * distinction est indispensable — le rendu qui fonctionne à l'échelle de la bibliothèque
 * entière ne fonctionne pas une fois dedans, où les arêtes se raréfient et où les points,
 * devenus gros, noieraient les fils.
 */
export const WEB = {
  /** À zéro, la toile n'existe pas tant qu'on n'a pas commencé à zoomer. Voulu. */
  edgeFar: 0,
  edgeNear: 0.39,
  lineFar: 0.5,
  lineNear: 0.2,
  /** De loin le halo porte tout le rendu, les fils eux-mêmes étant transparents. */
  bloomFar: 1,
  bloomNear: 0.25,
  bloomWidth: 11,
  dotFar: 0.1,
  dotNear: 0,
  dotGlowFar: 0,
  dotGlowNear: 0.26,
  dotSizeFar: 0.5,
  dotSizeNear: 0.8,
  /** Zoom auquel le régime « de près » est pleinement atteint. */
  nearAt: 6,
  /** Arêtes de référence pour l'amortissement d'opacité. */
  reference: 60_000
}

export interface WebTuning {
  /** Le régime, de 0 (toute la bibliothèque de loin) à 1 (dedans). */
  closeness: number
  /** Opacité d'une arête, amortie par leur nombre. */
  edgeAlpha: number
  /** Épaisseur du fil. */
  core: number
  /** Force du halo autour des fils. */
  bloom: number
  /** Rayon d'un point, en pixels d'écran. */
  dotRadius: number
  /** Force du halo autour d'un point. */
  glow: number
}

/**
 * Tout le rendu de la toile, à partir de l'empan et du nombre d'arêtes.
 *
 * `span` est `min(largeur, hauteur) × échelle` : la taille que la carte occupe réellement à
 * l'écran. C'est la seule grandeur qui décide de l'aspect, et c'est tout le propos — la toile
 * est peinte en `lighter`, donc ce qui compte est le nombre de superpositions par pixel, donc la
 * surface sur laquelle le même nuage est étalé.
 */
export function webTuning(span: number, links: number): WebTuning {
  const apparent = span / REFERENCE_FRAME
  const closeness = Math.min(1, Math.max(0, apparent - 1) / WEB.nearAt)
  return {
    closeness,
    edgeAlpha:
      (WEB.edgeFar + WEB.edgeNear * closeness) /
      Math.sqrt(Math.max(1, links / WEB.reference)),
    core: WEB.lineFar + WEB.lineNear * closeness,
    bloom: WEB.bloomFar + (WEB.bloomNear - WEB.bloomFar) * closeness,
    dotRadius: WEB.dotSizeFar + WEB.dotSizeNear * closeness,
    glow: WEB.dotGlowFar + WEB.dotGlowNear * closeness
  }
}

/**
 * Le coût d'un tracé de toile, en pixels de courbe à rasteriser.
 *
 * Ce n'est pas le nombre d'arêtes qui coûte, c'est leur longueur à l'écran multipliée par leur
 * épaisseur : la toile est tracée en trois passes dont deux très larges, et une arête mesure
 * `LINK_RADIUS × empan` pixels. Donc le coût grandit avec l'empan — et c'est pour cela que la
 * même carte gèle une seconde en plein écran là où elle coûte le quart dans la bande de
 * l'organisateur.
 *
 * Le facteur de visibilité borne le tout : une fois zoomé, la majeure partie des arêtes tombe
 * hors cadre et le découpage en tuiles les écarte sans les tracer. C'est pourquoi zoomer *dans*
 * la carte est moins cher que la regarder en entier.
 */
export function webLoad(links: number, span: number, width: number, height: number): number {
  if (span <= 0) return 0
  const visible = Math.min(1, (width * height) / (span * span))
  return links * span * visible
}

/**
 * Le coût du réglage d'origine, comme repère de lecture.
 *
 * Repère : la bande de l'organisateur — 800 × 460 points, empan 920 — et les 133 810 arêtes de
 * la bibliothèque de référence. C'est là que la toile a été réglée à l'œil et jugée bonne.
 *
 * Il a servi un temps à *réduire la résolution* de la toile quand la vue coûtait plus cher, et
 * c'était le mauvais remède : la charge est maximale précisément une fois dézoomé, donc la vue
 * la plus regardée était la plus floue. Le coût se paie maintenant en **temps étalé** — six
 * millisecondes par image dans un second tampon — et non en netteté. Le repère reste, pour dire
 * ce qu'un tracé coûte.
 */
export const WEB_TARGET_LOAD = webLoad(133_810, 920, 800, 460)

/**
 * Plafond d'arêtes tracées, pour que le coût ne dépende pas de la taille de la bibliothèque.
 *
 * Posé au-dessus des 133 810 de la bibliothèque de référence : celle-ci n'est donc pas touchée,
 * et c'est voulu — on ne change pas un rendu jugé bon. Le plafond protège la suite, où le
 * voisinage produit des arêtes proportionnellement au nombre de posts.
 */
export const MAX_EDGES = 140_000

/** Quelle part des arêtes tracer pour rester sous le plafond. */
export function edgeKeep(links: number): number {
  return links <= MAX_EDGES ? 1 : MAX_EDGES / links
}

/**
 * Cette arête fait-elle partie de l'échantillon ?
 *
 * Suite à faible discrépance plutôt que tirage au sort : le nombre d'or répartit les arêtes
 * gardées uniformément le long de la liste, là où un hasard laisserait des trous et des paquets
 * — visibles, puisque les arêtes voisines dans la liste sont voisines sur la carte.
 */
export function edgeKept(index: number, keep: number): boolean {
  if (keep >= 1) return true
  return (index * 0.618_033_988_749_895) % 1 < keep
}
