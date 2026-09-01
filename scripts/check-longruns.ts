import { code, read } from './source'
/**
 * Ce qui dure se dit, et se coupe : `npm run check:longruns`
 *
 * **L'analyse pouvait tourner deux heures sans qu'on puisse l'arrêter.** Le commentaire du
 * code le disait lui-même. Aucun bouton, aucune durée restante — et l'écran qui la montrait se
 * refermait **en silence** : le garde-fou de sortie ne testait que `stepsRunning`, le drapeau
 * de la *préparation*, que `OrganizerSteps` remet à faux juste avant d'appeler `onFinished()`,
 * c'est-à-dire juste avant que l'analyse ne démarre. Pendant toute la phase la plus longue,
 * Échap refermait sans un mot.
 *
 * Pire à la réouverture : l'écran revenait à « Rapide ou approfondi ? » et proposait de lancer
 * ce qui tournait déjà.
 *
 * Deux autres travaux étaient muets. L'export écrit une fiche par post — neuf mille huit cent
 * cinquante — sans compteur ni sortie. Et un premier rangement télécharge **688 Mo** de modèles
 * en disant « Préparation en cours… », ce qui, sur une connexion ordinaire, fait huit minutes
 * indiscernables d'une application figée.
 *
 * La règle : **tout travail qui peut dépasser la minute expose une progression et une sortie.**
 * Le registre des tâches sert de canal commun — il porte déjà les autres travaux longs et
 * traverse jusqu'à l'icône de la barre système ; aucun de ces trois n'avait de raison
 * d'inventer le sien.
 */

let failures = 0
function fail(message: string): void {
  failures += 1
  console.log(`  ✗ ${message}`)
}
function pass(message: string): void {
  console.log(`  ✓ ${message}`)
}


/**
 * Les trois travaux qui dépassent la minute, et ce qui doit les couvrir.
 *
 * `stop: null` dit qu'il n'y a pas de sortie **et pourquoi** — écrire un motif qui accepte tout
 * aurait donné un vert sans contenu, c'est-à-dire le contraire d'un contrôle.
 */
const LONG: {
  what: string
  stop: { file: string; pattern: RegExp } | { none: string }
  progress: { file: string; pattern: RegExp }
}[] = [
  {
    what: 'l’analyse',
    stop: { file: 'src/main/tagging/organize.ts', pattern: /export function stopProposal/ },
    progress: {
      file: 'src/renderer/src/components/AiOrganizer.tsx',
      pattern: /organizerProgress\?\.total/
    }
  },
  {
    what: 'l’export',
    stop: { file: 'src/main/export.ts', pattern: /export function stopExport/ },
    progress: {
      file: 'src/main/export.ts',
      pattern: /backgroundTasks\.update\(EXPORT_TASK/
    }
  },
  {
    what: 'le téléchargement des modèles',
    stop: {
      none: 'la requête vit dans la bibliothèque ; l’interrompre laisserait un fichier de modèle tronqué que rien ne saurait reprendre. Il doit donc, au minimum, se montrer — c’est ce qui manquait'
    },
    progress: {
      file: 'src/main/tagging/inference.ts',
      pattern: /backgroundTasks\.update\(DOWNLOAD_TASK/
    }
  }
]

console.log('Vérification des travaux longs\n')

console.log('ce qui dure se montre, et se coupe')
{
  for (const entry of LONG) {
    if ('none' in entry.stop) {
      pass(`${entry.what} — sans sortie, à dessein : ${entry.stop.none}`)
    } else {
      const stopSource = code(read(entry.stop.file))
      if (entry.stop.pattern.test(stopSource)) pass(`${entry.what} — une sortie existe`)
      else fail(`${entry.what} — aucune sortie dans ${entry.stop.file}`)
    }

    const progressSource = code(read(entry.progress.file))
    if (entry.progress.pattern.test(progressSource)) pass(`${entry.what} — sa progression se dit`)
    else fail(`${entry.what} — aucune progression dans ${entry.progress.file}`)
  }
}

console.log('\nrefermer pendant que ça travaille demande d’abord')
{
  const organizer = code(read('src/renderer/src/components/AiOrganizer.tsx'))
  const at = organizer.indexOf('const onClose')
  const body = at < 0 ? '' : organizer.slice(at, organizer.indexOf('}, [', at) + 40)

  if (body.length === 0) {
    fail('onClose introuvable')
  } else {
    /* `stepsRunning` seul ne suffit pas : `OrganizerSteps` le remet à faux **avant** de lancer
       l'analyse, donc la phase la plus longue n'était pas couverte. */
    if (!/stepsRunning/.test(body)) fail('onClose ne teste plus la préparation')
    else if (!/phase === 'loading'/.test(body)) {
      fail('onClose ne couvre pas la phase d’analyse — la plus longue, et elle se refermait en silence')
    } else pass('onClose couvre la préparation et l’analyse')
  }

  /* Et la réouverture ne doit pas proposer de relancer ce qui tourne. */
  const reopen = organizer.slice(organizer.indexOf('if (!open) return'))
  if (/phaseRef\.current === 'loading'/.test(reopen.slice(0, 600))) {
    pass('rouvrir pendant l’analyse ne remet pas l’écran au choix')
  } else {
    fail('rouvrir pendant l’analyse revient au choix, et propose de relancer ce qui tourne')
  }
}

console.log('\nun arrêt demandé n’est pas une panne')
{
  /* Afficher un arrêt en rouge ferait passer un choix de l'utilisateur pour un échec de
     l'application — et l'inviterait à recommencer ce qu'il vient d'interrompre. */
  for (const [file, cancelled] of [
    ['src/renderer/src/components/AiOrganizer.tsx', 'ProposalCancelled'],
    ['src/renderer/src/components/ExportPanel.tsx', 'ExportCancelled']
  ] as const) {
    const text = code(read(file))
    if (new RegExp(cancelled).test(text)) pass(`${cancelled} se distingue d’une panne`)
    else fail(`${file} affiche un arrêt demandé comme une erreur`)
  }
}

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} manquement(s).`)
process.exitCode = failures === 0 ? 0 : 1
