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

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} manquement(s).`)
process.exitCode = failures === 0 ? 0 : 1
