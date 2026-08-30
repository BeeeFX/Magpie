import { useEffect, useRef, useState } from 'react'
import type { CollectionInfo, PostKind, SortKey } from '@shared/types'
import type { TranslationKey } from '../i18n'
import { notifyError, notifyInfo, notifySuccess, reportFailure } from '../notices'
import { DENSITY_MAX, DENSITY_MIN, useStore, useT } from '../store'
import { Popover } from './Popover'
import { OrganizeButton } from './OrganizeButton'
import { SyncButton } from './SyncButton'
import { Downloads } from './Downloads'
import { magpie } from '../bridge'
import {
  IconCards,
  IconMap,
  IconCheck,
  IconFilter,
  IconMasonry,
  IconPanel,
  IconSearch,
  IconSort,
  IconVolume
} from './Icons'

const SORTS: { key: SortKey; label: TranslationKey }[] = [
  { key: 'saved', label: 'sort.saved' },
  { key: 'published', label: 'sort.published' },
  { key: 'author', label: 'sort.author' },
  { key: 'platform', label: 'sort.platform' },
  { key: 'random', label: 'sort.random' }
]

const KINDS: { key: PostKind; label: TranslationKey }[] = [
  { key: 'image', label: 'kind.image' },
  { key: 'carousel', label: 'kind.carousel' },
  { key: 'video', label: 'kind.video' },
  { key: 'text', label: 'kind.text' },
  { key: 'link', label: 'kind.link' }
]

