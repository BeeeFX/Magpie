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
  countPendingClips,
  countPendingThumbnails,
  countPosts,
  recentAiCandidateIds,
  repairMissingSyncDates
} from './db/queries'
import { backfillRuleTags } from './tagging/rules'
import {
  processPendingMedia,
  THUMB_NAME_PATTERN,
  touchCachedThumbnails,
  VIDEO_NAME_PATTERN,
  resetCacheUsage
} from './media/cache'
import { say } from './messages'
import { applyTheme, readSettings } from './settings'
import { syncEngine } from './sync/engine'
import { repairMissingCacheFiles, repairOversizedVideos } from './sync/repair'
import { aiTagger } from './tagging/ai'
import { applyRememberedOrganizerRules, localOrganizer } from './tagging/organize'
import { stopInference } from './tagging/inference'
import { refreshQueryCollections } from './tagging/collections'
import type {
  AfterSyncStep,
  BackgroundState,
  PostQuery,
  PreloadRequest,
  SyncPhase
} from '@shared/types'
import { AFTER_SYNC_STEPS, DEFAULT_QUERY, PUBLIC_PLATFORMS } from '@shared/types'
import { backgroundTasks } from './tasks'
import { initializeUpdater, stopUpdater } from './updater'
import { seedIfEmpty } from './fixtures/seed'
import { parseByteRange } from './media/range'
import { parseRemoteMediaUrl, resolveFreshMedia } from './media/remote'
import { streamMedia } from './adapters/http'

const isDev = !app.isPackaged
const APP_ID = 'tv.electrictheatre.magpie'
const isPrimaryInstance = app.requestSingleInstanceLock()

// Une seule instance doit posséder la base et les workers média. Sans ce verrou, chaque
// clic sur le raccourci lançait une nouvelle copie complète de Magpie qui travaillait sur
// la même bibliothèque et multipliait fortement la mémoire et la charge disque.
if (!isPrimaryInstance) app.quit()

/**
 * Les échecs que personne n'attrapait.
 *
 * Il n'y avait aucun de ces deux gestionnaires, et le code appelle beaucoup de promesses en
 * `void` — la synchronisation, la file média, la lecture des images, les minuteries. Une
 * rejetée disparaissait sans laisser de trace : ni journal, ni message, rien à quoi rattacher
 * le symptôme quand l'utilisateur signalait que « ça s'était arrêté tout seul ».
 *
 * On ne quitte pas pour autant. Une étape de fond qui échoue n'a aucune raison d'emporter la
 * fenêtre : la bibliothèque est intacte, et l'application reste utilisable sans elle.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[magpie] Promesse rejetée sans traitement :', reason)
})
process.on('uncaughtException', (error) => {
  console.error('[magpie] Exception non rattrapée :', error)
})

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
let organizerAfterSyncPending = false
let organizerAfterSyncTimer: NodeJS.Timeout | null = null

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
  mainWindow.on('enter-full-screen', () => {
    mainWindow?.webContents.send('window:fullscreen', true)
  })
  mainWindow.on('leave-full-screen', () => {
    mainWindow?.webContents.send('window:fullscreen', false)
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
  updateTray()
}

/** Icône de base, relue une seule fois : la barre système se redessine à chaque progrès,
 *  et relire le fichier à chaque lot serait de la lecture disque pour rien. */
let trayBase: { image: Electron.NativeImage; data: Buffer; width: number; height: number } | null =
  null

/**
 * Pose un voyant dans le coin de l'icône. Un menu contextuel ne se voit que si on
 * l'ouvre ; le point, lui, se remarque du coin de l'œil — c'est tout ce qu'on lui demande.
 *
 * La composition se fait à la main sur le bitmap : le processus principal n'a pas de
 * canevas, et ajouter une dépendance graphique pour six pixels serait disproportionné.
 */
