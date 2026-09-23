import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { SCHEMA_VERSION } from '../src/main/db/schema'
import {
  autoBackupName,
  autoBackupTime,
  backupsToPrune,
  KEEP_DAILY,
  KEEP_WEEKLY
} from '../src/main/db/backup-files'

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
 * Puis les sauvegardes régulières, et ce qu'elles ont changé au secours :
 *
 *   — une base verrouillée ou inaccessible n'est pas une base abîmée : on ne touche à rien ;
 *   — le secours remet en place la sauvegarde **la plus récente qui est saine**, régulière ou
 *     d'avant migration, jamais une copie venue du futur, et dit à quelle date ;
 *   — une copie se fait, en un seul fichier, tourne, et restaure réellement.
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
  const { getDb, takeLibraryRecovery } = await import('../src/main/db/index')
  try {
    getDb()
    console.log('OUVERT')
    /* Ce que l'interface annoncera : la date de la sauvegarde remise en place. */
    console.log('SECOURS', JSON.stringify(takeLibraryRecovery()))
    if (scene.startsWith('backup')) {
      const { backupNow } = await import('../src/main/db/backups')
      console.log('SAUVEGARDE', (await backupNow()).name)
    }
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
/** Ce que le secours annonce, tel que l'enfant l'a imprimé. */
function recoveryOf(out: string): { restoredAt: number | null; setAside: string | null } | null {
  const line = out.split('\n').find((text) => text.startsWith('SECOURS '))
  return line ? JSON.parse(line.slice('SECOURS '.length)) : null
}

function markerOf(path: string): string | null {
  const db = new Database(path, { readonly: true })
  try {
    return (db.prepare('SELECT note FROM marker').get() as { note: string } | undefined)?.note ?? null
  } catch {
    return null
  } finally {
    db.close()
  }
}

/** Une base valide qui dit d'où elle vient : c'est ce qu'on relit après restauration. */
function makeNamedLibrary(path: string, version: number, note: string): void {
  const db = new Database(path)
  db.exec('CREATE TABLE IF NOT EXISTS marker (note TEXT)')
  db.prepare('INSERT INTO marker (note) VALUES (?)').run(note)
  db.pragma(`user_version = ${version}`)
  db.close()
}

console.log('\nUne base verrouillée par un autre programme n’est pas une base abîmée')
{
  /* Un antivirus ou un outil de synchronisation qui tient le fichier suffisait à le faire
     mettre de côté et remplacer par une sauvegarde ancienne. Le verrou est réel ici : ce
     processus-ci tient la base en écriture exclusive pendant que l'enfant tente de l'ouvrir. */
  let holder: Database.Database | null = null
  const { out, files } = play('locked-db', (dir) => {
    makeNamedLibrary(join(dir, 'magpie.db'), SCHEMA_VERSION, 'vraie')
    makeNamedLibrary(join(dir, 'magpie-before-v9-1.db'), 0, 'ancienne')
    holder = new Database(join(dir, 'magpie.db'))
    holder.exec('BEGIN EXCLUSIVE')
  })
  holder!.exec('ROLLBACK')
  holder!.close()

  assert(out.includes('REFUS'), 'elle refuse de s’ouvrir')
  assert(out.includes('(locked)'), 'et l’erreur parle d’un verrou, pas d’une corruption')
  assert(!files.some((name) => name.startsWith('magpie-illisible')), 'rien n’est mis de côté')
  assert(markerOf(join(root, 'locked-db', 'magpie.db')) === 'vraie', 'la base est restée la vraie')
}

console.log('\nUne base qu’on ne peut pas ouvrir n’est pas une base abîmée')
{
  /* Un refus d'accès. On ne peut pas retirer un droit de façon portable — et ce banc tourne
     parfois en administrateur, que rien n'arrête — ; un dossier à la place du fichier produit
     le même `SQLITE_CANTOPEN`. */
  const { out, files } = play('denied', (dir) => {
    mkdirSync(join(dir, 'magpie.db'))
    makeNamedLibrary(join(dir, 'magpie-before-v9-1.db'), 0, 'ancienne')
  })
  assert(out.includes('REFUS') && out.includes('(denied)'), 'elle refuse de s’ouvrir, et dit pourquoi')
  assert(!files.some((name) => name.startsWith('magpie-illisible')), 'rien n’est mis de côté')
  assert(existsSync(join(root, 'denied', 'magpie-before-v9-1.db')), 'ni restauré')
}

console.log('\nLe secours remet en place la sauvegarde saine la plus récente')
{
  const now = Date.now()
  const hour = 3_600_000
  const at = (hoursAgo: number): number => Math.floor((now - hoursAgo * hour) / 1000) * 1000
  const { out, files } = play('newest', (dir) => {
    writeFileSync(join(dir, 'magpie.db'), Buffer.from('ceci n’est pas une base'))
    const backups = join(dir, 'backups')
    mkdirSync(backups)
    /* La plus récente vient du futur, la suivante est abîmée : c'est celle d'hier qui doit
       revenir — ni l'avant-veille, ni le filet de migration, bien plus ancien. */
    makeNamedLibrary(join(backups, autoBackupName(at(1))), 999, 'futur')
    writeFileSync(join(backups, autoBackupName(at(2))), Buffer.from('copie interrompue'))
    makeNamedLibrary(join(backups, autoBackupName(at(24))), SCHEMA_VERSION, 'hier')
    makeNamedLibrary(join(backups, autoBackupName(at(48))), SCHEMA_VERSION, 'avant-hier')
    makeNamedLibrary(join(dir, `magpie-before-v${SCHEMA_VERSION}-${at(24 * 30)}.db`), 0, 'migration')
  })
  const recovery = recoveryOf(out)
  assert(out.includes('OUVERT'), 'elle s’ouvre après restauration')
  assert(markerOf(join(root, 'newest', 'magpie.db')) === 'hier', 'c’est la copie saine la plus récente qui revient')
  assert(recovery?.restoredAt === at(24), 'et l’interface saura de quelle date')
  assert(
    Boolean(recovery?.setAside?.startsWith('magpie-illisible')) &&
      files.includes(recovery!.setAside!),
    'le fichier abîmé est gardé, sous le nom annoncé'
  )
}

console.log('\nFaute de sauvegarde régulière saine, le filet de migration sert encore')
{
  const { out } = play('fallback', (dir) => {
    writeFileSync(join(dir, 'magpie.db'), Buffer.from('abimee'))
    mkdirSync(join(dir, 'backups'))
    writeFileSync(join(dir, 'backups', autoBackupName(Date.now() - 3_600_000)), Buffer.from('abimee'))
    makeNamedLibrary(join(dir, 'magpie-before-v9-1700000000000.db'), 0, 'migration')
  })
  assert(out.includes('OUVERT'), 'elle s’ouvre')
  assert(markerOf(join(root, 'fallback', 'magpie.db')) === 'migration', 'depuis le filet de migration')
  assert(recoveryOf(out)?.restoredAt === 1700000000000, 'dont la date vient du nom, pas du fichier')
}

console.log('\nSans aucune sauvegarde saine, l’interface le saura aussi')
{
  const { out } = play('nothing', (dir) => {
    writeFileSync(join(dir, 'magpie.db'), Buffer.from('abimee'))
  })
  const recovery = recoveryOf(out)
  assert(out.includes('OUVERT'), 'une bibliothèque vide s’ouvre')
  assert(recovery !== null && recovery.restoredAt === null, 'et le secours dit qu’aucune date n’a pu revenir')
}

console.log('\nUne sauvegarde se fait, tourne, et restaure')
{
  const day = 86_400_000
  const { out, files } = play('backup', (dir) => {
    makeNamedLibrary(join(dir, 'magpie.db'), SCHEMA_VERSION, 'sauvegardée')
    const backups = join(dir, 'backups')
    mkdirSync(backups)
    /* Deux mois de copies quotidiennes déjà là, et le reste d'une copie interrompue. */
    for (let index = 1; index <= 60; index += 1) {
      makeNamedLibrary(join(backups, autoBackupName(Date.now() - index * day)), SCHEMA_VERSION, `j-${index}`)
    }
    writeFileSync(join(backups, `${autoBackupName(Date.now() - 3_600_000)}.part`), 'interrompue')
  })
  const made = out.split('\n').find((line) => line.startsWith('SAUVEGARDE '))?.slice('SAUVEGARDE '.length)
  const backups = readdirSync(join(root, 'backup', 'backups'))
  assert(Boolean(made) && backups.includes(made!), `la copie est écrite dans backups/ (${made})`)
  assert(!backups.some((name) => name.includes('.part')), 'rien d’interrompu ne reste à côté')
  assert(
    backups.length <= KEEP_DAILY + KEEP_WEEKLY,
    `la rotation garde une dizaine de copies, pas soixante (${backups.length})`
  )
  const copy = new Database(join(root, 'backup', 'backups', made!), { readonly: true })
  assert(copy.pragma('quick_check', { simple: true }) === 'ok', 'la copie est saine')
  assert(copy.pragma('journal_mode', { simple: true }) === 'delete', 'et tient en un seul fichier')
  copy.close()
  assert(markerOf(join(root, 'backup', 'backups', made!)) === 'sauvegardée', 'elle contient la base')
  assert(!files.some((name) => name.startsWith('magpie-illisible')), 'et la base, elle, n’a pas bougé')

  /* Puis la base s'abîme — c'est la vraie raison d'être de tout ceci. */
  const { out: after } = play('backup', (dir) => {
    for (const suffix of ['-wal', '-shm']) rmSync(join(dir, `magpie.db${suffix}`), { force: true })
    writeFileSync(join(dir, 'magpie.db'), Buffer.from('disque fatigué'))
  })
  assert(after.includes('OUVERT'), 'abîmée ensuite, elle se rouvre')
  assert(
    recoveryOf(after)?.restoredAt === autoBackupTime(made!),
    'depuis la copie qu’on vient de faire'
  )
}

console.log('\nLa rotation')
{
  const day = 86_400_000
  const now = Date.now()
  const all = Array.from({ length: 90 }, (_, index) => ({
    name: autoBackupName(now - index * day),
    at: Math.floor((now - index * day) / 1000) * 1000
  }))
  /* Trois clics sur « Sauvegarder maintenant » dans l'heure. */
  for (let index = 1; index <= 3; index += 1) {
    all.push({ name: autoBackupName(now - index * 60_000), at: now - index * 60_000 })
  }
  const pruned = new Set(backupsToPrune(all).map((backup) => backup.name))
  const kept = all.filter((backup) => !pruned.has(backup.name))
  assert(kept.length <= KEEP_DAILY + KEEP_WEEKLY, `trois mois donnent ${kept.length} copies gardées`)
  assert(kept.some((backup) => backup.at === Math.max(...all.map((b) => b.at))), 'la plus récente reste')
  const recent = kept.filter((backup) => now - backup.at < 6.5 * day)
  assert(recent.length === KEEP_DAILY, `une par jour sur la dernière semaine (${recent.length})`)
  const oldest = Math.min(...kept.map((backup) => backup.at))
  assert(now - oldest > 21 * day && now - oldest < 36 * day, 'et l’historique remonte à un mois environ')
  assert(
    autoBackupTime(autoBackupName(1758639730123)) === 1758639730000,
    'la date se relit dans le nom, à la seconde'
  )
}

rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} échec(s).`)
process.exit(failures === 0 ? 0 : 1)
