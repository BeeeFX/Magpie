import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { existsSync, statfsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type {
  AccountInfo,
  AiCollectionApplyResult,
  ClearCacheResult,
  AiCollectionChoice,
  AiCollectionMemoryOptions,
  LabelColor,
  LibraryInfo,
  LibraryMoveProgress,
  LoadProfile,
  MediaDiagnostic,
  BackgroundState,
  Platform,
  PostQuery,
  PlaybackQuality,
  PreloadRequest,
  Settings
} from '@shared/types'
import { CONTENT_SOURCES, DEFAULT_QUERY, LABELS, PLATFORMS, POST_KINDS, PUBLIC_PLATFORMS } from '@shared/types'
import { dataDir, getDb, mediaDir, writeDataDirLocation } from './db'
import {
  addTag,
  addToCollection,
  collectionBoundaries,
  mapLabels,
  saveMapLabel,
  deleteMapLabel,
  saveCollectionBoundary,
  clearFrozenMap,
  hasFrozenMap,
  collectionsForPost,
  countDemoPosts,
  createCollection,
  deleteDemoPosts,
  forgetAccount,
  getPostsByIds,
  getStats,
  lastOrganizerApplication,
  listCollections,
  listPostIds,
  listPostPage,
  listPosts,
  readAccount,
  playbackMediaSource,
  recordOrganizerApplication,
  rememberOrganizerRules,
  removeFromCollection,
  resetCachedMediaPaths,
  revertOrganizerApplication,
  removeTag,
  setCollectionColor,
  setLabel,
  setFavoriteMany,
  addTagMany,
  toggleFavorite,
  writeAccount
} from './db/queries'
import { seedIfEmpty } from './fixtures/seed'
import { backgroundTasks } from './tasks'
import { readSettings, writeSettings } from './settings'
import { ADAPTERS, syncEngine } from './sync/engine'
import { getCacheUsage, resetCacheUsage, VIDEO_NAME_PATTERN } from './media/cache'
import { createRemoteMediaUrl, resolveFreshMedia } from './media/remote'
import { streamMedia } from './adapters/http'
import { aiTagger } from './tagging/ai'
import { hasAiKey, writeAiKey } from './tagging/credentials'
import type { AiProvider } from '@shared/types'
import { checkForUpdates, getUpdateState, installUpdate } from './updater'
import { exportDir, exportLibrary, systemPrompt } from './export'
import {
  addKeyword,
  contested,
  createFromPhrase,
  createManual,
  heatOf,
  keepOnly,
  keywordsOf,
  membership as collectionMembership,
  merge as mergeCollections,
  remove as removeCollection,
  removeKeyword,
  rename as renameCollection,
  seedFromTopics,
  setKeywordWeight,
  setSize as setCollectionSize
} from './tagging/collections'
import {
  freezeMap, buildOrganizerMap, proposeVideoCollections } from './tagging/organize'
import {
  countPendingTranscripts,
  isTranscribing,
  stopTranscribing,
  transcribeAll
} from './tagging/transcribe'
import {
  imageReadingFailure,
  isReadingImages,
  pendingImageCount,
  readAllImages,
  stopReadingImages
} from './tagging/read-images'

/** L'export suit la langue de l'interface : c'est elle qui décide du prompt écrit. */
function exportLanguage(): 'fr' | 'en' {
  const setting = readSettings().language
  if (setting === 'fr' || setting === 'en') return setting
  return app.getLocale().toLowerCase().startsWith('fr') ? 'fr' : 'en'
}

function platformValue(value: unknown): Platform {
  if (!PLATFORMS.includes(value as Platform)) throw new Error('Plateforme invalide')
  return value as Platform
}

function platformValues(value: unknown): Platform[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > PLATFORMS.length) {
    throw new Error('Liste de plateformes invalide')
  }
  return value.map(platformValue)
}

