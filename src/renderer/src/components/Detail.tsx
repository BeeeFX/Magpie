import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CollectionInfo, Post } from '@shared/types'
import { magpie } from '../bridge'
import {
  avatarHue,
  displayName,
  formatDate,
  hasVideo,
  initials,
  PLATFORM_LABEL,
  SOURCE_LABEL
} from '../format'
import { useStore, useT } from '../store'
import { LabelPicker } from './LabelPicker'
import { VideoPlayer } from './VideoPlayer'
import {
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconCollections,
  IconCopy,
  IconExpand,
  IconExternal,
  IconPlus,
  IconSend,
  IconStar
} from './Icons'

/**
 * Vue détaillée.
 *
 * S'ouvre **depuis la carte cliquée** et y **retourne** à la fermeture : on mesure le
 * panneau une fois monté, on calcule la transformation qui le fait coïncider avec la
 * vignette, et on la relâche à l'ouverture puis on la réapplique à la fermeture. L'élément
 * part et revient donc de l'endroit exact où se trouvait la carte, au lieu d'apparaître au
 * centre et de disparaître d'un coup.
 */
export function Detail(): React.JSX.Element | null {
  const t = useT()
  const posts = useStore((s) => s.posts)
  const index = useStore((s) => s.detailIndex)
  const origin = useStore((s) => s.detailOrigin)
  const close = useStore((s) => s.closeDetail)
  const step = useStore((s) => s.stepDetail)
  const toggleFavorite = useStore((s) => s.toggleFavorite)
  const addTag = useStore((s) => s.addTag)
  const removeTag = useStore((s) => s.removeTag)
  const setLabel = useStore((s) => s.setLabel)
  const nitrateEnabled = useStore((s) => s.nitrateEnabled)

  const panelRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const lastWheel = useRef(0)
  const [entered, setEntered] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [mediaIndex, setMediaIndex] = useState(0)
  const [copied, setCopied] = useState(false)
  const [tagDraft, setTagDraft] = useState('')
  const [collections, setCollections] = useState<CollectionInfo[]>([])
  const [inCollections, setInCollections] = useState<number[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [creatingCollection, setCreatingCollection] = useState(false)
  const [collectionDraft, setCollectionDraft] = useState('')
  const [detailImageSrc, setDetailImageSrc] = useState<string | null>(null)
  const [detailImageError, setDetailImageError] = useState(false)
  const [htmlFullscreen, setHtmlFullscreen] = useState(false)
  const [nativeFullscreen, setNativeFullscreen] = useState(false)
  const fullscreen = htmlFullscreen || nativeFullscreen

  const post: Post | undefined = index === null ? undefined : posts[index]
  const selectedMedia = post?.media[mediaIndex] ?? post?.media[0]

  /** Transformation qui fait coïncider le panneau avec la vignette d'origine. */
  const originTransform = useCallback((): string | null => {
    const panel = panelRef.current
    if (!panel || !origin) return null
    const target = panel.getBoundingClientRect()
    if (target.width === 0 || target.height === 0) return null
    const scaleX = origin.width / target.width
    const scaleY = origin.height / target.height
    const dx = origin.x + origin.width / 2 - (target.x + target.width / 2)
    const dy = origin.y + origin.height / 2 - (target.y + target.height / 2)
    return `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`
  }, [origin])

  /**
   * Fermeture animée : sans elle, l'aller est soigné et le retour brutal. Le démontage
   * réel n'a lieu qu'une fois la transition finie.
   */
  const requestClose = useCallback(() => {
    if (nativeFullscreen) {
      void magpie.setWindowFullscreen(false)
      setNativeFullscreen(false)
    }
    const panel = panelRef.current
    const transform = originTransform()
    if (!panel || !transform) {
      close()
      return
    }
    setLeaving(true)
    panel.style.transform = transform
    panel.style.opacity = '0'
    setTimeout(close, 280)
  }, [close, nativeFullscreen, originTransform])

  /* Animation d'ouverture depuis la vignette. */
  useLayoutEffect(() => {
    const panel = panelRef.current
    const transform = originTransform()
    if (!panel || !transform) {
      setEntered(true)
      return
    }

    panel.style.transition = 'none'
    panel.style.transform = transform
    panel.style.opacity = '0.5'

    const release = (): void => {
      panel.style.transition = ''
      panel.style.transform = ''
      panel.style.opacity = ''
      setEntered(true)
    }

    // rAF donne le meilleur rendu, mais il est suspendu quand la fenêtre n'est pas
    // composited : sans ce repli, le panneau resterait figé à la taille de la vignette.
    const frame = requestAnimationFrame(release)
    const fallback = setTimeout(release, 120)

    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(fallback)
    }
  }, [originTransform])

  /* Chaque post repart de son premier média et recharge ses collections. */
  useEffect(() => {
    setMediaIndex(0)
    setNotice(null)
    if (!post) return
    void magpie.collectionsForPost(post.id).then(setInCollections)
  }, [post?.id])

  useEffect(() => {
    if (!post || selectedMedia?.kind !== 'image') {
      setDetailImageSrc(null)
      setDetailImageError(false)
      return
    }
    let cancelled = false
    setDetailImageSrc(selectedMedia.thumbUrl)
    setDetailImageError(false)
    void magpie
      .getMediaPlaybackUrl(post.id, selectedMedia.idx, 'image', 'auto')
      .then((url) => {
        if (!cancelled && url) setDetailImageSrc(url)
      })
      .catch(() => {
        if (!cancelled && !selectedMedia.thumbUrl) setDetailImageError(true)
      })
    return () => {
      cancelled = true
    }
  }, [post?.id, selectedMedia?.idx, selectedMedia?.kind, selectedMedia?.thumbUrl])

  useEffect(() => {
    if (index === null) return
    void magpie.listCollections().then(setCollections)
  }, [index])

  useEffect(() => {
    const update = (): void => setHtmlFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [])

  const toggleFullscreen = useCallback(async (): Promise<void> => {
    if (document.fullscreenElement) {
      await document.exitFullscreen?.()
      return
    }
    if (nativeFullscreen) {
      await magpie.setWindowFullscreen(false)
      setNativeFullscreen(false)
      return
    }

    try {
      if (!stageRef.current?.requestFullscreen) throw new Error('Fullscreen API unavailable')
      await stageRef.current.requestFullscreen()
    } catch {
      // Certains environnements Chromium refusent l'API HTML malgré un clic utilisateur.
      // Electron peut alors mettre la fenêtre en plein écran et le CSS masque le panneau.
      const enabled = await magpie.setWindowFullscreen(true)
      setNativeFullscreen(enabled)
    }
  }, [nativeFullscreen])

  const stepMedia = useCallback(
    (delta: number) => {
      if (!post || post.media.length < 2) return
      setMediaIndex((i) => (i + delta + post.media.length) % post.media.length)
    },
    [post]
  )

  useEffect(() => {
    if (index === null) return
    const onKey = (e: KeyboardEvent): void => {
      // Ne pas capturer les flèches pendant la saisie d'un tag.
      if (e.target instanceof HTMLInputElement) {
        if (e.key === 'Escape') e.target.blur()
        return
      }
      switch (e.key) {
        case 'Escape':
          if (fullscreen) {
            e.preventDefault()
            void toggleFullscreen().catch(() => {})
            break
          }
          requestClose()
          break
        case 'ArrowRight':
          step(1)
          break
        case 'ArrowLeft':
          step(-1)
          break
        case 'ArrowDown':
          stepMedia(1)
          break
        case 'ArrowUp':
          stepMedia(-1)
          break
        case 'f':
        case 'F':
          void toggleFullscreen().catch(() => {})
          break
        default:
          break
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [fullscreen, index, requestClose, step, stepMedia, toggleFullscreen])

  /**
   * Molette : un cran vers le bas passe au signet suivant, vers le haut au précédent.
   * Le verrou évite qu'un seul geste de trackpad, qui émet des dizaines d'événements,
   * ne fasse défiler vingt posts d'un coup.
   */
  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      if (Math.abs(event.deltaY) < 12) return
      const now = Date.now()
      if (now - lastWheel.current < 320) return
      lastWheel.current = now
      step(event.deltaY > 0 ? 1 : -1)
    },
    [step]
  )

  if (index === null || !post) return null

  const media = selectedMedia
  const isVideo = media?.kind === 'video' && Boolean(
    media.hasSource || media.videoUrl || media.videoQualities.length > 0
  )
  const hasMedia = Boolean(
    media?.hasSource || media?.thumbUrl || media?.videoUrl || media?.videoQualities.length
  )

  const copy = (): void => {
    void magpie.copyToClipboard(post.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  const submitTag = (e: React.FormEvent): void => {
    e.preventDefault()
    const name = tagDraft.trim()
    if (!name) return
    setTagDraft('')
    void addTag(post.id, name)
  }

  const toggleCollection = async (collection: CollectionInfo): Promise<void> => {
    if (inCollections.includes(collection.id)) {
      await magpie.removeFromCollection(collection.id, post.id)
      setInCollections((ids) => ids.filter((id) => id !== collection.id))
      setNotice(t('detail.removedFrom', { name: collection.name }))
      return
    }

    const result = await magpie.addToCollection(collection.id, [post.id])
    setInCollections((ids) => [...ids, collection.id])
    // La clé primaire composite rend le doublon impossible : on rend compte de l'état
    // réel plutôt que de proposer un « réajouter » qui ne ferait rien.
    setNotice(
      t(result.added > 0 ? 'detail.addedTo' : 'detail.alreadyIn', { name: collection.name })
    )
  }

  const createCollection = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const name = collectionDraft.trim()
    if (!name) return
    const created = await magpie.createCollection(name)
    setCollections(await magpie.listCollections())
    await magpie.addToCollection(created.id, [post.id])
    setInCollections((ids) => [...ids, created.id])
    setNotice(t('detail.addedTo', { name: created.name }))
    setCollectionDraft('')
    setCreatingCollection(false)
  }

  return (
    <div
      className={`detail ${entered ? 'is-entered' : ''} ${leaving ? 'is-leaving' : ''} ${nativeFullscreen ? 'is-window-fullscreen' : ''}`}
      onMouseDown={requestClose}
      onWheel={onWheel}
    >
      <button
        type="button"
        className="detail__nav detail__nav--prev"
        disabled={index === 0}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => step(-1)}
        title={`${t('detail.prevPost')}  ·  ←`}
      >
        <IconChevronLeft size={20} />
      </button>

      {/* Un post sans média n'a pas de scène à occuper : le panneau se réduit à une seule
          colonne, et le texte devient le contenu principal au lieu d'être une ligne
          perdue au milieu d'un grand rectangle noir. */}
      <div
        className={`detail__panel ${hasMedia ? '' : 'detail__panel--text'}`}
        ref={panelRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {hasMedia ? (
        <div className="detail__stage" ref={stageRef}>
          {isVideo ? (
            <VideoPlayer
              key={`${post.id}:${media.idx}`}
              src={media.videoUrl ?? ''}
              poster={media.thumbUrl ?? undefined}
              postId={post.id}
              mediaIndex={media.idx}
              qualities={media.videoQualities}
              fullscreen={fullscreen}
              onToggleFullscreen={toggleFullscreen}
            />
          ) : detailImageSrc ? (
            <img
              src={detailImageSrc}
              alt={post.text ?? ''}
              className="detail__media"
              onError={() => setDetailImageSrc(media?.thumbUrl ?? null)}
            />
          ) : detailImageError ? (
            <div className="player__error">{t('player.streamError')}</div>
          ) : (
            <div className="detail__media-loading" aria-live="polite">
              <span className="spinner" />
              <span>{t('card.preparingMedia')}</span>
            </div>
          )}

          {post.media.length > 1 ? (
            <>
              <button
                type="button"
                className="detail__media-nav detail__media-nav--prev"
                onClick={() => stepMedia(-1)}
                title={`${t('detail.prevMedia')}  ·  ↑`}
              >
                <IconChevronLeft />
              </button>
              <button
                type="button"
                className="detail__media-nav detail__media-nav--next"
                onClick={() => stepMedia(1)}
                title={`${t('detail.nextMedia')}  ·  ↓`}
              >
                <IconChevronRight />
              </button>
              <div className="detail__dots">
                {post.media.map((m, i) => (
                  <button
                    key={m.idx}
                    type="button"
                    className={`detail__dot ${i === mediaIndex ? 'is-active' : ''}`}
                    onClick={() => setMediaIndex(i)}
                    aria-label={`${t('detail.nextMedia')} ${i + 1}`}
                  />
                ))}
              </div>
            </>
          ) : null}
        </div>
        ) : null}

        <aside className="detail__side">
          <header className="detail__head">
            <span
              className="avatar avatar--lg"
              style={{ '--hue': avatarHue(post) } as React.CSSProperties}
            >
              {initials(post)}
            </span>
            <div className="detail__who">
              <span className="detail__name">{displayName(post)}</span>
              {post.authorHandle ? <span className="detail__handle">{post.authorHandle}</span> : null}
            </div>
            <button
              type="button"
              className="icon-btn-ghost"
              onClick={requestClose}
              title={`${t('detail.close')}  ·  Échap`}
            >
              <IconClose />
            </button>
          </header>

          {post.text ? (
            <p className={`detail__body ${hasMedia ? '' : 'detail__body--lead'}`}>{post.text}</p>
          ) : null}

          <div className="detail__chips">
            <span className="chip-static">{PLATFORM_LABEL[post.platform]}</span>
            <span className="chip-static">{SOURCE_LABEL[post.platform]}</span>
            {post.publishedAt ? (
              <span className="chip-static">{formatDate(post.publishedAt)}</span>
            ) : null}
          </div>

          <section className="detail__section">
            <h3>{t('label.section')}</h3>
            <LabelPicker
              value={post.label}
              onChange={(label) => void setLabel(post.id, label)}
              ariaLabel={t('label.section')}
            />
          </section>

          <section className="detail__section">
            <h3>{t('detail.tags')}</h3>
            <div className="detail__tags">
              {post.tags.map((tag) => (
                <button
                  key={tag.name}
                  type="button"
                  className={`tag-chip tag-chip--${tag.source}`}
                  onClick={() => void removeTag(post.id, tag.name)}
                  title={t('detail.removeTag')}
                >
                  {tag.name}
                  <IconClose size={11} />
                </button>
              ))}
            </div>
            <form onSubmit={submitTag}>
              <input
                className="detail__input"
                value={tagDraft}
                placeholder={t('detail.addTag')}
                onChange={(e) => setTagDraft(e.target.value)}
              />
            </form>
          </section>

          <section className="detail__section">
            <h3>{t('detail.collections')}</h3>
            <div className="detail__collections">
              {collections.map((collection) => (
                <button
                  key={collection.id}
                  type="button"
                  className={`collection-chip ${inCollections.includes(collection.id) ? 'is-in' : ''}`}
                  onClick={() => void toggleCollection(collection)}
                >
                  <IconCollections size={13} />
                  {collection.name}
                  {inCollections.includes(collection.id) ? <IconCheck size={12} /> : null}
                </button>
              ))}
              <button
                type="button"
                className="collection-chip"
                onClick={() => setCreatingCollection(true)}
              >
                <IconPlus size={13} />
                {t('detail.newCollection')}
              </button>
            </div>
            {creatingCollection ? (
              <form className="collection-create collection-create--detail" onSubmit={(event) => void createCollection(event)}>
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
            {notice ? <p className="detail__notice">{notice}</p> : null}
          </section>

          <footer className="detail__actions">
            <button
              type="button"
              className={`btn btn--icon ${post.isFavorite ? 'is-active' : ''}`}
              onClick={() => void toggleFavorite(post.id)}
              title={t('detail.favorite')}
            >
              <IconStar size={15} filled={post.isFavorite} />
            </button>
            <button type="button" className="btn btn--icon" onClick={copy} title={t('card.copyLink')}>
              {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
            </button>
            <button
              type="button"
              className="btn btn--icon"
              onClick={() => void magpie.openExternal(post.url)}
              title={t('detail.openOnPlatform')}
            >
              <IconExternal size={15} />
            </button>
            <button
              type="button"
              className={`btn btn--icon ${fullscreen ? 'is-active' : ''}`}
              onClick={() => void toggleFullscreen().catch(() => {})}
              title={`${t('detail.fullscreen')}  ·  F`}
              aria-pressed={fullscreen}
            >
              <IconExpand size={15} />
            </button>
            {nitrateEnabled && hasVideo(post) ? (
              <button
                type="button"
                className="btn btn--wide"
                onClick={() => void magpie.sendToNitrate(post.url)}
              >
                <IconSend size={15} />
                Nitrate
              </button>
            ) : null}
          </footer>
        </aside>
      </div>

      <button
        type="button"
        className="detail__nav detail__nav--next"
        disabled={index >= posts.length - 1}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => step(1)}
        title={`${t('detail.nextPost')}  ·  →`}
      >
        <IconChevronRight size={20} />
      </button>
    </div>
  )
}
