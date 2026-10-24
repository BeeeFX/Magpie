import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerFunctions } from '../src/main/db/functions'
import { SCHEMA_SQL } from '../src/main/db/schema'
import {
  importLibraryFile,
  LibraryFileError,
  LibraryScanner,
  previewLibraryFile,
  summarise,
  undoImport,
  writeLibraryFile,
  type ImportJournal
} from '../src/main/library-file'
import { normalizeTagName, tagKey } from '../src/shared/tags'
import { read } from './source'

/**
 * Rien n'est captif : `npm run check:library-file`
 *
 * SPEC §10 l'affirmait et §14 le démentait — il n'existait ni import ni export structuré. Ce
 * contrôle tient les promesses du fichier qui les remplace, avec le vrai code et de vraies bases
 * SQLite en mémoire :
 *
 *   — **l'aller-retour est fidèle.** Une bibliothèque exportée, importée dans une base vide puis
 *     réexportée, redonne le même fichier à la date près ;
 *   — **l'import est idempotent.** Réimporter le même fichier, ou l'importer dans une copie de
 *     la bibliothèque qui l'a produit, ne change pas une ligne ;
 *   — **la fusion ne détruit rien.** Tags réunis, favori s'il l'était d'un côté, étiquette et
 *     retrait déjà posés conservés, transcription comblée seulement si elle manquait ;
 *   — **l'annulation rend la bibliothèque d'avant**, ligne pour ligne ;
 *   — **le fichier est une entrée non fiable** : plateformes inconnues, identifiants
 *     incohérents, adresses `javascript:` et fichiers tronqués sont refusés ;
 *   — **la lecture ne suppose aucune mise en page** : réindenté, aux clés réordonnées, lu par
 *     morceaux de sept caractères qui coupent les échappements et les accents, le fichier se lit
 *     pareil.
 */

let failures = 0
function assert(condition: unknown, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${message}`)
}

function library(): Database.Database {
  const db = new Database(':memory:')
  registerFunctions(db)
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  return db
}

const DAY = 86_400_000
const T0 = Date.UTC(2025, 4, 1, 12, 0, 0, 123)

interface Seed {
  platform: 'instagram' | 'x' | 'reddit'
  native: string
  kind?: string
  text?: string | null
  transcript?: string | null
  favorite?: boolean
  archived?: boolean
  demo?: boolean
  label?: string | null
  sources?: ('saved' | 'liked')[]
  tags?: [string, 'user' | 'rule' | 'ai'][]
  media?: { kind: 'image' | 'video'; url: string | null; video?: string | null; variants?: [string, string][]; w?: number; h?: number }[]
  raw?: unknown
  author?: string
}

function seed(db: Database.Database, posts: Seed[]): void {
  const post = db.prepare(
    `INSERT INTO posts (id, platform, native_id, url, author_handle, author_name, author_avatar,
                        text, transcript, kind, media_count, width, height, published_at, saved_at,
                        discovered_at, saved_rank, is_favorite, is_archived, is_demo, label, raw, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const source = db.prepare(
    'INSERT INTO post_sources (post_id, source, source_rank, source_at, discovered_at) VALUES (?, ?, ?, ?, ?)'
  )
  const media = db.prepare(
    `INSERT INTO media (post_id, idx, kind, remote_url, source_path, video_source, thumb_path, width, height)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const variant = db.prepare(
    'INSERT INTO media_variants (post_id, idx, quality, source, width, height, bitrate) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  const tag = db.prepare('INSERT INTO tags (name, source) VALUES (?, ?) ON CONFLICT(name) DO NOTHING')
  const link = db.prepare(
    'INSERT INTO post_tags (post_id, tag_id, source) VALUES (?, (SELECT id FROM tags WHERE name = ? COLLATE NOCASE), ?)'
  )
  db.transaction(() => {
    posts.forEach((entry, rank) => {
      const id = `${entry.platform}:${entry.native}`
      const at = T0 + rank * DAY
      const items = entry.media ?? []
      post.run(
        id,
        entry.platform,
        entry.native,
        `https://example.com/${entry.platform}/${entry.native}`,
        entry.author ?? `@auteur${rank % 7}`,
        `Auteur ${rank % 7}`,
        rank % 3 === 0 ? `https://cdn.example.com/avatar/${rank % 7}.jpg` : null,
        entry.text === undefined ? `Légende n°${rank} #tag${rank % 5}` : entry.text,
        entry.transcript ?? null,
        entry.kind ?? (items.length > 1 ? 'carousel' : items[0]?.kind ?? 'text'),
        items.length,
        items[0]?.w ?? null,
        items[0]?.h ?? null,
        at - 3 * DAY,
        at,
        at + 1000,
        rank,
        entry.favorite ? 1 : 0,
        entry.archived ? 1 : 0,
        entry.demo ? 1 : 0,
        entry.label ?? null,
        entry.raw === undefined ? null : JSON.stringify(entry.raw),
        at + 2000
      )
      for (const [order, name] of (entry.sources ?? ['saved']).entries()) {
        source.run(id, name, rank + order, at - order, at + 1000)
      }
      items.forEach((item, idx) => {
        const local = item.url && !/^https?:/.test(item.url)
        media.run(
          id,
          idx,
          item.kind,
          item.url,
          local ? '/home/quelqu-un/fixtures/image.jpg' : null,
          item.video ?? null,
          'vignette-locale.webp',
          item.w ?? null,
          item.h ?? null
        )
        for (const [quality, url] of item.variants ?? []) variant.run(id, idx, quality, url, 720, 1280, 1_200_000)
      })
      for (const [name, origin] of entry.tags ?? []) {
        tag.run(name, origin)
        link.run(id, name, origin)
      }
    })
  })()
}

