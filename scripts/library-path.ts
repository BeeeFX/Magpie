import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function defaultLibraryDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? '', 'magpie')
  }
  if (process.platform === 'darwin') {
    return join(process.env.HOME ?? '', 'Library/Application Support/magpie')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config'), 'magpie')
}

export function libraryDbPath(): string {
  /* La même porte que `dataDir()` côté application : elle permet de faire tourner les
     contrôles sur une **copie** de la vraie base, ce qui est le seul moyen honnête de
     vérifier une migration avant de la livrer. */
  const forced = process.env['MAGPIE_DATA_DIR']
  if (forced) return join(forced, 'magpie.db')

  const defaultDir = defaultLibraryDir()
  const locationFile = join(defaultDir, 'library-location.json')

  if (existsSync(locationFile)) {
    try {
      const value = JSON.parse(readFileSync(locationFile, 'utf8')) as { path?: unknown }
      if (typeof value.path === 'string' && value.path.trim()) {
        return join(value.path, 'magpie.db')
      }
    } catch {
      // Le diagnostic retombera sur l'emplacement par défaut et affichera son chemin.
    }
  }

  return join(defaultDir, 'magpie.db')
}
