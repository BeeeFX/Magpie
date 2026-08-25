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
 * Un glissement continu ne doit pas relancer le tracé à chaque image.
 *
 * C'est le défaut qui faisait « disparaître » la carte quand on tirait vite vers un bord. Le
 * tracé de la toile est étalé sur plusieurs images ; il était jeté dès que la **zone à peindre**
 * bougeait d'un demi-pixel. Or cette zone est centrée sur le cadre : chaque image d'un
 * glissement la déplace. Le tracé repartait donc de zéro à chaque image, n'arrivait jamais au
 * bout, et l'écran restait sur son ancien tampon pendant tout le geste — d'où la bande vide qui
 * suivait le curseur, aussi longtemps qu'on continuait de tirer.
 *
 * La bonne question n'est pas « la zone a-t-elle bougé » mais « ce qui est en train d'être peint
 * couvre-t-il encore ce que le cadre demande ». Ce contrôle rejoue un glissement sur les
 * fonctions de production et compte les deux choses qui se voient : les tracés relancés, et le
 * temps que met la carte à se reposer une fois la main levée.
 *
 * Le modèle de tracé est volontairement grossier — un tracé demande `SLICES` images de travail —
 * parce que la question posée est booléenne : le tracé progresse-t-il, ou recommence-t-il ?
 */

const WIDTH = 1600
const HEIGHT = 900
const RATIO = 1.5
const WEB_BUDGET = 24_000_000
const WEB_MARGIN = 320
/** Ce qu'un tracé complet demande d'images à six millisecondes la tranche, sur la vraie
 *  bibliothèque : 150 ms de courbes. */
const SLICES = 25

let failures = 0