function postQueryValue(value: unknown): PostQuery {
  const raw = value && typeof value === 'object' ? (value as Partial<PostQuery>) : DEFAULT_QUERY
  const legacy = raw as Partial<PostQuery> & { tag?: unknown; collectionId?: unknown }
  const enabledSources = readSettings().contentSources
  const requestedSources = Array.isArray(raw.sources)
    ? raw.sources.slice(0, 2).filter((source) => CONTENT_SOURCES.includes(source as never))
        .filter((source) => enabledSources.includes(source))
    : []
  return {
    platforms: Array.isArray(raw.platforms)
      ? raw.platforms.slice(0, 3).map(platformValue)
      : [],
    sources: requestedSources.length > 0 ? requestedSources : enabledSources,
    kinds: Array.isArray(raw.kinds)
      ? raw.kinds.slice(0, 5).filter((kind) => POST_KINDS.includes(kind as never))
      : [],
    favoritesOnly: raw.favoritesOnly === true,
    untaggedOnly: raw.untaggedOnly === true,
    tags: [
      ...new Set(
        (Array.isArray(raw.tags) ? raw.tags : typeof legacy.tag === 'string' ? [legacy.tag] : [])
          .slice(0, 500)
          .filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
          .map((tag) => tag.slice(0, 80))
      )
    ],
    collectionIds: [
      ...new Set(
        (Array.isArray(raw.collectionIds)
          ? raw.collectionIds
          : Number.isInteger(legacy.collectionId)
            ? [Number(legacy.collectionId)]
            : [])
          .slice(0, 2000)
          .filter((id): id is number => Number.isInteger(id) && Number(id) > 0)
          .map(Number)
      )
    ],
    label: LABELS.includes(raw.label as never) ? raw.label! : null,
    search: typeof raw.search === 'string' ? raw.search.slice(0, 500) : '',
    sort: ['saved', 'published', 'author', 'platform', 'random'].includes(raw.sort ?? '')
      ? raw.sort!
      : 'saved',
    randomSeed: Number.isFinite(raw.randomSeed) ? Number(raw.randomSeed) : 1
  }
}

async function accountInfo(platform: Platform): Promise<AccountInfo> {
  const connected = await ADAPTERS[platform].isConnected()
  const stored = readAccount(platform)
  return {
    platform,
    connected,
    handle: stored?.handle ?? null,
    lastSyncAt: stored?.lastSyncAt ?? null,
    lastSyncStatus: stored?.lastSyncStatus ?? null
  }
}

/**
 * Surface IPC. Volontairement étroite : le renderer ne reçoit que des données déjà
 * filtrées et n'a aucun moyen d'exécuter du SQL ou d'ouvrir un fichier arbitraire.
 */
export interface IpcHooks {
  /** Rejoue le thème effectif sur la fenêtre et les boutons système. */
  onThemeChange: () => void
  /** Relance le traitement des médias en attente, sérialisé côté processus principal. */
  drainMedia: () => void
  requestThumbnails: (postIds: string[]) => void
  startPreload: (request: PreloadRequest) => BackgroundState
  stopPreload: (kind: 'thumbnails' | 'clips') => BackgroundState
  setDownloadsPaused: (paused: boolean) => BackgroundState
  backgroundState: () => BackgroundState
  pendingCounts: (query: PostQuery | null) => { thumbnails: number; clips: number }
  /** Garantit qu'aucun fichier média n'est écrit pendant une migration de bibliothèque. */
  pauseMedia: () => Promise<void>
  resumeMedia: () => void
  onSettingsChange: () => void
}

