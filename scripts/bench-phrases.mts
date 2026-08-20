import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { libraryDbPath } from './library-path'

/**
 * Une collection écrite en trois mots vaut-elle un classement ?
 *
 * C'est la seule question qui décide du modèle. Une collection est désormais une phrase : SigLIP
 * a été entraîné pour que les mots et les images partagent un repère, donc écrire « production
 * musicale » devrait suffire à noter neuf mille posts. « Devrait » n'est pas une mesure.
 *
 * Ce banc écrit une dizaine de phrases, note la bibliothèque contre chacune, et affiche les
 * légendes des mieux placés. Il n'y a pas de vérité de terrain à comparer — c'est justement le
 * point : ce qu'on veut savoir, c'est si les dix premiers d'une phrase *ressemblent* à la
 * phrase. Un œil humain répond à ça mieux que n'importe quel pourcentage, et le banc est écrit
 * pour être lu, pas pour rendre un chiffre.
 *
 * Il travaille sur une **copie** de la vraie base, dans un dossier à part, avec un lien vers les
 * modèles déjà téléchargés. Rien n'écrit dans la bibliothèque.
 */

const scratch = join(process.cwd(), '.bench-phrases')
const source = libraryDbPath()
if (!existsSync(source)) {
  console.log(`Aucune bibliothèque à ${source}. Rien à mesurer.`)
  process.exit(0)
}

rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })
copyFileSync(source, join(scratch, 'magpie.db'))

/* Les modèles pèsent 800 Mo : on les emprunte au lieu de les recopier. Une jonction Windows
   n'a pas besoin de droits particuliers, contrairement à un lien symbolique. */
const realModels = join(source, '..', 'models')
if (existsSync(realModels)) {
  try {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'mklink', '/J', join(scratch, 'models'), realModels], {
        stdio: 'ignore'
      })
    } else {
      execFileSync('ln', ['-s', realModels, join(scratch, 'models')], { stdio: 'ignore' })
    }
  } catch {
    console.log('Lien vers les modèles impossible : ils seront retéléchargés dans la copie.')
  }
}

process.env.MAGPIE_DATA_DIR = scratch

const { encodePhrase, scoreLibrary, cutFor, DEFAULT_SIZE } = await import(
  '../src/main/tagging/prototypes'
)

const PHRASES = [
  'production musicale',
  'motion design',
  '3D et rendu',
  'illustration et dessin',
  'cuisine',
  'architecture intérieure',
  'photographie de rue',
  'typographie',
  'chat',
  'voiture de sport'
]

const db = new Database(join(scratch, 'magpie.db'), { readonly: true })
const captionOf = new Map(
  (db.prepare('SELECT id, text FROM posts').all() as { id: string; text: string | null }[]).map(
    (row) => [row.id, (row.text ?? '').replace(/\s+/g, ' ').trim()]
  )
)

const short = (id: string): string => {
  const caption = captionOf.get(id) ?? ''
  return caption ? caption.slice(0, 68) : '(sans légende)'
}

for (const phrase of PHRASES) {
  const prototype = await encodePhrase(phrase)
  const scores = scoreLibrary(prototype)
  const ranked = scores.ids
    .map((id, at) => ({ id, z: scores.z[at] }))
    .filter((entry) => Number.isFinite(entry.z))
    .sort((left, right) => right.z - left.z)

  console.log(`\n=== « ${phrase} »`)
  console.log(
    `   coupe a ${DEFAULT_SIZE} posts : z >= ${cutFor(scores, DEFAULT_SIZE).toFixed(2)}` +
      ` · a 1 000 : z >= ${cutFor(scores, 1000).toFixed(2)}`
  )
  for (const entry of ranked.slice(0, 6)) {
    console.log(`   ${entry.z.toFixed(2)}  ${short(entry.id)}`)
  }
}

console.log('\nLes dix premiers ressemblent-ils à la phrase ? C’est la seule question.')
