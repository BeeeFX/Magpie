import type {
  AiCollectionPlan,
  LibraryStats,
  MagpieApi,
  MagpieEvents,
  Platform,
  Post,
  PostPage,
  Settings,
  SyncState,
  UpdateState
} from '@shared/types'
import { idleSyncState, PLATFORMS } from '@shared/types'

/**
 * Accès au processus principal.
 *
 * Sous Electron, c'est le pont exposé par le preload. Ouverte dans un navigateur ordinaire
 * (`http://localhost:5173` pendant `npm run dev`), l'interface bascule sur un instantané
 * statique produit par le processus principal — voir `src/main/dev/preview-snapshot.ts`.
 *
 * Le repli est volontairement minimal : il sert à regarder la grille, pas à simuler
 * l'application. Les filtres et le tri sont ignorés, pour qu'aucune logique métier ne soit
 * dupliquée ici et ne finisse par diverger de l'implémentation SQL.
 */

const isElectron = typeof window !== 'undefined' && 'magpie' in window

let previewCache: Post[] | null = null

async function previewPosts(): Promise<Post[]> {
  if (previewCache) return previewCache
  const res = await fetch('/preview/posts.json')
  if (!res.ok) throw new Error("Aperçu indisponible : lancez `npm run dev` une fois sous Electron.")
  previewCache = (await res.json()) as Post[]
  return previewCache
}

