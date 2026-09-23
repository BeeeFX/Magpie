/**
 * Ce qu'une ligne du journal ne doit jamais contenir.
 *
 * Le journal de `log.ts` est fait pour être joint à un ticket GitHub — donc publié. Or les
 * erreurs du processus principal transportent volontiers ce qu'elles ont sous la main : une
 * URL de média signée (Instagram met la signature dans la requête, et le lien rejoue le
 * média tant qu'il n'a pas expiré), un en-tête `Cookie` recopié dans un message, le jeton
 * `auth_token` de X ou le `sessionid` d'Instagram — c'est-à-dire le compte lui-même.
 *
 * Module sans dépendance, pour que `check:log` le rejoue sous Node.
 */

/** Cookies et jetons des plateformes connectées : le nom reste, la valeur part. */
const SECRET_NAMES = [
  'sessionid',
  'ds_user_id',
  'csrftoken',
  'rur',
  'mid',
  'ig_did',
  'shbid',
  'shbts',
  'auth_token',
  'ct0',
  'twid',
  'kdt',
  'guest_id',
  'att',
  'reddit_session',
  'token_v2',
  'access_token',
  'refresh_token',
  'oauth_token',
  'api_key',
  'apikey'
]

const SECRET_PAIR = new RegExp(
  `\\b(${SECRET_NAMES.join('|')})(["']?\\s*[=:]\\s*["']?)[^\\s;,&"'}]+`,
  'gi'
)

/** Un en-tête entier : son contenu n'a jamais d'intérêt pour un diagnostic. */
const SECRET_HEADER =
  /\b(cookie|set-cookie|authorization|proxy-authorization|x-csrf-token|x-ig-www-claim|x-ig-app-id)(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\n,}]+)/gi

const BEARER = /\b(Bearer)\s+[A-Za-z0-9%._~+/=-]+/g

/**
 * La requête et le fragment d'une URL : c'est là que vivent les signatures (`oh=`, `oe=`,
 * `_nc_sid=`…) et les jetons. L'hôte et le chemin suffisent à dire *quel* média a échoué.
 */
const URL_QUERY = /\b((?:https?|wss?|magpie|app):\/\/[^\s?#"'<>()]*)[?#][^\s"'<>()]*/gi

/**
 * La ligne, sans secrets. `home` — le dossier personnel — devient `~` : sous Windows il porte
 * le nom de la session, qui n'a rien à faire dans un ticket public.
 */
export function redact(text: string, home?: string): string {
  let out = text
    .replace(URL_QUERY, '$1?…')
    .replace(SECRET_HEADER, '$1$2[masqué]')
    .replace(BEARER, '$1 [masqué]')
    .replace(SECRET_PAIR, '$1$2[masqué]')
  if (home && home.length > 3) {
    /* Tel quel, avec des barres obliques, et doublé comme `util.inspect` l'écrit dans une
       chaîne citée. */
    for (const variant of new Set([home.replaceAll('\\', '\\\\'), home, home.replaceAll('\\', '/')])) {
      out = out.split(variant).join('~')
    }
  }
  return out
}
