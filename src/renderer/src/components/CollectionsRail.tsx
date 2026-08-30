import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LABELS, type CollectionHeat, type CollectionInfo } from '@shared/types'
import { magpie } from '../bridge'
import { SWATCH } from '../collection-colours'
import { notifyError, reportFailure } from '../notices'
import { useT } from '../store'
import { IconClose } from './Icons'

/**
 * Les collections, à côté de la carte.
 *
 * Une collection est **un nom, des mots, une ampleur** — trois choses distinctes, et c'est le
 * point. Le nom se lit ; les mots choisissent ; l'ampleur dit jusqu'où. Confondre le nom et la
 * définition faisait qu'une faute d'orthographe déplaçait mille posts.
 *
 * Les mots comptent en **union pondérée** : le score d'un post est le meilleur de ses
 * `poids × ressemblance`, pas leur moyenne. C'est ainsi qu'on pense une catégorie — ajouter
 * « ableton » à « production musicale » doit faire *entrer* les posts Ableton, pas déplacer tout
 * le thème vers eux.
 *
 * Rien ne se sélectionne sur la carte. La carte montre, elle ne saisit pas : on lit la chaleur,
 * on corrige les mots, on rejoue. Peindre ou lasso-sélectionner des points revenait à éditer
 * dans l'ombre que la projection donne du sens, alors que les mots éditent le sens lui-même.
 */

interface Props {
  /** Ce que la carte doit peindre, ou rien. */
  onHeat(
    heat: {
      token: string
      degrees: Map<string, number>
      reach: number
      only: boolean
    } | null
  ): void
}

/**
 * Les bornes de l'ampleur : un nombre de posts, sur une échelle logarithmique.
 *
 * Un nombre et non une confiance, parce que le calcul ne sait pas mesurer une confiance —
 * mesuré, une phrase étrangère à la bibliothèque note aussi haut qu'une phrase centrale. Ce que
 * le classement sait faire, c'est ordonner ; c'est donc à l'œil de dire où s'arrêter, et la
 * carte est là pour que cet œil voie.
 *
 * Logarithmique parce que l'écart entre 30 et 60 posts compte autant que celui entre 1 000 et
 * 2 000 : linéaire, les trois premiers centimètres du curseur auraient porté tout l'intérêt.
 */
const SIZE_MIN = 20
const SIZE_MAX = 4000
/* Borné à [0, 1] : l'ampleur ne vaut plus trois cents pour tout le monde depuis qu'elle vient
   de l'effectif réel du groupe, et une collection plus large que SIZE_MAX poussait la poignée
   hors de sa glissière. La valeur rangée, elle, garde ses propres bornes côté base. */
const toSlider = (size: number): number =>
  Math.min(1, Math.max(0, Math.log(size / SIZE_MIN) / Math.log(SIZE_MAX / SIZE_MIN)))
const fromSlider = (value: number): number =>
  Math.round(SIZE_MIN * (SIZE_MAX / SIZE_MIN) ** value)

interface Word {
  word: string
  weight: number
}

