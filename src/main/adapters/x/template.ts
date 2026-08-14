import { BrowserWindow } from 'electron'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../../db'
import { sessionFor, userAgent } from '../session'
import type { ContentSource } from '@shared/types'

/**
 * « Apprendre puis rejouer » — voir SPEC.md §5.2.
 *
 * L'endpoint des signets de X est du GraphQL dont l'identifiant de requête, les drapeaux
 * de fonctionnalités et plusieurs en-têtes changent à chaque déploiement. Les coder en dur
 * garantit une panne à brève échéance.
 *
 * On ouvre donc une fois la page des signets dans une fenêtre invisible, on intercepte la
 * requête que la page émet **d'elle-même**, et on en garde le gabarit. Le moteur de sync
 * rejoue ensuite cette requête en ne changeant que le curseur. Quand X change quelque
 * chose, la rejouée échoue, on réapprend, et l'adaptateur se répare seul.
 */

export interface RequestTemplate {
  url: string
  headers: Record<string, string>
  learnedAt: number
}

const BOOKMARKS_URL = 'https://x.com/i/bookmarks'

/** En-têtes recalculés par la couche réseau ou propres à une connexion. */
const DROPPED = new Set([
  'host',
  'connection',
  'content-length',
  'accept-encoding',
  'cookie',
  'user-agent',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site'
])

function templateFile(source: ContentSource): string {
  return join(dataDir(), `x-${source}-request-template.json`)
}

export function readTemplate(source: ContentSource): RequestTemplate | null {
  try {
    const file = templateFile(source)
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as RequestTemplate
    return parsed.url && parsed.headers ? parsed : null
  } catch {
    return null
  }
}

export function forgetTemplate(source?: ContentSource): void {
  for (const item of source ? [source] : (['saved', 'liked'] as const)) {
    rmSync(templateFile(item), { force: true })
  }
}

function saveTemplate(source: ContentSource, template: RequestTemplate): void {
  writeFileSync(templateFile(source), JSON.stringify(template, null, 2))
}

/**
 * Ouvre la page des signets hors écran et capture la requête GraphQL correspondante.
 * La fenêtre est fermée dès la capture — elle n'existe que le temps d'observer.
 */
export function learnTemplate(source: ContentSource, timeoutMs = 45000): Promise<RequestTemplate> {
  return new Promise((resolve, reject) => {
    const ses = sessionFor('x')
    let settled = false

    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false }
    })

    const cleanup = (): void => {
      // Le filtre est global à la session : on le retire pour ne pas laisser d'écouteur
      // actif entre deux apprentissages.
      ses.webRequest.onBeforeSendHeaders({ urls: ['*://*.x.com/i/api/graphql/*'] }, null)
      clearTimeout(timer)
      if (!win.isDestroyed()) win.destroy()
    }

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }

    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              "La page des signets de X n'a pas émis sa requête à temps. Vérifiez que le compte est bien connecté."
            )
          )
        ),
      timeoutMs
    )

    ses.webRequest.onBeforeSendHeaders(
      { urls: ['*://*.x.com/i/api/graphql/*'] },
      (details, callback) => {
        callback({ requestHeaders: details.requestHeaders })

        const operation = source === 'liked' ? 'Likes' : 'Bookmarks'
        if (settled || !new RegExp(`/${operation}(?:\\?|$)`).test(details.url)) return

        const headers: Record<string, string> = {}
        for (const [name, value] of Object.entries(details.requestHeaders)) {
          if (DROPPED.has(name.toLowerCase())) continue
          headers[name] = Array.isArray(value) ? value[0] : String(value)
        }

        finish(() => {
          const template: RequestTemplate = { url: details.url, headers, learnedAt: Date.now() }
          saveTemplate(source, template)
          resolve(template)
        })
      }
    )

    win.webContents.on('did-fail-load', (_e, code, description) => {
      if (code === -3) return // navigation annulée par la page elle-même, sans conséquence
      finish(() => reject(new Error(`Chargement de X impossible : ${description}`)))
    })

    if (source === 'saved') {
      void win.loadURL(BOOKMARKS_URL, { userAgent: userAgent() })
    } else {
      // Le lien de profil de la session est la seule route stable vers ses likes.
      win.webContents.once('did-finish-load', () => {
        void win.webContents
          .executeJavaScript(
            `document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.href || ''`
          )
          .then((profile: string) => {
            if (profile && !win.isDestroyed()) {
              void win.loadURL(`${profile.replace(/\/$/, '')}/likes`, { userAgent: userAgent() })
            }
          })
      })
      void win.loadURL('https://x.com/home', { userAgent: userAgent() })
    }
  })
}

/**
 * Réécrit le curseur dans le gabarit. Les `variables` sont un JSON encodé dans la chaîne
 * de requête : on le décode, on remplace le seul champ qui nous intéresse, et on laisse
 * tout le reste — y compris les drapeaux de fonctionnalités — exactement tel qu'appris.
 */
export function withCursor(template: RequestTemplate, cursor: string | null): string {
  const url = new URL(template.url)
  const raw = url.searchParams.get('variables')
  if (!raw) return url.toString()

  try {
    const variables = JSON.parse(raw) as Record<string, unknown>
    if (cursor) variables.cursor = cursor
    else delete variables.cursor
    url.searchParams.set('variables', JSON.stringify(variables))
  } catch {
    /* variables illisibles : on rejoue le gabarit tel quel, l'appel échouera proprement */
  }

  return url.toString()
}
