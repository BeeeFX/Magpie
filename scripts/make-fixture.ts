/**
 * Génère la fixture de développement : `npm run fixture`
 *
 * Produit deux choses :
 *   - `src/main/fixtures/*.json` — des réponses figées qui imitent la forme réelle des API
 *   - `fixtures/media/*.jpg`     — de vraies images qui tiennent lieu de CDN
 *
 * Les images viennent de picsum.photos quand le réseau répond, sinon d'un dégradé généré
 * localement. Dans les deux cas les ratios d'aspect sont ceux d'Instagram, parce que c'est
 * ce que le masonry doit encaisser.
 *
 * Déterministe : même graine, même fixture. Rejouer le script ne fait pas bouger l'UI.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'
import sharp from 'sharp'

const run = promisify(execFile)

// `npm run fixture` s'exécute toujours depuis la racine du projet.
const ROOT = resolve(process.cwd())
const MEDIA_DIR = join(ROOT, 'fixtures', 'media')
const FIXTURE_DIR = join(ROOT, 'src', 'main', 'fixtures')

const SOURCE_WIDTH = 720 // le cache redescend à 640, inutile de télécharger plus gros

/* ----------------------------------------------------------------- aléatoire */

let seed = 20260810
function random(): number {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
const chance = (p: number): boolean => random() < p
const between = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1))

/* ------------------------------------------------------------------ contenus */

const THEMES = [
  {
    tag: 'architecture',
    words: ['béton brut', 'lumière rasante', 'brutalisme', 'atrium', 'coursive', 'contre-jour'],
    hashtags: ['architecture', 'brutalism', 'concrete', 'archdaily']
  },
  {
    tag: 'typographie',
    words: ['grotesque', 'empattements', 'chasse étroite', 'affiche suisse', 'interlettrage'],
    hashtags: ['typography', 'typedesign', 'graphicdesign', 'poster']
  },
  {
    tag: '3d',
    words: ['rendu volumétrique', 'subsurface', 'houdini', 'displacement', 'octane'],
    hashtags: ['3d', 'cgi', 'houdini', 'blender', 'render']
  },
  {
    tag: 'étalonnage',
    words: ['teintes froides', 'halation', 'courbe filmique', 'split toning', 'grain argentique'],
    hashtags: ['colorgrading', 'colorist', 'davinciresolve', 'filmlook']
  },
  {
    tag: 'photographie',
    words: ['heure bleue', 'longue pose', 'argentique', 'flash direct', 'profondeur de champ'],
    hashtags: ['photography', 'filmphotography', '35mm', 'portrait']
  },
  {
    tag: 'motion',
    words: ['transition fluide', 'easing', 'habillage', 'générique', 'kinétique'],
    hashtags: ['motiondesign', 'aftereffects', 'animation', 'titlesequence']
  },
  {
    tag: 'intérieur',
    words: ['bois clair', 'lumière indirecte', 'mobilier chiné', 'plâtre', 'travertin'],
    hashtags: ['interiordesign', 'interiors', 'minimal', 'furniture']
  },
  {
    tag: 'cinéma',
    words: ['plan-séquence', 'anamorphique', 'clair-obscur', 'cadre serré', 'steadicam'],
    hashtags: ['cinematography', 'filmmaking', 'anamorphic', 'cinematic']
  }
] as const

const IG_AUTHORS = [
  ['archive.of.forms', 'Archive of Forms'],
  ['beton.journal', 'Béton Journal'],
  ['typo.daily', 'Typo Daily'],
  ['studio.nord', 'Studio Nord'],
  ['grain.et.lumiere', 'Grain & Lumière'],
  ['renders.club', 'Renders Club'],
  ['maison.brute', 'Maison Brute'],
  ['color.notes', 'Color Notes'],
  ['plan.large', 'Plan Large'],
  ['atelier.mono', 'Atelier Mono']
] as const