function trayImage(state: BackgroundState): Electron.NativeImage {
  if (!trayBase) {
    const image = nativeImage.createFromPath(appIconPath()).resize({ width: 18, height: 18 })
    const { width, height } = image.getSize()
    trayBase = { image, data: image.toBitmap(), width, height }
  }
  if (state.tasks.length === 0 && !state.cacheFull) return trayBase.image

  const { width, height } = trayBase
  const data = Buffer.from(trayBase.data)

  // Ambre quand il faut décider quelque chose, gris à l'arrêt, bleu quand ça travaille.
  const [b, g, r] = state.cacheFull
    ? [48, 160, 224]
    : state.paused
      ? [150, 150, 150]
      : [235, 140, 60]

  const cx = width - 4.5
  const cy = height - 4.5
  const paint = (radius: number, cb: number, cg: number, cr: number): void => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
        // Le dernier pixel se fond progressivement : sans cela le point paraît carré.
        const cover = Math.max(0, Math.min(1, radius + 0.5 - dist))
        if (cover <= 0) continue
        const i = (y * width + x) * 4
        data[i] = cb * cover + data[i] * (1 - cover)
        data[i + 1] = cg * cover + data[i + 1] * (1 - cover)
        data[i + 2] = cr * cover + data[i + 2] * (1 - cover)
        data[i + 3] = 255 * cover + data[i + 3] * (1 - cover)
      }
    }
  }
  // Un liseré sombre détache le voyant aussi bien d'une barre claire que du dessin.
  paint(4, 20, 20, 20)
  paint(2.9, b, g, r)

  return nativeImage.createFromBitmap(data, { width, height })
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
    tray.on('click', showMainWindow)
  } else if (!shouldShow && tray) {
    tray.destroy()
    tray = null
  }
  if (!tray) return

  const state = backgroundTasks.current()
  const busy = state.tasks.length > 0
  tray.setImage(trayImage(state))

  // L'infobulle dit ce qui se passe sans qu'on ait à ouvrir la fenêtre.
  tray.setToolTip(
    busy
      ? `Magpie — ${state.paused ? 'en pause' : 'en cours'} : ${state.tasks
          .map((task) => trayTaskLabel(task))
          .join(', ')}`
      : 'Magpie'
  )

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Ouvrir Magpie', click: showMainWindow },
      { type: 'separator' },
      // Les lignes d'état sont désactivées : elles informent, elles ne s'actionnent pas.
      ...(busy
        ? state.tasks.map((task) => ({ label: `  ${trayTaskLabel(task)}`, enabled: false }))
        : [{ label: '  Rien en cours', enabled: false }]),
      ...(state.cacheFull
        ? [{ label: '  ⚠ Espace de cache saturé', enabled: false }]
        : []),
      ...(busy
        ? [
            {
              label: state.paused ? 'Reprendre les téléchargements' : 'Suspendre les téléchargements',
              click: () => void setDownloadsPaused(!state.paused)
            }
          ]
        : []),
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

