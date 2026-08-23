import { useEffect, useState } from 'react'
import type { CollectionInfo, LabelColor, Platform, PostKind } from '@shared/types'
import { LABELS, PUBLIC_PLATFORMS } from '@shared/types'
import { magpie } from '../bridge'
import { PLATFORM_LABEL } from '../format'
import type { TranslationKey } from '../i18n'
import { useStore, useT } from '../store'
import { LabelPicker } from './LabelPicker'
import { Logo } from './Logo'
import { PlatformIcon } from './PlatformIcon'
import {
  IconCheck,
  IconCollections,
  IconGrid,
  IconHeart,
  IconImage,
  IconLink,
  IconPlus,
  IconSettings,
  IconStar,
  IconTag,
  IconVideo
} from './Icons'

/** Nombre de tags visibles au repos. Au-delà, la liste devient du bruit plus qu'un repère. */
const TAGS_COLLAPSED = 8

const KIND_FILTERS: { kind: PostKind; label: TranslationKey; icon: React.JSX.Element }[] = [
  { kind: 'link', label: 'sidebar.links', icon: <IconLink /> },
  { kind: 'video', label: 'sidebar.videos', icon: <IconVideo /> },
  { kind: 'image', label: 'sidebar.images', icon: <IconImage /> }
]

export function Sidebar(): React.JSX.Element {
  const t = useT()
  const stats = useStore((s) => s.stats)
  const query = useStore((s) => s.query)
  const setQuery = useStore((s) => s.setQuery)
  const resetQuery = useStore((s) => s.resetQuery)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const contentSources = useStore((s) => s.contentSources)

  const [showAllTags, setShowAllTags] = useState(false)
  const [collections, setCollections] = useState<CollectionInfo[]>([])
  const [creatingCollection, setCreatingCollection] = useState(false)
  const [collectionDraft, setCollectionDraft] = useState('')

  /* Accroché aux statistiques, pas au tableau des posts.

     Ce panneau ne lit `posts` nulle part : il ne s'y abonnait que pour savoir quand
     redemander les collections. Or `refreshPosts` reconstruit ce tableau toutes les trois
     cents millisecondes pendant une synchronisation, et une nouvelle identité suffisait à
     relancer un aller-retour vers le processus principal — `listCollections` joignant et
        regroupant toute la table `collection_posts` — plus un rendu complet du panneau,
     plusieurs fois par seconde, pendant tout un import. Les statistiques changent quand le
     contenu change, et elles sont déjà regroupées à 150 ms. */
  useEffect(() => {
    void magpie.listCollections().then(setCollections)
  }, [stats])

  const togglePlatform = (platform: Platform): void => {
    const active = query.platforms.includes(platform)
    setQuery({
      platforms: active
        ? query.platforms.filter((p) => p !== platform)
        : [...query.platforms, platform]
    })
  }

  const toggleKind = (kind: PostKind): void => {
    const only = query.kinds.length === 1 && query.kinds[0] === kind
    setQuery({ kinds: only ? [] : [kind] })
  }

  /**
   * Les catégories sont exclusives entre elles, mais indépendantes des filtres.
   * Changer de catégorie conserve donc plateforme, type, couleur, « sans tag »,
   * recherche et tri, au lieu de reconstruire toute la requête.
   */
  const selectCategory = (
    patch: Partial<Pick<typeof query, 'sources' | 'favoritesOnly' | 'tags' | 'collectionIds'>> = {}
  ): void => {
    setQuery({
      sources: [],
      favoritesOnly: false,
      tags: [],
      collectionIds: [],
      // Â« Tous les tags Â» et Â« Sans tag Â» ne peuvent pas être vrais ensemble.
      ...(patch.tags?.length ? { untaggedOnly: false } : {}),
      ...patch
    })
  }

  const tags = stats?.topTags ?? []
  const shown = showAllTags ? tags : tags.slice(0, TAGS_COLLAPSED)
  const allTagsSelected =
    tags.length > 0 && tags.every((tag) => query.tags.includes(tag.name))
  const allCollectionsSelected =
    collections.length > 0 &&
    collections.every((collection) => query.collectionIds.includes(collection.id))

  const toggleTag = (name: string): void => {
    const active = query.tags.includes(name)
    selectCategory({
      tags: active ? query.tags.filter((tag) => tag !== name) : [...query.tags, name]
    })
  }

  const toggleCollection = (id: number): void => {
    const active = query.collectionIds.includes(id)
    selectCategory({
      collectionIds: active
        ? query.collectionIds.filter((collectionId) => collectionId !== id)
        : [...query.collectionIds, id]
    })
  }
  const isAll =
    query.sources.length === 0 &&
    !query.favoritesOnly &&
    query.tags.length === 0 &&
    query.collectionIds.length === 0

  /** Teintes réellement utilisées : une palette de sept cases vides serait du bruit. */
  const labelledColors = LABELS.filter((color) => (stats?.byLabel[color] ?? 0) > 0)

  const recolour = async (id: number, color: LabelColor | null): Promise<void> => {
    await magpie.setCollectionColor(id, color)
    setCollections(await magpie.listCollections())
  }

  const createCollection = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const name = collectionDraft.trim()
    if (!name) return
    await magpie.createCollection(name)
    setCollections(await magpie.listCollections())
    setCollectionDraft('')
    setCreatingCollection(false)
  }

  const savedCount = stats?.bySource.saved ?? 0
  const likedCount = stats?.bySource.liked ?? 0
  /** On masque une provenance vide, sauf si les deux le sont — bibliothèque encore neuve. */
  const showSaved = savedCount > 0 || likedCount === 0
  const showLiked = likedCount > 0 || savedCount === 0

  return (
    <aside className="sidebar">
      {/* Zone de glissement de la fenêtre ; sous macOS les pastilles système s'y posent. */}
      <div className="sidebar__head">
        <div className="brand">
          <Logo size={22} />
          <span className="brand__name">{t('app.name')}</span>
        </div>
      </div>

      {/* Une provenance qu'on n'utilise pas n'a pas à occuper une ligne : « Favoris » à zéro,
          chez quelqu'un qui n'a jamais synchronisé ses likes, ne fait qu'ajouter du vide à
          lire. On la garde tant que l'autre est vide aussi — sur une bibliothèque neuve, tout
          est à zéro et masquer les deux laisserait une barre latérale amputée sans raison. */}
      <nav className="sidebar__nav">
        <div className="sidebar__group">
          <button type="button" className={`row ${isAll ? 'is-active' : ''}`} onClick={resetQuery}>
            <IconGrid />
            <span className="row__label">{t('sidebar.all')}</span>
            <span className="row__count">{stats?.total ?? 0}</span>
          </button>

          {contentSources.includes('saved') && showSaved ? (
              <button
                type="button"
                className={`row ${query.sources.length === 1 && query.sources[0] === 'saved' ? 'is-active' : ''}`}
                onClick={() =>
                  selectCategory(
                    query.sources.length === 1 && query.sources[0] === 'saved'
                      ? {}
                      : { sources: ['saved'] }
                  )
                }
              >
                <IconGrid />
                <span className="row__label">{t('sidebar.saved')}</span>
                <span className="row__count">{stats?.bySource.saved ?? 0}</span>
              </button>
          ) : null}
          {contentSources.includes('liked') && showLiked ? (
              <button
                type="button"
                className={`row ${query.sources.length === 1 && query.sources[0] === 'liked' ? 'is-active' : ''}`}
                onClick={() =>
                  selectCategory(
                    query.sources.length === 1 && query.sources[0] === 'liked'
                      ? {}
                      : { sources: ['liked'] }
                  )
                }
              >
                <IconHeart />
                <span className="row__label">{t('sidebar.liked')}</span>
                <span className="row__count">{stats?.bySource.liked ?? 0}</span>
              </button>
          ) : null}

          <button
            type="button"
            className={`row ${query.favoritesOnly ? 'is-active' : ''}`}
            onClick={() => selectCategory(query.favoritesOnly ? {} : { favoritesOnly: true })}
          >
            <IconStar filled={query.favoritesOnly} />
            <span className="row__label">{t('sidebar.favorites')}</span>
            <span className="row__count">{stats?.favorites ?? 0}</span>
          </button>
        </div>

        <div className="sidebar__group">
          <h2 className="sidebar__title">{t('sidebar.filters')}</h2>

          <button
            type="button"
            className={`row ${query.untaggedOnly ? 'is-active' : ''}`}
            onClick={() =>
              setQuery({
                untaggedOnly: !query.untaggedOnly,
                tags: []
              })
            }
          >
            <IconTag />
            <span className="row__label">{t('sidebar.untagged')}</span>
          </button>

          {KIND_FILTERS.map(({ kind, label, icon }) => (
            <button
              key={kind}
              type="button"
              className={`row ${query.kinds.includes(kind) ? 'is-active' : ''}`}
              onClick={() => toggleKind(kind)}
            >
              {icon}
              <span className="row__label">{t(label)}</span>
            </button>
          ))}

          {PUBLIC_PLATFORMS.map((platform) => (
            <button
              key={platform}
              type="button"
              className={`row ${query.platforms.includes(platform) ? 'is-active' : ''}`}
              onClick={() => togglePlatform(platform)}
            >
              <PlatformIcon
                platform={platform}
                coloured={!query.platforms.includes(platform)}
              />
              <span className="row__label">{PLATFORM_LABEL[platform]}</span>
              <span className="row__count">{stats?.byPlatform[platform] ?? 0}</span>
            </button>
          ))}
        </div>

        {/* Filtre par couleur : une rangée de pastilles plutôt qu'une liste de lignes —
            sept teintes tiennent sur une ligne et se reconnaissent sans être lues. */}
        {labelledColors.length > 0 ? (
          <div className="sidebar__group">
            <h2 className="sidebar__title">{t('label.sidebar')}</h2>
            <div className="label-filter">
              {labelledColors.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`label-dot label-dot--${color} ${query.label === color ? 'is-active' : ''}`}
                  title={`${t(`label.${color}` as TranslationKey)} · ${stats?.byLabel[color] ?? 0}`}
                  aria-label={t(`label.${color}` as TranslationKey)}
                  onClick={() => setQuery({ label: query.label === color ? null : color })}
                />
              ))}
            </div>
          </div>
        ) : null}

        <div className="sidebar__group">
          <h2 className="sidebar__title">
            <button
              type="button"
              className={`sidebar__title-filter ${allCollectionsSelected ? 'is-active' : ''}`}
              aria-pressed={allCollectionsSelected}
              disabled={collections.length === 0}
              title={t('sidebar.allCollections')}
              onClick={() =>
                selectCategory({
                  collectionIds: allCollectionsSelected
                    ? []
                    : collections.map((collection) => collection.id)
                })
              }
            >
              {t('sidebar.collections')}
            </button>
            <button
              type="button"
              className="title-btn"
              onClick={() => setCreatingCollection((value) => !value)}
              title={t('sidebar.newCollection')}
            >
              <IconPlus size={13} />
            </button>
          </h2>
          {creatingCollection ? (
            <form className="collection-create" onSubmit={(event) => void createCollection(event)}>
              <input
                autoFocus
                value={collectionDraft}
                maxLength={120}
                placeholder={t('sidebar.collectionName')}
                onChange={(event) => setCollectionDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setCreatingCollection(false)
                }}
              />
              <button type="submit" className="collection-create__submit" disabled={!collectionDraft.trim()}>
                <IconCheck size={13} />
              </button>
            </form>
          ) : null}
          {collections.length === 0 ? (
            <p className="sidebar__empty">{t('sidebar.noneYet')}</p>
          ) : (
            /* Sa propre zone de défilement : vingt-sept collections poussaient les tags hors
               du panneau, et rien ne disait qu'il en restait. */
            <div className="sidebar__scroll">
            {collections.map((collection) => (
              <div key={collection.id} className="collection-row">
                <button
                  type="button"
                  className={`row ${query.collectionIds.includes(collection.id) ? 'is-active' : ''}`}
                  aria-pressed={query.collectionIds.includes(collection.id)}
                  style={
                    collection.color
                      ? ({ '--label': `var(--label-${collection.color})` } as React.CSSProperties)
                      : undefined
                  }
                  onClick={() => toggleCollection(collection.id)}
                >
                  <IconCollections
                    className={collection.color ? 'is-coloured' : undefined}
                  />
                  <span className="row__label">{collection.name}</span>
                  <span className="row__count">{collection.count}</span>
                </button>

                {/* Le sélecteur vit hors du bouton de filtre : imbriquer deux boutons
                    serait invalide, et séparer les deux gestes évite de filtrer par
                    accident en voulant recolorer. */}
                <div className="collection-row__colour">
                  <LabelPicker
                    value={collection.color}
                    ariaLabel={t('label.collectionColor')}
                    onChange={(color) => void recolour(collection.id, color)}
                  />
                </div>
              </div>
            ))}
            </div>
          )}
        </div>

        <div className="sidebar__group sidebar__group--tags">
          <h2 className="sidebar__title">
            <button
              type="button"
              className={`sidebar__title-filter ${allTagsSelected ? 'is-active' : ''}`}
              aria-pressed={allTagsSelected}
              disabled={tags.length === 0}
              title={t('sidebar.allTags')}
              onClick={() =>
                selectCategory({ tags: allTagsSelected ? [] : tags.map((tag) => tag.name) })
              }
            >
              {t('sidebar.tags')}
            </button>
          </h2>
          <div className="tag-list">
            {shown.map((tag) => (
              <button
                key={tag.name}
                type="button"
                className={`row ${query.tags.includes(tag.name) ? 'is-active' : ''}`}
                aria-pressed={query.tags.includes(tag.name)}
                onClick={() => toggleTag(tag.name)}
              >
                <span className="row__hash">#</span>
                <span className="row__label">{tag.name}</span>
                <span className="row__count">{tag.count}</span>
              </button>
            ))}
            {tags.length === 0 ? <p className="sidebar__empty">{t('sidebar.noTagsYet')}</p> : null}
          </div>
          {tags.length > TAGS_COLLAPSED ? (
            <button type="button" className="link-btn" onClick={() => setShowAllTags((v) => !v)}>
              {showAllTags ? t('sidebar.collapse') : t('sidebar.showAllTags', { count: tags.length })}
            </button>
          ) : null}
        </div>
      </nav>

      <div className="sidebar__foot">
        <button type="button" className="row" onClick={() => setSettingsOpen(true)}>
          <IconSettings />
          <span className="row__label">{t('sidebar.settings')}</span>
          <span className="row__kbd">Ctrl ,</span>
        </button>
      </div>
    </aside>
  )
}
