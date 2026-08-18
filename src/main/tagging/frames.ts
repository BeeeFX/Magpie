import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { mediaDir } from '../db'
import { cachedVideoPaths } from '../db/queries'

/**
 * Trois images plutôt qu'une, pour les vidéos dont on a le clip.
 *
 * La couverture d'une vidéo ne dit souvent rien de la suite : un carton de titre, un visage
 * de miniature, une accroche. Prendre aussi le milieu et la fin donne au modèle ce que le
 * post *montre* réellement, et la moyenne des trois est plus stable qu'une seule vue.
 *
 * Seuls les clips déjà en cache sont concernés — 634 sur 4 338 vidéos au moment d'écrire.
 * Les autres gardent leur couverture, et passeront à trois images le jour où leur clip sera
 * téléchargé : le hash porte sur les chemins, donc ce post-là sera relu, et lui seul.
 */

/** Aux extrémités exactes on tombe souvent sur du noir ou un fondu. */
const POSITIONS = [0.15, 0.5, 0.85]

let scratch: string | null = null

/** Un dossier de travail par session, nettoyé à la sortie. */
function workspace(): string {
  if (scratch && existsSync(scratch)) return scratch
  scratch = mkdtempSync(join(tmpdir(), 'magpie-frames-'))
  return scratch
}

export function clearFrameWorkspace(): void {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = null
}

async function grab(video: string, at: number, target: string): Promise<boolean> {
  const executable = ffmpegPath
  if (!executable) return false
  return new Promise<boolean>((resolve) => {
    const child = spawn(
      executable,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        // Chercher avant d'ouvrir l'entrée : ffmpeg saute alors directement, au lieu de
        // décoder tout ce qui précède. Sur un clip d'une minute, c'est cent fois moins cher.
        '-ss',
        at.toFixed(2),
        '-i',
        video,
        '-frames:v',
        '1',
        '-vf',
        'scale=336:-1',
        target
      ],
      { windowsHide: true }
    )
    const timeout = setTimeout(() => child.kill(), 20_000)
    child.on('error', () => {
      clearTimeout(timeout)
      resolve(false)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      resolve(code === 0 && existsSync(target))
    })
  })
}

async function durationOf(video: string): Promise<number> {
  const executable = ffmpegPath
  if (!executable) return 0
  return new Promise<number>((resolve) => {
    // `ffmpeg` sans sortie écrit la durée sur stderr : pas besoin d'embarquer `ffprobe`.
    const child = spawn(executable, ['-hide_banner', '-i', video], { windowsHide: true })
    let text = ''
    child.stderr.on('data', (chunk: Buffer) => {
      if (text.length < 8000) text += String(chunk)
    })
    const timeout = setTimeout(() => child.kill(), 15_000)
    child.on('error', () => {
      clearTimeout(timeout)
      resolve(0)
    })
    child.on('close', () => {
      clearTimeout(timeout)
      const found = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(text)
      if (!found) return resolve(0)
      resolve(Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3]))
    })
  })
}

/**
 * Les images à lire pour chaque post, quand mieux que la couverture est disponible.
 *
 * Rendue une fois par passe : extraire à la demande obligerait à garder ffmpeg vivant
 * pendant toute la lecture, et à mêler deux natures de travail.
 */
export async function videoFrames(options: {
  onProgress?: (done: number, total: number) => void
  shouldStop?: () => boolean
}): Promise<Map<string, string[]>> {
  const clips = cachedVideoPaths()
  const out = new Map<string, string[]>()
  if (clips.length === 0) return out
  const dir = workspace()
  let done = 0
  for (const clip of clips) {
    if (options.shouldStop?.()) break
    const video = join(mediaDir(), clip.videoPath)
    if (!existsSync(video)) continue
    const seconds = await durationOf(video)
    if (seconds > 1) {
      const frames: string[] = []
      for (const [index, position] of POSITIONS.entries()) {
        const target = join(dir, `${clip.postId.replace(/[^a-z0-9]/gi, '')}-${index}.jpg`)
        if (await grab(video, seconds * position, target)) frames.push(target)
      }
      if (frames.length > 0) out.set(clip.postId, frames)
    }
    done += 1
    if (done % 8 === 0) options.onProgress?.(done, clips.length)
  }
  options.onProgress?.(done, clips.length)
  return out
}
