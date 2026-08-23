import { readdirSync, rmSync, statSync } from 'node:fs'
import { getDb, mediaDir } from '../db'
import { join } from 'node:path'
import { thumbName, videoName, THUMB_NAME_PATTERN, VIDEO_NAME_PATTERN } from '../media/names'

/**
 * Réparations de données déjà en base.
 *
 * Un adaptateur qui s'améliore laisse derrière lui des lignes produites par l'ancienne
 * version. Plutôt que d'imposer une resynchronisation complète — coûteuse et visible par
 * la plateforme — on recalcule depuis la charge brute conservée dans `posts.raw`, qui
 * existe exactement pour ça.
 */

const MAX_VIDEO_BITRATE = 2_500_000
const MAX_VIDEO_WIDTH = 720

/**
 * Réconcilie la base avec ce que contient réellement le dossier média — dans les deux sens.
 *
 * **Référence sans fichier.** C'est le pire des deux mondes : la carte croit avoir sa
 * vignette, donc elle n'affiche ni image ni indicateur d'attente — juste son aplat de
 * couleur — et la file de préparation ne la reprendra jamais, puisqu'elle ne retient que les
 * médias dont le chemin est vide. Un mur entier pouvait rester ainsi, sans qu'aucune
 * synchronisation n'y change quoi que ce soit. Le cas venait d'une purge de cache
 * interrompue : un seul fichier verrouillé par Windows suffisait à supprimer les autres sans
 * jamais remettre les références à zéro.
 *
 * **Fichier sans référence.** Le symétrique, et de très loin le plus coûteux : chaque
 * resynchronisation d'un post déjà connu comparait des URLs de CDN resignées, concluait que
 * le média avait changé et effaçait le chemin de sa vignette et de son clip. Les fichiers,
 * eux, restaient — seize mille vignettes sur le disque pour treize mille reconnues, et
 * treize gigaoctets de clips qu'il aurait fallu retélécharger. Comme le nom d'un fichier de
 * cache se déduit du couple (post, index), on les retrouve sans rien lire : ce sont des
 * fichiers à rattacher, pas à refaire.
 *
 * `media_identity` empêche désormais l'orphelinat de se reproduire ; cette passe répare ce
 * que les versions précédentes ont laissé.
 */
export interface CacheReconciliation {
  /** Références vers un fichier disparu, remises en file. */
  thumbs: number
  videos: number
  /** Fichiers présents que la base avait cessé de reconnaître. */
  relinkedThumbs: number
  relinkedVideos: number
  /** Fichiers que plus aucune ligne ne peut désigner, et les octets rendus. */
  orphans: number
  orphanBytes: number
}

export function repairMissingCacheFiles(): CacheReconciliation {
  let present: Set<string>
  try {
    present = new Set(readdirSync(mediaDir()))
  } catch {
    // Bibliothèque sur un disque absent : on ne touche à rien plutôt que de tout effacer.
    return { thumbs: 0, videos: 0, relinkedThumbs: 0, relinkedVideos: 0, orphans: 0, orphanBytes: 0 }
  }

  const db = getDb()
  const rows = db
    .prepare(
      `SELECT post_id, idx, thumb_path, video_path, kind FROM media`
    )
    .all() as {
    post_id: string
    idx: number
    thumb_path: string | null
    video_path: string | null
    kind: string
  }[]

  const clearThumb = db.prepare(
    'UPDATE media SET thumb_path = NULL, thumb_attempts = 0 WHERE post_id = ? AND idx = ?'
  )
  const clearVideo = db.prepare(
    `UPDATE media SET video_path = NULL, video_cache_state = 'pending', video_attempts = 0
      WHERE post_id = ? AND idx = ?`
  )
  const linkThumb = db.prepare(
    'UPDATE media SET thumb_path = ?, thumb_attempts = 0 WHERE post_id = ? AND idx = ?'
  )
  const linkVideo = db.prepare(
    `UPDATE media SET video_path = ?, video_cache_state = 'cached', video_attempts = 0
      WHERE post_id = ? AND idx = ?`
  )

  const result: CacheReconciliation = {
    thumbs: 0,
    videos: 0,
    relinkedThumbs: 0,
    relinkedVideos: 0,
    orphans: 0,
    orphanBytes: 0
  }

  db.transaction(() => {
    for (const row of rows) {
      if (row.thumb_path && !present.has(row.thumb_path)) {
        clearThumb.run(row.post_id, row.idx)
        result.thumbs++
      } else if (!row.thumb_path) {
        const name = thumbName(row.post_id, row.idx)
        if (present.has(name)) {
          linkThumb.run(name, row.post_id, row.idx)
          result.relinkedThumbs++
        }
      }

      if (row.video_path && !present.has(row.video_path)) {
        clearVideo.run(row.post_id, row.idx)
        result.videos++
      } else if (!row.video_path && row.kind === 'video') {
        const name = videoName(row.post_id, row.idx)
        if (present.has(name)) {
          linkVideo.run(name, row.post_id, row.idx)
          result.relinkedVideos++
        }
      }
    }
  })()

  /* Le dernier sens, celui qui manquait : du **fichier** vers la ligne.

     Le rattachement ci-dessus part des lignes et retrouve leur fichier ; un fichier dont la
     ligne a disparu — post supprimé, carrousel raccourci par `trimMedia`, données de
     démonstration retirées — n'est atteint par personne et ne le sera jamais. Il occupait
     pourtant sa place, et rien dans le code ne le supprimait.

     On ne juge que sur le nom : il se déduit du couple (post, index), donc l'ensemble de ce
     qui est légitime se construit sans lire un octet. Et on ne touche qu'aux deux formes de
     noms du cache — tout le reste du dossier est laissé tel quel. */
  const expected = new Set<string>()
  for (const row of rows) {
    expected.add(thumbName(row.post_id, row.idx))
    expected.add(videoName(row.post_id, row.idx))
    if (row.thumb_path) expected.add(row.thumb_path)
    if (row.video_path) expected.add(row.video_path)
  }
  for (const name of present) {
    if (expected.has(name)) continue
    if (!THUMB_NAME_PATTERN.test(name) && !VIDEO_NAME_PATTERN.test(name)) continue
    try {
      const size = statSync(join(mediaDir(), name)).size
      rmSync(join(mediaDir(), name), { force: true })
      result.orphans += 1
      result.orphanBytes += size
    } catch {
      // Fichier verrouillé ou déjà parti : la place perdue est un désagrément, pas un échec.
    }
  }

  return result
}

