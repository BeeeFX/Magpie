import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Rien ne détruit au premier clic : `npm run check:destructive`
 *
 * **L'écran « Que garder ? » supprimait définitivement toutes les collections en un clic.** Son
 * bouton principal, dans un écran où l'on venait de cliquer sur « Approfondi » pour lancer une
 * analyse — pas pour faire du ménage — et avec **toutes les cases décochées par défaut**. Le
 * libellé annonçait ce qu'on garde, jamais ce qu'on perd.
 *
 * On a d'abord cru pouvoir s'appuyer sur l'annulation existante. C'était faux, et le vérifier a
 * changé le correctif : `revertOrganizerApplication` ne sait que **défaire un classement** —
 * désarchiver des posts, supprimer les collections qu'elle a elle-même créées. Rien, chez elle,
 * ne peut recréer ce qui a été détruit. D'où la migration 28 et son instantané.
 *
 * ---
 *
 * **Sur la forme du contrôle.** La première version demandait « ce fichier contient-il un
 * `ConfirmButton` ? ». Elle a signalé cinq manquements dont **quatre étaient faux** : le rail
 * des collections protège ses deux suppressions, mais avec son propre état (`confirmDelete`,
 * `merging && mergeInto`) plutôt qu'avec le composant partagé ; la confirmation de la carte vit
 * dans l'enfant qui porte le menu, pas dans le parent qui appelle ; et l'accueil choisit un
 * dossier alors qu'il n'y a encore rien à déplacer.
 *
 * Un contrôle qui crie au loup coûte plus qu'un contrôle absent : on cherche le défaut au
 * mauvais endroit, puis on cesse de le lire. La table ci-dessous nomme donc **quelle protection
 * couvre quel appel**, une ligne par site. C'est plus long à écrire et ça dit quelque chose de
 * vrai : la protection devient nommée, donc la retirer se voit.
 */

const ROOT = 'src/renderer/src/components'

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

/**
 * Les appels qui détruisent du travail ou coûtent des minutes.
 *
 * La liste est explicite plutôt que déduite d'un préfixe : `removeFromCollection` défait un
 * classement qui se refait d'un clic, `deleteMapLabel` retire un mot qu'on retape en trois
 * secondes. Ce qui mérite une question, cela se décide.
 */
const DESTRUCTIVE: Record<string, string> = {
  keepOnlyCollections: 'supprime définitivement des collections entières',
  chooseLibraryFolder: 'copie des dizaines de gigaoctets, puis redémarre l’application',
  regenerateMap: 'jette la projection rangée — ~26 s, et les étiquettes perdent leurs ancres',
  untagSelection: 'retire un tag sur toute la sélection, et perd son origine',
  deleteCollection: 'supprime une collection et son contenu',
  mergeCollections: 'fond deux collections, la source disparaît'
}

/** Ce qui couvre chaque site d'appel, nommément. */
const GUARDS: { file: string; call: string; guard: RegExp | null; why: string }[] = [
  {
    file: 'AiOrganizer.tsx',
    call: 'keepOnlyCollections',
    guard: /confirm="organizer\.keepConfirm"/,
    why: 'un ConfirmButton qui chiffre la perte'
  },
  {
    file: 'Settings.tsx',
    call: 'chooseLibraryFolder',
    guard: /confirm="settings\.moveLibraryYes"/,
    why: 'un ConfirmButton qui annonce le redémarrage'
  },
  {
    file: 'Welcome.tsx',
    call: 'chooseLibraryFolder',
    guard: null,
    why: 'rien à déplacer pendant l’accueil : on choisit où la bibliothèque vivra, on n’en bouge pas une'
  },
  {
    file: 'LibraryMap.tsx',
    call: 'regenerateMap',
    guard: null,
    why: 'la question est posée par OrganizerMap, qui porte l’entrée de menu'
  },
  {
    file: 'OrganizerMap.tsx',
    call: 'onRegenerate',
    guard: /regenerateArmed/,
    why: 'une entrée de menu qui se retourne, et nomme le coût'
  },
  {
    file: 'Toolbar.tsx',
    call: 'untagSelection',
    guard: /confirm="bulk\.untagYes"/,
    why: 'un ConfirmButton qui nomme le tag et compte les posts'
  },
  {
    file: 'CollectionsRail.tsx',
    call: 'deleteCollection',
    guard: /confirmDelete/,
    why: 'une question posée sur place, dans le rail'
  },
  {
    file: 'CollectionsRail.tsx',
    call: 'mergeCollections',
    guard: /merging && mergeInto/,
    why: 'choisir une cible ne commet pas : un second bouton commet'
  },
  {
    file: 'CollectionsManager.tsx',
    call: 'deleteCollection',
    guard: /confirming === collection\.id/,
    why: 'la bascule en deux temps du gestionnaire'
  },
  {
    file: 'CollectionsManager.tsx',
    call: 'mergeCollections',
    guard: /ConfirmButton/,
    why: 'un ConfirmButton distinct du choix de la cible'
  }
]

