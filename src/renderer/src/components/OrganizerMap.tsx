import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { OrganizerMap as MapData, OrganizerMapPoint } from '@shared/types'
import { useT } from '../store'
import { neededArea, paintArea, stillCovers, ZOOM_HEADROOM } from '../map-coverage'
import {
  carveOutside,
  fieldFromMask,
  insideRing,
  isoContour,
  ownershipMasks,
  ringToCurves,
  simplifyRing,
  stitchRings,
  MASK_LEVEL,
  type Vertex
} from '../map-boundaries'

/**
 * La carte sémantique.
 *
 * Un point par post, placé par la projection des vecteurs : la distance à l'écran *est* la
 * proximité de sens, donc les îles sont réelles. Une simulation à ressorts aurait fait
 * l'inverse : de jolies îles qui ne montrent que la physique.
 *
 * La carte est immobile. Seul l'atterrissage — les points qui se posent depuis le centre à
 * l'ouverture — bouge, et il s'éteint au bout de 700 ms ; le reste, zoom et déplacement, est
 * du cadrage. Rien ne frémit sous le curseur, ce qui rend le clic sur un point sûr.
 *
 * Rendu en canvas. Neuf mille points en DOM ou en SVG ne tiennent pas les 60 images par
 * seconde ; en canvas, c'est confortable — à condition de ne pas repeindre la toile à chaque
 * image, cf. le tampon plus bas.
 */

const HOVER_DOT = 7
/** Grille de recherche du point sous le curseur : un balayage linéaire de neuf mille points à
 *  chaque mouvement de souris coûterait plus cher que le dessin lui-même. */
const BUCKET = 0.02
/** Rayon de voisinage pour les liens, dans le repère unité de la carte. */
const LINK_RADIUS = 0.022
/** Au-delà, la toile devient une bouillie : on garde les plus proches. */
/* Vingt-quatre voisins : mesuré sur la bibliothèque de référence, sans plafond le voisinage
   par rayon produit 465 872 arêtes et le mélange additif sature en blanc dans les zones
   denses. Vingt-quatre en garde 133 810 — la texture partout, sans les points chauds. */
const LINKS_PER_POINT = 24
/** En deçà, le rendu se casse : la toile s'agglomère et plus rien ne se distingue. */
const MIN_SCALE = 2
/** Marge peinte autour du cadre, recoupée à l'emprise de la carte : tant que le déplacement
 *  reste dedans, on recopie l'image déjà peinte au lieu de retracer la toile. Assez large
 *  pour absorber un geste franc, assez étroite pour que le tampon reste raisonnable. */
const WEB_MARGIN = 320
/** Plafond de zoom. Porté de 24 à 60 : dans les zones denses, plusieurs posts se superposent
 *  au même pixel et on ne pouvait pas les séparer pour les lire un par un. */
const MAX_SCALE = 60
/** Part de l'image effacée pour les groupes qu'on ne regarde pas. Assez pour qu'ils s'éteignent,
 *  pas au point de perdre le contexte : on doit encore voir *où* le groupe se situe. */
const FOCUS_FADE = 0.86
/**
 * Écart toléré en simplifiant un contour, en unités de carte.
 *
 * Les carrés marchants rendent un sommet par case traversée — trois cents pour une région,
 * alignés par petits paquets. On ne pose pas de poignées sur trois cents sommets. À 0,004,
 * mesuré, il en reste une vingtaine et la forme contient toujours 100 % de ses posts.
 */
const RING_TOLERANCE = 0.004
/** Plafond du tampon, en pixels physiques. Sur un grand écran à 200 %, le cadre plus sa marge
 *  dépasserait les cent mégaoctets : on rogne alors la marge, pas la mémoire. */
const WEB_BUDGET = 24_000_000

/**
 * Rendu de la toile, réglé à l'œil sur la vraie bibliothèque.
 *
 * Deux régimes : ce que vaut chaque grandeur de loin, et ce qu'elle gagne en approchant. La
 * distinction est indispensable — le rendu qui fonctionne à l'échelle de la bibliothèque
 * entière ne fonctionne pas une fois dedans, où les arêtes se raréfient et où les points,
 * devenus gros, noieraient les fils.
 */
