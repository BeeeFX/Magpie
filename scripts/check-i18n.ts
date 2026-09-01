import { read } from './source'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { translate, type TranslationKey } from '../src/renderer/src/i18n'
import { STEP_ORDER, STEPS_WITH_LOSS } from '../src/renderer/src/steps'
import {
  ACCENTS,
  LABELS,
  LOAD_PROFILES,
  type AiProvider,
  type BackgroundTaskKind,
  type Language,
  type LibraryMovePhase,
  type PlaybackQuality,
  type SyncSchedule,
  type UpdatePhase
} from '../src/shared/types'

/**
 * Vérification des clés de traduction fabriquées à la volée : `npm run check:i18n`
 *
 * Une clé écrite en toutes lettres est protégée par le compilateur : supprimer sa traduction
 * casse la compilation. Une clé assemblée puis castée — `t(\`accent.${name}\` as TranslationKey)`
 * — ne l'est par rien du tout, et elle est invisible à la recherche plein texte. C'est
 * exactement ainsi que les cinq boutons de couleur de la carte se sont affichés vides pendant
 * une version : le ménage du dictionnaire de 0.30.0 a emporté `organizer.colour*` sans que rien
 * ne proteste, ni compilation, ni contrôle, ni relecture.
 *
 * Ce contrôle énumère chaque famille et vérifie qu'aucun membre ne manque, dans les deux
 * langues. Les listes ci-dessous viennent des mêmes sources que l'interface parcourt — les
 * constantes exportées quand il en existe une, sinon une liste littérale que `satisfies` colle
 * au type. Ajouter une couleur, une qualité, une étape ou un fournisseur casse donc la
 * compilation ici avant de laisser un libellé vide à l'écran.
 */

const LANGUAGES: Language[] = ['fr', 'en']

/** Une clé absente rend `undefined` : la signature promet `string`, la table ne tient pas. */
function missing(language: Language, key: string): boolean {
  return (translate(language, key as TranslationKey) as string | undefined) === undefined
}

interface Family {
  /** Où la clé est assemblée, pour qu'un échec dise quoi rouvrir. */
  where: string
  keys: string[]
}

const QUALITIES = ['auto', '480p', '720p', '1080p', 'source'] satisfies PlaybackQuality[]
const SCHEDULES = ['manual', 'hourly', '6h', 'daily'] satisfies SyncSchedule[]
const PROVIDERS = ['openai', 'anthropic', 'gemini', 'deepseek', 'custom'] satisfies AiProvider[]
const TASK_KINDS = [
  'sync',
  'thumbnails',
  'clips',
  'organizer',
  'transcribe',
  'images'
] satisfies BackgroundTaskKind[]
const UPDATE_PHASES = [
  'idle',
  'checking',
  'available',
  'downloading',
  'ready',
  'up-to-date',
  'error',
  'unsupported'
] satisfies UpdatePhase[]
/* `error` est le seul état que l'écran ne traduit pas : il affiche le message du système. */
const MOVE_PHASES = [
  'preparing',
  'database',
  'media',
  'finalizing',
  'done'
] satisfies LibraryMovePhase[]
const TITLE_KINDS = ['Groups', 'Collections', 'Own']

const FAMILIES: Family[] = [
  { where: 'LabelPicker, Sidebar', keys: LABELS.map((color) => `label.${color}`) },
  { where: 'Settings, Welcome', keys: ACCENTS.map((name) => `accent.${name}`) },
  { where: 'Settings, VideoPlayer', keys: QUALITIES.map((quality) => `quality.${quality}`) },
  { where: 'Settings', keys: SCHEDULES.map((schedule) => `schedule.${schedule}`) },
  { where: 'Settings', keys: PROVIDERS.map((provider) => `ai.${provider}`) },
  { where: 'Settings', keys: UPDATE_PHASES.map((phase) => `update.status.${phase}`) },
  { where: 'Settings', keys: MOVE_PHASES.map((phase) => `settings.libraryMove.${phase}`) },
  { where: 'Downloads', keys: LOAD_PROFILES.map((profile) => `downloads.load.${profile}`) },
  { where: 'Downloads', keys: TASK_KINDS.map((kind) => `downloads.kind.${kind}`) },
  { where: 'LibraryMap', keys: TITLE_KINDS.map((kind) => `map.titles${kind}`) },
  {
    where: 'OrganizerSteps',
    keys: [
      ...STEP_ORDER.map((id) => `steps.${id}`),
      ...STEP_ORDER.map((id) => `steps.${id}Hint`),
      ...STEPS_WITH_LOSS.map((id) => `steps.${id}Loss`)
    ]
  }
]

let failures = 0

console.log('Vérification des clés de traduction assemblées à la volée\n')

for (const family of FAMILIES) {
  const holes: string[] = []
  for (const key of family.keys) {
    for (const language of LANGUAGES) {
      if (missing(language, key)) holes.push(`${key} (${language})`)
    }
  }
  if (holes.length === 0) {
    console.log(`  ✓ ${family.keys.length.toString().padStart(2)} clés · ${family.where}`)
  } else {
    failures += holes.length
    console.error(`  ✗ ${family.where} — manquantes : ${holes.join(', ')}`)
  }
}

/* Le contrôle ne vaut que s'il échoue quand il doit : une clé qui n'a jamais existé doit être
   vue comme manquante, sinon `missing` rend faux pour tout et la page reste verte à tort. */
if (!missing('fr', 'label.__inexistante__')) {
  failures += 1
  console.error("  ✗ le contrôle lui-même est aveugle : une clé absente n'est pas détectée")
}

