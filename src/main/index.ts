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
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { closeDb, getDb, mediaDir } from './db'
import { registerIpc } from './ipc'
import {
  countPosts,
  playbackMediaSource,
  recentAiCandidateIds,
  repairMissingSyncDates
} from './db/queries'
import { backfillRuleTags } from './tagging/rules'
import { processPendingMedia, THUMB_NAME_PATTERN, touchCachedThumbnails, VIDEO_NAME_PATTERN } from './media/cache'
import { applyTheme, readSettings } from './settings'
import { syncEngine } from './sync/engine'
import { repairOversizedVideos } from './sync/repair'
import { aiTagger } from './tagging/ai'
import { localOrganizer } from './tagging/organize'
import type { SyncPhase } from '@shared/types'
import { initializeUpdater, stopUpdater } from './updater'
import { seedIfEmpty } from './fixtures/seed'
import { parseByteRange } from './media/range'
import { parseRemoteMediaUrl } from './media/remote'
import { sessionFor, userAgent } from './adapters/session'

const isDev = !app.isPackaged
const APP_ID = 'tv.electrictheatre.magpie'
const isPrimaryInstance = app.requestSingleInstanceLock()

// Une seule instance doit posséder la base et les workers média. Sans ce verrou, chaque
// clic sur le raccourci lançait une nouvelle copie complète de Magpie qui travaillait sur
// la même bibliothèque et multipliait fortement la mémoire et la charge disque.
if (!isPrimaryInstance) app.quit()

// Le raccourci NSIS et le processus doivent annoncer exactement la même identité.
// Sinon Windows peut créer un second bouton dans la barre des tâches au lancement.
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

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
let windowInteractionActive = false
let windowInteractionTimer: NodeJS.Timeout | null = null
let scheduleTimer: NodeJS.Timeout | null = null
let lastScheduledSync = Date.now()
let quitting = false
const previousSyncPhase: Partial<Record<string, SyncPhase>> = {}
const previousSyncAdded: Partial<Record<string, number>> = {}
const syncStartedAt: Partial<Record<string, number>> = {}

if (isPrimaryInstance) {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

/** Hauteur de notre barre de titre ; les boutons système s'y superposent. Doit rester
 *  égale à la hauteur de `.topbar` côté CSS, sinon les boutons sont décalés. */
const TITLE_BAR_HEIGHT = 52

function appIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
}

function markWindowInteraction(): void {
  if (!windowInteractionActive) {
    windowInteractionActive = true
    mainWindow?.webContents.send('window:interaction', true)
  }
  if (windowInteractionTimer) clearTimeout(windowInteractionTimer)
  windowInteractionTimer = setTimeout(() => {
    windowInteractionTimer = null
    windowInteractionActive = false
    mainWindow?.webContents.send('window:interaction', false)
  }, 140)
}

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
    icon: appIconPath(),
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

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    updateTray()
  })
  mainWindow.on('close', (event) => {
    if (!quitting && readSettings().trayEnabled) {
      event.preventDefault()
      mainWindow?.hide()
      updateTray()
    }
  })
  mainWindow.on('move', markWindowInteraction)
  mainWindow.on('resize', markWindowInteraction)

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
  updateTray()
}

