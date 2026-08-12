/**
 * Diagnostic ponctuel du cache média : `npx tsx scripts/diagnose-media.ts`
 *
 * Répond à une seule question : pourquoi une vignette manque-t-elle ? En distinguant
 * « jamais tentée » (pas de source), « source distante » et « déjà en cache », on sait
 * immédiatement si le problème est à l'ingestion ou au téléchargement.
 */
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { libraryDbPath } from './library-path'

const dbPath = libraryDbPath()

if (!existsSync(dbPath)) {
  console.error(`Base introuvable : ${dbPath}`)
  process.exit(1)
}

const db = new Database(dbPath, { readonly: true })

const posts = db
  .prepare('SELECT platform, is_demo, COUNT(*) n FROM posts GROUP BY platform, is_demo')
  .all() as { platform: string; is_demo: number; n: number }[]

console.log('posts')
for (const row of posts) {
  console.log(`  ${row.platform}${row.is_demo ? ' (démo)' : ''} : ${row.n}`)
}

const media = db
  .prepare(
    `SELECT p.platform,
            p.is_demo,
            COUNT(*) AS total,
            SUM(CASE WHEN m.thumb_path IS NOT NULL THEN 1 ELSE 0 END) AS avec_vignette,
            SUM(CASE WHEN m.source_path IS NOT NULL THEN 1 ELSE 0 END) AS avec_source_locale,
            SUM(CASE WHEN m.remote_url LIKE 'http%' THEN 1 ELSE 0 END) AS avec_url_distante,
            SUM(CASE WHEN m.video_path IS NOT NULL THEN 1 ELSE 0 END) AS avec_clip
       FROM media m JOIN posts p ON p.id = m.post_id
      GROUP BY p.platform, p.is_demo`
  )
  .all() as Record<string, number | string>[]

console.log('\nmédias')
for (const row of media) {
  console.log(
    `  ${row.platform}${row.is_demo ? ' (démo)' : ''} : ${row.total} médias, ` +
      `${row.avec_vignette} vignettes, ${row.avec_source_locale} sources locales, ` +
      `${row.avec_url_distante} URLs distantes, ${row.avec_clip} clips`
  )
}

const sample = db
  .prepare(
    `SELECT m.remote_url, m.video_source
       FROM media m JOIN posts p ON p.id = m.post_id
      WHERE p.is_demo = 0 AND m.thumb_path IS NULL
      LIMIT 3`
  )
  .all() as { remote_url: string | null; video_source: string | null }[]

if (sample.length > 0) {
  console.log('\nexemples de médias sans vignette')
  for (const row of sample) {
    console.log(`  image : ${row.remote_url?.slice(0, 110) ?? '(aucune)'}`)
    if (row.video_source) console.log(`  clip  : ${row.video_source.slice(0, 110)}`)
  }
}

const dims = db
  .prepare(
    `SELECT COUNT(*) n FROM posts WHERE is_demo = 0 AND (width IS NULL OR height IS NULL)`
  )
  .get() as { n: number }
console.log(`\nposts réels sans dimensions : ${dims.n}`)

db.close()