const X_AUTHORS = [
  ['gradingnerd', 'Grading Nerd'],
  ['smallstudio', 'small studio'],
  ['typefacing', 'typefacing'],
  ['houdinidaily', 'Houdini Daily'],
  ['framegrabs', 'frame grabs']
] as const

const SUBREDDITS = [
  'Cinematography',
  'colorists',
  'typography',
  'brutalism',
  'blender',
  'AnalogCommunity',
  'design'
] as const

function caption(theme: (typeof THEMES)[number]): string {
  const bits = [pick(theme.words), pick(theme.words)]
  const lead = pick([
    `Référence ${bits[0]}`,
    `À garder pour plus tard — ${bits[0]}`,
    `${bits[0]}, ${bits[1]}`,
    `Étude de ${bits[0]}`,
    `Ce ${bits[0]} est exactement la direction`
  ])
  const tags = [...theme.hashtags]
    .sort(() => random() - 0.5)
    .slice(0, between(2, 4))
    .map((t) => `#${t}`)
    .join(' ')
  return `${lead}. ${tags}`
}

function shortcode(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from({ length: 11 }, () => alphabet[Math.floor(random() * alphabet.length)]).join('')
}

/* -------------------------------------------------------------------- images */

/** Ratios réels d'Instagram : carré, portrait 4:5, paysage 1.91:1, reel 9:16. */
const IG_RATIOS = [
  { w: 1, h: 1, weight: 30 },
  { w: 4, h: 5, weight: 45 },
  { w: 1.91, h: 1, weight: 15 },
  { w: 9, h: 16, weight: 10 }
]

function pickRatio(): number {
  const total = IG_RATIOS.reduce((s, r) => s + r.weight, 0)
  let n = random() * total
  for (const r of IG_RATIOS) {
    n -= r.weight
    if (n <= 0) return r.h / r.w
  }
  return 1
}

let downloaded = 0
let generated = 0