export function CollectionsRail({ onHeat }: Props): React.JSX.Element {
  const t = useT()
  const [collections, setCollections] = useState<CollectionInfo[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [heat, setHeatState] = useState<CollectionHeat | null>(null)
  const [words, setWords] = useState<Word[]>([])
  const [size, setSize] = useState(300)
  const [only, setOnly] = useState(false)
  const [draft, setDraft] = useState('')
  const [wordDraft, setWordDraft] = useState('')
  const [renameDraft, setRenameDraft] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [merging, setMerging] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  /**
   * Le rail est replié au départ.
   *
   * Il occupait le quart de la carte en permanence, pour un écran où l'on vient surtout
   * *regarder*. Une poignée verticale suffit à dire qu'il est là, et la carte reprend sa
   * place. Une fois ouvert il le reste — on n'édite pas une collection en trois secondes.
   */
  const [open, setOpen] = useState(false)
  const commitRef = useRef<number | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setCollections(await magpie.listCollections())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** Les degrés en table, pour que la carte n'ait pas à chercher dans un tableau de neuf mille. */
  const degrees = useMemo(() => {
    if (!heat) return null
    const out = new Map<string, number>()
    heat.postIds.forEach((id, at) => out.set(id, heat.degrees[at]))
    return out
  }, [heat])

  /**
   * Les degrés triés, une fois, pour trouver la coupe à l'image.
   *
   * C'est ce qui rend le curseur instantané : garder les N premiers demande de savoir quel score
   * occupe la N-ième place, et c'est une lecture dans un tableau déjà trié — pas un aller-retour
   * vers le processus principal, encore moins un recalcul de neuf mille scores par cran.
   */
  const ranked = useMemo(() => {
    if (!heat) return null
    return Float64Array.from(heat.degrees)
      .filter((value) => value > -8)
      .sort((a, b) => b - a)
  }, [heat])

  const cut = useMemo(() => {
    if (!ranked || ranked.length === 0) return Number.POSITIVE_INFINITY
    return ranked[Math.max(0, Math.min(ranked.length - 1, size - 1))]
  }, [ranked, size])

  useEffect(() => {
    if (!degrees || selected === null) {
      onHeat(null)
      return
    }
    onHeat({ token: `${selected}:${size}:${only ? 'only' : 'all'}`, degrees, reach: cut, only })
  }, [degrees, cut, size, only, selected, onHeat])

  const count = useMemo(() => {
    if (!ranked) return null
    return Math.min(size, ranked.length)
  }, [ranked, size])

  const choose = useCallback(async (id: number | null): Promise<void> => {
    setSelected(id)
    setRenameDraft(null)
    setConfirmDelete(false)
    setMerging(false)
    setWordDraft('')
    if (id === null) {
      setHeatState(null)
      setWords([])
      return
    }
    setBusy('heat')
    try {
      const [next, keywords] = await Promise.all([
        magpie.collectionHeat(id),
        magpie.collectionKeywords(id)
      ])
      setHeatState(next)
      setWords(keywords)
      if (next) setSize(next.size)
    } finally {
      setBusy(null)
    }
  }, [])

  /* L'ampleur n'est rangée qu'au repos. Un `UPDATE` plus un recalcul complet par cran de
     curseur, c'est neuf mille scores et une réécriture de table soixante fois par seconde. */
  const commitSize = useCallback(
    (id: number, value: number): void => {
      if (commitRef.current) window.clearTimeout(commitRef.current)
      commitRef.current = window.setTimeout(() => {
        void magpie
          .setCollectionSize(id, value)
          .then(() => void refresh())
          .catch(reportFailure('notice.collectionFailed'))
      }, 260)
    },
    [refresh]
  )

  const addWord = useCallback(async (): Promise<void> => {
    const word = wordDraft.trim()
    if (!word || selected === null) return
    setBusy('word')
    try {
      const next = await magpie.addCollectionKeyword(selected, word)
      setWordDraft('')
      setHeatState(next)
      setWords(await magpie.collectionKeywords(selected))
      await refresh()
    } catch (error) {
      notifyError('notice.collectionFailed', error)
    } finally {
      setBusy(null)
    }
  }, [wordDraft, selected, refresh])

  /* Le poids ne demande aucun encodage : seul un facteur change, donc on peut le glisser. */
  const weigh = useCallback(
    (word: string, weight: number): void => {
      if (selected === null) return
      setWords((current) => current.map((w) => (w.word === word ? { ...w, weight } : w)))
      if (commitRef.current) window.clearTimeout(commitRef.current)
      commitRef.current = window.setTimeout(() => {
        void magpie
          .setCollectionKeywordWeight(selected, word, weight)
          .then((next) => {
            setHeatState(next)
            return refresh()
          })
          .catch(reportFailure('notice.collectionFailed'))
      }, 220)
    },
    [selected, refresh]
  )

  const dropWord = useCallback(
    async (word: string): Promise<void> => {
      if (selected === null) return
      setBusy('word')
      try {
        setHeatState(await magpie.removeCollectionKeyword(selected, word))
        setWords(await magpie.collectionKeywords(selected))
        await refresh()
      } catch (error) {
        notifyError('notice.collectionFailed', error)
      } finally {
        setBusy(null)
      }
    },
    [selected, refresh]
  )

  const create = useCallback(async (): Promise<void> => {
    const phrase = draft.trim()
    if (!phrase) return
    setBusy('create')
    try {
      const id = await magpie.createCollectionFromPhrase(phrase)
      setDraft('')
      await refresh()
      await choose(id)
    } catch (error) {
      notifyError('notice.collectionCreateFailed', error)
    } finally {
      setBusy(null)
    }
  }, [draft, refresh, choose])

  const seed = useCallback(async (): Promise<void> => {
    setBusy('seed')
    try {
      await magpie.seedCollectionsFromTopics()
      await refresh()
    } catch (error) {
      notifyError('notice.collectionCreateFailed', error)
    } finally {
      setBusy(null)
    }
  }, [refresh])

  const selectedInfo = collections.find((entry) => entry.id === selected) ?? null

  return (
    <div className={`rail-dock${open ? ' is-open' : ''}`}>
    <aside className="rail" aria-label={t('collections.title')} aria-hidden={!open}>
      <header className="rail__head">
        <h2>{t('collections.title')}</h2>
        {selected !== null ? (
          <button
            type="button"
            className="icon-btn"
            onClick={() => void choose(null)}
            aria-label={t('collections.unselect')}
          >
            <IconClose />
          </button>
        ) : null}
      </header>

      <form
        className="rail__new"
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <input
          value={draft}
          placeholder={t('collections.describe')}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="rail__add" disabled={!draft.trim() || busy !== null}>
          +
        </button>
      </form>

      {collections.length === 0 ? (
        <div className="rail__empty">
          <p>{t('collections.emptyText')}</p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void seed()}
            disabled={busy !== null}
          >
            {busy === 'seed' ? t('collections.seeding') : t('collections.seed')}
          </button>
        </div>
      ) : null}

      <ul className="rail__list">
        {collections.map((collection) => {
          const open = collection.id === selected
          return (
            <li key={collection.id} className={open ? 'is-open' : ''}>
              <button
                type="button"
                className="rail__chip"
                onClick={() => void choose(open ? null : collection.id)}
              >
                <span
                  className="rail__dot"
                  style={{ background: SWATCH[collection.color ?? 'grey'] }}
                />
                <span className="rail__name">{collection.name}</span>
                <span className="rail__count">
                  {open && count !== null ? count : collection.count}
                </span>
              </button>

              {open ? (
                <div className="rail__body">
                  {/* Les mots. Chacun avec son poids : un mot fort attire, un mot faible
                      complète, et retirer un mot ne déforme pas les autres. */}
                  <ul className="rail__words">
                    {words.map((entry) => (
                      <li key={entry.word}>
                        <span className="rail__word">{entry.word}</span>
                        <input
                          type="range"
                          min={0}
                          max={2}
                          step={0.1}
                          value={entry.weight}
                          aria-label={t('collections.weightOf', { word: entry.word })}
                          onChange={(event) => weigh(entry.word, Number(event.target.value))}
                        />
                        <button
                          type="button"
                          className="rail__drop"
                          onClick={() => void dropWord(entry.word)}
                          aria-label={t('collections.removeWord')}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>

                  <form
                    className="rail__new rail__new--word"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void addWord()
                    }}
                  >
                    <input
                      value={wordDraft}
                      placeholder={t('collections.addWord')}
                      onChange={(event) => setWordDraft(event.target.value)}
                    />
                    <button
                      type="submit"
                      className="rail__add rail__add--small"
                      disabled={!wordDraft.trim() || busy !== null}
                    >
                      +
                    </button>
                  </form>

                  {/* L'ampleur. Deux mots aux extrémités plutôt qu'un nombre : « 1,8 écart-type »
                      ne veut rien dire, « évident → large » se comprend sans notice. */}
                  <label className="rail__reach">
                    <span>{t('collections.reachNarrow')}</span>
                    <input
                      type="range"
                      aria-label={t('collections.reach')}
                      min={0}
                      max={1}
                      step={0.005}
                      value={toSlider(size)}
                      disabled={!heat}
                      onChange={(event) => {
                        const value = fromSlider(Number(event.target.value))
                        setSize(value)
                        commitSize(collection.id, value)
                      }}
                    />
                    <span>{t('collections.reachWide')}</span>
                  </label>

                  {/* Ne montrer que la collection. Moins de contexte, mais on voit enfin sa forme
                      — et c'est aussi moins cher à peindre, puisque la toile disparaît avec. */}
                  <label className="rail__toggle">
                    <input
                      type="checkbox"
                      checked={only}
                      onChange={(event) => setOnly(event.target.checked)}
                    />
                    <span>{t('collections.onlyThis')}</span>
                  </label>

                  {/* Les teintes. Celle de la collection sert partout ailleurs dans
                      l'application, donc la choisir ici la choisit pour de bon. */}
                  <div className="rail__swatches">
                    {LABELS.map((colour) => (
                      <button
                        key={colour}
                        type="button"
                        className={`rail__swatch${
                          (collection.color ?? 'grey') === colour ? ' is-active' : ''
                        }`}
                        style={{ background: SWATCH[colour] }}
                        aria-label={colour}
                        onClick={() => {
                          void magpie
                            .setCollectionColor(collection.id, colour)
                            .then(refresh)
                            .catch(reportFailure('notice.collectionColourFailed'))
                        }}
                      />
                    ))}
                  </div>

                  <div className="rail__actions">
                    {renameDraft === null ? (
                      <button type="button" onClick={() => setRenameDraft(collection.name)}>
                        {t('collections.rename')}
                      </button>
                    ) : null}
                    <button type="button" onClick={() => setMerging((current) => !current)}>
                      {t('collections.merge')}
                    </button>
                    <button
                      type="button"
                      className="rail__danger"
                      onClick={() => setConfirmDelete(true)}
                    >
                      {t('collections.delete')}
                    </button>
                  </div>

                  {renameDraft !== null ? (
                    <form
                      className="rail__new rail__new--word"
                      onSubmit={(event) => {
                        event.preventDefault()
                        const name = renameDraft.trim()
                        setRenameDraft(null)
                        if (!name) return
                        void magpie
                            .renameCollection(collection.id, name)
                            .then(refresh)
                            .catch(reportFailure('notice.collectionRenameFailed'))
                      }}
                    >
                      <input
                        autoFocus
                        value={renameDraft}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') setRenameDraft(null)
                        }}
                      />
                      <button type="submit" className="rail__add rail__add--small">
                        ✓
                      </button>
                    </form>
                  ) : null}

                  {/* Fondre dans une autre. Les mots se réunissent en gardant le poids le plus
                      fort de chaque côté : deux collections qui disaient la même chose ne
                      doivent pas s'affaiblir l'une l'autre. */}
                  {merging ? (
                    <select
                      className="rail__select"
                      defaultValue=""
                      onChange={(event) => {
                        const into = Number(event.target.value)
                        if (!into) return
                        setMerging(false)
                        void magpie
                          .mergeCollections(collection.id, into)
                          .then(async () => {
                            await refresh()
                            await choose(into)
                          })
                          .catch(reportFailure('notice.collectionMergeFailed'))
                      }}
                    >
                      <option value="">{t('collections.mergeInto')}</option>
                      {collections
                        .filter((entry) => entry.id !== collection.id)
                        .map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.name}
                          </option>
                        ))}
                    </select>
                  ) : null}

                  {confirmDelete ? (
                    <p className="rail__confirm">
                      <span>{t('collections.deleteSure', { name: selectedInfo?.name ?? '' })}</span>
                      <button
                        type="button"
                        className="rail__danger"
                        onClick={() => {
                          void magpie
                            .deleteCollection(collection.id)
                            .then(async () => {
                              await choose(null)
                              await refresh()
                            })
                            .catch(reportFailure('notice.collectionDeleteFailed'))
                        }}
                      >
                        {t('collections.deleteYes')}
                      </button>
                      <button type="button" onClick={() => setConfirmDelete(false)}>
                        {t('organizer.cancel')}
                      </button>
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </aside>
      {/* La poignée. Après le rail dans le DOM, donc à sa droite : replier translate l'ensemble
          vers la gauche de la largeur du rail, et c'est la poignée qui vient se poser au bord.
          Une seule transformation, rien à réagencer — et la carte, qui n'est pas dans ce
          conteneur, ne bouge pas d'un pixel. */}
      <button
        type="button"
        className="rail-dock__handle"
        aria-expanded={open}
        aria-label={t(open ? 'collections.hide' : 'collections.show')}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="rail-dock__label">{t('collections.title')}</span>
        {collections.length > 0 ? (
          <span className="rail-dock__badge">{collections.length}</span>
        ) : null}
      </button>
    </div>
  )
}