export function registerIpc({
  onThemeChange,
  drainMedia,
  requestThumbnails,
  startPreload,
  stopPreload,
  setDownloadsPaused,
  backgroundState,
  pendingCounts,
  pauseMedia,
  resumeMedia,
  onSettingsChange
}: IpcHooks): void {
  ipcMain.handle('tasks:state', () => backgroundState())
  ipcMain.handle('tasks:pause', (_event, paused: boolean) => setDownloadsPaused(paused === true))
  ipcMain.handle('tasks:stop', (_event, kind: 'thumbnails' | 'clips') => {
    if (kind !== 'thumbnails' && kind !== 'clips') throw new Error('Tâche inconnue')
    return stopPreload(kind)
  })
  ipcMain.handle('tasks:pending', (_event, query?: PostQuery | null) =>
    pendingCounts(query ? postQueryValue(query) : null)
  )
  ipcMain.handle('tasks:preload', (_event, request: PreloadRequest) => {
    if (request?.what !== 'thumbnails' && request?.what !== 'clips') {
      throw new Error('Préchargement inconnu')
    }
    return startPreload({
      what: request.what,
      query: request.query ? postQueryValue(request.query) : null,
      scopeLabel:
        typeof request.scopeLabel === 'string' ? request.scopeLabel.slice(0, 80) : null
    })
  })

  ipcMain.handle('posts:list', (_event, query: PostQuery) => listPosts(postQueryValue(query)))
  ipcMain.handle('posts:page', (_event, query: PostQuery, offset: number, limit: number) => {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Pagination invalide')
    }
    return listPostPage(postQueryValue(query), offset, limit)
  })
  ipcMain.handle('posts:ids', (_event, query: PostQuery) => listPostIds(postQueryValue(query)))
  ipcMain.handle('posts:byIds', (_event, ids: string[]) => {
    if (
      !Array.isArray(ids) ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== 'string' || id.length > 300)
    ) {
      throw new Error('Liste de posts invalide')
    }
    return getPostsByIds(ids)
  })

  ipcMain.handle('stats:get', () => getStats(readSettings().contentSources))

  ipcMain.handle('posts:toggleFavorite', (_event, id: string) => toggleFavorite(id))
  ipcMain.handle('posts:setFavoriteMany', (_event, ids: string[], value: boolean) => {
    if (!Array.isArray(ids) || ids.length > 10000) throw new Error('Sélection invalide')
    setFavoriteMany(ids.map(String), value === true)
  })
  ipcMain.handle('tags:addMany', (_event, ids: string[], name: string) => {
    if (!Array.isArray(ids) || ids.length > 10000 || typeof name !== 'string') {
      throw new Error('Sélection invalide')
    }
    addTagMany(ids.map(String), name)
  })
  ipcMain.handle('ai:hasKey', (_event, provider: AiProvider) => hasAiKey(provider))
  ipcMain.handle('ai:setKey', (_event, provider: AiProvider, key: string) => {
    if (!['openai', 'anthropic', 'gemini', 'deepseek', 'custom'].includes(provider)) {
      throw new Error('Fournisseur invalide')
    }
    if (typeof key !== 'string' || key.length > 1000) throw new Error('Clé API invalide')
    writeAiKey(provider, key)
  })
  ipcMain.handle('ai:start', (_event, postIds?: string[]) => {
    if (postIds !== undefined && (!Array.isArray(postIds) || postIds.length > 10000)) {
      throw new Error('Sélection invalide')
    }
    return aiTagger.start(postIds?.map(String))
  })
  ipcMain.handle('ai:proposeCollections', () => proposeVideoCollections())
  ipcMain.handle(
    'ai:applyCollections',
    (
      _event,
      choices: AiCollectionChoice[],
      memory?: AiCollectionMemoryOptions
    ): AiCollectionApplyResult => {
      if (!Array.isArray(choices) || choices.length > 50) throw new Error('Plan de collections invalide')
      const remember = memory?.remember === true
      const ignoredRuleKeys = Array.isArray(memory?.ignoredRuleKeys)
        ? [...new Set(memory.ignoredRuleKeys)].filter(
            (key) => typeof key === 'string' && key.length > 0 && key.length <= 120
          )
        : []
      if (ignoredRuleKeys.length > 100) throw new Error('Préférences d’organisation invalides')
      const merged = new Map<string, { name: string; postIds: Set<string>; ruleKeys: Set<string> }>()
      for (const choice of choices) {
        if (!choice || typeof choice.name !== 'string' || !Array.isArray(choice.postIds)) {
          throw new Error('Catégorie invalide')
        }
        const name = choice.name.trim().slice(0, 80)
        if (!name || choice.postIds.length > 50_000) throw new Error('Catégorie invalide')
        const key = name.toLocaleLowerCase()
        const group = merged.get(key) ?? {
          name,
          postIds: new Set<string>(),
          ruleKeys: new Set<string>()
        }
        for (const id of choice.postIds) {
          if (typeof id !== 'string' || id.length > 300) throw new Error('Post invalide')
          group.postIds.add(id)
        }
        if (!Array.isArray(choice.ruleKeys) || choice.ruleKeys.length > 50) {
          throw new Error('Règle de catégorie invalide')
        }
        for (const ruleKey of choice.ruleKeys) {
          if (typeof ruleKey !== 'string' || !ruleKey || ruleKey.length > 120) {
            throw new Error('Règle de catégorie invalide')
          }
          group.ruleKeys.add(ruleKey)
        }
        merged.set(key, group)
      }

      const result = getDb().transaction(() => {
        const existing = new Map(
          listCollections().map((collection) => [collection.name.toLocaleLowerCase(), collection])
        )
        const learned: Array<{ ruleKey: string; collectionId: number }> = []
        // De quoi défaire exactement ce classement, et rien d'autre : les collections qu'il
        // fait naître, et les seules vidéos qu'il range réellement.
        const createdCollectionIds: number[] = []
        const filed: Array<{ collectionId: number; postIds: string[] }> = []
        // Renommer une catégorie du nom d'une collection existante y verse son contenu. C'est
        // le comportement voulu, mais il se faisait en silence : on le rapporte.
        const joinedExisting: string[] = []
        let added = 0
        let alreadyThere = 0
        for (const [key, group] of merged) {
          const known = existing.get(key)
          const collection = known ?? createCollection(group.name)
          if (known) joinedExisting.push(collection.name)
          else createdCollectionIds.push(collection.id)
          existing.set(key, collection)
          const result = addToCollection(collection.id, [...group.postIds])
          added += result.added
          alreadyThere += result.alreadyThere.length
          const untouched = new Set(result.alreadyThere)
          const freshly = [...group.postIds].filter((postId) => !untouched.has(postId))
          if (freshly.length > 0) filed.push({ collectionId: collection.id, postIds: freshly })
          for (const ruleKey of group.ruleKeys) {
            learned.push({ ruleKey, collectionId: collection.id })
          }
        }
        if (remember) rememberOrganizerRules(learned, ignoredRuleKeys)
        recordOrganizerApplication({
          collections: merged.size,
          posts: added,
          createdCollectionIds,
          filed
        })
        return { collections: merged.size, added, alreadyThere, joinedExisting }
      })()
      /* Le tri après synchronisation ne s'allume qu'une fois qu'un premier classement a été
         validé : ranger avant que l'utilisateur ait dit ce qu'il voulait n'aurait aucun sens.
         Il ne s'éteint en revanche que depuis les réglages — le commutateur « mémoriser » de
         la modale décidait jusqu'ici du comportement global à l'insu de l'utilisateur. */
      if (remember && !readSettings().autoOrganizeEnabled) {
        writeSettings({ autoOrganizeEnabled: true })
      }
      return result
    }
  )

  ipcMain.handle('tasks:setBandwidth', (_event, bytesPerSecond: number) => {
    backgroundTasks.setBandwidthLimit(bytesPerSecond)
    return backgroundTasks.current()
  })
  ipcMain.handle('tasks:setLoadProfile', (_event, profile: LoadProfile) => {
    backgroundTasks.setLoadProfile(profile)
    return backgroundTasks.current()
  })
  ipcMain.handle('tasks:setTaskPaused', (_event, id: string, paused: boolean) => {
    backgroundTasks.setTaskPaused(id, paused)
    return backgroundTasks.current()
  })

  ipcMain.handle('export:run', () => exportLibrary(exportLanguage()))
  /* Le chemin part avec les instructions : c'est tout l'intérêt du bouton — on les colle dans
     un assistant, qui doit alors pouvoir ouvrir le dossier sans le demander. */
  ipcMain.handle('export:prompt', () => systemPrompt(exportLanguage(), exportDir()))
  ipcMain.handle('export:open', async () => {
    await mkdir(exportDir(), { recursive: true })
    await shell.openPath(exportDir())
  })

  ipcMain.handle('images:state', () => ({
    pending: pendingImageCount(),
    running: isReadingImages(),
    failure: imageReadingFailure()
  }))
  ipcMain.handle('images:start', () => {
    void readAllImages()
    return backgroundTasks.current()
  })
  ipcMain.handle('images:stop', () => {
    stopReadingImages()
    return backgroundTasks.current()
  })

  ipcMain.handle('transcribe:state', () => ({
    pending: countPendingTranscripts(),
    running: isTranscribing()
  }))
  ipcMain.handle('transcribe:start', () => {
    void transcribeAll()
    return backgroundTasks.current()
  })
  ipcMain.handle('transcribe:stop', () => {
    stopTranscribing()
    return backgroundTasks.current()
  })

  /* Les collections comme requêtes. Un seul recalcul par geste, et il réécrit
     `collection_posts` : tout le reste de l'application continue de lire une liste de posts. */
  ipcMain.handle('collections:createPhrase', (_event, phrase: string) =>
    createFromPhrase(String(phrase))
  )
  ipcMain.handle('collections:createManual', (_event, name: string, postIds: string[]) =>
    createManual(String(name), (postIds ?? []).map(String))
  )
  ipcMain.handle('collections:keywords', (_event, id: number) => keywordsOf(Number(id)))
  ipcMain.handle('collections:addKeyword', async (_event, id: number, word: string) => {
    await addKeyword(Number(id), String(word))
    return heatOf(Number(id))
  })
  ipcMain.handle(
    'collections:keywordWeight',
    (_event, id: number, word: string, weight: number) => {
      setKeywordWeight(Number(id), String(word), Number(weight))
      return heatOf(Number(id))
    }
  )
  ipcMain.handle('collections:removeKeyword', (_event, id: number, word: string) => {
    removeKeyword(Number(id), String(word))
    return heatOf(Number(id))
  })
  ipcMain.handle('collections:rename', (_event, id: number, name: string) =>
    renameCollection(Number(id), String(name))
  )
  ipcMain.handle('collections:heat', (_event, id: number) => heatOf(Number(id)))
  ipcMain.handle('collections:size', (_event, id: number, size: number) => {
    const next = setCollectionSize(Number(id), Number(size))
    return next ? next.members.length : 0
  })
  ipcMain.handle('collections:delete', (_event, id: number) => {
    removeCollection(Number(id))
  })
  ipcMain.handle('collections:merge', (_event, from: number, into: number) => {
    mergeCollections(Number(from), Number(into))
  })
  ipcMain.handle('collections:keepOnly', (_event, ids: number[]) =>
    keepOnly((ids ?? []).map(Number))
  )
  ipcMain.handle('collections:seed', () => seedFromTopics())
  ipcMain.handle('collections:membership', () => collectionMembership())
  ipcMain.handle('collections:contested', () => contested())

  ipcMain.handle('organizer:map', (_event, layout?: string) =>
    buildOrganizerMap(layout as never)
  )
  ipcMain.handle('organizer:boundaries', () => collectionBoundaries())
  ipcMain.handle(
    'organizer:saveBoundary',
    (_event, name: string, shape: string, postIds: string[]) => {
      /* Ranger la frontière fige la carte du même coup : sans les positions, le contour
         désignerait n'importe quoi à la prochaine analyse. Les deux vont ensemble, toujours. */
      freezeMap()
      saveCollectionBoundary(String(name), String(shape))
      return postIds.length
    }
  )
  ipcMain.handle('organizer:clearBoundaries', () => {
    clearFrozenMap()
    return true
  })
  ipcMain.handle('organizer:hasFrozenMap', () => hasFrozenMap())
  ipcMain.handle('map:labels', () => mapLabels())
  ipcMain.handle('map:saveLabel', (_event, id: string, text: string, anchors: string[]) => {
    saveMapLabel({ id: String(id), text: String(text).slice(0, 120), anchors })
    return true
  })
  ipcMain.handle('map:deleteLabel', (_event, id: string) => {
    deleteMapLabel(String(id))
    return true
  })
  ipcMain.handle('organizer:lastApplication', () => lastOrganizerApplication())
  ipcMain.handle('organizer:undo', () => revertOrganizerApplication())

  ipcMain.handle('media:requestThumbnails', (_event, postIds: string[]) => {
    if (
      !Array.isArray(postIds) ||
      postIds.length > 1000 ||
      postIds.some((id) => typeof id !== 'string' || id.length > 300)
    ) {
      throw new Error('Liste de médias invalide')
    }
    requestThumbnails(postIds)
  })

  ipcMain.handle('clipboard:write', (_event, text: string) => {
    clipboard.writeText(String(text))
  })

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    // Un post vient d'une plateforme tierce : son URL est une donnée, pas une commande.
    // On n'ouvre que du web, jamais un `file:` ou un scheme applicatif arbitraire.
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('URL invalide')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Schéma refusé : ${parsed.protocol}`)
    }
    await shell.openExternal(parsed.toString())
  })

  /**
   * Envoi vers Nitrate, le compresseur vidéo de l'auteur, via son gestionnaire de
   * protocole. Le renderer ne fournit que l'URL du post : c'est le processus principal qui
   * construit le lien profond, pour qu'aucun code d'interface ne puisse déclencher un
   * schéma applicatif arbitraire.
   */
  ipcMain.handle('nitrate:send', async (_event, url: string) => {
    if (!readSettings().nitrateEnabled) throw new Error('Envoi vers Nitrate désactivé')

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('URL invalide')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Schéma refusé : ${parsed.protocol}`)
    }

    await shell.openExternal(`nitrate://add?url=${encodeURIComponent(parsed.toString())}`)
  })

  ipcMain.handle('settings:get', () => readSettings())

  ipcMain.handle('settings:set', (_event, patch: Partial<Settings>) => {
    const next = writeSettings(patch)
    if (patch.cacheLimitGb !== undefined) {
      getDb().exec("UPDATE media SET video_cache_state = 'pending' WHERE video_cache_state = 'skipped'")
      // Relever la limite doit lever l'avertissement de saturation ; l'abaisser peut le poser.
      void backgroundTasks.refreshCache(true)
    }
    onThemeChange()
    onSettingsChange()
    return next
  })

  ipcMain.handle('library:info', async (): Promise<LibraryInfo> => {
    const db = getDb()
    const posts = (db.prepare('SELECT COUNT(*) n FROM posts').get() as { n: number }).n
    const media = (db.prepare('SELECT COUNT(*) n FROM media').get() as { n: number }).n
    return {
      posts,
      media,
      demoPosts: countDemoPosts(),
      cacheBytes: await getCacheUsage(),
      dataPath: dataDir(),
      version: app.getVersion()
    }
  })

  ipcMain.handle('updates:state', () => getUpdateState())
  ipcMain.handle('updates:check', () => checkForUpdates())
  ipcMain.handle('updates:install', () => installUpdate())
  ipcMain.handle('window:setFullscreen', (event, enabled: boolean): boolean => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return false
    win.setFullScreen(enabled === true)
    return enabled === true
  })

  ipcMain.handle('library:clearCache', async (): Promise<ClearCacheResult> => {
    // Les métadonnées, tags et collections survivent toujours à une purge de médias :
    // on efface les fichiers et on remet les références à zéro, le cache se reconstruira
    // au prochain démarrage.
    await pauseMedia()
    try {
      const dir = mediaDir()
      const entries = await readdir(dir)
      const survivors: string[] = []
      let cursor = 0
      let removed = 0
      const worker = async (): Promise<void> => {
        while (cursor < entries.length) {
          const entry = entries[cursor++]
          try {
            // `force` n'avale qu'un fichier déjà absent. Sous Windows, un clip encore ouvert
            // — celui qu'on est en train de lire — refuse d'être supprimé, et laisser cette
            // erreur remonter interrompait toute la purge avant même la remise à zéro.
            await rm(join(dir, entry), { force: true, recursive: true })
            removed++
          } catch {
            survivors.push(entry)
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(16, entries.length) }, worker))

      resetCachedMediaPaths(survivors)
      // Un fichier verrouillé fausserait un compteur remis à zéro : on force un nouvel
      // inventaire plutôt que d'affirmer que le dossier est vide.
      resetCacheUsage(survivors.length > 0 ? null : 0)
      if (survivors.length > 0) {
        console.warn(`[magpie] Purge du cache : ${survivors.length} fichier(s) encore verrouillé(s).`)
      }
      void backgroundTasks.refreshCache(true)
      return { removed, failed: survivors.length }
    } finally {
      resumeMedia()
    }
  })

  ipcMain.handle('app:openDataFolder', () => shell.openPath(dataDir()))

  ipcMain.handle('library:chooseFolder', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const options = {
      title: 'Choisir le dossier de la bibliothèque Magpie',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    }
    const choice = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (choice.canceled || !choice.filePaths[0]) return { moved: false, path: dataDir() }

    const source = resolve(dataDir())
    const target = resolve(choice.filePaths[0])
    if (source.toLowerCase() === target.toLowerCase()) return { moved: false, path: source }
    if (target.toLowerCase().startsWith(`${source.toLowerCase()}${sep}`)) {
      throw new Error('Le nouveau dossier ne peut pas se trouver dans la bibliothèque actuelle.')
    }

    await mkdir(target, { recursive: true })
    const contents = await readdir(target)
    if (contents.length > 0) {
      throw new Error('Le dossier choisi doit être vide afin de protéger les fichiers existants.')
    }

    if (syncEngine.current().running) {
      throw new Error('Attendez la fin de la synchronisation avant de déplacer la bibliothèque.')
    }

    const targetDb = join(target, 'magpie.db')
    const targetMedia = join(target, 'media')
    const sourceMedia = join(source, 'media')
    let startedWriting = false
    const sendProgress = (progress: LibraryMoveProgress): void => {
      if (!event.sender.isDestroyed()) event.sender.send('library:moveProgress', progress)
    }

    try {
      sendProgress({ phase: 'preparing', done: 0, total: 0, path: target, message: null })
      await pauseMedia()

      const mediaFiles = await listLibraryFiles(sourceMedia)
      const databaseBytes = await stat(join(source, 'magpie.db')).then((value) => value.size)
      const mediaBytes = mediaFiles.reduce((sum, file) => sum + file.size, 0)
      const total = Math.max(1, databaseBytes + mediaBytes)
      const disk = statfsSync(target)
      const available = disk.bavail * disk.bsize
      if (available < total * 1.05) {
        throw new Error('Espace libre insuffisant dans le dossier choisi.')
      }

      startedWriting = true
      sendProgress({ phase: 'database', done: 0, total, path: target, message: null })
      await getDb().backup(targetDb, {
        progress: ({ totalPages, remainingPages }) => {
          const ratio = totalPages > 0 ? (totalPages - remainingPages) / totalPages : 0
          sendProgress({
            phase: 'database',
            done: Math.round(databaseBytes * ratio),
            total,
            path: target,
            message: null
          })
          return 200
        }
      })

      await mkdir(targetMedia, { recursive: true })
      let copiedMediaBytes = 0
      for (const file of mediaFiles) {
        const destination = join(targetMedia, file.relativePath)
        await mkdir(resolve(destination, '..'), { recursive: true })
        await copyFile(file.path, destination)
        copiedMediaBytes += file.size
        sendProgress({
          phase: 'media',
          done: databaseBytes + copiedMediaBytes,
          total,
          path: target,
          message: null
        })
      }

      sendProgress({ phase: 'finalizing', done: total, total, path: target, message: null })
      writeDataDirLocation(target)
      sendProgress({ phase: 'done', done: total, total, path: target, message: null })

      // L'ancienne bibliothèque reste intacte : le redémarrage est le seul moment où la
      // connexion SQLite bascule vers la copie validée.
      setTimeout(() => {
        app.relaunch()
        app.quit()
      }, 450)
      return { moved: true, path: target }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendProgress({ phase: 'error', done: 0, total: 0, path: target, message })
      if (startedWriting) {
        await rm(targetDb, { force: true }).catch(() => {})
        await rm(targetMedia, { recursive: true, force: true }).catch(() => {})
      }
      resumeMedia()
      throw error
    }
  })

  ipcMain.handle(
    'media:playbackUrl',
    async (
      _event,
      postId: string,
      idx: number,
      kind: 'image' | 'video',
      quality: PlaybackQuality
    ) => {
      if (typeof postId !== 'string' || postId.length > 300 || !Number.isInteger(idx) || idx < 0) {
        throw new Error('Média invalide')
      }
      if (!['image', 'video'].includes(kind)) throw new Error('Type de média invalide')
      if (!['auto', '480p', '720p', '1080p', 'source'].includes(quality)) {
        throw new Error('Qualité invalide')
      }

      // Renouvelle le lien avant de le rendre au lecteur : mieux vaut une seconde
      // d'attente qu'une erreur sur une vidéo parfaitement disponible.
      const media = await resolveFreshMedia({ postId, mediaIndex: idx, kind, quality })
      if (!media) throw new Error('Média indisponible')
      if (
        kind === 'video' &&
        media.cachePath &&
        VIDEO_NAME_PATTERN.test(media.cachePath) &&
        existsSync(join(mediaDir(), media.cachePath))
      ) {
        return `magpie://video/${media.cachePath}`
      }
      if (!media.source || !/^https?:\/\//i.test(media.source)) {
        throw new Error('La source en ligne de ce média a expiré. Synchronisez à nouveau le compte.')
      }

      return createRemoteMediaUrl({ postId, mediaIndex: idx, kind, quality })
    }
  )

  /**
   * Rejoue exactement ce que fait le protocole `magpie://remote`, mais en rapportant ce
   * qu'il obtient. Une vidéo qui ne démarre pas peut cacher un lien expiré, un refus du
   * CDN ou un transport qui ne délivre rien : de l'extérieur les trois se ressemblent, et
   * seule la réponse réelle permet de trancher.
   */
  ipcMain.handle(
    'media:diagnose',
    async (
      _event,
      postId: string,
      idx: number,
      kind: 'image' | 'video',
      quality: PlaybackQuality
    ): Promise<MediaDiagnostic> => {
      const started = Date.now()
      const empty = {
        host: null,
        status: null,
        statusText: null,
        contentType: null,
        contentLength: null,
        acceptRanges: null,
        contentEncoding: null,
        contentRange: null,
        firstChunkBytes: null
      }
      if (typeof postId !== 'string' || postId.length > 300 || !Number.isInteger(idx) || idx < 0) {
        return { ok: false, ...empty, elapsedMs: 0, error: 'Média invalide' }
      }

      const media = playbackMediaSource(postId, idx, kind, quality)
      if (!media?.source || !/^https?:\/\//i.test(media.source)) {
        return {
          ok: false,
          ...empty,
          elapsedMs: Date.now() - started,
          error: 'Aucune source en ligne enregistrée pour ce média.'
        }
      }

      const host = (() => {
        try {
          return new URL(media.source).host
        } catch {
          return null
        }
      })()

      // Le diagnostic doit emprunter *exactement* le chemin de la lecture, sinon son
      // verdict porte sur autre chose que le problème observé.
      const header = (name: string): string | null => {
        const value = remoteHeaders?.[name]
        return value === undefined ? null : Array.isArray(value) ? value.join(', ') : value
      }
      let remoteHeaders: Record<string, string | string[]> | null = null
      const TIMEOUT_MS = 8000

      try {
        const remote = await streamMedia(media.platform, media.source, {
          range: 'bytes=0-65535',
          accept: kind === 'video' ? 'video/*,application/octet-stream,*/*;q=0.8' : 'image/*,*/*;q=0.8',
          timeoutMs: TIMEOUT_MS
        })
        remoteHeaders = remote.headers

        // Un flux qui ne délivre jamais rien est le symptôme même qu'on traque : on borne
        // aussi la première lecture, faute de quoi le diagnostic pendrait comme le lecteur.
        let firstChunkBytes: number | null = null
        const reader = remote.body?.getReader()
        if (reader) {
          const first = await Promise.race([
            reader.read().then((chunk: { value?: Uint8Array }) => chunk.value?.byteLength ?? 0),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS))
          ])
          firstChunkBytes = first
          await reader.cancel().catch(() => {})
        }

        return {
          ok: remote.status >= 200 && remote.status < 300 && (firstChunkBytes ?? 0) > 0,
          host,
          status: remote.status,
          statusText: remote.statusText,
          contentType: header('content-type'),
          contentLength: header('content-length'),
          acceptRanges: header('accept-ranges'),
          contentEncoding: header('content-encoding'),
          contentRange: header('content-range'),
          firstChunkBytes,
          elapsedMs: Date.now() - started,
          error:
            firstChunkBytes === null
              ? `En-têtes reçus, mais aucun octet après ${Math.round(TIMEOUT_MS / 1000)} s : le corps ne s'écoule pas.`
              : null
        }
      } catch (error) {
        return {
          ok: false,
          ...empty,
          host,
          elapsedMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  ipcMain.handle('tags:add', (_event, postId: string, name: string) => {
    addTag(postId, name)
  })

  ipcMain.handle('tags:remove', (_event, postId: string, name: string) => {
    removeTag(postId, name)
  })

  ipcMain.handle('posts:setLabel', (_event, postId: string, label: LabelColor | null) => {
    setLabel(postId, label)
  })

  ipcMain.handle('collections:setColor', (_event, id: number, color: LabelColor | null) =>
    setCollectionColor(id, color)
  )

  ipcMain.handle('collections:list', () => listCollections())
  ipcMain.handle('collections:create', (_event, name: string) => createCollection(name))
  ipcMain.handle('collections:add', (_event, id: number, postIds: string[], readd?: boolean) =>
    addToCollection(id, postIds, readd === true)
  )
  ipcMain.handle('collections:remove', (_event, id: number, postId: string) =>
    removeFromCollection(id, postId)
  )
  ipcMain.handle('collections:forPost', (_event, postId: string) => collectionsForPost(postId))

  ipcMain.handle('accounts:list', () => Promise.all(PUBLIC_PLATFORMS.map(accountInfo)))

  ipcMain.handle('accounts:connect', async (event, platform: Platform) => {
    platform = platformValue(platform)
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    await ADAPTERS[platform].connect(parent)

    // Le pseudonyme est confortable mais pas indispensable : s'il échoue, la connexion
    // reste valide et on l'affichera simplement sans nom.
    const handle = await ADAPTERS[platform].resolveHandle().catch(() => null)
    writeAccount(platform, { handle: handle ?? undefined, connectedAt: Date.now() })
    return accountInfo(platform)
  })

  ipcMain.handle('accounts:disconnect', async (_event, platform: Platform) => {
    platform = platformValue(platform)
    await ADAPTERS[platform].disconnect()
    forgetAccount(platform)
    return accountInfo(platform)
  })

  ipcMain.handle('sync:start', (_event, platforms?: Platform[]) =>
    syncEngine.syncAll(platformValues(platforms))
  )

  ipcMain.handle('sync:full', (_event, platform: Platform) => {
    const target = platformValue(platform)
    // `partial` désactive l'arrêt sur les pages déjà connues : toute la pagination est
    // reparcourue, les doublons restant absorbés par les clés primaires SQLite.
    writeAccount(target, { lastSyncStatus: 'partial', cursor: null })
    getDb()
      .prepare("UPDATE account_sync_sources SET last_sync_status = 'partial', cursor = NULL WHERE platform = ?")
      .run(target)
    return syncEngine.syncAll([target])
  })

  ipcMain.handle('sync:cancel', (_event, platform?: Platform) =>
    syncEngine.cancel(platform === undefined ? undefined : platformValue(platform))
  )

  ipcMain.handle('sync:state', () => syncEngine.current())

  // Outil de test, déclenché explicitement depuis les réglages — jamais au démarrage.
  ipcMain.handle('library:loadDemo', () => {
    seedIfEmpty(false)
    drainMedia()
    return countDemoPosts()
  })

  ipcMain.handle('library:removeDemo', () => deleteDemoPosts())
}

interface LibraryFile {
  path: string
  relativePath: string
  size: number
}

async function listLibraryFiles(root: string): Promise<LibraryFile[]> {
  const files: LibraryFile[] = []
  const visit = async (directory: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        const info = await stat(path)
        files.push({ path, relativePath: relative(root, path), size: info.size })
      }
    }
  }
  await visit(root)
  return files
}
