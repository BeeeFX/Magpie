import { existsSync, rmSync } from 'node:fs'
import { copyFile, readdir, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import sharp from 'sharp'
import ffmpegPath from 'ffmpeg-static'
import type { Platform, PostQuery } from '@shared/types'
import { downloadMediaToFile, fetchMedia, MediaLimitExceeded } from '../adapters/http'
import { mediaDir } from '../db'
import {
  pendingClips,
  pendingThumbnails,
  pendingThumbnailsForPosts,
  pendingVideos,
  markThumbnailFailure,
  markVideoCacheResult,
  setThumbnail,
  setVideo,
  forgetThumbnailPaths,
  forgetVideoPaths,
  thumbnailPathsForPosts,
} from '../db/queries'
import { readSettings } from '../settings'
import { THUMB_NAME_PATTERN, VIDEO_NAME_PATTERN, thumbName, videoName } from './names'

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

export { THUMB_NAME_PATTERN, VIDEO_NAME_PATTERN } from './names'

class CacheQuotaReached extends Error {}

/**
 * Part du disque alloué réservée aux vignettes.
 *
 * Sans elle, un cache partagé se remplit de clips — mille fois plus lourds — et la place à
 * faire pour une vignette se prend forcément sur les vignettes, seules évinçables. Mesuré
 * sur une vraie bibliothèque : 634 clips occupaient 4,72 Go d'un plafond de 5, contre
 * 0,28 Go pour treize mille vignettes. Chaque débordement effaçait donc la totalité des
 * vignettes — et remettait leur compteur de tentatives à zéro, si bien que l'étape
 * « télécharger les images des tuiles » recommençait indéfiniment, sans jamais rien signaler.
 *
 * Un quart suffit très largement : une vignette pèse une vingtaine de kilo-octets, donc ce
 * quart en tient plus de cinquante mille sur un plafond de 5 Go, là où la bibliothèque de
 * référence en compte seize mille.
 */
const THUMBNAIL_SHARE = 0.25

let knownThumbBytes: number | null = null
let knownOtherBytes: number | null = null
let cacheScan: Promise<{ thumbs: number; other: number }> | null = null

/** Un seul inventaire du cache par lancement, au lieu d'un scan de milliers de fichiers
 * avant chaque clip. Les écritures suivantes maintiennent les compteurs en mémoire. */
async function cacheParts(): Promise<{ thumbs: number; other: number }> {
  if (knownThumbBytes !== null && knownOtherBytes !== null) {
    return { thumbs: knownThumbBytes, other: knownOtherBytes }
  }
  if (cacheScan) return cacheScan

  cacheScan = (async () => {
    const dir = mediaDir()
    const entries = await readdir(dir)
    let cursor = 0
    let thumbs = 0
    let other = 0
    const worker = async (): Promise<void> => {
      while (cursor < entries.length) {
        const entry = entries[cursor++]
        try {
          const size = (await stat(join(dir, entry))).size
          if (THUMB_NAME_PATTERN.test(entry)) thumbs += size
          else other += size
        } catch {
          // Un autre travailleur peut avoir remplacé un fichier entre les deux appels.
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(16, entries.length) }, worker))
    knownThumbBytes = thumbs
    knownOtherBytes = other
    cacheScan = null
    return { thumbs, other }
  })()
  return cacheScan
}

async function cacheBytes(): Promise<number> {
  const parts = await cacheParts()
  return parts.thumbs + parts.other
}

export function getCacheUsage(): Promise<number> {
  return cacheBytes()
}

function recordCacheDelta(delta: number, kind: 'thumb' | 'other'): void {
  if (kind === 'thumb') {
    if (knownThumbBytes !== null) knownThumbBytes = Math.max(0, knownThumbBytes + delta)
  } else if (knownOtherBytes !== null) {
    knownOtherBytes = Math.max(0, knownOtherBytes + delta)
  }
}

/** Les deux enveloppes, déduites du plafond réglé par l'utilisateur. */
function budgets(): { limit: number; thumbs: number; other: number } {
  const limit = readSettings().cacheLimitGb * 1024 * 1024 * 1024
  const thumbs = limit * THUMBNAIL_SHARE
  return { limit, thumbs, other: limit - thumbs }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/** Place restante pour un clip : son enveloppe à lui, jamais celle des vignettes. */
async function ensureQuota(bytes: number): Promise<void> {
  const { other: budget } = budgets()
  if ((await cacheParts()).other + bytes > budget) throw new CacheQuotaReached()
}

/**
 * Fait de la place pour une vignette — dans l'enveloppe des vignettes.
 *
 * L'ancienne version visait le plafond global : quand les clips le remplissaient à eux
 * seuls, la cible était hors d'atteinte et la boucle vidait la totalité des vignettes sans
 * jamais l'atteindre, ni signaler quoi que ce soit. Une vignette ne chasse plus qu'une
 * vignette, et seulement quand les vignettes débordent de leur propre part.
 */
/* Vraie que dès qu'une vignette a dû en chasser une autre : les vignettes remplissent alors
   leur part, et l'étape qui les télécharge ne peut plus finir — chaque nouvelle en efface une
   ancienne, qui repassera en file. Il faut le dire, pas tourner en rond. */
let thumbnailsEvicted = false

export function takeThumbnailPressure(): boolean {
  const pressed = thumbnailsEvicted
  thumbnailsEvicted = false
  return pressed
}

async function makeThumbnailRoom(bytes: number, protectedName?: string): Promise<void> {
  const limit = budgets().thumbs
  let usage = (await cacheParts()).thumbs
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
    recordCacheDelta(-item.size, 'thumb')
    if (usage + bytes <= limit * 0.92) break
  }
  if (removed.length > 0) thumbnailsEvicted = true
  forgetThumbnailPaths(removed)
  if (usage + bytes > limit) throw new CacheQuotaReached()
}

/**
 * Fait de la place pour un clip — dans l'enveloppe des clips.
 *
 * Il n'existait pas, et c'est ce qui laissait le dossier grossir sans retour : rien dans ce
 * code ne supprimait jamais un .mp4. Une fois la part pleine, les clips étaient *refusés*,
 * jamais *repris* — le dossier ne pouvait donc que croître, ou être vidé en entier. Relevé sur
 * la machine de référence : dix-huit gigaoctets pour un plafond réglé à cinq.
 *
 * Le plus ancien consulté part le premier, comme pour les vignettes. La référence en base est
 * effacée avec le fichier, sinon la carte du post désignerait un clip absent.
 *
 * **Une passe ne rend qu'un peu de place à la fois**, et c'est essentiel. Les liens vidéo des
 * plateformes sont signés et expirent : un clip supprimé ne se retélécharge que tant que son
 * lien vaut encore, et sur de l'historique ancien il faut une resynchronisation complète. Or
 * un dossier très au-dessus du plafond — dix-huit gigaoctets pour cinq, relevé ici — verrait
 * sinon quatorze gigaoctets partir en une fois, au premier clip demandé, sans un mot. On
 * revient donc au plafond par paliers, au rythme où le cache sert, et chaque passe le dit.
 */
export async function makeVideoRoom(bytes: number): Promise<void> {
  const limit = budgets().other
  let usage = (await cacheParts()).other
  if (usage + bytes + reservedBytes <= limit) return

  const candidates = await Promise.all(
    (await readdir(mediaDir()))
      .filter((name) => VIDEO_NAME_PATTERN.test(name))
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
  let freed = 0
  for (const item of candidates
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((a, b) => a.usedAt - b.usedAt)) {
    await rm(join(mediaDir(), item.name), { force: true })
    removed.push(item.name)
    usage -= item.size
    recordCacheDelta(-item.size, 'other')
    freed += item.size
    /* On descend un peu sous la cible : évincer un clip par clip téléchargé ferait payer un
       balayage du dossier à chacun. */
    if (usage + bytes + reservedBytes <= limit * 0.92) break
    if (freed >= EVICTION_PASS_LIMIT) break
  }
  forgetVideoPaths(removed)
  if (removed.length > 0) {
    console.log(
      `[magpie] ${removed.length} clip(s) évincés, ${(freed / 1024 / 1024).toFixed(0)} Mo rendus ` +
        `(${(usage / 1024 / 1024 / 1024).toFixed(2)} Go de clips pour un plafond de ` +
        `${(limit / 1024 / 1024 / 1024).toFixed(2)} Go).`
    )
  }
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

/**
 * Le plafond d'un seul clip, indépendant de la place restante.
 *
 * Il n'y en avait aucun : `maxBytes` recevait l'enveloppe entière, donc sur un cache neuf un
 * seul clip avait droit aux 3,75 Gio de sa part. Un clip de 110 Mo relevé sur la bibliothèque
 * de référence n'a jamais approché du refus. Un aperçu au survol n'a pas besoin de plus.
 */
const MAX_CLIP_BYTES = 96 * 1024 * 1024

/** Ce qu’une seule passe d’éviction rend au plus. Voir `makeVideoRoom`. */
const EVICTION_PASS_LIMIT = 12 * MAX_CLIP_BYTES

/**
 * Ce que les téléchargements en cours ont déjà le droit de dépenser.
 *
 * La place était lue avant le téléchargement et comptabilisée après, alors que jusqu'à douze
 * travailleurs tournent de front : chacun lisait la même place libre et se croyait seul à
 * pouvoir la prendre. On réserve donc d'abord, on libère ensuite — le dépassement ne peut plus
 * être multiplié par le nombre de travailleurs.
 */
let reservedBytes = 0

async function remainingQuota(): Promise<number> {
  const { other: budget } = budgets()
  return Math.max(0, budget - (await cacheParts()).other - reservedBytes)
}

/** Appelé après une purge ou un déplacement de bibliothèque. */
export function resetCacheUsage(bytes: number | null = null): void {
  knownThumbBytes = bytes === null ? null : 0
  knownOtherBytes = bytes
  cacheScan = null
}

/** Ce que chaque enveloppe contient, pour le dire à l'utilisateur plutôt qu'un total muet. */
export async function getCacheBreakdown(): Promise<{
  thumbs: number
  other: number
  thumbBudget: number
  otherBudget: number
}> {
  const parts = await cacheParts()
  const { thumbs, other } = budgets()
  return { thumbs: parts.thumbs, other: parts.other, thumbBudget: thumbs, otherBudget: other }
}

async function cacheAdaptiveVideo(source: string, target: string, signal?: AbortSignal): Promise<void> {
  await makeVideoRoom(MAX_CLIP_BYTES)
  if ((await remainingQuota()) <= 0) throw new CacheQuotaReached()
  const previousSize = await fileSize(target)

  const executable = ffmpegPath
  if (!executable) throw new Error('ffmpeg indisponible')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      executable,
      /* `-fs` : le remuxage écrivait un flux entier sans borne, et la taille n’était vérifiée
         qu'une fois le fichier sur le disque. ffmpeg s'arrête maintenant au plafond. Le fichier
         tronqué est jeté par le contrôle de taille en sortie. */
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-c', 'copy', '-movflags',
        '+faststart', '-fs', String(MAX_CLIP_BYTES), target],
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
  recordCacheDelta(nextSize - previousSize, 'other')
  if ((await cacheParts()).other > budgets().other) {
    rmSync(target, { force: true })
    recordCacheDelta(-nextSize, 'other')
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
  recordCacheDelta(info.size - previousSize, 'thumb')

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
        await makeVideoRoom(MAX_CLIP_BYTES)
        const available = Math.min(await remainingQuota(), MAX_CLIP_BYTES)
        if (available <= 0) throw new CacheQuotaReached()
        /* Réservé avant, libéré après : deux travailleurs ne peuvent plus se promettre la
           même place. La réserve porte sur le plafond et non sur la taille réelle — celle-ci
           n'est connue qu'une fois le fichier écrit. */
        reservedBytes += available
        try {
          const bytes = await downloadMediaToFile(platform, source, target, available, 180000, signal)
          recordCacheDelta(bytes, 'other')
        } catch (error) {
          if (error instanceof MediaLimitExceeded) throw new CacheQuotaReached()
          throw error
        } finally {
          reservedBytes = Math.max(0, reservedBytes - available)
        }
      }
    } else if (existsSync(source)) {
      const bytes = await fileSize(source)
      if (bytes > MAX_CLIP_BYTES) throw new CacheQuotaReached()
      await makeVideoRoom(bytes)
      await ensureQuota(bytes)
      await copyFile(source, target)
      recordCacheDelta(bytes, 'other')
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

/** Remonté à l'appelant plutôt qu'avalé : un préchargement qui bute sur le quota doit
 *  s'interrompre et le dire, pas s'acharner en évinçant ce qu'il vient d'écrire. */
export interface CacheOutcome extends CacheProgress {
  hasMore: boolean
  /** Les vignettes se chassent entre elles : leur part est pleine, l'étape ne finira pas. */
  thumbnailsCapped: boolean
  quotaReached: boolean
}

/**
 * Traite tout ce qui n'a pas encore de vignette, avec une concurrence bornée : sharp est
 * gourmand et saturer les cœurs rendrait l'interface saccadée pendant le premier sync.
 */
export interface ProcessMediaOptions {
  onProgress?: (progress: CacheProgress) => void
  concurrency?: number
  shouldPause?: () => boolean
  signal?: AbortSignal
  /** Restreint la passe aux posts demandés par la grille — le mode cache intelligent. */
  requestedPostIds?: string[]
  /** Ignore la file vidéo même en mode hors-ligne : un préchargement de vignettes ne doit
   *  jamais se mettre à télécharger des clips au passage. */
  thumbnailsOnly?: boolean
  /** Seulement le média de couverture. Le mur n'affiche que celui-là ; les vues suivantes
   *  d'un carrousel restent paresseuses, ce qui divise le travail par deux. */
  coverOnly?: boolean
  /** Restreint la passe au périmètre affiché : un tag, une collection, une recherche. */
  scope?: PostQuery | null
  /** Téléchargement délibéré de clips, indépendamment du mode de stockage : c'est une
   *  action demandée, pas une politique. Restreint au périmètre s'il y en a un. */
  clips?: PostQuery | true | null
}

export async function processPendingMedia({
  onProgress,
  concurrency = 2,
  shouldPause,
  signal,
  requestedPostIds,
  thumbnailsOnly = false,
  coverOnly = false,
  scope = null,
  clips = null
}: ProcessMediaOptions = {}): Promise<CacheOutcome> {
  /**
   * Un lot demandé par la grille reste court, parce que la file ne se réordonne qu'entre
   * deux lots : avec trois cent soixante vignettes d'avance, elle continuait de préparer
   * ce que l'utilisateur avait déjà dépassé pendant que son écran restait vide. Court, le
   * lot rend la main assez souvent pour que la position courante reprenne la main.
   * La passe de fond, elle, n'a personne à suivre et garde de gros lots.
   */
  const thumbnailBatch = requestedPostIds ? 48 : 360
  const videoBatch = 120
  const thumbRows = requestedPostIds
    ? pendingThumbnailsForPosts(requestedPostIds, thumbnailBatch)
    : pendingThumbnails(thumbnailBatch, coverOnly, scope)
  const thumbs = thumbRows.map((t) => ({ type: 'thumb' as const, ...t }))

  // Un clip pèse mille fois une vignette : les lots restent courts pour que l'avancement
  // se voie bouger et qu'une interruption ne perde pas grand-chose.
  const clipRows = clips
    ? pendingClips(24, clips === true ? null : clips)
    : !thumbnailsOnly && readSettings().mediaStorageMode === 'offline'
      ? pendingVideos(videoBatch)
      : []
  const videos = clipRows.map((v) => ({ type: 'video' as const, ...v }))
  // Un lot plein signifie qu'il en reste, y compris pour une demande de la grille : c'est
  // à l'appelant de relancer, en réordonnant d'abord sur la position courante.
  const hasMore =
    thumbs.length === thumbnailBatch || videos.length === (clips ? 24 : videoBatch)
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
  let quotaReached = false
  const changedPostIds = new Set<string>()

  if (total === 0) {
    return { done: 0, total: 0, hasMore: false, quotaReached: false, thumbnailsCapped: false }
  }

  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < pending.length && !shouldPause?.() && !quotaReached) {
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
        } else if (item.video_source && (clips || readSettings().mediaStorageMode === 'offline')) {
          await cacheVideo(item.platform, item.post_id, item.idx, item.video_source, signal)
        }
      } catch (err) {
        if (err instanceof CacheQuotaReached) quotaReached = true
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
  return { done, total, hasMore, quotaReached, thumbnailsCapped: takeThumbnailPressure() }
}
