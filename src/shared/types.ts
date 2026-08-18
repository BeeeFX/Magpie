/** Types partagés entre le processus principal et le renderer. */

export const PLATFORMS = ['instagram', 'x', 'reddit'] as const
export type Platform = (typeof PLATFORMS)[number]
/** Reddit reste implémenté mais est retiré du produit tant que son flux bloque les sessions. */
export const PUBLIC_PLATFORMS = ['instagram', 'x'] as const satisfies readonly Platform[]

/** Plafond de pages parcourues en une passe. Il sert aussi de repère visuel à la barre
 * de progression : les plateformes ne publient pas le nombre total de pages à l'avance. */
export const SYNC_PAGE_LIMITS: Record<Platform, number> = {
  instagram: 120,
  x: 120,
  reddit: 60
}

export const POST_KINDS = ['image', 'carousel', 'video', 'text', 'link'] as const
export type PostKind = (typeof POST_KINDS)[number]
export const CONTENT_SOURCES = ['saved', 'liked'] as const
export type ContentSource = (typeof CONTENT_SOURCES)[number]

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
  /** Un post présent dans les deux flux reste une seule entrée dans la bibliothèque. */
  sources: ContentSource[]
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
  /** Une source locale ou distante existe, même si la vignette n'est pas encore prête. */
  hasSource?: boolean
  /** Permet de distinguer une vignette en cours d'un échec définitif. */
  thumbStatus?: 'ready' | 'pending' | 'failed'
  width: number | null
  height: number | null
  /** Qualités que la plateforme expose pour ce clip. */
  videoQualities: VideoQuality[]
}

/** Tranche d'un mur potentiellement très grand. Les lots sont préchargés avant que
 * l'utilisateur atteigne le bas, donnant un scroll continu sans charger 10 000 posts. */
export interface PostPage {
  posts: Post[]
  /** Taille du jeu de résultats, comptée à la première tranche seulement : le COUNT coûte
   *  à lui seul bien plus que la page (près de trente fois plus à 60 000 posts) et sa
   *  valeur ne change pas d'une tranche à l'autre. `null` sur les suivantes — l'appelant
   *  conserve alors le total qu'il connaît déjà. */
  total: number | null
  offset: number
  hasMore: boolean
}

export type SortKey = 'saved' | 'published' | 'author' | 'platform' | 'random'
export type GridMode = 'masonry' | 'cards'

export type ThemeChoice = 'system' | 'light' | 'dark'
export type VideoQuality = '480p' | '720p' | '1080p' | 'source'
export type PlaybackQuality = 'auto' | VideoQuality
export type MediaStorageMode = 'stream' | 'offline'
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
  /** Flux importés depuis chaque compte connecté. Au moins une origine est toujours active. */
  contentSources: ContentSource[]
  /** Qualité maximale mise en cache automatiquement. */
  videoCacheQuality: VideoQuality
  /** `stream` conserve seulement les vignettes ; `offline` garde aussi les clips. */
  mediaStorageMode: MediaStorageMode
  /** Qualité préférée dans le lecteur détaillé. */
  playbackQuality: PlaybackQuality
  /** Plafond du cache média, en Gio. */
  cacheLimitGb: number
  trayEnabled: boolean
  /** Vérifie les nouveaux signets à chaque lancement, indépendamment de la répétition. */
  syncOnLaunch: boolean
  syncSchedule: SyncSchedule
  aiProvider: AiProvider
  aiModel: string
  aiEndpoint: string
  autoTagEnabled: boolean
  /** Range les nouveaux contenus après chaque synchronisation selon les choix locaux mémorisés. */
  /** Recette de rapprochement : voir RECIPES. Exposée pour être comparée à l'usage. */
  organizerRecipe:
    | 'texte'
    | 'equilibre'
    | 'image'
    | 'sujet'
    | 'style'
    | 'sujetSeul'
    | 'structureSeule'
    | 'structureHaute'
  autoOrganizeEnabled: boolean
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

export type LibraryMovePhase = 'preparing' | 'database' | 'media' | 'finalizing' | 'done' | 'error'

export interface LibraryMoveProgress {
  phase: LibraryMovePhase
  /** Octets copiés. La sauvegarde SQLite est convertie en octets estimés par page. */
  done: number
  total: number
  path: string
  message: string | null
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'up-to-date'
  | 'error'
  | 'unsupported'

export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  availableVersion: string | null
  /** Progression du téléchargement, entre 0 et 100. */
  percent: number | null
  /** Diagnostic court ; jamais utilisé comme texte principal de l'interface. */
  message: string | null
}

