import { backgroundTasks } from '../tasks'
import { cachedVideoPaths, countPendingImageEmbeddings } from '../db/queries'
import { clearFrameWorkspace, videoFrames } from './frames'
import { framesNeeded, readImages } from './vision'

/**
 * L'étape « Lire les images », vue de l'application.
 *
 * Deux temps : tirer trois images des clips en cache — le début d'une vidéo ne dit souvent
 * rien de la suite — puis encoder tout ce qui n'a pas déjà été lu.
 *
 * Les deux comptent dans la progression, et c'est une correction. Le premier temps était
 * réputé accessoire ; il ne l'est pas. Sur la bibliothèque de référence il appelle ffmpeg
 * quatre fois pour chacun des 4 440 clips en cache, soit une vingtaine de minutes — pendant
 * lesquelles rien n'était annoncé, et pendant lesquelles rien n'est encore écrit en base,
 * puisque le premier vecteur n'est calculé qu'après. L'étape restait donc à zéro sur un
 * quart d'heure, ce qui se lit comme un blocage ou comme une étape déjà finie, et une passe
 * abandonnée là ne laissait aucune trace. Additionner les deux totaux rend l'attente
 * lisible, et donne à l'estimation de durée de quoi travailler dès la première minute.
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

/* L'identifiant de la tâche, nommé une fois : c'est lui que le registre range et que
   l'interface suspend, et les deux boucles ci-dessous doivent lire exactement celui-là. */
const TASK = 'read:images'

export async function readAllImages(): Promise<void> {
  if (running) return
  running = true
  stopped = false
  failure = null
  const task = TASK
  /* La tache est declaree avant toute lecture de la base : c'est elle qui dit a l'ecran de
     preparation que l'etape a demarre. Sans elle, l'ecran attend huit secondes puis conclut
     « terminee » — ce qui a fait passer un plantage immediat pour un succes. */
  backgroundTasks.update(task, { kind: 'images', done: 0, total: 0 })
  try {
    /* Ce comptage etait hors du `try`. Quand la table manquait, il levait avant lui : le
       `finally` n'etait jamais atteint, `running` restait vrai pour de bon, et toute reprise
       ulterieure ressortait aussitot par le `if (running) return` — meme une fois la table
       creee. Il fallait redemarrer l'application pour esperer relancer l'etape. */
    const pending = countPendingImageEmbeddings()
    backgroundTasks.update(task, { kind: 'images', done: 0, total: pending })
    /* Les images de vidéo d'abord, pour que la lecture qui suit les trouve : les extraire au
       fil de l'encodage garderait ffmpeg vivant tout du long et mêlerait deux natures de
       travail. */
    /* Les clips lus une fois, et triés avant d'ouvrir quoi que ce soit : ceux dont la
       lecture est déjà en base n'ont pas à repasser par ffmpeg. C'est ce tri qui manquait,
       et qui faisait redemander l'étape entière à chaque lancement. */
    const cached = cachedVideoPaths()
    const clipOf = new Map(cached.map((clip) => [clip.postId, clip.videoPath]))
    let clips = 0
    const frames = await videoFrames({
      clips: cached,
      only: framesNeeded(cached),
      shouldStop: () =>
        stopped || backgroundTasks.isPaused() || backgroundTasks.isTaskPaused(TASK),
      /* Le total grandit au premier rapport : le nombre de clips n'est connu qu'ici, et
         l'annoncer d'avance demanderait une requête de plus pour le même chiffre. */
      onProgress: (done, total) => {
        clips = total
        backgroundTasks.update(task, { kind: 'images', done, total: total + pending })
      }
    })
    const result = await readImages({
      framesFor: (postId) => frames.get(postId) ?? null,
      clipOf: (postId) => clipOf.get(postId) ?? null,
      shouldStop: () =>
        stopped || backgroundTasks.isPaused() || backgroundTasks.isTaskPaused(TASK),
      // Les clips sont derrière nous : l'encodage reprend le décompte là où ils l'ont laissé.
      onProgress: ({ done, total }) =>
        backgroundTasks.update(task, { kind: 'images', done: clips + done, total: clips + total })
    })
    backgroundTasks.update(task, {
      kind: 'images',
      done: clips + result.done,
      total: clips + result.total
    })
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
