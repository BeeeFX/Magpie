import {
  edgeKeep,
  edgeKept,
  MAX_EDGES,
  REFERENCE_FRAME,
  WEB_TARGET_LOAD,
  webLoad,
  webTuning
} from '../src/renderer/src/map-render'

/**
 * Le rendu de la toile ne dépend que de l'empan.
 *
 * Cet invariant a été violé deux fois, et la seconde a coûté une session : tout le réglage
 * dérivait de `view.scale`, alors que ce qui décide de l'aspect est `min(largeur, hauteur) ×
 * échelle` — la surface que le nuage occupe réellement. Les deux se confondent tant qu'il n'y a
 * qu'un cadre. Il y en a deux : la bande de l'organisateur, 460 px, et la carte plein écran,
 * autour de 1 100. Le même nuage y était étalé sur près de six fois plus de surface avec la même
 * opacité d'arête et des points de 0,5 px — et comme la toile est peinte en `lighter`,
 * l'accumulation par pixel s'effondrait d'autant. La carte de l'accueil paraissait délavée là où
 * celle de l'organisateur paraissait nette, pour exactement le même dessin.
 *
 * L'assertion porte donc sur l'invariant lui-même, et non sur son voisinage : deux façons
 * d'obtenir le même empan doivent rendre le même réglage, au bit près.
 */

let failures = 0

function assert(condition: unknown, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${message}`)
}

const LINKS = 133_810

console.log('L’empan, et rien que l’empan')
{
  /* Un cadre deux fois plus grand à échelle moitié, c'est le même empan : le réglage doit être
     identique. C'est exactement le cas que l'ancien code traitait différemment. */
  const wide = webTuning(460 * 4, LINKS)
  const zoomed = webTuning(920 * 2, LINKS)
  assert(
    JSON.stringify(wide) === JSON.stringify(zoomed),
    'à empan égal, le réglage est le même quel que soit le cadre'
  )

  const organiser = webTuning(460 * 2, LINKS)
  const fullscreen = webTuning(1100 * 2, LINKS)
  assert(
    fullscreen.dotRadius > organiser.dotRadius * 1.5,
    `un grand cadre grossit les points (${organiser.dotRadius.toFixed(2)} → ${fullscreen.dotRadius.toFixed(2)})`
  )
  assert(
    fullscreen.edgeAlpha > organiser.edgeAlpha * 2,
    `et rattrape l’opacité perdue (${organiser.edgeAlpha.toFixed(3)} → ${fullscreen.edgeAlpha.toFixed(3)})`
  )
}

console.log('\nLe régime réglé à l’œil ne bouge pas')
{
  /* Garde-fou de non-régression : la bande de l'organisateur à ×2 est le point où le rendu a été
     réglé. Si ces valeurs changent, c'est que quelqu'un a retouché la toile sans le savoir. */
  const organiser = webTuning(REFERENCE_FRAME * 2, LINKS)
  assert(
    Math.abs(organiser.closeness - 1 / 6) < 1e-9,
    `l’organisateur reste à closeness ${organiser.closeness.toFixed(4)}`
  )
  assert(Math.abs(organiser.dotRadius - 0.6333) < 1e-3, 'points de 0,63 px')
  assert(Math.abs(organiser.core - 0.5333) < 1e-3, 'fils de 0,53 px')
}

console.log('\nLes bornes tiennent')
{
  assert(webTuning(REFERENCE_FRAME, LINKS).closeness === 0, 'à empan de référence, on est « loin »')
  assert(
    webTuning(REFERENCE_FRAME * 0.5, LINKS).closeness === 0,
    'un cadre minuscule ne passe pas en négatif'
  )
  assert(webTuning(REFERENCE_FRAME * 200, LINKS).closeness === 1, 'et le régime « près » sature')
}

console.log('\nL’amortissement par le nombre d’arêtes')
{
  const few = webTuning(REFERENCE_FRAME * 4, 60_000)
  const many = webTuning(REFERENCE_FRAME * 4, 480_000)
  assert(
    many.edgeAlpha < few.edgeAlpha,
    `plus d’arêtes, moins d’opacité chacune (${few.edgeAlpha.toFixed(3)} → ${many.edgeAlpha.toFixed(3)})`
  )
  assert(
    webTuning(REFERENCE_FRAME * 4, 10_000).edgeAlpha ===
      webTuning(REFERENCE_FRAME * 4, 60_000).edgeAlpha,
    'sous la référence, plus d’amortissement'
  )
}

console.log('\nL’enveloppe de coût')
{
  /* Le coût d'un tracé, c'est la longueur de courbe à rasteriser : trois passes dont deux
     halos larges, sur des arêtes qui mesurent `LINK_RADIUS × empan` pixels. Il grandit donc
     avec l'empan — et c'est pour cela que la même carte gelait une seconde en plein écran là
     où elle coûtait le quart dans la bande de l'organisateur.

     Ce coût ne se paie plus en netteté. Il a été payé un temps en résolution — la toile peinte
     dans un calque plus petit dès que la vue coûtait cher — et c'était le mauvais remède : la
     charge est maximale précisément une fois dézoomé, donc la vue la plus regardée était la
     plus floue. Il se paie désormais en **temps étalé**, six millisecondes par image dans un
     second tampon, ce qui ne coûte aucun pixel. */
  const band = webLoad(LINKS, 920, 800, 460)
  const fullscreen = webLoad(LINKS, 2000, 1400, 1000)
  assert(
    Math.abs(band - WEB_TARGET_LOAD) < 1,
    'la bande de l’organisateur est bien le repère'
  )
  assert(
    fullscreen > band * 1.5,
    `le plein écran coûte plus cher (×${(fullscreen / band).toFixed(2)})`
  )

  /* Zoomer *dans* la carte coûte moins cher que la regarder en entier : le découpage en tuiles
     écarte ce qui tombe hors cadre. C'est contre-intuitif et c'est ce qui rend le zoom profond
     confortable — si cette assertion tombe, c'est que le culling ne culle plus. */
  const deep = webLoad(LINKS, 20_000, 1400, 1000)
  assert(
    deep < fullscreen,
    `zoomé, il y a moins à tracer (${Math.round(deep / 1e6)} Mpx contre ${Math.round(fullscreen / 1e6)})`
  )
  assert(webLoad(LINKS, 0, 1400, 1000) === 0, 'un empan nul ne coûte rien')
}
console.log('\nLe plafond d’arêtes')
{
  assert(edgeKeep(LINKS) === 1, 'la bibliothèque de référence n’est pas échantillonnée')
  assert(edgeKeep(MAX_EDGES * 4) === 0.25, 'quatre fois le plafond n’en garde qu’un quart')

  /* Suite à faible discrépance et non tirage au sort : les arêtes voisines dans la liste sont
     voisines sur la carte, donc un hasard laisserait des trous visibles. */
  let kept = 0
  for (let index = 0; index < 10_000; index += 1) if (edgeKept(index, 0.5)) kept += 1
  assert(Math.abs(kept - 5000) < 20, `la moitié gardée, à ${Math.abs(kept - 5000)} près`)

  let worstGap = 0
  let since = 0
  for (let index = 0; index < 10_000; index += 1) {
    if (edgeKept(index, 0.25)) {
      worstGap = Math.max(worstGap, since)
      since = 0
    } else since += 1
  }
  assert(worstGap <= 6, `aucun trou plus long que ${worstGap} arêtes au quart`)
}
console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} échec(s).`)
process.exit(failures === 0 ? 0 : 1)
