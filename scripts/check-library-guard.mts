import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { SCHEMA_VERSION } from '../src/main/db/schema'

/**
 * Le secours d'ouverture répare-t-il seulement ce qui est cassé ?
 *
 * Il existe parce qu'un cas réel avait rendu une bibliothèque inouvrable sans aucun recours
 * depuis l'interface : base remplacée par une copie ancienne, journal dépareillé resté à côté,
 * boîte d'erreur et arrêt. Le secours met alors le fichier de côté et restaure une sauvegarde.
 *
 * **Il a fait pire que le mal une fois**, et c'est ce que ce contrôle interdit. Une vieille
 * version lancée sur une bibliothèque déjà migrée levait au même endroit, et le secours a mis
 * de côté une base parfaitement saine, restauré une sauvegarde antérieure — perdant tout ce qui
 * avait été fait depuis — puis échoué quand même, la sauvegarde étant elle aussi trop récente
 * pour ce lecteur. Relevé sur la bibliothèque de référence : deux mises à l'écart de 285 Mo en
 * dix secondes, vingt-sept collections évaporées, application toujours morte.
 *
 * Les trois assertions portent donc sur ce qui a effectivement mal tourné :
 *
 *   — une base venue du futur ne bouge **pas d'un octet**, et l'erreur le dit ;
 *   — une base réellement abîmée est toujours secourue, sinon le remède d'origine est perdu ;
 *   — les mises à l'écart ne s'accumulent plus : elles pèsent la bibliothèque entière chacune.
 *
 * Chaque scène tourne dans son propre processus : `getDb()` mémorise sa connexion, donc une
 * seule ouverture est possible par exécution.
 */

const scene = process.argv[2]

/** Une base valide, à la version demandée. Le contenu n'importe pas, l'en-tête si. */
function makeLibrary(path: string, version: number): void {
  const db = new Database(path)
  db.exec('CREATE TABLE IF NOT EXISTS marker (note TEXT)')
  db.prepare('INSERT INTO marker (note) VALUES (?)').run(`v${version}`)
  db.pragma(`user_version = ${version}`)
  db.close()
}

if (scene) {
  /* Dans le processus enfant : on ouvre, et on laisse l'erreur ou le succès parler. */
  process.env.MAGPIE_DATA_DIR = process.argv[3]
  const { getDb } = await import('../src/main/db/index')
  try {
    getDb()
    console.log('OUVERT')
  } catch (error) {
    console.log('REFUS', error instanceof Error ? error.message : String(error))
  }
  process.exit(0)
}

let failures = 0

