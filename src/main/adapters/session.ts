import { BrowserWindow, session, type Session } from 'electron'
import type { Platform } from '@shared/types'

/**
 * Sessions par plateforme. Voir SPEC.md §5 et §10.
 *
 * Chaque plateforme vit dans une partition Electron isolée : ses cookies ne fuient pas
 * vers les autres, et « Déconnecter » purge réellement quelque chose. Le stockage est
 * celui, chiffré, de Chromium.
 */

const PARTITION: Record<Platform, string> = {
  instagram: 'persist:magpie-instagram',
  x: 'persist:magpie-x',
  reddit: 'persist:magpie-reddit'
}

/** Cookie dont la présence atteste d'une session ouverte. */
const AUTH_COOKIE: Record<Platform, { name: string; url: string }> = {
  instagram: { name: 'sessionid', url: 'https://www.instagram.com' },
  x: { name: 'auth_token', url: 'https://x.com' },
  reddit: { name: 'reddit_session', url: 'https://www.reddit.com' }
}

const LOGIN_URL: Record<Platform, string> = {
  instagram: 'https://www.instagram.com/accounts/login/',
  x: 'https://x.com/i/flow/login',
  reddit: 'https://www.reddit.com/login/'
}

const WINDOW_TITLE: Record<Platform, string> = {
  instagram: 'Connexion à Instagram',
  x: 'Connexion à X',
  reddit: 'Connexion à Reddit'
}

/**
 * Electron s'annonce par défaut comme « Electron/43 », ce qu'aucun navigateur réel ne
 * fait — c'est une signature immédiate. On s'annonce donc comme le Chrome que nous sommes
 * réellement : le moteur est bien celui-là, seule l'étiquette est corrigée. La même chaîne
 * sert à la fenêtre de connexion et aux requêtes, sinon l'incohérence serait plus
 * suspecte que l'un ou l'autre pris séparément.
 */
export function userAgent(): string {
  const chrome = process.versions.chrome.split('.')[0]
  const platform =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : 'Windows NT 10.0; Win64; x64'
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36`
}

export function sessionFor(platform: Platform): Session {
  const partition = session.fromPartition(PARTITION[platform])
  partition.setUserAgent(userAgent())
  return partition
}

export async function cookiesFor(platform: Platform, url?: string): Promise<Map<string, string>> {
  const cookies = await sessionFor(platform).cookies.get({ url: url ?? AUTH_COOKIE[platform].url })
  return new Map(cookies.map((c) => [c.name, c.value]))
}

export async function isConnected(platform: Platform): Promise<boolean> {
  const { name } = AUTH_COOKIE[platform]
  const cookies = await cookiesFor(platform)
  return Boolean(cookies.get(name))
}

/** En-tête `Cookie` complet pour une requête sortante. */
export async function cookieHeader(platform: Platform, url: string): Promise<string> {
  const cookies = await sessionFor(platform).cookies.get({ url })
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

export class LoginCancelled extends Error {
  constructor() {
    super('Connexion annulée')
    this.name = 'LoginCancelled'
  }
}

/**
 * Ouvre la vraie page de connexion de la plateforme dans une fenêtre à part, et se
 * referme dès que le cookie d'authentification apparaît.
 *
 * C'est la page officielle, dans une session isolée : la double authentification, les
 * captchas et les vérifications par e-mail fonctionnent normalement, et Magpie ne voit à
 * aucun moment le mot de passe — il n'a accès qu'au cookie déposé à l'arrivée.
 */
export function openLogin(platform: Platform, parent?: BrowserWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    const ses = sessionFor(platform)
    const { name, url: cookieUrl } = AUTH_COOKIE[platform]

    const win = new BrowserWindow({
      width: 520,
      height: 760,
      parent,
      modal: Boolean(parent),
      title: WINDOW_TITLE[platform],
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true }
    })

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') || url.startsWith('http://')) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            parent: win,
            autoHideMenuBar: true,
            webPreferences: {
              session: ses,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true
            }
          }
        }
      }
      return { action: 'deny' }
    })

    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearInterval(poll)
      if (!win.isDestroyed()) win.destroy()
      fn()
    }

    // On observe l'apparition du cookie plutôt que la navigation : les parcours de
    // connexion passent par un nombre variable d'écrans selon la 2FA et les vérifications,
    // et le seul signal fiable de succès est le cookie lui-même.
    const poll = setInterval(() => {
      void ses.cookies
        .get({ url: cookieUrl, name })
        .then((found) => {
          if (found.length > 0) finish(resolve)
        })
        .catch(() => {})
    }, 700)

    win.on('closed', () => finish(() => reject(new LoginCancelled())))

    void win
      .loadURL(LOGIN_URL[platform], { userAgent: userAgent() })
      .catch((error) => finish(() => reject(error)))
  })
}

/** Purge réellement la partition : cookies, stockage, cache. */
export async function disconnect(platform: Platform): Promise<void> {
  const ses = sessionFor(platform)
  await ses.clearStorageData()
  await ses.clearCache()
}
