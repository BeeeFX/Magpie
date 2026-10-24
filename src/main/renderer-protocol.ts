import { app, BrowserWindow, net, protocol } from 'electron'
import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Le renderer servi par `app://magpie/`, et plus par `file://`.
 *
 * Chargée depuis `file://`, la page héritait des privilèges qu'Electron accorde encore à ce
 * protocole (le fusible `GrantFileProtocolExtraPrivileges`) : lire par `fetch` n'importe quel
 * fichier du disque, et, pour la CSP, `'self'` désignait **tout** `file://`. Une injection dans
 * le renderer — une légende mal échappée un jour — pouvait donc lire un fichier arbitraire et
 * le faire sortir par `shell:openExternal`, ou exécuter comme script n'importe quel fichier
 * déposé sur le disque. Servie par un schéma à nous, l'origine se réduit au dossier
 * `out/renderer`, et le fusible est coupé dans `electron-builder.yml`.
 */

export const RENDERER_SCHEME = 'app'
const RENDERER_HOST = 'magpie'
export const RENDERER_ORIGIN = `${RENDERER_SCHEME}://${RENDERER_HOST}`
export const RENDERER_ENTRY = `${RENDERER_ORIGIN}/index.html`

/**
 * À déclarer avant `ready`, avec `magpie://`. `standard` donne une vraie origine et la
 * résolution des chemins relatifs qu'émet Vite ; `secure` fait de la page un contexte sûr —
 * `navigator.clipboard` n'existe pas sans ; `codeCache` garde le cache V8 que `file://` avait.
 */
export const RENDERER_SCHEME_PRIVILEGES = {
  scheme: RENDERER_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true }
}

/** Ce que la fenêtre principale a le droit d'afficher. */
export function isRendererUrl(url: string): boolean {
  return url.startsWith(`${RENDERER_ORIGIN}/`)
}

function rendererRoot(): string {
  /* Pas `__dirname` : le bundler peut sortir ce module dans `out/main/chunks/`. La racine de
     l'application est stable, empaquetée ou non (voir `tagging/inference.ts`). */
  return join(app.getAppPath(), 'out', 'renderer')
}

const notFound = (): Response => new Response('Not found', { status: 404 })

export function registerRendererProtocol(): void {
  const root = rendererRoot()
  protocol.handle(RENDERER_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 })
    }
    const url = new URL(request.url)
    if (url.host !== RENDERER_HOST) return notFound()

    /* Le parseur d'URL résout déjà `..`, mais pas `%2f` ni `%5c` : décodés, ils redeviennent
       des séparateurs et `..%2f..%2f` sortirait du dossier. On vérifie donc le chemin final,
       une fois décodé et résolu, et pas l'URL. */
    let pathname: string
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return notFound()
    }
    if (pathname.includes('\0')) return notFound()
    const file = resolve(root, `.${pathname}`)
    const inside = relative(root, file)
    if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) {
      return notFound()
    }

    try {
      // Même chemin que `magpie://thumb` : `net.fetch` lit l'archive asar et pose le type MIME.
      return await net.fetch(pathToFileURL(file).toString())
    } catch {
      return notFound()
    }
  })
}

/**
 * Les préférences d'affichage suivent le renderer dans sa nouvelle origine.
 *
 * Le filtre, le tri, le mode de grille, la densité, le volume vivent dans le `localStorage`
 * (`magpie-ui`, voir `store.ts`), et un `localStorage` appartient à une origine. Passer de
 * `file://` à `app://magpie` les aurait remis à zéro à la mise à jour, sans un mot. On les
 * recopie donc, une fois : une fenêtre invisible lit l'ancienne origine, une autre écrit la
 * nouvelle, avant que la vraie fenêtre ne s'ouvre et ne relise ses préférences.
 *
 * Un échec ne coûte que ces préférences : on le journalise et on n'y revient pas — le relancer
 * à chaque démarrage retarderait chaque ouverture pour un gain qui s'amenuise.
 */
const UI_STORAGE_KEY = 'magpie-ui'
const STEP_TIMEOUT_MS = 5000

export async function migrateUiStorage(): Promise<void> {
  const marker = join(app.getPath('userData'), 'renderer-origin')
  if (existsSync(marker)) return

  const blank = join(app.getPath('temp'), `magpie-origin-${process.pid}.html`)
  try {
    /* N'importe quel document `file://` partage le stockage de l'ancienne page : ils n'ont
       qu'une origine à eux tous. Une page vide suffit, et n'exécute rien de l'application.

       Fusible `GrantFileProtocolExtraPrivileges` coupé, un document `file://` n'a plus accès
       à son `localStorage` (« Access is denied for this document ») : la reprise échouait
       dans la version installée, et seulement là. `webSecurity: false` le lui rend, pour
       cette fenêtre-ci : cachée, sans preload, elle n'affiche que la page vide qu'on vient
       d'écrire et n'exécute que la ligne ci-dessous, puis disparaît. */
    await writeFile(blank, '<!doctype html><title></title>')
    const saved = await inHiddenWindow<string | null>(
      pathToFileURL(blank).toString(),
      `localStorage.getItem(${JSON.stringify(UI_STORAGE_KEY)})`,
      { webSecurity: false }
    )
    if (saved !== null) {
      /* Une adresse sans fichier suffit à ouvrir un document dans la nouvelle origine, sans
         charger l'application. On n'écrase pas une valeur déjà là. */
      await inHiddenWindow<void>(
        `${RENDERER_ORIGIN}/__stockage__`,
        `localStorage.getItem(${JSON.stringify(UI_STORAGE_KEY)}) === null && ` +
          `localStorage.setItem(${JSON.stringify(UI_STORAGE_KEY)}, ${JSON.stringify(saved)})`
      )
      console.log('[magpie] Préférences d’affichage reprises de file:// vers app://magpie.')
    }
  } catch (error) {
    console.warn('[magpie] Préférences d’affichage non reprises de file:// :', error)
  } finally {
    await rm(blank, { force: true }).catch(() => {})
  }
  await writeFile(marker, `${RENDERER_ORIGIN}\n`).catch((error: unknown) => {
    console.warn('[magpie] Marqueur d’origine non écrit :', error)
  })
}

async function inHiddenWindow<T>(
  url: string,
  script: string,
  preferences: { webSecurity?: boolean } = {}
): Promise<T> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, ...preferences }
  })
  try {
    await withTimeout(win.loadURL(url), url)
    return (await withTimeout(win.webContents.executeJavaScript(script), url)) as T
  } finally {
    win.destroy()
  }
}

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} : délai dépassé`)), STEP_TIMEOUT_MS)
    })
  ]).finally(() => clearTimeout(timer))
}
