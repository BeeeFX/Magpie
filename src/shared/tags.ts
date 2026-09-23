/**
 * Ce qu'est un nom de tag, écrit une fois pour les deux processus.
 *
 * **Taper « #chats » posait une puce qui ne filtrait rien.** Le processus principal retirait le
 * dièse avant d'écrire (`addTag`), mais le store insérait le nom brut dans son état optimiste :
 * la puce affichait « #chats », le clic filtrait sur « #chats », et aucun post ne portait ce
 * tag — la base, elle, avait écrit « chats ». Le geste groupé faisait l'inverse : il gardait le
 * dièse *en base* (`addTagMany` ne le retirait pas), si bien que le même mot tapé dans la vue
 * détaillée et dans la barre de sélection donnait deux tags différents.
 *
 * Les deux côtés passent désormais par cette fonction, et ne peuvent donc plus diverger.
 */

/** La longueur que la base, la requête et les champs de saisie acceptent déjà. */
export const TAG_NAME_MAX = 80

/**
 * Le nom tel qu'il sera rangé : sans dièse de tête, espaces resserrés, forme Unicode composée.
 *
 * NFC parce qu'un « é » tapé sous macOS peut arriver décomposé — deux points de code — et que
 * SQLite compare des octets : il aurait fait un second tag, identique à l'œil.
 */
export function normalizeTagName(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^#+\s*/, '')
    .slice(0, TAG_NAME_MAX)
    .trim()
}

/**
 * La clé de comparaison de deux noms, **telle que SQLite la fait**.
 *
 * La colonne `tags.name` est `COLLATE NOCASE`, qui ne replie que l'ASCII : « Chats » et
 * « chats » sont un même tag, « Été » et « été » en sont deux. Comparer avec
 * `toLocaleLowerCase()` côté interface les confondait, et une puce disparaissait de l'écran
 * sans que la base ait rien retiré.
 */
export function tagKey(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}
