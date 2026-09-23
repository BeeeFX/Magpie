import { normalizePhrase } from '../tagging/terms'

/**
 * Ce qu'on cherche, découpé une fois pour toutes.
 *
 * Il y avait deux découpages de la même saisie. `toFtsQuery` gardait les mots d'un caractère,
 * `searchWords` les écartait et plafonnait à six ; les trois bras du `OR` ne cherchaient donc
 * pas la même chose, et le résultat cessait d'être prévisible dès qu'on tapait « art 3 ». Un
 * seul découpage, et l'invariant devient une propriété : les deux listes ont toujours la même
 * longueur, quoi qu'on tape.
 *
 * **Sans aucun import d'Electron ni de la base**, comme `terms.ts` dont il dépend : c'est ce qui
 * permet à `check:search` de rejouer le vrai SQL sur une base en mémoire. Le même déménagement
 * avait déjà été fait pour les migrations, et pour la même raison.
 */

/**
 * Au-delà, chaque mot ajoute un passage sur les noms et sur les tags, et la saisie ne cherche
 * plus rien.
 */
const MAX_TERMS = 6

/**
 * Les mots de la recherche, repliés.
 *
 * `normalizePhrase` fait tout le travail et le fait déjà partout ailleurs : elle retire les
 * accents, met en minuscules, et ne garde que lettres, chiffres, `+` et `#`. Deux bénéfices
 * qu'on n'avait pas : le décapage des jokers `%` et `_` de `LIKE` devient inutile — ils ne
 * survivent pas au filtre — et l'aiguille passe désormais par la même porte que la botte de
 * foin, ce qui est la seule façon d'avoir une comparaison qui ne mente pas.
 */
export function searchTerms(raw: string): string[] {
  return normalizePhrase(raw)
    .split(' ')
    .filter((word) => word.length > 0)
    .slice(0, MAX_TERMS)
}

/**
 * La requête FTS5, à partir des mêmes mots.
 *
 * Le dernier terme porte l'astérisque : on cherche pendant qu'on tape, et « photograp » doit
 * trouver « photographie » avant qu'on ait fini le mot.
 */
export function ftsQuery(raw: string): string | null {
  const terms = searchTerms(raw)
  if (terms.length === 0) return null
  return terms.map((term, i) => (i === terms.length - 1 ? `"${term}"*` : `"${term}"`)).join(' AND ')
}

/**
 * La clause de recherche, et les trois façons pour un post d'y répondre.
 *
 * L'index couvre la légende, la description, le pseudo et la transcription — et il est déclaré
 * `remove_diacritics 2`, donc insensible aux accents. Les deux autres bras ne l'étaient pas :
 * ils comparaient en `LIKE`, qui replie la casse ASCII et rien d'autre. « Beyonce » ne trouvait
 * donc pas un compte nommé « Beyoncé », et « Éducation » ne trouvait pas le tag « éducation » —
 * précisément les deux gisements que le README met en avant. `fold()` les replie des deux côtés.
 *
 * Ce que chaque bras accepte, et qui ne change pas :
 *
 *   — l'index : chaque mot est un **mot entier** de la légende, de la description, du pseudo ou
 *     de la transcription, le dernier pouvant n'en être que le **début** — on cherche en tapant ;
 *   — le nom affiché : chaque mot est une **sous-chaîne** du nom replié — « hibli » trouve
 *     « Studio Ghibli » ;
 *   — les tags : chaque mot est une **sous-chaîne** de l'un des tags du post, pas forcément le
 *     même pour tous les mots.
 *
 * **Chaque bras est un ensemble, et aucun ne s'évalue post par post.** Le nom passait par
 * `fold(p.author_name) LIKE ?`, une fonction JavaScript appelée sur chaque post à chaque frappe ;
 * les tags, par un `EXISTS` qui sondait la clé de `post_tags` une fois par post **et par tag
 * retenu** — un mot court en retient des milliers. Mesuré sur cent mille posts synthétiques :
 * 321 ms par comptage, bien davantage pour un mot que portent beaucoup de tags, et
 * `listPostPage` compte avant de lire sa page. Le processus principal gelait à chaque frappe.
 *
 * Désormais le nom se compare replié d'avance (`author_name_folded`, écrit par `upsertPosts`),
 * en `LIKE` natif sur l'index qui le couvre ; les tags qui répondent se trouvent d'abord dans
 * la petite table `tags`, puis leurs posts par `idx_post_tags_tag`. `fold()` ne tourne plus que
 * sur les noms de tags. Trois ensembles de `rowid` ou d'identifiants, calculés une fois par
 * requête : SQLite les sonde en suivant l'ordre du mur — un filtre de Bloom, sans charger la
 * ligne —, ou les unit par leurs index quand ses statistiques l'y invitent. Plus rien de
 * JavaScript ne tourne par post. Mesuré sur les mêmes cent mille posts, comptage et page
 * compris : 35 ms au lieu de 790 pour un mot absent, 130 ms au lieu de quatorze secondes pour
 * un mot que portent un tiers des tags. `check:search` le vérifie.
 */
export function searchClause(raw: string): { sql: string; params: unknown[] } | null {
  const match = ftsQuery(raw)
  if (!match) return null

  const terms = searchTerms(raw)
  const likes = terms.map((term) => `%${term}%`)

  const branches = [
    'p.rowid IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)',
    `p.rowid IN (SELECT rowid FROM posts WHERE ${terms
      .map(() => 'author_name_folded LIKE ?')
      .join(' AND ')})`,
    `p.id IN (${terms
      .map(
        () => `SELECT pt.post_id FROM post_tags pt
        WHERE pt.tag_id IN (SELECT id FROM tags WHERE fold(name) LIKE ?)`
      )
      .join(' INTERSECT ')})`
  ]

  return { sql: `(${branches.join(' OR ')})`, params: [match, ...likes, ...likes] }
}
