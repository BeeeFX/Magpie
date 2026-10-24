import { useEffect, useRef } from 'react'
import { magpie } from './bridge'
import { formatDate, formatTime } from './format'
import { reportFailure, useNotices } from './notices'

/**
 * Annonce ce que le secours d'ouverture a fait de la bibliothèque.
 *
 * Il ne l'écrivait que dans la console. Une base illisible était mise de côté et remplacée par
 * la dernière sauvegarde — ou par une bibliothèque vide —, et l'application s'ouvrait comme si
 * de rien n'était : des semaines de rangement pouvaient manquer sans que rien ne dise pourquoi,
 * ni à quelle date on était revenu, ni où dormait le fichier d'origine.
 *
 * Le message reste jusqu'à ce qu'on le ferme, et propose d'ouvrir le dossier où se trouve le
 * fichier mis de côté. Il attend que les réglages soient lus : la date se forme dans la langue
 * de l'interface, qui n'est connue qu'à ce moment-là.
 */
export function useRecoveryNotice(ready: boolean): void {
  const asked = useRef(false)
  useEffect(() => {
    if (!ready || asked.current) return
    asked.current = true
    void magpie
      .takeLibraryRecovery()
      .then((recovery) => {
        if (!recovery) return
        const { restoredAt } = recovery
        useNotices.getState().push({
          tone: 'warning',
          key: restoredAt ? 'notice.libraryRestored' : 'notice.libraryReset',
          vars: restoredAt ? { date: `${formatDate(restoredAt)}, ${formatTime(restoredAt)}` } : undefined,
          detail: recovery.setAside ?? undefined,
          action: {
            key: 'settings.openFolder',
            run: () => void magpie.openDataFolder().catch(reportFailure('notice.openFailed'))
          },
          ttl: 0
        })
      })
      .catch(reportFailure('notice.unexpected'))
  }, [ready])
}
