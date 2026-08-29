import { create } from 'zustand'
import type { StepId, StepState } from './steps'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import type {
  AccentName,
  AccountInfo,
  AfterSyncStep,
  AiProvider,
  AiTagProgress,
  ContentSource,
  GridMode,
  LabelColor,
  LibraryStats,
  MediaStorageMode,
  PlaybackQuality,
  Platform,
  Post,
  PostQuery,
  SortKey,
  SyncState,
  ThemeChoice,
  SyncSchedule,
  VideoQuality
} from '@shared/types'
import type { Language, LanguageChoice } from '@shared/types'
import { AFTER_SYNC_STEPS, DEFAULT_QUERY, idleSyncState } from '@shared/types'
import { magpie } from './bridge'
import { setFormatLanguage } from './format'
import { resolveLanguage, translate, type TranslationKey } from './i18n'

export const DENSITY_MIN = 140
export const DENSITY_MAX = 400
export const POST_PAGE_SIZE = 300
let pageGeneration = 0
let lastStatsRefresh = 0
let flushDeferredUiStorage = (): void => {}

async function fetchStats(): Promise<LibraryStats> {
  const stats = await magpie.getStats()
  lastStatsRefresh = Date.now()
  return stats
}

let statsTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Recompte les compteurs de la barre latérale sans faire attendre le geste qui les a
 * changés.
 *
 * Ce décompte parcourt toute la bibliothèque : plus de 200 ms sur un mur de 60 000 posts
 * bien tagué, et l'attendre avant d'afficher un tag ajouté rendait chaque clic poussif
 * alors que le tag, lui, était déjà écrit. Les chiffres suivent donc le contenu au lieu de
 * le précéder, et une rafale d'étiquetages ne déclenche qu'un seul recompte.
 */
function refreshStatsSoon(): void {
  if (statsTimer !== null) return
  statsTimer = setTimeout(() => {
    statsTimer = null
    void fetchStats()
      .then((stats) => useStore.setState({ stats }))
      .catch(() => {
        // Un décompte manqué se rattrape au prochain rafraîchissement de la grille.
      })
  }, 150)
}

/**
 * Zustand appelle le stockage après chaque mutation, même lorsque la partie persistée n'a
 * pas changé. Sur une grosse synchronisation cela faisait des milliers d'écritures
 * synchrones dans Chromium. On déduplique et on regroupe ces écritures hors du chemin de
 * rendu.
 */
