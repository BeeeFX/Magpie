import { app, BrowserWindow, session, type Session } from 'electron'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Platform } from '@shared/types'
import { PLATFORMS } from '@shared/types'

/**
 * Sessions par plateforme. Voir SPEC.md §5 et §10.
 *
 * Chaque plateforme vit dans une partition Electron isolée : ses cookies ne fuient pas
 * vers les autres, et « Déconnecter » purge réellement quelque chose.
 *
 * Ce commentaire affirmait que le stockage était « celui, chiffré, de Chromium ». Il ne
 * l'était pas : Electron écrit ses cookies **en clair** tant que le fusible
 * `EnableCookieEncryption` n'est pas posé, et il ne l'était pas — le `sessionid` d'Instagram et
 * l'`auth_token` de X se lisaient dans `userData/Partitions/magpie-*`. Le fusible est
 * désormais posé à l'empaquetage (`electron-builder.yml`) : la version installée chiffre avec
 * la clé du système (DPAPI sous Windows). Un lancement de développement, qui tourne sur le
 * binaire Electron non modifié, les écrit toujours en clair.
 *
 * Ce que ces fenêtres ont le droit d'ouvrir, de demander et de visiter se décide dans
 * `security.ts`, pour elles comme pour toutes les autres.
 */

/**
 * Le développement ne se connecte pas dans les partitions de la version installée.
 *
 * Le fusible de chiffrement n'est posé que sur le binaire empaqueté. Un Electron sans lui,
 * devant un magasin chiffré, ne sait pas en lire les cookies — et **les efface** (constaté :
 * la table était vide après un seul lancement). Or le développement et l'application
 * installée partagent le même profil — les deux s'appellent `magpie` dans leur `package.json`,
 * donc `%APPDATA%\magpie` : un `npm run dev` aurait déconnecté l'application installée. Le
 * développement a donc ses propres partitions, et s'y connecte une fois.
 */
function partition(platform: Platform): string {
  // Lu à l'appel, pas au chargement : les contrôles importent ce module hors d'Electron.
  return `${app.isPackaged ? 'persist:magpie-' : 'persist:magpie-dev-'}${platform}`
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

/** Les trois partitions, pour leur poser la même politique (`security.ts`). */
export function platformSessions(): Session[] {
  return PLATFORMS.map((platform) => session.fromPartition(partition(platform)))
}

/**
 * Réécrit, chiffrés, les cookies qu'une version antérieure a laissés en clair.
 *
 * Le fusible chiffre ce qui s'écrit, pas ce qui est déjà là : Chromium relit un cookie en
 * clair sans jamais le réécrire (constaté : après un lancement de la version chiffrante, le
 * `sessionid` était toujours en clair dans la base). Or le `sessionid` d'Instagram et
 * l'`auth_token` de X vivent des mois sans être redéposés — ils le seraient restés jusqu'à la
 * prochaine connexion. On les repose donc une fois, à l'identique : Chromium remplace la
 * ligne, chiffrée cette fois (`v10…`). Les cookies des fournisseurs de connexion — Google,
 * Apple, Facebook — vivent dans les mêmes partitions et suivent le même chemin.
 *
 * Seulement dans la version installée, la seule qui chiffre. Un échec laisse le marqueur
 * absent : on réessaiera au prochain lancement, et d'ici là rien n'est perdu.
 */
export async function encryptPlaintextCookies(): Promise<void> {
  if (!app.isPackaged) return
  const marker = join(app.getPath('userData'), 'cookies-encrypted')
  if (existsSync(marker)) return
  let rewritten = 0
  let skipped = 0
  try {
    for (const ses of platformSessions()) {
      for (const cookie of await ses.cookies.get({})) {
        if (!cookie.domain) {
          skipped++
          continue
        }
        const host = cookie.domain.replace(/^\./, '')
        try {
          await ses.cookies.set({
            url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path ?? '/'}`,
            name: cookie.name,
            value: cookie.value,
            // Un cookie d'hôte reste d'hôte : lui donner un domaine l'étendrait aux sous-domaines.
            ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            ...(cookie.session || cookie.expirationDate === undefined
              ? {}
              : { expirationDate: cookie.expirationDate }),
            sameSite: cookie.sameSite
          })
          rewritten++
        } catch {
          skipped++
        }
      }
      await ses.cookies.flushStore()
    }
    await writeFile(marker, 'EnableCookieEncryption\n')
    // Des nombres seulement : ni nom, ni valeur de cookie n'ont à passer par le journal.
    console.log(
      `[magpie] Cookies des plateformes réécrits chiffrés : ${rewritten}` +
        (skipped > 0 ? `, ${skipped} laissé(s) tel(s) quel(s).` : '.')
    )
  } catch (error) {
    console.warn('[magpie] Chiffrement des cookies existants reporté :', error)
  }
}

export function sessionFor(platform: Platform): Session {
  const ses = session.fromPartition(partition(platform))
  ses.setUserAgent(userAgent())
  return ses
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

    /* Les popups — la connexion Facebook d'Instagram, Google et Apple pour X — et les
       navigations de cette fenêtre sont gardés par `security.ts` : `https:` seulement, dans
       cette même partition, sans aucune permission. Ce gestionnaire-ci acceptait aussi le
       `http:` en clair, et ne regardait pas où la fenêtre elle-même partait. */

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
