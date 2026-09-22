/**
 * SCHEMA_SQL contre l'échelle des migrations : `npm run check:schema`
 *
 * L'invariant, et il n'était vérifié nulle part : une installation neuve exécute SCHEMA_SQL
 * *seul* — `migrate()` voit `user_version = 0`, pose le schéma, tamponne la version courante et
 * ne joue aucune migration. Donc tout ce que l'échelle produit doit déjà se trouver dans
 * SCHEMA_SQL. Une table ajoutée dans une migration et oubliée dans SCHEMA_SQL ne manque à
 * personne qui met à jour, et manque à *tout le monde* qui installe.
 *
 * C'est exactement ce qui est arrivé à `map_labels` : créée par les migrations 16 et 17,
 * absente de SCHEMA_SQL. Sur une installation neuve la table n'existait pas, `mapLabels()`
 * levait à chaque ouverture de la carte, et le seul appelant avalait l'erreur dans un `catch` —
 * la fonctionnalité était absente sans que rien ne le dise.
 *
 * Le contrôle ne demande aucune base : deux bases en mémoire suffisent.
 */
import { createRequire } from 'node:module'
import { MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION } from '../src/main/db/schema'

/* `better-sqlite3` est compilé pour Electron par `install-app-deps` ; sous tsx il se charge
   quand même, mais il faut le résoudre depuis la racine du projet et non depuis scripts/. */
const require_ = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = require_('better-sqlite3') as any

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
  else {
    failures++
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * Découpe un lot SQL en instructions.
 *
 * Un simple `split(';')` coupe au milieu des déclencheurs : `CREATE TRIGGER … BEGIN … END;`
 * contient ses propres points-virgules. On suit donc les chaînes, les deux formes de
 * commentaire, et la profondeur BEGIN/END.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let current = ''
  let depth = 0
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]
    const rest = sql.slice(i)
    if (ch === "'") {
      const end = sql.indexOf("'", i + 1)
      const stop = end < 0 ? sql.length : end + 1
      current += sql.slice(i, stop)
      i = stop - 1
      continue
    }
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i)
      const stop = end < 0 ? sql.length : end
      current += sql.slice(i, stop)
      i = stop - 1
      continue
    }
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2)
      const stop = end < 0 ? sql.length : end + 2
      current += sql.slice(i, stop)
      i = stop - 1
      continue
    }
    if (/^\bBEGIN\b/i.test(rest) && /\bTRIGGER\b/i.test(current)) depth += 1
    else if (/^\bEND\b/i.test(rest) && depth > 0) depth -= 1
    if (ch === ';' && depth === 0) {
      if (current.trim()) out.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) out.push(current.trim())
  return out
}

