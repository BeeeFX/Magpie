import { code, read } from './source'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * L'interface reste utilisable sans souris et sans yeux : `npm run check:a11y`
 *
 * Les règles ne sont pas des principes généraux : chacune rejoue un défaut qui a été livré.
 *
 * **Un `role="button"` ne contient pas de boutons.** La carte en portait un tout en abritant
 * quatre contrôles — favori, copier, Nitrate, volume. Les lecteurs d'écran aplatissent le
 * contenu d'un bouton et peuvent ne jamais les exposer ; et le gestionnaire de touche de
 * l'ancêtre interceptait l'Entrée destinée à l'enfant, si bien qu'« Entrée » sur « Copier le
 * lien » ouvrait le post au lieu de copier.
 *
 * **Un curseur a un nom.** Celui de la densité n'en avait aucun : son `title` était posé sur le
 * `<label>`, dont le contenu textuel est vide, et l'`input` n'avait ni `aria-label` ni texte.
 *
 * **Une fenêtre modale piège le focus.** `useModalFocus` existe et fait les trois gestes — le
 * piège, l'entrée, le retour — mais le gestionnaire de collections se déclarait `aria-modal`
 * sans l'appeler : Tab sortait dans la grille masquée derrière.
 *
 * **Un `<label>` dont le seul texte est une touche nomme mal son champ.** Le champ de recherche
 * s'annonçait « CtrlK », parce que ses deux `<kbd>` étaient son unique contenu textuel et que
 * le `placeholder` s'efface devant un label existant.
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

/**
 * Le code sans ses commentaires, lignes conservées.
 *
 * Sans quoi le commentaire qui *explique* un défaut corrigé le fait re-signaler : celui de la
 * carte cite `role="button"` pour dire précisément qu'il n'y en a plus. Les sauts de ligne sont
 * préservés pour que les numéros signalés restent ceux du fichier.
 */

const files = readdirSync(ROOT)
  .filter((name) => name.endsWith('.tsx'))
  .map((name) => join(ROOT, name))

console.log('Vérification de l’accessibilité\n')

console.log('un bouton ne contient pas de boutons')
{
  const offenders: string[] = []
  for (const file of files) {
    const lines = code(read(file)).split('\n')
    for (const [index, line] of lines.entries()) {
      if (!/role="button"/.test(line)) continue
      /* On regarde le sous-arbre qui suit, jusqu'à la fermeture de l'élément : un contrôle
         interactif y rend le motif invalide. Quarante lignes couvrent largement une carte. */
      const subtree = lines.slice(index, index + 60).join('\n')
      if (/<(button|input|select|textarea)\b|<a\s[^>]*href=/.test(subtree)) {
        offenders.push(`${file}:${index + 1} — un contrôle vit sous ce role="button"`)
      }
    }
  }
  if (offenders.length === 0) pass('aucun role="button" n’abrite de contrôle')
  else for (const offender of offenders) fail(offender)
}

console.log('\nun curseur a un nom')
{
  const offenders: string[] = []
  for (const file of files) {
    const lines = code(read(file)).split('\n')
    for (const [index, line] of lines.entries()) {
      if (!/type="range"/.test(line)) continue
      /* La fenêtre couvre l'élément entier : le lecteur vidéo pose son nom après une dizaine
         de gestionnaires d'événements. */
      const element = lines.slice(index, index + 24).join('\n')
      if (!/aria-label(?:ledby)?=/.test(element)) {
        offenders.push(`${file}:${index + 1} — ce curseur n’a pas de nom accessible`)
      }
    }
  }
  if (offenders.length === 0) pass('chaque curseur porte son aria-label')
  else for (const offender of offenders) fail(offender)
}