interface XVariant {
  bitrate?: number
  content_type?: string
  url?: string
}

/** Résolution lisible directement dans l'URL des clips X : `/vid/avc1/3840x2160/…` */
function widthFromUrl(url: string): number {
  const match = /\/(\d{3,5})x(\d{3,5})\//.exec(url)
  return match ? Number(match[1]) : 0
}

function collectVariants(node: unknown, into: XVariant[]): void {
  if (!node || typeof node !== 'object') return
  const record = node as Record<string, unknown>

  const info = record.video_info as { variants?: XVariant[] } | undefined
  if (info?.variants) into.push(...info.variants)

  for (const value of Object.values(record)) {
    if (Array.isArray(value)) for (const item of value) collectVariants(item, into)
    else if (value && typeof value === 'object') collectVariants(value, into)
  }
}

function pickAffordable(variants: XVariant[]): string | null {
  const usable = variants.filter((v) => v.content_type === 'video/mp4' && v.url)
  if (usable.length === 0) return null

  const affordable = usable.filter(
    (v) => (v.bitrate ?? 0) <= MAX_VIDEO_BITRATE && widthFromUrl(v.url ?? '') <= MAX_VIDEO_WIDTH
  )
  if (affordable.length === 0) {
    return usable.reduce((best, v) => ((v.bitrate ?? Infinity) < (best.bitrate ?? Infinity) ? v : best))
      .url ?? null
  }
  return affordable.reduce((best, v) => ((v.bitrate ?? 0) > (best.bitrate ?? 0) ? v : best)).url ?? null
}

/**
 * Remplace les clips trop lourds — jusqu'à de la 4K — par une variante raisonnable.
 * Les télécharger expirait systématiquement et aurait rempli le disque, pour un aperçu
 * affiché dans une carte de trois cents pixels.
 */
export function repairOversizedVideos(): number {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT m.post_id, m.idx, m.video_source, p.raw
         FROM media m JOIN posts p ON p.id = m.post_id
        WHERE m.video_path IS NULL AND m.video_source LIKE 'http%' AND p.raw IS NOT NULL`
    )
    .all() as { post_id: string; idx: number; video_source: string; raw: string }[]

  const update = db.prepare('UPDATE media SET video_source = ? WHERE post_id = ? AND idx = ?')
  let repaired = 0

  for (const row of rows) {
    if (widthFromUrl(row.video_source) <= MAX_VIDEO_WIDTH) continue

    let variants: XVariant[] = []
    try {
      collectVariants(JSON.parse(row.raw), variants)
    } catch {
      continue
    }

    const better = pickAffordable(variants)
    if (better && better !== row.video_source) {
      update.run(better, row.post_id, row.idx)
      repaired++
    }
  }

  return repaired
}