interface Shape {
  objects: Map<string, string>
  columns: Map<string, string[]>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shapeOf(conn: any): Shape {
  const objects = new Map<string, string>()
  const columns = new Map<string, string[]>()
  const rows = conn
    .prepare(
      "SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    )
    .all() as { type: string; name: string; tbl_name: string }[]
  for (const row of rows) {
    objects.set(`${row.type}:${row.name}`, row.tbl_name)
    if (row.type === 'table') {
      columns.set(
        row.name,
        (conn.prepare(`PRAGMA table_info("${row.name}")`).all() as { name: string }[]).map(
          (c) => c.name
        )
      )
    }
  }
  return { objects, columns }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fresh(): any {
  const conn = new Database(':memory:')
  conn.exec(SCHEMA_SQL)
  return conn
}

console.log(`SCHEMA_VERSION = ${SCHEMA_VERSION}\n`)

console.log("l'échelle")
const versions = Object.keys(MIGRATIONS)
  .map(Number)
  .sort((a, b) => a - b)
check('des migrations sont déclarées', versions.length > 0, `${versions.length} paliers`)
check(
  'la dernière migration atteint SCHEMA_VERSION',
  versions[versions.length - 1] === SCHEMA_VERSION,
  `dernier palier v${versions[versions.length - 1]}`
)
check(
  'aucun palier ne manque',
  versions.every((v, i) => i === 0 || v === versions[i - 1] + 1),
  versions.join(', ')
)

console.log('\nSCHEMA_SQL')
{
  const conn = fresh()
  const before = shapeOf(conn)
  conn.exec(SCHEMA_SQL)
  const after = shapeOf(conn)
  check(
    'est rejouable sans rien changer',
    after.objects.size === before.objects.size,
    `${before.objects.size} objets`
  )
  conn.close()
}

/* Le cœur du contrôle : les migrations rejouées **dans l’ordre**, sur une base neuve issue de
   SCHEMA_SQL, ne doivent rien laisser derrière elles. Une instruction qui réussit et fait
   apparaître un objet désigne ce que SCHEMA_SQL a oublié ; une colonne déjà là se signale par
   « duplicate column name », et c’est le succès.

   Cumulativement, et non palier par palier : un objet créé à un palier puis retiré à un autre
   — collection_boundaries, créée en v16 et supprimée en v22 — ne doit pas compter comme un
   oubli. Seul ce qui survit à toute l’échelle en est un. */
console.log('')
console.log('l’échelle rejouée en entier')
{
  const conn = fresh()
  const before = shapeOf(conn)
  const introduced = new Map<string, number>()
  const errors: string[] = []

  for (const version of versions) {
    for (const statement of splitStatements(MIGRATIONS[version])) {
      try {
        conn.exec(statement)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/duplicate column name|already exists/i.test(message)) {
          errors.push(`v${version} : ${message} — « ${statement.split(String.fromCharCode(10))[0].slice(0, 60)} »`)
        }
      }
    }
    const now = shapeOf(conn)
    for (const key of now.objects.keys()) {
      if (!before.objects.has(key) && !introduced.has(key)) introduced.set(key, version)
    }
    for (const [table, cols] of now.columns) {
      const had = before.columns.get(table)
      if (!had) continue
      for (const column of cols) {
        const key = `column:${table}.${column}`
        if (!had.includes(column) && !introduced.has(key)) introduced.set(key, version)
      }
    }
  }

  const after = shapeOf(conn)
  const surviving: string[] = []
  for (const key of after.objects.keys()) {
    if (!before.objects.has(key)) surviving.push(`${key} (v${introduced.get(key) ?? 0})`)
  }
  for (const [table, cols] of after.columns) {
    const had = before.columns.get(table)
    if (!had) continue
    for (const column of cols) {
      const key = `column:${table}.${column}`
      if (!had.includes(column)) surviving.push(`${key} (v${introduced.get(key) ?? 0})`)
    }
  }
  conn.close()

  check(
    'les migrations n’apportent rien que SCHEMA_SQL n’ait déjà',
    surviving.length === 0,
    surviving.join(', ')
  )
  check('aucune migration ne lève', errors.length === 0, errors.join(' | '))
}

/* Le même nom ne suffit pas. Un index homonyme mais défini autrement passait le contrôle
   précédent — c'est arrivé à `idx_collections_name`, posé par SCHEMA_SQL avec la condition de
   l'index voisin : il ne couvrait aucune ligne, et une installation neuve acceptait deux
   collections du même nom. La dernière définition que l'échelle donne d'un index doit donc
   être, au texte près, celle d'une installation neuve. */
console.log('')
console.log('les index de l’échelle ont leur définition dans SCHEMA_SQL')
{
  const normalise = (sql: string): string =>
    sql
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\bIF\s+(NOT\s+)?EXISTS\b/gi, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*([(),])\s*/g, '$1')
      .replace(/;\s*$/, '')
      .trim()
      .toLowerCase()

  /* `null` : l'index a été retiré plus loin dans l'échelle. */
  const last = new Map<string, { sql: string; version: number } | null>()
  for (const version of versions) {
    for (const statement of splitStatements(MIGRATIONS[version])) {
      const text = normalise(statement)
      const created = /^create (?:unique )?index (\w+)/.exec(text)
      const dropped = /^drop index (\w+)/.exec(text)
      if (created) last.set(created[1], { sql: text, version })
      else if (dropped) last.set(dropped[1], null)
    }
  }

  const conn = fresh()
  const installed = new Map(
    (
      conn
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
        .all() as { name: string; sql: string }[]
    ).map((row) => [row.name, normalise(row.sql)])
  )
  conn.close()

  const differing: string[] = []
  for (const [name, definition] of last) {
    if (!definition) continue
    const fresh = installed.get(name)
    if (fresh !== undefined && fresh !== definition.sql) {
      differing.push(`${name} (v${definition.version}) : « ${definition.sql} » ≠ « ${fresh} »`)
    }
  }
  check(
    'aucun index homonyme défini autrement',
    differing.length === 0,
    differing.length === 0 ? `${last.size} index comparés` : differing.join(' | ')
  )
}

console.log('')
console.log(
  failures === 0
    ? 'SCHEMA_SQL et les migrations disent la même chose.'
    : `${failures} écart(s). Une installation neuve n’aurait pas ce que les migrations produisent.`
)
process.exit(failures === 0 ? 0 : 1)