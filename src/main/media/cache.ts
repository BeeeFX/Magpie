import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import sharp from 'sharp'
import ffmpegPath from 'ffmpeg-static'
import type { Platform, VideoQuality } from '@shared/types'
import { fetchMedia } from '../adapters/http'
import { mediaDir } from '../db'
import {
  pendingThumbnails,
  pendingVideos,
  markVideoCacheResult,
  setThumbnail,
  setVideo,
  setVideoVariantCache,
  videoVariant
} from '../db/queries'
import { readSettings } from '../settings'

/**
 * Cache de vignettes. Voir SPEC.md §7.
 *
 * L'objectif n'est pas seulement d'éviter des allers-retours réseau : les URLs médias
 * d'Instagram et de X sont signées et expirent. Sans copie locale, une grille de six mois
 * serait pleine de carrés cassés.
 *
 * Effet de bord tout aussi important : on extrait ici les dimensions et la couleur
 * dominante, qu'on stocke en base. C'est ce qui permet au masonry de calculer sa mise en
 * page sans charger la moindre image.
 */

const MAX_WIDTH = 640
const QUALITY = 80

/** Nom déterministe : rejouer le cache n'accumule pas de fichiers orphelins. */
function thumbName(postId: string, idx: number): string {
  return `${createHash('sha1').update(`${postId}:${idx}`).digest('hex')}.webp`
}

function videoName(postId: string, idx: number): string {
  return `${createHash('sha1').update(`${postId}:${idx}:video`).digest('hex')}.mp4`
}

function variantVideoName(postId: string, idx: number, quality: VideoQuality): string {
  return `${createHash('sha1').update(`${postId}:${idx}:video:${quality}`).digest('hex')}.mp4`
}

/** Le protocole `magpie://` ne sert que des noms de ces formes — voir main/index.ts. */
export const THUMB_NAME_PATTERN = /^[0-9a-f]{40}\.webp$/
export const VIDEO_NAME_PATTERN = /^[0-9a-f]{40}\.mp4$/

class CacheQuotaReached extends Error {}

function cacheBytes(): number {
  return readdirSync(mediaDir()).reduce((total, entry) => {
    try {
      return total + statSync(join(mediaDir(), entry)).size
    } catch {
      return total
    }
  }, 0)
}

function ensureQuota(bytes: number): void {
  const limit = readSettings().cacheLimitGb * 1024 * 1024 * 1024
  if (cacheBytes() + bytes > limit) throw new CacheQuotaReached()
}

async function cacheAdaptiveVideo(source: string, target: string, signal?: AbortSignal): Promise<void> {
  const executable = ffmpegPath
  if (!executable) throw new Error('ffmpeg indisponible')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      executable,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-c', 'copy', '-movflags', '+faststart', target],
      { windowsHide: true }
    )
    let error = ''
    child.stderr.on('data', (chunk: Buffer) => {
      if (error.length < 4000) error += String(chunk)
    })
    const timeout = setTimeout(() => child.kill(), 10 * 60 * 1000)
    const abort = (): void => {
      child.kill()
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (err: Error) => {
      signal?.removeEventListener('abort', abort)
      rmSync(target, { force: true })
      reject(err)
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      if (code === 0) resolve()
      else {
        rmSync(target, { force: true })
        reject(new Error(error || `ffmpeg a quitté avec le code ${code}`))
      }
    })
    if (signal?.aborted) abort()
  })
  const limit = readSettings().cacheLimitGb * 1024 * 1024 * 1024
  if (cacheBytes() > limit) {
    rmSync(target, { force: true })
    throw new CacheQuotaReached()
  }
}

async function loadSource(
  platform: Platform,
  sourcePath: string | null,
  remoteUrl: string | null,
  signal?: AbortSignal
): Promise<Buffer> {
  if (sourcePath && existsSync(sourcePath)) {
    return sharp(sourcePath).toBuffer()
  }
  if (remoteUrl && /^https?:/.test(remoteUrl)) {
    return fetchMedia(platform, remoteUrl, 180000, signal)
  }
  throw new Error('Aucune source exploitable pour cette vignette')
}

