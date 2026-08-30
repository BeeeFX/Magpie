import type { ConnectFailure, Platform } from '../shared/types'
import { ChallengeRequired } from './adapters/http'
import { LoginCancelled } from './adapters/session'
import { interfaceLanguage } from './settings'

/**
 * Les phrases que le processus principal envoie à l'interface.
 *
 * **Elles étaient toutes en français, en dur, quelle que soit la langue choisie.** Un
 * utilisateur en anglais qui perdait sa session lisait « La session Instagram a expiré » — et
 * le reste de l'écran, lui, était traduit. Le moteur de synchronisation n'a pas accès au
 * dictionnaire du rendu : il vit dans un autre processus, et son `message` traverse l'IPC
 * **déjà résolu**, sans qu'aucune clé brute n'atteigne l'interface.
 *
 * Ce n'est pas une copie du dictionnaire de `i18n.ts` : les deux ne se recouvrent pas. C'est
 * la généralisation de ce que `export.ts` fait déjà avec `systemPrompt(language, dir)`.
 *
 * La contrepartie du message résolu, c'est qu'on ne peut plus l'inspecter : `Accounts.tsx`
 * testait `/annulée|cancelled/i` sur la phrase pour distinguer un abandon d'une panne, et
 * traduire aurait cassé ce filtre en silence. D'où {@link SyncMessageCode}, qui voyage à côté
 * du texte : le code se teste, la phrase se lit.
 */

const FR = {
  'sync.challenge':
    '{platform} demande une vérification de sécurité. Ouvrez le site dans votre navigateur, débloquez le compte, puis reconnectez-le ici.',
  'sync.expired': 'La session {platform} a expiré. Reconnectez le compte dans les réglages.',
  'sync.rateLimited': '{platform} limite toujours le débit après plusieurs tentatives.',
  'sync.rateLimitWait': '{platform} limite le débit, reprise dans {seconds} s…',
  'sync.failed': '{platform} : {detail}',
  'sync.pausedLiked': '{platform} : import des likes mis en pause, reprise disponible.',
  'sync.pausedSaved': '{platform} : import des signets mis en pause, reprise disponible.',

  'connect.cancelled': 'Connexion abandonnée.',
  'connect.challenge':
    '{platform} demande une vérification de sécurité avant de laisser passer. Débloquez le compte sur le site, puis réessayez.',
  'connect.network': 'Impossible de joindre {platform}. Vérifiez votre connexion, puis réessayez.',
  'connect.unknown': 'La connexion à {platform} a échoué.'
} as const

export type MessageKey = keyof typeof FR

const EN: Record<MessageKey, string> = {
  'sync.challenge':
    '{platform} is asking for a security check. Open the site in your browser, unlock the account, then reconnect it here.',
  'sync.expired': 'Your {platform} session expired. Reconnect the account in settings.',
  'sync.rateLimited': '{platform} is still rate-limiting after several attempts.',
  'sync.rateLimitWait': '{platform} is rate-limiting, resuming in {seconds}s…',
  'sync.failed': '{platform}: {detail}',
  'sync.pausedLiked': '{platform}: likes import paused, you can resume it.',
  'sync.pausedSaved': '{platform}: bookmarks import paused, you can resume it.',

  'connect.cancelled': 'Connection abandoned.',
  'connect.challenge':
    '{platform} wants a security check before letting you through. Unlock the account on the site, then try again.',
  'connect.network': 'Could not reach {platform}. Check your connection, then try again.',
  'connect.unknown': 'Connecting to {platform} failed.'
}

const DICTIONARIES: Record<'fr' | 'en', Record<MessageKey, string>> = { fr: FR, en: EN }

/** Le nom que la plateforme se donne — identique dans les deux langues, donc hors dictionnaire. */
export function platformLabel(platform: Platform): string {
  return platform === 'x' ? 'X' : platform === 'reddit' ? 'Reddit' : 'Instagram'
}

/**
 * La phrase, dans la langue de l'interface, prête à traverser l'IPC.
 *
 * La langue est relue à chaque appel plutôt que capturée : un message produit après un
 * changement de réglage doit suivre le réglage, et une synchronisation dure des minutes.
 */
export function say(key: MessageKey, vars?: Record<string, string | number>): string {
  const template = DICTIONARIES[interfaceLanguage()][key]
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match
  )
}

/**
 * Ce qui a empêché une connexion, dit sous une forme que l'appelant peut trancher.
 *
 * La classification vit ici, avec les phrases, parce que c'est le seul endroit d'où l'on peut
 * garantir que **chaque cause a son texte** — `check:messages` le vérifie en comparant les
 * membres de `ConnectFailure` aux clés `connect.*`.
 *
 * `detail` n'est jamais montré seul : il porte le relevé brut, qui dit « fetch failed » ou une
 * pile d'appel, et qui n'aide que si on le recopie dans un rapport.
 */
export function connectFailure(
  platform: Platform,
  err: unknown
): { reason: ConnectFailure; message: string; detail?: string } {
  const vars = { platform: platformLabel(platform) }
  const detail = err instanceof Error ? err.message : String(err)

  if (err instanceof LoginCancelled) {
    return { reason: 'cancelled', message: say('connect.cancelled') }
  }
  if (err instanceof ChallengeRequired) {
    return { reason: 'challenge', message: say('connect.challenge', vars), detail }
  }
  /* `fetch` échoue par un `TypeError` opaque et range la vraie cause dessous : sans elle, une
     coupure réseau et un bug de l'adaptateur portent le même message. */
  const cause = err instanceof Error ? (err.cause as { code?: string } | undefined) : undefined
  if (NETWORK_CODES.has(cause?.code ?? '') || /fetch failed|net::|ERR_INTERNET/i.test(detail)) {
    return { reason: 'network', message: say('connect.network', vars), detail }
  }
  return { reason: 'unknown', message: say('connect.unknown', vars), detail }
}

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH'
])
