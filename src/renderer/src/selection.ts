import { BULK_MAX } from '@shared/types'

/**
 * Découper une sélection avant de l'envoyer.
 *
 * Le processus principal refuse au-delà de `BULK_MAX` identifiants — un garde-fou légitime,
 * mais qui transformait « Tout » suivi de n'importe quelle action en erreur dès que la
 * bibliothèque dépassait ce chiffre. On découpe donc, ce qui règle aussi un second problème :
 * soixante mille `UPDATE` dans une seule transaction `better-sqlite3`, c'est plusieurs secondes
 * de fenêtre gelée sur le processus principal.
 *
 * Le même motif que la relecture des posts par tranches de cent : une seule branche de code,
 * quelle que soit la taille.
 */
export function chunk<T>(items: T[], size = BULK_MAX): T[][] {
  if (items.length === 0) return []
  const out: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size))
  }
  return out
}