console.log('\nune fenêtre modale piège le focus')
{
  const offenders: string[] = []
  for (const file of files) {
    const text = code(read(file))
    if (!/aria-modal="true"/.test(text)) continue
    if (!/useModalFocus\s*\(/.test(text)) {
      offenders.push(`${file} — se déclare modale sans appeler useModalFocus`)
    }
  }
  if (offenders.length === 0) pass('chaque fenêtre modale appelle useModalFocus')
  else for (const offender of offenders) fail(offender)
}

console.log('\nun label dit ce que le champ attend')
{
  const offenders: string[] = []
  for (const file of files) {
    const text = code(read(file))
    /* Un `<label>` dont le seul contenu textuel est un `<kbd>` : le nom accessible calculé est
       alors le raccourci, et le `placeholder` est ignoré puisqu'un label existe. */
    for (const match of text.matchAll(/<label[^>]*>([\s\S]{0,900}?)<\/label>/g)) {
      const body = match[1]
      if (!/<kbd/.test(body)) continue
      /* Les accolades d'abord, les balises ensuite : une flèche de fonction contient un `>`,
         et retirer les balises en premier laissait `setSearch(e.target.value)}` passer pour du
         texte visible — la règle ne se déclenchait donc jamais sur le seul cas qui l'a motivée. */
      const stripped = body
        .replace(/<kbd[\s\S]*?<\/kbd>/g, '')
        .replace(/\{[^{}]*\}/g, '')
        .replace(/<[^>]*>/g, '')
        .trim()
      /* Ce qui compte n'est pas qu'il reste du texte à l'œil, mais qu'il reste **un nom**. Un
         `placeholder` n'en est pas un — il s'efface devant le label, c'est précisément ce qui a
         produit « CtrlK ». On reconnaît donc les deux formes qui en sont un : un `aria-label`,
         ou un libellé masqué visuellement mais lu. */
      const named =
        /aria-label(?:ledby)?=/.test(body) ||
        /class(?:Name)?="[^"]*(?:__label|sr-only|visually-hidden)/.test(body)
      if (!stripped && !named) {
        const line = text.slice(0, match.index).split('\n').length
        offenders.push(`${file}:${line} — ce label ne dit qu'un raccourci`)
      }
    }
  }
  if (offenders.length === 0) pass('aucun label réduit à son raccourci')
  else for (const offender of offenders) fail(offender)
}

