import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { existsSync, statfsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type {
  AccountInfo,
  AiCollectionApplyResult,
  AiCollectionChoice,
  AiCollectionMemoryOptions,
  LabelColor,
  LibraryInfo,
  LibraryMoveProgress,
  Platform,
  PostQuery,
  PlaybackQuality,
  Settings
} from '@shared/types'
import { CONTENT_SOURCES, DEFAULT_QUERY, LABELS, PLATFORMS, POST_KINDS, PUBLIC_PLATFORMS } from '@shared/types'
import { dataDir, getDb, mediaDir, writeDataDirLocation } from './db'
import {
  addTag,
  addToCollection,
  collectionsForPost,
  countDemoPosts,
  createCollection,
  deleteDemoPosts,
  forgetAccount,
  getPostsByIds,
  getStats,
  lastOrganizerApplication,
  listCollections,
  listPostPage,
  listPosts,
  readAccount,
  playbackMediaSource,
  recordOrganizerApplication,
  rememberOrganizerRules,
  removeFromCollection,
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
import { readSettings, writeSettings } from './settings'
import { ADAPTERS, syncEngine } from './sync/engine'
import { getCacheUsage, resetCacheUsage, VIDEO_NAME_PATTERN } from './media/cache'
import { createRemoteMediaUrl } from './media/remote'
import { aiTagger } from './tagging/ai'
import { hasAiKey, writeAiKey } from './tagging/credentials'
import type { AiProvider } from '@shared/types'
import { checkForUpdates, getUpdateState, installUpdate } from './updater'
import { proposeVideoCollections } from './tagging/organize'

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
  /** Garantit qu'aucun fichier média n'est écrit pendant une migration de bibliothèque. */
  pauseMedia: () => Promise<void>
  resumeMedia: () => void
  onSettingsChange: () => void
}

export function registerIpc({
  onThemeChange,
  drainMedia,
  requestThumbnails,
  pauseMedia,
  resumeMedia,
  onSettingsChange
}: IpcHooks): void {
  ipcMain.handle('posts:list', (_event, query: PostQuery) => listPosts(postQueryValue(query)))
  ipcMain.handle('posts:page', (_event, query: PostQuery, offset: number, limit: number) => {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Pagination invalide')
    }
    return listPostPage(postQueryValue(query), offset, limit)
  })
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
        let added = 0
        let alreadyThere = 0
        for (const [key, group] of merged) {
          const known = existing.get(key)
          const collection = known ?? createCollection(group.name)
          if (!known) createdCollectionIds.push(collection.id)
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
        return { collections: merged.size, added, alreadyThere }
      })()
      writeSettings({ autoOrganizeEnabled: remember })
      return result
    }
  )

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

  ipcMain.handle('library:clearCache', async () => {
    // Les métadonnées, tags et collections survivent toujours à une purge de médias :
    // on efface les fichiers et on remet les références à zéro, le cache se reconstruira
    // au prochain démarrage.
    await pauseMedia()
    try {
      const dir = mediaDir()
      const entries = await readdir(dir)
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < entries.length) {
          const entry = entries[cursor++]
          await rm(join(dir, entry), { force: true })
        }
      }
      await Promise.all(Array.from({ length: Math.min(16, entries.length) }, worker))
      getDb().exec(
        "UPDATE media SET thumb_path = NULL, thumb_attempts = 0, video_path = NULL, video_cache_state = 'pending', video_attempts = 0"
      )
      resetCacheUsage(0)
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

      const media = playbackMediaSource(postId, idx, kind, quality)
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