async function makeImage(name: string, ratio: number, hue: number): Promise<[number, number]> {
  const width = SOURCE_WIDTH
  const height = Math.round(SOURCE_WIDTH * ratio)
  const file = join(MEDIA_DIR, name)

  if (existsSync(file)) return [width, height]

  try {
    const res = await fetch(`https://picsum.photos/seed/${name}/${width}/${height}`, {
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await sharp(buf).jpeg({ quality: 82 }).toFile(file)
    downloaded++
    return [width, height]
  } catch {
    // Hors-ligne : un dégradé bicolore. Moins joli qu'une vraie photo, mais il prouve
    // exactement ce que M0 doit prouver — que la grille encaisse des ratios variés.
    const a = `hsl(${hue}, 55%, 22%)`
    const b = `hsl(${(hue + 45) % 360}, 60%, 58%)`
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${a}"/><stop offset="100%" stop-color="${b}"/>
      </linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
    </svg>`
    await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toFile(file)
    generated++
    return [width, height]
  }
}

/**
 * Fabrique un clip lisible à partir d'une image fixe : un lent panoramique vertical, muet,
 * 4 secondes, en H.264. Il ne s'agit pas de simuler un reel mais de disposer de vrais
 * fichiers vidéo pour éprouver la lecture au survol — jusqu'ici la fixture n'avait que
 * des URLs factices, donc rien à lire.
 */
async function makeVideo(name: string, posterName: string): Promise<boolean> {
  const target = join(MEDIA_DIR, name)
  if (existsSync(target) && statSync(target).size > 0) return true
  if (!ffmpegPath) return false

  try {
    await run(ffmpegPath, [
      '-y',
      '-loop', '1',
      '-i', join(MEDIA_DIR, posterName),
      '-t', '4',
      '-r', '24',
      // `force_original_aspect_ratio=increase` garantit une image au moins aussi grande
      // que la fenêtre de recadrage, quel que soit le format de l'affiche : sans ça, une
      // source plus large que haute fait échouer le crop.
      '-vf',
      "scale=810:1440:force_original_aspect_ratio=increase," +
        "crop=720:1280:(iw-ow)/2:'(ih-oh)*t/4',format=yuv420p",
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '30',
      '-movflags', '+faststart',
      '-an',
      target
    ])
    return true
  } catch (err) {
    // ffmpeg crée le fichier de sortie avant d'échouer : sans ce nettoyage, la relance
    // verrait un fichier « existant » de zéro octet et ne retenterait jamais.
    if (existsSync(target)) rmSync(target, { force: true })
    throw err
  }
}

/** Petit pool de concurrence — 135 requêtes séquentielles seraient inutilement lentes. */
async function pooled<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      await fn(item)
    }
  })
  await Promise.all(workers)
}

/* ------------------------------------------------------------------ Instagram */

interface PendingImage {
  name: string
  ratio: number
  hue: number
}

interface PendingVideo {
  name: string
  poster: string
}

function buildInstagram(count: number): {
  payload: unknown
  images: PendingImage[]
  videos: PendingVideo[]
} {
  const images: PendingImage[] = []
  const videos: PendingVideo[] = []
  const items: unknown[] = []
  const now = Math.floor(Date.now() / 1000)

  for (let i = 0; i < count; i++) {
    const theme = pick(THEMES)
    const [username, fullName] = pick(IG_AUTHORS)
    const hue = between(0, 359)
    const isReel = chance(0.2)
    const isCarousel = !isReel && chance(0.3)
    const mediaType = isReel ? 2 : isCarousel ? 8 : 1
    const pk = `${3510000000000000000n + BigInt(i * 7919)}`
    const takenAt = now - between(3600, 3600 * 24 * 400)

    const makeCandidate = (name: string, ratio: number) => {
      images.push({ name, ratio, hue })
      return {
        // Une vraie réponse porte une URL CDN signée. En fixture, c'est un chemin local
        // relatif à `fixtures/media` — le normalizer traite les deux de la même façon.
        url: `fixture://${name}`,
        width: SOURCE_WIDTH,
        height: Math.round(SOURCE_WIDTH * ratio)
      }
    }

    let media: Record<string, unknown>

    if (isCarousel) {
      const n = between(2, 5)
      const carousel = Array.from({ length: n }, (_, k) => {
        const ratio = k === 0 ? pickRatio() : pickRatio()
        return {
          pk: `${pk}_${k}`,
          media_type: 1,
          image_versions2: { candidates: [makeCandidate(`ig_${i}_${k}.jpg`, ratio)] }
        }
      })
      media = { carousel_media: carousel, carousel_media_count: n }
    } else if (isReel) {
      const ratio = 16 / 9
      videos.push({ name: `ig_${i}.mp4`, poster: `ig_${i}_0.jpg` })
      media = {
        image_versions2: { candidates: [makeCandidate(`ig_${i}_0.jpg`, ratio)] },
        video_versions: [{ url: `fixture://ig_${i}.mp4`, width: 720, height: 1280 }],
        video_duration: 4
      }
    } else {
      const ratio = pickRatio()
      media = { image_versions2: { candidates: [makeCandidate(`ig_${i}_0.jpg`, ratio)] } }
    }

    items.push({
      media: {
        pk,
        id: `${pk}_${between(100000, 999999)}`,
        code: shortcode(),
        media_type: mediaType,
        taken_at: takenAt,
        caption: { text: caption(theme) },
        user: {
          pk: `${between(1000000, 9999999)}`,
          username,
          full_name: fullName
        },
        like_count: between(40, 90000),
        comment_count: between(0, 900),
        ...media
      }
    })
  }

  return {
    payload: { items, more_available: false, next_max_id: null, status: 'ok' },
    images,
    videos
  }
}

/* ------------------------------------------------------------------- X/Reddit */

