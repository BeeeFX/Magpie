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

const DOT = 3
const HOVER_DOT = 7
/** Grille de recherche du point sous le curseur : un balayage linéaire de 9 738 points à
 *  chaque mouvement de souris coûterait plus cher que le dessin lui-même. */
const BUCKET = 0.02

export type ColourMode = 'group' | 'platform' | 'kind' | 'source'

interface Props {
  data: MapData
  colourMode: ColourMode
  /** Groupes retenus, pour griser ce qui est exclu sans le faire disparaître. */
  includedGroups: Set<string>
  onLasso(ids: string[]): void
  onHover(point: OrganizerMapPoint | null): void
}

/** Teintes bien séparées, reprises de la palette d'étiquettes : lisibles en clair et sombre. */
const PALETTE = [
  '#e0574f', '#e08a30', '#d9b330', '#5aa85a', '#4a90d9',
  '#8a6ad9', '#c96aa8', '#3fa9a0', '#a8873f', '#6f7ad9'
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
  onLasso,
  onHover
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

    for (const point of data.points) {
      const [x, y] = toScreen(point)
      if (x < -8 || y < -8 || x > width + 8 || y > height + 8) continue
      const dimmed = point.group !== null && !includedGroups.has(point.group)
      context.globalAlpha = dimmed ? 0.18 : 0.85 * (0.3 + 0.7 * landing)
      context.fillStyle = colourFor(point, colourMode, groupIndex)
      context.beginPath()
      context.arc(x, y, DOT * Math.min(2.5, view.scale), 0, Math.PI * 2)
      context.fill()
    }

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
  }, [colourMode, data.points, groupIndex, hovered, includedGroups, view])

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

  const onWheel = (event: React.WheelEvent): void => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const pointerX = event.clientX - rect.left
    const pointerY = event.clientY - rect.top
    setView((current) => {
      const next = Math.min(12, Math.max(0.6, current.scale * (event.deltaY < 0 ? 1.12 : 0.89)))
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
        }}
        onWheel={onWheel}
        onContextMenu={(event) => event.preventDefault()}
      />
      {hovered?.thumbUrl ? (
        <img className="organizer-map__peek" src={hovered.thumbUrl} alt="" aria-hidden="true" />
      ) : null}
      <p className="organizer-map__hint">{t('organizer.mapHint')}</p>
    </div>
  )
}
