import { net } from 'electron'
import { createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { Transform, type Readable, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Platform } from '@shared/types'
import { cookieHeader, sessionFor, userAgent } from './session'

/**
 * Couche HTTP des adaptateurs.
 *
 * Les requêtes partent de la session partitionnée de la plateforme, donc avec ses cookies
 * et son user-agent — exactement ceux de la fenêtre où l'utilisateur s'est connecté.
 */

/** Erreurs que le moteur de sync doit distinguer pour réagir correctement. */
export class AuthExpired extends Error {
  constructor(readonly platform: Platform) {
    super('Session expirée — reconnectez le compte')
    this.name = 'AuthExpired'
  }
}

export class RateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Trop de requêtes')
    this.name = 'RateLimited'
  }
}

/**
 * Vérification de sécurité de la plateforme (checkpoint Instagram, verrou de compte).
 * Distincte d'une limite de débit : on ne réessaie **jamais** automatiquement, il faut
 * que l'utilisateur aille débloquer son compte lui-même.
 */
export class ChallengeRequired extends Error {
  constructor(readonly platform: Platform, readonly detail?: string) {
    super('La plateforme demande une vérification de sécurité')
    this.name = 'ChallengeRequired'
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`HTTP ${status}`)
    this.name = 'HttpError'
  }
}

export class MediaLimitExceeded extends Error {
  constructor() {
    super('Le média dépasse l’espace de cache disponible')
    this.name = 'MediaLimitExceeded'
  }
}

export interface RequestOptions {
  headers?: Record<string, string>
  referer?: string
  timeoutMs?: number
}

async function request(
  platform: Platform,
  url: string,
  options: RequestOptions = {}
): Promise<{ status: number; headers: Record<string, string | string[]>; body: string }> {
  const req = net.request({
    method: 'GET',
    url,
    session: sessionFor(platform),
    useSessionCookies: true
  })

  req.setHeader('User-Agent', userAgent())
  req.setHeader('Accept', 'application/json, text/plain, */*')
  req.setHeader('Accept-Language', 'fr-FR,fr;q=0.9,en;q=0.8')
  if (options.referer) req.setHeader('Referer', options.referer)
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    req.setHeader(key, value)
  }

  // `useSessionCookies` suffit en principe, mais certaines plateformes exigent l'en-tête
  // explicite ; le poser nous-mêmes évite un comportement dépendant de la version.
  if (!options.headers?.Cookie) {
    const cookies = await cookieHeader(platform, url)
    if (cookies) req.setHeader('Cookie', cookies)
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      req.abort()
      reject(new Error(`Délai dépassé sur ${url}`))
    }, options.timeoutMs ?? 30000)

    req.on('response', (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        clearTimeout(timeout)
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8')
        })
      })
      response.on('error', (err: Error) => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    req.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })

    req.end()
  })
}

/**
 * Télécharge un média par la session de sa plateforme.
 *
 * Passer par la session plutôt que par le `fetch` global apporte les cookies, notre
 * user-agent et un Referer cohérent : les CDN acceptent souvent une URL signée sans rien
 * de tout ça, mais pas toujours, et l'échec est alors silencieux — une vignette manquante.
 */
export async function fetchMedia(
  platform: Platform,
  url: string,
  // Un clip de plusieurs dizaines de mégaoctets sur une connexion ordinaire dépasse
  // largement une minute : le délai est calé sur le pire cas raisonnable.
  timeoutMs = 180000,
  signal?: AbortSignal
): Promise<Buffer> {
  const origin =
    platform === 'instagram'
      ? 'https://www.instagram.com/'
      : platform === 'x'
        ? 'https://x.com/'
        : 'https://www.reddit.com/'

  const req = net.request({ method: 'GET', url, session: sessionFor(platform) })
  req.setHeader('User-Agent', userAgent())
  req.setHeader('Accept', 'image/avif,image/webp,image/apng,video/*,*/*;q=0.8')
  req.setHeader('Referer', origin)

  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener('abort', abort)
    const abort = (): void => {
      clearTimeout(timeout)
      cleanup()
      req.abort()
      reject(new Error('Téléchargement interrompu'))
    }
    const timeout = setTimeout(() => {
      cleanup()
      req.abort()
      reject(new Error(`Délai dépassé sur ${url}`))
    }, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }

    req.on('response', (response) => {
      if (response.statusCode >= 400) {
        clearTimeout(timeout)
        cleanup()
        reject(new HttpError(response.statusCode, url))
        return
      }
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        clearTimeout(timeout)
        cleanup()
        resolve(Buffer.concat(chunks))
      })
      response.on('error', (err: Error) => {
        clearTimeout(timeout)
        cleanup()
        reject(err)
      })
    })

    req.on('error', (err) => {
      clearTimeout(timeout)
      cleanup()
      reject(err)
    })

    req.end()
  })
}

