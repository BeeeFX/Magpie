import { useEffect, useRef, useState } from 'react'
import type { CollectionInfo } from '@shared/types'
import { magpie } from '../bridge'
import { notifyError } from '../notices'
import { useModalFocus } from '../useModalFocus'
import { useStore, useT } from '../store'
import { IconClose } from './Icons'

interface Props {
  collections: CollectionInfo[]
  onClose(): void
  /** Rejouer la liste : renommer, fusionner et supprimer la changent tous les trois. */
  onChanged(): void
  /** En train de partir : le parent nous garde montés le temps de l'animation de sortie. */
  closing?: boolean
}

/**
 * Le ménage des collections, depuis le panneau latéral.
 *
 * Renommer, fusionner, supprimer existaient déjà — mais seulement dans le rail de la carte
 * sémantique, c'est-à-dire derrière un mode d'affichage qu'on n'ouvre pas pour faire du
 * rangement. Le panneau latéral, lui, montre les collections tout le temps et ne savait que
 * filtrer et recolorer.
 *
 * Une liste, et non un menu par ligne : ces trois gestes se pensent en regardant l'ensemble.
 * On fusionne parce qu'on voit deux noms qui disent la même chose, on supprime parce qu'on voit
 * une collection à trois posts. Un menu contextuel les aurait cachés un par un.
 *
 * Le contenu, lui, ne se règle pas ici : les mots qui définissent une collection et son ampleur
 * vivent sur la carte, là où l'on voit ce qu'ils attrapent. Ici on ne touche qu'à ce qui se lit
 * dans une liste — un nom, une existence.
 */
export function CollectionsManager({
  collections,
  onClose,
  onChanged,
  closing = false
}: Props): React.JSX.Element {
  const t = useT()
  const refresh = useStore((state) => state.refresh)
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [confirming, setConfirming] = useState<number | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  /* Le piège de tabulation, l'entrée du focus et son retour vivent dans `useModalFocus`.
     Cette fenêtre se déclarait `aria-modal` sans l'appeler : Tab sortait dans la grille
     masquée derrière, et le focus ne revenait jamais d'où il venait. */
  useModalFocus(true, panelRef)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  /* Après chaque geste : la liste du panneau **et** la grille. Supprimer une collection sur
     laquelle on filtrait laisserait sinon une mosaïque vide sans rien dire pourquoi. */
  const settle = async (): Promise<void> => {
    onChanged()
    await refresh()
  }

  const rename = async (collection: CollectionInfo): Promise<void> => {
    const name = (drafts[collection.id] ?? collection.name).trim()
    setDrafts(({ [collection.id]: _, ...rest }) => rest)
    if (!name || name === collection.name) return
    setBusy(collection.id)
    try {
      await magpie.renameCollection(collection.id, name)
      await settle()
    } catch (error) {
      notifyError('notice.collectionRenameFailed', error)
    } finally {
      setBusy(null)
    }
  }

  const merge = async (from: number, into: number): Promise<void> => {
    setBusy(from)
    try {
      await magpie.mergeCollections(from, into)
      await settle()
    } catch (error) {
      notifyError('notice.collectionMergeFailed', error)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (id: number): Promise<void> => {
    setBusy(id)
    try {
      await magpie.deleteCollection(id)
      setConfirming(null)
      await settle()
    } catch (error) {
      notifyError('notice.collectionDeleteFailed', error)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className={`modal collections-manager ${closing ? 'is-closing' : ''}`}
      onMouseDown={onClose}
    >
      <div
        ref={panelRef}
        className="modal__panel collections-manager__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collections-manager-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <div>
            <h2 id="collections-manager-title">{t('collections.manageTitle')}</h2>
            <p>{t('collections.manageText')}</p>
          </div>
          <button type="button" className="icon-btn-ghost" onClick={onClose} aria-label={t('settings.close')}>
            <IconClose />
          </button>
        </header>

        <div className="modal__body">
          {collections.length === 0 ? (
            <p className="sidebar__empty">{t('sidebar.noneYet')}</p>
          ) : (
            <ul className="manager__list">
              {collections.map((collection) => (
                <li key={collection.id} className="manager__row">
                  <input
                    className="manager__name"
                    value={drafts[collection.id] ?? collection.name}
                    maxLength={120}
                    disabled={busy === collection.id}
                    aria-label={t('collections.rename')}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [collection.id]: event.target.value }))
                    }
                    onBlur={() => void rename(collection)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                      if (event.key === 'Escape') {
                        setDrafts(({ [collection.id]: _, ...rest }) => rest)
                        event.currentTarget.blur()
                      }
                    }}
                  />

                  {/* Ce qui explique qu'une collection cesse de se remplir : celles qui portent
                      une définition se recalculent, les listes gardées ne bougent plus. */}
                  <span
                    className={`manager__kind ${collection.kind === 'query' ? 'is-defined' : ''}`}
                    title={t(collection.kind === 'query' ? 'collections.definedHint' : 'collections.frozenHint')}
                  >
                    {t(collection.kind === 'query' ? 'collections.defined' : 'collections.frozen')}
                  </span>

                  <span className="manager__count">{collection.count}</span>

                  <select
                    className="manager__merge"
                    value=""
                    disabled={busy !== null || collections.length < 2}
                    aria-label={t('collections.mergeInto')}
                    onChange={(event) => {
                      const into = Number(event.target.value)
                      if (into) void merge(collection.id, into)
                    }}
                  >
                    <option value="">{t('collections.mergeInto')}</option>
                    {collections
                      .filter((other) => other.id !== collection.id)
                      .map((other) => (
                        <option key={other.id} value={other.id}>
                          {other.name}
                        </option>
                      ))}
                  </select>

                  {confirming === collection.id ? (
                    <span className="manager__confirm">
                      <button
                        type="button"
                        className="btn btn--danger"
                        disabled={busy === collection.id}
                        onClick={() => void remove(collection.id)}
                      >
                        {t('collections.deleteYes')}
                      </button>
                      <button type="button" className="btn" onClick={() => setConfirming(null)}>
                        {t('organizer.cancel')}
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn manager__delete"
                      disabled={busy !== null}
                      onClick={() => setConfirming(collection.id)}
                    >
                      {t('collections.delete')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
