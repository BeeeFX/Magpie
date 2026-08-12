/** Types partagés entre le processus principal et le renderer. */

export const PLATFORMS = ['instagram', 'x', 'reddit'] as const
export type Platform = (typeof PLATFORMS)[number]

export const POST_KINDS = ['image', 'carousel', 'video', 'text', 'link'] as const
export type PostKind = (typeof POST_KINDS)[number]

/** Origine d'un tag — détermine son rendu et ce qu'une purge en masse efface. */
export type TagSource = 'user' | 'rule' | 'ai'

/**
 * Palette des étiquettes de couleur, commune aux posts et aux collections.
 *
 * Sept teintes bien séparées, dans l'esprit du Finder : la couleur est le repère le plus
 * rapide qui existe — on la voit sans lire, ce qu'aucun tag ne permet.
 */
export const LABELS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'grey'] as const
export type LabelColor = (typeof LABELS)[number]

export interface Post {
  id: string
  platform: Platform
  nativeId: string
  /** URL canonique — c'est elle que copie le bouton et qu'on envoie à Nitrate. */
  url: string
  authorHandle: string | null
  authorName: string | null
  text: string | null
  /** Description du contenu générée par Claude (M4). Indexée en recherche plein texte. */
  aiDescription: string | null
  kind: PostKind
  mediaCount: number
  /** Dimensions du média principal. Stockées pour que le masonry calcule sa mise en page
   *  sans charger la moindre image — c'est ce qui rend le scroll fluide. */
  width: number | null
  height: number | null
  dominantColor: string | null
  /** Vignette du média principal — raccourci sur `media[0]`, pour la grille. */
  thumbUrl: string | null
  /** Tous les médias du post, dans l'ordre. Un post texte a un tableau vide. */
  media: PostMedia[]
  publishedAt: number | null
  savedAt: number | null
  discoveredAt: number
  savedRank: number | null
  isFavorite: boolean
  isArchived: boolean
  /** Étiquette de couleur, ou null si le post n'en porte pas. */
  label: LabelColor | null
  tags: TagRef[]
}

export interface TagRef {
  name: string
  source: TagSource
}

/** Un média d'un post. Un carrousel en compte plusieurs, dans l'ordre de `idx`. */
export interface PostMedia {
  idx: number
  kind: 'image' | 'video'
  /** URL `magpie://thumb/…` de la vignette en cache. */
  thumbUrl: string | null
  /** URL `magpie://video/…` du clip en cache, pour la lecture au survol. */
  videoUrl: string | null
  width: number | null
  height: number | null
  /** Qualités que la plateforme expose pour ce clip. */
  videoQualities: VideoQuality[]
}

export type SortKey = 'saved' | 'published' | 'author' | 'platform' | 'random'
export type GridMode = 'masonry' | 'cards'

export type ThemeChoice = 'system' | 'light' | 'dark'
export type VideoQuality = '480p' | '720p' | '1080p' | 'source'
export type PlaybackQuality = 'auto' | VideoQuality
export type SyncSchedule = 'manual' | 'hourly' | '6h' | 'daily'
export type AiProvider = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'custom'

export const LANGUAGES = ['fr', 'en'] as const
export type Language = (typeof LANGUAGES)[number]
/** « system » suit la langue de l'ordinateur, résolue au démarrage. */
export type LanguageChoice = 'system' | Language
export const ACCENTS = ['violet', 'iridescent', 'amber', 'rose', 'azure', 'lime'] as const
export type AccentName = (typeof ACCENTS)[number]

/**
 * Réglages persistés côté processus principal plutôt que dans le renderer : le thème
 * détermine aussi la couleur des boutons système dessinés par l'OS par-dessus notre barre
 * de titre, que seul le processus principal peut fixer.
 */
export interface Settings {
  theme: ThemeChoice
  language: LanguageChoice
  accent: AccentName
  /** Affiche le bouton « Envoyer vers Nitrate » sur les posts vidéo. Désactivé par défaut. */
  nitrateEnabled: boolean
  /** Faux au premier lancement : la présentation s'affiche à la place de l'application. */
  onboardingDone: boolean
  /** Qualité maximale mise en cache automatiquement. */
  videoCacheQuality: VideoQuality
  /** Qualité préférée dans le lecteur détaillé. */
  playbackQuality: PlaybackQuality
  /** Plafond du cache média, en Gio. */
  cacheLimitGb: number
  trayEnabled: boolean
  syncSchedule: SyncSchedule
  aiProvider: AiProvider
  aiModel: string
  aiEndpoint: string
  autoTagEnabled: boolean
}

export interface CollectionInfo {
  id: number
  name: string
  count: number
  color: LabelColor | null
}

export interface AddToCollectionResult {
  added: number
  /** Posts déjà présents dans la collection — voir SPEC.md §9 sur les doublons. */
  alreadyThere: string[]
  collectionName: string
}

export interface AccountInfo {
  platform: Platform
  connected: boolean
  handle: string | null
  lastSyncAt: number | null
  lastSyncStatus: string | null
}

export type SyncPhase = 'idle' | 'running' | 'done' | 'error' | 'cancelled'

export interface PlatformSync {
  phase: SyncPhase
  /** Signets parcourus pendant cette synchronisation. */
  fetched: number
  /** Signets réellement nouveaux. */
  added: number
  page: number
  message: string | null
  /** La plateforme exige une intervention manuelle : aucune reprise automatique. */
  needsAttention: boolean
}