export interface PostQuery {
  /** Vide = toutes les plateformes. */
  platforms: Platform[]
  /** Vide = toutes les origines activées. */
  sources: ContentSource[]
  /** Vide = tous les types. */
  kinds: PostKind[]
  favoritesOnly: boolean
  untaggedOnly: boolean
  /** Vide = tous les tags ; plusieurs valeurs sont combinées avec OU. */
  tags: string[]
  /** Vide = toutes les collections ; plusieurs valeurs sont combinées avec OU. */
  collectionIds: number[]
  label: LabelColor | null
  search: string
  sort: SortKey
  /** Graine du tri aléatoire, pour qu'il reste stable pendant qu'on scrolle. */
  randomSeed: number
}

export const DEFAULT_QUERY: PostQuery = {
  platforms: [],
  sources: [],
  kinds: [],
  favoritesOnly: false,
  untaggedOnly: false,
  tags: [],
  collectionIds: [],
  label: null,
  search: '',
  sort: 'saved',
  randomSeed: 1
}

export interface LibraryStats {
  total: number
  favorites: number
  byPlatform: Record<Platform, number>
  bySource: Record<ContentSource, number>
  /** Nombre de posts par étiquette de couleur ; les teintes inutilisées sont absentes. */
  byLabel: Partial<Record<LabelColor, number>>
  topTags: { name: string; count: number; source: TagSource }[]
}

/** Surface IPC exposée au renderer via contextBridge. */
export interface MagpieApi {
  listPosts(query: PostQuery): Promise<Post[]>
  listPostPage(query: PostQuery, offset: number, limit: number): Promise<PostPage>
  getPostsByIds(ids: string[]): Promise<Post[]>
  getStats(): Promise<LibraryStats>
  toggleFavorite(id: string): Promise<boolean>
  setFavoriteMany(ids: string[], value: boolean): Promise<void>
  addTagMany(ids: string[], name: string): Promise<void>
  hasAiKey(provider: AiProvider): Promise<boolean>
  setAiKey(provider: AiProvider, key: string): Promise<void>
  startAiTagging(postIds?: string[]): Promise<AiTagProgress>
  proposeAiCollections(): Promise<AiCollectionPlan>
  applyAiCollections(
    choices: AiCollectionChoice[],
    memory: AiCollectionMemoryOptions
  ): Promise<AiCollectionApplyResult>
  setBandwidthLimit(bytesPerSecond: number): Promise<BackgroundState>
  setLoadProfile(profile: LoadProfile): Promise<BackgroundState>
  setTaskPaused(id: string, paused: boolean): Promise<BackgroundState>
  exportLibrary(): Promise<ExportSummary>
  exportPrompt(): Promise<string>
  openExportFolder(): Promise<void>
  transcriptState(): Promise<{ pending: number; running: boolean }>
  imageReadingState(): Promise<{ pending: number; running: boolean }>
  startImageReading(): Promise<BackgroundState>
  stopImageReading(): Promise<BackgroundState>
  startTranscription(): Promise<BackgroundState>
  stopTranscription(): Promise<BackgroundState>
  organizerMap(): Promise<OrganizerMap>
  lastOrganizerApplication(): Promise<OrganizerApplicationSummary | null>
  undoOrganizerApplication(): Promise<OrganizerUndoResult>
  copyToClipboard(text: string): Promise<void>
  openExternal(url: string): Promise<void>
  sendToNitrate(url: string): Promise<void>
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  getLibraryInfo(): Promise<LibraryInfo>
  getUpdateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  installUpdate(): Promise<void>
  setWindowFullscreen(enabled: boolean): Promise<boolean>
  clearMediaCache(): Promise<ClearCacheResult>
  openDataFolder(): Promise<void>
  chooseLibraryFolder(): Promise<{ moved: boolean; path: string }>
  getMediaPlaybackUrl(
    postId: string,
    mediaIndex: number,
    kind: 'image' | 'video',
    quality: PlaybackQuality
  ): Promise<string>
  /** Priorise les vignettes visibles dans le cache intelligent. */
  requestThumbnails(postIds: string[]): Promise<void>
  diagnoseMedia(
    postId: string,
    mediaIndex: number,
    kind: 'image' | 'video',
    quality: PlaybackQuality
  ): Promise<MediaDiagnostic>
  getBackgroundState(): Promise<BackgroundState>
  startPreload(request: PreloadRequest): Promise<BackgroundState>
  stopPreload(kind: 'thumbnails' | 'clips'): Promise<BackgroundState>
  setDownloadsPaused(paused: boolean): Promise<BackgroundState>
  pendingCounts(query: PostQuery | null): Promise<{ thumbnails: number; clips: number }>

