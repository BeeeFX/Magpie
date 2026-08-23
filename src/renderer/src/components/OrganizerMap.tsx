import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { OrganizerMap as MapData, OrganizerMapPoint } from '@shared/types'
import { useT } from '../store'
import { neededArea, paintArea, stillCovers, ZOOM_HEADROOM } from '../map-coverage'
import * as perf from '../perf'
import { edgeKeep, edgeKept, REFERENCE_FRAME, WEB, webTuning } from '../map-render'

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

/**
 * Ce qu'une étiquette posée à la main retient, et le minimum qu'il lui en faut.
 *
 * Les deux ensemble : on ramasse les voisins proches au moment de la pose, et on cesse de la
 * dessiner s'il en reste moins que ce minimum à l'écran. Un seul endroit, parce que la pose et
 * l'affichage doivent s'accorder — accepter d'en créer une sur trois voisins puis la montrer
 * sur un seul reviendrait à nommer le vide.
 */
const LABEL_RADIUS = 0.08
const LABEL_ANCHORS = 24
const LABEL_MIN_ANCHORS = 3
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
/** Plafond du tampon, en pixels physiques. Sur un grand écran à 200 %, le cadre plus sa marge
 *  dépasserait les cent mégaoctets : on rogne alors la marge, pas la mémoire. */
const WEB_BUDGET = 24_000_000

/** Portée du ressort quand on tire un point : ses voisins suivent, de moins en moins. */

export type ColourMode = 'group' | 'platform' | 'kind' | 'source' | 'collection'

