import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  AccentName,
  AccountInfo,
  AiProvider,
  AiTagProgress,
  CacheProgress,
  GridMode,
  LabelColor,
  LibraryStats,
  Platform,
  Post,
  PostQuery,
  SortKey,
  SyncState,
  ThemeChoice,
  VideoQuality,
  PlaybackQuality
  ,SyncSchedule
} from '@shared/types'
import type { Language, LanguageChoice } from '@shared/types'
import { DEFAULT_QUERY, idleSyncState } from '@shared/types'
import { magpie } from './bridge'
import { setFormatLanguage } from './format'
import { resolveLanguage, translate, type TranslationKey } from './i18n'

export const DENSITY_MIN = 140
export const DENSITY_MAX = 400

/**
 * Accès aux traductions depuis un composant. Il vit ici plutôt que dans `i18n.ts` pour
 * éviter que le module de traduction ne dépende du store — la dépendance ne va que dans
 * un sens.
 */
export function useT(): (key: TranslationKey, vars?: Record<string, string | number>) => string {
  const lang = useStore((s) => s.lang)
  return (key, vars) => translate(lang, key, vars)
}

interface State {
  posts: Post[]
  stats: LibraryStats | null
  loading: boolean
  cacheProgress: CacheProgress | null

  query: PostQuery
  gridMode: GridMode
  density: number
  sidebarOpen: boolean
  settingsOpen: boolean
  /** Volume du lecteur, partagé entre tous les posts et conservé entre les sessions. */
  volume: number
  muted: boolean
  /** Son des aperçus au survol dans la grille. Coupé par défaut : un mur qui se met à
   *  parler quand la souris le traverse serait insupportable. */
  hoverAudio: boolean
  /** Index du post ouvert en vue détaillée, ou null quand on est sur la grille. */
  detailIndex: number | null
  selectionMode: boolean
  selectedIds: string[]

  accounts: AccountInfo[]
  sync: SyncState
  /** Conservé pour revenir au mur exactement là où on l'avait laissé — y compris après
   *  un redémarrage de l'app. C'est une exigence explicite de SPEC.md §9. */
  scrollTop: number

  /** Réglages : la source de vérité est le processus principal, pas le localStorage. */
  theme: ThemeChoice
  language: LanguageChoice
  /** Langue effective, « système » déjà résolu. */
  lang: Language
  accent: AccentName
  nitrateEnabled: boolean
  videoCacheQuality: VideoQuality
  playbackQuality: PlaybackQuality
  cacheLimitGb: number
  trayEnabled: boolean
  syncSchedule: SyncSchedule
  aiProvider: AiProvider
  aiModel: string
  aiEndpoint: string
  autoTagEnabled: boolean
  aiProgress: AiTagProgress | null
  onboardingDone: boolean
  /** Vrai tant que les réglages n'ont pas été lus : évite d'afficher la présentation
   *  une fraction de seconde à chaque démarrage d'une installation déjà configurée. */
  settingsLoading: boolean
  /** Thème effectif, « système » déjà résolu. */
  isDark: boolean