/**
 * Écrit un média directement sur disque. Les clips ne transitent jamais par un énorme
 * Buffer JavaScript : avec plusieurs téléchargements parallèles, cette différence évite
 * des centaines de Mo de mémoire temporaire et de longues pauses du ramasse-miettes.
 */
export async function downloadMediaToFile(
  platform: Platform,
  url: string,
  target: string,
  maxBytes: number,
  timeoutMs = 180000,
  signal?: AbortSignal
): Promise<number> {
  const origin =
    platform === 'instagram'
      ? 'https://www.instagram.com/'
      : platform === 'x'
        ? 'https://x.com/'
        : 'https://www.reddit.com/'
  const temporary = `${target}.part`
  await rm(temporary, { force: true })

  const req = net.request({ method: 'GET', url, session: sessionFor(platform) })
  req.setHeader('User-Agent', userAgent())
  req.setHeader('Accept', 'video/*,application/octet-stream,*/*;q=0.8')
  req.setHeader('Referer', origin)

  return new Promise<number>((resolve, reject) => {
    let settled = false
    let bytes = 0

    const cleanup = (): void => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      req.abort()
      void rm(temporary, { force: true }).finally(() => reject(error))
    }
    const succeed = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(bytes)
    }
    const abort = (): void => fail(new Error('Téléchargement interrompu'))
    const timeout = setTimeout(
      () => fail(new Error(`Délai dépassé sur ${url}`)),
      timeoutMs
    )

    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }

    req.on('response', (response) => {
      if (response.statusCode >= 400) {
        fail(new HttpError(response.statusCode, url))
        return
      }

      const header = response.headers['content-length']
      const announced = Number(Array.isArray(header) ? header[0] : header)
      if (Number.isFinite(announced) && announced > maxBytes) {
        fail(new MediaLimitExceeded())
        return
      }

      const limiter = new Transform({
        transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
          bytes += chunk.length
          callback(bytes > maxBytes ? new MediaLimitExceeded() : null, chunk)
        }
      })

      void pipeline(response as unknown as Readable, limiter, createWriteStream(temporary))
        .then(() => rename(temporary, target))
        .then(succeed)
        .catch((error: Error) => fail(error))
    })

    req.on('error', (error) => fail(error))
    req.end()
  })
}

/** Requête JSON, avec traduction des statuts en erreurs que le moteur sait traiter. */
export async function getJson<T>(
  platform: Platform,
  url: string,
  options: RequestOptions = {}
): Promise<T> {
  const { status, headers, body } = await request(platform, url, options)

  if (status === 401 || status === 403) {
    // Instagram répond parfois 403 avec un corps signalant une vérification plutôt qu'une
    // session invalide : les deux appellent des réactions opposées, d'où le test.
    if (/challenge_required|checkpoint_required/i.test(body)) {
      throw new ChallengeRequired(platform, body.slice(0, 200))
    }
    throw new AuthExpired(platform)
  }

  if (status === 429) {
    const header = headers['retry-after']
    const seconds = Number(Array.isArray(header) ? header[0] : header)
    throw new RateLimited(Number.isFinite(seconds) ? seconds * 1000 : 60000)
  }

  if (status >= 400) throw new HttpError(status, body.slice(0, 400))

  try {
    return JSON.parse(body) as T
  } catch {
    // Une page HTML là où on attend du JSON signifie presque toujours une redirection vers
    // une connexion ou une interstitielle.
    if (/^\s*</.test(body)) throw new AuthExpired(platform)
    throw new Error(`Réponse illisible depuis ${url}`)
  }
}
