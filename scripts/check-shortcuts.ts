import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Un geste annoncé est un geste câblé : `npm run check:shortcuts`
 *
 * **L'aide de la carte annonçait un lasso qui ne faisait rien.** « Maj + glisser pour entourer
 * un groupe » — le geste fonctionnait visuellement, le tracé se dessinait, puis il appelait un
 * rappel vide et s'effaçait sans conséquence. On dessinait un cercle autour de vingt posts, on
 * relâchait, et rien. Le pire cas d'interface : le geste répond, et il ne fait rien.
 *
 * La décision de retirer le lasso était pourtant écrite, et juste — « la carte montre, elle ne
 * saisit pas ». Seule la phrase était restée.
 *
 * **Et « Ctrl » était écrit en dur aux deux endroits où le raccourci est réellement sous les
 * yeux** : le champ de recherche et la ligne des réglages. La fiche des raccourcis, elle,
 * calculait bien ⌘ sur Mac. L'interface se contredisait donc elle-même, ce qui est pire que si
 * les deux avaient tort ensemble : on ne sait plus laquelle croire.
 *
 * Deux règles, l'une pour chaque défaut.
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

const ROOT = 'src/renderer/src/components'
const renderer = readdirSync(ROOT)
  .filter((name) => name.endsWith('.tsx'))
  .map((name) => code(readFileSync(join(ROOT, name), 'utf8')))
  .join('\n')

const dictionary = readFileSync('src/renderer/src/i18n.ts', 'utf8').replace(/\r\n?/g, '\n')

console.log('Vérification des gestes annoncés\n')

console.log('un geste annoncé fait quelque chose')
{
  /**
   * Les gestes que les traductions promettent, et ce qui prouve qu'ils existent.
   *
   * Une table plutôt qu'une recherche automatique : « glisser », « cliquer », « molette »
   * s'écrivent de dix façons dans deux langues, et deviner lesquelles sont des promesses de
   * geste produirait des accusations au hasard — on a vu ailleurs ce que coûte un contrôle qui
   * crie au loup.
   */
  const PROMISED: { phrase: RegExp; wired: RegExp; what: string }[] = [
    { phrase: /lasso|entourer un groupe/i, wired: /onLasso=\{(?!IGNORE)/, what: 'le lasso de la carte' },
    { phrase: /clic droit|right-click/i, wired: /menuOnRightClick|onContextMenu/, what: 'le menu au clic droit' },
    { phrase: /double-clic|double-click/i, wired: /onDoubleClick|dblclick/i, what: 'le double-clic' },
    { phrase: /molette|scroll to zoom/i, wired: /onWheel|'wheel'/, what: 'le zoom à la molette' }
  ]

  for (const entry of PROMISED) {
    /* On ne regarde que les valeurs du dictionnaire, jamais les commentaires : celui qui
       *explique* le lasso retiré le cite, et le contrôle se re-signalerait lui-même. */
    const promised = [...dictionary.matchAll(/^\s*'[\w.]+':\s*\n?\s*'([^']*)'/gm)].some((match) =>
      entry.phrase.test(match[1])
    )
    if (!promised) {
      pass(`${entry.what} — rien ne le promet`)
      continue
    }
    if (entry.wired.test(renderer)) pass(`${entry.what} — promis, et câblé`)
    else fail(`${entry.what} est annoncé dans une traduction, mais rien ne le branche`)
  }
}

console.log('\nla touche de commande porte son nom sur cette machine')
{
  /* Une seule source, et personne ne réécrit « Ctrl » à la main. Trois écrans l'affichent ;
     deux se trompaient sur Mac. */
  if (!/export const MODIFIER/.test(readFileSync('src/renderer/src/format.ts', 'utf8'))) {
    fail('MODIFIER n’est plus déclaré dans format.ts')
  } else {
    pass('MODIFIER est déclaré une fois')
  }

  const offenders: string[] = []
  for (const name of readdirSync(ROOT).filter((entry) => entry.endsWith('.tsx'))) {
    const text = code(readFileSync(join(ROOT, name), 'utf8'))
    /* « Ctrl » dans du JSX ou une chaîne affichée. On accepte `MODIFIER`, et on ignore les
       noms d'événements comme `ctrlKey`, qui ne s'affichent jamais. */
    for (const match of text.matchAll(/(<kbd>\s*Ctrl|['"`][^'"`]*\bCtrl[+ ][^'"`]*['"`])/g)) {
      offenders.push(`${name} — ${match[0].slice(0, 40)}`)
    }
  }
  if (offenders.length === 0) pass('aucun « Ctrl » écrit en dur dans un composant')
  else for (const offender of offenders) fail(`${offender} : sur Mac le clavier dit ⌘`)
}

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} manquement(s).`)
process.exitCode = failures === 0 ? 0 : 1