function previewStats(posts: Post[]): LibraryStats {
  const byPlatform = Object.fromEntries(PLATFORMS.map((p) => [p, 0])) as Record<Platform, number>
  const counts = new Map<string, number>()

  for (const post of posts) {
    byPlatform[post.platform]++
    for (const tag of post.tags) counts.set(tag.name, (counts.get(tag.name) ?? 0) + 1)
  }

  return {
    total: posts.length,
    favorites: posts.filter((p) => p.isFavorite).length,
    byPlatform,
    byLabel: {},
    topTags: [...counts.entries()]
      .map(([name, count]) => ({ name, count, source: 'rule' as const }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 40)
  }
}

/** En aperçu, les réglages vivent dans le localStorage plutôt que sur disque. */
const PREVIEW_SETTINGS_KEY = 'magpie-preview-settings'

/** Doit rester aligné sur les valeurs par défaut du processus principal (main/settings.ts). */
const PREVIEW_DEFAULTS: Settings = {
  theme: 'system',
  language: 'system',
  accent: 'violet',
  nitrateEnabled: false,
  videoCacheQuality: '720p',
  playbackQuality: 'auto',
  cacheLimitGb: 20,
  trayEnabled: true,
  syncOnLaunch: true,
  syncSchedule: 'manual',
  aiProvider: 'openai',
  aiModel: 'gpt-4.1-mini',
  aiEndpoint: '',
  autoTagEnabled: false,
  // L'aperçu sert à juger l'application, pas à rejouer l'accueil à chaque rechargement.
  onboardingDone: true
}

const IDLE_SYNC: SyncState = idleSyncState()

function previewSettings(): Settings {
  try {
    const raw = localStorage.getItem(PREVIEW_SETTINGS_KEY)
    if (raw) return { ...PREVIEW_DEFAULTS, ...JSON.parse(raw) }
  } catch {
    /* réglages illisibles : on repart des valeurs par défaut */
  }
  return { ...PREVIEW_DEFAULTS }
}

const previewApi: MagpieApi = {
  listPosts: () => previewPosts(),
  listPostPage: async (_query, offset, limit): Promise<PostPage> => {
    const posts = await previewPosts()
    const page = posts.slice(offset, offset + limit)
    return { posts: page, total: posts.length, offset, hasMore: offset + page.length < posts.length }
  },
  getPostsByIds: async (ids) => {
    const wanted = new Set(ids)
    return (await previewPosts()).filter((post) => wanted.has(post.id))
  },
  getStats: async () => previewStats(await previewPosts()),
  toggleFavorite: async () => false,
  setFavoriteMany: async () => {},
  addTagMany: async () => {},
  // Une clé fictivement « présente » permet de tester le parcours d'organisation dans
  // l'aperçu visuel ; aucune requête réseau n'est émise par les méthodes ci-dessous.
  hasAiKey: async () => true,
  setAiKey: async () => {},
  startAiTagging: async () => ({ done: 0, total: 0, tagged: 0, failed: 0, running: false }),
  proposeAiCollections: async (): Promise<AiCollectionPlan> => ({
    analysedVideos: 18,
    unassignedVideos: 2,
    suggestions: [
      {
        id: 'music',
        name: 'Music',
        description: 'Guitar, DJ sets and music production.',
        postIds: ['demo-music-1', 'demo-music-2', 'demo-music-3']
      },
      {
        id: 'visual',
        name: 'Visual inspiration',
        description: 'Motion, photography and art direction.',
        postIds: ['demo-visual-1', 'demo-visual-2']
      }
    ]
  }),
  applyAiCollections: async (choices) => ({
    collections: choices.length,
    added: choices.reduce((total, choice) => total + choice.postIds.length, 0),
    alreadyThere: 0
  }),
  copyToClipboard: async (text) => {
    await navigator.clipboard.writeText(text)
  },
  openExternal: async (url) => {
    window.open(url, '_blank', 'noopener')
  },
  sendToNitrate: async (url) => {
    // Aucun navigateur ne connaît le protocole nitrate:// : en aperçu, on se contente
    // d'annoncer ce que l'application ferait.
    console.info(`[aperçu] nitrate://add?url=${encodeURIComponent(url)}`)
  },
  getSettings: async () => previewSettings(),
  setSettings: async (patch) => {
    const next = { ...previewSettings(), ...patch }
    localStorage.setItem(PREVIEW_SETTINGS_KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent('magpie-preview-theme'))
    return next
  },
  getLibraryInfo: async () => {
    const posts = await previewPosts()
    return {
      posts: posts.length,
      media: posts.reduce((n, p) => n + p.media.length, 0),
      demoPosts: posts.length,
      cacheBytes: 0,
      dataPath: 'aperçu navigateur',
      version: '0.2.2'
    }
  },
  getUpdateState: async (): Promise<UpdateState> => ({
    phase: 'unsupported',
    currentVersion: '0.2.2',
    availableVersion: null,
    percent: null,
    message: 'browser-preview'
  }),
  checkForUpdates: async (): Promise<UpdateState> => ({
    phase: 'unsupported',
    currentVersion: '0.2.2',
    availableVersion: null,
    percent: null,
    message: 'browser-preview'
  }),
  installUpdate: async () => {},
  setWindowFullscreen: async () => false,
  clearMediaCache: async () => {},
  openDataFolder: async () => {},
  chooseLibraryFolder: async () => ({ moved: false, path: 'aperçu navigateur' }),
  cacheVideoQuality: async () => {
    throw new Error('Qualités vidéo indisponibles dans l’aperçu navigateur.')
  },

  // Les mutations n'ont pas de base derrière elles en aperçu : elles renvoient l'état
  // courant sans rien modifier, plutôt que de simuler une persistance qui mentirait.
  setLabel: async () => {},
  setCollectionColor: async () => {},
  addTag: async () => {},
  removeTag: async () => {},
  listCollections: async () => [],
  createCollection: async (name) => ({ id: 0, name, count: 0, color: null }),
  addToCollection: async () => ({ added: 0, alreadyThere: [], collectionName: '' }),
  removeFromCollection: async () => {},
  collectionsForPost: async () => [],

  // La connexion des comptes n'a pas d'équivalent hors Electron : l'aperçu se contente
  // d'annoncer trois comptes déconnectés, ce qui suffit à juger de l'interface.
  listAccounts: async () =>
    PLATFORMS.map((platform) => ({
      platform,
      connected: false,
      handle: null,
      lastSyncAt: null,
      lastSyncStatus: null
    })),
  connectAccount: async (platform) => {
    throw new Error(`Connexion à ${platform} indisponible dans l'aperçu navigateur.`)
  },
  disconnectAccount: async (platform) => ({
    platform,
    connected: false,
    handle: null,
    lastSyncAt: null,
    lastSyncStatus: null
  }),
  startSync: async () => IDLE_SYNC,
  startFullSync: async () => IDLE_SYNC,
  cancelSync: async () => {},
  getSyncState: async () => IDLE_SYNC,
  loadDemoData: async () => 0,
  removeDemoData: async () => 0,

  platform: 'browser-preview' as NodeJS.Platform
}

/**
 * En aperçu, le thème effectif est résolu ici plutôt que par le processus principal.
 * C'est le seul comportement que le repli reproduit vraiment, parce que sans lui on ne
 * pourrait pas juger du rendu clair et sombre depuis le navigateur.
 */
const previewEvents: MagpieEvents = {
  onCacheProgress: () => () => {},
  onLibraryUpdated: () => () => {},
  onSyncState: () => () => {},
  onAiTagProgress: () => () => {},
  onOrganizerProgress: () => () => {},
  onUpdateState: () => () => {},
  onLibraryMoveProgress: () => () => {},
  onWindowInteraction: () => () => {},
  onThemeChanged: (cb) => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const resolve = (): void => {
      const { theme } = previewSettings()
      cb(theme === 'system' ? media.matches : theme === 'dark')
    }
    resolve()
    media.addEventListener('change', resolve)
    window.addEventListener('magpie-preview-theme', resolve)
    return () => {
      media.removeEventListener('change', resolve)
      window.removeEventListener('magpie-preview-theme', resolve)
    }
  }
}

export const magpie: MagpieApi = isElectron ? window.magpie : previewApi
export const magpieEvents: MagpieEvents = isElectron ? window.magpieEvents : previewEvents
export const isPreview = !isElectron
