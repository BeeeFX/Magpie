import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir, getDb } from './db'
import type { ExportSummary } from '@shared/types'

/**
 * Exporte la bibliothèque en un dossier qu'un assistant peut lire lui-même.
 *
 * Magpie n'appelle aucun modèle, n'embarque aucun CLI et ne parle à aucun service : il écrit
 * des fichiers, l'utilisateur les donne à l'assistant de son choix, et la conversation a lieu
 * là-bas. Aucune clé, aucun compte, rien à installer.
 *
 * Ce n'est pas la bibliothèque brute mais la connaissance distillée par les étapes
 * précédentes — transcriptions, légendes, auteurs, tags, collections. La contrainte qui
 * dicte la forme : neuf mille posts transcrits pèsent plus d'un million de mots, donc le
 * dossier doit être **navigable sans être lu en entier**. L'assistant lit `PROMPT.md`,
 * parcourt `index.md`, puis n'ouvre que les fiches nécessaires.
 *
 * Cette étape ne dépend d'aucune autre : elle fonctionne sur une bibliothèque sans une seule
 * collection ni transcription.
 */

/** Assez pour situer un post dans l'index, trop court pour le remplacer. */
const SUMMARY_CHARS = 120
/**
 * Posts par tranche d'index.
 *
 * Mesuré sur la bibliothèque de référence : un index d'un seul tenant pour 9 738 posts pèse
 * 2,1 Mo, soit un demi-million de jetons. Aucun assistant ne le lit « en entier », et le
 * prétendre dans le prompt aurait été un mensonge coûteux. Découpé, chaque tranche tient
 * confortablement dans une lecture.
 */
const INDEX_CHUNK = 1200

export function exportDir(): string {
  return join(dataDir(), 'export')
}

interface Row {
  id: string
  platform: string
  kind: string
  url: string
  author: string | null
  text: string | null
  transcript: string | null
  publishedAt: number | null
  savedAt: number | null
  sources: string | null
  tags: string | null
  collections: string | null
}

function slug(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .toLowerCase() || 'sans-nom'
  )
}

function oneLine(value: string, limit = SUMMARY_CHARS): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

function date(ms: number | null): string {
  return ms ? new Date(ms).toISOString().slice(0, 10) : ''
}

function readRows(): Row[] {
  return getDb()
    .prepare(
      `SELECT p.id, p.platform, p.kind, p.url, p.author_handle AS author, p.text,
              p.transcript, p.published_at AS publishedAt, p.saved_at AS savedAt,
              (SELECT GROUP_CONCAT(ps.source) FROM post_sources ps WHERE ps.post_id = p.id) AS sources,
              (SELECT GROUP_CONCAT(DISTINCT t.name) FROM post_tags pt
                 JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id) AS tags,
              (SELECT GROUP_CONCAT(c.name, ' | ') FROM collection_posts cp
                 JOIN collections c ON c.id = cp.collection_id WHERE cp.post_id = p.id) AS collections
         FROM posts p
        WHERE p.is_archived = 0
        ORDER BY COALESCE(p.saved_at, p.discovered_at) DESC`
    )
    .all() as Row[]
}

/** Le prompt système, en clair et modifiable : c'est l'utilisateur qui converse. */
/**
 * Les instructions que l'assistant lit en premier.
 *
 * `root` est indispensable, et son absence était un vrai défaut : le texte disait « ce
 * dossier » sans jamais donner son chemin. Un assistant à qui l'on colle ces instructions —
 * ce qui est l'usage même du bouton « Copier les instructions » — n'avait alors aucun moyen
 * de savoir *où* chercher sur le disque, et ne pouvait que demander le chemin ou inventer.
 */