function trayTaskLabel(task: BackgroundState['tasks'][number]): string {
  const name =
    task.kind === 'sync'
      ? `Synchronisation ${task.scope ?? ''}`.trim()
      : task.kind === 'thumbnails'
        ? 'Vignettes'
        : task.kind === 'clips'
          ? 'Clips'
          : 'Organisation'
  if (task.total > 0) return `${name} ${task.done}/${task.total}`
  return task.done > 0 ? `${name} (${task.done})` : name
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
      const { kind } = remoteRequest

      // Le lecteur peut rejouer cette URL longtemps après l'avoir obtenue — reprise après
      // pause, déplacement dans la timeline. Le lien est donc revérifié à chaque requête.
      const media = await resolveFreshMedia(remoteRequest)
      if (!media?.source || !/^https?:\/\//i.test(media.source)) {
        return new Response('Media unavailable', { status: 404 })
      }

      try {
        const remote = await streamMedia(media.platform, media.source, {
          method: request.method === 'HEAD' ? 'HEAD' : 'GET',
          range: request.headers.get('range'),
          accept:
            kind === 'video'
              ? 'video/*,application/octet-stream,*/*;q=0.8'
              : 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        })

        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(remote.headers)) {
          const lower = name.toLowerCase()
          // Les cookies de la plateforme n'ont rien à faire dans le renderer, et le corps
          // arrive déjà décodé : réannoncer son encodage ferait décompresser deux fois.
          if (lower.startsWith('set-cookie') || lower === 'content-encoding') continue
          responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value)
        }
        responseHeaders.set('Cache-Control', 'no-store')

        return new Response(remote.body, {
          status: remote.status,
          statusText: remote.statusText,
          headers: responseHeaders
        })
      } catch (error) {
        console.warn('[magpie] Diffusion distante impossible', error)
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

/** Garantit qu'aucun fichier média n'est écrit pendant une migration de bibliothèque. */
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
 * Préchargements demandés : vignettes et clips, sur toute la bibliothèque ou sur le
 * périmètre affiché.
 *
 * Le cache intelligent ne prépare que ce qu'on a fait défiler ; le mode hors-ligne prépare
 * tout mais impose aussi les clips. Ces tâches comblent l'écart sans changer de mode, et
 * empruntent la file existante — deux passes concurrentes se disputeraient les mêmes
 * lignes et le même quota.
 */
interface PreloadJob {
  kind: 'thumbnails' | 'clips'
  query: PostQuery | null
  scope: string | null
  total: number
}

const preloads = new Map<string, PreloadJob>()

function countRemaining(job: PreloadJob): number {
  return job.kind === 'thumbnails'
    ? countPendingThumbnails(true, job.query)
    : countPendingClips(job.query)
}

function publishPreload(id: string, job: PreloadJob): void {
  const remaining = countRemaining(job)
  backgroundTasks.update(id, {
    kind: job.kind,
    scope: job.scope,
    done: Math.max(0, job.total - remaining),
    total: job.total
  })
}

function startPreload(request: PreloadRequest): BackgroundState {
  const kind = request.what
  const id = `preload:${kind}`
  if (preloads.has(id)) return backgroundTasks.current()

  const query = request.query ?? null
  const job: PreloadJob = { kind, query, scope: request.scopeLabel ?? null, total: 0 }
  job.total = countRemaining(job)
  if (job.total === 0) return backgroundTasks.current()

  preloads.set(id, job)
  backgroundTasks.update(id, { kind, scope: job.scope, done: 0, total: job.total })
  void backgroundTasks.refreshCache(false)
  void drainMediaQueue()
  return backgroundTasks.current()
}

function stopPreload(kind: 'thumbnails' | 'clips'): BackgroundState {
  const id = `preload:${kind}`
  if (preloads.delete(id)) {
    mediaAbortController?.abort()
    backgroundTasks.clear(id)
  }
  return backgroundTasks.current()
}

/**
 * Le périmètre de tout ce qui travaille tout seul : les origines réellement affichées.
 *
 * Sans lui, décocher « Likes » cachait les posts de la grille mais laissait Magpie continuer
 * à leur descendre vignettes et clips, à les lire et à les transcrire — des heures et des
 * gigaoctets pour du contenu que plus personne ne voit. Les compteurs annonçaient d'ailleurs
 * ces posts-là, si bien que « 8 200 vidéos à télécharger » ne correspondait à rien de
 * visible dans une bibliothèque de deux mille.
 */
function enabledSourcesQuery(): PostQuery {
  return { ...DEFAULT_QUERY, sources: [...readSettings().contentSources] }
}

/**
 * Attend qu'un préchargement quitte la file.
 *
 * La file média n'a pas d'événement de fin — elle tourne tant qu'il reste quelque chose —
 * donc on regarde le registre plutôt que d'inventer un rappel. Une seconde de granularité
 * pour un travail qui se compte en minutes.
 *
 * Suspendu, on rend la main : cache plein ou pause de l'utilisateur, la tâche reste dans le
 * registre sans jamais avancer, et l'attendre là serait attendre pour toujours.
 */
function awaitPreload(kind: 'thumbnails' | 'clips'): Promise<void> {
  const id = `preload:${kind}`
  if (!preloads.has(id)) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      /* Suspendue seule, la tâche n'avancera pas davantage que suspendue globalement :
         attendre ici serait attendre pour toujours. */
      if (preloads.has(id) && !backgroundTasks.isPaused() && !backgroundTasks.isTaskPaused(id)) {
        return
      }
      clearInterval(timer)
      resolve()
    }, 1000)
    timer.unref?.()
  })
}

