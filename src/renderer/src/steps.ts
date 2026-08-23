/**
 * Vocabulaire des étapes de préparation.
 *
 * Dans son propre module parce que le store en a besoin autant que le composant : les
 * importer depuis celui-ci créerait un cycle, le composant lisant déjà le store.
 */
export type StepId = 'sync' | 'thumbnails' | 'clips' | 'images' | 'transcribe' | 'group'

export type StepState = 'todo' | 'running' | 'done' | 'skipped' | 'halted' | 'failed'

/**
 * Les étapes dont on annonce ce qu'on perd à les décocher.
 *
 * Ici plutôt que dans le composant, pour une raison précise : chacune promet une clé
 * `steps.<id>Loss` dans les deux dictionnaires, et une liste que personne ne peut relire depuis
 * l'extérieur est une liste qui dérive. `check:i18n` la lit d'ici.
 */
export const STEPS_WITH_LOSS: StepId[] = ['clips', 'images', 'transcribe']

/** L'ordre d'exécution, et celui de l'affichage : ils ne doivent jamais diverger. */
/* « Lire les images » vient après les vignettes, qui lui donnent sa matière, et après les
   clips, dont elle tire trois images au lieu d'une quand ils sont là. */
export const STEP_ORDER: StepId[] = [
  'sync',
  'thumbnails',
  'clips',
  'images',
  'transcribe',
  'group'
]
