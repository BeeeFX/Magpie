import { app, BrowserWindow, session, shell, type Session, type WebContents } from 'electron'
import { platformSessions } from './adapters/session'
import { isRendererUrl } from './renderer-protocol'

/**
 * Ce qu'une page a le droit de demander, et où elle a le droit d'aller.
 *
 * **Toute permission était accordée.** Sans `setPermissionRequestHandler`, Electron dit oui à
 * tout : caméra, micro, notifications, géolocalisation — et surtout `openExternal`, que
 * Chromium demande quand une page navigue vers un schéma qu'il ne sait pas afficher. C'est la
 * voie des `ms-msdt:` et `search-ms:` : une page chargée dans une fenêtre de connexion pouvait
 * faire lancer un programme du système. Et les fenêtres de connexion ouvraient n'importe quel
 * popup `http:` ou `https:` dans la partition connectée, sans garde sur leurs navigations.
 *
 * Deux politiques, selon la session :
 *
 * - **le renderer** (session par défaut) ne navigue que vers sa propre origine, ouvre les liens
 *   web dans le navigateur du système, et n'obtient que les deux permissions qu'il utilise ;
 * - **les fenêtres des plateformes** (connexion, leurs popups, la page hors écran de X) vont où
 *   elles veulent tant que c'est du `https:`, et n'obtiennent **aucune** permission. On ne tient
 *   pas de liste de domaines : Instagram passe par Facebook, X par Google et Apple, la double
 *   authentification par d'autres encore, et une liste qu'on ne peut pas éprouver casserait la
 *   connexion le jour où l'un d'eux déménage.
 */

/**
 * Ce que le renderer utilise réellement : le plein écran du lecteur (`Detail.tsx`) et
 * `navigator.clipboard.writeText` (`ErrorBoundary.tsx`). Le reste de la copie passe par l'IPC.
 */
const RENDERER_PERMISSIONS = new Set<string>(['fullscreen', 'clipboard-sanitized-write'])

const devRendererUrl = (): string | null =>
  app.isPackaged ? null : (process.env['ELECTRON_RENDERER_URL'] ?? null)

function isOwnPage(url: string): boolean {
  const dev = devRendererUrl()
  return isRendererUrl(url) || (dev !== null && url.startsWith(dev))
}

function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** `about:blank` : le premier document d'un popup que son opener remplit ensuite. */
function isRemoteAllowed(url: string): boolean {
  return /^https:\/\//i.test(url) || url === 'about:blank'
}

function isPlatformSession(ses: Session): boolean {
  return platformSessions().includes(ses)
}

let refusals = 0
function logRefusal(what: string, url: string): void {
  /* Une page hostile peut en produire en boucle : les premières suffisent au diagnostic. */
  if (++refusals > 50) return
  console.warn(`[magpie] ${what} : ${url.slice(0, 200)}`)
}

/** À appeler une fois `ready` : les sessions n'existent pas avant. */
export function hardenSessions(): void {
  const renderer = session.defaultSession
  renderer.setPermissionRequestHandler((contents, permission, callback, details) => {
    const allowed =
      RENDERER_PERMISSIONS.has(permission) &&
      isOwnPage(details.requestingUrl ?? contents.getURL())
    if (!allowed) logRefusal(`Permission « ${permission} » refusée`, details.requestingUrl ?? '')
    callback(allowed)
  })
  renderer.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    RENDERER_PERMISSIONS.has(permission) && isOwnPage(`${requestingOrigin.replace(/\/$/, '')}/`)
  )

  for (const ses of platformSessions()) {
    ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
      logRefusal(`Permission « ${permission} » refusée`, details.requestingUrl ?? '')
      callback(false)
    })
    ses.setPermissionCheckHandler(() => false)
    /* Rien à télécharger depuis une page de connexion : un fichier qui arrive là n'a pas été
       demandé par Magpie. */
    ses.on('will-download', (event, item) => {
      logRefusal('Téléchargement refusé', item.getURL())
      event.preventDefault()
    })
  }
}

/**
 * Garde posée sur **chaque** contenu web à sa création — fenêtre, popup, fenêtre cachée —,
 * avant que le code qui l'a créée n'ait pu l'oublier. À appeler avant `ready`.
 */
export function guardWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    // Aucune `<webview>` : rien ne s'en sert, et chacune serait une fenêtre sans garde.
    contents.on('will-attach-webview', (event) => event.preventDefault())
    if (isPlatformSession(contents.session)) guardPlatformContents(contents)
    else guardRendererContents(contents)
  })
}

function guardRendererContents(contents: WebContents): void {
  // Un lien cliqué dans le renderer part dans le navigateur, jamais dans une fenêtre Electron.
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url)
    else logRefusal('Ouverture refusée', url)
    return { action: 'deny' }
  })
  const stay = (event: Electron.Event, url: string): void => {
    if (isOwnPage(url)) return
    event.preventDefault()
    logRefusal('Navigation du renderer refusée', url)
  }
  contents.on('will-navigate', stay)
  contents.on('will-redirect', stay)
}

function guardPlatformContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    const owner = BrowserWindow.fromWebContents(contents)
    /* Une fenêtre cachée — la page des signets de X — n'a personne pour voir son popup. */
    if (!isRemoteAllowed(url) || !owner || !owner.isVisible()) {
      logRefusal('Popup refusé', url)
      return { action: 'deny' }
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent: owner,
        autoHideMenuBar: true,
        webPreferences: {
          session: contents.session,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      }
    }
  })
  const httpsOnly = (event: Electron.Event, url: string): void => {
    if (isRemoteAllowed(url)) return
    event.preventDefault()
    logRefusal('Navigation refusée', url)
  }
  contents.on('will-navigate', httpsOnly)
  contents.on('will-redirect', httpsOnly)
  showHostInTitle(contents)
}

/**
 * Pas de barre d'adresse dans une fenêtre de connexion : rien ne disait sur quel site on tapait
 * son mot de passe. Le titre commence donc par l'hôte réel de la page, avant le titre qu'elle
 * se donne — qu'elle ne peut pas faire passer devant.
 */
function showHostInTitle(contents: WebContents): void {
  let pageTitle = ''
  const update = (): void => {
    const win = BrowserWindow.fromWebContents(contents)
    if (!win || win.isDestroyed()) return
    let host = ''
    try {
      host = new URL(contents.getURL()).host
    } catch {
      return
    }
    if (host) win.setTitle(pageTitle ? `${host} — ${pageTitle}` : host)
  }
  contents.on('page-title-updated', (event, title) => {
    event.preventDefault()
    pageTitle = title
    update()
  })
  contents.on('did-navigate', () => {
    pageTitle = ''
    update()
  })
  contents.on('did-navigate-in-page', update)
}