/**
 * Les préparations demandées, dans l'ordre, avant que le rangement ne parte.
 *
 * L'ordre n'est pas cosmétique : la lecture d'images tire trois vues d'un clip quand il est
 * là et se contente de la couverture sinon, et la transcription n'a rien à écouter tant que
 * le son n'est pas descendu. Les lancer ensemble ferait le même travail en moins bien.
 */
/**
 * Une seule chaîne à la fois.
 *
 * La synchronisation la déclenche, et « Rattraper maintenant » aussi : lancées ensemble, les
 * deux se disputeraient les mêmes files — deux préchargements sur les mêmes lignes, deux
 * lectures d'images sur les mêmes vignettes. La seconde demande rejoint donc la première au
 * lieu d'en ouvrir une autre.
 */
let afterSyncRun: Promise<void> | null = null

function runAfterSyncSteps(steps: AfterSyncStep[]): Promise<void> {
  if (afterSyncRun) return afterSyncRun
  afterSyncRun = runStepsInOrder(steps).finally(() => {
    afterSyncRun = null
  })
  return afterSyncRun
}

async function runStepsInOrder(steps: AfterSyncStep[]): Promise<void> {
  for (const step of AFTER_SYNC_STEPS) {
    if (!steps.includes(step)) continue
    /* Une synchronisation repartie change la matière sous nos pieds : la préparation
       reprendra derrière elle, avec le nouveau contenu compris. */
    if (syncEngine.isRunning()) return
    /* Suspendu veut dire suspendu. La transcription, elle, attend la reprise dans sa propre
       boucle : lancée ici, elle retiendrait le rangement pour un temps indéfini. */
    if (backgroundTasks.isPaused()) return
    /* Une étape qui échoue n'annule pas les suivantes, ni le rangement : celui-ci reste
       possible avec ce qu'on a. Une transcription en panne empêchait sinon les nouveaux
       posts de rejoindre leurs collections, ce qui est le contraire du service rendu. */
    try {
      if (step === 'thumbnails' || step === 'clips') {
        startPreload({ what: step, query: enabledSourcesQuery() })
        await awaitPreload(step)
      } else if (step === 'images') {
        const { readAllImages } = await import('./tagging/read-images')
        await readAllImages()
      } else {
        const { transcribeAll } = await import('./tagging/transcribe')
        await transcribeAll()
      }
    } catch (error) {
      console.error(`[magpie] Préparation « ${step} » impossible`, error)
    }
  }
}

/** Suspend ou reprend tout ce qui télécharge. Le sync poursuit sa page en cours : la
 *  couper en deux laisserait un curseur incohérent, pour quelques secondes gagnées. */
