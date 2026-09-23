import { code, read } from './source'
import { readdirSync } from 'node:fs'
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


const ROOT = 'src/renderer/src/components'
const renderer = readdirSync(ROOT)
  .filter((name) => name.endsWith('.tsx'))
  .map((name) => code(read(join(ROOT, name))))
  .join('\n')

const dictionary = read('src/renderer/src/i18n.ts').replace(/\r\n?/g, '\n')

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
  if (!/export const MODIFIER/.test(read('src/renderer/src/format.ts'))) {
    fail('MODIFIER n’est plus déclaré dans format.ts')
  } else {
    pass('MODIFIER est déclaré une fois')
  }

  const offenders: string[] = []
  for (const name of readdirSync(ROOT).filter((entry) => entry.endsWith('.tsx'))) {
    const text = code(read(join(ROOT, name)))
    /* « Ctrl » dans du JSX ou une chaîne affichée. On accepte `MODIFIER`, et on ignore les
       noms d'événements comme `ctrlKey`, qui ne s'affichent jamais. */
    for (const match of text.matchAll(/(<kbd>\s*Ctrl|['"`][^'"`]*\bCtrl[+ ][^'"`]*['"`])/g)) {
      offenders.push(`${name} — ${match[0].slice(0, 40)}`)
    }
  }
  if (offenders.length === 0) pass('aucun « Ctrl » écrit en dur dans un composant')
  else for (const offender of offenders) fail(`${offender} : sur Mac le clavier dit ⌘`)
}

console.log('\nla fiche du mur ne promet que ce que le mur fait')
{
  /**
   * Chaque ligne du groupe « Sur le mur » de la fiche, et ce qui prouve qu'elle est câblée.
   *
   * La fiche est tenue à la main, et son en-tête le dit : c'est un engagement. Pendant des
   * versions, elle n'annonçait sur le mur que l'Entrée, tandis que la spécification (§14)
   * déclarait absents les flèches, l'aperçu, `Ctrl+A` et la plage — vrai, mais rien ne tenait
   * les deux ensemble. Livrer ces gestes sans le dire aurait été aussi faux que l'inverse.
   *
   * D'où deux règles. Une ligne de la fiche sans preuve dans cette table, ou dont la preuve ne se
   * retrouve plus dans le code du mur, échoue. Et §14 ne dit plus absent ce que la fiche annonce.
   * Une table plutôt qu'une déduction, pour la même raison que plus haut : un contrôle qui devine
   * finit par crier au loup.
   */
  const WALL: Record<string, { proof: RegExp; missing?: RegExp }> = {
    'shortcuts.wallMove': { proof: /ARROWS\[event\.key\][\s\S]{0,300}move\(direction\)/, missing: /Les flèches/ },
    'shortcuts.wallPreview': { proof: /event\.key === ' '[\s\S]{0,600}setPreviewId\(/, missing: /`Espace`/ },
    /* L'Entrée est celle du navigateur : l'ouverture est un vrai bouton, qui la reçoit seul. */
    'shortcuts.openPost': { proof: /<button[^>]*\n[^>]*className="card__open"/ },
    'shortcuts.selectAll': {
      proof: /key\.toLowerCase\(\) === 'a'[\s\S]{0,600}selectAllResults\(\)/,
      missing: /`Ctrl\+A`/
    },
    'shortcuts.selectRange': { proof: /event\.shiftKey\) onSelect\(post\.id, 'range'\)/, missing: /`Maj`\+clic/ },
    'shortcuts.selectOne': { proof: /event\.ctrlKey \|\| event\.metaKey \|\| selectionMode\) onSelect\(post\.id, 'toggle'\)/ },
    'shortcuts.wallEscape': { proof: /event\.key === 'Escape'[\s\S]{0,300}setPreviewId\(null\)/ }
  }

  const sheet = code(read(join(ROOT, 'Shortcuts.tsx')))
  const start = sheet.indexOf("title: 'shortcuts.groupWall'")
  const end = sheet.indexOf('title:', start + 1)
  const labels = [...sheet.slice(start, end < 0 ? undefined : end).matchAll(/label: '([\w.]+)'/g)].map(
    (match) => match[1]
  )
  const wall = ['Grid.tsx', 'Card.tsx'].map((name) => code(read(join(ROOT, name)))).join('\n')

  if (start < 0 || labels.length === 0) fail('le groupe « Sur le mur » est introuvable dans Shortcuts.tsx')
  for (const label of labels) {
    const entry = WALL[label]
    if (!entry) fail(`${label} est dans la fiche, sans preuve dans ce contrôle — ajoutez-la`)
    else if (!entry.proof.test(wall)) fail(`${label} est annoncé, mais Grid.tsx et Card.tsx ne le câblent plus`)
    else pass(`${label} — annoncé, et câblé`)
  }

  const spec = read('SPEC.md')
  const heading = spec.indexOf('**§9 — Raccourcis de la grille.**')
  const paragraph = heading < 0 ? '' : spec.slice(heading, spec.indexOf('\n\n', heading))
  const contradicted = labels.filter((label) => WALL[label]?.missing?.test(paragraph))
  if (contradicted.length === 0) pass('SPEC §14 ne dit absent aucun geste que la fiche annonce')
  else for (const label of contradicted) fail(`SPEC §14 dit absent ce que ${label} annonce`)
}

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} manquement(s).`)
process.exitCode = failures === 0 ? 0 : 1
