import { useState } from 'react'
import type { MediaDiagnostic } from '@shared/types'
import { magpie } from '../bridge'
import { useT } from '../store'

/**
 * Un média qui ne s'affiche pas, et de quoi comprendre pourquoi.
 *
 * Le lecteur vidéo savait déjà le dire — message, puis relevé technique à la demande. Les
 * images, elles, n'avaient rien : quand la source échouait après avoir été résolue, l'écran
 * restait sur « Chargement du média… » pour toujours. Un rond qui tourne sans fin est le pire
 * des états, parce qu'il promet quelque chose qui n'arrivera pas.
 *
 * Le relevé s'affiche même lorsqu'un message explique déjà l'échec : c'est justement dans ces
 * cas-là qu'il est le plus utile — un lien de CDN expiré et une coupure réseau donnent le même
 * message et deux relevés très différents.
 */
export function MediaError({
  message,
  postId,
  mediaIndex,
  kind,
  quality
}: {
  message: string
  postId: string
  mediaIndex: number
  kind: 'image' | 'video'
  /** La qualité réellement demandée, celle dont on veut le verdict. */
  quality: MediaDiagnosticQuality
}): React.JSX.Element {
  const t = useT()
  const [diagnostic, setDiagnostic] = useState<MediaDiagnostic | null>(null)
  const [diagnosing, setDiagnosing] = useState(false)

  const diagnose = async (): Promise<void> => {
    setDiagnosing(true)
    try {
      setDiagnostic(await magpie.diagnoseMedia(postId, mediaIndex, kind, quality))
    } finally {
      setDiagnosing(false)
    }
  }

  return (
    <div className="player__error" role="alert">
      <span>{message}</span>
      {diagnostic ? (
        <code className="player__diagnostic">
          {/* Un relevé, pas une phrase. Il était composé en français — « o reçus », « ranges
              non annoncés », « longueur », « encodage » — dans les deux langues, ce qui le
              rendait à la fois intraduit et inutilisable : ce texte sert à être recopié dans
              un rapport, ou comparé à ce que rend `curl`. Les noms d'en-têtes HTTP le disent
              mieux qu'une traduction, et de la même façon pour tout le monde. */}
          {diagnostic.status !== null
            ? `${diagnostic.host ?? '?'} · HTTP ${diagnostic.status} ${diagnostic.statusText ?? ''} · ` +
              `${diagnostic.contentType ?? 'content-type: ?'} · ${diagnostic.firstChunkBytes ?? 0} B · ` +
              `accept-ranges: ${diagnostic.acceptRanges ?? 'none'}` +
              (diagnostic.contentRange ? ` · content-range: ${diagnostic.contentRange}` : '') +
              (diagnostic.contentLength ? ` · content-length: ${diagnostic.contentLength}` : '') +
              (diagnostic.contentEncoding ? ` · content-encoding: ${diagnostic.contentEncoding}` : '') +
              ` · ${diagnostic.elapsedMs} ms`
            : `${diagnostic.host ?? '?'} · ${diagnostic.elapsedMs} ms`}
          {diagnostic.error ? `\n${diagnostic.error}` : ''}
        </code>
      ) : (
        <button type="button" className="btn" disabled={diagnosing} onClick={() => void diagnose()}>
          {t(diagnosing ? 'player.diagnosing' : 'player.diagnose')}
        </button>
      )}
    </div>
  )
}

/** La signature exacte attendue par `diagnoseMedia`, sans la réécrire à deux endroits. */
type MediaDiagnosticQuality = Parameters<typeof magpie.diagnoseMedia>[3]
