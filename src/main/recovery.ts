import { app, BrowserWindow, dialog, shell, type WebContents } from 'electron'
import { logsDir, writeLog } from './log'
import { say } from './messages'

/**
 * Ce qui arrive quand un processus d'Electron meurt.
 *
 * **Rien n'était écouté.** Un renderer qui plantait — mémoire épuisée sur une très grande
 * carte, pilote graphique — laissait une fenêtre blanche jusqu'au redémarrage de l'application,
 * sans un mot ; le processus des modèles ou le GPU pouvaient tomber sans laisser de trace.
 */

/** Deux chutes dans cet intervalle : recharger ne ferait que rejouer la même. */
const RELAPSE_MS = 60_000

let quitting = false

/** Journalise la fin de tout processus, fenêtre ou enfant. À appeler une fois. */
export function installCrashLogging(): void {
  app.on('before-quit', () => {
    quitting = true
  })
  app.on('render-process-gone', (_event, contents, details) => {
    console.error(
      `[magpie] Processus de rendu arrêté (${details.reason}, code ${details.exitCode}) : ${describe(contents)}`
    )
  })
  app.on('child-process-gone', (_event, details) => {
    const line =
      `[magpie] Processus ${details.type}${details.serviceName ? ` « ${details.serviceName} »` : ''} ` +
      `arrêté (${details.reason}, code ${details.exitCode}).`
    /* `killed` est aussi ce que produit l'arrêt volontaire du processus des modèles au bout de
       cinq minutes d'inactivité : ce n'est pas une panne. */
    if (details.reason === 'clean-exit' || details.reason === 'killed') console.log(line)
    else console.error(line)
  })
}

function describe(contents: WebContents): string {
  if (contents.isDestroyed()) return 'fenêtre fermée'
  return contents.getURL() || `contenu ${contents.id}`
}

/**
 * Relance la fenêtre principale quand son renderer meurt, une fois ; à la seconde chute
 * rapprochée, demande plutôt que de boucler — une page qui plante au chargement se
 * rechargerait indéfiniment, fenêtre clignotante et processeur plein.
 */
export function watchRenderer(win: BrowserWindow): void {
  let lastReload = 0
  const contents = win.webContents

  contents.on('render-process-gone', (_event, details) => {
    if (quitting || win.isDestroyed() || details.reason === 'clean-exit') return
    if (Date.now() - lastReload > RELAPSE_MS) {
      lastReload = Date.now()
      console.warn('[magpie] Fenêtre rechargée après l’arrêt de son renderer.')
      contents.reload()
      return
    }
    void askAfterRelapse(win).then((reload) => {
      if (win.isDestroyed()) return
      if (reload) {
        lastReload = Date.now()
        contents.reload()
      } else {
        app.quit()
      }
    })
  })

  contents.on('unresponsive', () => console.warn('[magpie] La fenêtre ne répond plus.'))
  contents.on('responsive', () => console.log('[magpie] La fenêtre répond de nouveau.'))
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) console.error(`[magpie] Chargement de l’interface impossible (${code} ${description}) : ${url}`)
  })

  /* Les erreurs du renderer ont leur propre console, que la version installée ne montre à
     personne : on ne recopie que les erreurs, et seulement dans le fichier. */
  contents.on('console-message', (event) => {
    if (event.level === 'error') writeLog('error', `[interface] ${event.message}`)
  })
}

/** `true` pour recharger, `false` pour quitter. */
async function askAfterRelapse(win: BrowserWindow): Promise<boolean> {
  for (;;) {
    const options = {
      type: 'error' as const,
      title: 'Magpie',
      message: say('crash.relapse'),
      detail: say('crash.relapseDetail'),
      buttons: [say('crash.reload'), say('crash.openLogs'), say('crash.quit')],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    }
    const { response } =
      win.isVisible() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    if (response === 0) return true
    if (response === 2) return false
    // Le dossier s'ouvre, et la question revient : il reste à décider quoi faire de la fenêtre.
    await shell.openPath(logsDir())
  }
}
