import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Aucun crochet après un retour anticipé : `npm run check:hooks`
 *
 * React exige que chaque rendu d'un composant appelle exactement les mêmes crochets, dans le
 * même ordre. Un `if (…) return null` posé au milieu du corps rompt cette règle pour tout ce
 * qui suit : le composant en exécute huit fermé et dix ouvert, React lève « Rendered more hooks
 * than during the previous render », et l'application entière tombe sur sa page de secours.
 *
 * Ce n'est pas une hypothèse. `ExportPanel` déclarait `useRef` et `useModalFocus` sous son
 * `if (!open) return null` : ouvrir « Exporter pour mon assistant » interrompait l'interface, et
 * ce depuis plusieurs versions. Le compilateur ne dit rien — les crochets sont des appels de
 * fonction comme les autres — et rien d'autre ne le disait non plus.
 *
 * On compte les accolades plutôt que d'analyser la syntaxe : les crochets ne comptent qu'au
 * premier niveau du corps, ceux d'un `useCallback` imbriqué ou d'une fonction voisine ne sont
 * pas concernés. C'est grossier, et suffisant pour la seule forme qui casse.
 */

const ROOTS = ['src/renderer/src', 'src/renderer/src/components']

interface Finding {
  file: string
  line: number
  hook: string
  guard: number
}

/** Le début d'une fonction susceptible de contenir des crochets : composant ou crochet maison. */
const DECLARATION = /^(?:export\s+)?function\s+(?<name>[A-Z]\w*|use[A-Z]\w*)\s*[(<]/
/* Les paramètres de type comptent : `useRef<HTMLDivElement>(null)` est un appel comme un autre,
   et un contrôle qui n'en voit qu'un sur deux enseigne la moitié de la règle. */
const HOOK_CALL = /\b(use[A-Z]\w*)\s*(?:<[^>()]*>)?\s*\(/
/** Un retour anticipé : conditionnel, et sur une seule ligne. Le reste n'est pas une garde. */
const EARLY_RETURN = /^\s{2}if\s*\(.*\)\s*return\b/

function scan(file: string, text: string): Finding[] {
  const lines = text.split('\n')
  const findings: Finding[] = []
  let depth = 0
  let inside = false
  let guard = 0

  for (const [index, line] of lines.entries()) {
    if (!inside && DECLARATION.test(line)) {
      inside = true
      depth = 0
      guard = 0
    }

    if (inside) {
      /* Le premier niveau du corps, c'est-à-dire une accolade ouverte : la déclaration elle-même
         ouvre la première, donc `depth === 1` désigne bien les instructions du corps. */
      if (depth === 1) {
        if (guard === 0 && EARLY_RETURN.test(line)) guard = index + 1
        else if (guard > 0) {
          const match = HOOK_CALL.exec(line)
          /* `useStore(...)` dans un `const x = useStore(…)` compte ; une mention en commentaire
             ou dans une chaîne, non. */
          if (match && !/^\s*(\*|\/\/)/.test(line)) {
            findings.push({ file, line: index + 1, hook: match[1], guard })
          }
        }
      }
      depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0)
      if (depth <= 0 && index > 0) inside = false
    }
  }
  return findings
}

const files: string[] = []
for (const root of ROOTS) {
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (name.isFile() && (name.name.endsWith('.tsx') || name.name.endsWith('.ts'))) {
      files.push(join(root, name.name))
    }
  }
}

console.log('Vérification de l’ordre des crochets React\n')

const all = files.flatMap((file) => scan(file, readFileSync(file, 'utf8')))
for (const finding of all) {
  console.log(
    `  ✗ ${finding.file}:${finding.line} — ${finding.hook}() est appelé après le retour ` +
      `anticipé de la ligne ${finding.guard}`
  )
}

if (all.length === 0) {
  console.log(`  ✓ ${files.length} fichiers, aucun crochet sous un retour anticipé`)
  console.log('\nTout est vert.')
} else {
  console.log(
    `\n${all.length} crochet(s) conditionnel(s). Remontez-les au-dessus du retour : React exige ` +
      'le même nombre d’appels à chaque rendu.'
  )
  process.exitCode = 1
}
