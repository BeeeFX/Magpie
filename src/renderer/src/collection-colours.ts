import type { LabelColor } from '@shared/types'

/**
 * Les teintes qu'une collection peut porter.
 *
 * Ce sont celles des étiquettes de posts, et c'est voulu : une même couleur doit dire la même
 * chose partout dans l'application. Sorties dans leur propre module parce que deux écrans les
 * lisent — le rail, qui les propose, et la carte, qui teinte ses points avec.
 */
export const SWATCH: Record<LabelColor, string> = {
  red: '#ff5c5c',
  orange: '#ff9f43',
  yellow: '#ffd93d',
  green: '#4ade80',
  blue: '#38bdf8',
  purple: '#a78bfa',
  grey: '#94a3b8'
}

/**
 * La teinte d'une collection, quelle que soit la valeur rangée en base.
 *
 * `color` traverse la base en texte libre : une couleur retirée d'une version à l'autre
 * ressortirait comme une chaîne inconnue, et indexer sans garde donnerait `undefined` là où le
 * canevas attend une couleur — un point invisible plutôt qu'un point gris.
 */
export function swatchOf(colour: string | null): string {
  return (colour && SWATCH[colour as LabelColor]) || SWATCH.grey
}