function setDownloadsPaused(next: boolean): BackgroundState {
  backgroundTasks.setPaused(next)
  if (next) mediaAbortController?.abort()
  else void drainMediaQueue()
  return backgroundTasks.current()
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

      // Les cartes visibles passent toujours devant : pendant un préchargement, on ne veut
      // pas regarder un mur vide en attendant que la passe de fond arrive jusqu'à nous.
      /* Une tâche suspendue n'est plus choisie pour la passe. C'est ce qui rend le bouton
         pause de chaque ligne réel : il écrivait bien `entry.paused`, mais **personne ne le
         lisait ici** — seule la transcription consultait son propre drapeau. Suspendre
         « Images des tuiles » faisait donc basculer la ligne sur « En pause », arrêtait
         l'animation de la barre, effaçait la durée restante — et le travail continuait, le
         disque et le processeur avec.
         Le suspendre ici plutôt qu'à l'entrée de la boucle laisse l'autre tâche avancer :
         mettre les clips en pause ne doit pas arrêter les vignettes. */
      const thumbnailJob = backgroundTasks.isTaskPaused('preload:thumbnails')
        ? undefined
        : preloads.get('preload:thumbnails')
      const clipJob = backgroundTasks.isTaskPaused('preload:clips')
        ? undefined
        : preloads.get('preload:clips')
      // Les vignettes avant les clips : mille fois plus légères, et c'est ce qui se voit.
      const sweeping = requested.length === 0 ? (thumbnailJob ?? clipJob) : undefined
      const sweepingClips = sweeping !== undefined && sweeping === clipJob && !thumbnailJob

      if (settings.mediaStorageMode === 'stream' && requested.length === 0 && !sweeping) break
      // En pause, la passe ne rapporterait rien : sortir évite une boucle à vide, et
      // évite surtout de prendre cette absence de progrès pour un travail terminé.
      if (backgroundTasks.isPaused()) break

      const result = await processPendingMedia({
        onProgress: (progress) => mainWindow?.webContents.send('cache:progress', progress),
        // Le coût dominant est le réseau, pas le processeur : deux téléchargements de front
        // faisaient attendre dix secondes pour une soixantaine de cartes visibles. Les
        // demandes de la grille passent donc large ; la passe de fond reste discrète pour
        // ne pas leur voler la bande passante.
        /* Le profil de charge décide combien de travailleurs tournent : c'est le seul
           levier honnête, un plafond en pourcentage de processeur n'existe pas sans
           ordonnanceur. Une passe de fond reste plus discrète que les cartes visibles,
           qui doivent arriver vite. */
        concurrency: sweeping
          ? Math.max(1, Math.round(backgroundTasks.workers() / 2))
          : backgroundTasks.workers(),
        shouldPause: () => mediaPaused || backgroundTasks.isPaused(),
        signal: mediaAbortController.signal,
        requestedPostIds:
          sweeping || settings.mediaStorageMode !== 'stream' ? undefined : requested,
        thumbnailsOnly: sweeping !== undefined && !sweepingClips,
        coverOnly: sweeping !== undefined && !sweepingClips,
        scope: sweeping && !sweepingClips ? sweeping.query : null,
        clips: sweepingClips ? (sweeping.query ?? true) : null
      })

      // Le lot est volontairement court : ce qui n'a pas été traité revient dans la file,
      // mais *derrière* les identifiants arrivés entre-temps. Un Set conserve son ordre
      // d'insertion, si bien que la position courante repasse naturellement devant ce
      // qu'on a déjà dépassé.
      if (result.hasMore && !sweeping) {
        for (const id of requested) requestedThumbnailPostIds.add(id)
      }

      /* Insister ne ferait que réécrire ce qu'on vient d'effacer : on arrête la passe et on
         rend la décision à l'utilisateur, qui seul peut relever le plafond. */
      if (result.thumbnailsCapped) {
        backgroundTasks.setThumbnailsCapped(true)
        await backgroundTasks.refreshCache()
        if (sweeping && !sweepingClips) stopPreload(sweeping.kind)
      }

      if (result.quotaReached) {
        /* Le quota ne peut plus venir que des clips : les vignettes ont leur part réservée et
           n'en sortent jamais. On arrête donc les clips, et eux seuls.
           Mettre tout en pause — ce que faisait la version précédente — arrêtait aussi les
           vignettes, qui avaient pourtant de la place, et laissait l'écran de préparation
           attendre indéfiniment deux étapes qui ne repartiraient jamais. */
        await backgroundTasks.refreshCache(true)
        const clips = preloads.get('preload:clips')
        if (clips) stopPreload(clips.kind)
      }

      for (const [id, job] of preloads) publishPreload(id, job)
      // Une passe de fond qui ne rend plus rien signifie qu'il ne reste que des médias
      // abandonnés après trois tentatives : insister ne servirait à rien.
      if (sweeping && result.total === 0 && !backgroundTasks.isPaused()) {
        stopPreload(sweeping.kind)
      }

      hasMore = result.hasMore || requestedThumbnailPostIds.size > 0 || preloads.size > 0
      if (result.total > 0) notifyLibraryUpdated()
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
    notifyLibraryUpdated(true)
  }
}