function updateTray(): void {
  // L'icône représente le processus en arrière-plan, pas l'état de la fenêtre.
  // Elle reste donc présente tant que Magpie tourne.
  const shouldShow = readSettings().trayEnabled
  if (shouldShow && !tray) {
    const icon = nativeImage.createFromPath(appIconPath()).resize({
      width: 18,
      height: 18
    })
    tray = new Tray(icon)
    tray.setToolTip('Magpie')
    tray.on('click', showMainWindow)
  } else if (!shouldShow && tray) {
    tray.destroy()
    tray = null
  }

  if (tray) {
    tray.setContextMenu(
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
  }
}

function refreshBackgroundFeatures(): void {
  const settings = readSettings()
  updateTray()

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

    if (url.host === 'remote') {
      const remoteRequest = parseRemoteMediaUrl(request.url)
      if (!remoteRequest) return new Response('Bad request', { status: 400 })
      const { postId, mediaIndex: idx, kind, quality } = remoteRequest

      const media = playbackMediaSource(postId, idx, kind, quality)
      if (!media?.source || !/^https?:\/\//i.test(media.source)) {
        return new Response('Media unavailable', { status: 404 })
      }

      const origin =
        media.platform === 'instagram'
          ? 'https://www.instagram.com/'
          : media.platform === 'x'
            ? 'https://x.com/'
            : 'https://www.reddit.com/'
      const headers = new Headers({
        Accept:
          kind === 'video'
            ? 'video/*,application/octet-stream,*/*;q=0.8'
            : 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: origin,
        'User-Agent': userAgent(),
        'Cache-Control': 'no-store'
      })
      const range = request.headers.get('range')
      if (range) headers.set('Range', range)

      try {
        const remote = await sessionFor(media.platform).fetch(media.source, {
          method: request.method === 'HEAD' ? 'HEAD' : 'GET',
          headers,
          credentials: 'include',
          redirect: 'follow'
        })
        const responseHeaders = new Headers(remote.headers)
        responseHeaders.set('Cache-Control', 'no-store')
        responseHeaders.delete('set-cookie')
        responseHeaders.delete('set-cookie2')
        return new Response(request.method === 'HEAD' ? null : remote.body, {
          status: remote.status,
          statusText: remote.statusText,
          headers: responseHeaders
        })
      } catch {
        return new Response('Remote media unavailable', { status: 502 })
      }
    }

    const name = decodeURIComponent(url.pathname.replace(/^\//, ''))

    // Le nom vient de la base, mais on le revalide : c'est la seule chose qui empêche un
    // chemin construit ailleurs de sortir du dossier de cache.
    const valid =
      (url.host === 'thumb' && THUMB_NAME_PATTERN.test(name)) ||
      (url.host === 'video' && VIDEO_NAME_PATTERN.test(name))
    if (!valid) return new Response('Bad request', { status: 400 })

    const filePath = join(mediaDir(), name)
    if (url.host === 'thumb') return net.fetch(pathToFileURL(filePath).toString())

    try {
      const file = await stat(filePath)
      const range = parseByteRange(request.headers.get('range'), file.size)
      const commonHeaders = {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/mp4',
        'Cache-Control': 'private, max-age=31536000, immutable'
      }

      if (range === null) {
        return new Response(null, {
          status: 416,
          headers: { ...commonHeaders, 'Content-Range': `bytes */${file.size}` }
        })
      }

      if (range) {
        const length = range.end - range.start + 1
        const body =
          request.method === 'HEAD'
            ? null
            : (Readable.toWeb(
              createReadStream(filePath, { start: range.start, end: range.end })
              ) as unknown as ConstructorParameters<typeof Response>[0])
        return new Response(body, {
          status: 206,
          headers: {
            ...commonHeaders,
            'Content-Length': String(length),
            'Content-Range': `bytes ${range.start}-${range.end}/${file.size}`
          }
        })
      }

      const body =
        request.method === 'HEAD'
          ? null
          : (Readable.toWeb(createReadStream(filePath)) as unknown as ConstructorParameters<
              typeof Response
            >[0])
      return new Response(body, {
        status: 200,
        headers: { ...commonHeaders, 'Content-Length': String(file.size) }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

let mediaDraining = false
let mediaQueuedAgain = false
let mediaPaused = false
let mediaPauseWaiters: Array<() => void> = []
let mediaAbortController: AbortController | null = null
const requestedThumbnailPostIds = new Set<string>()

function requestThumbnailDrain(postIds: string[]): void {
  void touchCachedThumbnails(postIds)
  for (const id of postIds) requestedThumbnailPostIds.add(id)
  void drainMediaQueue()
}

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
    let hasMore = false
    do {
      mediaQueuedAgain = false
      mediaAbortController = new AbortController()
      const settings = readSettings()
      const requested = [...requestedThumbnailPostIds]
      requestedThumbnailPostIds.clear()
      // Le mode léger ne parcourt jamais les milliers de médias en attente : seules
      // les cartes visibles (et leur petite marge de préchargement) alimentent la file.
      if (settings.mediaStorageMode === 'stream' && requested.length === 0) break
      const result = await processPendingMedia(
        (progress) => mainWindow?.webContents.send('cache:progress', progress),
        mainWindow?.isVisible() ? 2 : 3,
        () => mediaPaused,
        mediaAbortController.signal,
        settings.mediaStorageMode === 'stream' ? requested : undefined
      )
      hasMore = result.hasMore || requestedThumbnailPostIds.size > 0
      if (result.total > 0) mainWindow?.webContents.send('library:updated')
      // Rend régulièrement la main à Electron entre deux lots afin que déplacer ou
      // redimensionner la fenêtre reste instantané pendant un gros rattrapage.
      if (hasMore && !mediaPaused) await new Promise((resolve) => setTimeout(resolve, 25))
    } while ((mediaQueuedAgain || hasMore) && !mediaPaused)
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

if (isPrimaryInstance) void app.whenReady().then(async () => {
  registerMediaProtocol()
  registerIpc({
    onThemeChange: syncTheme,
    drainMedia: () => void drainMediaQueue(),
    requestThumbnails: requestThumbnailDrain,
    pauseMedia: pauseMediaQueue,
    resumeMedia: resumeMediaQueue,
    onSettingsChange: () => {
      refreshBackgroundFeatures()
      // Passer en mode hors-ligne doit commencer à remplir le cache sans attendre un
      // redémarrage. En mode léger, les workers consultent le réglage avant chaque clip.
      void drainMediaQueue()
    }
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

  localOrganizer.subscribe((value) => {
    mainWindow?.webContents.send('organizer:progress', value)
  })

  // Le thème « système » doit suivre les changements de l'OS en direct.
  nativeTheme.on('updated', () => syncTheme())

  await bootstrap()

  // Une vérification incrémentale au lancement ne reparcourt pas tout l'historique : le
  // moteur s'arrête dès qu'il retrouve quelques pages déjà connues. Le premier compte
  // connecté déclenche déjà son propre rattrapage depuis l'accueil.
  const startupSettings = readSettings()
  if (startupSettings.onboardingDone && startupSettings.syncOnLaunch) {
    lastScheduledSync = Date.now()
    void syncEngine.syncAll()
  }

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
  if (windowInteractionTimer) clearTimeout(windowInteractionTimer)
  stopUpdater()
  closeDb()
})
