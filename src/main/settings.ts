import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, nativeTheme } from 'electron'
import type { Settings } from '@shared/types'
import { ACCENTS } from '@shared/types'

const DEFAULTS: Settings = {
  theme: 'system',
  language: 'system',
  accent: 'violet',
  nitrateEnabled: false,
  onboardingDone: false,
  contentSources: ['saved'],
  videoCacheQuality: '480p',
  mediaStorageMode: 'stream',
  playbackQuality: 'auto',
  cacheLimitGb: 5,
  organizerRecipe: 'equilibre',
  trayEnabled: true,
  syncOnLaunch: true,
  syncSchedule: 'manual',
  aiProvider: 'openai',
  aiModel: 'gpt-4.1-mini',
  aiEndpoint: '',
  autoTagEnabled: false,
  autoOrganizeEnabled: false
}

let cache: Settings | null = null

function file(): string {
  // Les réglages restent dans le profil système même si la bibliothèque est déplacée :
  // c'est ce petit fichier stable qui permet de retrouver un disque D: au démarrage.
  return join(app.getPath('userData'), 'settings.json')
}

/** Un fichier de réglages écrit à la main ou corrompu ne doit pas empêcher l'app de démarrer. */
function sanitize(raw: unknown): Settings {
  const value = (raw ?? {}) as Partial<Settings>
  return {
    theme:
      value.theme === 'light' || value.theme === 'dark' || value.theme === 'system'
        ? value.theme
        : DEFAULTS.theme,
    language:
      value.language === 'fr' || value.language === 'en' || value.language === 'system'
        ? value.language
        : DEFAULTS.language,
    accent: ACCENTS.includes(value.accent as never)
      ? (value.accent as Settings['accent'])
      : DEFAULTS.accent,
    nitrateEnabled: value.nitrateEnabled === true,
    onboardingDone: value.onboardingDone === true,
    contentSources:
      Array.isArray(value.contentSources) && value.contentSources.includes('liked')
        ? value.contentSources.includes('saved') ? ['saved', 'liked'] : ['liked']
        : ['saved'],
    videoCacheQuality:
      value.videoCacheQuality === '480p' ||
      value.videoCacheQuality === '720p' ||
      value.videoCacheQuality === '1080p' ||
      value.videoCacheQuality === 'source'
        ? value.videoCacheQuality
        : DEFAULTS.videoCacheQuality,
    mediaStorageMode:
      value.mediaStorageMode === 'stream' || value.mediaStorageMode === 'offline'
        ? value.mediaStorageMode
        : DEFAULTS.mediaStorageMode,
    playbackQuality:
      value.playbackQuality === 'auto' ||
      value.playbackQuality === '480p' ||
      value.playbackQuality === '720p' ||
      value.playbackQuality === '1080p' ||
      value.playbackQuality === 'source'
        ? value.playbackQuality
        : DEFAULTS.playbackQuality,
    organizerRecipe: ['texte', 'equilibre', 'image', 'sujet', 'style'].includes(
      value.organizerRecipe as string
    )
      ? (value.organizerRecipe as Settings['organizerRecipe'])
      : DEFAULTS.organizerRecipe,
    cacheLimitGb:
      typeof value.cacheLimitGb === 'number' && value.cacheLimitGb >= 1 && value.cacheLimitGb <= 500
        ? value.cacheLimitGb
        : DEFAULTS.cacheLimitGb,
    trayEnabled: value.trayEnabled !== false,
    syncOnLaunch: value.syncOnLaunch !== false,
    syncSchedule:
      value.syncSchedule === 'hourly' ||
      value.syncSchedule === '6h' ||
      value.syncSchedule === 'daily' ||
      value.syncSchedule === 'manual'
        ? value.syncSchedule
        : DEFAULTS.syncSchedule,
    aiProvider:
      value.aiProvider === 'anthropic' ||
      value.aiProvider === 'gemini' ||
      value.aiProvider === 'deepseek' ||
      value.aiProvider === 'custom' ||
      value.aiProvider === 'openai'
        ? value.aiProvider
        : DEFAULTS.aiProvider,
    aiModel:
      typeof value.aiModel === 'string' && value.aiModel.trim()
        ? value.aiModel.trim().slice(0, 120)
        : DEFAULTS.aiModel,
    aiEndpoint:
      typeof value.aiEndpoint === 'string' ? value.aiEndpoint.trim().slice(0, 500) : '',
    // The cloud-LLM organizer is intentionally unavailable for now. Always
    // disable a value left behind by an older Magpie installation as well.
    autoTagEnabled: false,
    autoOrganizeEnabled: value.autoOrganizeEnabled === true
  }
}

export function readSettings(): Settings {
  if (cache) return cache
  try {
    cache = existsSync(file()) ? sanitize(JSON.parse(readFileSync(file(), 'utf8'))) : { ...DEFAULTS }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export function writeSettings(patch: Partial<Settings>): Settings {
  cache = sanitize({ ...readSettings(), ...patch })
  const temporary = `${file()}.tmp`
  writeFileSync(temporary, JSON.stringify(cache, null, 2))
  renameSync(temporary, file())
  applyTheme()
  return cache
}

/**
 * Répercute le thème choisi sur Electron. C'est ce qui fait que les boutons système
 * dessinés par Windows par-dessus notre barre de titre changent de couleur en même temps
 * que l'interface, au lieu de rester en clair sur un fond sombre.
 */
export function applyTheme(): boolean {
  nativeTheme.themeSource = readSettings().theme
  return nativeTheme.shouldUseDarkColors
}
