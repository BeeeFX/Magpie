import { code, read } from './source'
/**
 * Le processus principal parle la langue de l'interface : `npm run check:messages`
 *
 * **Tous ses messages étaient en français, en dur.** Quelqu'un en anglais qui perdait sa
 * session lisait « La session Instagram a expiré. Reconnectez le compte dans les réglages. »
 * au milieu d'un écran par ailleurs traduit — et c'était le seul texte qui lui disait quoi
 * faire.
 *
 * Traduire ces phrases ne suffisait pas : `Accounts.tsx` **testait la phrase** pour distinguer
 * une fenêtre refermée d'une panne — `/annulée|cancelled/i`. La traduction aurait donc, en
 * silence, transformé chaque abandon en erreur rouge. Les deux corrections sont indivisibles,
 * et les trois règles ci-dessous sont ce qui les tient ensemble :
 *
 * 1. le moteur ne fabrique plus de prose — il appelle `say()` ;
 * 2. les deux dictionnaires portent exactement les mêmes clés ;
 * 3. chaque cause d'échec de connexion a sa phrase, dans les deux langues.
 *
 * La troisième est celle qui compte le jour où l'on ajoutera une cause : sans elle, une
 * `ConnectFailure` de plus produirait `undefined` à l'écran.
 */

let failures = 0
function fail(message: string): void {
  failures += 1
  console.log(`  ✗ ${message}`)
}
function pass(message: string): void {
  console.log(`  ✓ ${message}`)
}

const messages = read('src/main/messages.ts')
const engine = read('src/main/sync/engine.ts')
const types = read('src/shared/types.ts')

/**
 * Le code sans ses commentaires, lignes conservées — même raison que dans `check:a11y`.
 *
 * **Et sans les retours chariot.** La copie de travail est en CRLF ; découper sur `\n` laisse
 * donc un `\r` en fin de chaque ligne, et en JavaScript `.` ne le traverse pas. Toute règle
 * ancrée par `$` ne se déclenchait alors jamais : celle qui suit passait au vert sur une
 * phrase française réintroduite exprès. C'est le genre de contrôle qui ne protège de rien
 * tout en donnant l'impression du contraire.
 */

console.log('Vérification des messages du processus principal\n')

