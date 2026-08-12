import { getDb } from '../db'

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
