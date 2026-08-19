import {
  neededArea,
  paintArea,
  stillCovers,
  ZOOM_HEADROOM,
  type Frame,
  type Painted,
  type Rect
} from '../src/renderer/src/map-coverage'

/**
 * Combien de fois la carte retrace-t-elle sa toile, pendant qu'on zoome ?
 *
 * Un retracé, ce sont trois passes de mélange additif sur 133 810 arêtes : 219 ms mesurés.
 * Une recopie du tampon, 4 ms. Le confort du geste tient donc entièrement au nombre de
 * retracés, et c'est ce que ce banc compte — sur les fonctions de production elles-mêmes,
 * pas sur une copie.
 *
 * Pourquoi le dézoom coûtait et pas le zoom : la zone peinte est exprimée dans l'échelle où
 * elle a été peinte. En zoom avant elle grandit avec l'échelle et couvre toujours plus que le
 * cadre. En zoom arrière elle rétrécit, le cadre déborde aussitôt, et il faut retracer. La
 * marge de dézoom peint plus large que nécessaire pour absorber plusieurs crans.
 *
 * `headroom = 1` reproduit exactement le comportement d'avant : la zone peinte valait le cadre
 * plus la marge de déplacement, sans provision pour l'échelle.
 */

const WIDTH = 1200
const HEIGHT = 460
const RATIO = 1.5
const WEB_BUDGET = 24_000_000
const WEB_MARGIN = 320
const MIN_SCALE = 2
const MAX_SCALE = 60
/** Le pas de la molette, repris de `OrganizerMap`. */
const IN = 1.16
const OUT = 0.862

/** L'emprise dessinée, telle que la calcule le composant. */
function contentOf(frame: Frame): Rect {
  const size = Math.min(frame.width, frame.height)
  const span = size * frame.scale
  const originX = ((frame.width - size) / 2) * frame.scale
  const originY = ((frame.height - size) / 2) * frame.scale
  const spill = 24
  return {
    left: originX - spill,
    top: originY - spill,
    right: originX + span + spill,
    bottom: originY + span + spill
  }
}

/** Le zoom s'accroche au curseur, comme dans le composant. */
function zoomAt(frame: Frame, factor: number, pointerX: number, pointerY: number): Frame {
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, frame.scale * factor))
  const ratio = next / frame.scale
  return {
    ...frame,
    scale: next,
    x: pointerX - (pointerX - frame.x) * ratio,
    y: pointerY - (pointerY - frame.y) * ratio
  }
}

interface Result {
  retraces: number
  steps: number
  painted: number
  /** Retracés survenus alors que le cadre, et non la carte, bornait ce qu'il fallait montrer.
   *  C'est le seul régime où la marge de dézoom peut aider. */
  frameBound: number
}

function replay(steps: Frame[], headroom: number): Result {
  const budget = WEB_BUDGET / (RATIO * RATIO)
  let painted: Painted | null = null
  let retraces = 0
  let paintedPixels = 0
  let frameBound = 0
  for (const frame of steps) {
    const content = contentOf(frame)
    const needed = neededArea(frame, content)
    if (painted && stillCovers(painted, needed, frame.scale)) continue
    if (needed.left > content.left + 0.5 || needed.right < content.right - 0.5) frameBound += 1
    const area = paintArea(frame, content, budget, headroom, WEB_MARGIN)
    const w = Math.max(1, Math.ceil(area.right - area.left))
    const h = Math.max(1, Math.ceil(area.bottom - area.top))
    painted = { scale: frame.scale, left: area.left, top: area.top, width: w, height: h }
    retraces += 1
    paintedPixels += w * h
  }
  return { retraces, steps: steps.length, painted: paintedPixels, frameBound }
}

/** Un geste : n crans dans un sens, le curseur au même endroit. */
function gesture(from: Frame, factor: number, count: number): Frame[] {
  const out: Frame[] = []
  let frame = from
  for (let i = 0; i < count; i += 1) {
    frame = zoomAt(frame, factor, WIDTH * 0.5, HEIGHT * 0.5)
    out.push(frame)
  }
  return out
}

/* Cadrage d'ouverture, repris du composant : la carte est centrée. Partir de (0,0) plaçait
   l'emprise hors du cadre et faussait entièrement la mesure. */
const box = Math.min(WIDTH, HEIGHT)
const start: Frame = {
  width: WIDTH,
  height: HEIGHT,
  scale: MIN_SCALE,
  x: WIDTH / 2 - (0.5 * box + (WIDTH - box) / 2) * MIN_SCALE,
  y: HEIGHT / 2 - (0.5 * box + (HEIGHT - box) / 2) * MIN_SCALE
}

const scenarios: { name: string; steps: Frame[] }[] = []
{
  // Plonger dans un amas, puis ressortir : le geste le plus courant.
  const dive = gesture(start, IN, 20)
  const deep = dive[dive.length - 1]
  scenarios.push({ name: 'zoom avant, 20 crans', steps: dive })
  scenarios.push({ name: 'zoom arrière, 20 crans', steps: gesture(deep, OUT, 20) })
  scenarios.push({ name: 'aller-retour, 40 crans', steps: [...dive, ...gesture(deep, OUT, 20)] })
  // Hésiter autour d'une profondeur : deux crans avant, un arrière, en boucle.
  const hesitate: Frame[] = []
  let frame = start
  for (let i = 0; i < 12; i += 1) {
    for (const step of gesture(frame, IN, 2)) hesitate.push(step)
    frame = hesitate[hesitate.length - 1]
    for (const step of gesture(frame, OUT, 1)) hesitate.push(step)
    frame = hesitate[hesitate.length - 1]
  }
  scenarios.push({ name: 'hésitation, 36 crans', steps: hesitate })
}

console.log(`marge de dézoom retenue : ×${ZOOM_HEADROOM}\n`)
console.log('scénario                     crans   retracés avant   après   dont cadre   pixels')
for (const scenario of scenarios) {
  const before = replay(scenario.steps, 1)
  const after = replay(scenario.steps, ZOOM_HEADROOM)
  const growth = before.painted > 0 ? after.painted / before.painted : 1
  console.log(
    `${scenario.name.padEnd(28)} ${String(scenario.steps.length).padStart(5)}` +
      `${String(before.retraces).padStart(17)}${String(after.retraces).padStart(8)}` +
      `${String(after.frameBound).padStart(13)}${`×${growth.toFixed(2)}`.padStart(10)}`
  )
}

console.log('\nbalayage de la marge, sur le dézoom :')
/* Le balayage se fait sur le dézoom : c'est le seul geste où la marge décide de quoi que ce
   soit. Sur l'aller-retour, trois retracés suffisent quelle que soit la marge — mesurer là
   n'aurait rien départagé. */
const roundTrip = scenarios[1].steps
for (const headroom of [1, 1.2, 1.4, 1.6, 1.8, 2.2, 3, 4]) {
  const run = replay(roundTrip, headroom)
  const base = replay(roundTrip, 1)
  /* Ce qu'on paie contre ce qu'on épargne, en unités de tracé : un retracé coûte à peu près
     la surface peinte, donc on compare des pixels et non des appels. */
  const cost = run.painted / base.painted
  console.log(
    `  ×${headroom.toFixed(1).padEnd(4)} ${String(run.retraces).padStart(3)} retracés` +
      `   travail total ×${cost.toFixed(2)}`
  )
}