const WEB = {
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
/** Portée du ressort quand on tire un point : ses voisins suivent, de moins en moins. */

export type ColourMode = 'group' | 'platform' | 'kind' | 'source'

interface Props {
  data: MapData
  colourMode: ColourMode
  /** Groupes retenus, pour griser ce qui est exclu sans le faire disparaître. */
  includedGroups: Set<string>
  /** Nom de chaque groupe, pour poser une étiquette sur son îlot. */
  groupNames: Map<string, string>
  /** Les noms d'amas sont-ils dessinés ? Masqués, la toile se voit entière. */
  showLabels: boolean
  /** Les contours de collections sont-ils tracés ? */
  showBoundaries: boolean
  /** Les frontières déjà rangées en base, par groupe. Vides si la carte n'est pas figée. */
  savedBoundaries: Map<string, Vertex[][]>
  /** Une frontière vient d'être déformée : à l'appelant de la ranger et de reclasser. */
  onBoundaryChange(group: string, rings: Vertex[][], inside: string[]): void
  /** Quelle frontière est en cours de retouche, pour que l'écran puisse le dire. */
  onEditingChange?(group: string | null): void
  onLasso(ids: string[]): void
  onHover(point: OrganizerMapPoint | null): void
  /** Clic sur un point : ouvrir le post qu'il représente. */
  onOpen(point: OrganizerMapPoint): void
  /** Auteur et texte du point survolé, quand le parent a fini de les chercher. L'infobulle
   *  s'ouvre sans les attendre : la vignette et le nom de l'amas suffisent à situer. */
  detail: { title: string; text: string } | null
}

/** Teintes bien séparées, reprises de la palette d'étiquettes : lisibles en clair et sombre. */
/* Palette saturée, reprise de la maquette : celle des étiquettes de l'interface est sourde à
   dessein, et sur fond noir elle rendait les amas indistincts. */
/** Le fil qui enjambe deux couleurs. Sombre et sourd : il fait la texture, pas le propos. */
const NEUTRAL_EDGE = '#4a4a58'

/* Vingt-quatre teintes pour vingt-quatre catégories possibles : à vingt-deux, les deux
   dernières reprenaient la couleur des deux premières, et deux collections sans rapport
   s'affichaient exactement de la même couleur sur la carte. */
const PALETTE = [
  '#ff5c5c', '#ff9f43', '#ffd93d', '#4ade80', '#38bdf8', '#a78bfa', '#f472b6', '#2dd4bf',
  '#c9a227', '#818cf8', '#fb7185', '#34d399', '#e879f9', '#a3e635', '#60a5fa', '#fde047',
  '#c084fc', '#22d3ee', '#f87171', '#86efac', '#f0abfc', '#94a3b8', '#fca5a5', '#5eead4'
]

/** La teinte d'un groupe. Un îlot en a une quel que soit le mode de couleur : il *est* un
 *  groupe, et son étiquette doit rester rattachée au même amas. */
function colourOfGroup(group: string | null, groupIndex: Map<string, number>): string {
  const index = group ? groupIndex.get(group) : undefined
  return index === undefined ? '#7b7b85' : PALETTE[index % PALETTE.length]
}

function colourFor(
  point: OrganizerMapPoint,
  mode: ColourMode,
  groupIndex: Map<string, number>
): string {
  if (mode === 'platform') return point.platform === 'instagram' ? '#c9539b' : '#4a90d9'
  if (mode === 'kind') {
    return point.kind === 'video'
      ? '#4a90d9'
      : point.kind === 'carousel'
        ? '#8a6ad9'
        : point.kind === 'text'
          ? '#a8873f'
          : '#5aa85a'
  }
  if (mode === 'source') return point.sources.includes('liked') ? '#e0574f' : '#4a90d9'
  return colourOfGroup(point.group, groupIndex)
}

export function OrganizerMap({
  data,
  colourMode,
  includedGroups,
  groupNames,
  showLabels,
  showBoundaries,
  savedBoundaries,
  onBoundaryChange,
  onEditingChange,
  onLasso,
  onHover,
  onOpen,
  detail
}: Props): React.JSX.Element {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  /* La carte s'ouvre au plancher, comme la maquette. À ×1 — sous son propre plancher, donc
     impossible à retrouver après un cran de molette — la toile est transparente : on ouvrait
     sur un nuage de points muet en attendant que l'utilisateur pense à zoomer. */
  const [view, setView] = useState({ scale: MIN_SCALE, x: 0, y: 0 })
  /** Cadrage initial : centrer la carte demande de connaître la taille du canevas. */
  const framedRef = useRef(false)
  const [hovered, setHovered] = useState<OrganizerMapPoint | null>(null)
  /** Amas éclairé : celui du point survolé, ou celui dont on survole le nom. */
  const [litGroup, setLitGroup] = useState<string | null>(null)
  /** Amas retenu au clic : tout le reste s'efface tant qu'il l'est. Le survol reste par-dessus. */
  const [focusGroup, setFocusGroup] = useState<string | null>(null)
  /** Nom survolé, pour lui donner l'aspect d'un bouton — et au curseur la forme qui va avec. */
  const [hoverLabel, setHoverLabel] = useState<string | null>(null)
  /**
   * La frontière en cours de retouche, s'il y en a une.
   *
   * Une seule à la fois, et c'est délibéré : deux régions qui se recouvrent poseraient la
   * question « à laquelle appartient ce post » sans réponse. Pousser la frontière d'une
   * collection creuse celles qu'elle recouvre.
   */
  const [editing, setEditing] = useState<string | null>(null)
  useEffect(() => {
    onEditingChange?.(editing)
  }, [editing, onEditingChange])
  /** Le sommet saisi pendant un glisser, s'il y en a un. */
  const draggedVertexRef = useRef<{ ring: number; index: number } | null>(null)
  /** Où les noms ont été posés au dernier dessin, pour pouvoir les survoler. */
  const labelBoxes = useRef<{ group: string; x: number; y: number; half: number; size: number }[]>(
    []
  )
  useEffect(() => {
    if (!focusGroup) return
    const onKey = (event: KeyboardEvent): void => {
      /* La touche ne doit pas remonter : Échap ferme aussi la fenêtre d'organisation, et
         relâcher le focus refermait tout l'écran d'un coup. */
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setFocusGroup(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [focusGroup])

  /* Les noms sont la seule poignée du focus : les masquer sans le relâcher laisserait la carte
     éteinte sans aucun moyen de la rallumer. */
  useEffect(() => {
    if (!showLabels) setFocusGroup(null)
  }, [showLabels])

  const lassoRef = useRef<{ x: number; y: number }[]>([])
  /* Le tracé en cours vit dans une référence, pas dans l'état : un mouvement de pointeur peut
     suivre l'appui dans la même image, avant que React n'ait rendu, et le geste était alors
     pris pour un déplacement de la carte. L'état ne sert qu'à changer le curseur. */
  const lassoActiveRef = useRef(false)
  const [lassoing, setLassoing] = useState(false)
  /** Instant de départ de l'atterrissage. La progression se déduit du temps écoulé, jamais
   *  d'un compteur d'images : une fenêtre masquée ne compose rien, `requestAnimationFrame`
   *  ne se déclenche pas, et les points resteraient empilés au centre jusqu'au retour au
   *  premier plan. Ainsi, n'importe quel dessin rend l'état juste. */
  const landingStartRef = useRef(0)
  const draggingRef = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const zoomRef = useRef<(event: WheelEvent) => void>(() => {})
  /** Point tiré et déplacement en cours, dans le repère unité. */
  const clickedRef = useRef<OrganizerMapPoint | null>(null)
  const pathCache = useRef<{
    key: string
    paths: Map<string, { path: Path2D; tone: string; group: string | null }>
  }>({ key: '', paths: new Map() })
  /** La toile et les points déjà peints, l'échelle à laquelle ils l'ont été, et la zone de
   *  la carte qu'ils couvrent — en coordonnées de cette échelle. */
  const webCache = useRef<{
    key: string
    canvas: HTMLCanvasElement | null
    scale: number
    left: number
    top: number
    width: number
    height: number
  }>({ key: '', canvas: null, scale: 0, left: 0, top: 0, width: 0, height: 0 })
  /* Un cran de molette change l'échelle, donc les chemins *et* la peinture : 320 ms, et les
     crans s'enchaînent plus vite que ça. Pendant le geste on étire l'image déjà peinte —
     l'agrandissement d'une toile est une toile agrandie — et on ne repeint net qu'une fois
     la molette arrêtée. */
  const [zooming, setZooming] = useState(false)
  const zoomTimer = useRef(0)

  /* React attache ses écouteurs de molette en mode passif, où `preventDefault` est ignoré :
     zoomer sur la carte faisait donc défiler la fenêtre derrière elle. Il faut poser
     l'écouteur soi-même en non passif. */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const handler = (event: WheelEvent): void => {
      event.preventDefault()
      zoomRef.current(event)
    }
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => {
      canvas.removeEventListener('wheel', handler)
      window.clearTimeout(zoomTimer.current)
    }
  }, [])

  const groupIndex = useMemo(
    () => new Map(data.plan.suggestions.map((suggestion, index) => [suggestion.id, index])),
    [data.plan.suggestions]
  )

  /**
   * Le calque des frontières : un contour et un aplat par collection, peints une fois.
   *
   * Peint dans le repère unité de la carte, donc une seule recopie transformée suffit à
   * chaque image — comme la toile. Le recalculer au zoom coûterait vingt champs de densité
   * par cran, pour un tracé qui ne change pas : les frontières vivent dans l'espace de la
   * carte, pas dans celui de l'écran.
   */
  /**
   * Les régions des collections, sous forme de masques modifiables.
   *
   * Calculées depuis les points au premier affichage, puis remplacées par celles que
   * l'utilisateur a déformées et rangées en base. Un masque plutôt qu'un contour : déformer
   * revient à peindre, et l'appartenance se lit en une case.
   */
  /**
   * Les régions, en contours vectoriels.
   *
   * Un anneau de sommets par région, et non plus un masque de 192 × 192 : le masque se
   * pixellisait dès qu'on zoomait, ne pouvait pas être lissé, et n'offrait aucune poignée à
   * saisir. Le vectoriel règle les trois — il se trace net à toute échelle, s'arrondit, et
   * chaque sommet est déjà un point de contrôle.
   */
  const [regions, setRegions] = useState<Map<string, Vertex[][]>>(new Map())

  useEffect(() => {
    const members = new Map<string, { x: number; y: number }[]>()
    for (const point of data.points) {
      if (!point.group) continue
      const list = members.get(point.group)
      if (list) list.push({ x: point.x, y: point.y })
      else members.set(point.group, [{ x: point.x, y: point.y }])
    }
    /* Les régions se découpent les unes contre les autres, jamais chacune dans son coin :
       les collections s'interpénètrent, et seuiller séparément faisait revendiquer presque
       toute la carte à chacune — vingt contours superposés, illisibles. */
    const owned = ownershipMasks(
      [...members]
        .filter(([, points]) => points.length >= 3)
        .map(([group, points]) => ({ group, points }))
    )
    const next = new Map<string, Vertex[][]>()
    for (const [group, mask] of owned) {
      const stored = savedBoundaries.get(group)
      if (stored && stored.length > 0) {
        next.set(group, stored)
        continue
      }
      const rings = stitchRings(isoContour(fieldFromMask(mask), MASK_LEVEL))
        .map((ring) => simplifyRing(ring, RING_TOLERANCE))
        .filter((ring) => ring.length >= 6)
      if (rings.length > 0) next.set(group, rings)
    }
    setRegions(next)
  }, [data.points, savedBoundaries])

  /**
   * Où poser le nom d'une collection quand ses frontières sont visibles.
   *
   * Au centre de sa région, et non sur la case la plus fournie de l'amas : quand un contour est
   * tracé, c'est lui que l'œil suit, et un nom posé à côté de sa région désignerait le voisin.
   */
  const regionCentres = useMemo(() => {
    const centres = new Map<string, { x: number; y: number }>()
    for (const [group, rings] of regions) {
      const ring = [...rings].sort((a, b) => b.length - a.length)[0]
      if (!ring || ring.length === 0) continue
      let x = 0
      let y = 0
      for (const vertex of ring) {
        x += vertex.x
        y += vertex.y
      }
      centres.set(group, { x: x / ring.length, y: y / ring.length })
    }
    return centres
  }, [regions])

  /**
   * Les chemins prêts à tracer, refaits seulement quand une région change.
   *
   * Chacun porte son emprise, pour pouvoir l'écarter sans l'examiner : zoomé dans un amas,
   * dix-neuf régions sur vingt sont hors cadre, et les remplir puis les border à chaque image
   * coûtait sans que rien n'apparaisse.
   */
  const boundaryPaths = useMemo(() => {
    const paths = new Map<string, { path: Path2D; left: number; top: number; right: number; bottom: number }>()
    for (const [group, rings] of regions) {
      const path = new Path2D()
      let left = Infinity
      let top = Infinity
      let right = -Infinity
      let bottom = -Infinity
      for (const ring of rings) {
        if (ring.length < 3) continue
        path.moveTo(ring[0].x, ring[0].y)
        for (const curve of ringToCurves(ring)) {
          path.bezierCurveTo(curve.c1.x, curve.c1.y, curve.c2.x, curve.c2.y, curve.to.x, curve.to.y)
        }
        path.closePath()
        for (const vertex of ring) {
          if (vertex.x < left) left = vertex.x
          if (vertex.y < top) top = vertex.y
          if (vertex.x > right) right = vertex.x
          if (vertex.y > bottom) bottom = vertex.y
        }
      }
      if (left <= right) paths.set(group, { path, left, top, right, bottom })
    }
    return paths
  }, [regions])

  /* Découpage en cases pour le pointage. Reconstruit seulement quand les points changent —
     pas au zoom, qui ne déplace rien dans le repère de la carte. */
  const buckets = useMemo(() => {
    const map = new Map<string, OrganizerMapPoint[]>()
    for (const point of data.points) {
      const key = `${Math.floor(point.x / BUCKET)}:${Math.floor(point.y / BUCKET)}`
      const list = map.get(key)
      if (list) list.push(point)
      else map.set(key, [point])
    }
    return map
  }, [data.points])

  /* Les liens rendent la structure visible : deux points reliés parlent du même sujet. Ils se
     calculent dans le repère 2D plutôt qu'en dimension 384 — la projection a justement pour
     rôle de préserver le voisinage, donc la proximité à l'écran suffit, et c'est mille fois
     moins cher. */
  /* Les vingt-quatre plus proches de chaque point, puis dédoublonnage — l'ordre compte.
     Écarter d'abord les identifiants inférieurs, comme le faisait la version précédente,
     ne retient pas les mêmes arêtes : un point dont tous les proches sont « avant » lui
     allait en chercher vingt-quatre plus loin, et le total montait à 210 794 au lieu des
     133 810 sur lesquels le rendu est réglé. Mesuré sur la vraie bibliothèque, à ×3 centré :
     494 ms par image contre 219. */
  const links = useMemo(() => {
    const rank = new Map(data.points.map((point, index) => [point.id, index]))
    const seen = new Set<string>()
    const pairs: [OrganizerMapPoint, OrganizerMapPoint][] = []
    for (const point of data.points) {
      const near: { other: OrganizerMapPoint; distance: number }[] = []
      const cellX = Math.floor(point.x / BUCKET)
      const cellY = Math.floor(point.y / BUCKET)
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (const other of buckets.get(`${cellX + dx}:${cellY + dy}`) ?? []) {
            if (other.id === point.id) continue
            const distance = Math.hypot(other.x - point.x, other.y - point.y)
            if (distance < LINK_RADIUS) near.push({ other, distance })
          }
        }
      }
      near.sort((left, right) => left.distance - right.distance)
      for (const entry of near.slice(0, LINKS_PER_POINT)) {
        const here = rank.get(point.id) ?? 0
        const there = rank.get(entry.other.id) ?? 0
        const key = here < there ? `${here}:${there}` : `${there}:${here}`
        if (seen.has(key)) continue
        seen.add(key)
        pairs.push([point, entry.other])
      }
    }
    return pairs
  }, [buckets, data.points])

  /* Sans étiquettes, neuf mille points colorés ne sont qu'une tache : on voit qu'il y a des
     amas, jamais lesquels. C'est ce qui sépare une jolie image d'une carte. */
  const islands = useMemo(() => {
    /* L'étiquette se pose sur la masse du groupe, pas sur la moyenne de ses points.
       Une catégorie éparpillée — « architecture » répartie en trois endroits — a une moyenne
       qui ne tombe sur aucun d'eux : le nom flottait dans le vide, à côté d'une carte pleine.
       On prend donc la case la plus fournie du groupe, puis le centre des points qu'elle et
       ses voisines contiennent : le nom se pose là où l'amas se voit. */
    const CELL = 0.04
    const members = new Map<string, OrganizerMapPoint[]>()
    for (const point of data.points) {
      if (!point.group) continue
      const list = members.get(point.group)
      if (list) list.push(point)
      else members.set(point.group, [point])
    }
    return [...members.entries()]
      .filter(([, list]) => list.length >= 12)
      .map(([group, list]) => {
        const cells = new Map<string, OrganizerMapPoint[]>()
        for (const point of list) {
          const key = `${Math.floor(point.x / CELL)}:${Math.floor(point.y / CELL)}`
          const cell = cells.get(key)
          if (cell) cell.push(point)
          else cells.set(key, [point])
        }
        let bestKey = ''
        let bestCount = -1
        for (const [key, cell] of cells) {
          if (cell.length > bestCount) {
            bestCount = cell.length
            bestKey = key
          }
        }
        const [cx, cy] = bestKey.split(':').map(Number)
        let x = 0
        let y = 0
        let near = 0
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            for (const point of cells.get(`${cx + dx}:${cy + dy}`) ?? []) {
              x += point.x
              y += point.y
              near += 1
            }
          }
        }
        return { group, x: x / near, y: y / near, count: list.length, near }
      })
      .sort((left, right) => right.count - left.count)
  }, [data.points])

  const reduced = useMemo(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    []
  )

  const LANDING_MS = 700
  const landingAt = (): number =>
    reduced ? 1 : Math.min(1, (performance.now() - landingStartRef.current) / LANDING_MS)

  useEffect(() => {
    landingStartRef.current = performance.now()
  }, [data.points])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const ratio = window.devicePixelRatio || 1
    const width = canvas.width / ratio
    const height = canvas.height / ratio
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)

    const size = Math.min(width, height)
    const landing = landingAt()
    const closeness = Math.min(1, (view.scale - 1) / WEB.nearAt)
    /* L'origine du carré unité à l'écran, avant décalage du cadrage. Remontée ici parce que
       les frontières s'en servent aussi, et qu'elle ne dépend que du cadre et de l'échelle. */
    const span = size * view.scale
    const originX = ((width - size) / 2) * view.scale
    const originY = ((height - size) / 2) * view.scale
    const edgeAlpha =
      (WEB.edgeFar + WEB.edgeNear * closeness) /
      Math.sqrt(Math.max(1, links.length / WEB.reference))
    const core = WEB.lineFar + WEB.lineNear * closeness
    const bloom = WEB.bloomFar + (WEB.bloomNear - WEB.bloomFar) * closeness
    const dotRadius = WEB.dotSizeFar + WEB.dotSizeNear * closeness
    const glow = WEB.dotGlowFar + WEB.dotGlowNear * closeness

    /* Position sans le déplacement : c'est la seule chose qui change quand on fait glisser
       la carte, et la garder à part permet de peindre une fois puis de translater. */
    const at = (point: { x: number; y: number }): [number, number] => {
      // L'atterrissage tire les points depuis le centre : ils se posent au lieu de surgir.
      const eased = 1 - Math.pow(1 - landing, 3)
      const cx = 0.5 + (point.x - 0.5) * eased
      const cy = 0.5 + (point.y - 0.5) * eased
      return [
        (cx * size + (width - size) / 2) * view.scale,
        (cy * size + (height - size) / 2) * view.scale
      ]
    }

    /* La toile, en trois passes par couleur : deux tracés larges et très faibles qui font la
       lueur, puis le fil net. Un chemin par couleur et non par arête — cent trente mille
       appels à `stroke` était le vrai coût, pas les courbes. */
    const paintWeb = (
      target: CanvasRenderingContext2D,
      area: { left: number; top: number; right: number; bottom: number }
    ): void => {
      if (edgeAlpha <= 0.002) return
      /* La zone peinte fait partie de la clé : à fort zoom, l'écarter laissait construire
         cent trente mille courbes dont trois cents seulement tombaient dans le cadre. */
      const key = [
        view.scale,
        landing.toFixed(3),
        colourMode,
        area.left.toFixed(0),
        area.top.toFixed(0),
        area.right.toFixed(0),
        area.bottom.toFixed(0)
      ].join(':')
      if (pathCache.current.key !== key) {
        const built = new Map<string, { path: Path2D; tone: string; group: string | null }>()
        // La courbe s'écarte de la corde : de la marge, sinon les arcs sautent aux bords.
        const slack = core * WEB.bloomWidth + LINK_RADIUS * size * view.scale * 0.3
        for (const [from, to] of links) {
          const [x1, y1] = at(from)
          const [x2, y2] = at(to)
          if (
            (x1 < area.left - slack && x2 < area.left - slack) ||
            (x1 > area.right + slack && x2 > area.right + slack) ||
            (y1 < area.top - slack && y2 < area.top - slack) ||
            (y1 > area.bottom + slack && y2 > area.bottom + slack)
          ) {
            continue
          }
          /* Un fil ne prend une couleur que s'il relie deux posts de la même couleur.
             Colorer chaque fil d'après son seul point de départ mettait de la couleur partout :
             les catégories de l'organiseur ne sont pas des zones — elles suivent le sens, pas
             la place — si bien que les voisins immédiats appartiennent souvent à deux
             catégories différentes, et la toile virait à l'arc-en-ciel piqueté. Le fil qui
             enjambe deux catégories passe au gris : il reste, la texture aussi, mais la
             couleur ne dit plus qu'une chose — ces deux-là vont ensemble. Les amas
             redeviennent des taches lisibles, et c'est ce que la maquette montrait, où les
             groupes étaient découpés dans l'espace et donc toujours d'accord avec leurs
             voisins. Vrai dans tous les modes : deux posts de la même plateforme, du même
             type ou de la même provenance gardent leur teinte. */
          const tone =
            colourFor(from, colourMode, groupIndex) === colourFor(to, colourMode, groupIndex)
              ? colourFor(from, colourMode, groupIndex)
              : NEUTRAL_EDGE
          const shared = tone === NEUTRAL_EDGE ? null : from.group
          /* Un chemin par couple groupe/teinte. La teinte seule suffirait à peindre, mais pas
             à éclairer un amas au survol : dans les modes autres que « par groupe », vingt
             amas partagent la même couleur. */
          const bucket = `${shared ?? ''}|${tone}`
          let entry = built.get(bucket)
          if (!entry) {
            entry = { path: new Path2D(), tone, group: shared }
            built.set(bucket, entry)
          }
          const path = entry.path
          path.moveTo(x1, y1)
          path.quadraticCurveTo(
            (x1 + x2) / 2 - (y2 - y1) * 0.26,
            (y1 + y2) / 2 + (x2 - x1) * 0.26,
            x2,
            y2
          )
        }
        pathCache.current = { key, paths: built }
      }
      target.globalCompositeOperation = 'lighter'
      for (const { path, tone } of pathCache.current.paths.values()) {
        target.strokeStyle = tone
        if (bloom > 0.02) {
          target.lineWidth = core * WEB.bloomWidth
          target.globalAlpha = edgeAlpha * bloom * 0.5
          target.stroke(path)
          target.lineWidth = core * Math.max(1.5, WEB.bloomWidth / 2.3)
          target.globalAlpha = edgeAlpha * bloom * 0.6
          target.stroke(path)
        }
        target.lineWidth = core
        target.globalAlpha = edgeAlpha
        target.stroke(path)
      }
      target.globalCompositeOperation = 'source-over'
      target.globalAlpha = 1
    }

    /* Survoler éclaire l'amas désigné au lieu d'éteindre les autres : la toile complète doit
       rester lisible en permanence, c'est tout son intérêt. Repeint par-dessus l'image en
       cache — repeindre le tampon entier pour un survol coûterait 220 ms par mouvement. */
    const lightUp = (group: string, stretch = 1): void => {
      if (edgeAlpha <= 0.002 || pathCache.current.key === '') return
      context.save()
      context.translate(view.x, view.y)
      /* Pendant un geste de zoom, le fond est une recopie *étirée* du tampon : aucun retracé
         n'a eu lieu, donc `pathCache` tient encore les courbes de l'échelle précédente. Les
         dessiner telles quelles les décalait du fond — c'était le calque qui glissait sous
         les points pendant qu'on zoomait. On leur applique le même étirement qu'à l'image. */
      if (stretch !== 1) context.scale(stretch, stretch)
      context.globalCompositeOperation = 'lighter'
      for (const entry of pathCache.current.paths.values()) {
        if (entry.group !== group) continue
        context.strokeStyle = entry.tone
        context.lineWidth = core * Math.max(1.5, WEB.bloomWidth / 2.3)
        context.globalAlpha = Math.min(0.5, edgeAlpha * 2.5)
        context.stroke(entry.path)
        context.lineWidth = core
        context.globalAlpha = Math.min(0.75, edgeAlpha * 4.5)
        context.stroke(entry.path)
      }
      context.globalCompositeOperation = 'source-over'
      context.globalAlpha = 1
      context.restore()
    }

    /**
     * Repeint un groupe **tel qu'il était**, après que l'effacement du focus l'a emporté avec
     * le reste.
     *
     * Rigoureusement les mêmes passes et les mêmes opacités que `paintWeb` : c'est là toute la
     * différence avec `lightUp`, qui *surexpose* pour désigner un amas au survol. Le focus ne
     * doit rien éclairer — il assombrit les autres, et celui qu'on regarde garde exactement la
     * luminance qu'il avait. Passer par `lightUp` rendait le groupe sélectionné éclatant, si
     * bien qu'on ne le voyait plus tel qu'il est.
     */
    const restoreGroup = (group: string, stretch = 1): void => {
      if (edgeAlpha <= 0.002 || pathCache.current.key === '') return
      context.save()
      context.translate(view.x, view.y)
      /* Pendant un geste de zoom, le fond est une recopie *étirée* du tampon : aucun retracé
         n'a eu lieu, donc `pathCache` tient encore les courbes de l'échelle précédente. Les
         dessiner telles quelles les décalait du fond — c'était le calque qui glissait sous
         les points pendant qu'on zoomait. On leur applique le même étirement qu'à l'image. */
      if (stretch !== 1) context.scale(stretch, stretch)
      context.globalCompositeOperation = 'lighter'
      for (const entry of pathCache.current.paths.values()) {
        if (entry.group !== group) continue
        context.strokeStyle = entry.tone
        if (bloom > 0.02) {
          context.lineWidth = core * WEB.bloomWidth
          context.globalAlpha = edgeAlpha * bloom * 0.5
          context.stroke(entry.path)
          context.lineWidth = core * Math.max(1.5, WEB.bloomWidth / 2.3)
          context.globalAlpha = edgeAlpha * bloom * 0.6
          context.stroke(entry.path)
        }
        context.lineWidth = core
        context.globalAlpha = edgeAlpha
        context.stroke(entry.path)
      }
      context.globalCompositeOperation = 'source-over'
      context.globalAlpha = 1
      context.restore()
    }

    /* Les points restent petits et translucides : c'est la lueur qui leur donne leur présence.
       Pleins, ils recouvraient exactement la toile qu'on veut lire.
       Rassemblés par teinte : un `fill` par couleur au lieu de neuf mille sept cent quarante-
       deux, pour la même image. */
    const paintDots = (
      target: CanvasRenderingContext2D,
      area: { left: number; top: number; right: number; bottom: number }
    ): void => {
      const fade = 0.3 + 0.7 * landing
      const full = new Map<string, Path2D>()
      const dim = new Map<string, Path2D>()
      const halosFull = new Map<string, Path2D>()
      const halosDim = new Map<string, Path2D>()
      const halo = dotRadius * (2.4 + 1.4 * closeness)
      for (const point of data.points) {
        const [x, y] = at(point)
        if (x < area.left - 8 || y < area.top - 8 || x > area.right + 8 || y > area.bottom + 8) {
          continue
        }
        const dimmed = point.group !== null && !includedGroups.has(point.group)
        const tone = colourFor(point, colourMode, groupIndex)
        const bodies = dimmed ? dim : full
        let body = bodies.get(tone)
        if (!body) {
          body = new Path2D()
          bodies.set(tone, body)
        }
        body.moveTo(x + dotRadius, y)
        body.arc(x, y, dotRadius, 0, Math.PI * 2)
        if (glow > 0.01) {
          const rings = dimmed ? halosDim : halosFull
          let ring = rings.get(tone)
          if (!ring) {
            ring = new Path2D()
            rings.set(tone, ring)
          }
          ring.moveTo(x + halo, y)
          ring.arc(x, y, halo, 0, Math.PI * 2)
        }
      }
      // Les exclus gardent leur couleur mais s'effacent : on les voit sans les lire.
      const shadeOf = (dimmed: boolean): number =>
        (WEB.dotFar + WEB.dotNear * closeness) * (dimmed ? 0.2 : 1) * fade
      target.globalCompositeOperation = 'lighter'
      for (const [rings, dimmed] of [
        [halosFull, false],
        [halosDim, true]
      ] as const) {
        target.globalAlpha = shadeOf(dimmed) * glow
        for (const [tone, path] of rings) {
          target.fillStyle = tone
          target.fill(path)
        }
      }
      target.globalCompositeOperation = 'source-over'
      for (const [bodies, dimmed] of [
        [full, false],
        [dim, true]
      ] as const) {
        target.globalAlpha = shadeOf(dimmed)
        for (const [tone, path] of bodies) {
          target.fillStyle = tone
          target.fill(path)
        }
      }
      target.globalAlpha = 1
    }

    /* Garder les chemins ne suffisait pas, et c'est ce qui laissait la carte à deux images par
       seconde : les reconstruire coûtait 100 ms une fois, mais les *tracer* en coûtait 219 à
       chaque image — trois passes sur cent trente mille courbes en mélange additif, que le
       cache de chemins ne dispense pas de repeindre.
       Toile et points sont donc peints une fois dans un canevas de côté, et le déplacement
       n'en recopie qu'une image : 4 ms au lieu de 494. Le rendu n'est pas au bit près —
       l'accumulation additive s'arrondit une fois de plus dans le tampon — mais l'écart mesuré
       est de 126 pixels sur 15 188 allumés, d'au plus 14 niveaux sur 255 : invisible. */
    // Débord du dessin autour des points : halo des fils et lueur des pastilles.
    const spill = Math.max(core * WEB.bloomWidth, dotRadius * (2.4 + 1.4 * closeness)) + 4
    const content = {
      left: originX - spill,
      top: originY - spill,
      right: originX + span + spill,
      bottom: originY + span + spill
    }
    /* Ce qu'il faut avoir peint pour que le cadre soit juste : la carte, limitée au cadre.
       Au-delà il n'y a rien à peindre, et c'est ce qui rend les recuissons rares une fois
       dézoomé — la carte entière tient alors dans le tampon. */
    /* Combien le fond peint est étiré par rapport à l'échelle courante. Vaut 1 hors geste de
       zoom, et c'est alors sans effet sur les calques. */
    let overlayStretch = 1
    const frame = { width, height, scale: view.scale, x: view.x, y: view.y }
    const needed = neededArea(frame, content)
    const painted = webCache.current
    const key = `${colourMode}|${ratio}|${[...includedGroups].sort().join(',')}`
    const usable =
      painted.canvas !== null && painted.key === key && stillCovers(painted, needed, view.scale)
    // Étirer ne vaut que le temps du geste : à l'arrêt, la toile doit être nette.
    const covers = usable && (painted.scale === view.scale || zooming)

    if (landing < 1) {
      /* Pendant l'atterrissage, les coordonnées bougent à chaque image : peindre dans un
         tampon qu'on jetterait aussitôt n'ajouterait qu'une recopie. */
      webCache.current.key = ''
      const area = { left: -view.x, top: -view.y, right: -view.x + width, bottom: -view.y + height }
      context.save()
      context.translate(view.x, view.y)
      paintWeb(context, area)
      paintDots(context, area)
      context.restore()
    } else {
      if (!covers) {
        /* On peint le cadre élargi d'une marge, recoupé au contenu : un déplacement court
           reste dedans, et ce qui déborde de la carte ne coûte rien à laisser de côté. */
        const budget = WEB_BUDGET / (ratio * ratio)
        const area = paintArea(frame, content, budget, ZOOM_HEADROOM, WEB_MARGIN)
        const bufferWidth = Math.max(1, Math.ceil(area.right - area.left))
        const bufferHeight = Math.max(1, Math.ceil(area.bottom - area.top))
        const buffer = painted.canvas ?? document.createElement('canvas')
        buffer.width = Math.ceil(bufferWidth * ratio)
        buffer.height = Math.ceil(bufferHeight * ratio)
        const paint = buffer.getContext('2d')
        if (!paint) return
        paint.setTransform(ratio, 0, 0, ratio, 0, 0)
        paint.clearRect(0, 0, bufferWidth, bufferHeight)
        paint.translate(-area.left, -area.top)
        paintWeb(paint, area)
        paintDots(paint, area)
        webCache.current = {
          key,
          canvas: buffer,
          scale: view.scale,
          left: area.left,
          top: area.top,
          width: bufferWidth,
          height: bufferHeight
        }
      }
      const web = webCache.current
      if (web.canvas) {
        /* Recopie calée sur la grille des pixels physiques. À 125 % ou 150 % — le cas courant
           sous Windows — un décalage entier en points d'interface tombe entre deux pixels de
           l'écran, et la recopie rééchantillonne : la toile deviendrait floue au déplacement,
           alors qu'elle est nette au premier tracé. */
        const zoom = web.scale > 0 ? view.scale / web.scale : 1
        overlayStretch = zoom
        const snap = (value: number): number => Math.round(value * ratio) / ratio
        context.drawImage(
          web.canvas,
          snap(web.left * zoom + view.x),
          snap(web.top * zoom + view.y),
          web.width * zoom,
          web.height * zoom
        )
      }
    }

    /* Les frontières, recopiées une fois dans le repère de la carte. Le carré unité occupe
       `size × scale` pixels à partir de l'origine de centrage — exactement la transformation
       de `at()`, donc les contours tombent sur les points qu'ils cernent. */
    if (showBoundaries && boundaryPaths.size > 0) {
      /* Tracé dans le repère unité puis mis à l'échelle : le contour reste net quel que soit
         le zoom, là où l'image de 1 024 pixels se pixellisait dès qu'on approchait. */
      context.save()
      context.translate(originX + view.x, originY + view.y)
      context.scale(span, span)
      /* Le cadre, ramené dans le repère unité : ce qui n'y touche pas ne se dessine pas.
         Une marge d'un dixième absorbe le débord des courbes au-delà de leurs sommets. */
      const seen = {
        left: (-view.x - originX) / span - 0.1,
        top: (-view.y - originY) / span - 0.1,
        right: (-view.x - originX + width) / span + 0.1,
        bottom: (-view.y - originY + height) / span + 0.1
      }
      for (const [group, entry] of boundaryPaths) {
        if (
          entry.right < seen.left ||
          entry.left > seen.right ||
          entry.bottom < seen.top ||
          entry.top > seen.bottom
        ) {
          continue
        }
        const path = entry.path
        const tone = colourOfGroup(group, groupIndex)
        context.fillStyle = tone
        context.globalAlpha = 0.1
        context.fill(path)
        context.strokeStyle = tone
        context.globalAlpha = editing === group ? 1 : 0.8
        // L'épaisseur est donnée en unités de carte : on la ramène à des pixels constants.
        context.lineWidth = (editing === group ? 3 : 1.8) / span
        context.lineJoin = 'round'
        context.stroke(path)
      }
      context.restore()
      context.globalAlpha = 1
    }

    /* Focus sur un groupe : tout s'efface sauf lui.
       L'effacement se fait en `destination-out` plutôt qu'en peignant un voile de la couleur
       du fond — on retire de l'alpha au lieu d'ajouter une couche. Deux raisons : la toile
       est peinte en `lighter` sur un canvas transparent, c'est le CSS qui donne le fond, donc
       un voile supposerait de lire `--field` et de le suivre au changement de thème ; et
       retirer l'alpha laisse le fond réel transparaître, quel qu'il soit.
       Les points sont dans le tampon, avec la toile : les griser un par un demanderait de
       retracer les 133 810 arêtes à chaque clic. On efface tout, puis on remet le groupe. */
    if (focusGroup) {
      context.save()
      context.globalCompositeOperation = 'destination-out'
      context.globalAlpha = FOCUS_FADE
      context.fillStyle = '#000'
      context.fillRect(0, 0, width, height)
      context.restore()
      restoreGroup(focusGroup, overlayStretch)
      // Les points du groupe, repeints par-dessus : ils viennent d'être effacés avec le reste.
      const bodies = new Map<string, Path2D>()
      for (const point of data.points) {
        if (point.group !== focusGroup) continue
        const [ux, uy] = at(point)
        const x = ux + view.x
        const y = uy + view.y
        if (x < -8 || y < -8 || x > width + 8 || y > height + 8) continue
        const tone = colourFor(point, colourMode, groupIndex)
        let body = bodies.get(tone)
        if (!body) {
          body = new Path2D()
          bodies.set(tone, body)
        }
        body.moveTo(x + dotRadius, y)
        body.arc(x, y, dotRadius, 0, Math.PI * 2)
      }
      context.globalCompositeOperation = 'lighter'
      // Même opacité que dans `paintDots` : on remet, on ne rehausse pas.
      context.globalAlpha = WEB.dotFar + WEB.dotNear * closeness
      for (const [tone, body] of bodies) {
        context.fillStyle = tone
        context.fill(body)
      }
      context.globalCompositeOperation = 'source-over'
      context.globalAlpha = 1
    }

    if (litGroup) lightUp(litGroup, overlayStretch)

    /* Chaque amas doit porter son nom, y compris quand deux étiquettes se gênent : la plus
       petite s'écarte de son amas avec un trait de rappel, au lieu de disparaître.
       Les amas anonymes étaient le principal reproche fait à la carte, et les faire céder
       revenait à en laisser la moitié sans nom dès qu'on dézoomait.
       Taille et rabattement repris de la maquette : la taille suit la racine du nombre de
       posts — un îlot deux fois plus gros se remarque sans écraser son voisin — et croît en
       racine du zoom, sans quoi les noms doublaient de corps à chaque cran. */
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.lineJoin = 'round'
    const drawn: { group: string; x: number; y: number; half: number; size: number }[] = []
    /* Masqués, on ne dessine rien *et* `drawn` reste vide : le survol d'un nom s'appuie
       dessus, donc il s'éteint de lui-même au lieu de réagir à des boîtes invisibles. */
    for (const island of showLabels ? islands : []) {
      const name = groupNames.get(island.group)?.trim().toLocaleLowerCase()
      if (!name) continue
      const [ux, uy] = at(island)
      const centreX = ux + view.x
      const centreY = uy + view.y
      if (centreX < -80 || centreY < -60 || centreX > width + 80 || centreY > height + 60) continue
      /* Assez gros pour se lire, pas au point de manger la carte. Les bornes précédentes —
         28 px, ×2,1 — laissaient un nom monter à 59 px : sur un gros amas, le mot couvrait le
         réseau qu'il désigne et la carte se lisait comme une affiche. La toile est le sujet,
         le nom n'est qu'une légende. */
      const size =
        Math.min(18, 10 + Math.sqrt(island.count) * 0.25) * Math.min(1.4, Math.sqrt(view.scale))
      /* Demi-largeur estimée sans `measureText` : la mesurer pour vingt-deux étiquettes à
         chaque image coûtait plus que de la deviner, et une approximation suffit à savoir
         que deux noms se chevauchent. */
      const half = (name.length * size) / 3.9
      const reach = Math.sqrt(island.count) * 1.25 * Math.min(2.6, view.scale)
      /* On tente le centre, puis on s'écarte au-dessus et en dessous. La maquette ne montait
         qu'au-dessus : sur un cadre deux fois moins haut que le sien, les noms des gros amas
         sortaient par le haut — dessinés, invisibles, et le trait de rappel pointait hors
         champ. Une place hors du cadre n'en est pas une. */
      const fits = (candidate: number): boolean =>
        candidate - size / 2 > 4 &&
        candidate + size / 2 < height - 4 &&
        !drawn.some(
          (other) =>
            Math.abs(other.x - centreX) < (other.half + half) * 0.9 &&
            Math.abs(other.y - candidate) < (other.size + size) * 0.62
        )
      let y = centreY
      for (let step = 1; !fits(y); step += 1) {
        if (step > 5) {
          y = NaN
          break
        }
        const away = reach + 12 + Math.ceil(step / 2) * (size + 7)
        y = step % 2 === 1 ? centreY - away : centreY + away
      }
      if (Number.isNaN(y)) continue
      drawn.push({ group: island.group, x: centreX, y, half, size })
      const faded = !includedGroups.has(island.group)
      context.globalAlpha = faded ? 0.28 : 1
      if (y !== centreY) {
        /* Le trait de rappel dit de quel amas le nom déplacé parle, et prend la teinte du
           groupe quel que soit le mode de couleur. Le faire passer par `colourFor` obligeait
           à fabriquer un faux point, sans plateforme, ni type, ni provenance : en mode
           « Signet / Likes », lire `sources` sur ce leurre plantait l'écran. */
        context.strokeStyle = colourOfGroup(island.group, groupIndex)
        // Un pixel à 45 % se perdait dans la toile : le trait doit se suivre à l'œil.
        context.lineWidth = 2
        context.globalAlpha = faded ? 0.3 : 0.85
        context.beginPath()
        context.moveTo(centreX, centreY + (y < centreY ? -reach : reach))
        context.lineTo(centreX, y + (y < centreY ? size / 2 : -size / 2))
        context.stroke()
        context.globalAlpha = faded ? 0.28 : 1
      }
      /* Le nom est un bouton, et rien ne le disait : cliquer dessus isole l'amas, mais aucun
         retour ne le laissait deviner — l'utilisateur n'a aucune raison d'essayer. Au survol,
         une pastille apparaît derrière le nom, et le curseur devient une main (plus bas). Le
         groupe déjà retenu la garde en permanence : c'est ce qui dit lequel est isolé. */
      const active = island.group === focusGroup
      if (island.group === hoverLabel || active) {
        const padX = size * 0.42
        const padY = size * 0.3
        const radius = size * 0.36
        context.beginPath()
        context.roundRect(
          centreX - half - padX,
          y - size / 2 - padY,
          (half + padX) * 2,
          size + padY * 2,
          radius
        )
        context.fillStyle = active ? 'rgba(255, 255, 255, 0.16)' : 'rgba(255, 255, 255, 0.09)'
        context.fill()
        context.lineWidth = 1.5
        context.strokeStyle = active
          ? colourOfGroup(island.group, groupIndex)
          : 'rgba(255, 255, 255, 0.4)'
        context.stroke()
      }
      /* Blanc et en minuscules, contour noir épais : coloré par groupe, le texte se noyait
         dans une toile déjà colorée. Le blanc tranche sur tout, la couleur reste au réseau. */
      context.font = `600 ${size.toFixed(1)}px system-ui, sans-serif`
      context.letterSpacing = '-0.02em'
      /* Le contour détache le nom sans l'épaissir : à `size / 3.2` il formait un halo noir
         plus large que les lettres, qui masquait la toile autour du mot. */
      context.lineWidth = size / 5
      context.strokeStyle = 'rgba(0, 0, 0, 0.85)'
      context.strokeText(name, centreX, y)
      context.fillStyle = '#ffffff'
      context.fillText(name, centreX, y)
      context.letterSpacing = '0px'
    }
    labelBoxes.current = drawn
    context.globalAlpha = 1

    if (hovered) {
      const [ux, uy] = at(hovered)
      const x = ux + view.x
      const y = uy + view.y
      context.globalAlpha = 1
      context.fillStyle = colourFor(hovered, colourMode, groupIndex)
      context.beginPath()
      context.arc(x, y, HOVER_DOT, 0, Math.PI * 2)
      context.fill()
      context.strokeStyle = 'rgba(255,255,255,0.9)'
      context.lineWidth = 2
      context.stroke()
    }

    const lasso = lassoRef.current
    if (lasso.length > 1) {
      context.globalAlpha = 1
      context.strokeStyle = 'rgba(255,255,255,0.85)'
      context.lineWidth = 1.5
      context.setLineDash([5, 4])
      context.beginPath()
      context.moveTo(lasso[0].x, lasso[0].y)
      for (const point of lasso.slice(1)) context.lineTo(point.x, point.y)
      context.closePath()
      context.stroke()
      context.setLineDash([])
    }
    context.globalAlpha = 1
  }, [
    colourMode,
    data.points,
    groupIndex,
    groupNames,
    hovered,
    includedGroups,
    islands,
    links,
    boundaryPaths,
    regionCentres,
    focusGroup,
    hoverLabel,
    litGroup,
    showBoundaries,
    showLabels,
    view,
    zooming
  ])

  /* La boucle d'animation lit `draw` par référence.
     En la faisant dépendre de `draw`, elle se démontait et se remontait à chaque rendu — un
     survol suffisait — et l'atterrissage restait bloqué à zéro : les 1 800 points se
     superposaient au centre exact du canvas. */
  const drawRef = useRef(draw)
  drawRef.current = draw

  useEffect(() => {
    let frame = 0
    const tick = (): void => {
      drawRef.current()
      if (landingAt() < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    /* Filet : sans composition — fenêtre masquée, onglet en arrière-plan — aucune image
       n'est demandée et la boucle ne démarre jamais. Ce dessin final garantit que la carte
       est juste quand on revient dessus. */
    const settle = setTimeout(() => drawRef.current(), LANDING_MS + 60)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(settle)
    }
  }, [data.points])

  // Tout changement d'apparence — survol, couleur, zoom, exclusion — redessine une fois.
  useEffect(() => {
    draw()
  }, [draw])

  /* Par `draw`, cet effet se redéfaisait à chaque déplacement : l'observateur se démontait
     et se remontait, et surtout `canvas.width` était réaffecté — ce qui vide la mémoire du
     canevas — puis la carte redessinée une seconde fois. Un mouvement de souris coûtait 1,7
     dessin au lieu d'un. Le dessin se lit donc par référence, et l'effet ne dépend de rien. */
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    /** Dernières dimensions connues, pour savoir de combien le cadre a changé. */
    let lastWidth = 0
    let lastHeight = 0
    const resize = (): void => {
      const ratio = window.devicePixelRatio || 1
      canvas.width = wrap.clientWidth * ratio
      canvas.height = wrap.clientHeight * ratio
      canvas.style.width = `${wrap.clientWidth}px`
      canvas.style.height = `${wrap.clientHeight}px`
      /* Rétrécir le cadre ne doit rien déplacer. Ouvrir le panneau latéral reprend de la
         largeur à la carte, et le contenu partait d'un bloc vers la gauche : la carte est
         posée à `(p.x × size + (width − size) / 2) × scale + view.x`, où le terme de centrage
         `(width − size) / 2` est **multiplié par l'échelle**. Perdre 300 px de largeur déplace
         donc tout de 150 × `scale` — 300 px à ×2, et bien davantage une fois zoomé.
         On annule exactement ce terme. Tant que le petit côté ne change pas, l'empan est
         inchangé et une translation suffit à tout figer ; sinon le repère lui-même se
         redimensionne, et on se rabat sur garder le centre du cadre. */
      const w = wrap.clientWidth
      const h = wrap.clientHeight
      if (framedRef.current && lastWidth > 0 && (w !== lastWidth || h !== lastHeight)) {
        const sizeBefore = Math.min(lastWidth, lastHeight)
        const sizeAfter = Math.min(w, h)
        const beforeWidth = lastWidth
        const beforeHeight = lastHeight
        setView((current) => {
          if (sizeBefore === sizeAfter) {
            return clamped({
              ...current,
              x: current.x + ((beforeWidth - w) / 2) * current.scale,
              y: current.y + ((beforeHeight - h) / 2) * current.scale
            })
          }
          /* Le point de la carte qui était au centre y reste. */
          const mapX =
            (beforeWidth / 2 - current.x) / current.scale - (beforeWidth - sizeBefore) / 2
          const mapY =
            (beforeHeight / 2 - current.y) / current.scale - (beforeHeight - sizeBefore) / 2
          return clamped({
            ...current,
            x: w / 2 - ((mapX / sizeBefore) * sizeAfter + (w - sizeAfter) / 2) * current.scale,
            y: h / 2 - ((mapY / sizeBefore) * sizeAfter + (h - sizeAfter) / 2) * current.scale
          })
        })
      }
      lastWidth = w
      lastHeight = h
      if (!framedRef.current && wrap.clientWidth > 0) {
        framedRef.current = true
        const box = Math.min(wrap.clientWidth, wrap.clientHeight)
        setView((current) => ({
          ...current,
          x: wrap.clientWidth / 2 - (0.5 * box + (wrap.clientWidth - box) / 2) * current.scale,
          y: wrap.clientHeight / 2 - (0.5 * box + (wrap.clientHeight - box) / 2) * current.scale
        }))
        return
      }
      drawRef.current()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [])

  const pointAt = useCallback(
    (clientX: number, clientY: number): OrganizerMapPoint | null => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      const width = rect.width
      const height = rect.height
      const size = Math.min(width, height)
      const localX = ((clientX - rect.left - view.x) / view.scale - (width - size) / 2) / size
      const localY = ((clientY - rect.top - view.y) / view.scale - (height - size) / 2) / size

      let best: OrganizerMapPoint | null = null
      let bestDistance = Infinity
      const reach = (HOVER_DOT / view.scale / size) * 1.4
      const cellX = Math.floor(localX / BUCKET)
      const cellY = Math.floor(localY / BUCKET)
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (const point of buckets.get(`${cellX + dx}:${cellY + dy}`) ?? []) {
            const distance = Math.hypot(point.x - localX, point.y - localY)
            if (distance < bestDistance && distance < reach) {
              best = point
              bestDistance = distance
            }
          }
        }
      }
      return best
    },
    [buckets, view]
  )

  /* L'infobulle se place à la main plutôt que par l'état : la position change à chaque pixel
     parcouru, et un rendu React par pixel redessinerait la carte entière. */
  const cursorRef = useRef({ x: 0, y: 0 })
  const placeTip = useCallback((clientX: number, clientY: number): void => {
    const tip = tipRef.current
    const wrap = wrapRef.current
    if (!tip || !wrap) return
    const rect = wrap.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    // Au-dessus et à droite du curseur, rabattue dans le cadre plutôt que débordante.
    tip.style.left = `${Math.max(8, Math.min(rect.width - tip.offsetWidth - 8, x + 15))}px`
    tip.style.top = `${Math.max(8, Math.min(rect.height - tip.offsetHeight - 8, y - tip.offsetHeight - 13))}px`
  }, [])

  /* Replacée une fois le contenu posé : au moment du mouvement, l'infobulle a encore la
     hauteur du point précédent — celle du cadre vide au premier survol — et se rabattait à
     côté du curseur. Le texte de l'auteur arrive plus tard encore, et la fait grandir. */
  useLayoutEffect(() => {
    if (hovered) placeTip(cursorRef.current.x, cursorRef.current.y)
  }, [hovered, detail, placeTip])

  /* Sans retenue, un geste franc emporte la carte hors du cadre et il n'y a plus rien à
     rattraper : ni bouton de recentrage, ni bord pour se repérer.
     La règle est que le centre du cadre reste posé sur la carte. Retenir un coin de la carte
     dans le cadre ne suffisait pas : les coins de l'emprise sont vides — la projection n'y met
     presque aucun point — et on se retrouvait devant du noir en croyant regarder la carte. */
  const clamped = useCallback((next: { scale: number; x: number; y: number }) => {
    const canvas = canvasRef.current
    if (!canvas) return next
    const ratio = window.devicePixelRatio || 1
    const width = canvas.width / ratio
    const height = canvas.height / ratio
    const box = Math.min(width, height)
    const span = box * next.scale
    const left = ((width - box) / 2) * next.scale
    const top = ((height - box) / 2) * next.scale
    return {
      scale: next.scale,
      x: Math.min(width / 2 - left, Math.max(width / 2 - left - span, next.x)),
      y: Math.min(height / 2 - top, Math.max(height / 2 - top - span, next.y))
    }
  }, [])

  /** Le point de la carte sous le curseur, dans le repère unité. */
  const mapPointAt = useCallback(
    (clientX: number, clientY: number): Vertex | null => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      const size = Math.min(rect.width, rect.height)
      return {
        x: ((clientX - rect.left - view.x) / view.scale - (rect.width - size) / 2) / size,
        y: ((clientY - rect.top - view.y) / view.scale - (rect.height - size) / 2) / size
      }
    },
    [view.scale, view.x, view.y]
  )

  /** La région sous le curseur, s'il y en a une. C'est elle qu'on saisit pour la retoucher. */
  const regionAt = useCallback(
    (clientX: number, clientY: number): string | null => {
      const place = mapPointAt(clientX, clientY)
      if (!place) return null
      for (const [group, rings] of regions) {
        if (rings.some((ring) => insideRing(ring, place.x, place.y))) return group
      }
      return null
    },
    [regions, mapPointAt]
  )

  /**
   * Le sommet le plus proche du curseur, dans la région retouchée.
   *
   * La tolérance est en pixels d'écran, pas en unités de carte : viser une poignée doit
   * demander la même précision de la main quel que soit le zoom.
   */
  const vertexAt = useCallback(
    (clientX: number, clientY: number): { ring: number; index: number } | null => {
      const group = editing
      const canvas = canvasRef.current
      const rings = group ? regions.get(group) : null
      if (!group || !canvas || !rings) return null
      const place = mapPointAt(clientX, clientY)
      if (!place) return null
      const rect = canvas.getBoundingClientRect()
      const size = Math.min(rect.width, rect.height)
      const tolerance = 11 / (size * view.scale)
      let best: { ring: number; index: number } | null = null
      let bestDistance = tolerance
      rings.forEach((ring, ringIndex) => {
        ring.forEach((vertex, index) => {
          const distance = Math.hypot(vertex.x - place.x, vertex.y - place.y)
          if (distance < bestDistance) {
            bestDistance = distance
            best = { ring: ringIndex, index }
          }
        })
      })
      return best
    },
    [editing, regions, mapPointAt, view.scale]
  )

  /** Déplace le sommet saisi. La courbe suit, puisqu'elle passe par les sommets. */
  const moveVertex = useCallback(
    (clientX: number, clientY: number): void => {
      const group = editing
      const held = draggedVertexRef.current
      if (!group || !held) return
      const place = mapPointAt(clientX, clientY)
      if (!place) return
      setRegions((current) => {
        const rings = current.get(group)
        if (!rings) return current
        const nextRings = rings.map((ring, ringIndex) =>
          ringIndex === held.ring
            ? ring.map((vertex, index) => (index === held.index ? place : vertex))
            : ring
        )
        const copy = new Map(current)
        copy.set(group, nextRings)
        /* La frontière d'en face recule. Sans cela, avancer sur son voisin laissait deux
           contours superposés, et un post pris dans les deux sans propriétaire. */
        for (const [other, otherRings] of current) {
          if (other === group) continue
          copy.set(other, carveOutside(otherRings, nextRings))
        }
        return copy
      })
    },
    [editing, mapPointAt]
  )

  /** Fin du geste : on remonte la région et ce qu'elle contient désormais. */
  const commitRegion = useCallback((): void => {
    const group = editing
    if (!group) return
    const rings = regions.get(group)
    if (!rings) return
    const inside = data.points
      .filter((point) => rings.some((ring) => insideRing(ring, point.x, point.y)))
      .map((point) => point.id)
    onBoundaryChange(group, rings, inside)
  }, [editing, regions, data.points, onBoundaryChange])

  /** Le nom d'amas sous le curseur, s'il y en a un. */
  const labelAt = useCallback((clientX: number, clientY: number): string | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    for (const box of labelBoxes.current) {
      if (Math.abs(box.x - x) < box.half + 6 && Math.abs(box.y - y) < box.size * 0.8) {
        return box.group
      }
    }
    return null
  }, [])

  const onPointerDown = (event: React.PointerEvent): void => {
    try {
      ;(event.target as Element).setPointerCapture?.(event.pointerId)
    } catch {
      /* Pointeur déjà relâché ou identifiant inconnu : la capture est un confort, pas un dû. */
    }
    if (event.shiftKey || event.button === 2) {
      lassoActiveRef.current = true
      setLassoing(true)
      const rect = canvasRef.current?.getBoundingClientRect()
      lassoRef.current = [
        { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
      ]
    } else {
      /* La carte est statique : les points ne se tirent plus. Un appui sur un point retient
         seulement de quoi savoir, au relâchement, s'il s'agissait d'un clic ou d'un
         déplacement de la carte.
         Le nom passe devant : un titre repose presque toujours sur son propre amas, donc un
         point se trouvait sous le curseur une fois sur deux et c'est lui qui l'emportait —
         viser le nom devenait un jeu d'adresse. Rien n'est perdu à le prioriser : le point
         reste atteignable partout ailleurs, et les noms se masquent. */
      /* En retouche, l'appui commence un coup de pinceau au lieu de saisir la carte.
         Bouton droit ou touche Alt : on creuse au lieu de pousser. */
      if (editing) {
        const grabbed = vertexAt(event.clientX, event.clientY)
        if (grabbed) {
          draggedVertexRef.current = grabbed
          return
        }
      }
      const overLabel = labelAt(event.clientX, event.clientY)
      clickedRef.current = overLabel ? null : pointAt(event.clientX, event.clientY)
      draggingRef.current = { x: event.clientX - view.x, y: event.clientY - view.y, moved: false }
    }
  }

  const onPointerMove = (event: React.PointerEvent): void => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (lassoActiveRef.current) {
      lassoRef.current.push({
        x: event.clientX - (rect?.left ?? 0),
        y: event.clientY - (rect?.top ?? 0)
      })
      draw()
      return
    }
    if (draggedVertexRef.current) {
      moveVertex(event.clientX, event.clientY)
      return
    }
    const dragging = draggingRef.current
    if (dragging) {
      dragging.moved = true
      setView((current) =>
        clamped({ ...current, x: event.clientX - dragging.x, y: event.clientY - dragging.y })
      )
      return
    }
    const overLabel = labelAt(event.clientX, event.clientY)
    /* Le nom couvre le point, au survol comme au clic. Sans ça l'infobulle proposait un post
       qu'un clic n'ouvrait plus — elle annonçait une action que le curseur ne ferait pas. */
    const found = overLabel ? null : pointAt(event.clientX, event.clientY)
    if (found?.id !== hovered?.id) {
      setHovered(found)
      onHover(found)
    }
    /* Survoler un nom éclaire son amas, comme un point : c'est souvent le nom qu'on vise,
       et il est bien plus facile à viser qu'une pastille d'un demi-pixel. */
    if (overLabel !== hoverLabel) setHoverLabel(overLabel)
    const lit = found?.group ?? overLabel
    if (lit !== litGroup) setLitGroup(lit)
    cursorRef.current = { x: event.clientX, y: event.clientY }
    if (found) placeTip(event.clientX, event.clientY)
  }

  const onPointerUp = (): void => {
    if (draggedVertexRef.current) {
      draggedVertexRef.current = null
      commitRegion()
      return
    }
    if (lassoActiveRef.current) {
      const path = lassoRef.current
      lassoRef.current = []
      lassoActiveRef.current = false
      setLassoing(false)
      if (path.length > 3) onLasso(idsInside(path))
      draw()
    }
    // Relâché sans avoir déplacé la carte : c'était un clic sur un point.
    const still = draggingRef.current && !draggingRef.current.moved
    if (clickedRef.current && still) {
      onOpen(clickedRef.current)
    } else if (still) {
      /* Clic sur un nom : on retient le groupe et tout le reste s'efface. Ailleurs dans le
         vide : on relâche. Le nom sert de poignée parce qu'un point a déjà son geste — il
         ouvre le post — et qu'on ne peut pas faire dire deux choses au même clic. */
      const name = labelAt(cursorRef.current.x, cursorRef.current.y)
      setFocusGroup((current) => (name && name !== current ? name : null))
      /* On ne quitte la retouche qu'en cliquant hors de toute région : la quitter dès qu'un
         clic tombait à côté d'un sommet obligeait à re-double-cliquer entre chaque
         déplacement, ce qui rendait l'outil inutilisable. */
      if (!regionAt(cursorRef.current.x, cursorRef.current.y)) setEditing(null)
    }
    clickedRef.current = null
    draggingRef.current = null
  }

  /** Test du point dans le polygone, par lancer de rayon. */
  const idsInside = (path: { x: number; y: number }[]): string[] => {
    const canvas = canvasRef.current
    if (!canvas) return []
    const rect = canvas.getBoundingClientRect()
    const size = Math.min(rect.width, rect.height)
    const inside: string[] = []
    for (const point of data.points) {
      const x = (point.x * size + (rect.width - size) / 2) * view.scale + view.x
      const y = (point.y * size + (rect.height - size) / 2) * view.scale + view.y
      let hit = false
      for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
        const intersects =
          path[i].y > y !== path[j].y > y &&
          x < ((path[j].x - path[i].x) * (y - path[i].y)) / (path[j].y - path[i].y) + path[i].x
        if (intersects) hit = !hit
      }
      if (hit) inside.push(point.id)
    }
    return inside
  }

  zoomRef.current = (event: WheelEvent): void => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    setZooming(true)
    window.clearTimeout(zoomTimer.current)
    zoomTimer.current = window.setTimeout(() => setZooming(false), 140)
    const pointerX = event.clientX - rect.left
    const pointerY = event.clientY - rect.top
    setView((current) => {
      /* Plancher à ×2 : plus loin, cent trente mille arêtes se superposent au point que la
         carte redevient une nappe informe. Mieux vaut interdire l'échelle que la montrer. */
      const next = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, current.scale * (event.deltaY < 0 ? 1.16 : 0.862))
      )
      const factor = next / current.scale
      // Le zoom s'accroche au curseur : sans cela, la zone regardée s'échappe à chaque cran.
      return clamped({
        scale: next,
        x: pointerX - (pointerX - current.x) * factor,
        y: pointerY - (pointerY - current.y) * factor
      })
    })
  }

  const hoveredGroupName = hovered?.group ? groupNames.get(hovered.group)?.trim() : ''

  return (
    <div className="organizer-map" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className={`${lassoing ? 'is-lassoing' : ''}${hoverLabel ? ' is-over-label' : ''}${editing ? ' is-editing' : ''}`.trim()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          setHovered(null)
          setLitGroup(null)
          setHoverLabel(null)
          onHover(null)
          draggingRef.current = null
          clickedRef.current = null
        }}
        onDoubleClick={(event) => {
          /* Double-clic dans une région : on retouche sa frontière.
             C'était le nom qui servait de poignée, et c'était un piège : afficher les
             frontières éteint les noms, donc il ne restait aucune boîte à viser — le geste
             disparaissait à l'instant où l'on affichait ce qu'on voulait retoucher. La
             région, elle, est toujours là. */
          const group = regionAt(event.clientX, event.clientY)
          if (!group) return
          setFocusGroup(group)
          setEditing((current) => (current === group ? null : group))
        }}
        onContextMenu={(event) => event.preventDefault()}
      />
      {/* L'infobulle de la maquette, qui suit le curseur : la vignette posée dans un coin
          obligeait à quitter le point des yeux pour lire ce qu'il était. */}
      <div
        ref={tipRef}
        className={`map-tip${hovered ? ' is-on' : ''}`}
        role="tooltip"
        aria-hidden={!hovered}
      >
        {hovered ? (
          <>
            <div className="map-tip__who">
              <span
                className="map-tip__swatch"
                style={{ background: colourFor(hovered, colourMode, groupIndex) }}
              />
              {/* Le nom de l'amas tient lieu de titre le temps que l'auteur arrive : ouvrir sur
                  un vide, puis le remplir, faisait sauter l'infobulle sous le curseur. Une
                  catégorie qu'on est en train de renommer n'a pas de nom du tout — l'infobulle
                  s'ouvrait alors sur une pastille de couleur et rien d'autre. */}
              <span className="map-tip__title">
                {detail?.title ?? (hoveredGroupName || t('organizer.unassigned'))}
              </span>
              {detail && hoveredGroupName ? (
                <span className="map-tip__group">· {hoveredGroupName}</span>
              ) : null}
            </div>
            {hovered.thumbUrl ? <img src={hovered.thumbUrl} alt="" aria-hidden="true" /> : null}
            {detail?.text ? <p className="map-tip__text">{detail.text}</p> : null}
          </>
        ) : null}
      </div>
      <p className="organizer-map__hint">{t('organizer.mapHint')}</p>
    </div>
  )
}
