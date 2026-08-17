import type { BrowserWindow } from 'electron'
import type { ContentSource, Platform } from '@shared/types'
import { getJson } from '../http'
import { cookiesFor, disconnect, isConnected, openLogin } from '../session'
import type { NormalizedPage, PlatformAdapter } from '../types'
import { normalizeSavedFeed, type IgSavedResponse } from './normalize'

/**
 * Adaptateur Instagram.
 *
 * Instagram n'expose aucune API publique pour les enregistrements — ni aujourd'hui ni
 * historiquement (voir SPEC.md §5.1). On appelle donc l'endpoint que le site web utilise
 * lui-même, avec la session de l'utilisateur. C'est assumé, et c'est la seule voie
 * existante.
 *
 * C'est aussi la plateforme la plus prompte à réagir : le moteur de sync la traite avec
 * les temporisations les plus prudentes, et un checkpoint provoque un arrêt définitif
 * sans reprise automatique.
 */

const ORIGIN = 'https://www.instagram.com'

/** Identifiant de l'application web d'Instagram, requis sur ces endpoints. */
const APP_ID = '936619743392459'

async function headers(): Promise<Record<string, string>> {
  const cookies = await cookiesFor('instagram')
  const csrf = cookies.get('csrftoken')
  return {
    'X-IG-App-ID': APP_ID,
    'X-Requested-With': 'XMLHttpRequest',
    ...(csrf ? { 'X-CSRFToken': csrf } : {})
  }
}

interface IgUserInfo {
  user?: { username?: string }
}

export const instagramAdapter: PlatformAdapter = {
  platform: 'instagram' as Platform,

  isConnected: () => isConnected('instagram'),

  connect: (parent?: BrowserWindow) => openLogin('instagram', parent),

  disconnect: () => disconnect('instagram'),

  async resolveHandle(): Promise<string | null> {
    const cookies = await cookiesFor('instagram')
    const userId = cookies.get('ds_user_id')
    if (!userId) return null

    const info = await getJson<IgUserInfo>(
      'instagram',
      `${ORIGIN}/api/v1/users/${userId}/info/`,
      { headers: await headers(), referer: `${ORIGIN}/` }
    )
    return info.user?.username ? `@${info.user.username}` : null
  },

  /**
   * `/api/v1/media/{pk}/info/` rend le même nœud média que le fil, mais avec des liens
   * fraîchement signés. Sa réponse place le média directement dans `items`, là où le fil
   * l'enveloppe dans `.media` — d'où la remise en forme avant normalisation, qui évite de
   * dupliquer toute la logique de lecture du payload.
   */
  async refreshPost(nativeId: string): Promise<Pick<NormalizedPage, 'posts' | 'media'>> {
    const response = await getJson<{ items?: unknown[] }>(
      'instagram',
      `${ORIGIN}/api/v1/media/${encodeURIComponent(nativeId)}/info/`,
      { headers: await headers(), referer: `${ORIGIN}/` }
    )
    const items = (response.items ?? []).map((item) => ({ media: item }))
    // `startRank` à zéro : l'upsert conserve le rang déjà enregistré, on ne renumérote rien.
    return normalizeSavedFeed({ items } as IgSavedResponse, 0)
  },

  async fetchPage(source: ContentSource, cursor: string | null, startRank: number): Promise<NormalizedPage> {
    const path = source === 'liked' ? 'liked/' : 'saved/posts/'
    const url = new URL(`${ORIGIN}/api/v1/feed/${path}`)
    if (cursor) url.searchParams.set('max_id', cursor)

    const response = await getJson<IgSavedResponse>('instagram', url.toString(), {
      headers: await headers(),
      referer: `${ORIGIN}/`
    })

    const { posts, media } = normalizeSavedFeed(response, startRank)
    const nextCursor = response.next_max_id ?? null

    return {
      posts,
      media,
      nextCursor,
      // `more_available` peut manquer : sans curseur suivant ni éléments, il n'y a de
      // toute façon plus rien à demander.
      done: response.more_available === false || !nextCursor || posts.length === 0
    }
  }
}
