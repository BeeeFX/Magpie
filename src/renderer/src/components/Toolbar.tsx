import { useEffect, useRef, useState } from 'react'
import type { PostKind, SortKey } from '@shared/types'
import type { TranslationKey } from '../i18n'
import { DENSITY_MAX, DENSITY_MIN, useStore, useT } from '../store'
import { Popover } from './Popover'
import { SyncButton } from './SyncButton'
import { magpie } from '../bridge'
import {
  IconCards,
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
  const posts = useStore((s) => s.posts)

  const [search, setSearch] = useState(query.search)
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

  const addSelectionToCollection = async (): Promise<void> => {
    const name = window.prompt(t('bulk.collectionPrompt'))?.trim()
    if (!name) return
    const collections = await magpie.listCollections()
    const collection =
      collections.find((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase()) ??
      (await magpie.createCollection(name))
    const result = await magpie.addToCollection(collection.id, selectedIds)
    if (result.alreadyThere.length > 0) {
      const readd = window.confirm(t('bulk.duplicates', { count: result.alreadyThere.length }))
      if (readd) await magpie.addToCollection(collection.id, result.alreadyThere, true)
    }
  }

  const copySelection = (): void => {
    const selected = new Set(selectedIds)
    void magpie.copyToClipboard(posts.filter((post) => selected.has(post.id)).map((post) => post.url).join('\n'))
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
          className={`control ${selectionMode ? 'is-active' : ''}`}
          onClick={() => setSelectionMode(!selectionMode)}
        >
          <IconCheck />
          <span>{t('bulk.select')}</span>
        </button>
        <SyncButton />
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

        <div className="segmented" role="group" aria-label="Mode de grille">
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
        </div>
      </div>

      {/* Réservé aux boutons système dessinés par l'OS par-dessus notre barre. */}
      <div className="topbar__window-space" />

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
            className="btn"
            disabled={selectedIds.length === 0}
            onClick={() => {
              const name = window.prompt(t('bulk.tagPrompt'))
              if (name?.trim()) void tagSelection(name.trim())
            }}
          >
            {t('bulk.tag')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={selectedIds.length === 0}
            onClick={() => void addSelectionToCollection()}
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
        </div>
      ) : null}
    </header>
  )
}
