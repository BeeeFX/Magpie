import { readFileSync, readdirSync } from 'node:fs'

/**
 * Un bouton qui prétend agir agit : `npm run check:tasks`
 *
 * **Le bouton pause de chaque ligne du panneau des téléchargements était inerte pour quatre
 * tâches sur cinq.** Il écrivait bien `entry.paused` dans le registre, la ligne basculait sur
 * « En pause », la barre cessait de s'animer, la durée restante disparaissait — et le travail
 * continuait, le disque et le processeur avec. Seule la transcription lisait son drapeau.
 *
 * C'est la pire espèce de défaut : non seulement le geste ne fait rien, mais **tout ce que
 * l'utilisateur voit lui confirme qu'il a marché**. Il n'a aucune raison d'insister, et le
 * seul bouton qui suspendait réellement — « Tout suspendre », dans l'en-tête — a l'air
 * redondant avec celui qu'il vient d'utiliser.
 *
 * Deux règles, qui se répondent :
 *
 * 1. **toute tâche dont l'interface montre une pause a un producteur qui lit son drapeau.**
 *    Le registre le rend facile à croire : `isTaskPaused(id)` retombe sur le drapeau global
 *    quand la tâche n'est pas inscrite, donc l'appeler *quelque part* ne prouve rien — il
 *    faut que la boucle qui travaille le consulte ;
 * 2. **toute méthode `stop*` du contrat est appelée par le rendu.** `stopImageReading`
 *    existait, était implémentée, exposée par le pont — et n'était appelée nulle part. Dix
 *    minutes de lecture sur neuf mille posts dont la seule sortie était « Tout suspendre ».
 *
 * La conclusion inverse est aussi valide, et c'est celle qu'on a tirée pour la synchronisation
 * et le regroupement : **une pause absente est honnête, une pause inerte ne l'est pas.** Leur
 * bouton a été retiré plutôt que câblé.
 */

let failures = 0
function fail(message: string): void {
  failures += 1
  console.log(`  ✗ ${message}`)
}
function pass(message: string): void {
  console.log(`  ✓ ${message}`)
}

function code(text: string): string {
  const blank = (chunk: string): string => chunk.replace(/[^\n]/g, ' ')
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank)
}

const downloads = code(readFileSync('src/renderer/src/components/Downloads.tsx', 'utf8'))
const types = readFileSync('src/shared/types.ts', 'utf8')

console.log('Vérification des tâches de fond\n')

console.log('une pause montrée est une pause qui suspend')
{
  /** Où chaque genre de tâche travaille, et l'identifiant sous lequel le registre le range. */
  const PRODUCERS: Record<string, { file: string; id: string }> = {
    thumbnails: { file: 'src/main/index.ts', id: 'preload:thumbnails' },
    clips: { file: 'src/main/index.ts', id: 'preload:clips' },
    images: { file: 'src/main/tagging/read-images.ts', id: 'read:images' },
    transcribe: { file: 'src/main/tagging/transcribe.ts', id: 'transcribe' }
  }

  /* Ce que l'interface propose de suspendre. On le lit dans le composant plutôt que de le
     supposer : c'est la seule source qui décide ce que l'utilisateur voit. */
  const guard = /const pausable = ([^\n]+)/.exec(downloads)
  if (!guard) {
    fail('Downloads.tsx ne dit plus quelles tâches se suspendent')
  } else {
    /* `pausable` **liste** ce qui se suspend, au lieu d'exclure ce qui ne se suspend pas.
       Le sens compte : écrit en négatif, un genre de tâche ajouté héritait d'une pause que
       personne ne tenait — c'est ainsi que « Téléchargement des modèles » et « Export » en ont
       reçu une, chacun le jour de sa création. En positif, le défaut est l'absence de pause,
       qui est le défaut honnête. */
    const offered = [...guard[1].matchAll(/task\.kind === '(\w+)'/g)].map((match) => match[1])
    /* Les genres viennent de leur propre union, et **tous** sont examinés. Une première
       version filtrait ceux qu'aucun producteur ne déclarait, ce qui écartait exactement le
       cas à attraper : proposer une pause pour une tâche dont personne ne tient le drapeau
       passait alors au vert, faute d'être regardé. */
    const union = /export type BackgroundTaskKind =([^=]*?)\n\n/.exec(types)
    const kinds = union ? [...union[1].matchAll(/'(\w+)'/g)].map((match) => match[1]) : []
    if (kinds.length === 0) fail('BackgroundTaskKind introuvable')

    for (const kind of kinds) {
      if (!offered.includes(kind)) {
        pass(`${kind} — pas de pause proposée, donc rien à tenir`)
        continue
      }
      const producer = PRODUCERS[kind]
      if (!producer) {
        fail(`${kind} — l’interface propose une pause, mais aucun producteur n’est connu`)
        continue
      }
      const source = code(readFileSync(producer.file, 'utf8'))
      if (source.includes(`isTaskPaused('${producer.id}')`) || source.includes('isTaskPaused(TASK)')) {
        pass(`${kind} — ${producer.id} est consulté dans ${producer.file}`)
      } else {
        fail(`${kind} — la pause est proposée, mais rien ne lit isTaskPaused('${producer.id}')`)
      }
    }
  }
}