console.log('\nle petit texte se lit dans les deux thèmes')
{
  /**
   * Le contraste, calculé plutôt que jugé à l'œil.
   *
   * `--faint` porte les pseudos, les compteurs et les états des cartes, en dix à douze pixels :
   * il tenait 3,5:1 en sombre et 3,2:1 en clair, sous le seuil AA de 4,5 des deux côtés. Et le
   * seul message d'erreur du parcours de connexion était écrit en deux couleurs codées en dur,
   * sans variante claire — 1,6:1 sur blanc, c'est-à-dire illisible au moment où il compte.
   */
  const css = read('src/renderer/src/styles.css')

  /** Les jetons d'un bloc, lus tels que le navigateur les résoudra. */
  function tokens(selector: string): Map<string, string> {
    const start = css.indexOf(selector)
    const open = css.indexOf('{', start)
    const close = css.indexOf('\n}', open)
    const found = new Map<string, string>()
    for (const line of css.slice(open, close).split('\n')) {
      const match = /^\s*(--[\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/.exec(line)
      if (match) found.set(match[1], match[2])
    }
    return found
  }

  function luminance(hex: string): number {
    const value = hex.replace('#', '')
    const full = value.length === 3 ? [...value].map((c) => c + c).join('') : value
    const channels = [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16) / 255)
    const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
  }

  function ratio(a: string, b: string): number {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (high + 0.05) / (low + 0.05)
  }

  /** Les couples qui portent réellement du texte sous 18,66 px, donc soumis au seuil de 4,5. */
  const PAIRS: [ink: string, surface: string][] = [
    ['--faint', '--canvas'],
    ['--faint', '--raised'],
    ['--faint', '--field'],
    ['--muted', '--canvas'],
    ['--muted', '--raised'],
    ['--text', '--canvas'],
    ['--danger-ink', '--raised']
  ]

  for (const [theme, selector] of [
    ['sombre', ":root,\n[data-theme='dark']"],
    ['clair', "[data-theme='light']"]
  ] as const) {
    const palette = tokens(selector)
    for (const [ink, surface] of PAIRS) {
      const a = palette.get(ink)
      const b = palette.get(surface)
      if (!a || !b) {
        fail(`thème ${theme} : ${ink} ou ${surface} introuvable`)
        continue
      }
      const value = ratio(a, b)
      if (value >= 4.5) pass(`thème ${theme} : ${ink} sur ${surface} — ${value.toFixed(2)}:1`)
      else fail(`thème ${theme} : ${ink} sur ${surface} — ${value.toFixed(2)}:1, seuil 4,5`)
    }
  }
}

console.log('\nce qui est cliquable dans une zone de glissement le dit')
{
  /**
   * **Toute la barre du haut est devenue incliquable, et rien ne pouvait le voir.**
   *
   * La fenêtre est sans cadre : `.topbar` porte `-webkit-app-region: drag` pour qu'on puisse
   * la déplacer. Sous Electron, un enfant d'une zone `drag` hérite de ce comportement — le clic
   * va au gestionnaire de fenêtre, pas au bouton. Les cinq lignes qui rendaient les contrôles
   * `no-drag` ont disparu dans un remaniement de la barre, et avec elles la synchronisation,
   * les filtres, le tri, les dispositions et la recherche. Pendant une release entière.
   *
   * **L'aperçu navigateur ne pouvait pas le montrer** : `app-region` n'existe pas dans un
   * navigateur, tout y reste cliquable. C'est précisément le genre de défaut qu'un contrôle de
   * source doit attraper, puisque aucun essai à l'écran ne le rencontrera.
   *
   * La règle : toute zone déclarée `drag` doit déclarer, quelque part, ce qui reste cliquable
   * dedans.
   */
  const css = read('src/renderer/src/styles.css')

  /* Les sélecteurs qui se déclarent zone de glissement. On remonte au sélecteur qui précède
     la déclaration, ce qui suffit ici : chaque règle en tient un seul. */
  /* Les prises qui ne contiennent aucun contrôle, avec ce qu'elles portent. Déclarées plutôt
     que devinées : le jour où l'une d'elles gagne un bouton, la règle doit le voir. */
  const BARE_HANDLES: Record<string, string> = {
    '.sidebar__head': 'ne porte que le logo',
    '.welcome__drag': 'rectangle vide, posé sur l’accueil pour déplacer la fenêtre'
  }

  const dragging: string[] = []
  for (const match of css.matchAll(/([.#\[][^{};]*?)\s*\{[^{}]*?-webkit-app-region:\s*drag/g)) {
    dragging.push(match[1].trim().split('\n').pop()!.trim())
  }

  if (dragging.length === 0) {
    fail('plus aucune zone de glissement — la fenêtre sans cadre ne se déplace plus')
  }

  for (const zone of dragging) {
    /* Une zone qui ne contient aucun contrôle n'a rien à excepter : c'est le cas de la prise
       posée sur l'accueil, qui est un rectangle vide par construction. */
    const bare = zone.replace(/^[.#]/, '').replace(/__.*/, '')
    const exempt = BARE_HANDLES[zone]
    if (exempt) {
      pass(`${zone} — ${exempt}`)
      continue
    }
    const escaped = zone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const frees = new RegExp(`${escaped}[^{}]*\\{[^{}]*?-webkit-app-region:\\s*no-drag`).test(css)
    if (frees) pass(`${zone} — ses contrôles sont rendus cliquables`)
    else fail(`${zone} est une zone de glissement dont rien ne libère les contrôles (${bare})`)
  }
}

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} manquement(s).`)
process.exitCode = failures === 0 ? 0 : 1