/** La bibliothèque de référence : de quoi exercer chaque champ, et assez de posts pour plusieurs tranches. */
function referenceLibrary(): Database.Database {
  const db = library()
  const special: Seed[] = [
    {
      platform: 'instagram',
      native: '111',
      text: 'Café ☕️ « guillemets » "quoted" \\ barre\nnouvelle ligne \u2028 séparateur — 😀',
      transcript: 'bonjour à tous',
      favorite: true,
      label: 'red',
      sources: ['saved', 'liked'],
      tags: [
        ['chats', 'rule'],
        ['Voyage', 'user'],
        ['été', 'ai']
      ],
      media: [
        { kind: 'image', url: 'https://cdn.example.com/a.jpg?sig=1&x=é', w: 1080, h: 1350 },
        {
          kind: 'video',
          url: 'https://cdn.example.com/b.jpg',
          video: 'https://cdn.example.com/b.mp4',
          variants: [
            ['480p', 'https://cdn.example.com/b-480.mp4'],
            ['720p', 'https://cdn.example.com/b-720.mp4'],
            ['1080p', 'C:\\\\clips\\\\local.mp4']
          ],
          w: 720,
          h: 1280
        },
        { kind: 'image', url: 'https://cdn.example.com/c.jpg' }
      ],
      raw: { pk: '111', nested: { list: [1, 2, 3], text: 'brut "et" \\ échappé' } }
    },
    {
      platform: 'x',
      native: '222',
      kind: 'text',
      text: null,
      transcript: '',
      archived: true,
      tags: [['été', 'user']],
      sources: ['liked']
    },
    {
      platform: 'instagram',
      native: '333',
      demo: true,
      media: [{ kind: 'video', url: 'fixture://demo/clip.jpg', video: 'fixture://demo/clip.mp4' }]
    },
    { platform: 'reddit', native: 't3_abc', kind: 'link', text: '[r/cuisine] une recette' }
  ]
  const filler: Seed[] = Array.from({ length: 1300 }, (_, n) => ({
    platform: n % 3 === 0 ? 'x' : 'instagram',
    native: `f${n}`,
    favorite: n % 11 === 0,
    label: n % 13 === 0 ? 'green' : null,
    tags: [[`tag${n % 5}`, 'rule'], ...(n % 4 === 0 ? [['lot', 'user'] as [string, 'user']] : [])],
    media: n % 2 === 0 ? [{ kind: 'image' as const, url: `https://cdn.example.com/f${n}.jpg`, w: 640, h: 640 }] : []
  }))
  seed(db, [...special, ...filler])

  const collection = db.prepare(
    'INSERT INTO collections (name, color, kind, query, target_size) VALUES (?, ?, ?, ?, ?)'
  )
  const manual = Number(collection.run('Manuelle', 'blue', 'manual', null, 300).lastInsertRowid)
  const query = Number(collection.run('Cuisine', null, 'query', 'cuisine du monde', 120).lastInsertRowid)
  collection.run('Vide', null, 'manual', null, 300)
  const keyword = db.prepare(
    'INSERT INTO collection_keywords (collection_id, word, weight, vector_text, sort_index) VALUES (?, ?, ?, ?, ?)'
  )
  keyword.run(query, 'cuisine du monde', 1, Buffer.from(new Float32Array([0.1, 0.2]).buffer), 0)
  keyword.run(query, 'recette', 0.5, Buffer.from(new Float32Array([0.3, 0.4]).buffer), 1)
  const member = db.prepare(
    'INSERT INTO collection_posts (collection_id, post_id, added_at, degree) VALUES (?, ?, ?, ?)'
  )
  member.run(manual, 'instagram:111', T0, null)
  member.run(manual, 'x:222', T0, null)
  for (let n = 0; n < 40; n += 1) member.run(query, `instagram:f${n * 3 + 1}`, T0, 1.5)
  db.prepare('INSERT INTO collection_removals (collection_id, post_id, removed_at) VALUES (?, ?, ?)').run(
    query,
    'instagram:333',
    T0
  )
  db.prepare('INSERT INTO map_labels (id, text, anchors, created_at) VALUES (?, ?, ?, ?)').run(
    'etiquette-1',
    'Les chats',
    JSON.stringify(['instagram:111', 'x:222']),
    T0
  )
  return db
}