function assert(condition: unknown, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${message}`)
}

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

interface Job {
  left: number
  top: number
  width: number
  height: number
  scale: number
  done: number
}

interface Run {
  /** Tracés commencés. Un seul suffirait pour un geste d'un seul tenant. */
  started: number
  /** Images où le tampon affiché ne couvrait pas ce que le cadre demandait. */
  blind: number
  /** Images écoulées entre la première image aveugle et le retour d'une carte nette. */
  settled: number
  steps: number
}

/**
 * Rejoue un geste.
 *
 * `anchored` est la règle : `false` reproduit l'ancienne — on jette le tracé dès que la zone
 * visée bouge — et `true` la nouvelle, où le tracé survit tant qu'il couvre ce qu'il faut.
 */
function replay(steps: Frame[], anchored: boolean): Run {
  const budget = WEB_BUDGET / (RATIO * RATIO)
  let painted: Painted | null = null
  let job: Job | null = null
  let started = 0
  let blind = 0
  let firstBlind = -1
  let settled = steps.length
  for (let index = 0; index < steps.length; index += 1) {
    const frame = steps[index]
    const content = contentOf(frame)
    const needed = neededArea(frame, content)
    const covered = painted !== null && stillCovers(painted, needed, frame.scale)
    if (!covered) {
      blind += 1
      if (firstBlind < 0) firstBlind = index
    } else if (firstBlind >= 0 && settled === steps.length) {
      settled = index - firstBlind
    }
    if (covered) {
      job = null
      continue
    }
    const area = paintArea(frame, content, budget, ZOOM_HEADROOM, WEB_MARGIN)
    const width = Math.max(1, Math.ceil(area.right - area.left))
    const height = Math.max(1, Math.ceil(area.bottom - area.top))
    const stale =
      job !== null &&
      (job.scale !== frame.scale ||
        (anchored
          ? !stillCovers(
              {
                scale: job.scale,
                left: job.left,
                top: job.top,
                width: job.width,
                height: job.height
              },
              needed,
              frame.scale
            )
          : job.width !== width ||
            job.height !== height ||
            Math.abs(job.left - area.left) > 0.5 ||
            Math.abs(job.top - area.top) > 0.5))
    if (!job || stale) {
      job = { left: area.left, top: area.top, width, height, scale: frame.scale, done: 0 }
      started += 1
    }
    job.done += 1
    if (job.done >= SLICES) {
      painted = {
        scale: job.scale,
        left: job.left,
        top: job.top,
        width: job.width,
        height: job.height
      }
      job = null
    }
  }
  return { started, blind, settled, steps: steps.length }
}

/** Un glissement : le cadre part d'un amas et file vers un bord, image par image. */
function drag(from: Frame, dx: number, dy: number, count: number): Frame[] {
  const out: Frame[] = []
  let frame = from
  for (let index = 0; index < count; index += 1) {
    frame = { ...frame, x: frame.x + dx, y: frame.y + dy }
    out.push(frame)
  }
  return out
}

/** Le geste réel : on tire, puis on lâche — et c'est là que la carte doit se reposer vite. */
function hold(steps: Frame[], count: number): Frame[] {
  const last = steps[steps.length - 1]
  return [...steps, ...Array.from({ length: count }, () => last)]
}

const box = Math.min(WIDTH, HEIGHT)
/** Zoomé dans la carte : c'est le seul régime où le cadre borne ce qu'il faut peindre. */
const SCALE = 8
const start: Frame = {
  width: WIDTH,
  height: HEIGHT,
  scale: SCALE,
  x: WIDTH / 2 - (0.5 * box + (WIDTH - box) / 2) * SCALE,
  y: HEIGHT / 2 - (0.5 * box + (HEIGHT - box) / 2) * SCALE
}

console.log('Le tracé survit au glissement')

const scenarios: { name: string; steps: Frame[] }[] = [
  { name: 'glissement franc puis arrêt', steps: hold(drag(start, -40, 0, 30), 40) },
  { name: 'glissement lent puis arrêt', steps: hold(drag(start, -8, 0, 30), 40) },
  { name: 'diagonale puis arrêt', steps: hold(drag(start, -28, -16, 30), 40) }
]

console.log('\nscénario                       images   tracés av→ap   reposée après av→ap')
for (const scenario of scenarios) {
  const before = replay(scenario.steps, false)
  const after = replay(scenario.steps, true)
  console.log(
    `${scenario.name.padEnd(30)} ${String(scenario.steps.length).padStart(6)}` +
      `${`${before.started}→${after.started}`.padStart(15)}` +
      `${`${before.settled}→${after.settled} img`.padStart(22)}`
  )
  /* Le cœur : un geste d'un seul tenant ne doit pas relancer le tracé à chaque image. Deux ou
     trois relances pour un glissement franc, c'est le prix des sorties successives de la zone
     peinte ; soixante, c'était un tracé qui ne finissait jamais. */
  assert(
    after.started <= 5,
    `${scenario.name} : le tracé avance au lieu de recommencer ` +
      `(${before.started} → ${after.started} relances)`
  )
  assert(
    after.settled < before.settled,
    `${scenario.name} : la carte se repose plus tôt ` +
      `(${before.settled} → ${after.settled} images)`
  )
}

/* L'ancienne règle relançait un tracé à chaque image du geste : c'est l'aveu du défaut, et il
   doit rester visible dans le banc pour qu'on sache ce qu'on a corrigé. */
const MOVING = 30
const franc = replay(scenarios[0].steps, false)
assert(
  franc.started === MOVING,
  `l’ancienne règle relançait un tracé à chaque image du geste ` +
    `(${franc.started} pour ${MOVING} images de geste)`
)

/* Ce que ce banc ne prétend pas corriger, et qui justifie l'aperçu : tant que la main tire plus
   vite que la toile ne se peint, il reste des images sans tracé net à montrer. Le trou est borné
   dans le temps, il n'est pas supprimé — c'est la réduction de la carte qui le remplit. */
const soutenu = replay(drag(start, -40, 0, 60), true)
console.log(
  `\nun glissement soutenu (60 images à 40 px) laisse ${soutenu.blind} images sans tracé net :` +
    `\n  c'est l'aperçu qui les peint, faute de quoi la carte y paraît vide.`
)

if (failures > 0) {
  console.log(`\n${failures} contrôle(s) en échec.`)
  process.exit(1)
}
console.log('\nTout est vert.')
