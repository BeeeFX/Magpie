import { app, BrowserWindow, dialog } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { UpdateState } from '@shared/types'
import { readSettings } from './settings'

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const INITIAL_CHECK_DELAY_MS = 12_000

let state: UpdateState = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  availableVersion: null,
  percent: null,
  message: null
}
let initialized = false
let checkTimer: NodeJS.Timeout | null = null
let initialTimer: NodeJS.Timeout | null = null
let promptedVersion: string | null = null
let getWindow: () => BrowserWindow | null = () => null
let beforeInstall: () => void = () => {}
let broadcast: (next: UpdateState) => void = () => {}

function publish(patch: Partial<UpdateState>): UpdateState {
  state = { ...state, ...patch, currentVersion: app.getVersion() }
  broadcast({ ...state })
  return { ...state }
}

function interfaceLanguage(): 'fr' | 'en' {
  const choice = readSettings().language
  if (choice === 'fr' || choice === 'en') return choice
  return app.getLocale().toLowerCase().startsWith('fr') ? 'fr' : 'en'
}

async function promptToInstall(info: UpdateInfo): Promise<void> {
  if (promptedVersion === info.version) return
  promptedVersion = info.version

  const fr = interfaceLanguage() === 'fr'
  const options = {
    type: 'info' as const,
    title: fr ? 'Mise à jour prête' : 'Update ready',
    message: fr
      ? `Magpie ${info.version} est prêt à être installé.`
      : `Magpie ${info.version} is ready to install.`,
    detail: fr
      ? 'Le redémarrage ferme Magpie, installe la mise à jour puis rouvre l’application. Votre bibliothèque reste intacte.'
      : 'Restarting closes Magpie, installs the update, then reopens the app. Your library is kept intact.',
    buttons: fr ? ['Redémarrer et installer', 'Plus tard'] : ['Restart and install', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  }
  const parent = getWindow()
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  if (result.response === 0) installUpdate()
}

function updaterSupported(): boolean {
  return app.isPackaged && process.platform === 'win32'
}

export function getUpdateState(): UpdateState {
  return { ...state, currentVersion: app.getVersion() }
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (!updaterSupported()) {
    return publish({
      phase: 'unsupported',
      percent: null,
      message: app.isPackaged ? 'unsupported-platform' : 'development-build'
    })
  }
  if (state.phase === 'checking' || state.phase === 'downloading') return getUpdateState()

  publish({ phase: 'checking', percent: null, message: null })
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    publish({
      phase: 'error',
      percent: null,
      message: error instanceof Error ? error.message.slice(0, 300) : 'Update check failed'
    })
  }
  return getUpdateState()
}

export function installUpdate(): void {
  if (state.phase !== 'ready') return
  beforeInstall()
  autoUpdater.quitAndInstall(false, true)
}

export function initializeUpdater(options: {
  getWindow: () => BrowserWindow | null
  beforeInstall: () => void
  broadcast: (state: UpdateState) => void
}): void {
  getWindow = options.getWindow
  beforeInstall = options.beforeInstall
  broadcast = options.broadcast
  if (initialized) return
  initialized = true

  if (!updaterSupported()) {
    publish({
      phase: 'unsupported',
      message: app.isPackaged ? 'unsupported-platform' : 'development-build'
    })
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false

  autoUpdater.on('checking-for-update', () => {
    publish({ phase: 'checking', percent: null, message: null })
  })
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    publish({
      phase: 'available',
      availableVersion: info.version,
      percent: 0,
      message: null
    })
  })
  autoUpdater.on('update-not-available', () => {
    publish({ phase: 'up-to-date', availableVersion: null, percent: null, message: null })
  })
  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    publish({ phase: 'downloading', percent: Math.max(0, Math.min(100, progress.percent)) })
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    publish({
      phase: 'ready',
      availableVersion: info.version,
      percent: 100,
      message: null
    })
    void promptToInstall(info)
  })
  autoUpdater.on('error', (error: Error) => {
    publish({ phase: 'error', percent: null, message: error.message.slice(0, 300) })
  })

  initialTimer = setTimeout(() => void checkForUpdates(), INITIAL_CHECK_DELAY_MS)
  initialTimer.unref()
  checkTimer = setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS)
  checkTimer.unref()
}

export function stopUpdater(): void {
  if (initialTimer) clearTimeout(initialTimer)
  if (checkTimer) clearInterval(checkTimer)
  initialTimer = null
  checkTimer = null
}
