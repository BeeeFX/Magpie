import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Rien n'échoue en silence : `npm run check:notices`
 *
 * Trois règles, et chacune rejoue un défaut qui a réellement été livré.
 *
 * **Aucune boîte native.** `window.prompt` n'est pas implémenté par Electron : il rend `null`
 * sans rien afficher. Deux actions de la barre de sélection — « Collection » et « Ajouter un
 * tag » — étaient donc des boutons morts dans l'application empaquetée, et le repli navigateur,
 * lui, implémente `prompt`, si bien que l'aperçu ne pouvait pas le montrer. `confirm` et
 * `alert` fonctionnent, mais ils bloquent la boucle d'événements et ne sont pas traduisibles :
 * `ConfirmButton` les remplace.
 *
 * **Le sens unique des dépendances.** `notices.ts` doit pouvoir être importé par `store.ts`,
 * dont les écritures vivent hors de tout composant. S'il importait `store.ts` en retour, le
 * cycle rendrait l'ordre d'initialisation dépendant de l'ordre des imports.
 *
 * **Toute écriture est rattrapée.** C'est la règle qui compte, et la plus facile à laisser
 * filer : une écriture sans `catch` échoue exactement comme un clic manqué. Le filet global sur
 * `unhandledrejection` ne dispense de rien — il ne sait pas quel geste a échoué.
 */

const ROOT = 'src/renderer/src'

/** Les verbes qui écrivent. Une lecture qui échoue se voit ; une écriture qui échoue, non. */
const WRITES =
  /\bmagpie\.(set|add|remove|create|delete|merge|rename|start|stop|toggle|request|connect|disconnect|apply|undo|keepOnly|seed|clear|copy|export|open|install|choose|finish|catchUp|revert|save)[A-Z]\w*\s*\(/

let failures = 0
function fail(message: string): void {
  failures += 1
  console.log(`  ✗ ${message}`)
}
function pass(message: string): void {
  console.log(`  ✓ ${message}`)
}

/** Le code sans ses commentaires, lignes conservées — et sans les retours chariot. */
function code(text: string): string {
  const blank = (chunk: string): string => chunk.replace(/[^\n]/g, ' ')
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank)
}

/**
 * Le corps d'un `.catch(…)`, des parenthèses ouvrantes à leur fermeture.
 *
 * Découper à un nombre de lignes fixe ne peut pas marcher : un `catch` d'une ligne déborde
 * alors sur le gestionnaire suivant, et un `catch` de dix lignes se fait couper avant sa
 * conclusion. Les deux erreurs se sont produites en écrivant cette règle.
 */
function catchBody(text: string, from: number): string {
  const open = text.indexOf('(', from)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') {
      depth--
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  return text.slice(open)
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(path)
  }
  return out
}

const files = walk(ROOT)
console.log('Vérification des retours d’erreur\n')

console.log('boîtes natives')
{
  const offenders: string[] = []
  for (const file of files) {
    /* `bridge.ts` a le droit d'en parler : son repli navigateur documente précisément la
       différence entre le navigateur et Electron. On regarde donc les appels, pas les mots. */
    for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      if (/\bwindow\.(prompt|confirm|alert)\s*\(/.test(line)) {
        offenders.push(`${file}:${index + 1} — ${line.trim().slice(0, 70)}`)
      }
    }
  }
  if (offenders.length === 0) pass('aucune boîte de dialogue native')
  else for (const offender of offenders) fail(offender)
}

console.log('\nsens des dépendances')
{
  const notices = readFileSync(join(ROOT, 'notices.ts'), 'utf8')
  if (/from '\.\/store'/.test(notices)) fail('notices.ts importe store.ts — le cycle est interdit')
  else pass('notices.ts n’importe pas store.ts')
}

console.log('\nécritures rattrapées')
{
  const offenders: string[] = []
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const [index, line] of lines.entries()) {
      if (!WRITES.test(line)) continue
      /* Trois formes acceptées, une seule suffit : un `.catch(` dans les lignes qui suivent —
         la chaîne peut passer par un `.then` —, un `} catch` plus bas dans le bloc, ce qui
         couvre le `try/catch` explicite du store, ou une place dans la liste d'un
         `Promise.allSettled`, qui **est** un filet : il ne rejette jamais et rend chaque échec
         dans son tableau de résultats. */
      const after = lines.slice(index, index + 8).join('\n')
      const before = lines.slice(Math.max(0, index - 6), index).join('\n')
      const guarded =
        /Promise\.allSettled\s*\(/.test(before) ||
        /\.catch\s*\(/.test(after) ||
        /}\s*catch\b/.test(lines.slice(index, index + 30).join('\n'))
      if (!guarded) offenders.push(`${file}:${index + 1} — ${line.trim().slice(0, 70)}`)
    }
  }
  if (offenders.length === 0) pass(`${files.length} fichiers, aucune écriture sans filet`)
  else for (const offender of offenders) fail(offender)
}