  refresh: () => Promise<void>
  setQuery: (patch: Partial<PostQuery>) => void
  resetQuery: () => void
  setSort: (sort: SortKey) => void
  setGridMode: (mode: GridMode) => void
  setDensity: (density: number) => void
  toggleSidebar: () => void
  setScrollTop: (scrollTop: number) => void
  setVolume: (volume: number) => void
  setMuted: (muted: boolean) => void
  setHoverAudio: (hoverAudio: boolean) => void
  setSelectionMode: (enabled: boolean) => void
  toggleSelected: (id: string) => void
  selectAllVisible: () => void
  clearSelection: () => void
  favoriteSelection: () => Promise<void>
  tagSelection: (name: string) => Promise<void>
  setCacheProgress: (progress: CacheProgress | null) => void
  toggleFavorite: (id: string) => Promise<void>
  setSettingsOpen: (open: boolean) => void
  loadSettings: () => Promise<void>
  setTheme: (theme: ThemeChoice) => Promise<void>
  setAccent: (accent: AccentName) => Promise<void>
  setLanguage: (language: LanguageChoice) => Promise<void>
  setNitrateEnabled: (enabled: boolean) => Promise<void>
  setVideoCacheQuality: (quality: VideoQuality) => Promise<void>
  setPlaybackQuality: (quality: PlaybackQuality) => Promise<void>
  setCacheLimitGb: (limit: number) => Promise<void>
  setTrayEnabled: (enabled: boolean) => Promise<void>
  setSyncSchedule: (schedule: SyncSchedule) => Promise<void>
  setAiSettings: (patch: Partial<Pick<State, 'aiProvider' | 'aiModel' | 'aiEndpoint' | 'autoTagEnabled'>>) => Promise<void>
  setAiProgress: (progress: AiTagProgress | null) => void
  finishOnboarding: () => Promise<void>
  replayOnboarding: () => Promise<void>
  setIsDark: (isDark: boolean) => void

  /** Rectangle de la carte cliquée, pour que la vue détaillée s'ouvre depuis elle. */
  detailOrigin: { x: number; y: number; width: number; height: number } | null
  openDetail: (index: number, origin?: DOMRect) => void
  closeDetail: () => void
  stepDetail: (delta: number) => void
  addTag: (postId: string, name: string) => Promise<void>
  removeTag: (postId: string, name: string) => Promise<void>
  setLabel: (postId: string, label: LabelColor | null) => Promise<void>

