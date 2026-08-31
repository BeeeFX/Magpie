import { useEffect, useRef } from 'react'
import { MODIFIER } from '../format'
import type { TranslationKey } from '../i18n'
import { useStore, useT } from '../store'
import { useClosing } from '../useClosing'
import { useModalFocus } from '../useModalFocus'
import { IconClose } from './Icons'

/**
 * Les raccourcis, écrits quelque part.
 *
 * Ils existaient tous — ouvrir la recherche, replier le panneau, parcourir les posts au clavier,
 * passer d'une image à l'autre dans un carrousel, le plein écran — et aucun n'était écrit nulle
 * part. Seuls deux se devinaient, parce qu'ils sont imprimés dans le champ de recherche et sur
 * la ligne des réglages ; les cinq du lecteur ne se découvraient qu'en tâtonnant.
 *
 * La liste est tenue à la main, et c'est un engagement : elle ne doit décrire que des touches
 * qui font réellement quelque chose. Une liste qui ment coûte plus cher que pas de liste.
 * Les sources, dans l'ordre : `App.tsx` pour les trois globales, `Toolbar.tsx` pour la
 * recherche, `Detail.tsx` pour le lecteur, `Card.tsx` pour l'ouverture au clavier.
 */

interface Row {
  keys: (string | TranslationKey)[]
  /** Les touches nommées se traduisent — « Échap » n'est pas « Esc ». */
  translateKeys?: boolean
  label: TranslationKey
}

const GROUPS: { title: TranslationKey; rows: Row[] }[] = [
  {
    title: 'shortcuts.groupGlobal',
    rows: [
      { keys: ['mod', 'K'], label: 'shortcuts.search' },
      { keys: ['mod', 'B'], label: 'shortcuts.panel' },
      { keys: ['mod', ','], label: 'shortcuts.settings' },
      { keys: ['↑', '↓'], label: 'shortcuts.menuMove' },
      { keys: ['?'], label: 'shortcuts.help' },
      { keys: ['shortcuts.esc'], translateKeys: true, label: 'shortcuts.close' }
    ]
  },
  {
    title: 'shortcuts.groupPost',
    rows: [
      { keys: ['←', '→'], label: 'shortcuts.steps' },
      { keys: ['↑', '↓'], label: 'shortcuts.media' },
      { keys: ['shortcuts.wheel'], translateKeys: true, label: 'shortcuts.steps' },
      { keys: ['F'], label: 'shortcuts.fullscreen' },
      { keys: ['shortcuts.esc'], translateKeys: true, label: 'shortcuts.closePost' }
    ]
  },
  {
    title: 'shortcuts.groupWall',
    rows: [{ keys: ['shortcuts.enter'], translateKeys: true, label: 'shortcuts.openPost' }]
  },
  {
    /* Les deux gestes de la carte que rien n'annonçait. Le clic droit est le **seul** geste
       d'écriture qu'elle offre — nommer un endroit — et il n'apparaissait ni ici ni dans son
       aide en bas d'écran. Un geste que personne ne peut deviner n'existe pas. */
    title: 'shortcuts.groupMap',
    rows: [
      { keys: ['shortcuts.rightClick'], translateKeys: true, label: 'shortcuts.nameSpot' },
      { keys: ['shortcuts.doubleClick'], translateKeys: true, label: 'shortcuts.zoomIn' },
      { keys: ['shortcuts.wheel'], translateKeys: true, label: 'shortcuts.zoom' }
    ]
  }
]

export function Shortcuts(): React.JSX.Element | null {
  const t = useT()
  const open = useStore((s) => s.shortcutsOpen)
  const setOpen = useStore((s) => s.setShortcutsOpen)
  const { mounted, closing } = useClosing(open, 230)
  const panelRef = useRef<HTMLDivElement>(null)
  useModalFocus(open, panelRef)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!mounted) return null

  /* La touche de commande porte le nom qu'elle a sur la machine : afficher « Ctrl » à
     quelqu'un dont le clavier dit ⌘ revient à décrire un autre appareil. Nommée dans
     `format.ts`, parce que trois écrans l'affichent et que deux se trompaient. */
  const modifier = MODIFIER

  return (
    <div
      className={`modal ${closing ? 'is-closing' : ''}`}
      onMouseDown={() => setOpen(false)}
    >
      <div
        ref={panelRef}
        className="modal__panel shortcuts"
        role="dialog"
        aria-modal="true"
        aria-label={t('shortcuts.title')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <div>
            <strong>{t('shortcuts.title')}</strong>
            <span>{t('shortcuts.subtitle')}</span>
          </div>
          <button
            type="button"
            className="icon-btn-ghost"
            onClick={() => setOpen(false)}
            aria-label={t('settings.close')}
          >
            <IconClose />
          </button>
        </header>

        <div className="modal__body shortcuts__body">
          {GROUPS.map((group) => (
            <section key={group.title} className="shortcuts__group">
              <h3>{t(group.title)}</h3>
              {group.rows.map((row) => (
                <div className="shortcuts__row" key={`${group.title}:${row.label}:${row.keys[0]}`}>
                  <span className="shortcuts__keys">
                    {row.keys.map((key) => (
                      <kbd key={key}>
                        {row.translateKeys
                          ? t(key as TranslationKey)
                          : key === 'mod'
                            ? modifier
                            : key}
                      </kbd>
                    ))}
                  </span>
                  <span>{t(row.label)}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
