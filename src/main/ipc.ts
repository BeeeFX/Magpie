import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type {
  AccountInfo,
  AiCollectionApplyResult,
  AiCollectionChoice,
  LabelColor,
  LibraryInfo,
  Platform,
  PostQuery,
  Settings
} from '@shared/types'
import { DEFAULT_QUERY, LABELS, PLATFORMS, POST_KINDS } from '@shared/types'
import type { VideoQuality } from '@shared/types'
import { dataDir, getDb, mediaDir, writeDataDirLocation } from './db'
import {
  addTag,
  addToCollection,
  collectionsForPost,
  countDemoPosts,
  createCollection,
  deleteDemoPosts,
  forgetAccount,
  getStats,
  listCollections,
  listPosts,
  readAccount,
  removeFromCollection,
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
import { cacheRequestedVideoQuality } from './media/cache'
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
  return {
    platforms: Array.isArray(raw.platforms)
      ? raw.platforms.slice(0, 3).map(platformValue)
      : [],
    kinds: Array.isArray(raw.kinds)
      ? raw.kinds.slice(0, 5).filter((kind) => POST_KINDS.includes(kind as never))
      : [],
    favoritesOnly: raw.favoritesOnly === true,
    untaggedOnly: raw.untaggedOnly === true,
    tag: typeof raw.tag === 'string' ? raw.tag.slice(0, 80) : null,
    collectionId: Number.isInteger(raw.collectionId) ? Number(raw.collectionId) : null,
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
  onSettingsChange: () => void
}

export function registerIpc({ onThemeChange, drainMedia, onSettingsChange }: IpcHooks): void {
  ipcMain.handle('posts:list', (_event, query: PostQuery) => listPosts(postQueryValue(query)))

  ipcMain.handle('stats:get', () => getStats())

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
    (_event, choices: AiCollectionChoice[]): AiCollectionApplyResult => {
      if (!Array.isArray(choices) || choices.length > 50) throw new Error('Plan de collections invalide')
      const merged = new Map<string, { name: string; postIds: Set<string> }>()
      for (const choice of choices) {
        if (!choice || typeof choice.name !== 'string' || !Array.isArray(choice.postIds)) {
          throw new Error('Catégorie invalide')
        }
        const name = choice.name.trim().slice(0, 80)
        if (!name || choice.postIds.length > 5000) throw new Error('Catégorie invalide')
        const key = name.toLocaleLowerCase()
        const group = merged.get(key) ?? { name, postIds: new Set<string>() }
        for (const id of choice.postIds) {
          if (typeof id !== 'string' || id.length > 300) throw new Error('Post invalide')
          group.postIds.add(id)
        }
        merged.set(key, group)
      }

      return getDb().transaction(() => {
        const existing = new Map(
          listCollections().map((collection) => [collection.name.toLocaleLowerCase(), collection])
        )
        let added = 0
        let alreadyThere = 0
        for (const [key, group] of merged) {
          const collection = existing.get(key) ?? createCollection(group.name)
          existing.set(key, collection)
          const result = addToCollection(collection.id, [...group.postIds])
          added += result.added
          alreadyThere += result.alreadyThere.length
        }
        return { collections: merged.size, added, alreadyThere }
      })()
    }
  )

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

  ipcMain.handle('library:info', (): LibraryInfo => {
    const db = getDb()
    const posts = (db.prepare('SELECT COUNT(*) n FROM posts').get() as { n: number }).n
    const media = (db.prepare('SELECT COUNT(*) n FROM media').get() as { n: number }).n
    return {
      posts,
      media,
      demoPosts: countDemoPosts(),
      cacheBytes: cacheSize(),
      dataPath: dataDir(),
      version: app.getVersion()
    }
  })

  ipcMain.handle('updates:state', () => getUpdateState())
  ipcMain.handle('updates:check', () => checkForUpdates())
  ipcMain.handle('updates:install', () => installUpdate())

  ipcMain.handle('library:clearCache', () => {
    // Les métadonnées, tags et collections survivent toujours à une purge de médias :
    // on efface les fichiers et on remet les références à zéro, le cache se reconstruira
    // au prochain démarrage.
    for (const entry of readdirSync(mediaDir())) {
      rmSync(join(mediaDir(), entry), { force: true })
    }
    getDb().exec(
      "UPDATE media SET thumb_path = NULL, video_path = NULL, video_cache_state = 'pending', video_attempts = 0"
    )
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

    mkdirSync(target, { recursive: true })
    const contents = readdirSync(target)
    if (contents.length > 0) {
      throw new Error('Le dossier choisi doit être vide afin de protéger les fichiers existants.')
    }

    // SQLite produit un instantané cohérent même si la base est ouverte en WAL. Les autres
    // fichiers sont ensuite copiés ; l'ancienne bibliothèque reste intacte en secours.
    await getDb().backup(join(target, 'magpie.db'))
    for (const entry of readdirSync(source)) {
      if (entry === 'magpie.db' || entry === 'magpie.db-wal' || entry === 'magpie.db-shm') continue
      const from = join(source, entry)
      const to = join(target, entry)
      if (statSync(from).isDirectory()) cpSync(from, to, { recursive: true })
      else if (existsSync(from)) copyFileSync(from, to)
    }

    writeDataDirLocation(target)
    app.relaunch()
    app.exit(0)
    return { moved: true, path: target }
  })

  ipcMain.handle(
    'media:quality',
    async (_event, postId: string, idx: number, quality: VideoQuality) => {
      if (typeof postId !== 'string' || postId.length > 300 || !Number.isInteger(idx) || idx < 0) {
        throw new Error('Média invalide')
      }
      if (!['480p', '720p', '1080p', 'source'].includes(quality)) {
        throw new Error('Qualité invalide')
      }
      const name = await cacheRequestedVideoQuality(postId, idx, quality)
      return `magpie://video/${name}`
    }
  )

  // Les mutations de tags renvoient la liste rafraîchie : le renderer n'a pas à deviner
  // le nouvel état ni à relancer une requête derrière.
  ipcMain.handle('tags:add', (_event, postId: string, name: string, query: PostQuery) => {
    addTag(postId, name)
    return listPosts(postQueryValue(query))
  })

  ipcMain.handle('tags:remove', (_event, postId: string, name: string, query: PostQuery) => {
    removeTag(postId, name)
    return listPosts(postQueryValue(query))
  })

  ipcMain.handle('posts:setLabel', (_event, postId: string, label: LabelColor | null, query: PostQuery) => {
    setLabel(postId, label)
    return listPosts(postQueryValue(query))
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

  ipcMain.handle('accounts:list', () => Promise.all(PLATFORMS.map(accountInfo)))

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

function cacheSize(): number {
  try {
    return readdirSync(mediaDir()).reduce((total, entry) => {
      try {
        return total + statSync(join(mediaDir(), entry)).size
      } catch {
        return total
      }
    }, 0)
  } catch {
    return 0
  }
}
