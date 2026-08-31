import { useEffect, useRef, useState } from 'react'
import type { TranslationKey } from '../i18n'
import { useT } from '../store'

/**
 * Un bouton qui se retourne pour demander confirmation.
 *
 * Deux grammaires cohabitaient : `window.confirm`, à quatre endroits, et cette bascule en deux
 * temps, écrite une fois dans le gestionnaire de collections. On garde celle-ci. La boîte
 * native fonctionne sous Electron — contrairement à `window.prompt` — mais elle bloque la
 * boucle d'événements, ses deux boutons ne sont pas traduisibles, et elle ne ressemble à rien
 * du reste de l'application.
 *
 * Le geste dangereux n'apparaît qu'au second temps, et le retour en arrière est le bouton le
 * plus large : on doit pouvoir renoncer sans viser.
 */
export function ConfirmButton({
  label,
  confirm,
  confirmVars,
  icon,
  className = 'btn',
  disabled = false,
  title,
  onConfirm
}: {
  /** Le libellé au repos. */
  label: TranslationKey
  /** Ce que dit le bouton une fois retourné — il doit nommer la conséquence, pas dire « oui ». */
  confirm: TranslationKey
  /** De quoi chiffrer cette conséquence : « Supprimer 10 collections » plutôt que « Supprimer ». */
  confirmVars?: Record<string, string | number>
  /**
   * Ce que montre le premier temps, quand une rangée d'icônes n'a pas la place d'un libellé.
   *
   * Le second temps reste du texte, toujours : c'est là qu'il faut nommer la conséquence, et
   * une icône ne la nomme pas. `label` sert alors d'infobulle et de nom accessible.
   */
  icon?: React.ReactNode
  className?: string
  disabled?: boolean
  title?: string
  onConfirm: () => void
}): React.JSX.Element {
  const [armed, setArmed] = useState(false)
  const timer = useRef<number | null>(null)

  /* Une question posée reste ouverte quelques secondes, pas indéfiniment : un bouton rouge
     oublié au milieu d'une liste finit par être cliqué pour autre chose. */
  useEffect(() => {
    if (!armed) return
    timer.current = window.setTimeout(() => setArmed(false), 6000)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [armed])

  const t = useT()
  if (!armed) {
    return (
      <button
        type="button"
        className={className}
        disabled={disabled}
        title={title ?? t(label)}
        aria-label={icon ? t(label) : undefined}
        onClick={() => setArmed(true)}
      >
        {icon ?? t(label)}
      </button>
    )
  }

  return (
    <span className="confirm-pair">
      <button
        type="button"
        className="btn btn--danger"
        disabled={disabled}
        onClick={() => {
          setArmed(false)
          onConfirm()
        }}
      >
        {t(confirm, confirmVars)}
      </button>
      <button type="button" className="btn" onClick={() => setArmed(false)}>
        {t('organizer.cancel')}
      </button>
    </span>
  )
}
