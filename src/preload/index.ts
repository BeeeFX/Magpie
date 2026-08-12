import { contextBridge, ipcRenderer } from 'electron'
import type {
  AccountInfo,
  AddToCollectionResult,
  AiProvider,
  AiTagProgress,
  CollectionInfo,
  LabelColor,
  LibraryInfo,
  LibraryStats,
  MagpieApi,
  MagpieEvents,
  Platform,
  Post,
  PostQuery,
  Settings,
  SyncState,
  VideoQuality
} from '@shared/types'

/**
 * Pont typé. Le renderer n'a jamais accès à `ipcRenderer` directement : il ne peut appeler
 * que les canaux listés ici, avec les formes déclarées dans `@shared/types`.
 */
/**
 * Dernière requête émise. Les mutations de tags renvoient la liste rafraîchie, et elle
 * doit respecter les filtres courants : mémoriser la requête ici évite de la faire
 * transiter dans chaque appel côté interface.
 */
let currentQuery: PostQuery | null = null

const api: MagpieApi = {
  listPosts: (query: PostQuery): Promise<Post[]> => {
    currentQuery = query
    return ipcRenderer.invoke('posts:list', query)
  },
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
  copyToClipboard: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  sendToNitrate: (url: string): Promise<void> => ipcRenderer.invoke('nitrate:send', url),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('settings:set', patch),
  getLibraryInfo: (): Promise<LibraryInfo> => ipcRenderer.invoke('library:info'),
  clearMediaCache: (): Promise<void> => ipcRenderer.invoke('library:clearCache'),
  openDataFolder: (): Promise<void> => ipcRenderer.invoke('app:openDataFolder'),
  chooseLibraryFolder: (): Promise<{ moved: boolean; path: string }> =>
    ipcRenderer.invoke('library:chooseFolder'),
  cacheVideoQuality: (postId: string, mediaIndex: number, quality: VideoQuality): Promise<string> =>
    ipcRenderer.invoke('media:quality', postId, mediaIndex, quality),

  setLabel: (postId: string, label: LabelColor | null): Promise<Post[]> =>
    ipcRenderer.invoke('posts:setLabel', postId, label, currentQuery),
  setCollectionColor: (collectionId: number, color: LabelColor | null): Promise<void> =>
    ipcRenderer.invoke('collections:setColor', collectionId, color),
  addTag: (postId: string, name: string): Promise<Post[]> =>
    ipcRenderer.invoke('tags:add', postId, name, currentQuery),
  removeTag: (postId: string, name: string): Promise<Post[]> =>
    ipcRenderer.invoke('tags:remove', postId, name, currentQuery),
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
  }
}

contextBridge.exposeInMainWorld('magpie', api)
contextBridge.exposeInMainWorld('magpieEvents', events)
