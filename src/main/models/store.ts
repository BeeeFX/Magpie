import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { modelsDir } from '../db'
import { USED_MODELS } from '../tagging/models'

/**
 * Le dossier des modèles, traité comme une ressource et non comme un détail.
 *
 * **C'est le plus gros consommateur de disque de l'application, et il était hors de toute
 * comptabilité.** Mesuré sur une machine à jour : 1,1 Go, contre quelques centaines de
 * mégaoctets pour le cache média que l'écran de stockage montre, plafonne et sait vider.
 *
 * Trois conséquences, toutes constatées :
 *
 * - `getCacheUsage()` ne lit que `media/`, donc le chiffre affiché à l'utilisateur oublie
 *   les trois quarts de ce que Magpie occupe réellement ;
 * - le déplacement de bibliothèque copiait `magpie.db` et `media/`, jamais `models/` — et
 *   comme le chemin suit `dataDir()`, l'application en **redemandait 688 Mo** au premier
 *   rangement suivant, en laissant 1,1 Go d'orphelins sur l'ancien disque ;
 * - rien ne purgeait les modèles que le code a cessé d'utiliser. Cinq répertoires
 *   abandonnés — `clip-vit-base-patch32`, `dinov2-base`, deux `siglip2`,
 *   `dinov2-with-registers-small` — soit ~380 Mo qu'aucun écran ne nomme et qu'aucun geste
 *   ne supprime.
 *
 * **Ils n'entrent pas dans `cacheLimitGb`.** Ce plafond gouverne ce qui est retéléchargeable à
 * la demande, image par image ; une purge sous pression y est sans conséquence. Supprimer un
 * modèle en cours de rangement casserait l'opération et coûterait des centaines de mégaoctets
 * à refaire. Les modèles sont donc **montrés et purgeables à la main**, jamais évincés
 * automatiquement.
 */

/** Un modèle sur le disque, tel qu'il est rangé : `organisation/nom`. */
export interface ModelEntry {
  /** L'identifiant Hugging Face, la forme exacte qu'attend `USED_MODELS`. */
  id: string
  bytes: number
  /** Faux quand plus aucun code ne le charge : c'est ce que la purge emporte. */
  used: boolean
}

async function folderBytes(dir: string): Promise<number> {
  let total = 0
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return 0
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    try {
      const info = await stat(path)
      total += info.isDirectory() ? await folderBytes(path) : info.size
    } catch {
      // Un fichier qui disparaît pendant qu'on le compte ne vaut pas d'interrompre le total.
    }
  }
  return total
}

/**
 * L'inventaire, tel qu'il est réellement sur le disque.
 *
 * Le rangement de `@huggingface/transformers` est `cacheDir/organisation/nom`, ce qui donne
 * exactement l'identifiant à deux niveaux de `USED_MODELS`. On lit donc l'arborescence plutôt
 * que de supposer : un modèle interrompu en cours de téléchargement existe et pèse, et c'est
 * précisément celui qu'on veut voir.
 */
export async function listModels(): Promise<ModelEntry[]> {
  const root = modelsDir()
  const found: ModelEntry[] = []
  let organisations: string[]
  try {
    organisations = await readdir(root)
  } catch {
    return found
  }
  for (const organisation of organisations) {
    let names: string[]
    try {
      names = await readdir(join(root, organisation))
    } catch {
      continue
    }
    for (const name of names) {
      const id = `${organisation}/${name}`
      found.push({
        id,
        bytes: await folderBytes(join(root, organisation, name)),
        used: USED_MODELS.includes(id)
      })
    }
  }
  return found.sort((a, b) => b.bytes - a.bytes)
}

/** Ce que les modèles occupent, en un chiffre — celui qui manquait à l'écran de stockage. */
export async function modelsUsage(): Promise<{ total: number; unused: number }> {
  const entries = await listModels()
  return {
    total: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    unused: entries.filter((entry) => !entry.used).reduce((sum, entry) => sum + entry.bytes, 0)
  }
}

/**
 * Supprime les modèles que plus rien ne charge.
 *
 * La sûreté tient à un seul point : `USED_MODELS` est **dérivée** des quatre constantes que le
 * fil d'inférence utilise vraiment (`tagging/models.ts`). Une liste recopiée à la main
 * deviendrait incomplète au premier changement de modèle, et cette fonction effacerait alors
 * un modèle en service — que l'application retéléchargerait en silence, ce qui est exactement
 * le défaut qu'elle répare.
 */
export async function pruneUnusedModels(): Promise<{ removed: string[]; freed: number }> {
  const root = modelsDir()
  const removed: string[] = []
  let freed = 0
  for (const entry of await listModels()) {
    if (entry.used) continue
    try {
      await rm(join(root, entry.id), { recursive: true, force: true })
      removed.push(entry.id)
      freed += entry.bytes
    } catch {
      // Un modèle verrouillé par un processus qui tourne encore reste : on le reprendra.
    }
  }
  return { removed, freed }
}
