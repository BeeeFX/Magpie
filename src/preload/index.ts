import { contextBridge, ipcRenderer } from 'electron'
import type {
  CollectionHeat,
  CollectionMembership,
  AccountInfo,
  AddToCollectionResult,
  AiCollectionApplyResult,
  AiCollectionChoice,
  AiCollectionMemoryOptions,
  AiCollectionPlan,
  AiProvider,
  AiTagProgress,
  ClearCacheResult,
  CollectionInfo,
  LabelColor,
  LibraryInfo,
  LibraryMoveProgress,
  LibraryStats,
  MagpieApi,
  MagpieEvents,
  MediaDiagnostic,
  OrganizerApplicationSummary,
  ExportSummary,
  LoadProfile,
  OrganizerMap,
  OrganizerProgress,
  OrganizerUndoResult,
  PlaybackQuality,
  Platform,
  Post,
  BackgroundState,
  PreloadRequest,
  PostPage,
  PostQuery,
  Settings,
  SyncState,
  UpdateState
} from '@shared/types'

/**
 * Pont typé. Le renderer n'a jamais accès à `ipcRenderer` directement : il ne peut appeler
 * que les canaux listés ici, avec les formes déclarées dans `@shared/types`.
 */
const api: MagpieApi = {
  listPosts: (query: PostQuery): Promise<Post[]> => ipcRenderer.invoke('posts:list', query),
  listPostPage: (query: PostQuery, offset: number, limit: number): Promise<PostPage> =>
    ipcRenderer.invoke('posts:page', query, offset, limit),
  listPostIds: (query: PostQuery): Promise<string[]> => ipcRenderer.invoke('posts:ids', query),
  createCollectionFromPhrase: (phrase: string): Promise<number> =>
    ipcRenderer.invoke('collections:createPhrase', phrase),
  createManualCollection: (name: string, postIds: string[]): Promise<number> =>
    ipcRenderer.invoke('collections:createManual', name, postIds),
  deleteCollection: (collectionId: number): Promise<void> =>
    ipcRenderer.invoke('collections:delete', collectionId),
  mergeCollections: (from: number, into: number): Promise<void> =>
    ipcRenderer.invoke('collections:merge', from, into),
  collectionMembership: (): Promise<CollectionMembership[]> =>
    ipcRenderer.invoke('collections:membership'),
  collectionKeywords: (collectionId: number): Promise<{ word: string; weight: number }[]> =>
    ipcRenderer.invoke('collections:keywords', collectionId),
  addCollectionKeyword: (collectionId: number, word: string): Promise<CollectionHeat | null> =>
    ipcRenderer.invoke('collections:addKeyword', collectionId, word),
  setCollectionKeywordWeight: (
    collectionId: number,
    word: string,
    weight: number
  ): Promise<CollectionHeat | null> =>
    ipcRenderer.invoke('collections:keywordWeight', collectionId, word, weight),
  removeCollectionKeyword: (
    collectionId: number,
    word: string
  ): Promise<CollectionHeat | null> =>
    ipcRenderer.invoke('collections:removeKeyword', collectionId, word),
  renameCollection: (collectionId: number, name: string): Promise<void> =>
    ipcRenderer.invoke('collections:rename', collectionId, name),
  collectionHeat: (collectionId: number): Promise<CollectionHeat | null> =>
    ipcRenderer.invoke('collections:heat', collectionId),
  setCollectionSize: (collectionId: number, size: number): Promise<number> =>
    ipcRenderer.invoke('collections:size', collectionId, size),
  seedCollectionsFromTopics: (): Promise<number> => ipcRenderer.invoke('collections:seed'),
  contestedPosts: (): Promise<{ postId: string; collectionIds: number[] }[]> =>
    ipcRenderer.invoke('collections:contested'),
  getPostsByIds: (ids: string[]): Promise<Post[]> => ipcRenderer.invoke('posts:byIds', ids),
  getStats: (): Promise<LibraryStats> => ipcRenderer.invoke('stats:get'),
  toggleFavorite: (id: string): Promise<boolean> => ipcRenderer.invoke('posts:toggleFavorite', id),
  setFavoriteMany: (ids: string[], value: boolean): Promise<void> =>
    ipcRenderer.invoke('posts:setFavoriteMany', ids, value),
  addTagMany: (ids: string[], name: string): Promise<void> =>
    ipcRenderer.invoke('tags:addMany', ids, name),
  hasAiKey: (provider: AiProvider): Promise<boolean> => ipcRenderer.invoke('ai:hasKey', provider),
  setAiKey: (provider: AiProvider, key: string): Promise<void> =>
    ipcRenderer.invoke('ai:setKey', provider, key),
  startAiTagging: (postIds?: string[]): Promise<AiTagProgress> =>
    ipcRenderer.invoke('ai:start', postIds),
  proposeAiCollections: (): Promise<AiCollectionPlan> =>
    ipcRenderer.invoke('ai:proposeCollections'),
  applyAiCollections: (
    choices: AiCollectionChoice[],
    memory: AiCollectionMemoryOptions
  ): Promise<AiCollectionApplyResult> =>
    ipcRenderer.invoke('ai:applyCollections', choices, memory),
  setBandwidthLimit: (bytesPerSecond: number): Promise<BackgroundState> =>
    ipcRenderer.invoke('tasks:setBandwidth', bytesPerSecond),
  setLoadProfile: (profile: LoadProfile): Promise<BackgroundState> =>
    ipcRenderer.invoke('tasks:setLoadProfile', profile),
  setTaskPaused: (id: string, paused: boolean): Promise<BackgroundState> =>
    ipcRenderer.invoke('tasks:setTaskPaused', id, paused),
  exportLibrary: (): Promise<ExportSummary> => ipcRenderer.invoke('export:run'),
  exportPrompt: (): Promise<string> => ipcRenderer.invoke('export:prompt'),
  openExportFolder: (): Promise<void> => ipcRenderer.invoke('export:open'),
  transcriptState: (): Promise<{ pending: number; running: boolean }> =>
    ipcRenderer.invoke('transcribe:state'),
  imageReadingState: (): Promise<{ pending: number; running: boolean }> =>
    ipcRenderer.invoke('images:state'),
  startImageReading: (): Promise<BackgroundState> => ipcRenderer.invoke('images:start'),
  stopImageReading: (): Promise<BackgroundState> => ipcRenderer.invoke('images:stop'),
  startTranscription: (): Promise<BackgroundState> => ipcRenderer.invoke('transcribe:start'),
  stopTranscription: (): Promise<BackgroundState> => ipcRenderer.invoke('transcribe:stop'),
  organizerMap: (layout?: string): Promise<OrganizerMap> =>
    ipcRenderer.invoke('organizer:map', layout),
  organizerBoundaries: (): Promise<{ name: string; shape: string }[]> =>
    ipcRenderer.invoke('organizer:boundaries'),
  saveOrganizerBoundary: (name: string, shape: string, postIds: string[]): Promise<number> =>
    ipcRenderer.invoke('organizer:saveBoundary', name, shape, postIds),
  clearOrganizerBoundaries: (): Promise<boolean> =>
    ipcRenderer.invoke('organizer:clearBoundaries'),
  hasFrozenMap: (): Promise<boolean> => ipcRenderer.invoke('organizer:hasFrozenMap'),
  mapLabels: (): Promise<{ id: string; text: string; anchors: string[] }[]> =>
    ipcRenderer.invoke('map:labels'),
  saveMapLabel: (id: string, text: string, anchors: string[]): Promise<boolean> =>
    ipcRenderer.invoke('map:saveLabel', id, text, anchors),
  deleteMapLabel: (id: string): Promise<boolean> => ipcRenderer.invoke('map:deleteLabel', id),
  lastOrganizerApplication: (): Promise<OrganizerApplicationSummary | null> =>
    ipcRenderer.invoke('organizer:lastApplication'),
  undoOrganizerApplication: (): Promise<OrganizerUndoResult> =>
    ipcRenderer.invoke('organizer:undo'),
  copyToClipboard: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  sendToNitrate: (url: string): Promise<void> => ipcRenderer.invoke('nitrate:send', url),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('settings:set', patch),
  getLibraryInfo: (): Promise<LibraryInfo> => ipcRenderer.invoke('library:info'),
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke('updates:state'),
  checkForUpdates: (): Promise<UpdateState> => ipcRenderer.invoke('updates:check'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('updates:install'),
  setWindowFullscreen: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('window:setFullscreen', enabled),
  clearMediaCache: (): Promise<ClearCacheResult> => ipcRenderer.invoke('library:clearCache'),
  openDataFolder: (): Promise<void> => ipcRenderer.invoke('app:openDataFolder'),
  chooseLibraryFolder: (): Promise<{ moved: boolean; path: string }> =>
    ipcRenderer.invoke('library:chooseFolder'),
  getMediaPlaybackUrl: (
    postId: string,
    mediaIndex: number,
    kind: 'image' | 'video',
    quality: PlaybackQuality
  ): Promise<string> => ipcRenderer.invoke('media:playbackUrl', postId, mediaIndex, kind, quality),
  requestThumbnails: (postIds: string[]): Promise<void> =>
    ipcRenderer.invoke('media:requestThumbnails', postIds),
  diagnoseMedia: (
    postId: string,
    mediaIndex: number,
    kind: 'image' | 'video',
    quality: PlaybackQuality
  ): Promise<MediaDiagnostic> =>
    ipcRenderer.invoke('media:diagnose', postId, mediaIndex, kind, quality),
  getBackgroundState: (): Promise<BackgroundState> => ipcRenderer.invoke('tasks:state'),
  startPreload: (request: PreloadRequest): Promise<BackgroundState> =>
    ipcRenderer.invoke('tasks:preload', request),
  stopPreload: (kind: 'thumbnails' | 'clips'): Promise<BackgroundState> =>
    ipcRenderer.invoke('tasks:stop', kind),
  setDownloadsPaused: (paused: boolean): Promise<BackgroundState> =>
    ipcRenderer.invoke('tasks:pause', paused),
  pendingCounts: (query: PostQuery | null): Promise<{ thumbnails: number; clips: number }> =>
    ipcRenderer.invoke('tasks:pending', query),

  setLabel: (postId: string, label: LabelColor | null): Promise<void> =>
    ipcRenderer.invoke('posts:setLabel', postId, label),
  setCollectionColor: (collectionId: number, color: LabelColor | null): Promise<void> =>
    ipcRenderer.invoke('collections:setColor', collectionId, color),
  addTag: (postId: string, name: string): Promise<void> =>
    ipcRenderer.invoke('tags:add', postId, name),
  removeTag: (postId: string, name: string): Promise<void> =>
    ipcRenderer.invoke('tags:remove', postId, name),
  listCollections: (): Promise<CollectionInfo[]> => ipcRenderer.invoke('collections:list'),
  createCollection: (name: string): Promise<CollectionInfo> =>
    ipcRenderer.invoke('collections:create', name),
  addToCollection: (
    collectionId: number,
    postIds: string[],
    readd?: boolean
  ): Promise<AddToCollectionResult> =>
    ipcRenderer.invoke('collections:add', collectionId, postIds, readd),
  removeFromCollection: (collectionId: number, postId: string): Promise<void> =>
    ipcRenderer.invoke('collections:remove', collectionId, postId),
  collectionsForPost: (postId: string): Promise<number[]> =>
    ipcRenderer.invoke('collections:forPost', postId),

  listAccounts: (): Promise<AccountInfo[]> => ipcRenderer.invoke('accounts:list'),
  connectAccount: (platform: Platform): Promise<AccountInfo> =>
    ipcRenderer.invoke('accounts:connect', platform),
  disconnectAccount: (platform: Platform): Promise<AccountInfo> =>
    ipcRenderer.invoke('accounts:disconnect', platform),
  startSync: (platforms?: Platform[]): Promise<SyncState> =>
    ipcRenderer.invoke('sync:start', platforms),
  startFullSync: (platform: Platform): Promise<SyncState> =>
    ipcRenderer.invoke('sync:full', platform),
  cancelSync: (platform?: Platform): Promise<void> => ipcRenderer.invoke('sync:cancel', platform),
  getSyncState: (): Promise<SyncState> => ipcRenderer.invoke('sync:state'),
  loadDemoData: (): Promise<number> => ipcRenderer.invoke('library:loadDemo'),
  removeDemoData: (): Promise<number> => ipcRenderer.invoke('library:removeDemo'),

  platform: process.platform
}

const events: MagpieEvents = {
  onCacheProgress: (cb) => {
    const listener = (_e: unknown, progress: { done: number; total: number }): void => cb(progress)
    ipcRenderer.on('cache:progress', listener)
    return () => ipcRenderer.removeListener('cache:progress', listener)
  },
  onLibraryUpdated: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('library:updated', listener)
    return () => ipcRenderer.removeListener('library:updated', listener)
  },
  onThemeChanged: (cb) => {
    const listener = (_e: unknown, isDark: boolean): void => cb(isDark)
    ipcRenderer.on('theme:changed', listener)
    return () => ipcRenderer.removeListener('theme:changed', listener)
  },
  onSyncState: (cb) => {
    const listener = (_e: unknown, state: SyncState): void => cb(state)
    ipcRenderer.on('sync:state', listener)
    return () => ipcRenderer.removeListener('sync:state', listener)
  },
  onAiTagProgress: (cb) => {
    const listener = (_e: unknown, progress: AiTagProgress): void => cb(progress)
    ipcRenderer.on('ai:progress', listener)
    return () => ipcRenderer.removeListener('ai:progress', listener)
  },
  onOrganizerProgress: (cb) => {
    const listener = (_e: unknown, value: OrganizerProgress): void => cb(value)
    ipcRenderer.on('organizer:progress', listener)
    return () => ipcRenderer.removeListener('organizer:progress', listener)
  },
  onBackgroundState: (cb) => {
    const listener = (_e: unknown, state: BackgroundState): void => cb(state)
    ipcRenderer.on('tasks:state', listener)
    return () => ipcRenderer.removeListener('tasks:state', listener)
  },
  onUpdateState: (cb) => {
    const listener = (_e: unknown, state: UpdateState): void => cb(state)
    ipcRenderer.on('updates:state', listener)
    return () => ipcRenderer.removeListener('updates:state', listener)
  },
  onLibraryMoveProgress: (cb) => {
    const listener = (_e: unknown, progress: LibraryMoveProgress): void => cb(progress)
    ipcRenderer.on('library:moveProgress', listener)
    return () => ipcRenderer.removeListener('library:moveProgress', listener)
  },
  onWindowInteraction: (cb) => {
    const listener = (_e: unknown, active: boolean): void => cb(active)
    ipcRenderer.on('window:interaction', listener)
    return () => ipcRenderer.removeListener('window:interaction', listener)
  },
  onWindowFullscreen: (cb) => {
    const listener = (_e: unknown, fullscreen: boolean): void => cb(fullscreen)
    ipcRenderer.on('window:fullscreen', listener)
    return () => ipcRenderer.removeListener('window:fullscreen', listener)
  }
}

contextBridge.exposeInMainWorld('magpie', api)
contextBridge.exposeInMainWorld('magpieEvents', events)
