import { useEffect, useState } from 'react'

/**
 * Garde un panneau monté le temps de sa sortie.
 *
 * Tout ce qui s'ouvre dans Magpie s'ouvre en fondu — menus, popovers, modales — et tout
 * disparaissait d'un coup, parce qu'un composant démonté n'a plus d'animation à jouer. Une
 * ouverture soignée suivie d'une fermeture sèche se remarque plus qu'aucune animation du
 * tout : l'œil a appris à attendre un mouvement, et il ne vient pas.
 *
 * `mounted` dit s'il faut encore rendre quelque chose, `closing` s'il faut le rendre en train
 * de partir. Rouvrir pendant la sortie annule proprement le démontage.
 *
 * La durée doit rester un peu plus longue que l'animation CSS correspondante : c'est elle qui
 * décide du démontage, et couper avant la fin ferait sauter la dernière image.
 */
export function useClosing(open: boolean, ms: number): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    if (open) {
      setMounted(true)
      setClosing(false)
      return
    }
    if (!mounted) return
    setClosing(true)
    const timer = setTimeout(() => {
      setMounted(false)
      setClosing(false)
    }, ms)
    return () => clearTimeout(timer)
  }, [open, mounted, ms])

  return { mounted, closing }
}