interface Props {
  data: MapData
  colourMode: ColourMode
  /** Groupes retenus, pour griser ce qui est exclu sans le faire disparaître. */
  includedGroups: Set<string>
  /** Nom de chaque groupe, pour poser une étiquette sur son îlot. */
  groupNames: Map<string, string>
  /** Les noms d'amas sont-ils dessinés ? Masqués, la toile se voit entière. */
  showLabels: boolean
  /**
   * Étiquettes posées à la main, accrochées à des posts.
   *
   * Elles ne portent pas de position : on la recalcule au centre de gravité de leurs ancres.
   * C'est ce qui leur permet de survivre à une reprojection en continuant de nommer le même
   * contenu — une étiquette figée en coordonnées désignerait le voisin.
   */
  ownLabels?: { id: string; text: string; anchors: string[] }[]
  /**
   * Le nuage entier, filtres compris — uniquement pour placer les étiquettes.
   *
   * Sans lui, leur centre de gravité se calculait sur les seuls points survivants : choisir une
   * collection déplaçait une étiquette au barycentre de ce qu'il en restait, et elle finissait
   * par nommer autre chose. Un filtre change ce qu'on regarde, pas où sont les endroits.
   */
  allPoints?: OrganizerMapPoint[]
  /** Double-clic dans le vide : l'appelant propose de nommer l'endroit. */
  onPlaceLabel?(anchors: string[]): void
  /**
   * Le prochain clic pose une étiquette au lieu de saisir la carte.
   *
   * Le geste existait — double-clic hors de toute région — et personne ne pouvait le
   * découvrir : rien ne l'annonçait, et il s'éteignait dès qu'on affichait les frontières,
   * puisque le pavage couvre tout et qu'aucun point de la carte n'est plus « hors région ».
   * Un mode armé depuis un bouton le rend visible, et le rend accessible partout.
   */
  /** Retirer une étiquette posée. Sans cela, une étiquette de trop restait là pour toujours. */
  onRemoveLabel?(id: string): void
  /**
   * Les collections de l'utilisateur, telles que la carte les lit.
   *
   * `members` ne porte qu'une collection par post — la dominante —, parce qu'un pixel n'a
   * qu'une teinte et qu'un nom se pose au milieu des siens. L'appartenance multiple existe
   * bien en base ; c'est l'affichage qui doit trancher, pas le modèle.
   */
  collections?: { id: number; name: string; tone: string; members: Set<string> }[]
  /** Les noms des collections, posés au milieu de leurs posts. */
  showCollectionNames?: boolean
  /** Les étiquettes posées à la main. */
  showOwnLabels?: boolean
  /**
   * Le clic droit ouvre un menu au lieu de commencer un lasso.
   *
   * Vrai sur la carte plein écran, faux dans l'organisateur, qui se sert du glisser droit pour
   * sélectionner. Nommer un endroit était un mode qu'il fallait armer d'un bouton, et un clic
   * gauche perdu suffisait à poser une étiquette qu'on n'avait pas demandée.
   */
  menuOnRightClick?: boolean
  /**
   * La collection regardée, peinte en chaleur.
   *
   * `degrees` porte **toute** la bibliothèque, pas seulement les membres : c'est ce qui permet de
   * voir la collection *déborder* — les points juste sous le seuil sont là, éteints, et régler
   * l'ampleur les allume. Une carte qui n'afficherait que les membres ne dirait rien de ce qu'un
   * cran de plus attraperait.
   *
   * `token` identifie l'état peint. Le réseau et les points vivent dans un tampon dont la clé
   * doit changer avec les couleurs, sinon le tampon resservirait l'ancienne teinte — c'est
   * exactement le piège dans lequel tombe toute couleur ajoutée ici sans toucher aux deux clés.
   */
  heat?: {
    token: string
    degrees: Map<string, number>
    reach: number
    /**
     * N'afficher que la collection : ni toile, ni points hors seuil.
     *
     * Moins de contexte, mais on voit enfin la *forme* de la collection — et c'est moins cher à
     * peindre, la toile disparaissant avec le reste. C'est le seul réglage de cet écran qui
     * accélère le rendu au lieu de le charger.
     */
    only?: boolean
  } | null
  /** Refaire la carte depuis zéro : les positions rangées sont effacées et reprojetées. */
  onRegenerate?(): void
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

/**
 * La rampe de chaleur : du violet sourd au jaune pâle.
 *
 * Séquentielle et non catégorielle — elle dit *combien*, pas *lequel*. Elle monte aussi en
 * clarté en même temps qu'en teinte, ce qui la rend lisible même quand deux points se
 * superposent : la toile est peinte en `lighter`, donc deux points proches s'additionnent, et
 * une rampe qui ne varierait qu'en teinte se brouillerait à l'addition.
 */
const HEAT_RAMP: [number, number, number][] = [
  [0x4c, 0x1d, 0x95],
  [0x7c, 0x3a, 0xed],
  [0xd9, 0x46, 0xef],
  [0xfb, 0x71, 0x85],
  [0xfb, 0xbf, 0x24],
  [0xfd, 0xe6, 0x8a]
]

/** Sous le seuil : présent, mais éteint. La forme de la bibliothèque reste lisible autour. */
const HEAT_COLD = '#1d1d26'

function heatTone(degree: number, reach: number): string {
  if (!Number.isFinite(degree) || degree < reach) return HEAT_COLD
  /* Un écart-type et demi au-delà du seuil suffit à saturer : au-delà, ce sont quelques posts
     isolés, et leur donner la moitié de la rampe écraserait tout le reste dans le violet. */
  const t = Math.max(0, Math.min(1, (degree - reach) / 1.5))
  const span = (HEAT_RAMP.length - 1) * t
  const low = Math.min(HEAT_RAMP.length - 1, Math.floor(span))
  const high = Math.min(HEAT_RAMP.length - 1, low + 1)
  const mix = span - low
  const channel = (at: number): number =>
    Math.round(HEAT_RAMP[low][at] + (HEAT_RAMP[high][at] - HEAT_RAMP[low][at]) * mix)
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`
}

function colourFor(
  point: OrganizerMapPoint,
  mode: ColourMode,
  groupIndex: Map<string, number>,
  heat?: { degrees: Map<string, number>; reach: number } | null,
  tint?: Map<string, string> | null
): string {
  // La chaleur prime : quand on regarde une collection, c'est elle qu'on regarde.
  if (heat) return heatTone(heat.degrees.get(point.id) ?? Number.NEGATIVE_INFINITY, heat.reach)
  /* La teinte que l'utilisateur a lui-même donnée à la collection du post. Un post sans
     collection garde le gris des sans-groupe : il est là, il n'est simplement rangé nulle part. */
  if (mode === 'collection') return tint?.get(point.id) ?? '#5a5a66'
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
  ownLabels,
  allPoints,
  onPlaceLabel,
  onRemoveLabel,
  collections,
  showCollectionNames = false,
  showOwnLabels = true,
  menuOnRightClick = false,
  heat = null,
  onRegenerate,
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
  /**
   * Les positions précédentes, et l'avancement du fondu vers les nouvelles.
   *
   * Changer de regard rejoue une projection entière : les neuf mille points sautent d'un
   * endroit à l'autre, et on perd de vue ce qu'on suivait. En les faisant glisser, l'œil
   * accompagne le déplacement et comprend ce qui s'est réorganisé — c'est le seul moment où
   * animer la carte a du sens, tout le reste étant du cadrage.
   */
  const morphFrom = useRef<Map<string, { x: number; y: number }> | null>(null)
  const morphStart = useRef(0)
  const [hovered, setHovered] = useState<OrganizerMapPoint | null>(null)
  /** Amas éclairé : celui du point survolé, ou celui dont on survole le nom. */
  /**
   * La teinte de chaque post, d'après sa collection. Bâtie une fois par changement.
   *
   * Elle entre dans la clé du tampon par un jeton : sans lui, recolorer une collection
   * repeindrait sur une image déjà peinte et rien ne changerait à l'écran.
   */
  const collectionTint = useMemo(() => {
    if (!collections || collections.length === 0) return null
    const out = new Map<string, string>()
    for (const room of collections) {
      for (const id of room.members) out.set(id, room.tone)
    }
    return out
  }, [collections])
  const tintToken = useMemo(
    () => (collections ?? []).map((room) => `${room.id}${room.tone}`).join(','),
    [collections]
  )

  /** Le menu du clic droit : ce qu'il propose dépend de ce qu'il y a sous le curseur. */
  const [menu, setMenu] = useState<{
    x: number
    y: number
    labelId: string | null
    anchors: string[] | null
  } | null>(null)

  /** Amas retenu au clic : tout le reste s'efface tant qu'il l'est. Le survol reste par-dessus. */
  const [focusGroup, setFocusGroup] = useState<string | null>(null)
  /** Nom survolé, pour lui donner l'aspect d'un bouton — et au curseur la forme qui va avec. */
  const [hoverLabel, setHoverLabel] = useState<string | null>(null)
  /** Où les noms ont été posés au dernier dessin, pour pouvoir les survoler. */
  /** L'emprise des étiquettes personnelles, pour pouvoir en viser une et la retirer. */
  const ownLabelBoxes = useRef<{ id: string; x: number; y: number; half: number; size: number }[]>(
    []
  )
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
    paths: Map<
      string,
      {
        path: Path2D
        tone: string
        group: string | null
        /** Emprise du paquet, en coordonnées de carte, pour l'écarter quand il est hors cadre. */
        left: number
        top: number
        right: number
        bottom: number
      }
    >
    /**
     * La même chose, en liste.
     *
     * Peindre la toile par tranches demande de reprendre à un indice précis d'une image à la
     * suivante, et l'itérateur d'une `Map` ne se reprend pas. La liste est construite une fois
     * avec la table ; elles ne divergent jamais.
     */
    list: {
      path: Path2D
      tone: string
      group: string | null
      left: number
      top: number
      right: number
      bottom: number
    }[]
  }>({ key: '', paths: new Map(), list: [] })

  /**
   * Le tracé en cours, étalé sur plusieurs images.
   *
   * C'est le remède au gel. Le tampon était peint d'un bloc — cent trente mille courbes en
   * trois passes, jusqu'à une seconde sur la carte plein écran — et la main ne revenait qu'après.
   * On peint désormais six millisecondes par image dans un **second** tampon, en continuant
   * d'afficher le premier étiré : le déplacement et le zoom ne s'interrompent jamais, et la
   * toile se pose nette quelques images plus tard.
   *
   * Deux tampons, donc, qui échangent leurs rôles à chaque tracé terminé — celui qu'on montre
   * ne peut pas être celui qu'on peint sans laisser voir un dessin à moitié fait.
   */
  const paintJob = useRef<{
    key: string
    scale: number
    canvas: HTMLCanvasElement
    paint: CanvasRenderingContext2D
    left: number
    top: number
    width: number
    height: number
    /** Prochain paquet de courbes à tracer. */
    at: number
    /** Les points sont peints en dernier, une fois la toile finie. */
    dotsDone: boolean
  } | null>(null)
  /** Le tampon libre, prêt à recevoir le prochain tracé. */
  const spareBuffer = useRef<HTMLCanvasElement | null>(null)
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
  /**
   * Un affinage est-il réclamé ?
   *
   * Le tampon est peint à une échelle donnée ; zoomer le rend flou d'autant, et le retracer le
   * remet net. Le retracé coûtait jusqu'à une seconde, et il tombait cent quarante millisecondes
   * après le dernier cran de molette — c'est-à-dire pile au moment où l'on veut recommencer à
   * bouger. On rend donc la main d'abord : la recopie étirée reste à l'écran, et l'affinage est
   * remis à un moment d'inactivité. Si un geste arrive entre-temps, il passe devant.
   */
  const sharpenNow = useRef(false)
  const sharpenAsked = useRef(false)
  const [zooming, setZooming] = useState(false)
  /** Le même état, lisible depuis une réponse différée qui ne voit pas le rendu courant. */
  const zoomingRef = useRef(false)
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
   * Où poser chaque étiquette personnelle : au centre de gravité de ses ancres.
   *
   * Recalculé à partir des points, jamais rangé : c'est ainsi qu'une étiquette suit le contenu
   * qu'elle nomme quand la carte est reprojetée. Une étiquette figée en coordonnées désignerait
   * le voisin dès la première reprojection — le défaut qu'on a payé sur les frontières.
   *
   * Deux nuages, et c'est la correction : la **place** vient du nuage entier, pour qu'un filtre
   * ne déplace pas un endroit ; la **visibilité** vient des points affichés, parce qu'une
   * étiquette dont il ne reste presque rien à l'écran nomme le vide. Le seuil est celui de la
   * pose : on n'a jamais accepté d'en créer une sur moins de trois voisins.
   */
  const ownLabelSpots = useMemo(() => {
    if (!ownLabels || ownLabels.length === 0) return []
    const at = new Map((allPoints ?? data.points).map((point) => [point.id, point]))
    const shown = allPoints ? new Set(data.points.map((point) => point.id)) : null
    return ownLabels.flatMap((label) => {
      let x = 0
      let y = 0
      let seen = 0
      let visible = 0
      for (const anchor of label.anchors) {
        const point = at.get(anchor)
        if (!point) continue
        x += point.x
        y += point.y
        seen += 1
        if (!shown || shown.has(anchor)) visible += 1
      }
      // Plus assez d'ancres : l'étiquette n'a plus rien à nommer, on ne la pose pas.
      if (seen === 0 || visible < LABEL_MIN_ANCHORS) return []
      return [{ id: label.id, text: label.text, x: x / seen, y: y / seen }]
    })
  }, [ownLabels, data.points, allPoints])

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
  /* On retient les positions qu'on quitte, à chaque changement de jeu de points. */
  useEffect(() => {
    const previous = new Map(data.points.map((point) => [point.id, { x: point.x, y: point.y }]))
    return () => {
      morphFrom.current = previous
      morphStart.current = performance.now()
    }
  }, [data.points])

  /**
   * Où poser un nom pour un ensemble de points.
   *
   * Sur la masse, pas sur la moyenne : un ensemble éparpillé — « architecture » en trois
   * endroits — a une moyenne qui ne tombe sur aucun d'eux, et le nom flottait dans le vide à
   * côté d'une carte pleine. On prend la case la plus fournie, puis le centre de ce qu'elle et
   * ses voisines contiennent.
   */
  const denseSpot = (
    points: { x: number; y: number }[]
  ): { x: number; y: number; near: number } | null => {
    const CELL = 0.04
    const cells = new Map<string, { x: number; y: number }[]>()
    for (const point of points) {
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
    if (!bestKey) return null
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
    return near > 0 ? { x: x / near, y: y / near, near } : null
  }

  /** Les noms de collections, posés au milieu des leurs. */
  const collectionSpots = useMemo(() => {
    if (!collections || collections.length === 0) return []
    const at = new Map(data.points.map((point) => [point.id, point]))
    return collections
      .map((room) => {
        const own = [...room.members]
          .map((id) => at.get(id))
          .filter((point): point is OrganizerMapPoint => point !== undefined)
        if (own.length < 6) return null
        const spot = denseSpot(own)
        if (!spot) return null
        return {
          key: `collection:${room.id}`,
          text: room.name.trim().toLocaleLowerCase(),
          tone: room.tone,
          x: spot.x,
          y: spot.y,
          count: own.length,
          near: spot.near,
          faded: false,
          members: room.members
        }
      })
      .filter((spot): spot is NonNullable<typeof spot> => spot !== null)
      .sort((left, right) => right.count - left.count)
  }, [collections, data.points])

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
    perf.openFrame()
    const ratio = window.devicePixelRatio || 1
    const width = canvas.width / ratio
    const height = canvas.height / ratio
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)

    const size = Math.min(width, height)
    const landing = landingAt()
    /* L'origine du carré unité à l'écran, avant décalage du cadrage. Remontée ici parce que
       les frontières s'en servent aussi, et qu'elle ne dépend que du cadre et de l'échelle. */
    const span = size * view.scale
    /**
     * L'échelle apparente : de combien la carte paraît grossie, cadre compris.
     *
     * La règle qui sépare les deux échelles : tout ce qui *place* quelque chose passe par
     * `view.scale`, tout ce qui *dimensionne* quelque chose à l'écran passe par `apparent`.
     * Confondre les deux marchait tant qu'un seul cadre existait ; deux cadres de tailles très
     * différentes — la bande de l'organisateur et la carte plein écran — et tout ce qui est
     * dimensionné se retrouve réglé pour l'autre.
     */
    const apparent = span / REFERENCE_FRAME
    /* Ce que ce tracé va coûter, et la part d'arêtes qu'on garde pour rester sous le plafond.
       `keep` ne dépend que du nombre d'arêtes, donc il est constant pour une bibliothèque
       donnée : il peut entrer dans la clé du tampon de courbes sans jamais l'invalider. */
    const keep = edgeKeep(links.length)
    const { closeness, edgeAlpha, core, bloom, dotRadius, glow } = webTuning(
      span,
      links.length * keep
    )
    const originX = ((width - size) / 2) * view.scale
    const originY = ((height - size) / 2) * view.scale

    /* Position sans le déplacement : c'est la seule chose qui change quand on fait glisser
       la carte, et la garder à part permet de peindre une fois puis de translater. */
    /* Avancement du fondu entre deux regards, s'il y en a un en cours. */
    const MORPH_MS = 650
    const morph = morphFrom.current
      ? Math.min(1, (performance.now() - morphStart.current) / MORPH_MS)
      : 1
    if (morph >= 1) morphFrom.current = null
    const at = (point: { x: number; y: number; id?: string }): [number, number] => {
      // L'atterrissage tire les points depuis le centre : ils se posent au lieu de surgir.
      const eased = 1 - Math.pow(1 - landing, 3)
      /* Pendant le fondu, le point est entre là où il était et là où il va. Adouci aux deux
         bouts, sinon le nuage démarre et s'arrête d'un coup. */
      if (morph < 1 && point.id && morph > 0) {
        const was = morph < 1 ? morphFrom.current?.get(point.id) : undefined
        if (was) {
          const ease = morph < 0.5 ? 2 * morph * morph : 1 - 2 * (1 - morph) * (1 - morph)
          point = {
            x: was.x + (point.x - was.x) * ease,
            y: was.y + (point.y - was.y) * ease
          }
        }
      }
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
    /**
     * Trace la toile depuis un paquet donné, et rend la main à l'échéance.
     *
     * Rend l'indice atteint. `deadline` à `null` trace tout d'un coup — l'atterrissage en a
     * besoin, ses coordonnées changeant à chaque image, il n'y a rien à reprendre.
     */
    const paintWebFrom = (
      target: CanvasRenderingContext2D,
      from: number,
      deadline: number | null
    ): number => {
      if (edgeAlpha <= 0.002 || heat?.only) return Number.MAX_SAFE_INTEGER
      /* Ni l'échelle ni la zone visible n'entrent dans la clé, et c'est le remède au gel.
         Les courbes sont construites dans le repère de la carte — des coordonnées entre 0 et 1
         — puis mises à l'échelle au tracé. Elles ne dépendent donc plus du zoom, et chaque
         retracé se contente de les peindre.
         Avant, la clé portait l'échelle *et* la zone : le moindre cran de molette invalidait
         tout et reconstruisait les cent trente mille courbes avant de les tracer. C'est la
         moitié des cinq cents millisecondes de gel — le reste est le tracé lui-même, qui est
         irréductible. La zone y avait été mise pour éviter de bâtir cent trente mille courbes
         dont trois cents tombent dans le cadre ; le problème disparaît quand on ne les bâtit
         qu'une fois pour toute la session. */
      const key = [
        landing.toFixed(3),
        colourMode,
        /* La *présence* d'une chaleur, pas son contenu : entrer ou sortir du mode change la
           teinte des fils (ils s'éteignent), régler l'ampleur ne la change pas. Mettre le jeton
           complet ici coûtait une reconstruction des courbes par cran de curseur. */
        heat ? 'heat' : '',
        /* Recolorer une collection change la teinte des points : sans ce jeton, on repeindrait
           une image déjà peinte et rien ne bougerait. */
        tintToken,
        keep.toFixed(3),
        [...includedGroups].sort().join(',')
      ].join(':')
      perf.begin('courbes')
      if (pathCache.current.key !== key) {
        const built = new Map<
          string,
          {
            path: Path2D
            tone: string
            group: string | null
            left: number
            top: number
            right: number
            bottom: number
          }
        >()
        /* L'atterrissage tire les points depuis le centre ; on garde le même adoucissement,
           mais en coordonnées de carte, pour que les courbes soient indépendantes du zoom. */
        const eased = 1 - Math.pow(1 - landing, 3)
        const unitOf = (point: { x: number; y: number }): [number, number] => [
          0.5 + (point.x - 0.5) * eased,
          0.5 + (point.y - 0.5) * eased
        ]
        for (let index = 0; index < links.length; index += 1) {
          if (!edgeKept(index, keep)) continue
          const [from, to] = links[index]
          const [x1, y1] = unitOf(from)
          const [x2, y2] = unitOf(to)
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
          /* Sans la chaleur, volontairement. Les fils disent la *structure*, les points disent
             la mesure : c'est la seule répartition qui tienne, parce que la teinte d'un fil
             entre dans la clé du tampon de courbes. Coloré par la chaleur, le moindre cran du
             curseur d'ampleur reconstruisait les cent trente mille courbes — un gel d'une
             seconde par cran. Et à l'œil c'est aussi mieux : la toile éteinte fait ressortir
             les points allumés, au lieu de rivaliser avec eux. */
          const tone =
            colourFor(from, colourMode, groupIndex, null, collectionTint) === colourFor(to, colourMode, groupIndex, null, collectionTint)
              ? colourFor(from, colourMode, groupIndex, null, collectionTint)
              : NEUTRAL_EDGE
          const shared = tone === NEUTRAL_EDGE ? null : from.group
          /* Un chemin par couple groupe/teinte. La teinte seule suffirait à peindre, mais pas
             à éclairer un amas au survol : dans les modes autres que « par groupe », vingt
             amas partagent la même couleur. */
          /* Un paquet par tuile, en plus de la couleur.
             Le tracé des cent trente mille arêtes est le coût qui reste — la construction, elle,
             ne se refait plus. Zoomé, l'écran n'en montre qu'une poignée, mais on les traçait
             toutes : le canvas les écartait une à une, ce qui coûte presque autant que de les
             peindre. Découpées en tuiles, on n'appelle `stroke` que sur les paquets qui touchent
             le cadre. Huit par côté : assez fin pour que le zoom en écarte l'essentiel, assez
             large pour que le nombre d'appels reste petit une fois dézoomé. */
          const TILES = 8
          const tileX = Math.min(TILES - 1, Math.max(0, Math.floor(((x1 + x2) / 2) * TILES)))
          const tileY = Math.min(TILES - 1, Math.max(0, Math.floor(((y1 + y2) / 2) * TILES)))
          const bucket = `${tileX}:${tileY}|${shared ?? ''}|${tone}`
          let entry = built.get(bucket)
          if (!entry) {
            entry = {
              path: new Path2D(),
              tone,
              group: shared,
              left: Infinity,
              top: Infinity,
              right: -Infinity,
              bottom: -Infinity
            }
            built.set(bucket, entry)
          }
          /* L'emprise réelle du paquet, et non celle de la tuile : une arête déborde de la
             sienne, et l'écarter sur la tuile ferait clignoter des fils au bord du cadre. */
          entry.left = Math.min(entry.left, x1, x2)
          entry.top = Math.min(entry.top, y1, y2)
          entry.right = Math.max(entry.right, x1, x2)
          entry.bottom = Math.max(entry.bottom, y1, y2)
          const path = entry.path
          path.moveTo(x1, y1)
          path.quadraticCurveTo(
            (x1 + x2) / 2 - (y2 - y1) * 0.26,
            (y1 + y2) / 2 + (x2 - x1) * 0.26,
            x2,
            y2
          )
        }
        pathCache.current = { key, paths: built, list: [...built.values()] }
      }
      perf.end()
      target.globalCompositeOperation = 'lighter'
      /* Les courbes vivent entre 0 et 1 : c'est la transformation qui les porte à l'échelle,
         et les épaisseurs se divisent d'autant pour rester constantes à l'écran. */
      target.save()
      target.translate(originX, originY)
      target.scale(span, span)
      /* Le cadre, ramené en coordonnées de carte. La marge absorbe le débord du halo, qui est
         large : un fil juste hors cadre y projette encore de la lueur. */
      const slack = (core * WEB.bloomWidth) / span + 0.01
      const seenLeft = (-originX - view.x) / span - slack
      const seenTop = (-originY - view.y) / span - slack
      const seenRight = (width - originX - view.x) / span + slack
      const seenBottom = (height - originY - view.y) / span + slack
      const entries = pathCache.current.list
      let at = Math.max(0, from)
      for (; at < entries.length; at += 1) {
        const entry = entries[at]
        /* L'échéance n'est consultée qu'un paquet sur trente-deux : `performance.now()` est
           bon marché, mais pas au point d'être appelé cent trente mille fois. */
        if (deadline !== null && (at & 31) === 31 && performance.now() >= deadline) break
        const { path, tone } = entry
        if (
          entry.right < seenLeft ||
          entry.left > seenRight ||
          entry.bottom < seenTop ||
          entry.top > seenBottom
        ) {
          continue
        }
        target.strokeStyle = tone
        if (bloom > 0.02) {
          target.lineWidth = (core * WEB.bloomWidth) / span
          target.globalAlpha = edgeAlpha * bloom * 0.5
          target.stroke(path)
          target.lineWidth = (core * Math.max(1.5, WEB.bloomWidth / 2.3)) / span
          target.globalAlpha = edgeAlpha * bloom * 0.6
          target.stroke(path)
        }
        target.lineWidth = core / span
        target.globalAlpha = edgeAlpha
        target.stroke(path)
      }
      target.restore()
      target.globalCompositeOperation = 'source-over'
      target.globalAlpha = 1
      return at
    }

    /** Toute la toile d'un coup. Pour l'atterrissage, et pour le premier tracé. */
    const paintWeb = (target: CanvasRenderingContext2D): void => {
      paintWebFrom(target, 0, null)
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
    const restoreGroup = (group: string): void => {
      if (edgeAlpha <= 0.002 || pathCache.current.key === '') return
      context.save()
      /**
       * Le repère de la carte, comme le tracé principal.
       *
       * Ces deux calques translataient du déplacement et rien de plus. C'était juste quand les
       * courbes étaient construites en pixels d'écran ; depuis qu'elles vivent entre 0 et 1 —
       * ce qui a supprimé leur reconstruction à chaque cran de molette — un tracé sans mise à
       * l'échelle les écrase toutes dans un carré d'un pixel. Isoler un groupe éteignait donc
       * la carte sans jamais rallumer le groupe : c'était le calque qu'on ne voyait pas.
       *
       * L'étirement du geste de zoom n'a plus à être appliqué : `span` suit déjà l'échelle
       * courante, et la recopie étirée du fond montre la carte exactement là où cette
       * transformation la met.
       */
      context.translate(originX + view.x, originY + view.y)
      context.scale(span, span)
      /* Pendant un geste de zoom, le fond est une recopie *étirée* du tampon : aucun retracé
         n'a eu lieu, donc `pathCache` tient encore les courbes de l'échelle précédente. Les
         dessiner telles quelles les décalait du fond — c'était le calque qui glissait sous
         les points pendant qu'on zoomait. On leur applique le même étirement qu'à l'image. */
      context.globalCompositeOperation = 'lighter'
      for (const entry of pathCache.current.paths.values()) {
        if (entry.group !== group) continue
        context.strokeStyle = entry.tone
        if (bloom > 0.02) {
          context.lineWidth = (core * WEB.bloomWidth) / span
          context.globalAlpha = edgeAlpha * bloom * 0.5
          context.stroke(entry.path)
          context.lineWidth = (core * Math.max(1.5, WEB.bloomWidth / 2.3)) / span
          context.globalAlpha = edgeAlpha * bloom * 0.6
          context.stroke(entry.path)
        }
        context.lineWidth = core / span
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
        const tone = colourFor(point, colourMode, groupIndex, heat, collectionTint)
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
    const frame = { width, height, scale: view.scale, x: view.x, y: view.y }
    const needed = neededArea(frame, content)
    const painted = webCache.current
    const key = `${colourMode}|${ratio}|${heat?.token ?? ''}|${tintToken}|${[...includedGroups].sort().join(',')}`
    const usable =
      painted.canvas !== null && painted.key === key && stillCovers(painted, needed, view.scale)
    // Étirer ne vaut que le temps du geste : à l'arrêt, la toile doit être nette.
    const sharp = painted.scale === view.scale
    /* On garde la recopie étirée tant qu'on n'a pas décidé d'affiner. `!usable` reste un
       retracé immédiat : là, ce n'est plus une question de netteté mais de zone manquante, et
       étirer laisserait du vide à l'écran. */
    /**
     * Garde-t-on la recopie étirée ?
     *
     * `zooming` est décisif, et l'avoir retiré a coûté une session. Un tracé étalé sur plusieurs
     * images ne peut pas traverser un changement d'échelle : ses courbes sont mises à l'échelle
     * au moment du tracé, donc deux tranches peintes à deux échelles ne se raccorderaient pas.
     * Il faut donc le recommencer à chaque cran — et recommencer, c'est redimensionner le
     * tampon, l'effacer et repartir de zéro. Pendant un geste continu, ce tracé ne finissait
     * jamais et payait sa mise en place à chaque cran.
     *
     * Pendant le geste on étire, donc, sans rien peindre. L'affinage attend l'arrêt de la
     * molette, où l'échelle est stable et où le tracé peut enfin aller au bout.
     */
    const covers = usable && (sharp || zooming || !sharpenNow.current)

    if (landing < 1) {
      /* Pendant l'atterrissage, les coordonnées bougent à chaque image : peindre dans un
         tampon qu'on jetterait aussitôt n'ajouterait qu'une recopie. */
      webCache.current.key = ''
      const area = { left: -view.x, top: -view.y, right: -view.x + width, bottom: -view.y + height }
      context.save()
      context.translate(view.x, view.y)
      paintWeb(context)
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

        /* Rien à montrer en attendant : il faut peindre maintenant, sinon l'écran garderait un
           trou. C'est le premier tracé, et les déplacements qui sortent de la zone peinte — que
           la marge est justement là pour rendre rares. Partout ailleurs on étale. */
        const mustFinishNow = painted.canvas === null

        let job = paintJob.current
        const stale =
          job !== null &&
          (job.key !== key ||
            job.scale !== view.scale ||
            job.width !== bufferWidth ||
            job.height !== bufferHeight ||
            Math.abs(job.left - area.left) > 0.5 ||
            Math.abs(job.top - area.top) > 0.5)
        if (stale) job = null

        if (!job) {
          /* Le tampon libre, jamais celui qu'on affiche : peindre dans l'image montrée
             laisserait voir un dessin à moitié fait. */
          const canvas =
            spareBuffer.current && spareBuffer.current !== painted.canvas
              ? spareBuffer.current
              : document.createElement('canvas')
          spareBuffer.current = canvas
          /* Réaffecter `width` réalloue et efface le canevas — plusieurs mégapixels, des
             dizaines de millisecondes. On ne le fait donc que si la taille change réellement ;
             sinon `clearRect` suffit, et il coûte autrement moins cher. La zone peinte garde le
             plus souvent la même taille d'un cran à l'autre : c'est le cadre plus sa marge, et
             seul son centre bouge. */
          const wantedWidth = Math.ceil(bufferWidth * ratio)
          const wantedHeight = Math.ceil(bufferHeight * ratio)
          const paint = canvas.getContext('2d')
          if (!paint) return
          if (canvas.width !== wantedWidth || canvas.height !== wantedHeight) {
            canvas.width = wantedWidth
            canvas.height = wantedHeight
          }
          paint.setTransform(ratio, 0, 0, ratio, 0, 0)
          paint.clearRect(0, 0, bufferWidth, bufferHeight)
          paint.translate(-area.left, -area.top)
          job = {
            key,
            scale: view.scale,
            canvas,
            paint,
            left: area.left,
            top: area.top,
            width: bufferWidth,
            height: bufferHeight,
            at: 0,
            dotsDone: false
          }
          paintJob.current = job
        }

        /* Six millisecondes par image : de quoi avancer franchement en laissant respirer le
           reste — les points, les étiquettes, et surtout les événements de la souris. */
        const deadline = mustFinishNow ? null : performance.now() + 6
        perf.begin('toile')
        job.at = paintWebFrom(job.paint, job.at, deadline)
        perf.end()
        perf.note('paquets', `${job.at}/${pathCache.current.list.length}`)
        const webDone = job.at >= pathCache.current.list.length
        if (webDone && !job.dotsDone) {
          /* Les points en une fois : neuf mille pastilles groupées par teinte, c'est deux ou
             trois millisecondes — le découpage n'y gagnerait rien et compliquerait la reprise. */
          perf.begin('points')
          paintDots(job.paint, {
            left: job.left,
            top: job.top,
            right: job.left + job.width,
            bottom: job.top + job.height
          })
          perf.end()
          job.dotsDone = true
        }

        if (job.dotsDone) {
          /* Terminé : les deux tampons échangent leurs rôles. L'ancien devient le brouillon
             du prochain tracé, ce qui évite de rallouer plusieurs mégapixels par cran. */
          spareBuffer.current = painted.canvas
          webCache.current = {
            key,
            canvas: job.canvas,
            scale: job.scale,
            left: job.left,
            top: job.top,
            width: job.width,
            height: job.height
          }
          paintJob.current = null
          sharpenNow.current = false
        } else {
          /* Pas fini : on reprendra à l'image suivante, et l'écran montre en attendant la
             recopie étirée du tracé précédent. */
          window.requestAnimationFrame(() => drawRef.current())
        }
      } else {
        sharpenNow.current = false
      }
      const web = webCache.current
      if (web.canvas) {
        /* Recopie calée sur la grille des pixels physiques. À 125 % ou 150 % — le cas courant
           sous Windows — un décalage entier en points d'interface tombe entre deux pixels de
           l'écran, et la recopie rééchantillonne : la toile deviendrait floue au déplacement,
           alors qu'elle est nette au premier tracé. */
        const zoom = web.scale > 0 ? view.scale / web.scale : 1
        perf.begin('recopie')
        const snap = (value: number): number => Math.round(value * ratio) / ratio
        context.drawImage(
          web.canvas,
          snap(web.left * zoom + view.x),
          snap(web.top * zoom + view.y),
          web.width * zoom,
          web.height * zoom
        )
        perf.end()
      }

      /**
       * L'affinage, réclamé pour plus tard.
       *
       * `requestIdleCallback` est exactement l'outil : il ne se déclenche pas tant que la file
       * de tâches est occupée, donc un cran de molette ou un déplacement passe devant. On
       * rend la main dans l'image courante avec une recopie étirée, et la toile redevient nette
       * dès que la main se pose. Le repli à `setTimeout` sert aux moteurs qui ne l'ont pas.
       */
      if (usable && !sharp && !zooming && !sharpenAsked.current) {
        sharpenAsked.current = true
        const ask = (): void => {
          sharpenAsked.current = false
          /* Un geste a pu reprendre pendant l'attente : on ne réclame l'affinage que si la main
             s'est réellement posée, sinon la prochaine accalmie le redemandera. */
          if (zoomingRef.current) return
          sharpenNow.current = true
          drawRef.current()
        }
        const idle = (
          window as unknown as {
            requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number
          }
        ).requestIdleCallback
        if (idle) idle(ask, { timeout: 600 })
        else window.setTimeout(ask, 260)
      }
    }

    /* Focus sur un groupe : tout s'efface sauf lui.
       L'effacement se fait en `destination-out` plutôt qu'en peignant un voile de la couleur
       du fond — on retire de l'alpha au lieu d'ajouter une couche. Deux raisons : la toile
       est peinte en `lighter` sur un canvas transparent, c'est le CSS qui donne le fond, donc
       un voile supposerait de lire `--field` et de le suivre au changement de thème ; et
       retirer l'alpha laisse le fond réel transparaître, quel qu'il soit.
       Les points sont dans le tampon, avec la toile : les griser un par un demanderait de
       retracer les 133 810 arêtes à chaque clic. On efface tout, puis on remet le groupe. */
    perf.begin('isolement')
    if (focusGroup) {
      /**
       * Isoler, qu'il s'agisse d'un amas ou d'une collection.
       *
       * Un amas est un groupe des courbes : on peut donc rallumer sa toile. Une collection ne
       * l'est pas — ses membres sont dispersés dans tous les paquets — et reconstruire ses
       * arêtes coûterait une passe sur cent trente mille. On rallume donc ses **points** seuls,
       * ce qui dit exactement ce qu'on veut savoir : où elle est, et comment elle est répartie.
       */
      const isolated = collectionSpots.find((spot) => spot.key === focusGroup)?.members ?? null
      context.save()
      context.globalCompositeOperation = 'destination-out'
      context.globalAlpha = FOCUS_FADE
      context.fillStyle = '#000'
      context.fillRect(0, 0, width, height)
      context.restore()
      if (!isolated) restoreGroup(focusGroup)
      // Les points retenus, repeints par-dessus : ils viennent d'être effacés avec le reste.
      const bodies = new Map<string, Path2D>()
      for (const point of data.points) {
        if (isolated ? !isolated.has(point.id) : point.group !== focusGroup) continue
        const [ux, uy] = at(point)
        const x = ux + view.x
        const y = uy + view.y
        if (x < -8 || y < -8 || x > width + 8 || y > height + 8) continue
        const tone = colourFor(point, colourMode, groupIndex, heat, collectionTint)
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

    perf.end()

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
    /* Avec les frontières, ce sont les cellules qu'on nomme, pas les amas. Le bouton des noms
       commande donc les unes ou les autres selon ce qu'on regarde. */
    /**
     * Trois familles de noms, chacune avec son interrupteur.
     *
     * Les amas que l'analyse a trouvés, les collections que l'utilisateur a écrites, et les
     * endroits qu'il a nommés lui-même. Elles disaient trois choses différentes et un seul
     * bouton les commandait toutes — ou plutôt, la troisième n'en avait aucun.
     *
     * Chaque nom porte son texte et sa teinte plutôt que de les faire déduire de son groupe :
     * c'est ce qui permet à une collection d'apparaître ici avec la couleur que l'utilisateur
     * lui a donnée, sans que la boucle ait à savoir de quelle famille elle vient.
     */
    perf.note('empan', Math.round(span))
    perf.note('aretes', pathCache.current.list.length)
    perf.note('tampon', covers ? 'recopie' : paintJob.current ? 'en cours' : 'pose')
    perf.begin('noms')
    const groupTitles = islands.map((island) => ({
      key: island.group,
      text: groupNames.get(island.group)?.trim().toLocaleLowerCase() ?? '',
      tone: colourOfGroup(island.group, groupIndex),
      x: island.x,
      y: island.y,
      count: island.count,
      near: island.near,
      faded: !includedGroups.has(island.group),
      members: null as Set<string> | null
    }))
    const labelled = [
      ...(showLabels ? groupTitles : []),
      ...(showCollectionNames ? collectionSpots : [])
    ]
    for (const island of labelled) {
      const name = island.text
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
        Math.min(18, 10 + Math.sqrt(island.count) * 0.25) * Math.min(1.4, Math.sqrt(apparent))
      /* Demi-largeur estimée sans `measureText` : la mesurer pour vingt-deux étiquettes à
         chaque image coûtait plus que de la deviner, et une approximation suffit à savoir
         que deux noms se chevauchent. */
      const half = (name.length * size) / 3.9
      /* En pixels d'écran : c'est donc l'échelle apparente qui compte. Avec `view.scale`, la
         portée était calculée pour un cadre de 460 px et sous-estimée de moitié sur la carte
         plein écran — deux noms voisins ne se voyaient pas se toucher, et « cinéma et vidéo »
         se collait à « mode ». */
      const reach = Math.sqrt(island.count) * 1.25 * Math.min(2.6, apparent)
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
      drawn.push({ group: island.key, x: centreX, y, half, size })
      const faded = island.faded
      context.globalAlpha = faded ? 0.28 : 1
      if (y !== centreY) {
        /* Le trait de rappel dit de quel amas le nom déplacé parle, et prend la teinte du
           groupe quel que soit le mode de couleur. Le faire passer par `colourFor` obligeait
           à fabriquer un faux point, sans plateforme, ni type, ni provenance : en mode
           « Signet / Likes », lire `sources` sur ce leurre plantait l'écran. */
        context.strokeStyle = island.tone
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
      const active = island.key === focusGroup
      if (island.key === hoverLabel || active) {
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
        context.strokeStyle = active ? island.tone : 'rgba(255, 255, 255, 0.4)'
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
      /* À sa propre teinte : celle du groupe pour un amas, celle que l'utilisateur a choisie
         pour une collection. Le blanc tranchait mieux sur la toile, mais il coupait le nom de
         ce qu'il désigne — devant vingt titres, savoir lequel va avec quoi demandait de suivre
         le trait de rappel à chaque fois. Le contour noir épais au-dessus fait le travail de
         lisibilité que le blanc faisait. */
      context.fillStyle = island.tone
      context.fillText(name, centreX, y)
      context.letterSpacing = '0px'
    }
    /* Les étiquettes de l'utilisateur, par-dessus. En italique et sans contour de groupe :
       elles ne désignent pas une collection mais un endroit, et il faut que la différence se
       voie sans avoir à réfléchir. */
    const ownDrawn: { id: string; x: number; y: number; half: number; size: number }[] = []
    for (const spot of showOwnLabels ? ownLabelSpots : []) {
      const [ux, uy] = at(spot)
      const x = ux + view.x
      const y = uy + view.y
      if (x < -80 || y < -40 || x > width + 80 || y > height + 40) continue
      const size = 13 * Math.min(1.5, Math.sqrt(apparent))
      context.font = `italic 500 ${size.toFixed(1)}px system-ui, sans-serif`
      context.lineWidth = size / 5
      context.strokeStyle = 'rgba(0, 0, 0, 0.85)'
      context.strokeText(spot.text, x, y)
      context.fillStyle = 'rgba(255, 255, 255, 0.82)'
      context.fillText(spot.text, x, y)
      ownDrawn.push({
        id: spot.id,
        x,
        y,
        half: context.measureText(spot.text).width / 2,
        size
      })
    }
    ownLabelBoxes.current = ownDrawn
    perf.end()

    labelBoxes.current = drawn
    context.globalAlpha = 1

    if (hovered) {
      const [ux, uy] = at(hovered)
      const x = ux + view.x
      const y = uy + view.y
      context.globalAlpha = 1
      context.fillStyle = colourFor(hovered, colourMode, groupIndex, heat, collectionTint)
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
    perf.closeFrame()
  }, [
    colourMode,
    data.points,
    groupIndex,
    groupNames,
    hovered,
    includedGroups,
    heat,
    collectionTint,
    collectionSpots,
    showCollectionNames,
    showOwnLabels,
    tintToken,
    islands,
    links,
    ownLabelSpots,
    focusGroup,
    hoverLabel,
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
  /**
   * Un dessin par image, et non un par événement.
   *
   * C'était la vraie cause du gel au zoom. Chaque cran de molette appelle `setView`, donc un
   * rendu, donc cet effet — et le dessin partait **sur le champ**, de façon synchrone. Une
   * molette envoie un cran toutes les huit millisecondes, un dessin en coûte davantage : les
   * crans s'empilaient plus vite qu'ils ne se traitaient et la file d'événements ne se vidait
   * plus. L'application paraissait figée alors qu'elle dessinait sans arrêt, chaque image jetée
   * avant d'avoir été vue.
   *
   * Une image en attente est donc annulée par la suivante : vingt crans dans la même image ne
   * dessinent qu'une fois, à la position finale. Cela coûte au plus une image de retard, ce
   * qu'aucun geste ne perçoit — et c'est ce qui rend la main.
   */
  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = 0
      draw()
    })
    return () => {
      if (frame) cancelAnimationFrame(frame)
    }
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
          /* Le petit côté a changé : l'empan de la carte change avec lui, et garder le centre
             ne suffit pas — la carte reste au bon endroit mais grossit ou rétrécit sous les
             yeux, ce qui se lit comme un saut. Ce cas se produit sur la carte plein écran, où
             la fenêtre est souvent plus haute que large : ouvrir le panneau prend alors sur le
             petit côté. L'échelle compense l'empan pour que `size × scale` — la taille apparente
             — ne bouge pas non plus. Rien ne se déplace, rien ne se redimensionne. */
          const scale = Math.min(
            MAX_SCALE,
            Math.max(MIN_SCALE, (current.scale * sizeBefore) / sizeAfter)
          )
          const mapX =
            (beforeWidth / 2 - current.x) / current.scale - (beforeWidth - sizeBefore) / 2
          const mapY =
            (beforeHeight / 2 - current.y) / current.scale - (beforeHeight - sizeBefore) / 2
          return clamped({
            scale,
            x: w / 2 - ((mapX / sizeBefore) * sizeAfter + (w - sizeAfter) / 2) * scale,
            y: h / 2 - ((mapY / sizeBefore) * sizeAfter + (h - sizeAfter) / 2) * scale
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
    (clientX: number, clientY: number): { x: number; y: number } | null => {
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

  /** Le nom d'amas sous le curseur, s'il y en a un. */
  /** L'étiquette personnelle sous le curseur, s'il y en a une. */
  const ownLabelAt = useCallback((clientX: number, clientY: number): string | null => {
    const canvas = canvasRef.current
    const rect = canvas?.getBoundingClientRect()
    if (!rect) return null
    const x = clientX - rect.left
    const y = clientY - rect.top
    const hit = ownLabelBoxes.current.find(
      (box) => Math.abs(box.x + box.half - x) < box.half + 8 && Math.abs(box.y - y) < box.size
    )
    return hit?.id ?? null
  }, [])

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

  /**
   * Les posts auxquels une étiquette va rester accrochée.
   *
   * Ce sont eux qu'on retient, et non la position du curseur : une reprojection déplace les
   * neuf mille points, et une étiquette figée en coordonnées désignerait alors autre chose.
   * Accrochée à ses voisins, elle se repose à leur nouveau centre de gravité.
   */
  const anchorsAt = useCallback(
    (clientX: number, clientY: number): string[] | null => {
      const place = mapPointAt(clientX, clientY)
      if (!place) return null
      /* Par les cases plutôt que par un tri : la version précédente ordonnait les neuf mille
         points à chaque clic droit pour en garder vingt-quatre. Le découpage existe déjà pour
         le pointage, et le rayon ne couvre que quatre cases de part et d'autre. */
      const reach = Math.ceil(LABEL_RADIUS / BUCKET)
      const cx = Math.floor(place.x / BUCKET)
      const cy = Math.floor(place.y / BUCKET)
      const near: { id: string; d: number }[] = []
      for (let dx = -reach; dx <= reach; dx += 1) {
        for (let dy = -reach; dy <= reach; dy += 1) {
          for (const point of buckets.get(`${cx + dx}:${cy + dy}`) ?? []) {
            const d = Math.hypot(point.x - place.x, point.y - place.y)
            if (d < LABEL_RADIUS) near.push({ id: point.id, d })
          }
        }
      }
      // Moins de trois voisins : on nommerait le vide, et l'étiquette n'aurait nulle part à
      // revenir après la prochaine projection.
      if (near.length < LABEL_MIN_ANCHORS) return null
      return near
        .sort((a, b) => a.d - b.d)
        .slice(0, LABEL_ANCHORS)
        .map((entry) => entry.id)
    },
    [buckets, mapPointAt]
  )

  const onPointerDown = (event: React.PointerEvent): void => {
    try {
      ;(event.target as Element).setPointerCapture?.(event.pointerId)
    } catch {
      /* Pointeur déjà relâché ou identifiant inconnu : la capture est un confort, pas un dû. */
    }
    /* Un menu ouvert se referme au premier appui, où qu'il soit. */
    if (menu) setMenu(null)
    /* Le clic droit ouvre un menu au lieu de commencer un lasso — mais seulement là où on l'a
       demandé : l'organisateur, lui, sélectionne au glisser droit. */
    if (menuOnRightClick && event.button === 2) return
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
    /**
     * Le survol n'allume plus l'amas.
     *
     * Il le faisait pour tout point survolé, et c'était deux problèmes en un. À l'œil, la carte
     * clignotait sans arrêt : le curseur passe sur un point sans le vouloir, et tout son groupe
     * s'embrasait. Au chronomètre, c'était pire — surexposer un amas retrace ses paquets en
     * trois passes, **à chaque image**, et le curseur est justement sur la carte quand on
     * tourne la molette. Chaque image de zoom repeignait donc un groupe entier par-dessus.
     *
     * Désigner un amas reste possible, et c'est le clic sur son nom qui le fait : un geste
     * demandé, pas un effet de bord du passage de la souris. Le nom, lui, garde sa pastille au
     * survol — c'est un retour local, qui ne coûte rien.
     */
    if (overLabel !== hoverLabel) setHoverLabel(overLabel)
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
    const still = draggingRef.current && !draggingRef.current.moved
    if (clickedRef.current && still) {
      onOpen(clickedRef.current)
    } else if (still) {
      /* Clic sur un nom : on retient le groupe et tout le reste s'efface. Ailleurs dans le
         vide : on relâche. Le nom sert de poignée parce qu'un point a déjà son geste — il
         ouvre le post — et qu'on ne peut pas faire dire deux choses au même clic. */
      const name = labelAt(cursorRef.current.x, cursorRef.current.y)
      setFocusGroup((current) => (name && name !== current ? name : null))
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
    zoomingRef.current = true
    window.clearTimeout(zoomTimer.current)
    zoomTimer.current = window.setTimeout(() => {
      zoomingRef.current = false
      setZooming(false)
    }, 140)
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
      {menu ? (
        <div
          className="map-menu"
          style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          {menu.labelId ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                if (menu.labelId) onRemoveLabel?.(menu.labelId)
                setMenu(null)
              }}
            >
              {t('map.removeLabel')}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            /* Sans voisins, il n'y a rien à nommer : une étiquette accrochée au vide n'aurait
               nulle part où revenir après la prochaine projection. */
            disabled={!menu.anchors}
            onClick={() => {
              if (menu.anchors) onPlaceLabel?.(menu.anchors)
              setMenu(null)
            }}
          >
            {t('map.placeLabel')}
          </button>
          {onRegenerate ? (
            <button
              type="button"
              role="menuitem"
              /* La seule sortie, et elle est devenue nécessaire : les positions sont désormais
                 rangées en base et relues telles quelles, ce qui est tout l'intérêt — la carte
                 ne bouge plus sous les pieds. Il faut donc un geste explicite pour demander
                 qu'elle soit refaite, sinon rien ne la rafraîchirait jamais. */
              onClick={() => {
                setMenu(null)
                onRegenerate()
              }}
            >
              {t('organizer.edgeRegenerate')}
            </button>
          ) : null}
        </div>
      ) : null}
      <canvas
        ref={canvasRef}
        className={`${lassoing ? 'is-lassoing' : ''}${hoverLabel ? ' is-over-label' : ''}`.trim()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          setHovered(null)
          setHoverLabel(null)
          onHover(null)
          draggingRef.current = null
          clickedRef.current = null
        }}
        onDoubleClick={(event) => {
          /* Double-clic : on propose de nommer l'endroit. Les ancres sont les posts les plus
             proches — c'est à eux que l'étiquette restera accrochée, donc c'est eux qu'il faut
             retenir, pas la position du curseur. */
          if (!onPlaceLabel) return
          const anchors = anchorsAt(event.clientX, event.clientY)
          if (anchors) onPlaceLabel(anchors)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          if (!menuOnRightClick || !onPlaceLabel) return
          /**
           * Nommer un endroit se demande, il ne s'arme pas.
           *
           * C'était un mode : un bouton l'allumait, et le clic gauche suivant posait une
           * étiquette — y compris quand ce clic ne voulait rien dire. Un menu au clic droit dit
           * ce qu'il fait avant de le faire, ne coûte aucun état, et laisse le clic gauche à ce
           * qu'il a toujours servi : regarder.
           */
          const rect = canvasRef.current?.getBoundingClientRect()
          if (!rect) return
          setMenu({
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
            labelId: ownLabelAt(event.clientX, event.clientY),
            anchors: anchorsAt(event.clientX, event.clientY)
          })
        }}
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
                style={{ background: colourFor(hovered, colourMode, groupIndex, heat, collectionTint) }}
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
