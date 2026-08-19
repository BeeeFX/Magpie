import {
  densityField,
  fieldFromMask,
  insideField,
  insideMask,
  isoContour,
  maskFromField,
  ownershipMasks,
  paintMask,
  ringToCurves,
  simplifyRing,
  stitchRings,
  insideRing,
  FIELD_LEVEL,
  FIELD_SIZE,
  MASK_LEVEL,
  type FieldPoint
} from '../src/renderer/src/map-boundaries'

/**
 * Le contour d'une collection tient-il ses promesses ?
 *
 * Trois choses à garantir, et aucune n'est évidente à l'œil sur une carte de neuf mille
 * points : que le contour contienne bien les posts de la collection, qu'il en exclue les
 * autres, et qu'il se referme — un contour ouvert laisse fuir le remplissage et rend le test
 * d'appartenance faux d'un côté.
 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Échec : ${message}`)
  console.log(`  ✓ ${message}`)
}

/** Un amas rond, façon îlot de carte. */
function blob(cx: number, cy: number, radius: number, count: number, seed: number): FieldPoint[] {
  let state = seed
  const random = (): number => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648)
  return Array.from({ length: count }, () => {
    const angle = random() * Math.PI * 2
    const distance = Math.sqrt(random()) * radius
    return { x: cx + Math.cos(angle) * distance, y: cy + Math.sin(angle) * distance }
  })
}

console.log('Contour d’un amas isolé')
{
  const points = blob(0.5, 0.5, 0.12, 300, 7)
  const field = densityField(points)
  const inside = points.filter((p) => insideField(field, p.x, p.y)).length
  assert(inside / points.length > 0.95, `le contour contient ses posts (${inside}/${points.length})`)

  const outside = blob(0.5, 0.5, 0.5, 400, 11).filter(
    (p) => Math.hypot(p.x - 0.5, p.y - 0.5) > 0.22
  )
  const wrong = outside.filter((p) => insideField(field, p.x, p.y)).length
  assert(wrong === 0, `il n’attrape aucun post lointain (${wrong} sur ${outside.length})`)

  const segments = isoContour(field)
  assert(segments.length > 0, `il produit un tracé (${segments.length} segments)`)

  /* Un contour fermé a autant d'extrémités que de segments : chaque point de passage est
     partagé par exactement deux segments. Un contour ouvert laisse des extrémités isolées. */
  const ends = new Map<string, number>()
  const key = (x: number, y: number): string => `${x.toFixed(5)}:${y.toFixed(5)}`
  for (const s of segments) {
    for (const [x, y] of [
      [s.x1, s.y1],
      [s.x2, s.y2]
    ]) {
      const k = key(x, y)
      ends.set(k, (ends.get(k) ?? 0) + 1)
    }
  }
  const lonely = [...ends.values()].filter((n) => n === 1).length
  assert(lonely === 0, `le tracé se referme (${lonely} extrémité(s) isolée(s))`)
}

console.log('\nDeux amas séparés')
{
  const points = [...blob(0.28, 0.5, 0.09, 200, 3), ...blob(0.74, 0.5, 0.09, 200, 5)]
  const field = densityField(points)
  const inside = points.filter((p) => insideField(field, p.x, p.y)).length
  assert(inside / points.length > 0.95, `les deux amas sont contenus (${inside}/${points.length})`)
  // Le vide entre les deux doit rester dehors : sinon les deux taches n'en font qu'une.
  assert(!insideField(field, 0.51, 0.5), 'le vide entre les deux reste hors du contour')
}

console.log('\nCas dégénérés')
{
  const empty = densityField([])
  assert(isoContour(empty).length === 0, 'aucun point : aucun tracé')
  assert(!insideField(empty, 0.5, 0.5), 'aucun point : rien n’est dedans')

  /* Un post seul ne fait pas une collection : sa bosse culmine à 1, sous le niveau, donc il
     ne dessine rien. C'est le rôle même du niveau — un anneau autour de chaque point isolé
     piquerait la carte de bulles qui ne veulent rien dire. */
  const single = densityField([{ x: 0.5, y: 0.5 }])
  assert(
    isoContour(single).length === 0,
    `un post isolé ne dessine pas de contour (niveau ${FIELD_LEVEL})`
  )
  // Deux posts voisins, en revanche, forment déjà une tache : le niveau ne doit pas tout tuer.
  const couple = densityField([
    { x: 0.5, y: 0.5 },
    { x: 0.53, y: 0.5 }
  ])
  assert(isoContour(couple).length > 0, 'deux posts voisins se tracent')

  const line = Array.from({ length: 60 }, (_, i) => ({ x: 0.1 + i * 0.013, y: 0.5 }))
  const stretched = densityField(line)
  assert(isoContour(stretched).length > 0, 'un amas allongé se trace quand même')
}

