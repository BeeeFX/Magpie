/**
 * Ce que le tampon de la carte doit couvrir, et s'il couvre encore.
 *
 * Sorti du composant pour une seule raison : c'est la décision qui commande le coût du rendu,
 * et on ne peut pas la mesurer à travers un canvas. Ici, elle se rejoue hors écran
 * (`scripts/bench-map-zoom`) et on compte les retracés au lieu de les supposer.
 *
 * Le principe du tampon : toile et points sont peints une fois dans un canevas de côté, et
 * chaque image n'en recopie qu'une portion. Tant que la zone peinte contient ce que le cadre
 * demande, il n'y a rien à retracer — c'est ce qui rend le déplacement fluide.
 */

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Frame {
  width: number
  height: number
  scale: number
  x: number
  y: number
}

export interface Painted {
  scale: number
  left: number
  top: number
  width: number
  height: number
}

/**
 * Marge de dézoom : la zone peinte déborde le cadre de ce facteur.
 *
 * C'est le correctif du dézoom saccadé. En zoom avant, la zone peinte grandit avec l'échelle
 * et couvre donc toujours plus que le cadre — on étire l'image déjà peinte, c'est gratuit. En
 * zoom **arrière**, elle rétrécit : le cadre débordait aussitôt, la condition tombait, et les
 * 133 810 arêtes étaient retracées à chaque cran de molette. Peindre plus large qu'il n'est
 * nécessaire absorbe plusieurs crans arrière avant qu'un tracé redevienne indispensable.
 *
 * Balayé sur vingt crans arrière depuis un amas (`scripts/bench-map-zoom`). « Travail » est
 * la surface totale peinte, rapportée au comportement d'avant :
 *
 *   ×1,0   8 retracés   ×1,00   ← avant
 *   ×1,4   6 retracés   ×0,94
 *   ×1,6   5 retracés   ×0,90   ← retenu
 *   ×1,8   5 retracés   ×1,01
 *   ×3,0   4 retracés   ×1,34
 *
 * À 1,6 on peint *moins* qu'avant tout en retraçant cinq fois au lieu de huit : les tracés
 * épargnés coûtent plus cher que la surface ajoutée. Au-delà, le compte de retracés ne bouge
 * presque plus et la surface, elle, continue de grimper.
 *
 * Les autres gestes n'en sentent rien — zoom avant, aller-retour et hésitation gardent leur
 * compte de retracés à ×1,01 de surface. La marge ne joue que là où le cadre borne ce qu'il
 * faut montrer, c'est-à-dire une fois entré dans la carte.
 */
export const ZOOM_HEADROOM = 1.6

/** Ce que le cadre exige d'avoir sous les yeux, borné à la carte : au-delà il n'y a rien. */
export function neededArea(frame: Frame, content: Rect): Rect {
  return {
    left: Math.max(content.left, -frame.x),
    top: Math.max(content.top, -frame.y),
    right: Math.min(content.right, -frame.x + frame.width),
    bottom: Math.min(content.bottom, -frame.y + frame.height)
  }
}

/**
 * La zone à peindre : le cadre élargi de la marge de dézoom, puis d'une marge de déplacement,
 * le tout recoupé à la carte et ramené sous le budget de mémoire.
 *
 * Le budget se fait respecter en rapprochant les deux demi-étendues du cadre nu, jamais en
 * deçà : un tampon plus petit que le cadre obligerait à retracer à chaque image.
 */
export function paintArea(
  frame: Frame,
  content: Rect,
  budget: number,
  headroom = ZOOM_HEADROOM,
  margin = 0
): Rect {
  const centreX = -frame.x + frame.width / 2
  const centreY = -frame.y + frame.height / 2
  const minHalfWidth = frame.width / 2
  const minHalfHeight = frame.height / 2
  let halfWidth = minHalfWidth * headroom + margin
  let halfHeight = minHalfHeight * headroom + margin
  const area = 4 * halfWidth * halfHeight
  if (area > budget) {
    /* On rétrécit les deux côtés du même facteur : garder le rapport du cadre évite de peindre
       une bande large et plate, qui déborderait au premier déplacement vertical. */
    const shrink = Math.sqrt(budget / area)
    halfWidth = Math.max(minHalfWidth, halfWidth * shrink)
    halfHeight = Math.max(minHalfHeight, halfHeight * shrink)
  }
  return {
    left: Math.max(content.left, centreX - halfWidth),
    top: Math.max(content.top, centreY - halfHeight),
    right: Math.min(content.right, centreX + halfWidth),
    bottom: Math.min(content.bottom, centreY + halfHeight)
  }
}

/**
 * La zone déjà peinte contient-elle encore ce que le cadre demande ?
 *
 * L'espace de la carte grandit proportionnellement à l'échelle : une zone peinte à `S0` couvre,
 * à l'échelle `S`, la même zone multipliée par `S / S0`.
 */
export function stillCovers(painted: Painted, needed: Rect, scale: number): boolean {
  if (needed.right <= needed.left) return true
  const stretch = painted.scale > 0 ? scale / painted.scale : 0
  return (
    painted.left * stretch <= needed.left &&
    painted.top * stretch <= needed.top &&
    (painted.left + painted.width) * stretch >= needed.right &&
    (painted.top + painted.height) * stretch >= needed.bottom
  )
}
