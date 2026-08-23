import { mkdirSync, rmSync, writeFileSync, truncateSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * L'éviction des clips tient-elle son plafond, sans vider la bibliothèque d'un coup ?
 *
 * Deux garanties, et la seconde compte autant que la première. Rien n'évinçait jamais de clip :
 * `makeThumbnailRoom` ne filtrait que les `.webp`, et aucune fonction ne regardait les `.mp4`.
 * Une fois la part pleine les clips étaient *refusés*, jamais *repris* — le dossier ne pouvait
 * donc que croître, ou être vidé en entier. Relevé sur la bibliothèque de référence : dix-huit
 * gigaoctets pour un plafond réglé à cinq.
 *
 * Mais revenir au plafond **d'un seul coup** serait pire que le mal. Les liens vidéo des
 * plateformes sont signés et expirent : un clip supprimé ne revient que tant que son lien vaut
 * encore, et sur de l'historique ancien il faut une resynchronisation complète. Quatorze
 * gigaoctets effacés au premier clip demandé, en silence, seraient une perte sèche. On revient
 * donc par paliers — c'est ce que la seconde assertion protège.
 *
 * Les fichiers sont créés par `truncate` : la taille annoncée est la seule chose que lit
 * l'éviction, et écrire cinq gigaoctets pour de vrai coûterait des minutes.
 */

const root = join(tmpdir(), `magpie-budget-${process.pid}`)
rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, 'media'), { recursive: true })
process.env['MAGPIE_DATA_DIR'] = root

const MB = 1024 * 1024
const CLIP_MB = 64
/* Le plafond vient des réglages par défaut — 5 Gio, dont 75 % pour les clips : ceux-ci vivent
   dans le profil système, hors de portée d'un banc. On dépasse donc le défaut. */
const CLIP_BUDGET_MB = Math.round(5 * 1024 * 0.75)
const COUNT = Math.ceil((CLIP_BUDGET_MB * 1.35) / CLIP_MB)

const hex = (n: number): string => n.toString(16).padStart(40, '0')
for (let index = 0; index < COUNT; index += 1) {
  const path = join(root, 'media', `${hex(index)}.mp4`)
  writeFileSync(path, '')
  truncateSync(path, CLIP_MB * MB)
  // Le plus grand numéro est le plus ancien : l'ordre du dossier ne doit rien décider.
  const when = new Date(Date.now() - index * 86_400_000)
  utimesSync(path, when, when)
}

const { makeVideoRoom } = await import('../src/main/media/cache')

let failures = 0
function assert(condition: unknown, message: string): void {
  if (condition) console.log(`  ✓ ${message}`)
  else {
    failures += 1
    console.log(`  ✗ ${message}`)
  }
}

const clipsLeft = (): string[] => readdirSync(join(root, 'media')).filter((n) => n.endsWith('.mp4'))
const megabytesLeft = (): number => clipsLeft().length * CLIP_MB

console.log(`${COUNT} clips de ${CLIP_MB} Mo — ${megabytesLeft()} Mo pour une part de ${CLIP_BUDGET_MB} Mo`)

console.log('\nUne passe rend de la place sans vider la bibliothèque')
const before = megabytesLeft()
await makeVideoRoom(CLIP_MB * MB)
const afterOne = megabytesLeft()
const PASS_LIMIT_MB = 12 * 96
assert(afterOne < before, `elle rend de la place (${before} Mo → ${afterOne} Mo)`)
assert(
  before - afterOne <= PASS_LIMIT_MB,
  `elle s'arrête au palier (${before - afterOne} Mo rendus, palier ${PASS_LIMIT_MB} Mo)`
)
assert(afterOne > CLIP_BUDGET_MB, 'une seule passe ne suffit pas à revenir au plafond')
assert(
  !clipsLeft().includes(`${hex(COUNT - 1)}.mp4`),
  'le clip le plus anciennement consulté part le premier'
)
assert(clipsLeft().includes(`${hex(0)}.mp4`), 'le plus récemment consulté reste')

console.log('\nLes passes suivantes convergent vers le plafond')
for (let pass = 0; pass < 12; pass += 1) await makeVideoRoom(CLIP_MB * MB)
const settled = megabytesLeft()
assert(settled + CLIP_MB <= CLIP_BUDGET_MB, `on finit dans la part (${settled} Mo pour ${CLIP_BUDGET_MB} Mo)`)
assert(settled > CLIP_BUDGET_MB / 2, `et la bibliothèque n'est pas vidée (${settled} Mo restants)`)

console.log('\nUne part déjà tenue ne coûte rien')
const quiet = megabytesLeft()
await makeVideoRoom(CLIP_MB * MB)
assert(megabytesLeft() === quiet, 'aucun clip évincé quand la place suffit')

/* Le nettoyage est un confort : sous Windows un descripteur encore ouvert le fait échouer,
   et ce n'est pas ce que ce banc mesure. */
try {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
} catch {
  console.log(`  (dossier temporaire laissé sur place : ${root})`)
}
console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} échec(s).`)
process.exit(failures === 0 ? 0 : 1)
