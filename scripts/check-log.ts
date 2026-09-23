import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { redact } from '../src/main/redact'
import { code, read } from './source'

/**
 * Le journal peut être publié : `npm run check:log`
 *
 * `src/main/log.ts` recopie la console du processus principal dans un fichier que
 * l'utilisateur est invité à joindre à un ticket GitHub — donc à rendre public. Deux choses
 * doivent y rester vraies, et aucun typage ne les tient :
 *
 * 1. **`redact` masque ce qui donne accès au compte** : les cookies de session (`sessionid`
 *    d'Instagram, `auth_token` et `ct0` de X), un en-tête `Cookie` ou `Authorization` recopié
 *    dans un message, la requête d'une URL de média signée — qui rejoue le média tant qu'elle
 *    n'a pas expiré — et le dossier personnel, qui porte le nom de la session Windows.
 * 2. **Aucun appel à la console ne lui passe une légende, un cookie ou des en-têtes.** Le
 *    masquage attrape des formes connues ; une légende n'en a aucune. La seule protection est
 *    de ne jamais la donner : la règle lit les arguments de chaque `console.*` de
 *    `src/main`, chaînes littérales exclues, et refuse ces noms-là.
 */

let failures = 0
function fail(message: string): void {
  failures += 1
  console.log(`  ✗ ${message}`)
}
function pass(message: string): void {
  console.log(`  ✓ ${message}`)
}

console.log('Vérification du journal sur disque\n')

console.log('ce qui donne accès au compte est masqué')
{
  const home = 'C:\\Users\\Camille'
  const cases: { label: string; input: string; secrets: string[]; kept?: string[] }[] = [
    {
      label: 'URL de média signée',
      input:
        'échec https://scontent-cdg4-1.cdninstagram.com/v/t51.2885-15/4242_n.jpg?stp=dst-jpg&_nc_ht=x&oh=00_AfSIGNATURE&oe=66FF0000 (403)',
      secrets: ['oh=00_AfSIGNATURE', 'oe=66FF0000', '_nc_ht'],
      kept: ['scontent-cdg4-1.cdninstagram.com/v/t51.2885-15/4242_n.jpg', '(403)']
    },
    {
      label: 'en-tête Cookie recopié',
      input: 'Cookie: sessionid=4242%3AabcDEF; csrftoken=zzz; ds_user_id=42',
      secrets: ['4242%3AabcDEF', 'zzz', 'ds_user_id=42']
    },
    {
      label: 'cookies de X en paires',
      input: 'requête refusée, auth_token=0123456789abcdef ct0=feedface',
      secrets: ['0123456789abcdef', 'feedface'],
      kept: ['requête refusée']
    },
    {
      label: 'objet d’en-têtes inspecté',
      input: "{ cookie: 'sessionid=4242; mid=ZZ', 'x-csrf-token': 'feedface', accept: '*/*' }",
      secrets: ['4242', 'ZZ', 'feedface'],
      kept: ["accept: '*/*'"]
    },
    {
      label: 'jeton porteur',
      input: 'Authorization: Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D',
      secrets: ['AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D']
    },
    {
      label: 'dossier personnel, tel quel et cité',
      input: `C:\\Users\\Camille\\AppData\\Roaming\\magpie\\magpie.db — 'C:\\\\Users\\\\Camille\\\\x'`,
      secrets: ['Camille'],
      kept: ['AppData\\Roaming\\magpie\\magpie.db']
    },
    {
      label: 'une ligne ordinaire traverse intacte',
      input: '[magpie] Base : 2445 posts.',
      secrets: [],
      kept: ['[magpie] Base : 2445 posts.']
    }
  ]
  for (const entry of cases) {
    const out = redact(entry.input, home)
    const leaked = entry.secrets.filter((secret) => out.includes(secret))
    const lost = (entry.kept ?? []).filter((part) => !out.includes(part))
    if (leaked.length > 0) fail(`${entry.label} : « ${leaked.join(' », « ')} » passe — ${out}`)
    else if (lost.length > 0) fail(`${entry.label} : « ${lost.join(' », « ')} » disparaît — ${out}`)
    else pass(entry.label)
  }
}

/** Les arguments d'un appel, parenthèses équilibrées, à partir de la parenthèse ouvrante. */
function argumentsFrom(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i)
  }
  return text.slice(open + 1)
}

/**
 * Le code d'une expression sans ses chaînes littérales — mais avec ce que les gabarits
 * interpolent : `${cookie.value}` doit se voir, « Cookies réécrits » ne doit pas compter.
 */
function withoutLiterals(text: string): string {
  let out = ''
  let i = 0
  const skipQuoted = (quote: string): void => {
    i++
    while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1
    i++
  }
  const readTemplate = (): void => {
    i++
    while (i < text.length && text[i] !== '`') {
      if (text[i] === '\\') {
        i += 2
      } else if (text[i] === '$' && text[i + 1] === '{') {
        let depth = 1
        i += 2
        const start = i
        while (i < text.length && depth > 0) {
          if (text[i] === '{') depth++
          else if (text[i] === '}') depth--
          i++
        }
        out += ` ${withoutLiterals(text.slice(start, i - 1))} `
      } else {
        i++
      }
    }
    i++
  }
  while (i < text.length) {
    const char = text[i]
    if (char === "'" || char === '"') skipQuoted(char)
    else if (char === '`') readTemplate()
    else {
      out += char
      i++
    }
  }
  return out
}

function walk(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(path))
    else if (entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

const FORBIDDEN = /\b(captions?|cookies?|(?:request|response)?headers?|tokens?|password|transcript|body)\b/i

console.log('\naucune légende, aucun cookie, aucun en-tête n’est passé à la console')
{
  const offenders: string[] = []
  let calls = 0
  for (const file of walk('src/main')) {
    const text = code(read(file))
    for (const match of text.matchAll(/\bconsole\.(?:log|info|warn|error)\s*\(/g)) {
      calls++
      const args = withoutLiterals(argumentsFrom(text, match.index + match[0].length - 1))
      const found = FORBIDDEN.exec(args)
      if (found) {
        const line = text.slice(0, match.index).split('\n').length
        offenders.push(`${file}:${line} passe « ${found[1]} »`)
      }
    }
  }
  if (calls < 20) fail(`seulement ${calls} appels trouvés — la lecture des sources est cassée`)
  else if (offenders.length > 0) for (const offender of offenders) fail(offender)
  else pass(`${calls} appels relus`)
}

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} échec(s).`)
process.exitCode = failures === 0 ? 0 : 1