/**
 * « La bibliothèque a changé », au plus une fois par seconde et demie.
 *
 * Le rendu répond à cet événement par un `refreshNow()` sans frein, et `refresh()` demande
 * toujours la page zéro — or c’est à l’offset zéro que `listPostPage` compte. Le `COUNT(*)`
 * qu'on avait justement sorti du défilement revenait donc par la porte de derrière, au
 * rythme des lots de la file média : un comptage complet, une page de trois cents posts,
 * leurs médias, leurs tags, leurs sources et les statistiques, en synchrone, tous les trois
 * cent soixante vignettes. On regroupe donc les rafales ; la fin d'une passe, elle, part
 * tout de suite, parce que plus rien ne suivra pour la relancer.
 */
let libraryUpdateTimer: NodeJS.Timeout | null = null

function notifyLibraryUpdated(immediate = false): void {
  if (immediate) {
    if (libraryUpdateTimer) {
      clearTimeout(libraryUpdateTimer)
      libraryUpdateTimer = null
    }
    mainWindow?.webContents.send('library:updated')
    return
  }
  if (libraryUpdateTimer) return
  libraryUpdateTimer = setTimeout(() => {
    libraryUpdateTimer = null
    mainWindow?.webContents.send('library:updated')
  }, 1500)
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

  // Doit précéder la file média : c'est ce qui remet en attente les vignettes dont le
  // fichier a disparu, et surtout ce qui rend à la base les fichiers qu'elle avait cessé de
  // reconnaître — sans quoi la file les retéléchargerait un par un, tous déjà sur le disque.
  const cache = repairMissingCacheFiles()
  if (cache.thumbs > 0 || cache.videos > 0) {
    console.log(
      `[magpie] Cache réconcilié : ${cache.thumbs} vignette(s) et ${cache.videos} clip(s) à refaire.`
    )
  }
  if (cache.relinkedThumbs > 0 || cache.relinkedVideos > 0) {
    console.log(
      `[magpie] Cache rattaché : ${cache.relinkedThumbs} vignette(s) et ${cache.relinkedVideos} clip(s) retrouvés sur le disque.`
    )
  }
  if (cache.orphans > 0) {
    console.log(
      `[magpie] Cache balayé : ${cache.orphans} fichier(s) que plus aucune ligne ne désigne, ` +
        `${(cache.orphanBytes / 1024 / 1024 / 1024).toFixed(2)} Go rendus.`
    )
    resetCacheUsage()
  }

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
    startPreload,
    stopPreload,
    catchUp: () => void runAfterSyncSteps(readSettings().afterSync),
    setDownloadsPaused,
    backgroundState: () => backgroundTasks.current(),
    pendingCounts: (query) => ({
      thumbnails: countPendingThumbnails(true, query),
      clips: countPendingClips(query)
    }),
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
  // Un seul canal pour tout ce qui travaille en fond : l'indicateur, son survol et
  // l'icône de la barre système lisent la même chose.
  backgroundTasks.subscribe((state) => {
    mainWindow?.webContents.send('tasks:state', state)
    updateTray()
  })

  syncEngine.subscribe((state) => {
    // La synchronisation se déclare comme les autres : `page` fait office d'avancement,
    // son ampleur n'étant pas connue d'avance.
    for (const platform of PUBLIC_PLATFORMS) {
      const progress = state.byPlatform[platform]
      const id = `sync:${platform}`
      if (progress.phase === 'running') {
        backgroundTasks.update(id, {
          kind: 'sync',
          scope: platform === 'x' ? 'X' : 'Instagram',
          done: progress.added,
          total: 0,
          message: progress.message
        })
      } else {
        backgroundTasks.clear(id)
      }
    }

    mainWindow?.webContents.send('sync:state', state)
    for (const platform of ['instagram', 'x', 'reddit'] as const) {
      const phase = state.byPlatform[platform].phase
      const added = state.byPlatform[platform].added
      if (phase === 'running' && previousSyncPhase[platform] !== 'running') {
        syncStartedAt[platform] = Date.now()
      }
      if (added > (previousSyncAdded[platform] ?? 0)) {
        organizerAfterSyncPending = true
        void drainMediaQueue()
      }
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

    // Une source peut finir quelques millisecondes avant que la suivante commence. Le
    // petit délai évite de lancer l'organisateur entre Signets et Likes ; il ne part
    // qu'une fois l'ensemble de la synchronisation réellement au repos.
    if (organizerAfterSyncTimer) clearTimeout(organizerAfterSyncTimer)
    organizerAfterSyncTimer = null
    if (!state.running && organizerAfterSyncPending) {
      if (!readSettings().autoOrganizeEnabled) {
        organizerAfterSyncPending = false
      } else {
        organizerAfterSyncTimer = setTimeout(() => {
          organizerAfterSyncTimer = null
          if (syncEngine.isRunning()) return
          organizerAfterSyncPending = false
          /* Les préparations cochées se rejouent, puis le classement. */
          void (async () => {
            try {
              await runAfterSyncSteps(readSettings().afterSync)
              /* Puis les collections qui portent une définition la rejouent. Sans ceci, seules
                 les routes mémorisées rangeaient les nouveaux posts — et elles n'existent que
                 pour le chemin rapide. Les collections de l'approfondi restaient donc figées
                 sur la bibliothèque du jour de leur création, sans que rien ne le dise. */
              const refreshed = await refreshQueryCollections()
              const result = await applyRememberedOrganizerRules()
              if (result.added > 0 || refreshed.collections > 0) notifyLibraryUpdated(true)
            } catch (error) {
              console.error('[magpie] Organisation automatique impossible', error)
            }
          })()
        }, 750)
      }
    }
  })

  aiTagger.subscribe((progress) => {
    mainWindow?.webContents.send('ai:progress', progress)
    if (!progress.running) notifyLibraryUpdated(true)
  })

  localOrganizer.subscribe((value) => {
    mainWindow?.webContents.send('organizer:progress', value)
    if (value.running) {
      backgroundTasks.update('organizer', {
        kind: 'organizer',
        done: value.done,
        total: value.total
      })
    } else {
      backgroundTasks.clear('organizer')
    }
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
  dialog.showErrorBox(say('library.unreachable'), (error as Error).message)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !readSettings().trayEnabled) app.quit()
})

app.on('before-quit', () => {
  quitting = true
  /* Le processus des modèles ne s'arrête pas tout seul : c'est un enfant d'Electron, pas une
     tâche de la boucle. Sans ceci, il survivait à la fenêtre fermée avec ses modèles chargés. */
  stopInference()
  if (scheduleTimer) clearInterval(scheduleTimer)
  if (organizerAfterSyncTimer) clearTimeout(organizerAfterSyncTimer)
  if (windowInteractionTimer) clearTimeout(windowInteractionTimer)
  stopUpdater()
  closeDb()
})
