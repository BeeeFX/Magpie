/**
 * Vocabulaire des étapes de préparation.
 *
 * Dans son propre module parce que le store en a besoin autant que le composant : les
 * importer depuis celui-ci créerait un cycle, le composant lisant déjà le store.
 */
export type StepId = 'sync' | 'thumbnails' | 'clips' | 'images' | 'transcribe' | 'group'

export type StepState = 'todo' | 'running' | 'done' | 'skipped' | 'halted' | 'failed'

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
