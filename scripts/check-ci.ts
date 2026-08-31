import { readFileSync } from 'node:fs'

/**
 * Chaque contrôle tourne quelque part : `npm run check:ci`
 *
 * **Sur vingt-six scripts `check:`, quatre passaient dans le pipeline de publication.** Pas
 * treize, pas vingt : quatre. `release.yml` — le seul workflow qui produise l'installateur
 * que les gens téléchargent — vérifiait moins que celui qui relit une pull request. Une
 * release pouvait donc partir avec le schéma dérivé de ses migrations, des clés de traduction
 * manquantes, la carte cassée, et chacun des trente-neuf défauts que les autres contrôles
 * existent précisément pour rejouer.
 *
 * La cause n'est pas un oubli, c'est une duplication : deux listes tenues à la main, dans deux
 * fichiers YAML, qu'aucun compilateur ne relie au `package.json`. Écrire un contrôle et
 * oublier de le brancher ne coûte rien sur le moment et ne se voit jamais — le script passe au
 * vert quand on le lance soi-même, ce qui donne exactement l'impression d'être protégé.
 *
 * D'où la règle, qui porte sur le seul endroit où les trois fichiers peuvent se contredire :
 * **tout script `check:*` est dans `verify`, ou dans la liste d'exclusions ci-dessous avec sa
 * raison.** Pas de troisième possibilité. Et les deux workflows appellent `verify`, jamais une
 * liste à eux.
 */

/**
 * Ce qui ne peut pas tourner sur une machine de CI, et pourquoi.
 *
 * La raison est obligatoire : c'est elle qui empêche cette liste de devenir la poubelle où
 * l'on range ce qu'on n'a pas envie de faire passer.
 */
const OFFLINE: Record<string, string> = {
  'check:db':
    'lit la bibliothèque réelle — l’index FTS5 en table externe ne se vérifie que sur des données vécues',
  'check:vision': 'télécharge DINOv2 et SigLIP, soit ~290 Mo de modèles',
  'check:transcribe': 'télécharge Whisper, soit ~354 Mo de modèles',
  'check:inference': 'exige Electron et la copie empaquetée, produite après la CI'
}

let failures = 0
function fail(message: string): void {
  failures += 1
  console.log(`  ✗ ${message}`)
}
function pass(message: string): void {
  console.log(`  ✓ ${message}`)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>
}
const scripts = Object.keys(pkg.scripts)
const checks = scripts.filter((name) => name.startsWith('check:'))
const verify = pkg.scripts['verify'] ?? ''

console.log('Vérification du branchement des contrôles\n')

console.log('chaque contrôle tourne, ou dit pourquoi il ne peut pas')
{
  /* `check:ci` se vérifierait lui-même : il tourne dans les deux workflows, mais avant
     `verify` et non dedans — le garde ne peut pas être gardé par ce qu'il garde. */
  const wired = new Set(
    [...verify.matchAll(/npm run (check:[\w-]+)/g)].map((match) => match[1])
  )
  for (const check of checks) {
    if (check === 'check:ci') continue
    const excused = OFFLINE[check]
    if (wired.has(check) && excused) {
      fail(`${check} — à la fois dans verify et dans les exclusions : choisir`)
    } else if (wired.has(check)) {
      pass(check)
    } else if (excused) {
      pass(`${check} — hors CI : ${excused}`)
    } else {
      fail(`${check} — n’est ni dans verify ni dans les exclusions motivées`)
    }
  }

  /* Une exclusion qui ne correspond à aucun script est un vestige : elle laisse croire qu'on
     a réfléchi à un contrôle qui n'existe plus. */
  for (const excused of Object.keys(OFFLINE)) {
    if (!checks.includes(excused)) fail(`${excused} — exclu, mais ce script n’existe pas`)
  }
}

console.log('\nles deux workflows appellent la même liste')
{
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
  const release = readFileSync('.github/workflows/release.yml', 'utf8')

  for (const [name, text] of [
    ['ci.yml', ci],
    ['release.yml', release]
  ] as const) {
    if (!/npm run verify\b/.test(text)) {
      fail(`${name} — n’appelle pas npm run verify`)
    } else if (!/npm run check:ci\b/.test(text)) {
      fail(`${name} — n’appelle pas npm run check:ci, donc rien n’y garde la liste`)
    } else {
      pass(`${name} appelle check:ci puis verify`)
    }

    /* Le défaut d'origine, énoncé comme règle : un workflow qui nomme des contrôles un par un
       tient une seconde liste, et une seconde liste finit par diverger. */
    const named = [...text.matchAll(/npm run (check:[\w-]+)/g)]
      .map((match) => match[1])
      .filter((check) => check !== 'check:ci')
    if (named.length > 0) {
      fail(`${name} — énumère ${named.length} contrôle(s) au lieu de passer par verify : ${named.join(', ')}`)
    }
  }
}

console.log('\nverify compile avant ce qui lit la compilation')
{
  /* `check:map` inspecte la sortie de build : le placer avant `npm run build` le ferait
     travailler sur celle du coup d'avant, donc passer au vert sur du code disparu. */
  const build = verify.indexOf('npm run build')
  const map = verify.indexOf('npm run check:map ')
  const mapEnd = verify.indexOf('npm run check:map', build)
  if (build < 0) fail('verify ne compile pas')
  else if (map >= 0 && map < build) fail('check:map tourne avant la compilation qu’il inspecte')
  else if (mapEnd < 0) fail('check:map ne tourne pas après la compilation')
  else pass('la compilation précède les contrôles qui la lisent')
}

console.log(failures === 0 ? '\nTout est branché.' : `\n${failures} manquement(s).`)
process.exitCode = failures === 0 ? 0 : 1
