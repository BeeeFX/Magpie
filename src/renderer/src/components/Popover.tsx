import { useEffect, useRef, useState } from 'react'
import { useClosing } from '../useClosing'
import { useMenuKeys } from '../useMenuKeys'

interface Props {
  label: React.ReactNode
  title?: string
  badge?: number
  align?: 'left' | 'right'
  /** Le libellé tombe quand la barre se serre ; l'icône et le `title` restent. */
  compact?: boolean
  children: (close: () => void) => React.ReactNode
}

/**
 * Menu déroulant maison. Se ferme au clic extérieur et à Échap, et rend son contenu
 * paresseusement pour qu'un menu jamais ouvert ne coûte rien.
 */
export function Popover({
  label,
  title,
  badge,
  align = 'right',
  compact = false,
  children
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  /* Rendu paresseux **et** sortie animée : le contenu n'existe qu'une fois ouvert, et il reste
     le temps de partir. Les deux tenaient sur le même `open`, donc le menu sautait. */
  const { mounted, closing } = useClosing(open, 150)
  const menuRef = useRef<HTMLDivElement>(null)
  useMenuKeys(menuRef, open)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="popover-anchor" ref={ref}>
      <button
        type="button"
        className={`control ${compact ? 'control--compact' : ''} ${
          open || (badge ?? 0) > 0 ? 'is-active' : ''
        }`}
        /* `useMenuKeys` promet la navigation aux flèches à tout conteneur `role="menu"` : le
           crochet était branché, le rôle manquait. Le bouton de synchronisation, lui, le
           déclarait correctement — deux menus de la même barre ne se présentaient pas pareil. */
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        title={title}
      >
        {label}
        {badge ? <span className="control__badge">{badge}</span> : null}
      </button>

      {mounted ? (
        <div
          ref={menuRef}
          role="menu"
          className={`popover popover--${align} ${closing ? 'is-closing' : ''}`}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  )
}