  setLabel(postId: string, label: LabelColor | null): Promise<void>
  setCollectionColor(collectionId: number, color: LabelColor | null): Promise<void>
  addTag(postId: string, name: string): Promise<void>
  removeTag(postId: string, name: string): Promise<void>
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
  /** Médias tout juste traités, pour actualiser leurs cartes sans recharger le mur. */
  postIds?: string[]
}

export interface AiTagProgress {
  done: number
  total: number
  tagged: number
  failed: number
  running: boolean
}

export interface OrganizerProgress {
  stage: 'idle' | 'preparing' | 'visuals' | 'embedding' | 'grouping' | 'projecting'
  done: number
  total: number
  running: boolean
}

export interface AiCollectionSuggestion {
  id: string
  /** Identifiants sémantiques stables utilisés pour mémoriser renommages et fusions. */
  ruleKeys: string[]
  name: string
  /** Courte explication destinée à aider l'utilisateur à arbitrer ou fusionner. */
  description: string
  postIds: string[]
}

export interface AiCollectionRoute {
  postId: string
  /** Catégories compatibles, de la plus pertinente à la moins pertinente. */
  rankedRuleKeys: string[]
}

export interface AiCollectionPlan {
  suggestions: AiCollectionSuggestion[]
  /** Alternatives conservées afin de redistribuer une catégorie exclue sans nouvelle analyse. */
  routes: AiCollectionRoute[]
  analysedVideos: number
  unassignedVideos: number
}

/**
 * Un post sur la carte sémantique.
 *
 * `x` et `y` sont dans [0, 1] : la vue décide de l'échelle, pas le calcul. Ils viennent de la
 * projection des vecteurs, donc la distance affichée est de la proximité de sens.
 */
export interface OrganizerMapPoint {
  id: string
  x: number
  y: number
  /** Identifiant de la suggestion à laquelle il appartient, ou null s'il flotte seul. */
  group: string | null
  thumbUrl: string | null
  platform: Platform
  kind: PostKind
  /** Signets et likes se distinguent à l'œil sans jamais filtrer l'analyse. */
  sources: ContentSource[]
}

/** Ce qu'un export a produit. Sert à décrire le dossier avant de l'ouvrir. */
export interface ExportSummary {
  path: string
  posts: number
  collections: number
  transcripts: number
  /** Fiches réellement réécrites : un réexport n'en touche que ce qui a changé. */
  written: number
  bytes: number
  at: number
}

export interface OrganizerMap {
  points: OrganizerMapPoint[]
  /** Le plan qui a servi à colorer la carte : mêmes identifiants que `points.group`. */
  plan: AiCollectionPlan
}

export interface AiCollectionChoice {
  name: string
  postIds: string[]
  ruleKeys: string[]
}

export interface AiCollectionMemoryOptions {
  remember: boolean
  ignoredRuleKeys: string[]
}

export interface AiCollectionApplyResult {
  collections: number
  added: number
  alreadyThere: number
  /** Collections déjà existantes que le classement a rejointes plutôt que créées. */
  joinedExisting: string[]
}

/**
 * Travail de fond, tel qu'il se montre à l'utilisateur.
 *
 * Synchronisation, vignettes, clips et organisation avançaient chacun dans leur coin, avec
 * leur propre événement et leur propre coin d'interface. Les réunir derrière un seul état
 * permet de n'avoir qu'un indicateur à regarder — et de tout suspendre d'un geste.
 */
export type BackgroundTaskKind =
  | 'sync'
  | 'thumbnails'
  | 'clips'
  | 'organizer'
  | 'transcribe'
  | 'images'

export interface BackgroundTask {
  /** Octets par seconde observés sur cette tâche, ou null si elle ne transfère rien. */
  bytesPerSecond?: number | null
  id: string
  kind: BackgroundTaskKind
  /** Ce sur quoi porte la tâche : nom de plateforme, de collection, de tag… */
  scope: string | null
  done: number
  /** Zéro quand l'ampleur n'est pas connue d'avance : l'interface montre alors une
   *  progression indéterminée plutôt qu'un pourcentage inventé. */
  total: number
  etaMs: number | null
  paused: boolean
  message: string | null
}

