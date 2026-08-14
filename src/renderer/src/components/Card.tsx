import { memo, useEffect, useRef, useState } from 'react'
import type { GridMode, Post } from '@shared/types'
import {
  avatarHue,
  displayName,
  formatShortDate,
  initials,
  isLightColor,
  SOURCE_LABEL
} from '../format'
import type { LayoutItem } from '../layout'
import { magpie } from '../bridge'
import { useStore, useT } from '../store'
import {
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconCopy,
  IconPlay,
  IconSend,
  IconStar,
  IconVolume
} from './Icons'
import { PlatformIcon } from './PlatformIcon'

interface Props {
  item: LayoutItem
  mode: GridMode
  onToggleFavorite: (id: string) => void
  onCopy: (post: Post) => void
  onOpen: (post: Post, element: HTMLElement) => void
  onSendToNitrate: (post: Post) => void
  nitrateEnabled: boolean
  copied: boolean
  selectionMode: boolean
  selected: boolean
  onToggleSelected: (id: string) => void
}

/** Cadence de défilement d'un carrousel au survol. */
const CAROUSEL_INTERVAL = 1400

function CardImpl({
  item,
  mode,
  onToggleFavorite,
  onCopy,
  onOpen,
  onSendToNitrate,
  nitrateEnabled,
  copied,
  selectionMode,
  selected,
  onToggleSelected
}: Props): React.JSX.Element {
  const t = useT()
  const hoverAudio = useStore((s) => s.hoverAudio)
  const setHoverAudio = useStore((s) => s.setHoverAudio)
  const muted = useStore((s) => s.muted)
  const volume = useStore((s) => s.volume)
  const setVolume = useStore((s) => s.setVolume)
  const setMuted = useStore((s) => s.setMuted)
  const { post } = item
  const [loaded, setLoaded] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [index, setIndex] = useState(0)
  const [videoReady, setVideoReady] = useState(false)
  const [streamedVideoUrl, setStreamedVideoUrl] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const rootRef = useRef<HTMLElement>(null)

  const media = post.media
  const current = media[index] ?? media[0]
  const isCarousel = media.length > 1
  const hasMedia = post.kind !== 'text' && post.kind !== 'link'
  const hasVideo = post.kind === 'video' || media.some((m) => m.kind === 'video')

  /* Un carrousel défile tant que la souris reste dessus, et repart de la première image
     quand elle sort — revenir sur une carte doit toujours montrer la même chose. */
  useEffect(() => {
    if (!hovered || !isCarousel) {
      setIndex(0)
      return
    }
    const id = setInterval(() => setIndex((i) => (i + 1) % media.length), CAROUSEL_INTERVAL)
    return () => clearInterval(id)
  }, [hovered, isCarousel, media.length])

  useEffect(() => {
    if (!hovered) setVideoReady(false)
  }, [hovered])

  useEffect(() => {
    setStreamedVideoUrl(null)
  }, [post.id, current?.idx])

  useEffect(() => {
    if (
      !hovered ||
      current?.kind !== 'video' ||
      current.videoUrl ||
      streamedVideoUrl
    ) return
    let cancelled = false
    void magpie
      .getMediaPlaybackUrl(post.id, current.idx, 'video', 'auto')
      .then((url) => {
        if (!cancelled && url) setStreamedVideoUrl(url)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [current?.idx, current?.kind, current?.videoUrl, hovered, post.id, streamedVideoUrl])

  const videoUrl = hovered ? (current?.videoUrl ?? streamedVideoUrl) : null

  /* Le son des aperçus suit le réglage global. Il reste coupé par défaut, et la lecture
     est relancée à chaque clip : un refus d'autoplay est avalé sans bruit. */
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    el.muted = !hoverAudio || muted
    el.volume = volume
    void el.play().catch(() => {})
  }, [videoUrl, hoverAudio, muted, volume])

  const stop = (e: React.MouseEvent): void => e.stopPropagation()

  const mediaBlock = hasMedia ? (
    <div
      className={`card__media ${current?.thumbUrl ? '' : 'is-pending'}`}
      style={{ background: post.dominantColor ?? 'var(--field)' }}
    >
      {current?.thumbUrl ? (
        <img
          src={post.thumbUrl ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className={loaded ? 'is-loaded' : ''}
          onLoad={() => setLoaded(true)}
        />
      ) : null}

      {!current?.thumbUrl ? (
        <span className="card__media-pending" aria-label={t('card.preparingMedia')}>
          <span className="spinner" />
          <span>{t('card.preparingMedia')}</span>
        </span>
      ) : null}

      {/* Vue courante du carrousel, superposée en fondu. Les suivantes ne sont chargées
          qu'au survol : une grille de carrousels ne tire pas cinq images par carte. */}
      {hovered && isCarousel && index > 0 && current?.thumbUrl ? (
        <img key={index} src={current.thumbUrl} alt="" draggable={false} className="card__slide" />
      ) : null}

      {videoUrl ? (
        <video
          ref={videoRef}
          src={videoUrl}
          className={`card__video ${videoReady ? 'is-ready' : ''}`}
          muted={!hoverAudio || muted}
          loop
          playsInline
          preload="auto"
          onCanPlay={() => setVideoReady(true)}
        />
      ) : null}

      {hasVideo ? (
        <span className="card__badge card__badge--icon">
          <IconPlay size={11} />
        </span>
      ) : null}
      {isCarousel ? <span className="card__badge">{media.length}</span> : null}

      {isCarousel ? (
        <>
          {/* Flèches pour parcourir soi-même, en plus du défilement automatique au
              survol : on veut pouvoir s'arrêter sur une vue précise. */}
          <button
            type="button"
            className="card__media-nav card__media-nav--prev"
            title={t('detail.prevMedia')}
            onClick={(e) => {
              e.stopPropagation()
              setIndex((i) => (i - 1 + media.length) % media.length)
            }}
          >
            <IconChevronLeft size={14} />
          </button>
          <button
            type="button"
            className="card__media-nav card__media-nav--next"
            title={t('detail.nextMedia')}
            onClick={(e) => {
              e.stopPropagation()
              setIndex((i) => (i + 1) % media.length)
            }}
          >
            <IconChevronRight size={14} />
          </button>
          <div className="card__dots">
            {media.map((m, i) => (
              <span key={m.idx} className={`card__dot ${i === index ? 'is-active' : ''}`} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  ) : null

  return (
    <article
      ref={rootRef as React.RefObject<HTMLElement>}
      className={`card card--${mode} ${post.label ? 'is-labelled' : ''} ${selected ? 'is-selected' : ''} ${
        isLightColor(post.dominantColor) ? 'is-light' : ''
      }`}
      style={
        {
          '--x': `${item.x}px`,
          '--y': `${item.y}px`,
          // Teinte de l'étiquette, consommée par le CSS pour l'anneau et la pastille.
          ...(post.label ? { '--label': `var(--label-${post.label})` } : {}),
          width: item.width,
          height: item.height
        } as React.CSSProperties
      }
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) =>
        selectionMode ? onToggleSelected(post.id) : onOpen(post, e.currentTarget)
      }
      role="button"
      tabIndex={0}
      aria-label={post.text ?? post.authorName ?? post.authorHandle ?? post.url}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          if (selectionMode) onToggleSelected(post.id)
          else onOpen(post, event.currentTarget)
        }
      }}
    >
      {selectionMode ? (
        <span className={`card__select ${selected ? 'is-selected' : ''}`} aria-hidden="true">
          {selected ? <IconCheck size={15} /> : null}
        </span>
      ) : null}
      {mode === 'cards' ? (
        <>
          <header className="card__author-row">
            <span className="avatar" style={{ '--hue': avatarHue(post) } as React.CSSProperties}>
              {initials(post)}
            </span>
            <span className="card__names">
              <span className="card__name">{displayName(post)}</span>
              {post.authorHandle && post.authorHandle !== displayName(post) ? (
                <span className="card__handle">{post.authorHandle}</span>
              ) : null}
            </span>
          </header>

          {post.text ? <p className="card__copy">{post.text}</p> : null}

          {mediaBlock}

          <footer className="card__chips">
            {post.label ? <span className="card__label-dot" /> : null}
            <span className={`chip-source chip-source--${post.platform}`}>
              <PlatformIcon platform={post.platform} size={12} coloured />
              {SOURCE_LABEL[post.platform]}
            </span>
            {post.publishedAt ? (
              <span className="chip-source">
                <IconClock size={11} />
                {formatShortDate(post.publishedAt)}
              </span>
            ) : null}
            {post.isFavorite ? (
              <span className="chip-source chip-source--fav">
                <IconStar size={11} filled />
              </span>
            ) : null}
          </footer>
        </>
      ) : (
        mediaBlock ?? (
          <div className="card__media card__media--text">
            <div className="card__text-body">
              <p>{post.text}</p>
            </div>
          </div>
        )
      )}

      <div className="card__actions" onClick={stop}>
        {/* Le son des aperçus se coupe et se rétablit depuis la carte elle-même : c'est
            là qu'on s'en rend compte, pas dans la barre d'outils. Le réglage reste
            global — une seule décision, pas une par vignette. */}
        {hasVideo ? (
          <div className="card-volume">
            <button
              type="button"
              className={`icon-btn ${hoverAudio ? 'is-active' : ''}`}
              title={t(hoverAudio ? 'toolbar.hoverAudioOn' : 'toolbar.hoverAudioOff')}
              aria-pressed={hoverAudio}
              onClick={() => setHoverAudio(!hoverAudio)}
            >
              <IconVolume size={15} waves={hoverAudio && !muted && volume > 0} />
            </button>
            <div className="card-volume__popover">
              <input
                type="range"
                min={0}
                max={100}
                value={muted ? 0 : Math.round(volume * 100)}
                onChange={(event) => {
                  const next = Number(event.target.value) / 100
                  setVolume(next)
                  setHoverAudio(next > 0)
                  setMuted(next === 0)
                }}
                aria-label={t('toolbar.previewVolume')}
              />
              <span>{Math.round((muted ? 0 : volume) * 100)}%</span>
            </div>
          </div>
        ) : null}
        {nitrateEnabled && hasVideo ? (
          <button
            type="button"
            className="icon-btn"
            title={t('card.sendToNitrate')}
            onClick={() => onSendToNitrate(post)}
          >
            <IconSend size={15} />
          </button>
        ) : null}
        <button
          type="button"
          className={`icon-btn ${post.isFavorite ? 'is-active' : ''}`}
          title={t(post.isFavorite ? 'card.unfavorite' : 'card.favorite')}
          onClick={() => onToggleFavorite(post.id)}
        >
          <IconStar size={15} filled={post.isFavorite} />
        </button>
        <button
          type="button"
          className={`icon-btn ${copied ? 'is-copied' : ''}`}
          title={t('card.copyLink')}
          onClick={() => onCopy(post)}
        >
          {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
        </button>
      </div>

      {mode === 'masonry' ? (
        <div className="card__overlay">
          <div className="card__foot">
            {post.authorHandle ? <span className="card__author">{post.authorHandle}</span> : null}
            {post.text ? <p className="card__excerpt">{post.text}</p> : null}
          </div>
        </div>
      ) : null}
    </article>
  )
}

export const Card = memo(CardImpl)
