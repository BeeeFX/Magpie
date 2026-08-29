import { useEffect, type RefObject } from 'react'

/**
 * Les flèches parcourent un menu ouvert.
 *
 * Un conteneur qui se déclare `role="menu"` promet ce comportement : c'est la seule chose que
 * la spécification exige de lui, et aucun des menus de Magpie ne la tenait. À la souris on ne
 * s'en aperçoit pas ; au clavier, un menu de dix entrées obligeait à tabuler à travers
 * l'application entière, dans un ordre qui n'est pas le sien.
 *
 * Ce qui est délibérément absent : le focus ne saute pas sur la première entrée à l'ouverture.
 * Ces menus s'ouvrent presque toujours à la souris, et déplacer le focus sous le curseur fait
 * clignoter un halo dont personne n'a besoin. La première flèche l'y amène.
 *
 * Une entrée désactivée est sautée, pas traversée : la réponse à « suivant » ne peut pas être
 * un endroit où rien ne se passe.
 */
export function useMenuKeys(container: RefObject<HTMLElement | null>, open: boolean): void {
  useEffect(() => {
    if (!open) return

    const onKey = (event: KeyboardEvent): void => {
      const root = container.current
      if (!root) return
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return

      /* Une liste déroulante ou un champ dans le menu garde ses propres flèches : elles y
         changent une valeur ou déplacent un curseur, ce qui prime sur la navigation. */
      const focused = document.activeElement as HTMLElement | null
      const tag = focused?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      const items = [...root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      if (items.length === 0) return

      const at = focused ? items.indexOf(focused as HTMLButtonElement) : -1
      let next = 0
      if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = items.length - 1
      else if (event.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length
      else next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length

      event.preventDefault()
      items[next].focus()
    }

    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [container, open])
}
