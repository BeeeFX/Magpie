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

/** Au-delà, chaque mot ajoute deux comparaisons par post et la saisie ne cherche plus rien. */
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
 * Le bras des tags devient une sous-requête **non corrélée** : la liste des tags qui répondent
 * se calcule une fois par mot, sur les quelques milliers de tags distincts, au lieu d'être
 * réévaluée pour chacun des douze mille liens. C'est moins cher que ce qu'il remplace, avant
 * même de parler d'accents.
 */
export function searchClause(raw: string): { sql: string; params: unknown[] } | null {
  const match = ftsQuery(raw)
  if (!match) return null

  const terms = searchTerms(raw)
  const params: unknown[] = [match]
  const branches = ['p.rowid IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)']

  if (terms.length > 0) {
    branches.push(terms.map(() => 'fold(p.author_name) LIKE ?').join(' AND '))
    params.push(...terms.map((term) => `%${term}%`))

    branches.push(
      terms
        .map(
          () => `EXISTS (
        SELECT 1 FROM post_tags pt
        WHERE pt.post_id = p.id
          AND pt.tag_id IN (SELECT id FROM tags WHERE fold(name) LIKE ?)
      )`
        )
        .join(' AND ')
    )
    params.push(...terms.map((term) => `%${term}%`))
  }

  return { sql: `(${branches.join(' OR ')})`, params }
}
