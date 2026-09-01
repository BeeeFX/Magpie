import { code, read } from './source'
import { STRUCTURE_MODEL, MEANING_MODEL, TEXT_MODEL, SPEECH_MODEL, USED_MODELS } from '../src/main/tagging/models'

/**
 * Les modèles sont une ressource gérée : `npm run check:models`
 *
 * **1,1 Go hors de toute comptabilité**, mesuré sur une machine à jour. Trois défauts nés du
 * même oubli — le dossier des modèles n'était nommé nulle part comme une chose que
 * l'application possède :
 *
 * - l'écran de stockage annonçait le seul cache média, soit le quart de ce que Magpie occupe ;
 * - le déplacement de bibliothèque copiait `magpie.db` et `media/`, **jamais `models/`** ; comme
 *   le chemin dérive de `dataDir()`, l'application en redemandait 688 Mo au premier rangement
 *   suivant, en silence, en laissant 1,1 Go d'orphelins sur l'ancien disque ;
 * - rien ne purgeait les modèles abandonnés en cours de route. Cinq répertoires — `clip-vit`,
 *   `dinov2-base`, deux `siglip2`, `dinov2-with-registers-small` — soit ~380 Mo.
 *
 * La règle qui compte est la première : **`USED_MODELS` est dérivée, jamais recopiée.** C'est
 * elle qui rend la purge sûre, puisque celle-ci supprime tout ce qui n'y figure pas. Une liste
 * tenue à la main deviendrait incomplète au premier changement de modèle, et la purge
 * effacerait alors un modèle en service — que l'application retéléchargerait en silence, ce
 * qui est exactement le défaut qu'elle répare.
 */

let failures = 0
function fail(message: string): void {
  failures += 1
  console.log(`  ✗ ${message}`)
}
function pass(message: string): void {
  console.log(`  ✓ ${message}`)
}

/** Le code sans ses commentaires — un commentaire qui *cite* un nom de modèle n'en est pas un. */

console.log('Vérification des modèles\n')

console.log('la liste des modèles en service est dérivée, pas recopiée')
{
  const declared = [STRUCTURE_MODEL, MEANING_MODEL, TEXT_MODEL, SPEECH_MODEL]
  const missing = declared.filter((model) => !USED_MODELS.includes(model))
  if (missing.length > 0) {
    for (const model of missing) fail(`${model} est chargé mais absent de USED_MODELS`)
  } else if (USED_MODELS.length !== declared.length) {
    fail(`USED_MODELS porte ${USED_MODELS.length} entrées pour ${declared.length} modèles`)
  } else {
    pass(`${USED_MODELS.length} modèles, tous dérivés de leur constante`)
  }

  /* Le nom d'un modèle ne doit exister qu'à un endroit. Un second littéral quelque part est
     une copie qui se désynchronisera, et c'est la copie qui décide alors ce que la purge
     épargne. */
  const sources = [
    'src/main/tagging/inference.worker.ts',
    'src/main/models/store.ts',
    'src/main/ipc.ts'
  ]
  const strays: string[] = []
  for (const file of sources) {
    const text = code(read(file))
    for (const model of declared) {
      if (text.includes(`'${model}'`) || text.includes(`"${model}"`)) {
        strays.push(`${file} — nomme ${model} en dur`)
      }
    }
  }
  if (strays.length === 0) pass('aucun nom de modèle écrit en dur hors de models.ts')
  else for (const stray of strays) fail(stray)
}

console.log('\nla purge ne peut pas emporter un modèle en service')
{
  const store = code(read('src/main/models/store.ts'))
  if (!/USED_MODELS\.includes/.test(store)) {
    fail('store.ts ne compare pas à USED_MODELS pour décider ce qui sert')
  } else {
    pass('l’appartenance à USED_MODELS décide')
  }
  /* La garde qui protège : sans ce `continue`, la boucle supprimerait aussi ce qui sert. */
  if (!/if \(entry\.used\) continue/.test(store)) {
    fail('pruneUnusedModels ne saute pas les modèles en service')
  } else {
    pass('pruneUnusedModels épargne ce qui sert')
  }
}

console.log('\nle déplacement de bibliothèque emporte les modèles')
{
  const ipc = code(read('src/main/ipc.ts'))
  /* `indexOf` rend -1 quand il ne trouve pas, et `slice(-1)` rend alors le **dernier
     caractère** au lieu de rien : le contrôle signalait cinq manquements sur un fichier
     correct, ce qui est pire qu'un faux vert parce qu'on cherche le défaut au mauvais
     endroit. On exige donc l'ancre. */
  const at = ipc.indexOf("ipcMain.handle('library:chooseFolder'")
  const move = at < 0 ? '' : ipc.slice(at)
  const checks: [RegExp, string, string][] = [
    [/listLibraryFiles\(sourceModels\)/, 'il lit le dossier des modèles source', 'ne lit pas le dossier des modèles source'],
    [/for \(const file of modelFiles\)/, 'il énumère les fichiers de modèles', 'n’énumère pas les fichiers de modèles'],
    [
      /mediaBytes \+ modelBytes/,
      'il compte les modèles dans le total',
      'ne compte pas les modèles dans le total, donc la vérification d’espace libre ment d’un gigaoctet'
    ],
    [/mkdir\(targetModels/, 'il écrit les modèles à destination', 'n’écrit pas les modèles à destination'],
    [
      /rm\(targetModels/,
      'il nettoie les modèles à moitié copiés en cas d’échec',
      'ne nettoie pas les modèles à moitié copiés, donc la tentative suivante bute sur un dossier non vide'
    ]
  ]
  if (move.length === 0) {
    fail('library:chooseFolder introuvable — le déplacement a changé de nom')
  } else {
    for (const [pattern, good, bad] of checks) {
      if (pattern.test(move)) pass(good)
      else fail(`le déplacement ${bad}`)
    }
  }
}

console.log('\nl’écran de stockage montre ce que les modèles occupent')
{
  const types = read('src/shared/types.ts')
  if (!/modelBytes: number/.test(types)) fail('LibraryInfo ne porte pas modelBytes')
  else pass('LibraryInfo porte modelBytes')

  /* Ce qu'un contrôle statique peut prouver ici, c'est que le chiffre **traverse** — des types
     au processus principal, du pont au rendu. Qu'il s'affiche vraiment se vérifie dans
     l'aperçu, pas en lisant du JSX : `{false ? (…)}` garderait toutes les ancres. */
  const ipcInfo = code(read('src/main/ipc.ts'))
  if (!/modelBytes: usage\.total/.test(ipcInfo)) fail('library:info ne calcule pas modelBytes')
  else pass('library:info calcule modelBytes')

  const preload = code(read('src/preload/index.ts'))
  if (!/models:prune/.test(preload)) fail('le pont n’expose pas la purge')
  else pass('le pont expose la purge')

  const settings = code(read('src/renderer/src/components/Settings.tsx'))
  if (!/t\('settings\.models'/.test(settings)) fail('l’écran de stockage ne nomme pas les modèles')
  else pass('l’écran de stockage nomme les modèles')

  /* Distincte de « vider le cache » : le cache se reconstruit à la demande, un modèle se
     retélécharge par centaines de mégaoctets. Les deux gestes n'ont pas le même prix. */
  if (!/pruneModels/.test(settings)) fail('aucun geste ne purge les modèles abandonnés')
  else pass('la purge des modèles a son propre bouton')
}

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} manquement(s).`)
process.exitCode = failures === 0 ? 0 : 1
