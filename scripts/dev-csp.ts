import type { Plugin } from 'vite'

/**
 * Le WebSocket local de Vite, et seulement quand Vite sert la page.
 *
 * La CSP de `src/renderer/index.html` autorisait `ws://localhost:*` et `ws://127.0.0.1:*`
 * **dans la version installée**, alors que seul le rechargement à chaud du serveur de
 * développement s'en sert. La page livrée n'en a plus besoin, donc elle ne l'a plus ; ce
 * greffon le rajoute à la volée pour `npm run dev` et `npm run preview:web` — `apply: 'serve'`
 * le tient à l'écart de `npm run build`.
 *
 * Si la directive change de forme, on échoue plutôt que de laisser le serveur démarrer sans
 * son socket : un rechargement à chaud qui se tait sans rien dire coûte plus cher à trouver.
 */
const CONNECT_SRC = "connect-src 'self' magpie:"

export function devCsp(): Plugin {
  return {
    name: 'magpie-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      if (!html.includes(CONNECT_SRC)) {
        throw new Error(`CSP de développement : « ${CONNECT_SRC} » introuvable dans index.html`)
      }
      return html.replace(CONNECT_SRC, `${CONNECT_SRC} ws://localhost:* ws://127.0.0.1:*`)
    }
  }
}
