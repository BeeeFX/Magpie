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

if (failures > 0) {
  console.error(`\n${failures} clé(s) manquante(s).`)
  process.exit(1)
}
console.log('\nToutes les familles sont complètes dans les deux langues.')