console.log('\ntoute commande d’arrêt du contrat est atteignable')
{
  /* Une méthode `stop*` que le rendu n'appelle jamais est du travail qu'on ne peut pas
     interrompre — et le contrat laisse croire le contraire. */
  const stops = [...types.matchAll(/^\s{2}(stop\w+)\(/gm)].map((match) => match[1])
  if (stops.length === 0) fail('aucune méthode stop* trouvée dans MagpieApi')

  /* Tous les composants, et non une liste écrite à la main : celle-ci ignorait le panneau
     d'export et signalait donc un bouton qui existait. Une liste à tenir à jour est une liste
     qui sera en retard. */
  const renderer = readdirSync('src/renderer/src/components')
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => code(readFileSync(`src/renderer/src/components/${name}`, 'utf8')))
    .join('\n')

  for (const stop of stops) {
    /* Le motif tolère la coupure de ligne : `magpie` en bout de ligne et l'appel en
       dessous est la mise en forme habituelle du dépôt, et l'exiger sur une seule ligne
       faisait signaler un bouton bien présent. */
    if (new RegExp(`magpie\\s*\\.\\s*${stop}\\(`).test(renderer)) pass(`${stop} est appelée`)
    else fail(`${stop} existe dans le contrat mais aucun bouton ne l’appelle`)
  }
}

console.log('\n« Tout couper » coupe tout')
{
  /* Le geste qui promet le plus est celui qui doit le moins oublier : il en oubliait un
     cinquième, la lecture d'images, qui continuait sans rien à l'écran pour le dire. */
  const organizer = code(readFileSync('src/renderer/src/components/AiOrganizer.tsx', 'utf8'))
  const at = organizer.indexOf('const stopEverything')
  const body = at < 0 ? '' : organizer.slice(at, organizer.indexOf('}, [', at))
  if (body.length === 0) {
    fail('stopEverything introuvable')
  } else {
    for (const call of ['cancelSync(', 'stopPreload(\'thumbnails\')', 'stopPreload(\'clips\')', 'stopImageReading(', 'stopTranscription(']) {
      if (body.includes(call)) pass(`stopEverything appelle ${call.replace(/\($/, '')}`)
      else fail(`stopEverything oublie ${call.replace(/\($/, '')}`)
    }
    /* Et la remise à zéro doit couvrir les mêmes étapes : écrite à la main, elle oubliait
       `images`, qui repassait donc à « à faire » sans jamais avoir été remise à zéro. */
    if (/STEP_ORDER\.map/.test(body)) pass('la remise à zéro dérive de STEP_ORDER')
    else fail('la remise à zéro énumère les étapes à la main, donc elle en oubliera une')
  }
}

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} manquement(s).`)
process.exitCode = failures === 0 ? 0 : 1
