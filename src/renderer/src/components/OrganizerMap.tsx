import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { OrganizerMap as MapData, OrganizerMapPoint } from '@shared/types'
import { useT } from '../store'

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
/** Plafond de zoom, comme la maquette : au-delà on ne lit plus que quelques points isolés. */
const MAX_SCALE = 24
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

const PALETTE = [
  '#ff5c5c', '#ff9f43', '#ffd93d', '#4ade80', '#38bdf8', '#a78bfa', '#f472b6', '#2dd4bf',
  '#c9a227', '#818cf8', '#fb7185', '#34d399', '#e879f9', '#a3e635', '#60a5fa', '#fde047',
  '#c084fc', '#22d3ee', '#f87171', '#86efac', '#f0abfc', '#94a3b8'
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
  /** Où les noms ont été posés au dernier dessin, pour pouvoir les survoler. */
  const labelBoxes = useRef<{ group: string; x: number; y: number; half: number; size: number }[]>(
    []
  )
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
    const lightUp = (group: string): void => {
      if (edgeAlpha <= 0.002 || pathCache.current.key === '') return
      context.save()
      context.translate(view.x, view.y)
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
    const span = size * view.scale
    const originX = ((width - size) / 2) * view.scale
    const originY = ((height - size) / 2) * view.scale
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
    const needed = {
      left: Math.max(content.left, -view.x),
      top: Math.max(content.top, -view.y),
      right: Math.min(content.right, -view.x + width),
      bottom: Math.min(content.bottom, -view.y + height)
    }
    const painted = webCache.current
    const key = `${colourMode}|${ratio}|${[...includedGroups].sort().join(',')}`
    /* L'espace de la carte grandit proportionnellement à l'échelle : une zone peinte à `S0`
       couvre, à l'échelle `S`, la même zone multipliée par `S / S0`. */
    const stretch = painted.scale > 0 ? view.scale / painted.scale : 0
    const usable =
      painted.canvas !== null &&
      painted.key === key &&
      (needed.right <= needed.left ||
        (painted.left * stretch <= needed.left &&
          painted.top * stretch <= needed.top &&
          (painted.left + painted.width) * stretch >= needed.right &&
          (painted.top + painted.height) * stretch >= needed.bottom))
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
        const sum = width + height
        const room = Math.sqrt(Math.max(0, sum * sum - 4 * (width * height - budget)))
        const margin = Math.max(0, Math.min(WEB_MARGIN, (room - sum) / 4))
        const area = {
          left: Math.max(content.left, -view.x - margin),
          top: Math.max(content.top, -view.y - margin),
          right: Math.min(content.right, -view.x + width + margin),
          bottom: Math.min(content.bottom, -view.y + height + margin)
        }
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

    if (litGroup) lightUp(litGroup)

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
    for (const island of islands) {
      const name = groupNames.get(island.group)?.trim().toLocaleLowerCase()
      if (!name) continue
      const [ux, uy] = at(island)
      const centreX = ux + view.x
      const centreY = uy + view.y
      if (centreX < -80 || centreY < -60 || centreX > width + 80 || centreY > height + 60) continue
      const size =
        Math.min(28, 11 + Math.sqrt(island.count) * 0.4) * Math.min(2.1, Math.sqrt(view.scale))
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
      /* Blanc et en minuscules, contour noir épais : coloré par groupe, le texte se noyait
         dans une toile déjà colorée. Le blanc tranche sur tout, la couleur reste au réseau. */
      context.font = `600 ${size.toFixed(1)}px system-ui, sans-serif`
      context.letterSpacing = '-0.02em'
      context.lineWidth = size / 3.2
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
    litGroup,
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
    const resize = (): void => {
      const ratio = window.devicePixelRatio || 1
      canvas.width = wrap.clientWidth * ratio
      canvas.height = wrap.clientHeight * ratio
      canvas.style.width = `${wrap.clientWidth}px`
      canvas.style.height = `${wrap.clientHeight}px`
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
      setView((current) =>
        clamped({ ...current, x: event.clientX - dragging.x, y: event.clientY - dragging.y })
      )
      return
    }
    const found = pointAt(event.clientX, event.clientY)
    if (found?.id !== hovered?.id) {
      setHovered(found)
      onHover(found)
    }
    /* Survoler un nom éclaire son amas, comme un point : c'est souvent le nom qu'on vise,
       et il est bien plus facile à viser qu'une pastille d'un demi-pixel. */
    const lit = found?.group ?? labelAt(event.clientX, event.clientY)
    if (lit !== litGroup) setLitGroup(lit)
    cursorRef.current = { x: event.clientX, y: event.clientY }
    if (found) placeTip(event.clientX, event.clientY)
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
        className={lassoing ? 'is-lassoing' : ''}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          setHovered(null)
          setLitGroup(null)
          onHover(null)
          draggingRef.current = null
          clickedRef.current = null
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
