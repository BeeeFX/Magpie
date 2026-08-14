import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { copyFile, readdir, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import sharp from 'sharp'
import ffmpegPath from 'ffmpeg-static'
import type { Platform } from '@shared/types'
import { downloadMediaToFile, fetchMedia, MediaLimitExceeded } from '../adapters/http'
import { mediaDir } from '../db'
import {
  pendingThumbnails,
  pendingThumbnailsForPosts,
  pendingVideos,
  markThumbnailFailure,
  markVideoCacheResult,
  setThumbnail,
  setVideo,
  forgetThumbnailPaths,
  thumbnailPathsForPosts,
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

const MAX_WIDTH = 480
const QUALITY = 76
let mediaWarningCount = 0

function warnMedia(postId: string, idx: number, error: unknown): void {
  mediaWarningCount++
  // Une URL expirée ne doit pas produire des milliers de lignes et ralentir le processus
  // principal. On garde les premiers diagnostics, puis un échantillon régulier.
  if (mediaWarningCount <= 20 || mediaWarningCount % 100 === 0) {
    console.warn(
      `[magpie] Média impossible pour ${postId}#${idx} (${mediaWarningCount} échec(s)) :`,
      error
    )
  }
}

/** Nom déterministe : rejouer le cache n'accumule pas de fichiers orphelins. */
function thumbName(postId: string, idx: number): string {
  return `${createHash('sha1').update(`${postId}:${idx}`).digest('hex')}.webp`
}

function videoName(postId: string, idx: number): string {
  return `${createHash('sha1').update(`${postId}:${idx}:video`).digest('hex')}.mp4`
}

/** Le protocole `magpie://` ne sert que des noms de ces formes — voir main/index.ts. */
export const THUMB_NAME_PATTERN = /^[0-9a-f]{40}\.webp$/
export const VIDEO_NAME_PATTERN = /^[0-9a-f]{40}\.mp4$/

class CacheQuotaReached extends Error {}

let knownCacheBytes: number | null = null
let cacheScan: Promise<number> | null = null

/** Un seul inventaire du cache par lancement, au lieu d'un scan de milliers de fichiers
 * avant chaque clip. Les écritures suivantes maintiennent le compteur en mémoire. */
async function cacheBytes(): Promise<number> {
  if (knownCacheBytes !== null) return knownCacheBytes
  if (cacheScan) return cacheScan

  cacheScan = (async () => {
    const dir = mediaDir()
    const entries = await readdir(dir)
    let cursor = 0
    let total = 0
    const worker = async (): Promise<void> => {
      while (cursor < entries.length) {
        const entry = entries[cursor++]
        try {
          total += (await stat(join(dir, entry))).size
        } catch {
          // Un autre travailleur peut avoir remplacé un fichier entre les deux appels.
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(16, entries.length) }, worker))
    knownCacheBytes = total
    cacheScan = null
    return total
  })()
  return cacheScan
}

export function getCacheUsage(): Promise<number> {
  return cacheBytes()
}

function recordCacheDelta(delta: number): void {
  if (knownCacheBytes !== null) knownCacheBytes = Math.max(0, knownCacheBytes + delta)
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function ensureQuota(bytes: number): Promise<void> {
  const limit = readSettings().cacheLimitGb * 1024 * 1024 * 1024
  if ((await cacheBytes()) + bytes > limit) throw new CacheQuotaReached()
}

async function makeThumbnailRoom(bytes: number, protectedName?: string): Promise<void> {
  const limit = readSettings().cacheLimitGb * 1024 * 1024 * 1024
  let usage = await cacheBytes()
  if (usage + bytes <= limit) return

  const candidates = await Promise.all(
    (await readdir(mediaDir()))
      .filter((name) => THUMB_NAME_PATTERN.test(name) && name !== protectedName)
      .map(async (name) => {
        try {
          const info = await stat(join(mediaDir(), name))
          return { name, size: info.size, usedAt: Math.max(info.atimeMs, info.mtimeMs) }
        } catch {
          return null
        }
      })
  )
  const removed: string[] = []
  for (const item of candidates.filter((value): value is NonNullable<typeof value> => Boolean(value)).sort((a, b) => a.usedAt - b.usedAt)) {
    await rm(join(mediaDir(), item.name), { force: true })
    removed.push(item.name)
    usage -= item.size
    recordCacheDelta(-item.size)
    if (usage + bytes <= limit * 0.92) break
  }
  forgetThumbnailPaths(removed)
  if (usage + bytes > limit) throw new CacheQuotaReached()
}

/** Les cartes consultées deviennent les dernières candidates à l'éviction. */
export async function touchCachedThumbnails(postIds: string[]): Promise<void> {
  const now = new Date()
  await Promise.all(
    thumbnailPathsForPosts(postIds).map((name) =>
      utimes(join(mediaDir(), name), now, now).catch(() => {})
    )
  )
}

async function remainingQuota(): Promise<number> {
  const limit = readSettings().cacheLimitGb * 1024 * 1024 * 1024
  return Math.max(0, limit - (await cacheBytes()))
}

/** Appelé après une purge ou un déplacement de bibliothèque. */
export function resetCacheUsage(bytes: number | null = null): void {
  knownCacheBytes = bytes
  cacheScan = null
}

async function cacheAdaptiveVideo(source: string, target: string, signal?: AbortSignal): Promise<void> {
  if ((await remainingQuota()) <= 0) throw new CacheQuotaReached()
  const previousSize = await fileSize(target)

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
  const nextSize = await fileSize(target)
  recordCacheDelta(nextSize - previousSize)
  const limit = readSettings().cacheLimitGb * 1024 * 1024 * 1024
  if ((await cacheBytes()) > limit) {
    rmSync(target, { force: true })
    recordCacheDelta(-nextSize)
    throw new CacheQuotaReached()
  }
}

async function loadSource(
  platform: Platform,
  sourcePath: string | null,
  remoteUrl: string | null,
  signal?: AbortSignal
): Promise<Buffer | string> {
  if (sourcePath && existsSync(sourcePath)) {
    return sourcePath
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
  const previousSize = await fileSize(target)

  // Une vignette 480p WebP est généralement bien sous 512 Kio. Cette réserve suffit
  // à déclencher l'éviction avant le décodage de l'original.
  await makeThumbnailRoom(512 * 1024, name)

  const input = await loadSource(platform, sourcePath, remoteUrl, signal)

  const info = await sharp(input)
    .rotate() // respecte l'orientation EXIF avant de mesurer
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toFile(target)
  recordCacheDelta(info.size - previousSize)

  // La couleur dominante n'a pas besoin de redécoder l'original, parfois immense. La
  // vignette déjà réduite contient la même information visuelle pour une fraction du CPU.
  const stats = await sharp(target).resize(32, 32, { fit: 'inside' }).stats()
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
        const available = await remainingQuota()
        if (available <= 0) throw new CacheQuotaReached()
        try {
          const bytes = await downloadMediaToFile(platform, source, target, available, 180000, signal)
          recordCacheDelta(bytes)
        } catch (error) {
          if (error instanceof MediaLimitExceeded) throw new CacheQuotaReached()
          throw error
        }
      }
    } else if (existsSync(source)) {
      const bytes = await fileSize(source)
      await ensureQuota(bytes)
      await copyFile(source, target)
      recordCacheDelta(bytes)
    } else {
      throw new Error('Aucune source exploitable pour ce clip')
    }
  }

  setVideo(postId, idx, name)
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
  concurrency = 2,
  shouldPause?: () => boolean,
  signal?: AbortSignal,
  requestedPostIds?: string[]
): Promise<CacheProgress & { hasMore: boolean }> {
  const thumbnailBatch = 360
  const videoBatch = 120
  const thumbRows = requestedPostIds
    ? pendingThumbnailsForPosts(requestedPostIds, thumbnailBatch)
    : pendingThumbnails(thumbnailBatch)
  const thumbs = thumbRows.map((t) => ({ type: 'thumb' as const, ...t }))
  const videos =
    readSettings().mediaStorageMode === 'offline'
      ? pendingVideos(videoBatch).map((v) => ({ type: 'video' as const, ...v }))
      : []
  const hasMore = !requestedPostIds && (thumbs.length === thumbnailBatch || videos.length === videoBatch)
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

  if (total === 0) return { done: 0, total: 0, hasMore: false }

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
        } else if (item.video_source && readSettings().mediaStorageMode === 'offline') {
          await cacheVideo(item.platform, item.post_id, item.idx, item.video_source, signal)
        }
      } catch (err) {
        if (item.type === 'thumb' && !signal?.aborted) {
          markThumbnailFailure(item.post_id, item.idx)
        }
        if (item.type === 'video' && !signal?.aborted) {
          markVideoCacheResult(
            item.post_id,
            item.idx,
            err instanceof CacheQuotaReached ? 'skipped' : 'pending'
          )
        }
        if (!signal?.aborted) warnMedia(item.post_id, item.idx, err)
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
  return { done, total, hasMore }
}
