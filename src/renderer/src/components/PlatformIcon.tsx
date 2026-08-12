import type { Platform } from '@shared/types'

/**
 * Logos des plateformes.
 *
 * Redessinés à la main plutôt qu'importés : les glyphes officiels sont des marques
 * déposées dont les conditions d'usage varient, et une forme simplifiée reste reconnaissable
 * à 16 px là où le logo exact devient une bouillie.
 *
 * Ils prennent `currentColor` par défaut, sauf `coloured` qui applique la couleur de marque —
 * utile dans le panneau, où c'est justement le repère qu'on cherche.
 */

interface Props {
  platform: Platform
  size?: number
  coloured?: boolean
}

export const PLATFORM_COLOR: Record<Platform, string> = {
  instagram: '#e1306c',
  x: 'currentColor',
  reddit: '#ff5c1f'
}

export function PlatformIcon({ platform, size = 16, coloured = false }: Props): React.JSX.Element {
  const style = coloured ? { color: PLATFORM_COLOR[platform] } : undefined

  if (platform === 'instagram') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        aria-hidden
        style={style}
      >
        <rect x="2.9" y="2.9" width="14.2" height="14.2" rx="4.4" />
        <circle cx="10" cy="10" r="3.5" />
        <circle cx="14.3" cy="5.7" r="1" fill="currentColor" stroke="none" />
      </svg>
    )
  }

  if (platform === 'x') {
    return (
      <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" aria-hidden style={style}>
        <path d="M12.9 3h2.4l-5.2 6 6.2 8h-4.9l-3.8-5-4.4 5H.8l5.6-6.4L.5 3h5l3.5 4.6zm-.9 12.6h1.3L7.1 4.3H5.7z" />
      </svg>
    )
  }

  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" aria-hidden style={style}>
      <path d="M17.9 10a1.9 1.9 0 00-3.2-1.4 9.4 9.4 0 00-4.9-1.5l.9-4 2.8.6a1.4 1.4 0 101.4-1.5 1.4 1.4 0 00-1.3.8l-3.2-.7a.4.4 0 00-.5.3l-1 4.5a9.4 9.4 0 00-4.8 1.5A1.9 1.9 0 103 13a3.6 3.6 0 000 .6c0 2.8 3.2 5 7.1 5s7.1-2.2 7.1-5a3.6 3.6 0 000-.6 1.9 1.9 0 00.7-3zM6.6 11.4a1.4 1.4 0 111.4 1.4 1.4 1.4 0 01-1.4-1.4zm7.7 3.7a4.9 4.9 0 01-3.1.9h-.1a4.9 4.9 0 01-3.1-.9.4.4 0 01.5-.6 4.2 4.2 0 002.6.7h.1a4.2 4.2 0 002.6-.7.4.4 0 11.5.6zm-.2-2.3a1.4 1.4 0 111.4-1.4 1.4 1.4 0 01-1.4 1.4z" />
    </svg>
  )
}
