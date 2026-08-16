import type { PlaybackQuality, VideoQuality } from './types'

/** Du plus léger au plus lourd. L'ordre du réglage comme celui du menu du lecteur. */
export const QUALITY_LADDER: VideoQuality[] = ['480p', '720p', '1080p', 'source']

/**
 * Traduit la qualité préférée en une qualité réellement disponible pour ce clip.
 *
 * Les plateformes ne servent que les définitions qu'elles ont : un Reel n'existe souvent
 * qu'en 480p et 720p, et l'étiquette « source » n'est posée qu'au-delà de 1080p — donc
 * presque jamais. Exiger la correspondance exacte revenait à ignorer le réglage et à
 * retomber silencieusement sur « Auto », y compris quand une variante plus haute existait.
 *
 * On lit donc la préférence comme un plafond, exactement comme le fait le choix de la
 * variante mise en cache : la meilleure définition qui ne le dépasse pas, et à défaut la
 * plus modeste disponible — mieux vaut lire un clip un cran trop léger que pas du tout.
 */
export function resolvePreferredQuality(
  preference: PlaybackQuality,
  available: VideoQuality[]
): PlaybackQuality {
  if (preference === 'auto' || available.length === 0) return 'auto'

  const ranked = QUALITY_LADDER.filter((quality) => available.includes(quality))
  if (ranked.length === 0) return 'auto'
  if (ranked.includes(preference)) return preference

  const ceiling = QUALITY_LADDER.indexOf(preference)
  const affordable = ranked.filter((quality) => QUALITY_LADDER.indexOf(quality) <= ceiling)
  return affordable.length > 0 ? affordable[affordable.length - 1] : ranked[0]
}