console.log('le moteur de synchronisation ne fabrique plus de prose')
{
  /* On cherche ce qui *ressemble à une phrase* dans une affectation de `message` : deux mots
     séparés par une espace, hors appel à `say()`. Les identifiants et les gabarits d'une seule
     variable passent ; « La session X a expiré » ne passe pas. */
  const lines = code(engine).split('\n')
  const offenders: string[] = []
  for (const [index, line] of lines.entries()) {
    const match = /message:\s*(.+)$/.exec(line)
    if (!match) continue
    const value = match[1].trim()
    if (value.startsWith('say(') || value === 'null,' || value === 'null') continue
    if (/^(completed|null)\b/.test(value)) continue
    if (/['"`][^'"`]*\s[A-Za-zÀ-ÿ]/.test(value)) {
      offenders.push(`src/main/sync/engine.ts:${index + 1} — phrase écrite en dur : ${value}`)
    }
  }
  if (offenders.length === 0) pass('chaque message passe par say()')
  else for (const offender of offenders) fail(offender)
}

console.log('\nchaque état porte son code, pas seulement sa phrase')
{
  /* Une phrase traduite ne s'inspecte plus. Toute écriture de `message` qui n'est pas `null`
     doit donc être accompagnée d'un `messageCode` : c'est lui que l'interface teste. */
  const withSay = [...code(engine).matchAll(/message:\s*say\(/g)].length
  const withCode = [...code(engine).matchAll(/messageCode:/g)].length
  // `messageCode: null` accompagne les remises à zéro, d'où le « au moins ».
  if (withCode >= withSay && withSay > 0) {
    pass(`${withSay} phrases, ${withCode} codes`)
  } else {
    fail(`${withSay} phrases pour seulement ${withCode} codes — une phrase ne s'inspecte pas`)
  }

  /* Et personne ne doit retomber dans l'ancien réflexe : décider sur le texte. */
  const renderer = read('src/renderer/src/components/Accounts.tsx')
  if (/\.test\(\s*(?:message|err|result\.message)/.test(code(renderer))) {
    fail('src/renderer/src/components/Accounts.tsx — une décision se prend encore sur la phrase')
  } else {
    pass('l’interface décide sur le code, jamais sur le texte')
  }
}

console.log('\nce que l’utilisateur lit passe par le dictionnaire')
{
  /**
   * Les phrases du processus principal qui **atteignent l'écran**.
   *
   * La distinction est le tout de cette règle. `throw new Error('Sélection invalide')` ne peut
   * se déclencher que si le rendu envoie n'importe quoi — c'est-à-dire jamais en usage normal :
   * c'est une garde contre un bug, pas un message. La traduire serait du travail pour une phrase
   * que personne ne lira, et ferait grossir la liste sans rien protéger.
   *
   * Ce qui compte, ce sont les sorties par lesquelles une phrase arrive vraiment sous les yeux.
   * On les nomme, et on exige qu'elles passent par `say()`.
   */
  const USER_FACING: { file: string; sinks: RegExp[] }[] = [
    {
      file: 'src/main/ipc.ts',
      sinks: [
        /title:\s*'[^']*[éèêàçôûù][^']*'/,
        /throw new Error\('[^']*\.\s*'\)/,
        /error:\s*'[^']*[éèêàçôûù][^']*'/
      ]
    },
    { file: 'src/main/index.ts', sinks: [/showErrorBox\('[^']/] },
    { file: 'src/main/tagging/credentials.ts', sinks: [/throw new Error\('[^']*[éèêàçôûù]/] }
  ]

  const offenders: string[] = []
  for (const entry of USER_FACING) {
    const lines = code(read(entry.file)).split('\n')
    for (const [index, line] of lines.entries()) {
      for (const sink of entry.sinks) {
        if (sink.test(line)) offenders.push(`${entry.file}:${index + 1} — ${line.trim().slice(0, 62)}`)
      }
    }
  }
  if (offenders.length === 0) pass('aucune phrase visible écrite en dur hors du dictionnaire')
  else for (const offender of offenders) fail(offender)
}

console.log('\nles deux langues disent les mêmes choses')
{
  function keysOf(marker: string): string[] {
    const start = messages.indexOf(marker)
    if (start < 0) return []
    const end = messages.indexOf('\n}', start)
    return [...messages.slice(start, end).matchAll(/^\s*'([\w.]+)':/gm)].map((m) => m[1])
  }
  const fr = keysOf('const FR = {')
  const en = keysOf('const EN: Record<MessageKey, string> = {')

  if (fr.length === 0 || en.length === 0) {
    fail('un des deux dictionnaires est introuvable')
  } else {
    const missing = fr.filter((key) => !en.includes(key))
    const extra = en.filter((key) => !fr.includes(key))
    for (const key of missing) fail(`${key} — manque en anglais`)
    for (const key of extra) fail(`${key} — en trop en anglais`)
    if (missing.length === 0 && extra.length === 0) {
      pass(`${fr.length} clés, identiques des deux côtés`)
    }
  }

  /* Les variables aussi : `{platform}` oublié dans une traduction laisse une phrase qui parle
     d'un compte sans jamais le nommer. */
  const values = [...messages.matchAll(/'([\w.]+)':\s*\n?\s*'([^']*(?:''[^']*)*)'/g)]
  const vars = new Map<string, Set<string>>()
  for (const [, key, value] of values) {
    const found = new Set([...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
    const seen = vars.get(key)
    if (!seen) vars.set(key, found)
    else if ([...seen].sort().join(',') !== [...found].sort().join(',')) {
      fail(`${key} — les deux langues n’attendent pas les mêmes variables`)
    }
  }
  pass('les deux langues attendent les mêmes variables')
}

console.log('\nchaque cause d’échec a sa phrase')
{
  const union = /export type ConnectFailure =\s*([^\n]*(?:\n\s*\|[^\n]*)*)/.exec(types)
  if (!union) {
    fail('ConnectFailure introuvable dans shared/types.ts')
  } else {
    const reasons = [...union[1].matchAll(/'(\w+)'/g)].map((m) => m[1])
    if (reasons.length === 0) fail('ConnectFailure ne liste aucune cause')
    for (const reason of reasons) {
      if (messages.includes(`'connect.${reason}':`)) pass(`connect.${reason}`)
      else fail(`connect.${reason} — cette cause n’a pas de phrase`)
    }

    /* Le classement doit trancher chaque cause, sans quoi une branche morte affiche une
       phrase que rien ne produit. */
    const classifier = messages.slice(messages.indexOf('export function connectFailure'))
    for (const reason of reasons) {
      if (!classifier.includes(`reason: '${reason}'`)) {
        fail(`connectFailure ne rend jamais '${reason}'`)
      }
    }
  }
}

console.log(failures === 0 ? '\nTout est traduit.' : `\n${failures} manquement(s).`)
process.exitCode = failures === 0 ? 0 : 1