export async function buildThumbnail(
  platform: Platform,
  postId: string,
  idx: number,
  sourcePath: string | null,
  remoteUrl: string | null = null,
  signal?: AbortSignal
): Promise<void> {
  const name = thumbName(postId, idx)
  const target = join(mediaDir(), name)

  const input = await loadSource(platform, sourcePath, remoteUrl, signal)

  const info = await sharp(input)
    .rotate() // respecte l'orientation EXIF avant de mesurer
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toFile(target)

  const stats = await sharp(input).stats()
  const { r, g, b } = stats.dominant

  setThumbnail(postId, idx, {
    thumbPath: name,
    width: info.width,
    height: info.height,
    dominantColor: `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
  })
}

/**
 * Met un clip en cache local. Même raison que pour les vignettes : les URLs vidéo
 * d'Instagram et de X sont signées et expirent, donc un mur de six mois ne pourrait plus
 * rien lire. Le fichier est copié tel quel — pas de ré-encodage, ce serait cher pour un
 * aperçu au survol.
 */
export async function cacheVideo(
  platform: Platform,
  postId: string,
  idx: number,
  source: string,
  signal?: AbortSignal
): Promise<void> {
  const name = videoName(postId, idx)
  const target = join(mediaDir(), name)

  if (!existsSync(target)) {
    if (/^https?:/.test(source)) {
      if (/\.(?:m3u8|mpd)(?:\?|$)/i.test(source)) {
        await cacheAdaptiveVideo(source, target, signal)
      } else {
        const data = await fetchMedia(platform, source, 180000, signal)
        ensureQuota(data.length)
        writeFileSync(target, data)
      }
    } else if (existsSync(source)) {
      copyFileSync(source, target)
    } else {
      throw new Error('Aucune source exploitable pour ce clip')
    }
  }

  setVideo(postId, idx, name)
}

/** Télécharge à la demande une qualité supérieure choisie dans le lecteur. */
export async function cacheRequestedVideoQuality(
  postId: string,
  idx: number,
  quality: VideoQuality
): Promise<string> {
  const variant = videoVariant(postId, idx, quality)
  if (!variant) throw new Error('Cette qualité n’est plus disponible pour ce média.')
  if (variant.cachePath && existsSync(join(mediaDir(), variant.cachePath))) {
    return variant.cachePath
  }

  const name = variantVideoName(postId, idx, quality)
  const target = join(mediaDir(), name)
  if (!existsSync(target)) {
    if (/^https?:/.test(variant.source)) {
      const data = await fetchMedia(variant.platform, variant.source)
      ensureQuota(data.length)
      writeFileSync(target, data)
    } else if (existsSync(variant.source)) {
      copyFileSync(variant.source, target)
    } else {
      throw new Error('La source de cette qualité a expiré.')
    }
  }
  setVideoVariantCache(postId, idx, quality, name)
  return name
}

export interface CacheProgress {
  done: number
  total: number
  postIds?: string[]
}

/**
 * Traite tout ce qui n'a pas encore de vignette, avec une concurrence bornée : sharp est
 * gourmand et saturer les cœurs rendrait l'interface saccadée pendant le premier sync.
 */
export async function processPendingMedia(
  onProgress?: (progress: CacheProgress) => void,
  concurrency = 4,
  shouldPause?: () => boolean,
  signal?: AbortSignal
): Promise<CacheProgress> {
  const thumbs = pendingThumbnails().map((t) => ({ type: 'thumb' as const, ...t }))
  const videos = pendingVideos().map((v) => ({ type: 'video' as const, ...v }))
  // Trois affiches puis un clip : auparavant, les milliers de vignettes bloquaient toute
  // la file vidéo jusqu'à leur achèvement. L'entrelacement fait progresser les deux sans
  // laisser les gros fichiers ralentir l'apparition du mur.
  const pending: Array<(typeof thumbs)[number] | (typeof videos)[number]> = []
  let thumbCursor = 0
  let videoCursor = 0
  while (thumbCursor < thumbs.length || videoCursor < videos.length) {
    for (let i = 0; i < 3 && thumbCursor < thumbs.length; i++) {
      pending.push(thumbs[thumbCursor++])
    }
    if (videoCursor < videos.length) pending.push(videos[videoCursor++])
  }
  const total = pending.length
  let done = 0
  const changedPostIds = new Set<string>()

  if (total === 0) return { done: 0, total: 0 }

  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < pending.length && !shouldPause?.()) {
      const item = pending[cursor++]
      try {
        if (item.type === 'thumb') {
          await buildThumbnail(
            item.platform,
            item.post_id,
            item.idx,
            item.source_path,
            item.remote_url,
            signal
          )
        } else if (item.video_source) {
          await cacheVideo(item.platform, item.post_id, item.idx, item.video_source, signal)
        }
      } catch (err) {
        if (item.type === 'video') {
          markVideoCacheResult(
            item.post_id,
            item.idx,
            err instanceof CacheQuotaReached ? 'skipped' : 'pending'
          )
        }
        console.warn(`[magpie] Média impossible pour ${item.post_id}#${item.idx}:`, err)
      }
      done++
      changedPostIds.add(item.post_id)
      if (done === 1 || done % 10 === 0 || done === total) {
        onProgress?.({ done, total, postIds: [...changedPostIds] })
        changedPostIds.clear()
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker))
  if (changedPostIds.size > 0) onProgress?.({ done, total, postIds: [...changedPostIds] })
  return { done, total }
}