export function systemPrompt(language: 'fr' | 'en', root?: string): string {
  const where = root
    ? language === 'fr'
      ? `

Le dossier se trouve à cet emplacement, sur cet ordinateur :

    ${root}

Tous les chemins ci-dessous sont relatifs à ce dossier.`
      : `

The folder is at this location on this computer:

    ${root}

Every path below is relative to that folder.`
    : ''
  if (language === 'fr') {
    return `Tu réponds à des questions sur une bibliothèque de posts sauvegardés depuis
Instagram et X, exportée par Magpie dans ce dossier.${where}

Structure du dossier :
- \`index.md\` — le sommaire : combien de posts, et en combien de tranches.
- \`index/000.md\`, \`001.md\`… — une ligne par post : identifiant, auteur, date, plateforme,
  origine (signet ou like), collection, tags, lien, et un résumé court. Les posts sont rangés
  du plus récemment sauvegardé au plus ancien.
- \`collections/\` — un fichier par collection, listant ses posts.
- \`fiches/\` — un fichier par post, avec la légende complète et, quand elle existe, la
  transcription de l'audio.

Comment chercher : si tu peux fouiller le dossier par motif de texte, fais-le d'abord, c'est
de loin le plus rapide. Sinon, lis \`index.md\` puis les tranches d'index qui te concernent —
elles sont découpées pour tenir à la lecture, mais l'index complet représente plusieurs
centaines de milliers de mots, ne le charge pas d'un bloc. N'ouvre une fiche que lorsque tu as
besoin du texte complet ou de la transcription, jamais « pour voir ».

Comment répondre : cite les posts par leur identifiant et leur lien, pour qu'ils puissent
être retrouvés. Distingue les signets des likes quand la question s'y prête. Si l'information
n'est pas dans le dossier, dis-le plutôt que de la deviner — une transcription absente
signifie que la vidéo n'a pas encore été transcrite, pas qu'elle est muette.`
  }
  return `You answer questions about a library of posts saved from Instagram and X,
exported by Magpie into this folder.${where}

Folder structure:
- \`index.md\` — the table of contents: how many posts, in how many chunks.
- \`index/000.md\`, \`001.md\`… — one line per post: id, author, date, platform, origin (saved
  or liked), collection, tags, link, and a short summary. Most recently saved first.
- \`collections/\` — one file per collection, listing its posts.
- \`fiches/\` — one file per post, with the full caption and, when available, the audio
  transcript.

How to search: if you can grep the folder, do that first — it is by far the fastest. Otherwise
read \`index.md\` then only the index chunks you need. They are split to stay readable, but the
full index runs to several hundred thousand words; do not load it in one go. Only open a post
file when you need the complete text or the transcript, never just to look.

How to answer: cite posts by id and link so they can be found again. Distinguish saved posts
from likes when the question calls for it. If the answer is not in the folder, say so rather
than guessing — a missing transcript means the video has not been transcribed yet, not that
it is silent.`
}

/**
 * Écrit le dossier. Incrémental : une fiche dont le post n'a pas changé n'est pas réécrite,
 * ce qui rend un réexport quasi gratuit sur une grande bibliothèque.
 */