  loadAccounts: () => Promise<void>
  connectAccount: (platform: Platform) => Promise<void>
  disconnectAccount: (platform: Platform) => Promise<void>
  startSync: (platforms?: Platform[]) => Promise<void>
  cancelSync: (platform?: Platform) => Promise<void>
  setSyncState: (state: SyncState) => void
}

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      posts: [],
      stats: null,
      loading: true,
      cacheProgress: null,

      query: DEFAULT_QUERY,
      // Les cartes de contenu sont le mode par défaut : le mur mélange des posts texte
      // et des images, et l'auteur compte autant que le visuel.
      gridMode: 'cards',
      density: 320,
      sidebarOpen: true,
      settingsOpen: false,
      volume: 0.7,
      muted: false,
      hoverAudio: false,
      detailIndex: null,
      selectionMode: false,
      selectedIds: [],
      detailOrigin: null,
      scrollTop: 0,

      accounts: [],
      sync: idleSyncState(),

      theme: 'system',
      language: 'system',
      lang: resolveLanguage('system'),
      // Aligné sur les valeurs par défaut du processus principal (main/settings.ts).
      accent: 'violet',
      nitrateEnabled: false,
      videoCacheQuality: '720p',
      playbackQuality: 'auto',
      cacheLimitGb: 20,
      trayEnabled: true,
      syncSchedule: 'manual',
      aiProvider: 'openai',
      aiModel: 'gpt-4.1-mini',
      aiEndpoint: '',
      autoTagEnabled: false,
      aiProgress: null,
      // Vrai par défaut, corrigé dès la lecture des réglages : mieux vaut afficher
      // brièvement l'application vide que de faire clignoter la présentation à chaque
      // démarrage d'une installation déjà configurée.
      onboardingDone: true,
      settingsLoading: true,
      isDark: true,

      refresh: async () => {
        const query = get().query
        set({ loading: true })
        const [posts, stats] = await Promise.all([
          magpie.listPosts(query),
          magpie.getStats()
        ])
        // Une réponse plus lente qu'une requête plus récente ne doit pas écraser l'état.
        if (get().query !== query) return
        set({ posts, stats, loading: false })
      },

      setQuery: (patch) => {
        set({ query: { ...get().query, ...patch }, scrollTop: 0, detailIndex: null })
        void get().refresh()
      },

      resetQuery: () => {
        set({ query: DEFAULT_QUERY, scrollTop: 0 })
        void get().refresh()
      },

      setSort: (sort) => {
        // Nouvelle graine à chaque passage en aléatoire, sinon « aléatoire » renverrait
        // toujours le même ordre.
        const randomSeed = sort === 'random' ? Math.floor(Math.random() * 2 ** 31) : get().query.randomSeed
        set({ query: { ...get().query, sort, randomSeed }, scrollTop: 0 })
        void get().refresh()
      },

      setGridMode: (gridMode) => set({ gridMode, scrollTop: 0 }),
      toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
      setDensity: (density) =>
        set({ density: Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, Math.round(density))) }),
      setScrollTop: (scrollTop) => set({ scrollTop }),
      setVolume: (volume) => set({ volume: Math.min(1, Math.max(0, volume)) }),
      setMuted: (muted) => set({ muted }),
      setHoverAudio: (hoverAudio) => set({ hoverAudio }),
      setSelectionMode: (selectionMode) =>
        set({ selectionMode, selectedIds: selectionMode ? get().selectedIds : [] }),
      toggleSelected: (id) => {
        const selected = new Set(get().selectedIds)
        if (selected.has(id)) selected.delete(id)
        else selected.add(id)
        set({ selectedIds: [...selected] })
      },
      selectAllVisible: () => set({ selectedIds: get().posts.map((post) => post.id) }),
      clearSelection: () => set({ selectedIds: [] }),
      favoriteSelection: async () => {
        const ids = get().selectedIds
        await magpie.setFavoriteMany(ids, true)
        await get().refresh()
      },
      tagSelection: async (name) => {
        const ids = get().selectedIds
        await magpie.addTagMany(ids, name)
        await get().refresh()
      },
      setCacheProgress: (cacheProgress) => set({ cacheProgress }),

      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

      loadSettings: async () => {
        const settings = await magpie.getSettings()
        const lang = resolveLanguage(settings.language)
        setFormatLanguage(lang)
        document.documentElement.lang = lang
        set({
          theme: settings.theme,
          language: settings.language,
          lang,
          accent: settings.accent,
          nitrateEnabled: settings.nitrateEnabled,
          videoCacheQuality: settings.videoCacheQuality,
          playbackQuality: settings.playbackQuality,
          cacheLimitGb: settings.cacheLimitGb,
          trayEnabled: settings.trayEnabled,
          syncSchedule: settings.syncSchedule,
          aiProvider: settings.aiProvider,
          aiModel: settings.aiModel,
          aiEndpoint: settings.aiEndpoint,
          autoTagEnabled: settings.autoTagEnabled,
          onboardingDone: settings.onboardingDone,
          settingsLoading: false
        })
      },

      setLanguage: async (language) => {
        const lang = resolveLanguage(language)
        setFormatLanguage(lang)
        document.documentElement.lang = lang
        set({ language, lang })
        await magpie.setSettings({ language })
      },

      finishOnboarding: async (): Promise<void> => {
        set({ onboardingDone: true })
        await magpie.setSettings({ onboardingDone: true })
        await get().refresh()
      },

      replayOnboarding: async (): Promise<void> => {
        set({ onboardingDone: false, settingsOpen: false })
        await magpie.setSettings({ onboardingDone: false })
      },

      setTheme: async (theme) => {
        set({ theme })
        await magpie.setSettings({ theme })
      },

      setAccent: async (accent) => {
        set({ accent })
        await magpie.setSettings({ accent })
      },

      setNitrateEnabled: async (nitrateEnabled) => {
        set({ nitrateEnabled })
        await magpie.setSettings({ nitrateEnabled })
      },

      setVideoCacheQuality: async (videoCacheQuality) => {
        set({ videoCacheQuality })
        await magpie.setSettings({ videoCacheQuality })
      },

      setPlaybackQuality: async (playbackQuality) => {
        set({ playbackQuality })
        await magpie.setSettings({ playbackQuality })
      },

      setCacheLimitGb: async (cacheLimitGb) => {
        const next = Math.min(500, Math.max(1, Math.round(cacheLimitGb)))
        set({ cacheLimitGb: next })
        await magpie.setSettings({ cacheLimitGb: next })
      },

      setTrayEnabled: async (trayEnabled) => {
        set({ trayEnabled })
        await magpie.setSettings({ trayEnabled })
      },

      setSyncSchedule: async (syncSchedule) => {
        set({ syncSchedule })
        await magpie.setSettings({ syncSchedule })
      },

      setAiSettings: async (patch) => {
        set(patch)
        await magpie.setSettings(patch)
      },
      setAiProgress: (aiProgress) => set({ aiProgress }),

      setIsDark: (isDark) => set({ isDark }),

      openDetail: (detailIndex, origin) =>
        set({
          detailIndex,
          detailOrigin: origin
            ? { x: origin.x, y: origin.y, width: origin.width, height: origin.height }
            : null
        }),

      closeDetail: () => set({ detailIndex: null, detailOrigin: null }),

      addTag: async (postId, name) => {
        set({ posts: await magpie.addTag(postId, name) })
        set({ stats: await magpie.getStats() })
      },

      removeTag: async (postId, name) => {
        set({ posts: await magpie.removeTag(postId, name) })
        set({ stats: await magpie.getStats() })
      },

      setLabel: async (postId, label) => {
        set({ posts: await magpie.setLabel(postId, label) })
        set({ stats: await magpie.getStats() })
      },

      /** Navigation dans la vue détaillée, bornée aux extrémités plutôt que circulaire. */
      stepDetail: (delta) => {
        const { detailIndex, posts } = get()
        if (detailIndex === null || posts.length === 0) return
        const next = Math.min(posts.length - 1, Math.max(0, detailIndex + delta))
        if (next !== detailIndex) set({ detailIndex: next })
      },

      loadAccounts: async (): Promise<void> => {
        set({ accounts: await magpie.listAccounts() })
      },

      connectAccount: async (platform) => {
        await magpie.connectAccount(platform)
        await get().loadAccounts()
        // Un compte fraîchement connecté n'a encore rien : on enchaîne sur son premier
        // rattrapage, ce que l'utilisateur attend de toute façon.
        void get().startSync([platform])
      },

      disconnectAccount: async (platform) => {
        await magpie.disconnectAccount(platform)
        await get().loadAccounts()
      },

      startSync: async (platforms) => {
        await magpie.startSync(platforms)
        await get().loadAccounts()
        await get().refresh()
      },

      cancelSync: async (platform): Promise<void> => {
        await magpie.cancelSync(platform)
      },

      setSyncState: (sync) => {
        const wasRunning = get().sync.running
        set({ sync })
        // Une plateforme vient de finir : ses comptes et sa bibliothèque ont bougé.
        if (wasRunning && !sync.running) {
          void get().loadAccounts()
          void get().refresh()
        }
      },

      toggleFavorite: async (id) => {
        const isFavorite = await magpie.toggleFavorite(id)
        set({
          posts: get().posts.map((p) => (p.id === id ? { ...p, isFavorite } : p)),
          stats: get().stats
            ? {
                ...get().stats!,
                favorites: get().stats!.favorites + (isFavorite ? 1 : -1)
              }
            : null
        })
      }
    }),
    {
      name: 'magpie-ui',
      // On ne persiste ici que ce qui appartient à l'interface. Le thème et l'accent
      // vivent côté processus principal : c'est lui qui doit les connaître pour colorer
      // les boutons système, et deux sources de vérité finiraient par diverger.
      partialize: (state) => ({
        query: state.query,
        gridMode: state.gridMode,
        density: state.density,
        sidebarOpen: state.sidebarOpen,
        volume: state.volume,
        muted: state.muted,
        hoverAudio: state.hoverAudio,
        scrollTop: state.scrollTop
      })
    }
  )
)
