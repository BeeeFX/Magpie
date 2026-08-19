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
 * Seuls les clips déjà en cache sont concernés. Les autres gardent leur couverture, et
 * passeront à trois images le jour où leur clip sera téléchargé : le hash porte sur le clip,
 * donc ce post-là sera relu, et lui seul.
 *
 * Cette passe n'est pas gratuite : quatre appels à ffmpeg par clip — un pour la durée, trois
 * pour les images — soit 312 ms par clip mesurés sur la bibliothèque de référence. Ses 4 440
 * clips en cache demandent donc une vingtaine de minutes, avant que le moindre vecteur ne
 * soit calculé. D'où l'avancement rendu à l'appelant : sans lui, l'étape reste muette tout ce
 * temps et se donne pour bloquée.
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

/** Ce qu'on a tiré d'un clip, et le clip d'où ça vient. */
export interface PostFrames {
  /** Les images extraites, dans le dossier de travail de la session. */
  paths: string[]
  /**
   * Le clip d'origine, tel qu'il est rangé en base.
   *
   * C'est lui qui identifie la lecture, pas les images : celles-ci vivent dans un dossier
   * recréé à chaque session, sous un nom tiré au hasard. Les faire entrer dans le hash
   * rendait toute reprise impossible — aucun post illustré par une vidéo ne pouvait se
   * retrouver « déjà lu », puisque son empreinte changeait d'un lancement à l'autre.
   */
  source: string
}

/**
 * Les images à lire pour chaque post, quand mieux que la couverture est disponible.
 *
 * Rendue une fois par passe : extraire à la demande obligerait à garder ffmpeg vivant
 * pendant toute la lecture, et à mêler deux natures de travail.
 */
export async function videoFrames(options: {
  /** Les clips du cache. Passés par l'appelant, qui les a déjà lus pour trier ce qui suit. */
  clips?: { postId: string; videoPath: string }[]
  /**
   * Les seuls posts à traiter.
   *
   * Omis, tous les clips y passent — ce qui était le comportement, et le défaut : une
   * bibliothèque déjà lue repayait une vingtaine de minutes de ffmpeg pour des images
   * aussitôt jetées par `clearFrameWorkspace()`.
   */
  only?: Set<string>
  onProgress?: (done: number, total: number) => void
  shouldStop?: () => boolean
}): Promise<Map<string, PostFrames>> {
  const all = options.clips ?? cachedVideoPaths()
  const clips = options.only ? all.filter((clip) => options.only?.has(clip.postId)) : all
  const out = new Map<string, PostFrames>()
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
      if (frames.length > 0) out.set(clip.postId, { paths: frames, source: clip.videoPath })
    }
    done += 1
    if (done % 8 === 0) options.onProgress?.(done, clips.length)
  }
  options.onProgress?.(done, clips.length)
  return out
}
