/**
 * Le point de reprise d'un rattrapage, tel qu'il s'écrit dans `account_sync_sources.cursor`.
 *
 * Sorti du moteur, et **sans aucun import** : le moteur tire les adaptateurs, donc Electron, et
 * `check:order` doit pouvoir relire les curseurs que les versions précédentes ont écrits.
 *
 * `epoch` est le `discovered_at` de la tournée interrompue. Sans lui, la reprise d'un rattrapage
 * tamponnait ses posts — plus anciens, puisqu'on reprend plus bas dans l'historique — d'une date
 * plus récente que ceux de la première partie, et ils passaient devant eux sur le mur. Un curseur
 * écrit avant son arrivée n'en porte pas : `epoch` vaut alors `null`, et c'est au moteur de le
 * retrouver dans la base.
 */
export interface ResumeCursor {
  cursor: string
  rank: number
  epoch: number | null
}

export function decodeResumeCursor(value: string | null): ResumeCursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<ResumeCursor>
    if (typeof parsed.cursor === 'string' && Number.isFinite(parsed.rank)) {
      return {
        cursor: parsed.cursor,
        rank: Math.max(0, Number(parsed.rank)),
        epoch:
          typeof parsed.epoch === 'number' && Number.isFinite(parsed.epoch) && parsed.epoch > 0
            ? parsed.epoch
            : null
      }
    }
  } catch {
    // Compatibilité avec un éventuel curseur brut écrit par une ancienne version.
  }
  return { cursor: value, rank: 0, epoch: null }
}

export function encodeResumeCursor(cursor: string, rank: number, epoch: number): string {
  return JSON.stringify({ cursor, rank, epoch } satisfies ResumeCursor)
}
