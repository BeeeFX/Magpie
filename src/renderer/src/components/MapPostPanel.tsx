import { useEffect, useState } from 'react'
import type { Post } from '@shared/types'
import { magpie } from '../bridge'
import { displayName, formatDate, PLATFORM_LABEL } from '../format'
import { notifySuccess, reportFailure } from '../notices'
import { useStore, useT } from '../store'
import { IconChevronLeft, IconChevronRight, IconClose, IconCopy, IconExternal, IconStar } from './Icons'
import { PlatformIcon } from './PlatformIcon'
import { VideoPlayer } from './VideoPlayer'

/**
 * Le post cliqué sur la carte, à côté de la carte.
 *
 * Un clic ouvrait la page web dans le navigateur : on quittait l'application pour voir un
 * contenu qu'elle a déjà sur le disque, et il fallait revenir. Un panneau plutôt qu'une
 * fenêtre par-dessus, parce qu'on regarde rarement un seul post : cliquer d'un point à
 * l'autre remplace le contenu, sans rien à refermer entre deux.
 *
 * Volontairement plus mince que `Detail` : celui-ci est piloté par le store — il lit
 * `posts`, `detailIndex`, et navigue de proche en proche dans la grille filtrée. Or les
 * points de la carte ne sont pas cette liste : la carte porte la bibliothèque entière, la
 * grille ce que les filtres ont laissé. Le brancher ici l'aurait fait naviguer dans une
 * liste sans rapport avec ce qu'on voit.
 */

interface Props {
  postId: string | null
  onClose(): void
  /**
   * `inline` prend sa place à côté de la carte, `floating` se pose par-dessus.
   *
   * La différence n'est pas décorative. En `inline`, ouvrir le panneau reprend de la largeur à
   * la carte, donc le canevas est redimensionné et la projection doit se recaler — supportable
   * dans l'organisateur, où la carte est un bandeau large et bas, ingérable sur la carte plein
   * écran, où la fenêtre est souvent plus haute que large : le petit côté change alors, et avec
   * lui l'empan de la carte. En `floating`, la carte ne bouge pas d'un pixel, et le panneau peut
   * glisser et se redimensionner sans rien entraîner.
   */
  variant?: 'inline' | 'floating'
  /** Largeur en pixels du panneau flottant, tenue par l'appelant pour qu'elle survive à la fermeture. */
  width?: number
  onResize?(width: number): void
}

/** Assez large pour voir, assez étroit pour laisser la carte lisible. */
const MIN_WIDTH = 320
const MAX_FRACTION = 0.72

