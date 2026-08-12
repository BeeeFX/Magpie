import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Platform, PostKind } from '@shared/types'
import { countPosts, setTags, upsertPosts, type MediaInput, type PostInput } from '../db/queries'
import { normalizeSavedFeed, type IgSavedResponse } from '../adapters/instagram/normalize'
import instagramFixture from './instagram-saved.json'
import otherFixture from './other-platforms.json'

interface OtherPost {
  platform: Platform
  id: string
  url: string
  authorHandle: string | null
  authorName: string | null
  subreddit?: string
  text: string
  kind: PostKind
  image: string | null
  publishedAt: number
  savedAt: number
}

/** Racine des images de fixture — en dev, `app.getAppPath()` est la racine du projet. */
function fixtureMediaDir(): string {
  return join(app.getAppPath(), 'fixtures', 'media')
}

/**
 * Remplace le schéma `fixture://` par un chemin absolu sur disque. C'est le seul endroit
 * où la fixture diffère du flux réel : en M1 le média sera téléchargé depuis `remoteUrl`
 * au lieu d'être lu localement, le reste du pipeline est identique.
 */
function resolveFixtureMedia(media: MediaInput[]): MediaInput[] {
  const dir = fixtureMediaDir()
  const local = (url: string | null | undefined): string | null => {
    if (!url?.startsWith('fixture://')) return null
    const path = join(dir, url.slice('fixture://'.length))
    return existsSync(path) ? path : null
  }

  return media.map((m) => ({
    ...m,
    sourcePath: local(m.remoteUrl) ?? m.sourcePath ?? null,
    videoSource: local(m.videoSource) ?? m.videoSource ?? null
  }))
}

/** Tags dérivés sans modèle : hashtags, auteur, subreddit. C'est l'étage gratuit de §8.1. */
function ruleTags(post: PostInput, subreddit?: string): { name: string; source: 'rule' }[] {
  const tags = new Set<string>()

  for (const match of (post.text ?? '').matchAll(/#(\p{L}[\p{L}\p{N}_]{1,29})/gu)) {
    tags.add(match[1].toLowerCase())
  }
  if (subreddit) tags.add(subreddit.toLowerCase())

  return [...tags].map((name) => ({ name, source: 'rule' as const }))
}

function seedInstagram(): void {
  const { posts, media } = normalizeSavedFeed(instagramFixture as IgSavedResponse)
  for (const post of posts) post.isDemo = true
  upsertPosts(posts, resolveFixtureMedia(media))
  for (const post of posts) {
    const tags = ruleTags(post)
    if (tags.length > 0) setTags(post.id, tags)
  }
}

function seedOthers(): void {
  const dir = fixtureMediaDir()
  const source = otherFixture as { posts: OtherPost[] }
  const posts: PostInput[] = []
  const media: MediaInput[] = []

  source.posts.forEach((p, rank) => {
    const id = `${p.platform}:${p.id}`
    posts.push({
      id,
      platform: p.platform,
      nativeId: p.id,
      url: p.url,
      authorHandle: p.authorHandle,
      authorName: p.authorName,
      text: p.text,
      kind: p.kind,
      mediaCount: p.image ? 1 : 0,
      publishedAt: p.publishedAt,
      savedAt: p.savedAt,
      savedRank: rank,
      raw: p,
      isDemo: true
    })

    if (p.image) {
      const path = join(dir, p.image)
      media.push({
        postId: id,
        idx: 0,
        kind: 'image',
        remoteUrl: `fixture://${p.image}`,
        sourcePath: existsSync(path) ? path : null
      })
    }
  })

  upsertPosts(posts, media)
  source.posts.forEach((p) => {
    const tags = ruleTags(
      { text: p.text } as PostInput,
      p.platform === 'reddit' ? p.subreddit : undefined
    )
    if (tags.length > 0) setTags(`${p.platform}:${p.id}`, tags)
  })
}

/**
 * Charge la fixture de démonstration si la base est vide.
 *
 * Le seeding est court-circuité dès qu'un compte réel est connecté : passé ce point,
 * mêler des données inventées aux vrais signets ne rendrait plus service à personne.
 */
export function seedIfEmpty(hasRealAccount = false): { seeded: boolean; count: number } {
  if (hasRealAccount || countPosts() > 0) return { seeded: false, count: countPosts() }

  if (!existsSync(fixtureMediaDir())) {
    console.warn(
      `[magpie] Images de fixture absentes (${fixtureMediaDir()}). Lancez \`npm run fixture\`.`
    )
  }

  seedInstagram()
  seedOthers()
  return { seeded: true, count: countPosts() }
}
