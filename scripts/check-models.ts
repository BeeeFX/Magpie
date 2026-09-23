import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { code, read } from './source'
import {
  chooseRevision,
  pinnedUrl,
  STRUCTURE_MODEL,
  MEANING_MODEL,
  TEXT_MODEL,
  SPEECH_MODEL,
  USED_MODELS
} from '../src/main/tagging/models'

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
  /* Tout le processus principal, et plus trois fichiers choisis : les deux copies qui restaient —
     `embeddings.ts` et `vision.ts` — vivaient justement hors de la liste. */
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : entry.name.endsWith('.ts')
          ? [join(dir, entry.name)]
          : []
    )
  const sources = walk('src/main').filter((file) => !file.endsWith(join('tagging', 'models.ts')))
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

console.log('\nles téléchargements sont épinglés')
{
  const sha = (seed: string): string => createHash('sha1').update(seed).digest('hex')
  const a = sha('a')
  const none = { recorded: null, legacy: false, pinned: null }
  const expect = (label: string, got: { revision: string | null; source: string }, revision: string | null, source: string): void => {
    if (got.revision === revision && got.source === source) pass(label)
    else fail(`${label} — rendu ${got.source} ${got.revision}`)
  }
  expect('une installation neuve résout main une fois', chooseRevision(none), null, 'resolve')
  expect('la révision rangée passe avant tout', chooseRevision({ ...none, recorded: a, pinned: sha('b'), legacy: true }), a, 'recorded')
  expect(
    'des fichiers d’avant l’épinglage restent ceux qui ont fait les vecteurs',
    chooseRevision({ ...none, legacy: true, pinned: a }),
    'main',
    'legacy'
  )
  expect('un SHA écrit à la main vaut pour une installation neuve', chooseRevision({ ...none, pinned: a }), a, 'pinned')
  expect('une révision rangée qui n’est pas un SHA ne compte pas', chooseRevision({ ...none, recorded: 'main' }), null, 'resolve')

  /* L'épingle se pose sur l'adresse, pas en option : `pipeline()` oubliait l'option dans sa
     découverte des fichiers, qui relisait `main` — constaté sur le fil construit. */
  const pins = new Map([[TEXT_MODEL, a]])
  const host = 'https://huggingface.co/'
  const pinned = pinnedUrl(`${host}${TEXT_MODEL}/resolve/main/onnx/model_quantized.onnx`, host, pins)
  if (pinned === `${host}${TEXT_MODEL}/resolve/${a}/onnx/model_quantized.onnx`) {
    pass('une requête vers main vise le commit épinglé')
  } else fail(`adresse réécrite inattendue : ${pinned}`)
  const other = `${host}${SPEECH_MODEL}/resolve/main/config.json`
  if (pinnedUrl(other, host, pins) === other) pass('un modèle sans épingle garde son adresse')
  else fail('un modèle sans épingle a été réécrit')
  if (pinnedUrl(`${host}${TEXT_MODEL}-v2/resolve/main/config.json`, host, pins).includes('/resolve/main/')) {
    pass('un modèle au nom voisin n’hérite pas de l’épingle')
  } else fail('un modèle au nom voisin a hérité de l’épingle')

  /* Qu'un chargeur oublie sa révision, et ce modèle-là retire `main` en silence. Le relais du
     téléchargement ne se donne donc qu'avec elle, par `sourceOf`, et nulle part ailleurs. */
  const worker = code(read('src/main/tagging/inference.worker.ts'))
  const relays = worker.match(/progress_callback: watchDownload/g)?.length ?? 0
  if (relays === 1 && /await revisionOf\(model\)\s*return \{ progress_callback: watchDownload \}/.test(worker)) {
    pass('le relais du téléchargement ne se donne qu’une fois la révision décidée')
  } else fail(`le relais du téléchargement est posé ${relays} fois, hors de sourceOf`)
  /* Et la révision s'applique à l'adresse, pour toutes les requêtes de la bibliothèque : passée
     en option, `pipeline()` l'oubliait dans sa découverte des fichiers. */
  if (/env\.fetch = \(input: string \| URL, init\?: RequestInit\) =>\s*original\(pinnedUrl\(/.test(worker)) {
    pass('toutes les requêtes du hub passent par l’épingle')
  } else fail('le fetch de la bibliothèque n’est plus enveloppé : les requêtes visent main')
  /* Chaque chargement reçoit ce que `sourceOf` rend — directement, ou par la variable qui le
     garde pour les chargeurs d'un même modèle. */
  const loaders = [...worker.matchAll(/\b(?:from_pretrained|pipeline)\(\s*[^,]+,\s*([^)]*)/g)]
  const bare = loaders.filter((match) => !/sourceOf\(|\bstructure\b|\bmeaning\b/.test(match[1]))
  if (loaders.length > 0 && bare.length === 0) {
    pass(`les ${loaders.length} chargements passent par sourceOf`)
  } else fail(`${bare.length} chargement(s) sans révision sur ${loaders.length}`)
  if (/DOWNLOAD_REPORT_MS/.test(worker)) pass('l’avancement du téléchargement est espacé')
  else fail('chaque paquet téléchargé redevient un message, un instantané et un menu reconstruit')
}

console.log('\nles empreintes de vecteurs n’ont pas bougé')
{
  /* Les noms ont quitté `embeddings.ts` et `vision.ts` pour `models.ts`. Les empreintes les
     contiennent : si la chaîne changeait, toute la bibliothèque repasserait par les modèles. */
  const vision = read('src/main/tagging/vision.ts')
  if (/const VERSION = `\$\{STRUCTURE_MODEL\}\|\$\{MEANING_MODEL\}\|q8\|v1`/.test(vision)) {
    pass('l’empreinte des images porte toujours les deux mêmes noms')
  } else fail('l’empreinte des images a changé de forme')
}

async function runtime(): Promise<void> {
  const { embeddingHash } = await import('../src/main/tagging/embeddings')
  const expected = createHash('sha1').update('Xenova/multilingual-e5-small blender donut').digest('hex').slice(0, 16)
  if (embeddingHash('blender donut') === expected) pass('l’empreinte du texte est celle d’avant, à l’octet près')
  else fail('l’empreinte du texte a changé : toute la bibliothèque serait réencodée')

  console.log('\nle registre des révisions et les partiels')
  const root = mkdtempSync(join(tmpdir(), 'magpie-models-'))
  process.env.MAGPIE_DATA_DIR = root
  const store = await import('../src/main/models/store')
  const models = join(root, 'models')
  const a = createHash('sha1').update('a').digest('hex')
  store.recordModelRevision(TEXT_MODEL, a)
  store.recordModelRevision(TEXT_MODEL, createHash('sha1').update('b').digest('hex'))
  store.recordModelRevision(SPEECH_MODEL, 'main')
  const known = store.modelRevisions()
  if (known[TEXT_MODEL] === a && Object.keys(known).length === 1) {
    pass('la première révision rangée fait foi, et seul un SHA se range')
  } else fail(`registre inattendu : ${JSON.stringify(known)}`)
  mkdirSync(join(models, 'Xenova', 'whisper-base', 'onnx'), { recursive: true })
  const dead = 2 ** 22 + 12345
  writeFileSync(join(models, 'Xenova', 'whisper-base', 'onnx', `decoder.onnx.tmp.${dead}.k3x9`), 'x'.repeat(64))
  writeFileSync(join(models, 'Xenova', 'whisper-base', 'onnx', `encoder.onnx.tmp.${process.pid}.a1b2`), 'y')
  writeFileSync(join(models, 'Xenova', 'whisper-base', 'config.json'), '{}')
  const swept = await store.sweepPartialDownloads((pid) => pid === process.pid, models)
  const left = readdirSync(join(models, 'Xenova', 'whisper-base', 'onnx'))
  if (swept.removed === 1 && swept.freed === 64 && left.length === 1 && left[0].includes(String(process.pid))) {
    pass('un partiel sans auteur vivant part, celui d’un téléchargement en cours reste')
  } else fail(`balayage inattendu : ${JSON.stringify(swept)}, restent ${left.join(', ')}`)
  const listed = await store.listModels()
  if (listed.every((entry) => entry.id.includes('/')) && listed.some((entry) => entry.id === SPEECH_MODEL)) {
    pass('le registre ne passe pas pour un modèle dans l’inventaire')
  } else fail(`inventaire inattendu : ${listed.map((entry) => entry.id).join(', ')}`)
}

void runtime()
  .catch((error: unknown) => fail(`contrôle d’exécution impossible : ${error instanceof Error ? error.message : String(error)}`))
  .finally(() => {
    console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} manquement(s).`)
    process.exitCode = failures === 0 ? 0 : 1
  })