const files = readdirSync(ROOT).filter((name) => name.endsWith('.tsx'))
const sources = new Map(files.map((name) => [name, code(readFileSync(join(ROOT, name), 'utf8'))]))

console.log('Vérification des gestes destructeurs\n')

console.log('chaque appel destructeur est couvert, nommément')
{
  for (const entry of GUARDS) {
    const text = sources.get(entry.file)
    if (text === undefined) {
      fail(`${entry.file} n’existe plus — la table cite une protection sur un fichier disparu`)
      continue
    }
    if (!new RegExp(`\\b${entry.call}\\(`).test(text)) {
      fail(`${entry.file} n’appelle plus ${entry.call} — l’entrée de la table est un vestige`)
      continue
    }
    if (entry.guard === null) {
      pass(`${entry.file} · ${entry.call} — sans garde : ${entry.why}`)
    } else if (entry.guard.test(text)) {
      pass(`${entry.file} · ${entry.call} — ${entry.why}`)
    } else {
      fail(`${entry.file} · ${entry.call} — la protection a disparu (${entry.why})`)
    }
  }

  /* La règle qui attrape la vraie régression : un **nouveau** site d'appel que la table ne
     connaît pas. Sans elle, ajouter un bouton « supprimer » ailleurs passerait inaperçu. */
  for (const [name, text] of sources) {
    for (const call of Object.keys(DESTRUCTIVE)) {
      if (!new RegExp(`\\b${call}\\(`).test(text)) continue
      if (GUARDS.some((entry) => entry.file === name && entry.call === call)) continue
      fail(`${name} appelle ${call} sans figurer dans la table — ${DESTRUCTIVE[call]}`)
    }
  }
}

console.log('\nla suppression de collections est rattrapable')
{
  /* La règle la plus concrète du lot : sans instantané pris **avant** les suppressions, rien
     au monde ne peut rendre un nom, une couleur, des mots-clés et une appartenance. */
  const collections = code(readFileSync('src/main/tagging/collections.ts', 'utf8'))
  const at = collections.indexOf('export function keepOnly')
  const body = at < 0 ? '' : collections.slice(at, collections.indexOf('\n}', at))
  if (body.length === 0) {
    fail('keepOnly introuvable')
  } else {
    const snapshotAt = body.indexOf('collection_snapshots')
    const deleteAt = body.indexOf('DELETE FROM collections')
    if (snapshotAt < 0) fail('keepOnly ne prend aucun instantané avant de supprimer')
    else if (deleteAt >= 0 && snapshotAt > deleteAt) {
      fail('l’instantané est pris après les suppressions : il décrit un état déjà perdu')
    } else pass('l’instantané précède les suppressions')
  }

  if (!/export function restoreRemovedCollections/.test(collections)) {
    fail('aucun rétablissement n’est offert')
  } else pass('restoreRemovedCollections existe')

  /* Et il doit être atteignable. Le motif tolère la coupure de ligne : `magpie` en bout de
     ligne et l'appel en dessous est la mise en forme habituelle du dépôt, et l'exiger sur une
     seule ligne faisait signaler un appel bien présent. */
  const renderer = [...sources.values()].join('\n')
  if (/magpie\s*\.\s*restoreRemovedCollections\(/.test(renderer)) pass('et l’interface le propose')
  else fail('restoreRemovedCollections existe mais rien ne l’appelle')
}

console.log('\nla confirmation nomme la conséquence, pas « oui »')
{
  const organizer = sources.get('AiOrganizer.tsx') ?? ''
  /* Un second temps qui dit « Confirmer » ne dit rien : c'est le nombre qui informe. Le
     libellé du bouton principal annonçait d'ailleurs ce qu'on garde, jamais ce qu'on perd. */
  if (/confirmVars=\{\{ count: existing\.length - keeping\.length \}\}/.test(organizer)) {
    pass('« Que garder ? » chiffre ce qui sera supprimé')
  } else {
    fail('« Que garder ? » ne chiffre pas ce qui sera supprimé')
  }

  /* Et son défaut ne détruit pas : toutes les cases décochées faisaient du bouton principal
     un « tout supprimer » atteint par inadvertance. */
  if (/setKeeping\(rows\.map/.test(organizer)) pass('et il garde tout par défaut')
  else fail('le défaut de « Que garder ? » ne garde rien, donc il détruit par inadvertance')
}

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} manquement(s).`)
process.exitCode = failures === 0 ? 0 : 1