/** Toute la bibliothèque, ligne à ligne, dans un ordre stable. `updated_at` est de la tenue de livres. */
function dump(db: Database.Database): string {
  const tables: [string, string][] = [
    ['posts', 'id'],
    ['post_sources', 'post_id, source'],
    ['media', 'post_id, idx'],
    ['media_variants', 'post_id, idx, quality'],
    ['tags', 'name'],
    ['post_tags', 'post_id, tag_id'],
    ['collections', 'name'],
    ['collection_keywords', 'collection_id, word'],
    ['collection_posts', 'collection_id, post_id'],
    ['collection_removals', 'collection_id, post_id'],
    ['map_labels', 'id']
  ]
  return tables
    .map(([table, order]) => {
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Record<string, unknown>[]
      return `${table}\n${rows
        .map((row) => {
          const { updated_at: _updated, ...rest } = row
          return JSON.stringify(rest, (_key, value) =>
            Buffer.isBuffer(value) ? value.toString('hex') : value
          )
        })
        .join('\n')}`
    })
    .join('\n\n')
}

function withoutDate(text: string): unknown {
  const parsed = JSON.parse(text) as Record<string, unknown>
  delete parsed.exportedAt
  return parsed
}

const collect = (): { entries: ImportJournal[]; journal: (entry: ImportJournal) => void } => {
  const entries: ImportJournal[] = []
  return { entries, journal: (entry) => void entries.push(entry) }
}

