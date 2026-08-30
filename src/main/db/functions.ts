import type { Database } from 'better-sqlite3'
import { mediaIdentity } from '../media/identity'
import { normalizePhrase } from '../tagging/terms'

/**
 * Les fonctions que SQLite ne connaît pas, déclarées sur la connexion.
 *
 * Elles vivent ici plutôt que dans `db/index.ts` pour une raison précise : ce module n'importe
 * ni Electron ni la base, donc `check:search` peut les enregistrer sur une connexion en mémoire
 * et exercer **les mêmes** fonctions que l'application, au lieu d'une copie qui dériverait.
 */

/**
 * Le repli d'une chaîne : accents retirés, casse abaissée.
 *
 * Le même que celui du vocabulaire (`normalizePhrase`), et c'est tout l'intérêt : l'aiguille et
 * la botte de foin passent par la même porte. Deux replis différents, c'est la panne qu'a déjà
 * connue la liste de mots vides — écrite accentuée, comparée à des mots désaccentués, et donc
 * morte depuis toujours sans que rien ne le dise.
 *
 * **Mémoïsée**, parce qu'elle est appelée une fois par ligne candidate et par mot : sur la
 * bibliothèque de référence, une recherche de six mots l'appellerait quelques dizaines de
 * milliers de fois. Elle est pure, donc la mémo ne périme jamais ; elle se vide en bloc au
 * plafond plutôt que de grossir sans fin — même règle que le cache de vignettes chaudes.
 */
const FOLD_CACHE_MAX = 20_000
const folded = new Map<string, string>()

export function fold(value: unknown): string {
  if (typeof value !== 'string') return ''
  const known = folded.get(value)
  if (known !== undefined) return known
  const result = normalizePhrase(value)
  if (folded.size > FOLD_CACHE_MAX) folded.clear()
  folded.set(value, result)
  return result
}

/**
 * Déclare tout ce que le SQL du projet suppose disponible.
 *
 * `media_identity` : comparer deux liens de CDN dans une requête demande de savoir lequel des
 * deux désigne le même fichier. La déclarer ici garde l'upsert de synchronisation en une seule
 * instruction, sans lecture préalable ligne à ligne.
 */
export function registerFunctions(conn: Database): void {
  conn.function('media_identity', { deterministic: true }, (value: unknown) =>
    mediaIdentity(typeof value === 'string' ? value : null)
  )
  conn.function('fold', { deterministic: true }, fold)
}