/**
 * État de synchronisation, **par plateforme**.
 *
 * Les trois plateformes sont des services indépendants : les synchroniser ensemble
 * n'augmente en rien le nombre de requêtes vues par chacune. La temporisation prudente
 * s'applique donc à l'intérieur de chaque plateforme, pas entre elles.
 */
export interface SyncState {
  byPlatform: Record<Platform, PlatformSync>
  /** Vrai tant qu'au moins une plateforme travaille. */
  running: boolean
  fetched: number
  added: number
}

export const IDLE_PLATFORM_SYNC: PlatformSync = {
  phase: 'idle',
  fetched: 0,
  added: 0,
  page: 0,
  message: null,
  needsAttention: false
}

export function idleSyncState(): SyncState {
  return {
    byPlatform: {
      instagram: { ...IDLE_PLATFORM_SYNC },
      x: { ...IDLE_PLATFORM_SYNC },
      reddit: { ...IDLE_PLATFORM_SYNC }
    },
    running: false,
    fetched: 0,
    added: 0
  }
}

export interface LibraryInfo {
  posts: number
  media: number
  /** Posts issus de la fixture de démonstration, distincts des vrais signets. */
  demoPosts: number
  /** Octets occupés par le cache de vignettes et de clips. */
  cacheBytes: number
  dataPath: string
  version: string
}

export interface PostQuery {
  /** Vide = toutes les plateformes. */
  platforms: Platform[]
  /** Vide = tous les types. */
  kinds: PostKind[]
  favoritesOnly: boolean
  untaggedOnly: boolean
  tag: string | null
  collectionId: number | null
  label: LabelColor | null
  search: string
  sort: SortKey
  /** Graine du tri aléatoire, pour qu'il reste stable pendant qu'on scrolle. */
  randomSeed: number
}

export const DEFAULT_QUERY: PostQuery = {
  platforms: [],
  kinds: [],
  favoritesOnly: false,
  untaggedOnly: false,
  tag: null,
  collectionId: null,
  label: null,
  search: '',
  sort: 'saved',
  randomSeed: 1
}

export interface LibraryStats {
  total: number
  favorites: number
  byPlatform: Record<Platform, number>
  /** Nombre de posts par étiquette de couleur ; les teintes inutilisées sont absentes. */
  byLabel: Partial<Record<LabelColor, number>>
  topTags: { name: string; count: number; source: TagSource }[]
}

/** Surface IPC exposée au renderer via contextBridge. */
export interface MagpieApi {
  listPosts(query: PostQuery): Promise<Post[]>
  getStats(): Promise<LibraryStats>
  toggleFavorite(id: string): Promise<boolean>
  setFavoriteMany(ids: string[], value: boolean): Promise<void>
  addTagMany(ids: string[], name: string): Promise<void>
  hasAiKey(provider: AiProvider): Promise<boolean>
  setAiKey(provider: AiProvider, key: string): Promise<void>
  startAiTagging(postIds?: string[]): Promise<AiTagProgress>
  copyToClipboard(text: string): Promise<void>
  openExternal(url: string): Promise<void>
  sendToNitrate(url: string): Promise<void>
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  getLibraryInfo(): Promise<LibraryInfo>
  clearMediaCache(): Promise<void>
  openDataFolder(): Promise<void>
  chooseLibraryFolder(): Promise<{ moved: boolean; path: string }>
  cacheVideoQuality(postId: string, mediaIndex: number, quality: VideoQuality): Promise<string>

  setLabel(postId: string, label: LabelColor | null): Promise<Post[]>
  setCollectionColor(collectionId: number, color: LabelColor | null): Promise<void>
  addTag(postId: string, name: string): Promise<Post[]>
  removeTag(postId: string, name: string): Promise<Post[]>
  listCollections(): Promise<CollectionInfo[]>
  createCollection(name: string): Promise<CollectionInfo>
  addToCollection(collectionId: number, postIds: string[], readd?: boolean): Promise<AddToCollectionResult>
  removeFromCollection(collectionId: number, postId: string): Promise<void>
  collectionsForPost(postId: string): Promise<number[]>

  listAccounts(): Promise<AccountInfo[]>
  connectAccount(platform: Platform): Promise<AccountInfo>
  disconnectAccount(platform: Platform): Promise<AccountInfo>
  startSync(platforms?: Platform[]): Promise<SyncState>
  startFullSync(platform: Platform): Promise<SyncState>
  cancelSync(platform?: Platform): Promise<void>
  getSyncState(): Promise<SyncState>
  /** Charge la bibliothèque de démonstration. Outil de test, jamais automatique. */
  loadDemoData(): Promise<number>
  removeDemoData(): Promise<number>

  platform: NodeJS.Platform
}

export interface CacheProgress {
  done: number
  total: number
}

export interface AiTagProgress {
  done: number
  total: number
  tagged: number
  failed: number
  running: boolean
}

/** Événements poussés par le processus principal. Chaque abonnement rend son désabonnement. */
export interface MagpieEvents {
  onCacheProgress(cb: (progress: CacheProgress) => void): () => void
  onLibraryUpdated(cb: () => void): () => void
  /** Thème effectif résolu par le processus principal (« system » déjà tranché). */
  onThemeChanged(cb: (isDark: boolean) => void): () => void
  onSyncState(cb: (state: SyncState) => void): () => void
  onAiTagProgress(cb: (progress: AiTagProgress) => void): () => void
}

declare global {
  interface Window {
    magpie: MagpieApi
    magpieEvents: MagpieEvents
  }
}
