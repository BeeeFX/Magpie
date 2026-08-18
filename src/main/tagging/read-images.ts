import { backgroundTasks } from '../tasks'
import { countPendingImageEmbeddings } from '../db/queries'
import { clearFrameWorkspace, videoFrames } from './frames'
import { readImages } from './vision'

/**
 * L'étape « Lire les images », vue de l'application.
 *
 * Deux temps : tirer trois images des clips en cache — le début d'une vidéo ne dit souvent
 * rien de la suite — puis encoder tout ce qui n'a pas déjà été lu. Le second temps porte
 * l'essentiel du travail, donc c'est lui qui compte dans la progression.
 */

let running = false
let stopped = false
/** Derniere erreur, pour que l'ecran puisse dire que l'etape a echoue au lieu de reussir. */
let failure: string | null = null

export function isReadingImages(): boolean {
  return running
}

export function stopReadingImages(): void {
  stopped = true
}

export function pendingImageCount(): number {
  return countPendingImageEmbeddings()
}

export function imageReadingFailure(): string | null {
  return failure
}

export async function readAllImages(): Promise<void> {
  if (running) return
  running = true
  stopped = false
  failure = null
  const task = 'read:images'
  /* La tache est declaree avant toute lecture de la base : c'est elle qui dit a l'ecran de
     preparation que l'etape a demarre. Sans elle, l'ecran attend huit secondes puis conclut
     « terminee » — ce qui a fait passer un plantage immediat pour un succes. */
  backgroundTasks.update(task, { kind: 'images', done: 0, total: 0 })
  try {
    /* Ce comptage etait hors du `try`. Quand la table manquait, il levait avant lui : le
       `finally` n'etait jamais atteint, `running` restait vrai pour de bon, et toute reprise
       ulterieure ressortait aussitot par le `if (running) return` — meme une fois la table
       creee. Il fallait redemarrer l'application pour esperer relancer l'etape. */
    backgroundTasks.update(task, { kind: 'images', done: 0, total: countPendingImageEmbeddings() })
    /* Les images de vidéo d'abord, pour que la lecture qui suit les trouve : les extraire au
       fil de l'encodage garderait ffmpeg vivant tout du long et mêlerait deux natures de
       travail. */
    const frames = await videoFrames({ shouldStop: () => stopped || backgroundTasks.isPaused() })
    const result = await readImages({
      framesFor: (postId) => frames.get(postId) ?? null,
      shouldStop: () => stopped || backgroundTasks.isPaused(),
      onProgress: ({ done, total }) => backgroundTasks.update(task, { kind: 'images', done, total })
    })
    backgroundTasks.update(task, { kind: 'images', done: result.done, total: result.total })
  } catch (error) {
    // Remontee a l'ecran : une erreur qui ne vit que dans la console n'existe pour personne.
    console.error('[magpie] Lecture des images :', error)
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    clearFrameWorkspace()
    backgroundTasks.clear(task)
    running = false
  }
}
