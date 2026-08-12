/**
 * Prépare la marque à partir du rendu fourni : `npm run logo`
 *
 * Le fichier source est un tracé blanc sur fond noir opaque. On en tire deux choses :
 *
 *   1. `src/renderer/src/assets/magpie.png` — le tracé seul, fond transparent, détouré.
 *      Il sert de **masque CSS** : l'élément prend `currentColor`, donc la marque est
 *      claire en thème sombre et sombre en thème clair, sans second fichier à maintenir
 *      ni retouche à refaire à chaque changement de palette.
 *
 *   2. `build/icon.png` — l'icône d'application, elle, a besoin d'un fond : une marque
 *      blanche sur transparent disparaîtrait sur une barre des tâches claire.
 *
 * La transparence est obtenue en prenant la luminance du source comme canal alpha. Comme
 * le tracé est blanc pur et le fond noir pur, la conversion est exacte, et elle conserve
 * l'antialiasing des bords au lieu de le trancher au seuil.
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'

const ROOT = resolve(process.cwd())
const SOURCE = join(ROOT, 'icons', 'icon.png')
const ASSETS = join(ROOT, 'src', 'renderer', 'src', 'assets')
const BUILD = join(ROOT, 'build')

const MARK_SIZE = 256
const ICON_SIZE = 512

async function main(): Promise<void> {
  mkdirSync(ASSETS, { recursive: true })
  mkdirSync(BUILD, { recursive: true })

  const { data, info } = await sharp(SOURCE).greyscale().raw().toBuffer({ resolveWithObject: true })

  // Blanc partout, la luminance devenant l'opacité.
  const rgba = Buffer.alloc(info.width * info.height * 4)
  for (let i = 0; i < info.width * info.height; i++) {
    rgba[i * 4] = 255
    rgba[i * 4 + 1] = 255
    rgba[i * 4 + 2] = 255
    rgba[i * 4 + 3] = data[i]
  }

  const trimmed = await sharp(rgba, {
    raw: { width: info.width, height: info.height, channels: 4 }
  })
    // Le rendu comporte une marge généreuse : on la retire pour que la marque remplisse
    // vraiment la place qu'on lui donne dans l'interface.
    .trim({ background: { r: 255, g: 255, b: 255, alpha: 0 }, threshold: 10 })
    .png()
    .toBuffer()

  const mark = await sharp(trimmed)
    .resize(MARK_SIZE, MARK_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer()

  await sharp(mark).toFile(join(ASSETS, 'magpie.png'))

  // Icône d'application : fond sombre à coins arrondis, marque centrée à 62 %.
  const inner = Math.round(ICON_SIZE * 0.62)
  const bird = await sharp(trimmed)
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer()

  const background = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}">
       <rect width="${ICON_SIZE}" height="${ICON_SIZE}" rx="${Math.round(ICON_SIZE * 0.22)}" fill="#17171a"/>
     </svg>`
  )

  await sharp(background)
    .composite([{ input: bird, gravity: 'center' }])
    .png()
    .toFile(join(BUILD, 'icon.png'))

  const meta = await sharp(mark).metadata()
  console.log(`Marque   : ${join(ASSETS, 'magpie.png')} (${meta.width}×${meta.height})`)
  console.log(`Icône    : ${join(BUILD, 'icon.png')} (${ICON_SIZE}×${ICON_SIZE})`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