/**
 * Profils de charge, plutôt qu'un pourcentage.
 *
 * Un vrai plafond CPU en pourcentage n'est pas réalisable sans ordonnanceur : ce qu'on règle,
 * c'est le nombre de travailleurs simultanés. Annoncer « 40 % » serait un mensonge d'interface.
 */
export const LOAD_PROFILES = ['light', 'balanced', 'fast'] as const
export type LoadProfile = (typeof LOAD_PROFILES)[number]

/** Un échantillon par seconde, pour tracer la courbe des dernières minutes. */
export interface ThroughputSample {
  at: number
  bytesPerSecond: number
  itemsPerSecond: number
}

export interface BackgroundState {
  tasks: BackgroundTask[]
  /** Vrai dès qu'un téléchargement est suspendu à la demande. */
  paused: boolean
  /** Quota atteint : poursuivre ne ferait qu'évincer ce qu'on vient d'écrire, alors les
   *  téléchargements s'arrêtent et l'interface propose de libérer ou d'agrandir. */
  cacheFull: boolean
  /** La part réservée aux vignettes est pleine : elles se remplacent sans jamais aboutir. */
  cacheThumbnailsCapped: boolean
  cacheThumbnailBytes: number
  cacheThumbnailBudget: number
  cacheBytes: number
  cacheLimitBytes: number
  /** Débit cumulé, toutes tâches confondues. */
  bytesPerSecond: number
  /** Les dernières minutes, une mesure par seconde, pour la courbe. */
  history: ThroughputSample[]
  /** Plafond de bande passante en octets par seconde, ou 0 si aucun. */
  bandwidthLimit: number
  loadProfile: LoadProfile
}

/** Ce qu'un préchargement doit préparer, et sur quel périmètre. */
export interface PreloadRequest {
  what: 'thumbnails' | 'clips'
  /** Sans requête, toute la bibliothèque. Avec, le périmètre affiché à l'écran. */
  query?: PostQuery | null
  scopeLabel?: string | null
}

/** Préparation en masse des vignettes du mur. `pending` n'est renseigné qu'à l'interrogation
 *  de l'état, pour annoncer le travail restant avant de lancer quoi que ce soit. */
export interface PreloadState {
  running: boolean
  done: number
  total: number
  remaining: number
  pending?: number
  /** Temps restant estimé, ou `null` tant que la cadence n'est pas assez établie pour
   *  qu'une annonce ait un sens. */
  etaMs?: number | null
}

/**
 * Résultat d'un test de diffusion, rejoué exactement comme le fait le protocole interne.
 * Sert à distinguer un lien expiré d'un problème de transport, que l'interface présente
 * autrement de la même façon : une vidéo qui ne démarre pas.
 */
export interface MediaDiagnostic {
  ok: boolean
  host: string | null
  status: number | null
  statusText: string | null
  contentType: string | null
  contentLength: string | null
  acceptRanges: string | null
  contentEncoding: string | null
  contentRange: string | null
  /** Octets réellement reçus sur la première tranche : distingue un flux vide d'un refus. */
  firstChunkBytes: number | null
  elapsedMs: number
  error: string | null
}

/** Une purge peut être partielle : un fichier encore ouvert résiste à sa suppression. */
export interface ClearCacheResult {
  removed: number
  failed: number
}

/** Dernier classement appliqué, tel qu'on peut le proposer à l'annulation. */
export interface OrganizerApplicationSummary {
  appliedAt: number
  collections: number
  posts: number
}

export interface OrganizerUndoResult {
  removed: number
  collectionsDeleted: number
}

/** Événements poussés par le processus principal. Chaque abonnement rend son désabonnement. */
export interface MagpieEvents {
  onCacheProgress(cb: (progress: CacheProgress) => void): () => void
  onLibraryUpdated(cb: () => void): () => void
  /** Thème effectif résolu par le processus principal (« system » déjà tranché). */
  onThemeChanged(cb: (isDark: boolean) => void): () => void
  onSyncState(cb: (state: SyncState) => void): () => void
  onAiTagProgress(cb: (progress: AiTagProgress) => void): () => void
  onOrganizerProgress(cb: (progress: OrganizerProgress) => void): () => void
  onBackgroundState(cb: (state: BackgroundState) => void): () => void
  onUpdateState(cb: (state: UpdateState) => void): () => void
  onLibraryMoveProgress(cb: (progress: LibraryMoveProgress) => void): () => void
  onWindowInteraction(cb: (active: boolean) => void): () => void
  onWindowFullscreen(cb: (fullscreen: boolean) => void): () => void
}

declare global {
  interface Window {
    magpie: MagpieApi
    magpieEvents: MagpieEvents
  }
}