export function MapPostPanel({
  postId,
  onClose,
  variant = 'inline',
  width = 520,
  onResize
}: Props): React.JSX.Element | null {
  const t = useT()
  const toggleFavorite = useStore((state) => state.toggleFavorite)
  const setQuery = useStore((state) => state.setQuery)
  const query = useStore((state) => state.query)
  const [post, setPost] = useState<Post | null>(null)
  const [missing, setMissing] = useState(false)
  const [dragging, setDragging] = useState(false)
  /**
   * L'image en pleine résolution, quand la plateforme veut bien la donner.
   *
   * Le panneau n'affichait que la vignette du cache — 480 pixels de large. Tant qu'il faisait
   * trois cents pixels, personne ne le voyait ; à la moitié de l'écran, une vignette de 480 px
   * occupe le quart de la place et le reste est du vide. Même escalade que `Detail` : la
   * vignette d'abord, parce qu'elle est déjà sur le disque et s'affiche à l'instant, puis la
   * vraie image dès que son URL revient.
   */
  const [fullImage, setFullImage] = useState<string | null>(null)
  /**
   * Le média regardé, quand le post en porte plusieurs.
   *
   * Le panneau affichait `media[0]` **seul** tout en annonçant « 4 médias » juste en dessous :
   * il disait donc lui-même ce qu'il ne montrait pas. Un carrousel de plusieurs images est
   * exactement le cas où le premier ne suffit pas.
   */
  const [mediaIndex, setMediaIndex] = useState(0)

  useEffect(() => {
    if (!postId) return
    let cancelled = false
    /* Le post précédent reste affiché pendant la recherche du suivant : le vider ferait
       clignoter le panneau à chaque clic, alors que la réponse arrive en quelques
       millisecondes — tout est local. */
    setMissing(false)
    setMediaIndex(0)
    void magpie
      .getPostsByIds([postId])
      .then((found) => {
        if (cancelled) return
        if (found[0]) setPost(found[0])
        else setMissing(true)
      })
      .catch(() => {
        if (!cancelled) setMissing(true)
      })
    return () => {
      cancelled = true
    }
  }, [postId])

  const image = post?.media[mediaIndex] ?? post?.media[0] ?? null
  const isImage = image?.kind === 'image' || (image?.kind === 'video' && !image.videoUrl)

  useEffect(() => {
    if (!post || !image || !isImage) {
      setFullImage(null)
      return
    }
    let cancelled = false
    setFullImage(image.thumbUrl)
    void magpie
      .getMediaPlaybackUrl(post.id, image.idx, 'image', 'auto')
      .then((url) => {
        if (!cancelled && url) setFullImage(url)
      })
      .catch(() => {
        // La vignette reste : elle est petite, mais elle est là.
      })
    return () => {
      cancelled = true
    }
  }, [post?.id, image?.idx, image?.thumbUrl, isImage])

  useEffect(() => {
    if (!postId) return
    const onKey = (event: KeyboardEvent): void => {
      /* Échap ferme le panneau et rien d'autre : sans l'arrêter ici, il refermait aussi la
         fenêtre d'organisation, et on perdait l'analyse pour avoir voulu fermer un aperçu. */
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [postId, onClose])

  const floating = variant === 'floating'
  /* En `inline` on démonte : il n'y a pas d'animation à jouer, et laisser une colonne vide
     décalerait la carte. En `floating` le panneau reste monté et se retire en glissant — un
     composant démonté n'a plus d'animation de sortie, c'est toute la raison de le garder. */
  if (!postId && !floating) return null

  const open = postId !== null
  /* Filtrer le mur sur ce tag et refermer le panneau : ce qu'on vient de redéfinir est
     derrière la carte, pas devant. Même geste que dans la vue détaillée. */
  const filterByTag = (name: string): void => {
    const active = query.tags.includes(name)
    setQuery({
      tags: active ? query.tags.filter((tag) => tag !== name) : [...query.tags, name]
    })
    onClose()
  }

  const shown = post
  const media = shown?.media[0] ?? null
  const isVideo = media?.kind === 'video' && Boolean(media.videoUrl)

  return (
    <aside
      className={`map-panel${floating ? ' map-panel--floating' : ''}${open ? ' is-open' : ''}${
        dragging ? ' is-dragging' : ''
      }`}
      style={floating ? { width: `${width}px` } : undefined}
      aria-label={t('organizer.panelTitle')}
      aria-hidden={floating && !open}
    >
      {/* La poignée, sur le bord intérieur. Pendant le glissement la transition est coupée :
          sans cela le panneau poursuivrait la souris avec un temps de retard. */}
      {floating && onResize ? (
        <div
          className="map-panel__grip"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('map.resizePanel')}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            setDragging(true)
          }}
          onPointerMove={(event) => {
            if (!dragging) return
            const wanted = window.innerWidth - event.clientX
            onResize(
              Math.max(MIN_WIDTH, Math.min(window.innerWidth * MAX_FRACTION, Math.round(wanted)))
            )
          }}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          /* Double-clic : retour à la moitié de l'écran, sans avoir à viser. */
          onDoubleClick={() => onResize(Math.round(window.innerWidth / 2))}
        />
      ) : null}
      <header className="map-panel__head">
        <PlatformIcon platform={shown?.platform ?? 'instagram'} />
        <span className="map-panel__who">
          {shown ? displayName(shown) : t('organizer.panelLoading')}
        </span>
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          aria-label={t('detail.close')}
        >
          <IconClose />
        </button>
      </header>

      {missing ? (
        <p className="map-panel__empty">{t('organizer.panelMissing')}</p>
      ) : (
        <>
          <div className="map-panel__stage">
            {isVideo && media ? (
              <VideoPlayer
                key={`${shown?.id}:${media.idx}`}
                src={media.videoUrl ?? ''}
                poster={media.thumbUrl ?? undefined}
                postId={shown?.id ?? ''}
                mediaIndex={media.idx}
                qualities={media.videoQualities}
                fullscreen={false}
                /* Le plein écran appartient à `Detail` : ici la carte doit rester visible,
                   c'est tout l'intérêt du panneau. */
                onToggleFullscreen={() => Promise.resolve()}
              />
            ) : fullImage ?? media?.thumbUrl ? (
              <img
                src={fullImage ?? media?.thumbUrl ?? ''}
                alt={shown?.text ?? ''}
                /* Si la pleine résolution ne se charge pas, on retombe sur la vignette. */
                onError={() => setFullImage(media?.thumbUrl ?? null)}
              />
            ) : (
              <div className="map-panel__nomedia">{t('organizer.panelNoMedia')}</div>
            )}
            {/* Le panneau annonçait « 4 médias » en n'en montrant qu'un : il disait lui-même
                ce qu'il ne montrait pas. */}
            {shown && shown.media.length > 1 ? (
              <>
                <button
                  type="button"
                  className="map-panel__arrow map-panel__arrow--prev"
                  onClick={() => setMediaIndex((index) => Math.max(0, index - 1))}
                  disabled={mediaIndex === 0}
                  aria-label={t('detail.prevMedia')}
                >
                  <IconChevronLeft size={16} />
                </button>
                <button
                  type="button"
                  className="map-panel__arrow map-panel__arrow--next"
                  onClick={() =>
                    setMediaIndex((index) => Math.min(shown.media.length - 1, index + 1))
                  }
                  disabled={mediaIndex >= shown.media.length - 1}
                  aria-label={t('detail.nextMedia')}
                >
                  <IconChevronRight size={16} />
                </button>
                <span className="map-panel__count">
                  {mediaIndex + 1} / {shown.media.length}
                </span>
              </>
            ) : null}
          </div>

          {shown?.text ? <p className="map-panel__text">{shown.text}</p> : null}

          <div className="map-panel__meta">
            <span>{PLATFORM_LABEL[shown?.platform ?? 'instagram']}</span>
            {shown?.savedAt ? <span>· {formatDate(shown.savedAt)}</span> : null}
            {shown && shown.mediaCount > 1 ? (
              <span>· {t('organizer.panelMediaCount', { count: shown.mediaCount })}</span>
            ) : null}
          </div>

          {shown?.tags.length ? (
            <ul className="map-panel__tags">
              {shown.tags.slice(0, 8).map((tag) => (
                <li key={tag.name}>
                  {/* Filtrer, comme dans la barre latérale et dans la vue détaillée. La même
                      forme doit faire la même chose sur les trois surfaces. */}
                  <button type="button" onClick={() => filterByTag(tag.name)}>
                    {tag.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {/* On trouvait un post grâce à la carte, et le seul geste possible était de
              **quitter l'application**. Les deux plus fréquents rejoignent donc l'ouverture :
              mettre en favori et copier le lien. Poser une étiquette ou définir une collection
              reste dans le rail, juste à côté sur le même écran — les refaire ici dans une
              colonne étroite serait un doublon moins bon que l'original. */}
          {shown ? (
            <div className="map-panel__actions">
              <button
                type="button"
                className={`btn btn--icon ${shown.isFavorite ? 'is-active' : ''}`}
                onClick={() => void toggleFavorite(shown.id)}
                title={t('detail.favorite')}
                aria-label={t('detail.favorite')}
                aria-pressed={shown.isFavorite}
              >
                <IconStar size={15} filled={shown.isFavorite} />
              </button>
              <button
                type="button"
                className="btn btn--icon"
                onClick={() => {
                  void magpie
                    .copyToClipboard(shown.url)
                    .then(() => notifySuccess('notice.copied'))
                    .catch(reportFailure('notice.copyFailed'))
                }}
                title={t('card.copyLink')}
                aria-label={t('card.copyLink')}
              >
                <IconCopy size={15} />
              </button>
              <button
                type="button"
                className="btn map-panel__out"
                onClick={() => void magpie.openExternal(shown.url).catch(reportFailure('notice.openFailed'))}
              >
                <IconExternal />
                {t('organizer.panelOpen')}
              </button>
            </div>
          ) : null}
        </>
      )}
    </aside>
  )
}