function assert(condition: unknown, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${message}`)
}

const root = join(tmpdir(), `magpie-guard-${process.pid}`)
rmSync(root, { recursive: true, force: true })

function play(name: string, prepare: (dir: string) => void): { out: string; files: string[] } {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  prepare(dir)
  /* Le même exécutable et les mêmes drapeaux que nous : `execArgv` porte le chargeur `tsx`,
     sans lequel l'enfant ne saurait pas lire du TypeScript. */
  const out = execFileSync(
    process.execPath,
    [...process.execArgv, process.argv[1], name, dir],
    { encoding: 'utf8', env: { ...process.env, MAGPIE_DATA_DIR: dir } }
  )
  return { out, files: readdirSync(dir).sort() }
}

console.log('Une base venue du futur ne se « répare » pas')
{
  const before: string[] = []
  const { out, files } = play('future', (dir) => {
    makeLibrary(join(dir, 'magpie.db'), 999)
    // Une sauvegarde tentante juste à côté : le secours ne doit pas y toucher non plus.
    makeLibrary(join(dir, 'magpie-before-v999-1.db'), 0)
    before.push(...readdirSync(dir).sort())
  })

  assert(out.includes('REFUS'), 'elle refuse de s’ouvrir')
  assert(
    out.includes('schéma v999') && out.includes('Installez la dernière version'),
    'et l’erreur dit quoi faire'
  )
  assert(
    files.join('|') === before.join('|'),
    `aucun fichier écarté ni restauré (${files.length} fichiers, inchangés)`
  )
  assert(
    !files.some((name) => name.startsWith('magpie-illisible')),
    'rien n’a été mis de côté'
  )
  const db = new Database(join(root, 'future', 'magpie.db'), { readonly: true })
  assert(db.pragma('user_version', { simple: true }) === 999, 'la base est restée en v999')
  db.close()
}

console.log('\nUne base réellement abîmée est toujours secourue')
{
  const { out, files } = play('broken', (dir) => {
    // Ni SQLite ni rien : un en-tête invalide, ce que produit une copie interrompue.
    writeFileSync(join(dir, 'magpie.db'), Buffer.from('ceci n’est pas une base'))
    makeLibrary(join(dir, 'magpie-before-v9-1.db'), 0)
  })

  assert(out.includes('OUVERT'), 'elle s’ouvre après restauration')
  assert(
    files.some((name) => name.startsWith('magpie-illisible')),
    'l’originale est mise de côté plutôt que détruite'
  )
}

console.log('\nLes mises à l’écart ne s’accumulent pas')
{
  const { files } = play('pruned', (dir) => {
    writeFileSync(join(dir, 'magpie.db'), Buffer.from('abimee'))
    makeLibrary(join(dir, 'magpie-before-v9-1.db'), 0)
    /* Cinq copies déjà là. Chacune pèse la bibliothèque entière : sur la bibliothèque de
       référence, quatre d'entre elles faisaient un gigaoctet et demi. */
    for (let index = 0; index < 5; index += 1) {
      makeLibrary(join(dir, `magpie-illisible-2020-01-0${index + 1}T00-00-00-000Z.db`), 0)
    }
  })

  const quarantined = files.filter((name) => name.startsWith('magpie-illisible'))
  assert(
    quarantined.length === 2,
    `il n’en reste que deux, la plus récente comprise (${quarantined.length})`
  )
}


console.log('\nUne migration qui échoue n’emporte pas la bibliothèque')
{
  const { out, files } = play('migration', (dir) => {
    /* Une base au tout premier palier, sans aucune des tables que la suite altère : le palier
       2 lève, la transaction annule tout, et `user_version` reste où il était. C’est la forme
       exacte du défaut qui a coûté `map_labels`.

       On part de 1 plutôt que de l’avant-dernier palier : celui-ci peut très bien être une
       migration qui ne lève sur rien — un `DROP TABLE IF EXISTS` en est une — et le banc ne
       mesurerait alors plus rien sans que personne le remarque. */
    makeLibrary(join(dir, 'magpie.db'), 1)
    makeLibrary(join(dir, `magpie-before-v${SCHEMA_VERSION}-1.db`), 0)
  })

  assert(out.includes('REFUS'), 'elle refuse de s’ouvrir')
  assert(
    out.includes('La migration du schéma a échoué'),
    'et l’erreur nomme la migration, pas une base illisible'
  )
  assert(
    !files.some((name) => name.startsWith('magpie-illisible')),
    'rien n’est mis de côté'
  )
  const db = new Database(join(root, 'migration', 'magpie.db'), { readonly: true })
  assert(
    db.pragma('user_version', { simple: true }) === 1,
    'la base est restée telle quelle'
  )
  db.close()
}

console.log('\nUne ouverture réussie fait le ménage')
{
  /* Les deux purges n’étaient appelées que depuis l’incident qui les crée. Dès que tout
     allait bien, plus rien ne balayait : huit mises à l’écart et trois sauvegardes dormaient
     dans le dossier de référence, environ deux gigaoctets et demi. */
  const { out, files } = play('swept', (dir) => {
    makeLibrary(join(dir, 'magpie.db'), SCHEMA_VERSION)
    for (let index = 0; index < 5; index += 1) {
      makeLibrary(join(dir, `magpie-illisible-2020-01-0${index + 1}T00-00-00-000Z.db`), 0)
    }
    for (let index = 0; index < 3; index += 1) {
      makeLibrary(join(dir, `magpie-before-v9-${index + 1}.db`), 0)
    }
  })

  assert(out.includes('OUVERT'), 'elle s’ouvre')
  const quarantined = files.filter((name) => name.startsWith('magpie-illisible'))
  const backups = files.filter((name) => /^magpie-before-v\d+-\d+\.db$/.test(name))
  assert(quarantined.length === 2, `deux mises à l’écart au plus (${quarantined.length})`)
  assert(backups.length === 1, `une seule sauvegarde de migration (${backups.length})`)
}

console.log('\nUn fichier qu’on ne peut pas retirer n’arrête pas le ménage')
{
  /* Relevé sur la vraie installation : trois mises à l’écart et deux sauvegardes avaient
     survécu au balayage, un gigaoctet et demi, et la seule trace était des `-wal` orphelins
     dont le `.db` avait bien été retiré. La cause est un `rmSync` qui lève — sous Windows, un
     journal encore ouvert par un autre processus donne `EBUSY` — au milieu d’une boucle
     enveloppée dans un seul `try` : tout ce qui restait à retirer était abandonné.

     On ne peut pas verrouiller un fichier de façon portable ; un **dossier** à la place du
     fichier attendu produit exactement la même chose, `rmSync` sans `recursive` levant dessus. */
  const { out, files } = play('locked', (dir) => {
    makeLibrary(join(dir, 'magpie.db'), SCHEMA_VERSION)
    for (let index = 0; index < 5; index += 1) {
      const name = `magpie-illisible-2020-01-0${index + 1}T00-00-00-000Z.db`
      makeLibrary(join(dir, name), 0)
      /* Des dates franchement distinctes : le balayage trie par date et garde les deux plus
         récentes, donc sans cela l'ordre de passage dépendrait de la milliseconde d'écriture —
         et la scène passerait ou non selon l'humeur du disque. */
      const when = new Date(2020, 0, index + 1)
      utimesSync(join(dir, name), when, when)
    }
    /* Le journal de la **première** que le balayage voudra retirer, c'est-à-dire la
       troisième plus récente : son retrait lève, et c'est là que tout s'arrêtait. */
    mkdirSync(join(dir, 'magpie-illisible-2020-01-03T00-00-00-000Z.db-wal'))
    for (let index = 0; index < 3; index += 1) {
      makeLibrary(join(dir, `magpie-before-v9-${index + 1}.db`), 0)
    }
  })

  assert(out.includes('OUVERT'), 'la bibliothèque s’ouvre quand même')
  const quarantined = files.filter((name) => /^magpie-illisible-.*\.db$/.test(name))
  const backups = files.filter((name) => /^magpie-before-v\d+-\d+\.db$/.test(name))
  assert(
    quarantined.length === 2,
    `les autres mises à l’écart sont retirées malgré l’échec (${quarantined.length})`
  )
  assert(
    backups.length === 1,
    `et les sauvegardes de migration aussi (${backups.length})`
  )
}
rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} échec(s).`)
process.exit(failures === 0 ? 0 : 1)
