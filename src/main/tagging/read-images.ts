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

export function isReadingImages(): boolean {
  return running
}

export function stopReadingImages(): void {
  stopped = true
}

export function pendingImageCount(): number {
  return countPendingImageEmbeddings()
}

export async function readAllImages(): Promise<void> {
  if (running) return
  running = true
  stopped = false
  const task = 'read:images'
  backgroundTasks.update(task, { kind: 'images', done: 0, total: countPendingImageEmbeddings() })
  try {
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
    console.error('[magpie] Lecture des images :', error)
  } finally {
    clearFrameWorkspace()
    backgroundTasks.clear(task)
    running = false
  }
}
