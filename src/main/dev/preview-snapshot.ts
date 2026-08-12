import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_QUERY } from '@shared/types'
import { mediaDir } from '../db'
import { listPosts } from '../db/queries'

/**
 * Outil de développement — jamais exécuté dans une build packagée.
 *
 * Écrit un instantané de la bibliothèque dans `fixtures/preview/`, que le serveur Vite
 * sert en statique. Cela permet d'ouvrir l'interface dans un navigateur ordinaire, avec
 * ses devtools, pour itérer sur le CSS et la mise en page sans relancer Electron.
 *
 * L'instantané passe par `listPosts()`, donc par le vrai chemin de lecture : ce qu'on
 * regarde dans le navigateur est bien ce que l'app affiche.
 */
export function writePreviewSnapshot(): void {
  const root = join(app.getAppPath(), 'fixtures', 'preview')
  const thumbs = join(root, 'thumbs')

  // On écrase plutôt qu'on ne purge : le serveur Vite sert ce dossier et garde des
  // poignées ouvertes dessus, ce qui fait échouer une suppression récursive sous Windows.
  // Les fichiers orphelins sont sans conséquence — c'est un artefact de développement,
  // ignoré par git, et chaque nom est un hachage stable du média.
  mkdirSync(thumbs, { recursive: true })

  /** Copie un média dans le dossier d'aperçu et renvoie son URL servie par Vite. */
  const publish = (url: string | null, prefix: string): string | null => {
    if (!url?.startsWith(prefix)) return null
    const name = url.slice(prefix.length)
    try {
      copyFileSync(join(mediaDir(), name), join(thumbs, name))
      return `/preview/thumbs/${name}`
    } catch {
      return null
    }
  }

  const posts = listPosts(DEFAULT_QUERY).map((post) => {
    const media = post.media.map((m) => ({
      ...m,
      thumbUrl: publish(m.thumbUrl, 'magpie://thumb/'),
      videoUrl: publish(m.videoUrl, 'magpie://video/')
    }))
    return { ...post, media, thumbUrl: media[0]?.thumbUrl ?? null }
  })

  writeFileSync(join(root, 'posts.json'), JSON.stringify(posts))
  console.log(`[magpie] Aperçu navigateur : ${posts.length} posts → http://localhost:5173/`)
}
