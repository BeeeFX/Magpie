/**
 * Le processus des modèles répond, et la fenêtre reste vivante : `npm run check:inference`
 *
 * Ce contrôle-ci ne tourne pas sous `tsx` comme les autres : il a besoin d'Electron, parce que
 * c'est précisément Electron qu'il vérifie. Deux choses, qu'aucun typage ne peut attester.
 *
 * **Que le point d'entrée se charge là où il se trouvera vraiment.** Le fil de projection s'est
 * déjà cassé exactement ainsi en version installée — « Cannot find module …/chunks/… » — et le
 * piège est le même ici, en pire : le worker doit résoudre `@huggingface/transformers`,
 * `onnxruntime-node` et leur parenté depuis l'endroit d'où on le lance. Si une archive
 * `app.asar` est présente à côté, c'est **elle** qu'on exerce, puisque c'est le cas qui casse.
 *
 * **Que le calcul ait bien quitté le processus principal.** `onnxruntime-node` exécute son `run`
 * de façon synchrone : tant qu'il tournait ici, chaque encodage retenait la fenêtre. On mesure
 * donc le plus long créneau pendant lequel la boucle d'événements n'a pas pu tourner, pendant
 * qu'un modèle se charge et que quatre encodages s'enchaînent de l'autre côté.
 *
 * Les modèles sont lus depuis le cache de la bibliothèque. Le premier passage les télécharge —
 * quelques centaines de mégaoctets, une fois.
 */
const { app, utilityProcess } = require('electron')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
/* La copie empaquetée d'abord : c'est la seule dont la résolution de modules pose question. */
const PACKED = join(root, 'release', 'win-unpacked', 'resources', 'app.asar', 'out', 'main', 'inference.worker.js')
const BUILT = join(root, 'out', 'main', 'inference.worker.js')
const script = existsSync(join(root, 'release', 'win-unpacked', 'resources', 'app.asar')) ? PACKED : BUILT

/** Au-delà, la fenêtre saccade ; à cinq secondes, Windows la déclare morte. */
const LIMIT_MS = 250

let failures = 0
function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${message}`)
}

let longest = 0
let tick = Date.now()
const beat = setInterval(() => {
  longest = Math.max(longest, Date.now() - tick)
  tick = Date.now()
}, 10)

app.whenReady().then(() => {
  console.log(`Processus des modèles — ${script.includes('app.asar') ? 'copie empaquetée' : 'build de développement'}\n`)
  const child = utilityProcess.fork(script, [], { serviceName: 'Magpie models', stdio: 'inherit' })
  const waiting = new Map()
  let next = 1
  const ask = (request) =>
    new Promise((resolve, reject) => {
      const id = next++
      waiting.set(id, { resolve, reject })
      child.postMessage({ ...request, id })
    })

  child.on('message', (reply) => {
    const entry = waiting.get(reply.id)
    if (!entry) return
    waiting.delete(reply.id)
    if (reply.ok) entry.resolve(reply)
    else entry.reject(new Error(reply.message))
  })

  child.once('spawn', async () => {
    try {
      await ask({ kind: 'configure', cacheDir: join(app.getPath('userData'), 'models') })
      assert(true, 'le point d’entrée se charge et répond')

      const texts = await ask({ kind: 'embed', texts: ['blender donut tutorial', 'geometry nodes'] })
      assert(texts.width === 384 && texts.flat.length === 768, 'le texte rend deux vecteurs de 384')
      const norm = Math.sqrt(texts.flat.slice(0, 384).reduce((sum, value) => sum + value * value, 0))
      assert(Math.abs(norm - 1) < 1e-3, 'les vecteurs de texte sont unitaires')

      const image = await ask({ kind: 'encode-images', paths: [join(root, 'build', 'icon.png')] })
      assert(
        image.structure.length === 384 && image.meaning.length === 768,
        'une image rend sa structure et son sujet'
      )

      const prompts = await ask({ kind: 'encode-prompts', prompts: ['a photo of a cat'] })
      assert(prompts.width === 768, 'la tour texte de SigLIP répond dans le repère des images')

      /* Deux secondes de son faible : on n'attend rien du contenu, seulement que la chaîne
         complète — modèle, découpage, langue — aille au bout sans lever. */
      const audio = new Float32Array(16_000 * 2)
      for (let i = 0; i < audio.length; i += 1) audio[i] = Math.sin(i / 40) * 0.02
      const heard = await ask({ kind: 'transcribe', audio, language: 'french' })
      assert(typeof heard.text === 'string', 'la reconnaissance de parole rend du texte')
    } catch (error) {
      failures += 1
      console.log(`  ✗ ${error.message}`)
    }

    longest = Math.max(longest, Date.now() - tick)
    clearInterval(beat)
    assert(
      longest < LIMIT_MS,
      `le processus principal reste disponible (plus long blocage : ${longest} ms)`
    )

    console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} échec(s).`)
    child.kill()
    process.exitCode = failures === 0 ? 0 : 1
    app.quit()
  })
})