function deferredStorage(): StateStorage {
  const pending = new Map<string, string>()
  const last = new Map<string, string | null>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    for (const [name, value] of pending) {
      localStorage.setItem(name, value)
      last.set(name, value)
    }
    pending.clear()
  }

  // Un changement de filtre ou de tri appelle également ce flush explicitement. Les
  // autres mutations fréquentes (notamment le scroll) restent regroupées pour ne pas
  // solliciter Chromium en continu.
  flushDeferredUiStorage = flush
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })

  return {
    getItem: (name) => {
      const value = localStorage.getItem(name)
      last.set(name, value)
      return value
    },
    setItem: (name, value) => {
      if ((pending.get(name) ?? last.get(name)) === value) return
      pending.set(name, value)
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(flush, 500)
    },
    removeItem: (name) => {
      pending.delete(name)
      last.delete(name)
      localStorage.removeItem(name)
    }
  }
}

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
  loadingMore: boolean
  hasMore: boolean
  resultTotal: number
  nextOffset: number
  /** Ne change que lorsque la position ou la taille des cartes peut changer. */
  layoutRevision: number

  query: PostQuery
  gridMode: GridMode
  density: number
  sidebarOpen: boolean
  settingsOpen: boolean
  /** L'organisateur s'ouvre depuis le menu d'actions, donc hors de portée d'un état local. */
  organizerOpen: boolean
  /** L'export vit hors du tri : on peut vouloir converser sans avoir jamais rangé. */
  exportOpen: boolean
  /* La préparation continue en arrière-plan quand on ferme la fenêtre : son état vit donc
     ici, pas dans le composant, sinon revenir dedans repart de zéro pendant que le travail
     tourne toujours. */
  stepChoices: StepId[]
  stepStates: Record<StepId, StepState>
  stepsRunning: boolean
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
  contentSources: ContentSource[]
  videoCacheQuality: VideoQuality
  mediaStorageMode: MediaStorageMode
  playbackQuality: PlaybackQuality
  cacheLimitGb: number
  trayEnabled: boolean
  syncOnLaunch: boolean
  syncSchedule: SyncSchedule
  aiProvider: AiProvider
  aiModel: string
  aiEndpoint: string
  autoTagEnabled: boolean
  autoOrganizeEnabled: boolean
  afterSync: AfterSyncStep[]
  organizeMode: 'quick' | 'deep' | null
  aiProgress: AiTagProgress | null
  onboardingDone: boolean
  /** Vrai tant que les réglages n'ont pas été lus : évite d'afficher la présentation
   *  une fraction de seconde à chaque démarrage d'une installation déjà configurée. */
  settingsLoading: boolean
  /** Thème effectif, « système » déjà résolu. */
  isDark: boolean

  refresh: (reset?: boolean, forceStats?: boolean) => Promise<void>
  refreshPosts: (ids: string[]) => Promise<void>
  loadMore: () => Promise<void>
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
  toggleFavorite: (id: string) => Promise<void>
  setSettingsOpen: (open: boolean) => void
  setOrganizerOpen: (open: boolean) => void
  setExportOpen: (open: boolean) => void
  setStepChoices: (ids: StepId[]) => void
  setStepStates: (patch: Partial<Record<StepId, StepState>>) => void
  setStepsRunning: (running: boolean) => void
  loadSettings: () => Promise<void>
  setTheme: (theme: ThemeChoice) => Promise<void>
  setAccent: (accent: AccentName) => Promise<void>
  setLanguage: (language: LanguageChoice) => Promise<void>
  setNitrateEnabled: (enabled: boolean) => Promise<void>
  setContentSources: (sources: ContentSource[]) => Promise<void>
  setVideoCacheQuality: (quality: VideoQuality) => Promise<void>
  setMediaStorageMode: (mode: MediaStorageMode) => Promise<void>
  setPlaybackQuality: (quality: PlaybackQuality) => Promise<void>
  setCacheLimitGb: (limit: number) => Promise<void>
  setTrayEnabled: (enabled: boolean) => Promise<void>
  setSyncOnLaunch: (enabled: boolean) => Promise<void>
  setSyncSchedule: (schedule: SyncSchedule) => Promise<void>
  setAutoOrganizeEnabled: (enabled: boolean) => Promise<void>
  setAfterSync: (steps: AfterSyncStep[]) => Promise<void>
  setOrganizeMode: (mode: 'quick' | 'deep') => Promise<void>
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
      loadingMore: false,
      hasMore: false,
      resultTotal: 0,
      nextOffset: 0,
      layoutRevision: 0,

      query: DEFAULT_QUERY,
      // Les cartes de contenu sont le mode par défaut : le mur mélange des posts texte
      // et des images, et l'auteur compte autant que le visuel.
      gridMode: 'cards',
      density: 320,
      sidebarOpen: true,
      settingsOpen: false,
      organizerOpen: false,
      exportOpen: false,
      /* Les deux étapes légères d'entrée, les deux lourdes à la demande : télécharger
         quatorze gigaoctets et transcrire trois heures ne se déclenchent pas par défaut
         parce qu'on a cliqué sur « organiser ». On les coche en connaissance de cause. */
      stepChoices: ['sync', 'thumbnails', 'group'],
      stepStates: {
        sync: 'todo',
        thumbnails: 'todo',
        clips: 'todo',
        images: 'todo',
        transcribe: 'todo',
        group: 'todo'
      },
      stepsRunning: false,
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
      contentSources: ['saved'],
      videoCacheQuality: '480p',
      mediaStorageMode: 'stream',
      playbackQuality: 'auto',
      cacheLimitGb: 5,
      trayEnabled: true,
      syncOnLaunch: true,
      syncSchedule: 'manual',
      aiProvider: 'openai',
      aiModel: 'gpt-4.1-mini',
      aiEndpoint: '',
      autoTagEnabled: false,
      autoOrganizeEnabled: false,
      afterSync: ['thumbnails'],
      organizeMode: null,
      aiProgress: null,
      // Vrai par défaut, corrigé dès la lecture des réglages : mieux vaut afficher
      // brièvement l'application vide que de faire clignoter la présentation à chaque
      // démarrage d'une installation déjà configurée.
      onboardingDone: true,
      settingsLoading: true,
      isDark: true,

      /* Un rejet ne doit pas laisser la grille éteinte pour toujours.

         Rien n'entourait ce corps : si `listPostPage` échouait — base momentanément
         inaccessible, IPC coupée à la fermeture — `loading` restait vrai, et l'état vide de
         la grille est justement conditionné à `!loading`. On n’affichait donc ni posts, ni
         message, ni explication : une fenêtre vide, sans rien à quoi se raccrocher. */
      refresh: async (reset = false, forceStats = false) => {
        const generation = ++pageGeneration
        try {
        const query = get().query
        const current = get().posts
        set({
          loadingMore: false,
          ...(reset || current.length === 0 ? { loading: true } : {})
        })
        const shouldRefreshStats =
          forceStats || get().stats === null || Date.now() - lastStatsRefresh >= 5000
        const [page, stats] = await Promise.all([
          magpie.listPostPage(query, 0, POST_PAGE_SIZE),
          shouldRefreshStats ? fetchStats() : Promise.resolve(get().stats!)
        ])
        // Une réponse plus lente qu'une requête plus récente ne doit pas écraser l'état.
        if (get().query !== query || generation !== pageGeneration) return

        let posts = page.posts
        let nextOffset = page.posts.length
        if (!reset && current.length > 0) {
          // Pendant un long import, les cartes déjà à l'écran gardent leur ordre et leur
          // ratio. Une vignette peut ainsi remplacer son placeholder sans déplacer tout
          // le mur ; les nouveaux posts sont ajoutés à la suite jusqu'au prochain tri.
          const updated = new Map(page.posts.map((post) => [post.id, post]))
          const currentIds = new Set(current.map((post) => post.id))
          const fresh = page.posts.filter((post) => !currentIds.has(post.id))
          posts = [
            ...current.map((post) => {
              const next = updated.get(post.id)
              return next ? { ...next, width: post.width, height: post.height } : post
            }),
            ...fresh
          ]
          // Les nouvelles lignes ont été insérées avant l'ancien offset dans SQLite.
          // Les compter évite de les revoir à la page suivante ou d'en sauter d'autres.
          nextOffset = get().nextOffset + fresh.length
        }

        // `refresh` demande toujours la première tranche, donc le total est recompté ici.
        // Le `??` n'est qu'un filet : sans total on garde celui déjà affiché.
        const total = page.total ?? get().resultTotal

        set({
          posts,
          stats,
          layoutRevision:
            reset || current.length === 0 || posts.length !== current.length
              ? get().layoutRevision + 1
              : get().layoutRevision,
          loading: false,
          hasMore: nextOffset < total,
          resultTotal: total,
          nextOffset
        })
        } catch (error) {
          console.error('[magpie] Page de posts illisible', error)
          if (generation === pageGeneration) set({ loading: false, loadingMore: false })
        }
      },

      refreshPosts: async (ids) => {
        if (ids.length === 0) return
        const unique = [...new Set(ids)]
        const chunks: string[][] = []
        for (let offset = 0; offset < unique.length; offset += 100) {
          chunks.push(unique.slice(offset, offset + 100))
        }
        const changed = (await Promise.all(chunks.map((chunk) => magpie.getPostsByIds(chunk)))).flat()
        if (changed.length === 0) return
        const byId = new Map(changed.map((post) => [post.id, post]))
        set({
          posts: get().posts.map((post) => {
            const next = byId.get(post.id)
            return next ? { ...next, width: post.width, height: post.height } : post
          })
        })
      },

      loadMore: async () => {
        const state = get()
        if (state.loading || state.loadingMore || !state.hasMore) return
        const generation = pageGeneration
        const query = state.query
        const offset = state.nextOffset
        set({ loadingMore: true })
        try {
          const page = await magpie.listPostPage(query, offset, POST_PAGE_SIZE)
          if (get().query !== query || generation !== pageGeneration) return
          const known = new Set(get().posts.map((post) => post.id))
          const fresh = page.posts.filter((post) => !known.has(post.id))
          const posts = [...get().posts, ...fresh]
          set({
            posts,
            layoutRevision:
              fresh.length > 0 ? get().layoutRevision + 1 : get().layoutRevision,
            // Les tranches suivantes ne recomptent pas : le total reste celui de la
            // première, que `refresh` remet à jour au fil des synchronisations.
            resultTotal: page.total ?? get().resultTotal,
            nextOffset: offset + page.posts.length,
            hasMore: page.hasMore
          })
        } finally {
          if (generation === pageGeneration) set({ loadingMore: false })
        }
      },

      setQuery: (patch) => {
        set({ query: { ...get().query, ...patch }, scrollTop: 0, detailIndex: null })
        flushDeferredUiStorage()
        void get().refresh(true)
      },

      resetQuery: () => {
        const query = get().query
        // « Tous » est une catégorie de bibliothèque, pas un bouton de remise à zéro
        // générale. Les filtres, la recherche et le tri doivent survivre à la navigation
        // entre Tous, Favoris, Signets/Likes, collections et tags.
        set({
          query: {
            ...query,
            sources: [],
            favoritesOnly: false,
            tags: [],
            collectionIds: []
          },
          scrollTop: 0,
          detailIndex: null
        })
        flushDeferredUiStorage()
        void get().refresh(true)
      },

      setSort: (sort) => {
        // Nouvelle graine à chaque passage en aléatoire, sinon « aléatoire » renverrait
        // toujours le même ordre.
        const randomSeed = sort === 'random' ? Math.floor(Math.random() * 2 ** 31) : get().query.randomSeed
        set({ query: { ...get().query, sort, randomSeed }, scrollTop: 0 })
        flushDeferredUiStorage()
        void get().refresh(true)
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
        const selected = new Set(ids)
        set({
          posts: get().posts.map((post) =>
            selected.has(post.id) ? { ...post, isFavorite: true } : post
          )
        })
        refreshStatsSoon()
      },
      tagSelection: async (name) => {
        const ids = get().selectedIds
        await magpie.addTagMany(ids, name)
        const selected = new Set(ids)
        const before = get().posts
        const posts = before
          .map((post) =>
            selected.has(post.id) && !post.tags.some((tag) => tag.name === name)
              ? { ...post, tags: [...post.tags, { name, source: 'user' as const }] }
              : post
          )
          .filter((post) => !(get().query.untaggedOnly && selected.has(post.id)))
        set({
          posts,
          layoutRevision:
            posts.length !== before.length ? get().layoutRevision + 1 : get().layoutRevision,
          resultTotal: Math.max(0, get().resultTotal - (before.length - posts.length))
        })
        refreshStatsSoon()
      },

      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      setOrganizerOpen: (organizerOpen) => set({ organizerOpen }),
      setExportOpen: (exportOpen) => set({ exportOpen }),
      setStepChoices: (stepChoices) => set({ stepChoices }),
      setStepStates: (patch) => set((s) => ({ stepStates: { ...s.stepStates, ...patch } })),
      setStepsRunning: (stepsRunning) => set({ stepsRunning }),

      /* Même raison : `settingsLoading` commande le routage vers la présentation. Un rejet le
         laissait vrai, et un premier lancement n'affichait plus qu'une coquille vide. */
      loadSettings: async () => {
        try {
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
          contentSources: settings.contentSources,
          videoCacheQuality: settings.videoCacheQuality,
          mediaStorageMode: settings.mediaStorageMode,
          playbackQuality: settings.playbackQuality,
          cacheLimitGb: settings.cacheLimitGb,
          trayEnabled: settings.trayEnabled,
          syncOnLaunch: settings.syncOnLaunch,
          syncSchedule: settings.syncSchedule,
          aiProvider: settings.aiProvider,
          aiModel: settings.aiModel,
          aiEndpoint: settings.aiEndpoint,
          autoTagEnabled: settings.autoTagEnabled,
          autoOrganizeEnabled: settings.autoOrganizeEnabled,
          afterSync: settings.afterSync,
          organizeMode: settings.organizeMode,
          onboardingDone: settings.onboardingDone,
          settingsLoading: false
        })
        } catch (error) {
          console.error('[magpie] Réglages illisibles', error)
          set({ settingsLoading: false })
        }
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

      setContentSources: async (contentSources) => {
        const next = contentSources.length > 0 ? [...new Set(contentSources)] : ['saved' as const]
        set({ contentSources: next })
        await magpie.setSettings({ contentSources: next })
        // Une seule origine active doit aussi devenir la vue courante. Avec les deux,
        // `[]` conserve le sens ergonomique de « toute la bibliothèque ».
        get().setQuery({ sources: next.length === 1 ? [next[0]] : [] })
      },

      setVideoCacheQuality: async (videoCacheQuality) => {
        set({ videoCacheQuality })
        await magpie.setSettings({ videoCacheQuality })
      },

      setMediaStorageMode: async (mediaStorageMode) => {
        set({ mediaStorageMode })
        await magpie.setSettings({ mediaStorageMode })
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

      setSyncOnLaunch: async (syncOnLaunch) => {
        set({ syncOnLaunch })
        await magpie.setSettings({ syncOnLaunch })
      },

      setSyncSchedule: async (syncSchedule) => {
        set({ syncSchedule })
        await magpie.setSettings({ syncSchedule })
      },

      setAutoOrganizeEnabled: async (autoOrganizeEnabled) => {
        set({ autoOrganizeEnabled })
        await magpie.setSettings({ autoOrganizeEnabled })
      },

      /* L'ordre canonique, et non celui des clics : le réglage se relit ailleurs comme une
         liste d'étapes à suivre, et une liste qui change d'ordre selon l'ordre de cochage
         se lirait mal partout où on l'affiche. */
      setAfterSync: async (steps) => {
        const afterSync = AFTER_SYNC_STEPS.filter((step) => steps.includes(step))
        set({ afterSync })
        await magpie.setSettings({ afterSync })
      },

      /* Écrit seulement quand un rangement est allé au bout. Le noter au lancement dirait que
         la carte est prête alors que l'analyse vient à peine de commencer. */
      setOrganizeMode: async (organizeMode) => {
        set({ organizeMode })
        await magpie.setSettings({ organizeMode })
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
        await magpie.addTag(postId, name)
        const before = get().posts
        const posts = before
          .map((post) =>
            post.id === postId && !post.tags.some((tag) => tag.name === name)
              ? { ...post, tags: [...post.tags, { name, source: 'user' as const }] }
              : post
          )
          .filter((post) => !(get().query.untaggedOnly && post.id === postId))
        set({
          posts,
          layoutRevision:
            posts.length !== before.length ? get().layoutRevision + 1 : get().layoutRevision,
          resultTotal: Math.max(0, get().resultTotal - (before.length - posts.length))
        })
        refreshStatsSoon()
      },

      removeTag: async (postId, name) => {
        await magpie.removeTag(postId, name)
        const before = get().posts
        const selectedTags = new Set(get().query.tags.map((tag) => tag.toLocaleLowerCase()))
        const posts = before
          .map((post) =>
            post.id === postId
              ? {
                  ...post,
                  tags: post.tags.filter(
                    (tag) => tag.name.toLocaleLowerCase() !== name.toLocaleLowerCase()
                  )
              }
              : post
          )
          .filter(
            (post) =>
              !(
                post.id === postId &&
                selectedTags.size > 0 &&
                !post.tags.some((tag) => selectedTags.has(tag.name.toLocaleLowerCase()))
              )
          )
        set({
          posts,
          layoutRevision:
            posts.length !== before.length ? get().layoutRevision + 1 : get().layoutRevision,
          resultTotal: Math.max(0, get().resultTotal - (before.length - posts.length))
        })
        refreshStatsSoon()
      },

      setLabel: async (postId, label) => {
        await magpie.setLabel(postId, label)
        const before = get().posts
        const posts = before
          .map((post) => (post.id === postId ? { ...post, label } : post))
          .filter(
            (post) => !(post.id === postId && get().query.label && get().query.label !== label)
          )
        set({
          posts,
          layoutRevision:
            posts.length !== before.length ? get().layoutRevision + 1 : get().layoutRevision,
          resultTotal: Math.max(0, get().resultTotal - (before.length - posts.length))
        })
        refreshStatsSoon()
      },

      /** Navigation dans la vue détaillée, bornée aux extrémités plutôt que circulaire. */
      stepDetail: (delta) => {
        const { detailIndex, posts, hasMore } = get()
        if (detailIndex === null || posts.length === 0) return
        if (delta > 0 && detailIndex === posts.length - 1 && hasMore) {
          const currentId = posts[detailIndex].id
          void get().loadMore().then(() => {
            const current = get().posts.findIndex((post) => post.id === currentId)
            if (current >= 0 && current + 1 < get().posts.length) set({ detailIndex: current + 1 })
          })
          return
        }
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
          void get().refresh(false, true)
        }
      },

      toggleFavorite: async (id) => {
        const isFavorite = await magpie.toggleFavorite(id)
        const before = get().posts
        const posts = before
          .map((p) => (p.id === id ? { ...p, isFavorite } : p))
          .filter((post) => !(get().query.favoritesOnly && post.id === id && !isFavorite))
        set({
          posts,
          resultTotal: Math.max(0, get().resultTotal - (before.length - posts.length)),
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
      storage: createJSONStorage(deferredStorage),
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
      }),
      // Zustand fusionne normalement seulement le premier niveau. Fusionner aussi la
      // requête permet aux nouveaux filtres ajoutés dans une future version de recevoir
      // leur valeur par défaut sans effacer les préférences déjà enregistrées.
      merge: (persisted, current) => {
        const saved = persisted as Partial<State>
        const savedQuery = saved.query as
          | (Partial<PostQuery> & { tag?: string | null; collectionId?: number | null })
          | undefined
        return {
          ...current,
          ...saved,
          query: {
            ...DEFAULT_QUERY,
            ...(savedQuery ?? {}),
            tags: Array.isArray(savedQuery?.tags)
              ? savedQuery.tags
              : savedQuery?.tag
                ? [savedQuery.tag]
                : [],
            collectionIds: Array.isArray(savedQuery?.collectionIds)
              ? savedQuery.collectionIds
              : Number.isInteger(savedQuery?.collectionId)
                ? [Number(savedQuery?.collectionId)]
                : []
          }
        }
      }
    }
  )
)
