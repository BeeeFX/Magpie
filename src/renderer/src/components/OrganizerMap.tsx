import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OrganizerMap as MapData, OrganizerMapPoint } from '@shared/types'
import { useT } from '../store'

/**
 * La carte sémantique.
 *
 * Un point par post, placé par la projection des vecteurs : la distance à l'écran *est* la
 * proximité de sens, donc les îles sont réelles. Le rebond — inertie, zoom élastique,
 * frémissement au survol, atterrissage en cascade — est de l'interaction posée par-dessus des
 * positions qui ne bougent jamais. Une simulation à ressorts aurait fait l'inverse : de jolies
 * îles qui ne montrent que la physique.
 *
 * Rendu en canvas. Neuf mille points en DOM ou en SVG ne tiennent pas les 60 images par
 * seconde ; en canvas, c'est confortable.
 */

const HOVER_DOT = 7
/** Grille de recherche du point sous le curseur : un balayage linéaire de 9 738 points à
 *  chaque mouvement de souris coûterait plus cher que le dessin lui-même. */
const BUCKET = 0.02
/** Rayon de voisinage pour les liens, dans le repère unité de la carte. */
const LINK_RADIUS = 0.022
/** Au-delà, la toile devient une bouillie : on garde les plus proches. */
/* Vingt-quatre voisins : mesuré sur la bibliothèque de référence, sans plafond le voisinage
   par rayon produit 465 872 arêtes et le mélange additif sature en blanc dans les zones
   denses. Vingt-quatre en garde 133 814 — la texture partout, sans les points chauds. */
const LINKS_PER_POINT = 24
/** En deçà, le rendu se casse : la toile s'agglomère et plus rien ne se distingue. */
const MIN_SCALE = 2

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
  onLasso(ids: string[]): void
  onHover(point: OrganizerMapPoint | null): void
  /** Clic sur un point : ouvrir le post qu'il représente. */
  onOpen(point: OrganizerMapPoint): void
}

/** Teintes bien séparées, reprises de la palette d'étiquettes : lisibles en clair et sombre. */
/* Palette saturée, reprise de la maquette : celle des étiquettes de l'interface est sourde à
   dessein, et sur fond noir elle rendait les amas indistincts. */
const PALETTE = [
  '#ff5c5c', '#ff9f43', '#ffd93d', '#4ade80', '#38bdf8', '#a78bfa', '#f472b6', '#2dd4bf',
  '#c9a227', '#818cf8', '#fb7185', '#34d399', '#e879f9', '#a3e635', '#60a5fa', '#fde047',
  '#c084fc', '#22d3ee', '#f87171', '#86efac', '#f0abfc', '#94a3b8'
]

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
  const index = point.group ? groupIndex.get(point.group) : undefined
  return index === undefined ? '#7b7b85' : PALETTE[index % PALETTE.length]
}

