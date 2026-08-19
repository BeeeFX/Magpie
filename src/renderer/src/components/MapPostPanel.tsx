import { useEffect, useState } from 'react'
import type { Post } from '@shared/types'
import { magpie } from '../bridge'
import { displayName, formatDate, PLATFORM_LABEL } from '../format'
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
}

export function MapPostPanel({ postId, onClose }: Props): React.JSX.Element | null {
  const t = useT()
  const [post, setPost] = useState<Post | null>(null)
  const [missing, setMissing] = useState(false)

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

  if (!postId) return null

  const shown = post
  const media = shown?.media[0] ?? null
  const isVideo = media?.kind === 'video' && Boolean(media.videoUrl)

  return (
    <aside className="map-panel" aria-label={t('organizer.panelTitle')}>
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
            ) : media?.thumbUrl ? (
              <img src={media.thumbUrl} alt={shown?.text ?? ''} />
            ) : (
              <div className="map-panel__nomedia">{t('organizer.panelNoMedia')}</div>
            )}
          </div>

          {shown?.text ? <p className="map-panel__text">{shown.text}</p> : null}

          <div className="map-panel__meta">
            <span>{PLATFORM_LABEL[shown?.platform ?? 'instagram']}</span>
            {shown?.publishedAt ? <span>· {formatDate(shown.publishedAt)}</span> : null}
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
              onClick={() => void magpie.openExternal(shown.url)}
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
