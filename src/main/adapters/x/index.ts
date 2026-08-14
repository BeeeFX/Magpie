import type { BrowserWindow } from 'electron'
import type { ContentSource } from '@shared/types'
import { getJson } from '../http'
import { cookiesFor, disconnect, isConnected, openLogin } from '../session'
import type { NormalizedPage, PlatformAdapter } from '../types'
import { normalizeBookmarks, type XBookmarksResponse } from './normalize'
import { forgetTemplate, learnTemplate, readTemplate, withCursor, type RequestTemplate } from './template'

/**
 * Adaptateur X.
 *
 * L'API officielle expose bien les signets, mais derrière un abonnement payant hors de
 * proportion pour un usage personnel (voir SPEC.md §5.2). On rejoue donc la requête que
 * la page émet elle-même, apprise une fois par observation.
 */

async function template(source: ContentSource, relearn = false): Promise<RequestTemplate> {
  if (!relearn) {
    const cached = readTemplate(source)
    if (cached) return cached
  }
  forgetTemplate(source)
  return learnTemplate(source)
}

async function requestPage(
  tpl: RequestTemplate,
  cursor: string | null,
  source: ContentSource
): Promise<XBookmarksResponse> {
  const cookies = await cookiesFor('x')
  const csrf = cookies.get('ct0')

  return getJson<XBookmarksResponse>('x', withCursor(tpl, cursor), {
    headers: {
      ...tpl.headers,
      // Le jeton CSRF doit correspondre au cookie **courant** : celui capturé lors de
      // l'apprentissage a pu être renouvelé depuis.
      ...(csrf ? { 'x-csrf-token': csrf } : {})
    },
    referer: source === 'saved' ? 'https://x.com/i/bookmarks' : 'https://x.com/home'
  })
}

export const xAdapter: PlatformAdapter = {
  platform: 'x',

  isConnected: () => isConnected('x'),

  async connect(parent?: BrowserWindow): Promise<void> {
    await openLogin('x', parent)
    // L'apprentissage suit immédiatement la connexion : autant payer ce coût maintenant,
    // pendant que l'utilisateur attend déjà, plutôt qu'au premier sync.
    await template('saved', true).catch(() => {
      /* on réessaiera à la première synchronisation */
    })
  },

  async disconnect(): Promise<void> {
    forgetTemplate()
    await disconnect('x')
  },

  async resolveHandle(): Promise<string | null> {
    const cookies = await cookiesFor('x')
    const raw = cookies.get('twid')
    if (!raw) return null
    // `twid` vaut `u%3D<id>` : il donne l'identifiant, pas le pseudonyme. Le gabarit
    // appris ne porte pas non plus le pseudo, et aller le chercher coûterait une requête
    // de plus sur une plateforme qu'on veut peu solliciter.
    const id = decodeURIComponent(raw).replace(/^u=/, '')
    return id ? `id ${id}` : null
  },

  async fetchPage(source: ContentSource, cursor: string | null, startRank: number): Promise<NormalizedPage> {
    let tpl = await template(source)
    let response: XBookmarksResponse

    try {
      response = await requestPage(tpl, cursor, source)
    } catch (err) {
      // Un gabarit périmé se manifeste par un refus ou une réponse inattendue : on
      // réapprend une fois, ce qui répare la majorité des changements de X.
      console.warn('[magpie] Gabarit X rejeté, réapprentissage :', (err as Error).message)
      tpl = await template(source, true)
      response = await requestPage(tpl, cursor, source)
    }

    if (response.errors?.length) {
      const message = response.errors.map((e) => e.message).filter(Boolean).join(' · ')
      if (message) throw new Error(`X a répondu : ${message}`)
    }

    const { posts, media, nextCursor } = normalizeBookmarks(response, startRank)

    return {
      posts,
      media,
      nextCursor,
      // X renvoie un curseur de fin même quand il n'y a plus rien : c'est l'absence de
      // nouveaux posts qui signale la fin, pas l'absence de curseur.
      done: posts.length === 0 || !nextCursor || nextCursor === cursor
    }
  }
}