export function OrganizerMap({
  data,
  colourMode,
  includedGroups,
  groupNames,
  onLasso,
  onHover,
  onOpen
}: Props): React.JSX.Element {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const [hovered, setHovered] = useState<OrganizerMapPoint | null>(null)
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
  const pathCache = useRef<{ key: string; paths: Map<string, Path2D> }>({ key: '', paths: new Map() })

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
    return () => canvas.removeEventListener('wheel', handler)
  }, [])

  const groupIndex = useMemo(
    () => new Map(data.plan.suggestions.map((suggestion, index) => [suggestion.id, index])),
    [data.plan.suggestions]
  )

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
  const links = useMemo(() => {
    const pairs: [OrganizerMapPoint, OrganizerMapPoint][] = []
    for (const point of data.points) {
      const near: { other: OrganizerMapPoint; distance: number }[] = []
      const cellX = Math.floor(point.x / BUCKET)
      const cellY = Math.floor(point.y / BUCKET)
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (const other of buckets.get(`${cellX + dx}:${cellY + dy}`) ?? []) {
            if (other.id <= point.id) continue
            const distance = Math.hypot(other.x - point.x, other.y - point.y)
            if (distance < LINK_RADIUS) near.push({ other, distance })
          }
        }
      }
      near.sort((left, right) => left.distance - right.distance)
      for (const entry of near.slice(0, LINKS_PER_POINT)) pairs.push([point, entry.other])
    }
    return pairs
  }, [buckets, data.points])

  /* Sans étiquettes, neuf mille points colorés ne sont qu'une tache : on voit qu'il y a des
     amas, jamais lesquels. C'est ce qui sépare une jolie image d'une carte. */
  const islands = useMemo(() => {
    const sums = new Map<string, { x: number; y: number; count: number }>()
    for (const point of data.points) {
      if (!point.group) continue
      const entry = sums.get(point.group) ?? { x: 0, y: 0, count: 0 }
      entry.x += point.x
      entry.y += point.y
      entry.count += 1
      sums.set(point.group, entry)
    }
    return [...sums.entries()]
      .filter(([, entry]) => entry.count >= 12)
      .map(([group, entry]) => ({
        group,
        x: entry.x / entry.count,
        y: entry.y / entry.count,
        count: entry.count
      }))
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
    const toScreen = (point: OrganizerMapPoint): [number, number] => {
      // L'atterrissage tire les points depuis le centre : ils se posent au lieu de surgir.
      const eased = 1 - Math.pow(1 - landing, 3)
      const cx = 0.5 + (point.x - 0.5) * eased
      const cy = 0.5 + (point.y - 0.5) * eased
      return [
        (cx * size + (width - size) / 2) * view.scale + view.x,
        (cy * size + (height - size) / 2) * view.scale + view.y
      ]
    }

    const closeness = Math.min(1, (view.scale - 1) / WEB.nearAt)

    /* La toile, en deux passes par couleur : un tracé large et très faible qui fait la lueur,
       puis le fil net. Un chemin par couleur et non par arête — cent trente mille appels à
       `stroke` était le vrai coût, pas les courbes. */
    const edgeAlpha =
      (WEB.edgeFar + WEB.edgeNear * closeness) /
      Math.sqrt(Math.max(1, links.length / WEB.reference))
    if (edgeAlpha > 0.002) {
      context.globalCompositeOperation = 'lighter'
      const core = WEB.lineFar + WEB.lineNear * closeness
      const bloom = WEB.bloomFar + (WEB.bloomNear - WEB.bloomFar) * closeness
      /* Les chemins ne dépendent que de l'échelle et de la traction : déplacer la carte est
         une translation pure. Les rebâtir à chaque image coûtait cent trente mille courbes
         pour rien — on les garde et on translate le canevas, à rendu identique. */
      /* `landing` anime les coordonnées à l'ouverture : l'oublier ici gardait des chemins
         périmés, ou les reconstruisait sans fin. Il se stabilise à 1, la clé aussi. */
      const signature = `${view.scale}:${landing.toFixed(3)}`
      if (pathCache.current.key !== signature) {
        const built = new Map<string, Path2D>()
        for (const [from, to] of links) {
          const [ax, ay] = toScreen(from)
          const [bx, by] = toScreen(to)
          const x1 = ax - view.x, y1 = ay - view.y, x2 = bx - view.x, y2 = by - view.y
          const tone = colourFor(from, colourMode, groupIndex)
          let path = built.get(tone)
          if (!path) { path = new Path2D(); built.set(tone, path) }
          path.moveTo(x1, y1)
          path.quadraticCurveTo(
            (x1 + x2) / 2 - (y2 - y1) * 0.26,
            (y1 + y2) / 2 + (x2 - x1) * 0.26,
            x2,
            y2
          )
        }
        pathCache.current = { key: signature, paths: built }
      }
      const paths = pathCache.current.paths
      context.save()
      context.translate(view.x, view.y)
      const unusedLoop = (): void => {
      for (const [from, to] of links) {
        const [x1, y1] = toScreen(from)
        const [x2, y2] = toScreen(to)
        // Écarter seulement si les deux bouts sortent du même côté : ne tester que le premier
        // effaçait la moitié de la toile dès qu'on zoomait.
        if (
          (x1 < -40 && x2 < -40) || (x1 > width + 40 && x2 > width + 40) ||
          (y1 < -40 && y2 < -40) || (y1 > height + 40 && y2 > height + 40)
        ) continue
        const tone = colourFor(from, colourMode, groupIndex)
        let path = paths.get(tone)
        if (!path) { path = new Path2D(); paths.set(tone, path) }
        path.moveTo(x1, y1)
        path.quadraticCurveTo(
          (x1 + x2) / 2 - (y2 - y1) * 0.26,
          (y1 + y2) / 2 + (x2 - x1) * 0.26,
          x2,
          y2
        )
      }
      }
      void unusedLoop
      for (const [tone, path] of paths) {
        context.strokeStyle = tone
        if (bloom > 0.02) {
          context.lineWidth = core * WEB.bloomWidth
          context.globalAlpha = edgeAlpha * bloom * 0.5
          context.stroke(path)
          context.lineWidth = core * Math.max(1.5, WEB.bloomWidth / 2.3)
          context.globalAlpha = edgeAlpha * bloom * 0.6
          context.stroke(path)
        }
        context.lineWidth = core
        context.globalAlpha = edgeAlpha
        context.stroke(path)
      }
      context.restore()
      context.globalCompositeOperation = 'source-over'
      context.globalAlpha = 1
    }

    /* Les points restent petits et translucides : c'est la lueur qui leur donne leur
       présence. Pleins, ils recouvraient exactement la toile qu'on veut lire. */
    const dotRadius = WEB.dotSizeFar + WEB.dotSizeNear * closeness
    for (const point of data.points) {
      const [x, y] = toScreen(point)
      if (x < -8 || y < -8 || x > width + 8 || y > height + 8) continue
      const dimmed = point.group !== null && !includedGroups.has(point.group)
      const shade =
        (WEB.dotFar + WEB.dotNear * closeness) * (dimmed ? 0.2 : 1) * (0.3 + 0.7 * landing)
      const tone = colourFor(point, colourMode, groupIndex)
      context.fillStyle = tone
      const glow = WEB.dotGlowFar + WEB.dotGlowNear * closeness
      if (glow > 0.01) {
        context.globalCompositeOperation = 'lighter'
        context.globalAlpha = shade * glow
        context.beginPath()
        context.arc(x, y, dotRadius * (2.4 + 1.4 * closeness), 0, Math.PI * 2)
        context.fill()
        context.globalCompositeOperation = 'source-over'
      }
      context.globalAlpha = shade
      context.beginPath()
      context.arc(x, y, dotRadius, 0, Math.PI * 2)
      context.fill()
    }
    context.globalAlpha = 1

    /* Taille proportionnelle à la racine du nombre de posts : un îlot deux fois plus gros
       n'écrase pas son voisin, il se remarque simplement davantage. */
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    const drawn: { x: number; y: number; size: number }[] = []
    for (const island of islands) {
      const name = groupNames.get(island.group)
      if (!name) continue
      const [x, y] = toScreen({ x: island.x, y: island.y } as OrganizerMapPoint)
      if (x < 0 || y < 0 || x > width || y > height) continue
      const size = Math.min(30, 9 + Math.sqrt(island.count) * 1.5) * Math.min(1.6, view.scale)
      // Deux étiquettes superposées ne se lisent ni l'une ni l'autre : la plus petite cède.
      if (drawn.some((other) => Math.hypot(other.x - x, other.y - y) < (other.size + size) * 1.1)) {
        continue
      }
      drawn.push({ x, y, size })
      const faded = !includedGroups.has(island.group)
      /* Blanc et en minuscules, contour noir épais : coloré par groupe, le texte se noyait
         dans une toile déjà colorée. Le blanc tranche sur tout, la couleur reste au réseau. */
      context.font = `600 ${size.toFixed(1)}px system-ui, sans-serif`
      context.letterSpacing = '-0.02em'
      context.globalAlpha = faded ? 0.28 : 1
      context.lineJoin = 'round'
      context.lineWidth = size / 3.2
      context.strokeStyle = 'rgba(0, 0, 0, 0.85)'
      context.strokeText(name.toLocaleLowerCase(), x, y)
      context.fillStyle = '#ffffff'
      context.fillText(name.toLocaleLowerCase(), x, y)
      context.letterSpacing = '0px'
    }
    context.globalAlpha = 1

    if (hovered) {
      const [x, y] = toScreen(hovered)
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
  }, [colourMode, data.points, groupIndex, groupNames, hovered, includedGroups, islands, links, view])

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

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const resize = (): void => {
      const ratio = window.devicePixelRatio || 1
      canvas.width = wrap.clientWidth * ratio
      canvas.height = wrap.clientHeight * ratio
      canvas.style.width = `${wrap.clientWidth}px`
      canvas.style.height = `${wrap.clientHeight}px`
      draw()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [draw])

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
         déplacement de la carte. */
      clickedRef.current = pointAt(event.clientX, event.clientY)
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
    const dragging = draggingRef.current
    if (dragging) {
      dragging.moved = true
      setView((current) => ({
        ...current,
        x: event.clientX - dragging.x,
        y: event.clientY - dragging.y
      }))
      return
    }
    const found = pointAt(event.clientX, event.clientY)
    if (found?.id !== hovered?.id) {
      setHovered(found)
      onHover(found)
    }
  }

  const onPointerUp = (): void => {
    if (lassoActiveRef.current) {
      const path = lassoRef.current
      lassoRef.current = []
      lassoActiveRef.current = false
      setLassoing(false)
      if (path.length > 3) onLasso(idsInside(path))
      draw()
    }
    // Relâché sans avoir déplacé la carte : c'était un clic sur un point.
    if (clickedRef.current && draggingRef.current && !draggingRef.current.moved) {
      onOpen(clickedRef.current)
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
    const pointerX = event.clientX - rect.left
    const pointerY = event.clientY - rect.top
    setView((current) => {
      /* Plancher à ×2 : plus loin, cent trente mille arêtes se superposent au point que la
         carte redevient une nappe informe. Mieux vaut interdire l'échelle que la montrer. */
      const next = Math.min(12, Math.max(MIN_SCALE, current.scale * (event.deltaY < 0 ? 1.12 : 0.89)))
      const factor = next / current.scale
      // Le zoom s'accroche au curseur : sans cela, la zone regardée s'échappe à chaque cran.
      return {
        scale: next,
        x: pointerX - (pointerX - current.x) * factor,
        y: pointerY - (pointerY - current.y) * factor
      }
    })
  }

  return (
    <div className="organizer-map" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className={lassoing ? 'is-lassoing' : ''}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          setHovered(null)
          onHover(null)
          draggingRef.current = null
          clickedRef.current = null
        }}
        onContextMenu={(event) => event.preventDefault()}
      />
      {hovered?.thumbUrl ? (
        <img className="organizer-map__peek" src={hovered.thumbUrl} alt="" aria-hidden="true" />
      ) : null}
      <p className="organizer-map__hint">{t('organizer.mapHint')}</p>
    </div>
  )
}
