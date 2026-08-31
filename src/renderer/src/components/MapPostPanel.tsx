import { useEffect, useState } from 'react'
import type { Post } from '@shared/types'
import { magpie } from '../bridge'
import { displayName, formatDate, PLATFORM_LABEL } from '../format'
import { reportFailure } from '../notices'
import { useT } from '../store'
import { IconClose, IconExternal } from './Icons'
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

  useEffect(() => {
    if (!postId) return
    let cancelled = false
    /* Le post précédent reste affiché pendant la recherche du suivant : le vider ferait
       clignoter le panneau à chaque clic, alors que la réponse arrive en quelques
       millisecondes — tout est local. */
    setMissing(false)
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

  const image = post?.media[0] ?? null
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
                <li key={tag.name}>{tag.name}</li>
              ))}
            </ul>
          ) : null}

          {shown ? (
            <button
              type="button"
              className="btn map-panel__out"
              onClick={() => void magpie.openExternal(shown.url).catch(reportFailure('notice.openFailed'))}
            >
              <IconExternal />
              {t('organizer.panelOpen')}
            </button>
          ) : null}
        </>
      )}
    </aside>
  )
}
