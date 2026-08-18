/**
 * Jeu d'icônes maison. Une seule grille de 20×20, un seul trait, des extrémités et des
 * jointures arrondies partout, et `currentColor` : c'est ce qui les fait lire comme une
 * famille plutôt que comme une collection. Aucune dépendance pour une vingtaine de formes.
 *
 * Le trait est volontairement un peu gras (1,75) et les rayons généreux : à 16 px, un
 * trait fin paraît fragile et casse l'impression d'ensemble arrondie.
 */
interface IconProps {
  size?: number
  className?: string
}

const base = (size: number, className?: string): React.SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  className,
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
})

/** Marque-page : l'icône de « tous les signets ». */
export function IconGrid({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M5 3.4h10a1.6 1.6 0 011.6 1.6v11.6L10 13.3l-6.6 3.3V5A1.6 1.6 0 015 3.4z" />
    </svg>
  )
}

export function IconInbox({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M3 11.4h3.4l1.2 2.2h4.8l1.2-2.2H17" />
      <path d="M4.6 4.4h10.8l1.6 7v3.6a1.8 1.8 0 01-1.8 1.8H4.8A1.8 1.8 0 013 15V11.4z" />
    </svg>
  )
}

export function IconStar({ size = 16, filled = false }: IconProps & { filled?: boolean }): React.JSX.Element {
  return (
    <svg {...base(size)} fill={filled ? 'currentColor' : 'none'}>
      <path d="M10 2.8l2.24 4.54 5.01.73-3.62 3.53.85 4.99L10 14.24l-4.48 2.35.85-4.99L2.75 8.07l5.01-.73z" />
    </svg>
  )
}

export function IconHeart({ size = 16, filled = false }: IconProps & { filled?: boolean }): React.JSX.Element {
  return (
    <svg {...base(size)} fill={filled ? 'currentColor' : 'none'}>
      <path d="M10 16.9S3 12.8 3 7.2C3 4.8 4.5 3.3 6.6 3.3c1.4 0 2.7.8 3.4 2 .7-1.2 2-2 3.4-2 2.1 0 3.6 1.5 3.6 3.9 0 5.6-7 9.7-7 9.7z" />
    </svg>
  )
}

export function IconTag({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M2.8 8.6V3.6a.8.8 0 01.8-.8h5l8.6 8.6a1.2 1.2 0 010 1.7l-4.3 4.3a1.2 1.2 0 01-1.7 0z" />
      <circle cx="6.6" cy="6.6" r="1.05" />
    </svg>
  )
}

export function IconSearch({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <circle cx="8.8" cy="8.8" r="5.4" />
      <path d="M12.9 12.9l4 4" />
    </svg>
  )
}

export function IconFilter({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M3 5h14M6 10h8M8.5 15h3" />
    </svg>
  )
}

export function IconSort({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M6 4v12M6 16l-2.6-2.8M6 16l2.6-2.8" />
      <path d="M14 16V4M14 4l-2.6 2.8M14 4l2.6 2.8" />
    </svg>
  )
}

export function IconMasonry({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="2.6" y="2.6" width="6" height="8.4" rx="1.5" />
      <rect x="11.4" y="2.6" width="6" height="5" rx="1.5" />
      <rect x="2.6" y="13.6" width="6" height="3.8" rx="1.5" />
      <rect x="11.4" y="10.2" width="6" height="7.2" rx="1.5" />
    </svg>
  )
}

export function IconCards({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="2.6" y="3.4" width="6" height="6" rx="1.5" />
      <rect x="11.4" y="3.4" width="6" height="6" rx="1.5" />
      <path d="M2.6 12.4h6M2.6 15.4h4M11.4 12.4h6M11.4 15.4h4" />
    </svg>
  )
}

export function IconSettings({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <circle cx="10" cy="10" r="2.7" />
      <path d="M15.8 12.2a1.3 1.3 0 00.26 1.43l.05.05a1.55 1.55 0 11-2.2 2.2l-.05-.05a1.3 1.3 0 00-1.43-.26 1.3 1.3 0 00-.79 1.19v.14a1.55 1.55 0 11-3.1 0v-.07a1.3 1.3 0 00-.85-1.19 1.3 1.3 0 00-1.43.26l-.05.05a1.55 1.55 0 11-2.2-2.2l.05-.05a1.3 1.3 0 00.26-1.43 1.3 1.3 0 00-1.19-.79h-.14a1.55 1.55 0 110-3.1h.07a1.3 1.3 0 001.19-.85 1.3 1.3 0 00-.26-1.43l-.05-.05a1.55 1.55 0 112.2-2.2l.05.05a1.3 1.3 0 001.43.26h.06a1.3 1.3 0 00.79-1.19v-.14a1.55 1.55 0 113.1 0v.07a1.3 1.3 0 00.79 1.19 1.3 1.3 0 001.43-.26l.05-.05a1.55 1.55 0 112.2 2.2l-.05.05a1.3 1.3 0 00-.26 1.43v.06a1.3 1.3 0 001.19.79h.14a1.55 1.55 0 110 3.1h-.07a1.3 1.3 0 00-1.19.79z" />
    </svg>
  )
}

export function IconPanel({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="2.6" y="3.4" width="14.8" height="13.2" rx="2.2" />
      <path d="M8 3.4v13.2" />
    </svg>
  )
}

export function IconCollections({ size = 16, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, className)}>
      <path d="M2.8 6.4a1.6 1.6 0 011.6-1.6h2.5l1.3 1.7h5.4a1.6 1.6 0 011.6 1.6v6.1a1.6 1.6 0 01-1.6 1.6H4.4a1.6 1.6 0 01-1.6-1.6z" />
    </svg>
  )
}

