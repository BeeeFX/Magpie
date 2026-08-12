import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  shell,
  Tray
} from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { closeDb, getDb, mediaDir } from './db'
import { registerIpc } from './ipc'
import { countPosts, recentAiCandidateIds, repairMissingSyncDates } from './db/queries'
import { backfillRuleTags } from './tagging/rules'
import { processPendingMedia, THUMB_NAME_PATTERN, VIDEO_NAME_PATTERN } from './media/cache'
import { applyTheme, readSettings } from './settings'
import { syncEngine } from './sync/engine'
import { repairOversizedVideos } from './sync/repair'
import { aiTagger } from './tagging/ai'
import type { SyncPhase } from '@shared/types'
import { initializeUpdater, stopUpdater } from './updater'
import { seedIfEmpty } from './fixtures/seed'

const isDev = !app.isPackaged

// Les captures et tests visuels utilisent un profil jetable, jamais la bibliothèque du
// développeur. Ces deux variables n'ont aucun effet dans l'application distribuée.
if (isDev && process.env['MAGPIE_DEV_DATA_DIR']) {
  app.setPath('userData', process.env['MAGPIE_DEV_DATA_DIR'])
}

// Doit être déclaré avant `app.whenReady()`. `magpie://` sert les médias en cache au
// renderer sans avoir à ouvrir `file://`, ce qui permet de garder une CSP stricte.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'magpie',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let scheduleTimer: NodeJS.Timeout | null = null
let lastScheduledSync = Date.now()
let quitting = false
const previousSyncPhase: Partial<Record<string, SyncPhase>> = {}
const previousSyncAdded: Partial<Record<string, number>> = {}
const syncStartedAt: Partial<Record<string, number>> = {}

/** Hauteur de notre barre de titre ; les boutons système s'y superposent. Doit rester
 *  égale à la hauteur de `.topbar` côté CSS, sinon les boutons sont décalés. */
const TITLE_BAR_HEIGHT = 52

function overlayColors(isDark: boolean): { color: string; symbolColor: string } {
  // La couleur de fond doit correspondre exactement à celle de la barre côté CSS, sinon
  // un rectangle se détache derrière les boutons.
  return isDark
    ? { color: '#131316', symbolColor: '#c8c8d2' }
    : { color: '#ffffff', symbolColor: '#3a3a44' }
}

function createWindow(): void {
  const isDark = applyTheme()

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: isDark ? '#17171a' : '#ffffff',
    title: 'Magpie',
    icon: join(app.getAppPath(), 'build', 'icon.png'),
    // Le cadre natif est remplacé par le nôtre : c'est ce qui sépare une application de
    // bureau d'une page web dans une fenêtre. Sous Windows, `titleBarOverlay` laisse l'OS
    // dessiner ses propres boutons, aux couleurs qu'on lui donne ; sous macOS,
    // `hiddenInset` conserve les pastilles, simplement décalées.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 16, y: 15 } }
      : { titleBarOverlay: { ...overlayColors(isDark), height: TITLE_BAR_HEIGHT } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => {
    if (!quitting && readSettings().trayEnabled) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  // Un lien cliqué dans le renderer part dans le navigateur, jamais dans une fenêtre
  // Electron sans garde-fou.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const rendererUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
    const allowed = isDev
      ? url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost')
      : url.startsWith(rendererUrl)
    if (!allowed) event.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  mainWindow?.show()
  mainWindow?.focus()
}

function refreshBackgroundFeatures(): void {
  const settings = readSettings()

  if (settings.trayEnabled && !tray) {
    const icon = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png')).resize({
      width: 18,
      height: 18
    })
    tray = new Tray(icon)
    tray.setToolTip('Magpie')
    tray.on('click', showMainWindow)
  } else if (!settings.trayEnabled && tray) {
    tray.destroy()
    tray = null
  }

  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Ouvrir Magpie', click: showMainWindow },
      { label: 'Synchroniser maintenant', click: () => void syncEngine.syncAll() },
      { type: 'separator' },
      {
        label: 'Quitter',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )

  if (scheduleTimer) clearInterval(scheduleTimer)
  scheduleTimer = null
  const interval =
    settings.syncSchedule === 'hourly'
      ? 60 * 60 * 1000
      : settings.syncSchedule === '6h'
        ? 6 * 60 * 60 * 1000
        : settings.syncSchedule === 'daily'
          ? 24 * 60 * 60 * 1000
          : 0
  if (interval > 0) {
    scheduleTimer = setInterval(() => {
      if (Date.now() - lastScheduledSync < interval || syncEngine.isRunning()) return
      lastScheduledSync = Date.now()
      void syncEngine.syncAll()
    }, 60 * 1000)
  }
}