console.log('')
console.log('Masque : ce qui est stocké et déformé')
{
  const points = blob(0.5, 0.5, 0.12, 300, 7)
  const field = densityField(points)
  const mask = maskFromField(field)
  assert(
    mask.length === Math.ceil((FIELD_SIZE * FIELD_SIZE) / 8),
    `un masque pèse ${mask.length} octets`
  )
  /* Le masque doit dire exactement ce que disait le champ : c'est lui qu'on range en base, et
     un écart ici ferait changer une collection de contenu au simple fait de l'enregistrer. */
  let agree = 0
  for (const p of points) {
    if (insideMask(mask, p.x, p.y) === insideField(field, p.x, p.y)) agree += 1
  }
  assert(agree === points.length, 'le masque dit exactement ce que disait le champ')

  // Repousser la frontière : un point qui était dehors se retrouve dedans.
  const outside = { x: 0.7, y: 0.5 }
  assert(!insideMask(mask, outside.x, outside.y), 'le point témoin est hors de la région')
  paintMask(mask, outside.x, outside.y, 0.05, true)
  assert(insideMask(mask, outside.x, outside.y), 'le pinceau le fait entrer')

  // Creuser : un point du cœur en ressort.
  assert(insideMask(mask, 0.5, 0.5), 'le cœur est dans la région')
  paintMask(mask, 0.5, 0.5, 0.04, false)
  assert(!insideMask(mask, 0.5, 0.5), 'le pinceau le fait sortir')

  // Après déformation, la région doit encore savoir se tracer.
  const redrawn = isoContour(fieldFromMask(mask), MASK_LEVEL)
  assert(redrawn.length > 0, `la région déformée se retrace (${redrawn.length} segments)`)
}

console.log('')
console.log('Régions qui se partagent la carte')
{
  /* Le cas reel, et celui qui a manque : des collections qui occupent la même zone. Chacune
     seuillée dans son coin couvrait presque toute la carte, et vingt contours se superposaient
     jusqu'à ne plus rien montrer. */
  const groups = [
    { group: 'a', points: blob(0.42, 0.5, 0.3, 400, 3) },
    { group: 'b', points: blob(0.58, 0.5, 0.3, 400, 5) },
    { group: 'c', points: blob(0.5, 0.42, 0.3, 400, 9) }
  ]

  const separate = groups.map((g) => maskFromField(densityField(g.points)))
  let overlapping = 0
  for (let i = 0; i < FIELD_SIZE * FIELD_SIZE; i += 1) {
    const owners = separate.filter((m) => (m[i >> 3] & (1 << (i & 7))) !== 0).length
    if (owners > 1) overlapping += 1
  }
  assert(overlapping > 1000, `seuillées séparément, les régions se chevauchent (${overlapping} cases)`)

  const shared = ownershipMasks(groups)
  let doubled = 0
  let owned = 0
  for (let i = 0; i < FIELD_SIZE * FIELD_SIZE; i += 1) {
    let owners = 0
    for (const mask of shared.values()) if ((mask[i >> 3] & (1 << (i & 7))) !== 0) owners += 1
    if (owners > 1) doubled += 1
    if (owners === 1) owned += 1
  }
  assert(doubled === 0, 'partagées, aucune case n’appartient à deux collections')
  assert(owned > 2000, `elles couvrent quand même la carte (${owned} cases attribuées)`)

  // Chaque collection doit garder une région à elle, pas se faire absorber par sa voisine.
  for (const [group, mask] of shared) {
    let count = 0
    for (let i = 0; i < FIELD_SIZE * FIELD_SIZE; i += 1) {
      if ((mask[i >> 3] & (1 << (i & 7))) !== 0) count += 1
    }
    assert(count > 100, `la collection ${group} garde une région (${count} cases)`)
  }
}

console.log('')
console.log('Contours vectoriels : recoudre, simplifier, lisser')
{
  const points = blob(0.5, 0.5, 0.15, 400, 13)
  const field = densityField(points)
  const rings = stitchRings(isoContour(field))
  assert(rings.length >= 1, `les segments se recousent en anneaux (${rings.length})`)

  const ring = rings.sort((a, b) => b.length - a.length)[0]
  assert(ring.length > 20, `l’anneau principal a du corps (${ring.length} sommets)`)

  /* Le lancer de rayon doit dire la même chose que le champ : c’est lui qui décidera de
     l’appartenance une fois les frontières éditables, et un désaccord ferait changer une
     collection de contenu au seul fait de passer en vectoriel. */
  let agree = 0
  for (const p of points) if (insideRing(ring, p.x, p.y)) agree += 1
  assert(agree / points.length > 0.95, `l’anneau contient ses posts (${agree}/${points.length})`)

  const simple = simplifyRing(ring, 0.004)
  assert(simple.length < ring.length / 3, `la simplification dégrossit (${ring.length} vers ${simple.length})`)
  assert(simple.length >= 6, `il reste de quoi manipuler (${simple.length} sommets)`)
  let stillIn = 0
  for (const p of points) if (insideRing(simple, p.x, p.y)) stillIn += 1
  assert(stillIn / points.length > 0.93, `simplifié, il contient encore ses posts (${stillIn}/${points.length})`)

  const curves = ringToCurves(simple)
  assert(curves.length === simple.length, 'une courbe par sommet, refermée')
  /* La courbe doit passer par les sommets : sans cela, déplacer une poignée ne ferait pas ce
     qu’on attend, et le contour ne collerait plus à ce qu’il entoure. */
  const ends = curves.map((c) => `${c.to.x.toFixed(6)}:${c.to.y.toFixed(6)}`)
  const vertices = simple.map((v) => `${v.x.toFixed(6)}:${v.y.toFixed(6)}`)
  assert(
    ends.every((end) => vertices.includes(end)),
    'chaque courbe arrive sur un sommet, pas à côté'
  )
}

console.log('\nTout est vert.')
