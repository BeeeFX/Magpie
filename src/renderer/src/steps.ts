/**
 * Vocabulaire des étapes de préparation.
 *
 * Dans son propre module parce que le store en a besoin autant que le composant : les
 * importer depuis celui-ci créerait un cycle, le composant lisant déjà le store.
 */
export type StepId = 'sync' | 'thumbnails' | 'clips' | 'transcribe' | 'group'

export type StepState = 'todo' | 'running' | 'done' | 'skipped' | 'halted' | 'failed'

/** L'ordre d'exécution, et celui de l'affichage : ils ne doivent jamais diverger. */
export const STEP_ORDER: StepId[] = ['sync', 'thumbnails', 'clips', 'transcribe', 'group']