console.log('\nun échec se dit à l’utilisateur, pas à la console')
{
  /**
   * Un `catch` qui n'écrit que dans la console est un `catch` qui ment.
   *
   * La règle précédente exige un filet ; elle ne dit pas ce qu'il en fait. La carte en avait
   * quatre, tous en `console.warn` : le contrôle passait au vert pendant que **le seul contenu
   * que l'utilisateur écrit sur la carte** — le nom d'un endroit — disparaissait sans un mot.
   * On le tapait, il s'affichait, l'écriture échouait, et il n'était plus là à la réouverture.
   *
   * `store.ts` est exempté : il journalise **en plus** de son état d'erreur, et `notices.ts`
   * ne peut évidemment pas s'interdire d'écrire dans la console.
   */
  const EXEMPT = /notices\.ts$|ErrorBoundary\.tsx$|store\.ts$/

  /**
   * Les silences voulus, avec leur raison.
   *
   * Une exception sans motif écrit devient la case où l'on range ce qu'on n'a pas envie de
   * traiter. Celle-ci en a un, et il tient à la nature du calque : il montre déjà l'erreur que
   * l'utilisateur cherche à rapporter.
   */
  const DELIBERATE: Record<string, string> = {
    'components/Notices.tsx':
      'une copie qui échoue ne peut pas s’annoncer dans le calque qu’elle occupe déjà ; le bouton qui reste au repos dit déjà que rien ne s’est passé'
  }

  const offenders: string[] = []
  for (const file of files) {
    if (EXEMPT.test(file)) continue
    const declared = Object.keys(DELIBERATE).find((suffix) =>
      file.replace(/\\/g, '/').endsWith(suffix)
    )
    if (declared) continue
    const text = code(readFileSync(file, 'utf8'))
    const lines = text.split('\n')
    for (const [index, line] of lines.entries()) {
      const at = line.search(/\.catch\s*\(/)
      if (at < 0) continue
      /* Le corps du `catch`, et **lui seul**. Une fenêtre de seize lignes débordait sur le
         gestionnaire suivant : un `.catch(console.warn(…))` d'une seule ligne passait au vert
         parce que le `reportFailure` de l'effet d'après tombait dedans. Trop étroite, la
         fenêtre rate ; trop large, elle se laisse rassurer par le voisin. On compte donc les
         parenthèses jusqu'à la fermeture, ce qui donne exactement ce que ce `catch` fait. */
      const from = text.indexOf('.catch', text.split('\n').slice(0, index).join('\n').length)
      const body = catchBody(text, from)
      if (!/console\.(warn|error|log)/.test(body)) continue
      /* Journaliser est légitime tant que l'utilisateur est prévenu par ailleurs. */
      const tells = /notifyError|reportFailure|notifyInfo|setFailure|setError|setCacheError/.test(body)
      if (!tells) offenders.push(`${file.replace(/\\/g, '/')}:${index + 1} — ${line.trim().slice(0, 60)}`)
    }
  }
  for (const [suffix, why] of Object.entries(DELIBERATE)) {
    const exists = files.some((file) => file.replace(/\\/g, '/').endsWith(suffix))
    if (exists) pass(`${suffix} — silence voulu : ${why}`)
    else fail(`${suffix} est déclaré silencieux, mais ce fichier n’existe pas`)
  }
  if (offenders.length === 0) pass('aucun autre échec ne finit dans la seule console')
  else for (const offender of offenders) fail(offender)
}

console.log('\nun correctif optimiste ne survit pas à son écriture')
{
  /**
   * Poser l'effet avant la réponse est le bon geste — l'interface ne doit pas attendre un
   * aller-retour pour bouger. Mais si l'écriture échoue, l'effet doit repartir.
   *
   * Les deux étiquettes de la carte faisaient exactement l'inverse : `setOwnLabels` d'abord,
   * puis un `catch` qui ne défaisait rien. L'écran montrait donc un état que la base
   * n'avait pas, jusqu'à la réouverture — c'est-à-dire jusqu'au moment où l'on ne fait plus le
   * lien entre ce qu'on a perdu et le geste qui l'a perdu.
   */
  const map = readFileSync('src/renderer/src/components/LibraryMap.tsx', 'utf8').replace(/\r\n?/g, '\n')
  for (const [call, undo] of [
    ['saveMapLabel', /setOwnLabels\(\(current\) => current\.filter/],
    ['deleteMapLabel', /setOwnLabels\(\(current\) => \[\.\.\.current, removed\]\)/]
  ] as const) {
    const at = map.indexOf(`.${call}(`)
    if (at < 0) {
      fail(`${call} introuvable dans LibraryMap`)
      continue
    }
    const body = map.slice(at, at + 400)
    if (undo.test(body)) pass(`${call} défait son correctif optimiste en cas d’échec`)
    else fail(`${call} laisse son correctif optimiste posé sur une écriture qui a échoué`)
  }
}

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} manquement(s).`)
process.exitCode = failures === 0 ? 0 : 1
