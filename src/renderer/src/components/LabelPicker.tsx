import type { LabelColor } from '@shared/types'
import { LABELS } from '@shared/types'
import type { TranslationKey } from '../i18n'
import { useT } from '../store'
import { IconClose } from './Icons'

interface Props {
  value: LabelColor | null
  onChange: (label: LabelColor | null) => void
  /** Étiquette accessible du groupe, pour distinguer post et collection. */
  ariaLabel?: string
}

/**
 * Choix d'une teinte, réutilisé pour l'étiquette d'un post et la couleur d'une collection.
 *
 * Cliquer la teinte déjà active la retire : pas besoin d'un bouton « aucune » séparé, et
 * le geste d'annulation est au même endroit que celui d'application.
 */
export function LabelPicker({ value, onChange, ariaLabel }: Props): React.JSX.Element {
  const t = useT()

  return (
    <div className="label-picker" role="group" aria-label={ariaLabel}>
      {LABELS.map((color) => (
        <button
          key={color}
          type="button"
          className={`label-dot label-dot--${color} ${value === color ? 'is-active' : ''}`}
          title={t(`label.${color}` as TranslationKey)}
          aria-label={t(`label.${color}` as TranslationKey)}
          aria-pressed={value === color}
          onClick={() => onChange(value === color ? null : color)}
        />
      ))}
      <button
        type="button"
        className={`label-dot label-dot--none ${value === null ? 'is-active' : ''}`}
        title={t('label.none')}
        aria-label={t('label.none')}
        aria-pressed={value === null}
        onClick={() => onChange(null)}
      >
        <IconClose size={11} />
      </button>
    </div>
  )
}
