import { useEffect, useRef, useState } from 'react'

interface Props {
  label: React.ReactNode
  title?: string
  badge?: number
  align?: 'left' | 'right'
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
  children
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

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
        className={`control ${open || (badge ?? 0) > 0 ? 'is-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={title}
      >
        {label}
        {badge ? <span className="control__badge">{badge}</span> : null}
      </button>

      {open ? (
        <div className={`popover popover--${align}`}>{children(() => setOpen(false))}</div>
      ) : null}
    </div>
  )
}
