import { useStore, useT } from '../store'
import { IconCollections } from './Icons'

/**
 * Ranger sa bibliothèque, au même rang que la synchroniser.
 *
 * Les deux gestes fondent l'application et ils ne font pas la même chose : l'un fait entrer le
 * contenu, l'autre le met en ordre. Ranger vivait pourtant en quatrième position d'un menu caché
 * derrière le chevron du bouton de synchronisation — un endroit où personne ne va chercher une
 * action de premier plan, et où celle-ci n'avait jamais servi.
 *
 * Deux boutons côte à côte, donc, et non un bouton et un sous-menu. Le libellé change une fois
 * qu'un rangement est allé au bout : « ranger » la première fois, « reranger » ensuite — c'est
 * la même action, mais on n'a pas besoin de la même invitation.
 */
export function OrganizeButton(): React.JSX.Element {
  const t = useT()
  const setOrganizerOpen = useStore((state) => state.setOrganizerOpen)
  const organizeMode = useStore((state) => state.organizeMode)

  return (
    <button
      type="button"
      className="control organize-control"
      onClick={() => setOrganizerOpen(true)}
      title={t('actions.organizeHint')}
    >
      <IconCollections size={16} />
      <span>{t(organizeMode ? 'actions.organizeAgain' : 'actions.organize')}</span>
    </button>
  )
}