/** Rejoue le thème effectif partout : boutons système, fond de fenêtre, renderer. */
export function syncTheme(): void {
  const isDark = applyTheme()
  if (!mainWindow || mainWindow.isDestroyed()) return

  mainWindow.setBackgroundColor(isDark ? '#17171a' : '#ffffff')
  if (process.platform !== 'darwin') {
    mainWindow.setTitleBarOverlay({ ...overlayColors(isDark), height: TITLE_BAR_HEIGHT })
  }
  mainWindow.webContents.send('theme:changed', isDark)
}

function registerMediaProtocol(): void {
  protocol.handle('magpie', async (request) => {
    const url = new URL(request.url)
    const name = decodeURIComponent(url.pathname.replace(/^\//, ''))

    // Le nom vient de la base, mais on le revalide : c'est la seule chose qui empêche un
    // chemin construit ailleurs de sortir du dossier de cache.
    const valid =
      (url.host === 'thumb' && THUMB_NAME_PATTERN.test(name)) ||
      (url.host === 'video' && VIDEO_NAME_PATTERN.test(name))
    if (!valid) return new Response('Bad request', { status: 400 })

    // `net.fetch` honore les requêtes par plage, ce dont l'élément vidéo a besoin pour
    // démarrer sans charger tout le fichier.
    return net.fetch(pathToFileURL(join(mediaDir(), name)).toString())
  })
}

let mediaDraining = false
let mediaQueuedAgain = false
let mediaPaused = false
let mediaPauseWaiters: Array<() => void> = []
let mediaAbortController: AbortController | null = null

async function pauseMediaQueue(): Promise<void> {
  mediaPaused = true
  mediaAbortController?.abort()
  if (!mediaDraining) return
  await new Promise<void>((resolve) => mediaPauseWaiters.push(resolve))
}

function resumeMediaQueue(): void {
  mediaPaused = false
  void drainMediaQueue()
}

/**
 * Traite les médias en attente, une passe à la fois. Une demande arrivée pendant une
 * passe en cours est mémorisée et rejouée à la fin, pour qu'aucune page rapatriée ne
 * reste sans vignette.
 */
async function drainMediaQueue(): Promise<void> {
  if (mediaPaused) {
    mediaQueuedAgain = true
    return
  }
  if (mediaDraining) {
    mediaQueuedAgain = true
    return
  }

  mediaDraining = true
  try {
    do {
      mediaQueuedAgain = false
      mediaAbortController = new AbortController()
      const result = await processPendingMedia(
        (progress) => mainWindow?.webContents.send('cache:progress', progress),
        4,
        () => mediaPaused,
        mediaAbortController.signal
      )
      if (result.total > 0) mainWindow?.webContents.send('library:updated')
    } while (mediaQueuedAgain && !mediaPaused)
  } catch (err) {
    console.error('[magpie] Cache média :', err)
  } finally {
    mediaAbortController = null
    mediaDraining = false
    const waiters = mediaPauseWaiters
    mediaPauseWaiters = []
    for (const resolve of waiters) resolve()
    mainWindow?.webContents.send('library:updated')
  }
}

async function bootstrap(): Promise<void> {
  getDb()

  if (isDev && process.env['MAGPIE_DEV_DEMO'] === '1') seedIfEmpty(false)

  // Aucune donnée de démonstration n'est chargée automatiquement : une application qui
  // s'ouvre sur des posts inventés ne montre pas ce qu'elle fait, elle le mime. La
  // bibliothèque de démonstration reste disponible à la demande depuis les réglages.
  console.log(`[magpie] Base : ${countPosts()} posts.`)

  const oversized = repairOversizedVideos()
  if (oversized > 0) console.log(`[magpie] Clips surdimensionnés remplacés : ${oversized}.`)

  const repaired = repairMissingSyncDates()
  if (repaired > 0) console.log(`[magpie] Date de synchronisation réparée : ${repaired} compte(s).`)

  const backfilled = backfillRuleTags()
  if (backfilled.posts > 0) {
    console.log(`[magpie] Règles de tags : ${backfilled.tagged}/${backfilled.posts} posts tagués.`)
  }

  // Le cache tourne en tâche de fond : la grille s'affiche tout de suite et se remplit
  // au fil de l'eau, exactement comme pendant un vrai backfill.
  void drainMediaQueue().then(async () => {
    if (isDev) {
      const { writePreviewSnapshot } = await import('./dev/preview-snapshot')
      writePreviewSnapshot()
    }
  })
}

void app.whenReady().then(async () => {
  registerMediaProtocol()
  registerIpc({
    onThemeChange: syncTheme,
    drainMedia: () => void drainMediaQueue(),
    pauseMedia: pauseMediaQueue,
    resumeMedia: resumeMediaQueue,
    onSettingsChange: refreshBackgroundFeatures
  })
  createWindow()
  refreshBackgroundFeatures()
  initializeUpdater({
    getWindow: () => mainWindow,
    beforeInstall: () => {
      quitting = true
    },
    broadcast: (state) => mainWindow?.webContents.send('updates:state', state)
  })

  // La progression du sync remonte en direct : la grille se remplit pendant le backfill
  // plutôt qu'à la fin. Le cache est sérialisé — chaque page ajoutée déclencherait sinon
  // une passe concurrente, et elles se disputeraient les mêmes fichiers.
  syncEngine.subscribe((state) => {
    mainWindow?.webContents.send('sync:state', state)
    for (const platform of ['instagram', 'x', 'reddit'] as const) {
      const phase = state.byPlatform[platform].phase
      const added = state.byPlatform[platform].added
      if (phase === 'running' && previousSyncPhase[platform] !== 'running') {
        syncStartedAt[platform] = Date.now()
      }
      if (added > (previousSyncAdded[platform] ?? 0)) void drainMediaQueue()
      if (
        phase === 'done' &&
        previousSyncPhase[platform] !== 'done' &&
        state.byPlatform[platform].added > 0 &&
        readSettings().autoTagEnabled
      ) {
        const ids = recentAiCandidateIds(platform, syncStartedAt[platform] ?? Date.now())
        if (ids.length > 0) void aiTagger.start(ids)
      }
      previousSyncPhase[platform] = phase
      previousSyncAdded[platform] = added
    }
  })

  aiTagger.subscribe((progress) => {
    mainWindow?.webContents.send('ai:progress', progress)
    if (!progress.running) mainWindow?.webContents.send('library:updated')
  })

  // Le thème « système » doit suivre les changements de l'OS en direct.
  nativeTheme.on('updated', () => syncTheme())

  await bootstrap()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error: unknown) => {
  dialog.showErrorBox('Bibliothèque Magpie inaccessible', (error as Error).message)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !readSettings().trayEnabled) app.quit()
})

app.on('before-quit', () => {
  quitting = true
  if (scheduleTimer) clearInterval(scheduleTimer)
  stopUpdater()
  closeDb()
})