async function problem(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (error) {
    return error instanceof LibraryFileError ? error.problem : `autre : ${String(error)}`
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'magpie-library-file-'))
  try {
    const options = { includeRaw: true, appVersion: '9.9.9' }

    console.log('Vérification du fichier de bibliothèque\n')
    console.log('les noms de tags')
    assert(normalizeTagName('#chats') === 'chats', '« #chats » devient « chats »')
    assert(normalizeTagName('  ##  Street   Photo ') === 'Street Photo', 'dièses, espaces de tête et espaces doublés retirés')
    assert(normalizeTagName('e\u0301te\u0301') === 'été', 'la forme décomposée d’un accent est recomposée')
    assert(normalizeTagName('x'.repeat(200)).length === 80, 'un nom trop long est borné à 80')
    assert(normalizeTagName('#') === '', 'un dièse seul ne fait pas un tag')
    assert(tagKey('Chats') === tagKey('chats') && tagKey('Été') !== tagKey('été'), 'la comparaison replie l’ASCII seul, comme NOCASE')

    const a = referenceLibrary()
    const fileA = join(dir, 'a.json')
    const written = await writeLibraryFile(a, fileA, options)
    const textA = read(fileA)
    const parsedA = JSON.parse(textA) as { format: string; version: number; posts: Record<string, unknown>[] }

    console.log('\nl’export')
    assert(parsedA.format === 'magpie-library' && parsedA.version === 1, 'format et version en tête')
    assert(written.posts === 1304 && parsedA.posts.length === 1304, 'tous les posts, retirés et démonstration compris')
    assert(!/vignette-locale|quelqu-un|fixture:|C:\\\\clips/.test(textA), 'aucun chemin local ni adresse non web ne sort')
    const p111 = parsedA.posts.find((post) => post.id === 'instagram:111') as Record<string, unknown>
    assert(JSON.stringify(p111?.raw) === JSON.stringify({ pk: '111', nested: { list: [1, 2, 3], text: 'brut "et" \\ échappé' } }), '`raw` voyage quand on le demande')
    const lean = join(dir, 'lean.json')
    await writeLibraryFile(a, lean, { ...options, includeRaw: false })
    assert(!read(lean).includes('"raw"'), 'et pas autrement')
    const lines = textA.split('\n').filter((line) => line.startsWith('{"id":') && line.includes('"nativeId"')).length
    assert(lines === 1304, `un post par ligne (${lines})`)

    console.log('\nla lecture ne suppose aucune mise en page')
    {
      const reordered = JSON.stringify(
        { posts: parsedA.posts, ...Object.fromEntries(Object.entries(parsedA).filter(([key]) => key !== 'posts')) },
        null,
        2
      )
      for (const [name, text, size] of [
        ['compact, morceaux de 7', textA, 7],
        ['réindenté et réordonné, morceaux de 7', reordered, 7],
        ['compact, morceaux de 64 ko', textA, 65536]
      ] as const) {
        const scanner = new LibraryScanner()
        const posts: unknown[] = []
        for (let at = 0; at < text.length; at += size) posts.push(...scanner.push(text.slice(at, at + size)))
        scanner.finish()
        const same =
          JSON.stringify(posts) === JSON.stringify(parsedA.posts) &&
          JSON.stringify(scanner.head.collections) === JSON.stringify((parsedA as Record<string, unknown>).collections)
        assert(same, `${name} : mêmes posts, même en-tête`)
      }

      /* La lecture reste linéaire. La première version cherchait la prochaine barre oblique
         inverse à chaque chaîne, jusqu'au bout du morceau : sur soixante mille posts, trente
         secondes d'aperçu et des blocages d'une seconde et demie. Le coût de ce défaut croît avec
         la taille du morceau, celui d'une lecture linéaire non : par morceaux de quatre
         mégaoctets, vingt-six mégaoctets se lisent en ~150 ms, et l'ancienne version y mettait
         quarante-cinq secondes. Le budget de trois secondes ne tremble donc pas sur une machine
         chargée, et ne laisse pas passer le défaut. */
      const element = JSON.stringify({ id: 'x:1', text: 'une légende sans échappement '.repeat(8), tags: ['a', 'b', 'c'] })
      const big = `{"format":"magpie-library","version":1,"posts":[${Array.from({ length: 100_000 }, () => element).join(',')}]}`
      const scanner = new LibraryScanner()
      const started = Date.now()
      let count = 0
      const size = 4 * 1024 * 1024
      for (let at = 0; at < big.length; at += size) count += scanner.push(big.slice(at, at + size)).length
      scanner.finish()
      const elapsed = Date.now() - started
      assert(count === 100_000 && elapsed < 3000, `${(big.length / 1024 / 1024).toFixed(0)} Mo lus en ${elapsed} ms, par morceaux de quatre mégaoctets`)
    }

    console.log('\nl’aller-retour est fidèle')
    const b = library()
    const preview = await previewLibraryFile(b, fileA)
    assert(preview.posts.fresh === 1304 && preview.posts.existing === 0 && preview.posts.invalid === 0, `l’aperçu annonce 1304 nouveaux posts (${JSON.stringify(preview.posts)})`)
    assert(preview.collections.fresh === 3 && preview.mapLabels === 1, 'et trois collections, une étiquette')
    const first = collect()
    const imported = await importLibraryFile(b, fileA, { journal: first.journal, chunkBytes: 4096 })
    const report = summarise(imported.journal, { at: 0, fileName: 'a.json', stopped: imported.stopped })
    assert(report.postsAdded === 1304 && report.collectionsCreated === 3 && report.mapLabels === 1, 'tout entre dans une bibliothèque vide')
    const fileB = join(dir, 'b.json')
    await writeLibraryFile(b, fileB, options)
    assert(
      JSON.stringify(withoutDate(read(fileB))) === JSON.stringify(withoutDate(textA)),
      'réexportée, elle redonne le même fichier à la date près'
    )
    assert(
      (b.prepare("SELECT COUNT(*) FROM posts WHERE tag_status = 'rules_only'").pluck().get() as number) === 1304,
      'les posts importés ne repassent pas par les règles : un tag retiré ne ressuscitera pas'
    )
    assert(
      (b.prepare('SELECT COUNT(*) FROM media WHERE thumb_path IS NOT NULL').pluck().get() as number) === 0,
      'aucune vignette locale n’est inventée : la file les construira'
    )
    assert(
      (b.prepare("SELECT is_demo FROM posts WHERE id = 'instagram:333'").pluck().get() as number) === 1,
      'la démonstration reste retirable d’un geste'
    )
    assert(
      (b.prepare("SELECT COUNT(*) FROM collection_keywords WHERE vector_text IS NULL").pluck().get() as number) === 2,
      'les mots-clés arrivent sans vecteur : ils se recalculent chez celui qui importe'
    )

    console.log('\nréimporter ne change rien')
    {
      const before = dump(b)
      const again = await previewLibraryFile(b, fileA)
      assert(again.posts.existing === 1304 && again.posts.fresh === 0, 'l’aperçu reconnaît chaque post')
      const second = await importLibraryFile(b, fileA, {})
      const secondReport = summarise(second.journal, { at: 0, fileName: 'a.json', stopped: false })
      assert(dump(b) === before, 'la base est identique, ligne pour ligne')
      assert(
        secondReport.postsAdded + secondReport.postsMerged + secondReport.collectionsCreated + secondReport.memberships === 0 &&
          secondReport.postsUnchanged === 1304,
        'et le compte rendu le dit'
      )
    }
    {
      const copy = new Database(a.serialize())
      registerFunctions(copy)
      copy.pragma('foreign_keys = ON')
      const before = dump(copy)
      await importLibraryFile(copy, fileA, {})
      assert(dump(copy) === before, 'importé dans une copie de la bibliothèque d’origine, il ne change rien non plus')
    }

    console.log('\nla fusion ne détruit rien')
    {
      const c = library()
      seed(c, [
        {
          platform: 'instagram',
          native: '111',
          text: 'Ma version locale, plus fraîche',
          tags: [['CHATS', 'user']],
          sources: ['saved']
        },
        { platform: 'x', native: '222', kind: 'text', label: 'green', transcript: null }
      ])
      c.prepare("INSERT INTO collections (name, kind) VALUES ('manuelle', 'manual')").run()
      c.prepare("INSERT INTO collections (name, kind, query) VALUES ('cuisine', 'query', 'locale')").run()
      const before = dump(c)
      const merge = collect()
      const result = await importLibraryFile(c, fileA, { journal: merge.journal })
      const row = c.prepare("SELECT * FROM posts WHERE id = 'instagram:111'").get() as Record<string, unknown>
      const tags = c
        .prepare("SELECT t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = 'instagram:111' ORDER BY t.name")
        .pluck()
        .all() as string[]
      assert(row.text === 'Ma version locale, plus fraîche', 'la légende locale reste : la synchronisation est plus fraîche qu’un export')
      assert(row.is_favorite === 1 && row.label === 'red' && row.transcript === 'bonjour à tous', 'favori, étiquette et transcription manquants sont comblés')
      assert(JSON.stringify(tags) === JSON.stringify(['CHATS', 'Voyage', 'été']), `les tags s’unissent, casse locale gardée (${tags.join(', ')})`)
      assert(
        (c.prepare("SELECT COUNT(*) FROM post_sources WHERE post_id = 'instagram:111'").pluck().get() as number) === 2,
        'l’origine « like » s’ajoute au signet'
      )
      const x222 = c.prepare("SELECT label, is_archived, transcript FROM posts WHERE id = 'x:222'").get() as Record<string, unknown>
      assert(x222.label === 'green' && x222.is_archived === 0, 'une étiquette et un état de retrait déjà posés restent tels quels')
      assert(x222.transcript === null, 'une transcription vide dans le fichier ne comble rien')
      const manuelle = c.prepare("SELECT id, name, color FROM collections WHERE name = 'manuelle'").get() as Record<string, unknown>
      const members = c.prepare('SELECT post_id FROM collection_posts WHERE collection_id = ? ORDER BY post_id').pluck().all(manuelle.id) as string[]
      assert(manuelle.color === 'blue' && JSON.stringify(members) === JSON.stringify(['instagram:111', 'x:222']), 'la liste homonyme — à la casse près — reçoit les membres et la couleur qui lui manquaient')
      assert(
        (c.prepare("SELECT COUNT(*) FROM collection_posts cp JOIN collections c ON c.id = cp.collection_id WHERE c.name = 'cuisine'").pluck().get() as number) === 0 &&
          (c.prepare("SELECT query FROM collections WHERE name = 'cuisine'").pluck().get() as string) === 'locale',
        'une collection à mots-clés homonyme garde sa définition, et rien n’y est épinglé'
      )
      assert(
        (c.prepare('SELECT COUNT(*) FROM collections').pluck().get() as number) === 3,
        'seule « Vide » est créée'
      )
      const mergeReport = summarise(result.journal, { at: 0, fileName: 'a.json', stopped: false })
      assert(mergeReport.postsAdded === 1302 && mergeReport.postsMerged === 2 && mergeReport.postsUnchanged === 0, `le compte rendu compte juste (${mergeReport.postsAdded} ajoutés, ${mergeReport.postsMerged} enrichis)`)

      const undone = await undoImport(c, merge.entries)
      assert(undone.postsRemoved === 1302 && undone.collectionsRemoved === 1, 'l’annulation retire ce que l’import a ajouté')
      assert(dump(c) === before, 'et rend la bibliothèque d’avant, ligne pour ligne')
    }

    console.log('\nun arrêt laisse une bibliothèque cohérente, et annulable')
    {
      const d = library()
      const stop = collect()
      let batches = 0
      const halted = await importLibraryFile(d, fileA, {
        journal: (entry) => {
          stop.journal(entry)
          batches += 1
        },
        shouldStop: () => batches >= 2,
        chunkBytes: 8192
      })
      const count = d.prepare('SELECT COUNT(*) FROM posts').pluck().get() as number
      assert(halted.stopped && count > 0 && count < 1304, `arrêté en route : ${count} posts entrés, par paquets entiers`)
      assert((d.prepare('SELECT COUNT(*) FROM collections').pluck().get() as number) === 0, 'les collections, qui viennent après, ne sont pas créées')
      await undoImport(d, stop.entries)
      assert(dump(d) === dump(library()), 'l’annulation rend la base vide')
    }

    console.log('\nle fichier est une entrée non fiable')
    {
      const hostile = {
        format: 'magpie-library',
        version: 1,
        posts: [
          { ...parsedA.posts[4], platform: 'myspace' },
          { ...parsedA.posts[5], id: 'instagram:autre-chose' },
          { ...parsedA.posts[6], url: 'javascript:alert(1)' },
          { ...parsedA.posts[7], kind: 'hologramme' },
          { ...parsedA.posts[8], nativeId: 'avec espace', id: undefined },
          parsedA.posts[9],
          parsedA.posts[9],
          {
            ...parsedA.posts[10],
            text: 'x'.repeat(250_000),
            author: { handle: '@h', name: 'N', avatar: 'data:image/png;base64,AAAA' },
            media: [{ index: 0, kind: 'image', url: 'file:///etc/passwd', videoUrl: 'javascript:1', variants: [{ quality: '8k', url: 'https://a.b/c' }] }],
            tags: [
              { name: '#Chats', source: 'user' },
              { name: '  chats ', source: 'rule' },
              { name: 'CHATS', source: 'ai' },
              { name: '#', source: 'user' }
            ],
            label: 'fuchsia',
            publishedAt: '1492-10-12T00:00:00.000Z'
          }
        ]
      }
      const path = join(dir, 'hostile.json')
      writeFileSync(path, JSON.stringify(hostile))
      const e = library()
      const seen = await previewLibraryFile(e, path)
      assert(seen.posts.total === 2 && seen.posts.invalid === 6, `plateforme, identifiant, adresse, type et doublon écartés (${JSON.stringify(seen.posts)})`)
      await importLibraryFile(e, path, {})
      const kept = e.prepare('SELECT * FROM posts WHERE id = ?').get(parsedA.posts[10].id) as Record<string, unknown>
      const media = e.prepare('SELECT remote_url, video_source FROM media WHERE post_id = ?').get(parsedA.posts[10].id) as Record<string, unknown>
      const tags = e.prepare('SELECT t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = ?').pluck().all(parsedA.posts[10].id) as string[]
      assert((kept.text as string).length === 100_000, 'une légende démesurée est bornée')
      assert(kept.author_avatar === null && media.remote_url === null && media.video_source === null, 'data:, file: et javascript: ne deviennent jamais des adresses')
      assert((e.prepare('SELECT COUNT(*) FROM media_variants').pluck().get() as number) === 0, 'une qualité inconnue est ignorée')
      assert(JSON.stringify(tags) === JSON.stringify(['Chats']), `« #Chats », « chats » et « CHATS » ne font qu’un tag (${tags.join(', ')})`)
      assert(kept.label === null && kept.published_at === null, 'une couleur ou une date inventées sont ignorées')

      const cases: [string, string, string][] = [
        ['un autre format', JSON.stringify({ format: 'autre', version: 1, posts: [] }), 'notMagpie'],
        ['une version future', JSON.stringify({ format: 'magpie-library', version: 2, posts: [] }), 'newerVersion'],
        ['un tableau', '[]', 'notMagpie'],
        ['du texte', 'bonjour', 'notMagpie'],
        ['sans posts', JSON.stringify({ format: 'magpie-library', version: 1 }), 'notMagpie'],
        ['tronqué', textA.slice(0, Math.floor(textA.length / 2)), 'invalidJson'],
        ['suivi de déchets', `${textA}{}`, 'invalidJson'],
        ['un post illisible', textA.replace('{"id":"instagram:111"', '{"id":"instagram:111",,'), 'invalidJson']
      ]
      for (const [name, text, expected] of cases) {
        const file = join(dir, 'cas.json')
        writeFileSync(file, text)
        const got = await problem(() => previewLibraryFile(library(), file))
        assert(got === expected, `${name} : ${expected}${got === expected ? '' : ` (obtenu : ${got})`}`)
      }
      const f = library()
      const file = join(dir, 'cas.json')
      writeFileSync(file, textA.slice(0, Math.floor(textA.length / 2)))
      const got = await problem(() => importLibraryFile(f, file, {}))
      assert(got === 'invalidJson', 'un import tronqué s’arrête sur l’erreur…')
      assert((f.prepare('SELECT COUNT(*) FROM collections').pluck().get() as number) === 0, '… sans créer les collections d’un fichier incomplet')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} manquement(s).`)
  process.exitCode = failures === 0 ? 0 : 1
}

void main()