export function IconClose({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M5.4 5.4l9.2 9.2M14.6 5.4l-9.2 9.2" />
    </svg>
  )
}

export function IconCheck({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M4.2 10.4l3.7 3.6 8-8.4" />
    </svg>
  )
}

export function IconCopy({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="7" y="7" width="9.4" height="9.4" rx="2" />
      <path d="M13 7V5.6a2 2 0 00-2-2H5.6a2 2 0 00-2 2V11a2 2 0 002 2H7" />
    </svg>
  )
}

export function IconDownload({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M10 3.4v8.4" />
      <path d="M6.4 8.6L10 12.2l3.6-3.6" />
      <path d="M4 14.2v1.2a1.4 1.4 0 001.4 1.4h9.2a1.4 1.4 0 001.4-1.4v-1.2" />
    </svg>
  )
}

export function IconPause({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} fill="currentColor" stroke="none">
      <rect x="6" y="5" width="2.8" height="10" rx="1" />
      <rect x="11.2" y="5" width="2.8" height="10" rx="1" />
    </svg>
  )
}

export function IconPlay({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} fill="currentColor" stroke="none">
      <path d="M7.2 5.2l7.4 4.8-7.4 4.8z" />
    </svg>
  )
}

export function IconSync({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M16.8 8.6A7 7 0 004.6 5.9M3.2 11.4a7 7 0 0012.2 2.7" />
      <path d="M16.6 3.9v4.7h-4.7M3.4 16.1v-4.7h4.7" />
    </svg>
  )
}

export function IconChevronLeft({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M12.4 4.6L6.8 10l5.6 5.4" />
    </svg>
  )
}

export function IconChevronRight({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M7.6 4.6L13.2 10l-5.6 5.4" />
    </svg>
  )
}

export function IconExpand({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M11.6 3.4h5v5M8.4 16.6h-5v-5M16.6 3.4l-5.8 5.8M3.4 16.6l5.8-5.8" />
    </svg>
  )
}

export function IconContract({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M8.4 8.4h-5v-5M11.6 11.6h5v5M3.4 3.4l5.8 5.8M16.6 16.6l-5.8-5.8" />
    </svg>
  )
}

export function IconExternal({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M11.4 3.4h5.2v5.2M16.6 3.4L9 11" />
      <path d="M15 12v3.4a1.6 1.6 0 01-1.6 1.6H4.6A1.6 1.6 0 013 15.4V6.6A1.6 1.6 0 014.6 5H8" />
    </svg>
  )
}

export function IconPlus({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M10 4.4v11.2M4.4 10h11.2" />
    </svg>
  )
}

export function IconClock({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <circle cx="10" cy="10" r="6.8" />
      <path d="M10 6.2V10l2.6 1.6" />
    </svg>
  )
}

export function IconLink({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M8.4 11.6a3 3 0 004.4.3l2.4-2.4a3 3 0 00-4.3-4.3l-1.3 1.3" />
      <path d="M11.6 8.4a3 3 0 00-4.4-.3L4.8 10.5a3 3 0 004.3 4.3l1.3-1.3" />
    </svg>
  )
}

export function IconImage({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="3" y="4.2" width="14" height="11.6" rx="2" />
      <circle cx="7.6" cy="8.4" r="1.2" />
      <path d="M3.4 13.4l3.8-3.4 3 2.6 2.6-2.2 3.2 2.8" />
    </svg>
  )
}

/** Un œil : l'étape qui regarde les images plutôt que de les télécharger. */
export function IconEye({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M1.8 10s3-5.2 8.2-5.2S18.2 10 18.2 10s-3 5.2-8.2 5.2S1.8 10 1.8 10z" />
      <circle cx="10" cy="10" r="2.6" />
    </svg>
  )
}

/** Haut-parleur. `waves` à faux donne la version muette, sans les ondes. */
export function IconVolume({
  size = 16,
  waves = true
}: IconProps & { waves?: boolean }): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M4.4 7.6h2.4L10.4 4.4a.6.6 0 011 .45v10.3a.6.6 0 01-1 .45L6.8 12.4H4.4a1 1 0 01-1-1V8.6a1 1 0 011-1z" />
      {waves ? <path d="M14 7.6a3.6 3.6 0 010 4.8M16.2 5.4a6.8 6.8 0 010 9.2" /> : null}
    </svg>
  )
}

/** Micro : la transcription écoute la piste audio, elle ne regarde pas l'image. */
export function IconMic({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="7.4" y="2.6" width="5.2" height="9.4" rx="2.6" />
      <path d="M4.6 9.6a5.4 5.4 0 0010.8 0M10 15v2.4" />
    </svg>
  )
}

export function IconVideo({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="2.8" y="5" width="10.4" height="10" rx="2" />
      <path d="M13.2 9l4-2.2v6.4l-4-2.2z" />
    </svg>
  )
}

/** Envoi vers Nitrate : une flèche qui descend dans un bac. */
export function IconSend({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M10 2.8v8.6M10 11.4l-3-3M10 11.4l3-3" />
      <path d="M3.4 12.6v2.4a2 2 0 002 2h9.2a2 2 0 002-2v-2.4" />
    </svg>
  )
}

export function IconLayers({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M10 2.9l7 3.6-7 3.6-7-3.6z" />
      <path d="M3 10.6l7 3.6 7-3.6" />
    </svg>
  )
}