function buildOthers(): { payload: unknown; images: PendingImage[] } {
  const images: PendingImage[] = []
  const posts: unknown[] = []
  const now = Date.now()

  for (let i = 0; i < 26; i++) {
    const theme = pick(THEMES)
    const [handle, name] = pick(X_AUTHORS)
    const hasImage = chance(0.6)
    const ratio = hasImage ? pick([9 / 16, 3 / 4, 1, 0.5625]) : 0
    const id = `${1890000000000000000n + BigInt(i * 104729)}`
    if (hasImage) images.push({ name: `x_${i}.jpg`, ratio, hue: between(0, 359) })

    posts.push({
      platform: 'x',
      id,
      url: `https://x.com/${handle}/status/${id}`,
      authorHandle: handle,
      authorName: name,
      text: caption(theme).replace(/#\w+/g, '').trim(),
      kind: hasImage ? 'image' : chance(0.5) ? 'text' : 'link',
      image: hasImage ? `x_${i}.jpg` : null,
      publishedAt: now - between(3600_000, 3600_000 * 24 * 300),
      savedAt: now - between(3600_000, 3600_000 * 24 * 200)
    })
  }

  for (let i = 0; i < 21; i++) {
    const theme = pick(THEMES)
    const sub = pick(SUBREDDITS)
    const hasImage = chance(0.55)
    const ratio = hasImage ? pick([3 / 4, 1, 9 / 16, 0.75]) : 0
    const id = `t3_${Math.floor(random() * 1e10).toString(36)}`
    if (hasImage) images.push({ name: `rd_${i}.jpg`, ratio, hue: between(0, 359) })

    posts.push({
      platform: 'reddit',
      id,
      url: `https://www.reddit.com/r/${sub}/comments/${id.slice(3)}/`,
      authorHandle: `u/${pick(['mikael_r', 'nord_light', 'delta_grain', 'plan_fixe', 'okiro'])}`,
      authorName: null,
      subreddit: sub,
      text: `[r/${sub}] ${caption(theme).replace(/#\w+/g, '').trim()}`,
      kind: hasImage ? 'image' : chance(0.6) ? 'text' : 'link',
      image: hasImage ? `rd_${i}.jpg` : null,
      publishedAt: now - between(3600_000, 3600_000 * 24 * 500),
      savedAt: now - between(3600_000, 3600_000 * 24 * 250)
    })
  }

  return { payload: { posts }, images }
}

/* ----------------------------------------------------------------------- main */

async function main(): Promise<void> {
  mkdirSync(MEDIA_DIR, { recursive: true })
  mkdirSync(FIXTURE_DIR, { recursive: true })

  const instagram = buildInstagram(92)
  const others = buildOthers()
  const allImages = [...instagram.images, ...others.images]

  console.log(`Génération de ${allImages.length} images (téléchargement ou dégradé de repli)…`)
  await pooled(allImages, 6, async (img) => {
    await makeImage(img.name, img.ratio, img.hue)
    const done = downloaded + generated
    if (done % 20 === 0) console.log(`  ${done}/${allImages.length}`)
  })

  console.log(`\nGénération de ${instagram.videos.length} clips…`)
  let clips = 0
  await pooled(instagram.videos, 3, async (video) => {
    try {
      if (await makeVideo(video.name, video.poster)) clips++
    } catch (err) {
      console.warn(`  clip ${video.name} impossible :`, (err as Error).message.split('\n')[0])
    }
  })
  console.log(`  ${clips}/${instagram.videos.length} clips`)

  writeFileSync(
    join(FIXTURE_DIR, 'instagram-saved.json'),
    JSON.stringify(instagram.payload, null, 2)
  )
  writeFileSync(join(FIXTURE_DIR, 'other-platforms.json'), JSON.stringify(others.payload, null, 2))

  console.log(
    `\nFixture prête : ${downloaded} images téléchargées, ${generated} générées localement.`
  )
  console.log(`  ${MEDIA_DIR}`)
  console.log(`  ${FIXTURE_DIR}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
