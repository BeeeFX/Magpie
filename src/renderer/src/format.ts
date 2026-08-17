import type { Language, Platform, Post } from '@shared/types'
import { LOCALE } from './i18n'

/**
 * Locale courante, tenue à jour par le store.
 *
 * Les fonctions de formatage sont appelées depuis des composants mémoïsés et depuis du
 * code sans accès au store ; faire transiter la langue dans chaque appel alourdirait tous
 * les points d'appel pour une valeur qui change une fois par session.
 */
let locale: string = LOCALE.fr
let language: Language = 'fr'

export function setFormatLanguage(next: Language): void {
  locale = LOCALE[next]
  language = next
}

/** Nom lisible de la source, tel qu'affiché en pied de carte. */
export const SOURCE_LABEL: Record<Platform, string> = {
  instagram: 'instagram.com',
  x: 'x.com',
  reddit: 'reddit.com'
}

export const PLATFORM_LABEL: Record<Platform, string> = {
  instagram: 'Instagram',
  x: 'X',
  reddit: 'Reddit'
}

export function formatDate(ms: number | null): string {
  if (!ms) return ''
  return new Date(ms).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatShortDate(ms: number | null): string {
  if (!ms) return ''
  const date = new Date(ms)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' })
  })
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * Durée restante, arrondie à la précision que l'estimation mérite. Annoncer « 7 min 12 s »
 * sur une cadence qui varie avec la latence du CDN donnerait une fausse impression de
 * mesure ; on reste donc grossier au-delà de la minute.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${Math.max(5, Math.ceil(seconds / 5) * 5)} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, '0')}`
}

/** Tailles de fichiers. Les unités suivent la langue : « Mo » en français, « MB » ailleurs. */
export function formatBytes(bytes: number): string {
  const [mo, go] = language === 'fr' ? ['Mo', 'Go'] : ['MB', 'GB']
  if (bytes <= 0) return `0 ${mo}`
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} ${go}` : `${mb.toFixed(1)} ${mo}`
}

export function displayName(post: Post): string {
  return post.authorName ?? post.authorHandle ?? 'Inconnu'
}

/**
 * Avatar de repli : les initiales sur une couleur dérivée du pseudonyme.
 *
 * Les plateformes servent bien de vraies photos de profil, mais leurs URLs sont signées
 * et expirent comme celles des médias : les afficher sans les mettre en cache donnerait
 * une grille de trous au bout de quelques semaines. En attendant ce cache, un monogramme
 * déterministe reste lisible et ne casse jamais.
 */
export function initials(post: Post): string {
  const source = post.authorName ?? post.authorHandle ?? '?'
  const clean = source.replace(/^[@u]\/?/, '').replace(/^r\//, '')
  const parts = clean.split(/[\s._-]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

export function avatarHue(post: Post): number {
  const source = post.authorHandle ?? post.authorName ?? post.id
  let hash = 0
  for (let i = 0; i < source.length; i++) hash = (hash * 31 + source.charCodeAt(i)) >>> 0
  return hash % 360
}

/**
 * Vrai quand la couleur dominante est claire.
 *
 * Sert à basculer l'incrustation des cartes en texte sombre sur voile clair : du blanc
 * sur une photo à fond blanc est illisible, et c'est exactement le cas des captures
 * d'écran et des images de produit, qui sont fréquentes.
 *
 * Luminance relative pondérée selon la sensibilité de l'œil, pas une moyenne des canaux.
 */
export function isLightColor(hex: string | null): boolean {
  if (!hex) return false
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return false
  const value = parseInt(match[1], 16)
  const r = (value >> 16) & 255
  const g = (value >> 8) & 255
  const b = value & 255
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.62
}

export function hasVideo(post: Post): boolean {
  return post.kind === 'video' || post.media.some((m) => m.kind === 'video')
}