export function Toolbar(): React.JSX.Element {
  const t = useT()
  const query = useStore((s) => s.query)
  const setQuery = useStore((s) => s.setQuery)
  const setSort = useStore((s) => s.setSort)
  const mode = useStore((s) => s.gridMode)
  const setGridMode = useStore((s) => s.setGridMode)
  const density = useStore((s) => s.density)
  const setDensity = useStore((s) => s.setDensity)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const hoverAudio = useStore((s) => s.hoverAudio)
  const setHoverAudio = useStore((s) => s.setHoverAudio)
  const selectionMode = useStore((s) => s.selectionMode)
  const selectedIds = useStore((s) => s.selectedIds)
  const setSelectionMode = useStore((s) => s.setSelectionMode)
  const selectAllVisible = useStore((s) => s.selectAllVisible)
  const clearSelection = useStore((s) => s.clearSelection)
  const favoriteSelection = useStore((s) => s.favoriteSelection)
  const tagSelection = useStore((s) => s.tagSelection)

  const [search, setSearch] = useState(query.search)
  /** Quel formulaire de la barre de sélection est ouvert, s'il y en a un. */
  const [bulkForm, setBulkForm] = useState<'tag' | 'collection' | null>(null)
  const [bulkDraft, setBulkDraft] = useState('')
  const [bulkCollections, setBulkCollections] = useState<CollectionInfo[]>([])

  /* Chargée seulement quand le formulaire s'ouvre : la barre de sélection ne doit pas
     interroger le processus principal tant que personne ne lui demande rien. */
  useEffect(() => {
    if (bulkForm !== 'collection') return
    void magpie.listCollections().then(setBulkCollections).catch(reportFailure('notice.collectionFailed'))
  }, [bulkForm])
  const inputRef = useRef<HTMLInputElement>(null)

  /* Ctrl/⌘+K place le curseur dans la recherche depuis n'importe où. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* Recherche au fil de la frappe, mais une requête seulement quand la frappe s'arrête. */
  useEffect(() => {
    if (search === query.search) return
    const id = setTimeout(() => setQuery({ search }), 220)
    return () => clearTimeout(id)
  }, [search, query.search, setQuery])

  const toggleKind = (kind: PostKind): void => {
    const active = query.kinds.includes(kind)
    setQuery({ kinds: active ? query.kinds.filter((k) => k !== kind) : [...query.kinds, kind] })
  }

  const activeFilters = query.kinds.length + (query.untaggedOnly ? 1 : 0)
  const sortKey = SORTS.find((s) => s.key === query.sort)?.label

  /**
   * Ranger la sélection dans une collection.
   *
   * Le nom se saisissait dans un `window.prompt` — qu'Electron n'implémente pas. Le retour
   * était `null`, aucune boîte n'apparaissait, et le `if (!name) return` juste dessous avalait
   * le cas : le bouton ne faisait **rien**, et l'échec était indiscernable d'un clic manqué.
   * Seul l'aperçu navigateur, où `prompt` existe, pouvait donner l'illusion qu'il marchait.
   *
   * La question de doublon posait le même problème à l'envers : elle arrive *après* une
   * réponse, donc aucun bouton ne peut la porter d'avance. Elle devient une notification avec
   * action.
   */
  const addSelectionToCollection = async (name: string): Promise<void> => {
    setBulkForm(null)
    try {
      const collections = await magpie.listCollections()
      const collection =
        collections.find((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase()) ??
        (await magpie.createCollection(name))
      const result = await magpie.addToCollection(collection.id, selectedIds)
      if (result.alreadyThere.length === 0) {
        notifySuccess('bulk.addedTo', { count: result.added, name: collection.name })
        return
      }
      notifyInfo(
        'bulk.duplicates',
        { count: result.alreadyThere.length },
        {
          key: 'bulk.readd',
          run: () => {
            void magpie
              .addToCollection(collection.id, result.alreadyThere, true)
              .catch(reportFailure('notice.collectionFailed'))
          }
        }
      )
    } catch (error) {
      notifyError('notice.collectionFailed', error)
    }
  }

  const copySelection = (): void => {
    /* Lu au clic, pas par abonnement. S'abonner à `posts` pour ce seul gestionnaire rendait
       toute la barre — synchronisation, téléchargements, les deux menus, le curseur de
       densité — à chaque reconstruction du tableau, soit plusieurs fois par seconde pendant
       un import, pour une valeur qu'aucun rendu ne lit. */
    const posts = useStore.getState().posts
    const selected = new Set(selectedIds)
    void magpie
      .copyToClipboard(
        posts.filter((post) => selected.has(post.id)).map((post) => post.url).join('\n')
      )
      .then(() => notifySuccess('bulk.copied', { count: selected.size }))
      .catch(reportFailure('notice.copyFailed'))
  }

  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-btn-ghost"
        onClick={toggleSidebar}
        title={`${t('toolbar.togglePanel', {
          action: t(sidebarOpen ? 'toolbar.hide' : 'toolbar.show')
        })}  ·  Ctrl+B`}
      >
        <IconPanel />
      </button>

      <label className="search">
        <span className="search__icon">
          <IconSearch />
        </span>
        <input
          ref={inputRef}
          type="search"
          value={search}
          placeholder={t('toolbar.search')}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="search__kbd">
          <kbd>Ctrl</kbd>
          <kbd>K</kbd>
        </span>
      </label>

      <div className="topbar__actions">
        <button
          type="button"
          className={`control control--compact ${selectionMode ? 'is-active' : ''}`}
          onClick={() => setSelectionMode(!selectionMode)}
          title={t('bulk.select')}
        >
          <IconCheck />
          <span>{t('bulk.select')}</span>
        </button>
        <SyncButton />
        <OrganizeButton />
        {/* Un seul bouton pour demander un préchargement et pour voir où il en est. */}
        <Downloads />
        <div className="divider" />

        <Popover
          label={
            <>
              <IconFilter />
              <span>{t('toolbar.filters')}</span>
            </>
          }
          badge={activeFilters}
          title={t('toolbar.filterByType')}
          compact
        >
          {() => (
            <>
              <h3 className="popover__title">{t('toolbar.contentType')}</h3>
              {KINDS.map((k) => (
                <button key={k.key} type="button" className="menu-item" onClick={() => toggleKind(k.key)}>
                  <span className="menu-item__mark">
                    {query.kinds.includes(k.key) ? <IconCheck size={14} /> : null}
                  </span>
                  {t(k.label)}
                </button>
              ))}
              <div className="popover__sep" />
              <button
                type="button"
                className="menu-item"
                onClick={() =>
                  setQuery({
                    untaggedOnly: !query.untaggedOnly,
                    tags: []
                  })
                }
              >
                <span className="menu-item__mark">
                  {query.untaggedOnly ? <IconCheck size={14} /> : null}
                </span>
                {t('sidebar.untagged')}
              </button>
            </>
          )}
        </Popover>

        <Popover
          label={
            <>
              <IconSort />
              <span>{sortKey ? t(sortKey) : ''}</span>
            </>
          }
          title={t('toolbar.sort')}
          compact
        >
          {(close) => (
            <>
              <h3 className="popover__title">{t('toolbar.sortBy')}</h3>
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    setSort(s.key)
                    close()
                  }}
                >
                  <span className="menu-item__mark">
                    {query.sort === s.key ? <IconCheck size={14} /> : null}
                  </span>
                  {t(s.label)}
                </button>
              ))}
            </>
          )}
        </Popover>

        <div className="divider" />

        {/* Son des aperçus au survol. Coupé par défaut, et l'état se lit sans survoler
            grâce à la barre oblique. */}
        <button
          type="button"
          className={`icon-btn-ghost ${hoverAudio ? 'is-active' : ''}`}
          onClick={() => setHoverAudio(!hoverAudio)}
          title={t(hoverAudio ? 'toolbar.hoverAudioOn' : 'toolbar.hoverAudioOff')}
          aria-pressed={hoverAudio}
        >
          <IconVolume waves={hoverAudio} />
        </button>

        <label className="density" title={t('toolbar.density')}>
          <span className="density__cap density__cap--lg" />
          <input
            type="range"
            min={DENSITY_MIN}
            max={DENSITY_MAX}
            step={10}
            /* Inversé : glisser vers la droite densifie, ce qui est le sens attendu. */
            value={DENSITY_MAX + DENSITY_MIN - density}
            onChange={(e) => setDensity(DENSITY_MAX + DENSITY_MIN - Number(e.target.value))}
          />
          <span className="density__cap density__cap--sm" />
        </label>

        <div className="segmented" role="group" aria-label={t('toolbar.gridMode')}>
          <button
            type="button"
            className={mode === 'masonry' ? 'is-active' : ''}
            onClick={() => setGridMode('masonry')}
            title={t('toolbar.masonry')}
          >
            <IconMasonry />
          </button>
          <button
            type="button"
            className={mode === 'cards' ? 'is-active' : ''}
            onClick={() => setGridMode('cards')}
            title={t('toolbar.cards')}
          >
            <IconCards />
          </button>
          {/* La carte sémantique comme troisième façon de regarder : par ressemblance plutôt
              que par date. Sa place est ici, à côté des deux autres dispositions. */}
          <button
            type="button"
            className={mode === 'map' ? 'is-active' : ''}
            onClick={() => setGridMode('map')}
            title={t('toolbar.map')}
          >
            <IconMap size={16} />
          </button>
        </div>
      </div>

      {selectionMode ? (
        <div className="bulk-bar" role="toolbar" aria-label={t('bulk.actions')}>
          <strong>{t('bulk.count', { count: selectedIds.length })}</strong>
          <button type="button" className="btn" onClick={selectAllVisible}>
            {t('bulk.all')}
          </button>
          <button type="button" className="btn" onClick={clearSelection}>
            {t('bulk.none')}
          </button>
          <span className="divider" />
          <button
            type="button"
            className="btn"
            disabled={selectedIds.length === 0}
            onClick={() => void favoriteSelection()}
          >
            {t('bulk.favorite')}
          </button>
          <button
            type="button"
            className={`btn ${bulkForm === 'tag' ? 'is-active' : ''}`}
            disabled={selectedIds.length === 0}
            onClick={() => setBulkForm(bulkForm === 'tag' ? null : 'tag')}
          >
            {t('bulk.tag')}
          </button>
          <button
            type="button"
            className={`btn ${bulkForm === 'collection' ? 'is-active' : ''}`}
            disabled={selectedIds.length === 0}
            onClick={() => setBulkForm(bulkForm === 'collection' ? null : 'collection')}
          >
            {t('bulk.collection')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={selectedIds.length === 0}
            onClick={copySelection}
          >
            {t('bulk.copy')}
          </button>

          {/* La saisie se fait dans la barre, à côté du bouton qui l'a demandée, et non dans une
              boîte du système : c'est le formulaire en ligne déjà utilisé pour créer une
              collection depuis le panneau latéral. */}
          {bulkForm ? (
            <form
              className="collection-create collection-create--bulk"
              onSubmit={(event) => {
                event.preventDefault()
                const name = bulkDraft.trim()
                if (!name) return
                setBulkDraft('')
                if (bulkForm === 'tag') {
                  setBulkForm(null)
                  void tagSelection(name)
                } else void addSelectionToCollection(name)
              }}
            >
              <input
                autoFocus
                value={bulkDraft}
                maxLength={80}
                placeholder={t(bulkForm === 'tag' ? 'bulk.tagPrompt' : 'bulk.collectionPrompt')}
                aria-label={t(bulkForm === 'tag' ? 'bulk.tagPrompt' : 'bulk.collectionPrompt')}
                list={bulkForm === 'collection' ? 'bulk-collections' : undefined}
                onChange={(event) => setBulkDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setBulkForm(null)
                }}
              />
              {/* Les collections existantes se proposent : le nom se résolvait par comparaison
                  insensible à la casse, donc une frappe approximative en créait une seconde à
                  côté de celle qu'on visait. */}
              {bulkForm === 'collection' ? (
                <datalist id="bulk-collections">
                  {bulkCollections.map((collection) => (
                    <option key={collection.id} value={collection.name} />
                  ))}
                </datalist>
              ) : null}
              <button
                type="submit"
                className="collection-create__submit"
                disabled={!bulkDraft.trim()}
                aria-label={t('bulk.apply')}
                title={t('bulk.apply')}
              >
                <IconCheck size={13} />
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
    </header>
  )
}