export async function exportLibrary(language: 'fr' | 'en'): Promise<ExportSummary> {
  const root = exportDir()
  const sheets = join(root, 'fiches')
  const indexDir = join(root, 'index')
  const collectionsDir = join(root, 'collections')
  await mkdir(sheets, { recursive: true })
  await mkdir(collectionsDir, { recursive: true })

  const rows = readRows()
  const byCollection = new Map<string, Row[]>()
  const header = [
    language === 'fr'
      ? '| id | auteur | date | source | origine | collection | tags | lien | résumé |'
      : '| id | author | date | source | origin | collection | tags | link | summary |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ]
  const entries: string[] = []

  const wanted = new Set<string>()
  let written = 0
  let transcripts = 0

  for (const row of rows) {
    const name = `${slug(row.id)}.md`
    wanted.add(name)
    const collections = row.collections?.split(' | ').filter(Boolean) ?? []
    for (const collection of collections) {
      const list = byCollection.get(collection) ?? []
      list.push(row)
      byCollection.set(collection, list)
    }
    if (row.transcript) transcripts += 1

    const summary = oneLine(row.transcript || row.text || '')
    entries.push(
      `| ${row.id} | ${row.author ?? ''} | ${date(row.publishedAt ?? row.savedAt)} | ` +
        `${row.platform} | ${row.sources ?? ''} | ${collections.join(', ')} | ` +
        `${(row.tags ?? '').split(',').filter(Boolean).join(' ')} | ${row.url} | ` +
        `${summary.replace(/\|/g, '/')} |`
    )

    const sheet = [
      '---',
      `id: ${row.id}`,
      `plateforme: ${row.platform}`,
      `type: ${row.kind}`,
      `auteur: ${row.author ?? ''}`,
      `origine: ${row.sources ?? ''}`,
      `date: ${date(row.publishedAt ?? row.savedAt)}`,
      `lien: ${row.url}`,
      `collections: ${collections.join(', ')}`,
      `tags: ${(row.tags ?? '').split(',').filter(Boolean).join(', ')}`,
      '---',
      '',
      `## ${language === 'fr' ? 'Légende' : 'Caption'}`,
      row.text?.trim() || (language === 'fr' ? '(vide)' : '(empty)'),
      '',
      `## ${language === 'fr' ? 'Transcription' : 'Transcript'}`,
      row.transcript?.trim() ||
        (language === 'fr' ? '(pas encore transcrit)' : '(not transcribed yet)'),
      ''
    ].join('\n')

    const target = join(sheets, name)
    // Réécrire neuf mille fiches identiques à chaque export coûterait cher pour rien : on ne
    // touche que celles dont le contenu a réellement changé.
    const existing = await stat(target).catch(() => null)
    if (!existing || existing.size !== Buffer.byteLength(sheet)) {
      await writeFile(target, sheet, 'utf8')
      written += 1
    }
  }

  // Index découpé en tranches lisibles, plus un sommaire qui dit où chercher.
  await mkdir(indexDir, { recursive: true })
  const chunks: string[] = []
  for (let start = 0; start < entries.length; start += INDEX_CHUNK) {
    const slice = entries.slice(start, start + INDEX_CHUNK)
    const name = `${String(chunks.length).padStart(3, '0')}.md`
    chunks.push(name)
    await writeFile(join(indexDir, name), `${[...header, ...slice].join('\n')}\n`, 'utf8')
  }
  for (const entry of await readdir(indexDir)) {
    if (!chunks.includes(entry)) await rm(join(indexDir, entry), { force: true })
  }

  for (const [collection, members] of byCollection) {
    const body = [
      `# ${collection}`,
      '',
      ...members.map((row) => `- ${row.id} — ${row.author ?? ''} — ${row.url}`),
      ''
    ].join('\n')
    await writeFile(join(collectionsDir, `${slug(collection)}.md`), body, 'utf8')
  }

  const toc = [
    language === 'fr' ? '# Sommaire' : '# Table of contents',
    '',
    language === 'fr'
      ? `${rows.length} posts, du plus récemment sauvegardé au plus ancien, en ${chunks.length} tranches :`
      : `${rows.length} posts, most recently saved first, in ${chunks.length} chunks:`,
    '',
    ...chunks.map(
      (name, position) =>
        `- \`index/${name}\` — ${position * INDEX_CHUNK + 1}–${Math.min(rows.length, (position + 1) * INDEX_CHUNK)}`
    ),
    ''
  ].join('\n')
  await writeFile(join(root, 'index.md'), toc, 'utf8')
  await writeFile(join(root, 'PROMPT.md'), `${systemPrompt(language)}\n`, 'utf8')

  // Une fiche dont le post a disparu de la bibliothèque n'a plus rien à faire là : la laisser
  // ferait répondre l'assistant sur du contenu que l'utilisateur a supprimé.
  for (const entry of await readdir(sheets)) {
    if (!wanted.has(entry)) await rm(join(sheets, entry), { force: true })
  }

  let bytes = 0
  for (const directory of [root, sheets, collectionsDir, indexDir]) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const info = await stat(join(directory, entry.name)).catch(() => null)
      bytes += info?.size ?? 0
    }
  }

  return {
    path: root,
    posts: rows.length,
    collections: byCollection.size,
    transcripts,
    written,
    bytes,
    at: Date.now()
  }
}
