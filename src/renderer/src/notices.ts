import { create } from 'zustand'
import type { TranslationKey } from './i18n'

/**
 * Ce que l'application répond quand on lui demande quelque chose.
 *
 * Elle ne répondait rien. Après « Favoris » sur trois cents posts, seules les cartes à l'écran
 * changeaient ; après « Copier les liens », rien ne bougeait du tout ; et une douzaine
 * d'écritures — tags, étiquettes, collections, connexion — n'avaient aucun `catch`, si bien
 * qu'un échec était strictement indiscernable d'un clic manqué. Deux boutons de la barre de
 * sélection ne faisaient même rien du tout, et personne ne pouvait le voir.
 *
 * **Un module à part, et jamais l'inverse.** Il n'importe pas `store.ts`, ce qui permet à
 * `store.ts` de l'importer : les écritures fautives y vivent hors de tout composant, aucun
 * crochet ne s'y appelle. C'est la même règle à sens unique qu'entre `i18n.ts` et `store.ts`.
 *
 * **Une clé, pas une phrase.** Le module ignore la langue ; le composant résout avec `useT()`
 * au moment du rendu. Une notification affichée pendant un changement de langue se réécrit donc
 * d'elle-même, et rien ne fige du français dans un état.
 *
 * **Où va quoi.** Un `aria-live` qui décrit un *état en cours* reste attaché à son sujet — la
 * progression d'une synchronisation, le chargement d'un média, le déplacement de la
 * bibliothèque. Ce calque-ci ne porte que le *résultat d'un geste sans ancrage à l'écran*.
 * C'est ce qui explique que `Detail.notice` soit absorbé ici — il était de cette nature, et
 * n'était d'ailleurs jamais effacé — tandis que l'erreur de connexion reste dans la ligne du
 * compte concerné et l'erreur de purge sous le bouton qui l'a produite.
 */

export type NoticeTone = 'info' | 'success' | 'warning' | 'error'

export interface Notice {
  id: number
  tone: NoticeTone
  key: TranslationKey
  vars?: Record<string, string | number>
  /**
   * Le relevé technique, brut et jamais traduit.
   *
   * C'est ici que va la chaîne d'`ipcRenderer.invoke` — « Error invoking remote method
   * 'accounts:connect': Error: ERR_INTERNET_DISCONNECTED… » — qui s'affichait jusqu'ici comme
   * texte principal. Elle n'aide personne à comprendre, mais elle aide à rapporter.
   */
  detail?: string
  /** Un geste proposé avec le message : « déjà présents · [Réajouter] ». */
  action?: { key: TranslationKey; run: () => void }
  /** Combien de fois le même message s'est répété. Une répétition n'empile pas. */
  count: number
  /** Millisecondes avant retrait. Zéro veut dire « jusqu'au geste de l'utilisateur ». */
  ttl: number
}

/** Assez pour lire, assez court pour ne pas encombrer. Une erreur, elle, attend qu'on la lise. */
const TTL: Record<NoticeTone, number> = { info: 4000, success: 3500, warning: 8000, error: 0 }

interface NoticeState {
  items: Notice[]
  push(notice: Omit<Notice, 'id' | 'count' | 'ttl'> & { ttl?: number }): number
  dismiss(id: number): void
  clear(): void
}

let nextId = 1

export const useNotices = create<NoticeState>((set) => ({
  items: [],

  push: (notice) => {
    const ttl = notice.ttl ?? TTL[notice.tone]
    let id = nextId
    set((state) => {
      /* Une même clé qui revient compte, elle ne s'empile pas. Sans cela, un préchargement de
         vignettes qui échoue à chaque image posait quarante panneaux par seconde. */
      const twin = state.items.find(
        (item) => item.key === notice.key && item.detail === notice.detail
      )
      if (twin) {
        id = twin.id
        return {
          items: state.items.map((item) =>
            item.id === twin.id ? { ...item, count: item.count + 1, vars: notice.vars } : item
          )
        }
      }
      nextId += 1
      return { items: [...state.items, { ...notice, id, count: 1, ttl }] }
    })
    if (ttl > 0) setTimeout(() => useNotices.getState().dismiss(id), ttl)
    return id
  },

  dismiss: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
  clear: () => set({ items: [] })
}))

/** Une réussite qui se voit. Sans elle, un geste sur trois cents posts ne laissait aucune trace. */
export function notifySuccess(
  key: TranslationKey,
  vars?: Record<string, string | number>,
  action?: Notice['action']
): void {
  useNotices.getState().push({ tone: 'success', key, vars, action })
}

export function notifyInfo(
  key: TranslationKey,
  vars?: Record<string, string | number>,
  action?: Notice['action']
): void {
  useNotices.getState().push({ tone: 'info', key, vars, action })
}

/**
 * Le message que porte un rejet, débarrassé de son emballage.
 *
 * Electron enveloppe tout rejet d'IPC — « Error invoking remote method 'x': Error: … » — et
 * cette enveloppe occupait toute la place dans le seul retour d'erreur que l'écran offrait.
 * Ce qu'on garde est le message réel ; il finit dans `detail`, jamais dans le texte principal.
 */
export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim()
}

export function notifyError(key: TranslationKey, error?: unknown, vars?: Record<string, string | number>): void {
  useNotices.getState().push({
    tone: 'error',
    key,
    vars,
    detail: error === undefined ? undefined : describeError(error)
  })
}

/**
 * De quoi terminer une promesse qu'on lance sans l'attendre.
 *
 * `void magpie.faireQuelqueChose().catch(reportFailure('notice.x'))` — vingt-huit caractères,
 * ce qui est le prix qu'il faut pour que personne n'ait de raison de s'en passer. Les écritures
 * du store, elles, gardent un `try/catch` explicite : le correctif optimiste ne doit pas
 * s'appliquer quand l'écriture a échoué, et un helper qui avale le rejet le laisserait posé.
 */
export function reportFailure(
  key: TranslationKey,
  vars?: Record<string, string | number>
): (error: unknown) => void {
  return (error) => notifyError(key, error, vars)
}

/**
 * Le filet, en plus et jamais à la place.
 *
 * Il ne sait pas quel geste a échoué — c'est précisément pourquoi il ne dispense d'aucun
 * `catch`, et pourquoi `check:notices` continue d'en exiger un partout. Il existe pour qu'une
 * promesse oubliée cesse de disparaître sans laisser de trace.
 */
export function catchStrayRejections(): void {
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[magpie] Promesse rejetée sans traitement :', event.reason)
    notifyError('notice.unexpected', event.reason)
  })
}