/**
 * Deuxième famille de trous : une phrase à variable appelée sans sa variable.
 *
 * `translate` remplace `{quality}` par ce qu'on lui donne — et laisse l'accolade telle quelle
 * quand on ne lui donne rien. Le texte s'affiche alors avec son gabarit apparent, « Vidéos en
 * {quality} », ce qu'aucun compilateur ne voit et qu'aucune recherche de clé manquante n'attrape :
 * la clé existe, c'est son appel qui est incomplet.
 *
 * On relit donc les sources : toute clé dont le texte porte une accolade doit être appelée avec un
 * second argument. Un `t('clé')` nu sur une telle clé est un gabarit qui part à l'écran.
 */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (/\.(ts|tsx)$/.test(entry) && !path.endsWith('i18n.ts')) out.push(path)
  }
  return out
}

console.log('\nPhrases à variable, appelées sans leur variable\n')

const dictionary = read('src/renderer/src/i18n.ts')
/* Les clés du dictionnaire dont la valeur porte une accolade. Le nom suffit : on ne cherche pas
   à savoir quelles variables, seulement qu'il en faut. */
const templated = new Set<string>()
for (const match of dictionary.matchAll(/^ {2}'([a-zA-Z][\w.]*)':/gm)) {
  const key = match[1]
  /* Le texte vient du dictionnaire lui-même, pas d'une découpe du fichier : lire la source à
     coups de tranches attrapait la valeur de l'entrée suivante, et cinquante-cinq clés
     innocentes se retrouvaient accusées. */
  const text = translate('fr', key as TranslationKey) as string | undefined
  if (text && /\{\w+\}/.test(text)) templated.add(key)
}

const files = sources('src')
const bare: string[] = []
for (const key of [...templated].sort()) {
  const naked = new RegExp(`\\bt\\(\\s*['\`"]${key.replace(/\./g, '\\.')}['\`"]\\s*\\)`)
  for (const file of files) {
    if (naked.test(read(file))) bare.push(`${key} — ${file.replace(/\\/g, '/')}`)
  }
}

if (bare.length === 0) {
  console.log(`  ✓ ${templated.size} phrases à variable, toutes appelées avec la leur`)
} else {
  failures += bare.length
  for (const hole of bare) console.error(`  ✗ ${hole}`)
}

/**
 * Les formes du pluriel, présentes des deux côtés ou d'aucun.
 *
 * Une seule phrase servait pour toutes les quantités, et une bibliothèque en contient beaucoup
 * de un : « 1 sélectionnés », « 1 vidéos sans transcription ». Un endroit s'en sortait par
 * « {count} fichier(s) » — la parenthèse dit exactement qu'on a renoncé.
 *
 * Deux dangers, et deux règles :
 *
 * - **une forme oubliée dans une langue.** Le séparateur n'est pas un caractère spécial : une
 *   valeur avec `|` que rien ne découpe s'affiche telle quelle, barre comprise. Ajouter le
 *   pluriel en français en oubliant l'anglais mettrait donc « 3 files was still open|3 files
 *   were still open » à l'écran ;
 * - **trois formes au lieu de deux.** `pick` ignore la troisième en silence.
 *
 * Il n'y a délibérément pas de règle exigeant `|` partout où un `{count}` apparaît : « {count}
 * à lire » et « {count} · {size} » ne font accorder aucun mot, et une telle règle forcerait à
 * dupliquer des phrases identiques pour rien.
 */
console.log('\nFormes du pluriel\n')

{
  /* Chaque clé apparaît deux fois dans le fichier, une par dictionnaire : sans le `Set`, tout
     manquement se signalait en double. */
  const keys = new Set(
    [...dictionary.matchAll(/^ {2}'([a-zA-Z][\w.]*)':/gm)].map((match) => match[1])
  )
  const withForms = new Map<string, Set<Language>>()
  const malformed: string[] = []
  for (const key of keys) {
    for (const language of LANGUAGES) {
      const text = translate(language, key as TranslationKey) as string | undefined
      if (!text || !text.includes('|')) continue
      if (!withForms.has(key)) withForms.set(key, new Set())
      withForms.get(key)!.add(language)
      const forms = text.split('|')
      if (forms.length !== 2) {
        malformed.push(`${key} (${language}) — ${forms.length} formes, il en faut deux`)
      }
    }
  }

  const lonely = [...withForms.entries()]
    .filter(([, langs]) => langs.size !== LANGUAGES.length)
    .map(([key, langs]) => `${key} — formes en ${[...langs].join(', ')} seulement`)

  /* Et la dérobade d'origine ne doit pas revenir : « fichier(s) » est une phrase qui refuse de
     choisir, dans une interface où le nombre est toujours connu au moment du rendu. */
  const dodging: string[] = []
  for (const key of keys) {
    for (const language of LANGUAGES) {
      const text = translate(language, key as TranslationKey) as string | undefined
      if (text && /\w\(s\)/.test(text)) dodging.push(`${key} (${language}) — ${text.slice(0, 40)}…`)
    }
  }

  const problems = [...malformed, ...lonely, ...dodging]
  if (problems.length === 0) {
    console.log(`  ✓ ${withForms.size} phrases à deux formes, complètes dans les deux langues`)
  } else {
    failures += problems.length
    for (const problem of problems) console.error(`  ✗ ${problem}`)
  }
}

if (failures > 0) {
  console.error(`\n${failures} problème(s).`)
  process.exit(1)
}
console.log('\nToutes les familles sont complètes dans les deux langues.')
