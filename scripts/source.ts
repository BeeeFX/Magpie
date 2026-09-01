import { readFileSync } from 'node:fs'

/**
 * Lire une source pour l'inspecter, sans se faire piéger par les fins de ligne.
 *
 * **La CI a refusé une release pour ça.** `check:tasks` cherchait l'union
 * `BackgroundTaskKind` avec un motif contenant `\n\n` ; il passait ici et échouait sur
 * `windows-latest`, où `actions/checkout` convertit en CRLF. Le fichier disait alors
 * `\r\n\r\n`, l'union restait introuvable, et le contrôle concluait que le type n'existait
 * pas — sur un fichier parfaitement correct.
 *
 * C'est la **troisième** fois que les fins de ligne piègent un contrôle de ce dépôt. La
 * première a rendu une règle entière muette : elle passait au vert sur une phrase française
 * réintroduite exprès, parce qu'en JavaScript `.` ne traverse pas `\r` et qu'une ancre `$`
 * n'était donc jamais atteinte. Corriger le site ne suffit pas quand le piège se retend à
 * chaque nouveau contrôle : c'est la lecture elle-même qui doit être sûre.
 *
 * `check:ci` interdit désormais `readFileSync` direct dans un script de contrôle.
 */
export function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n?/g, '\n')
}

/**
 * Le code sans ses commentaires, lignes conservées.
 *
 * Sans quoi le commentaire qui *explique* un défaut corrigé le fait re-signaler : celui de la
 * carte cite `role="button"` pour dire précisément qu'il n'y en a plus. Les sauts de ligne sont
 * préservés pour que les numéros signalés restent ceux du fichier.
 */
export function code(text: string): string {
  const blank = (chunk: string): string => chunk.replace(/[^\n]/g, ' ')
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank)
}

/** Le code d'un fichier, lu et débarrassé de ses commentaires en une fois. */
export function readCode(path: string): string {
  return code(read(path))
}
