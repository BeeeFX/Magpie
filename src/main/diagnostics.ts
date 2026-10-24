import { app } from 'electron'
import { arch, release, type } from 'node:os'
import { PUBLIC_PLATFORMS } from '@shared/types'
import { isConnected } from './adapters/session'
import { getDb } from './db'
import { readSettings } from './settings'

/**
 * L'état de l'installation en quelques lignes, à coller dans un ticket.
 *
 * Ce qu'on demande toujours en premier à quelqu'un qui signale un défaut — quelle version,
 * quel système, quelle base — et que personne ne sait retrouver seul. Rien de personnel :
 * pas de chemin (le dossier personnel porte le nom de la session), pas de nom de compte,
 * seulement *si* une plateforme est connectée. Les libellés restent en anglais, comme le
 * suivi des tickets.
 */
export async function diagnostics(): Promise<string> {
  const db = getDb()
  const count = (table: 'posts' | 'media'): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  const settings = readSettings()
  const connected = (
    await Promise.all(
      PUBLIC_PLATFORMS.map(async (platform) =>
        (await isConnected(platform).catch(() => false)) ? platform : null
      )
    )
  ).filter(Boolean)

  return [
    `Magpie ${app.getVersion()}${app.isPackaged ? '' : ' (development build)'}`,
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
    `OS: ${type()} ${release()} ${arch()}`,
    `Locale: ${app.getLocale()} · interface: ${settings.language}`,
    `Database schema: v${db.pragma('user_version', { simple: true }) as number}`,
    `Posts: ${count('posts')} · media: ${count('media')}`,
    `Media storage: ${settings.mediaStorageMode} · cache limit: ${settings.cacheLimitGb} GB`,
    `Connected: ${connected.length > 0 ? connected.join(', ') : 'none'}`
  ].join('\n')
}
