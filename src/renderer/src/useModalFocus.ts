import { useEffect, useRef, type RefObject } from 'react'

/**
 * Le clavier dans une fenêtre modale : y entrer, y rester, en revenir.
 *
 * Les trois gestes vont ensemble, et n'étaient tenus que par les réglages. Le détail d'un post
 * — l'écran le plus ouvert de l'application — n'avait ni rôle, ni piège de tabulation, ni
 * retour du focus : le curseur restait sur la carte qu'on venait de quitter, `Tab` promenait
 * dans la grille masquée derrière, et un lecteur d'écran ne signalait rien du tout.
 *
 * Sorti en crochet plutôt que recopié : trois fenêtres le demandent, et une quatrième
 * l'oublierait. `Échap` reste à l'appelant — chaque fenêtre a sa façon de se fermer, et le
 * détail doit d'abord sortir du plein écran.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useModalFocus(open: boolean, panelRef: RefObject<HTMLElement | null>): void {
  const returnTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    returnTo.current = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    /* Après la peinture : le panneau vient d'être monté, et viser son premier contrôle avant
       qu'il existe ne fait rien du tout. */
    const raf = requestAnimationFrame(() => {
      const first = panel?.querySelector<HTMLElement>(FOCUSABLE)
      if (first) first.focus()
      else panel?.focus()
    })

    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || !panel) return
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (node) => node.offsetParent !== null || node === document.activeElement
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKey)
      /* Rendre le focus d'où il venait : sans ça, fermer une fenêtre laisse le curseur sur
         `<body>` et la tabulation suivante repart du haut de la page. */
      returnTo.current?.focus()
    }
  }, [open, panelRef])
}
