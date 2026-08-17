import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { workerScriptPath } from '../src/main/tagging/projection'

/**
 * Éprouve la projection de la carte de bout en bout, sur le fil réellement construit.
 *
 * Ce contrôle existe parce que son absence a coûté cher : le chemin du fil était calculé
 * depuis `__dirname`, que le bundler place dans `out/main/chunks/`. En développement personne
 * ne l'a vu ; en version installée la carte tournait dans le vide pendant dix minutes avant
 * qu'un message d'erreur ne finisse par le dire.
 *
 * On vérifie donc deux choses qu'aucun typage ne peut garantir : que le chemin se résout dans
 * les deux empaquetages, et que le fil construit répond vraiment, à l'échelle d'une vraie
 * bibliothèque.
 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Échec : ${message}`)
  console.log(`  ✓ ${message}`)
}

const POINTS = 9740
const WIDTH = 384

async function main(): Promise<void> {
  console.log('Vérification de la carte sémantique')

  console.log('\nrésolution du fil')
  const packaged = workerScriptPath('C:\\Programs\\Magpie\\resources\\app.asar')
  assert(
    packaged === 'C:\\Programs\\Magpie\\resources\\app.asar.unpacked\\out\\main\\projection.worker.js',
    'en version installée, le chemin vise la copie déballée'
  )
  assert(
    !packaged.includes('chunks'),
    'le chemin ne passe jamais par le dossier des morceaux du bundler'
  )
  const dev = workerScriptPath('D:\\dev\\magpie')
  assert(dev.endsWith(join('out', 'main', 'projection.worker.js')), 'en développement, le chemin part de la racine du projet')

  const built = join(process.cwd(), 'out', 'main', 'projection.worker.js')
  assert(existsSync(built), 'le fil est présent dans la sortie de compilation')

  /* Un fil d'exécution n'a accès ni à Electron ni au processus principal. Le vérifier à
     l'exécution ne suffit pas : en développement `electron` se résout depuis node_modules et
     tout passe, alors qu'en version installée le fil échoue sur « Cannot find module
     'electron' ». On lit donc le bundle construit, seule preuve qui vaille. */
  console.log('\nisolement du fil')
  const seen = new Set<string>()
  const queue = [built]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    const source = await readFile(file, 'utf8').catch(() => '')
    assert(
      !/require\(["']electron["']\)|from ["']electron["']/.test(source),
      `${basename(file)} n'atteint jamais le module electron`
    )
    for (const match of source.matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
      queue.push(join(dirname(file), match[1]))
    }
  }

  console.log('\nexécution')
  const ids = Array.from({ length: POINTS }, (_, index) => `p${index}`)
  const flat = new Float32Array(POINTS * WIDTH)
  // Vingt amas, pour que la projection ait quelque chose à séparer.
  for (let index = 0; index < POINTS; index += 1) {
    const cluster = index % 20
    for (let axis = 0; axis < WIDTH; axis += 1) {
      flat[index * WIDTH + axis] =
        Math.sin((cluster + 1) * (axis + 1) * 0.05) + (Math.random() - 0.5) * 0.25
    }
  }

  const started = performance.now()
  const points = await new Promise<{ id: string; x: number; y: number }[]>((resolve, reject) => {
    const worker = new Worker(built, { workerData: { ids, flat, width: WIDTH }, transferList: [flat.buffer] })
    const guard = setTimeout(() => {
      void worker.terminate()
      reject(new Error('le fil n’a pas répondu en trois minutes'))
    }, 180_000)
    worker.on('message', (message: { type: string; points?: { id: string; x: number; y: number }[] }) => {
      if (message.type !== 'done') return
      clearTimeout(guard)
      resolve(message.points ?? [])
    })
    worker.on('error', (error) => {
      clearTimeout(guard)
      reject(error)
    })
  })
  const elapsed = performance.now() - started

  assert(points.length === POINTS, `tous les points reviennent (${points.length})`)
  assert(
    points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
    'aucune coordonnée n’est NaN ou infinie'
  )
  assert(
    points.every((point) => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1),
    'les coordonnées tiennent dans le repère unité'
  )
  const spread = new Set(points.map((point) => `${Math.round(point.x * 20)}:${Math.round(point.y * 20)}`))
  assert(spread.size > 40, `les points s’étalent au lieu de s’empiler (${spread.size} cases occupées)`)
  console.log(`  ${POINTS} points projetés en ${Math.round(elapsed)} ms`)
  assert(elapsed < 120_000, 'la projection reste sous deux minutes')

  console.log('\nTout est vert.')
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
