import type {
  AiCollectionPlan,
  AiCollectionSuggestion,
  Language,
  OrganizerProgress
} from '@shared/types'
import { app } from 'electron'
import sharp from 'sharp'
import {
  localVideoFeatures,
  saveLocalVideoFeatures,
  videoOrganizationItems,
  type LocalVideoFeature,
  type VideoOrganizationItem
} from '../db/queries'
import { readSettings } from '../settings'

const MAX_CATEGORIES = 24
const VISUAL_SIZE = 6
const VISUAL_THRESHOLD = 0.94
const VISUAL_MARGIN = 0.035

interface Topic {
  id: string
  fr: string
  en: string
  keywords: string[]
}

interface PreparedItem {
  item: VideoOrganizationItem
  terms: Map<string, number>
  visual: Float32Array | null
  choices: { id: string; score: number }[]
}

interface CategoryDefinition {
  id: string
  name: string
  keyword: string
  fixed: boolean
}

const TOPICS: Topic[] = [
  { id: 'skateboard', fr: 'Skateboard', en: 'Skateboarding', keywords: ['skate', 'skater', 'skateboard', 'skateboarding', 'ollie', 'kickflip', 'grind', 'thrasher'] },
  { id: 'guitar', fr: 'Guitare', en: 'Guitar', keywords: ['guitar', 'guitare', 'guitarist', 'guitariste', 'guitartok', 'riff', 'pedalboard', 'fretboard'] },
  { id: 'dj', fr: 'DJ et mix', en: 'DJ & mixing', keywords: ['dj', 'deejay', 'turntable', 'cdj', 'serato', 'rekordbox', 'mixing', 'mixage', 'boiler room'] },
  { id: 'music-production', fr: 'Production musicale', en: 'Music production', keywords: ['music production', 'production musicale', 'producer', 'beatmaking', 'ableton', 'fl studio', 'logic pro', 'synth', 'synthesizer', 'sound design', 'mixdown', 'mastering'] },
  { id: 'music', fr: 'Musique', en: 'Music', keywords: ['music', 'musique', 'musician', 'musicien', 'concert', 'song', 'chanson', 'album', 'piano', 'drums', 'batterie', 'bass'] },
  { id: '3d', fr: '3D et Blender', en: '3D & Blender', keywords: ['3d', '3dart', '3dcg', 'cg', 'cgi', 'blender', 'blender3d', 'b3d', 'bnpr', 'npr', 'cinema4d', 'c4d', 'houdini', 'unreal engine', 'unrealengine', 'ue5', 'render', 'rendering', 'geometry nodes', 'geometrynodes', 'substance painter'] },
  { id: 'graphic-design', fr: 'Design graphique', en: 'Graphic design', keywords: ['graphic design', 'graphicdesign', 'design graphique', 'typography', 'typographie', 'poster design', 'affiche', 'branding', 'logo design', 'illustrator', 'photoshop'] },
  { id: 'generative-ai', fr: 'IA générative', en: 'Generative AI', keywords: ['generative ai', 'ia generative', 'ai art', 'aiart', 'ai illustration', 'aiイラスト', 'comfyui', 'stable diffusion', 'stablediffusion', 'midjourney', 'flux ai', 'controlnet', 'lora'] },
  { id: 'art', fr: 'Art et illustration', en: 'Art & illustration', keywords: ['art', 'artist', 'artiste', 'illustration', 'drawing', 'dessin', 'painting', 'peinture', 'sketch', 'croquis', 'digital art', 'digitalart'] },
  { id: 'photography', fr: 'Photographie', en: 'Photography', keywords: ['photo', 'photography', 'photographie', 'photographer', 'photographe', 'camera', 'appareil photo', 'lightroom', 'portrait photography', 'street photography'] },
  { id: 'animation', fr: 'Animation', en: 'Animation', keywords: ['animation', 'animator', 'animateur', '2danimation', '3danimation', 'motion design', 'motion graphics', 'stop motion', 'after effects', 'aftereffects', 'anime', 'animated'] },
  { id: 'film', fr: 'Cinéma et vidéo', en: 'Film & video', keywords: ['cinema', 'cinéma', 'film', 'filmmaking', 'videography', 'video editing', 'montage vidéo', 'director', 'réalisateur', 'cinematography', 'vfx'] },
  { id: 'fashion', fr: 'Mode', en: 'Fashion', keywords: ['fashion', 'mode', 'outfit', 'streetwear', 'clothing', 'vêtement', 'sneakers', 'runway', 'couture', 'style'] },
  { id: 'food', fr: 'Cuisine', en: 'Food & cooking', keywords: ['food', 'cooking', 'cuisine', 'recipe', 'recette', 'chef', 'baking', 'pâtisserie', 'restaurant', 'meal'] },
  { id: 'fitness', fr: 'Sport et fitness', en: 'Sport & fitness', keywords: ['fitness', 'workout', 'gym', 'musculation', 'training', 'entraînement', 'running', 'course à pied', 'sport', 'yoga'] },
  { id: 'travel', fr: 'Voyage', en: 'Travel', keywords: ['travel', 'voyage', 'trip', 'roadtrip', 'vacation', 'vacances', 'destination', 'hotel', 'hôtel', 'city guide'] },
  { id: 'tech', fr: 'Technologie', en: 'Technology', keywords: ['technology', 'technologie', 'tech', 'gadget', 'computer', 'ordinateur', 'smartphone', 'hardware', 'robot', 'electronics'] },
  { id: 'coding', fr: 'Code et développement', en: 'Code & development', keywords: ['code', 'coding', 'programming', 'programmation', 'developer', 'développeur', 'javascript', 'typescript', 'python', 'github', 'webdev'] },
  { id: 'architecture', fr: 'Architecture', en: 'Architecture', keywords: ['architecture', 'architect', 'architecte', 'building', 'bâtiment', 'facade', 'façade', 'urbanism', 'urbanisme'] },
  { id: 'interiors', fr: 'Intérieurs et décoration', en: 'Interiors & decor', keywords: ['interior design', 'design intérieur', 'decor', 'décoration', 'furniture', 'mobilier', 'home design', 'room', 'maison'] },
  { id: 'cars', fr: 'Auto et moto', en: 'Cars & motorcycles', keywords: ['car', 'cars', 'voiture', 'automobile', 'motorcycle', 'moto', 'racing', 'drift', 'engine', 'moteur'] },
  { id: 'nature', fr: 'Nature', en: 'Nature', keywords: ['nature', 'landscape', 'paysage', 'forest', 'forêt', 'ocean', 'océan', 'mountain', 'montagne', 'wildlife'] },
  { id: 'animals', fr: 'Animaux', en: 'Animals', keywords: ['animal', 'animals', 'animaux', 'dog', 'chien', 'cat', 'chat', 'pet', 'pets', 'bird', 'oiseau'] },
  { id: 'gaming', fr: 'Jeux vidéo', en: 'Gaming', keywords: ['gaming', 'gameplay', 'video game', 'jeu vidéo', 'gamer', 'gamedev', 'game dev', 'indiedev', 'indiegame', 'playstation', 'xbox', 'nintendo', 'steam'] },
  { id: 'beauty', fr: 'Beauté', en: 'Beauty', keywords: ['beauty', 'beauté', 'makeup', 'maquillage', 'skincare', 'cosmetics', 'cosmétique', 'hair', 'coiffure'] },
  { id: 'humor', fr: 'Humour', en: 'Humour', keywords: ['funny', 'humour', 'humor', 'comedy', 'comédie', 'meme', 'memes', 'blague', 'parody'] },
  { id: 'learning', fr: 'Apprendre et comprendre', en: 'Learning & ideas', keywords: ['tutorial', 'tutoriel', 'howto', 'how to', 'learn', 'apprendre', 'education', 'éducation', 'explained', 'explication', 'science', 'history', 'histoire'] }
]

const STOP_WORDS = new Set(
  `a about above after again against ai all am an and any are arent as at avec avoir be because been before being below between both but by can could dans de des did do does doing dont down during each elle en encore est et few for from further get got had has have having he her here hers herself him himself his how i if in into is it its itself je just la le les lui mais me more most my myself ne no nor not nous of off on once only or other our ours ourselves out over own pas plus pour que qui re really same she should so some such sur than that the their theirs them themselves then there these they this those through to too très under until up very vous was we were what when where which while who why will with you your yours yourself yourselves ça comme cette ces ce une un video videos reel reels post posts instagram reddit twitter tiktok x com http https www fyp fy foryou foryoupage viral trending trend explore explorepage follow like likes share watch link bio indie`.split(/\s+/)
)

const topicKeyword = new Map<string, string>()
for (const topic of TOPICS) {
  for (const keyword of topic.keywords) topicKeyword.set(normalizePhrase(keyword), topic.id)
}

let progress: OrganizerProgress = {
  stage: 'idle',
  done: 0,
  total: 0,
  running: false
}
const listeners = new Set<(value: OrganizerProgress) => void>()

export const localOrganizer = {
  subscribe(listener: (value: OrganizerProgress) => void): () => void {
    listeners.add(listener)
    listener(progress)
    return () => listeners.delete(listener)
  }
}

function setProgress(next: OrganizerProgress): void {
  progress = next
  for (const listener of listeners) listener(next)
}

function language(): Language {
  const setting = readSettings().language
  if (setting === 'fr' || setting === 'en') return setting
  return app.getLocale().toLowerCase().startsWith('fr') ? 'fr' : 'en'
}

function normalizePhrase(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^\p{L}\p{N}+# ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function words(value: string): string[] {
  return normalizePhrase(value)
    .replace(/https?\s+\S+/g, ' ')
    .split(' ')
    .map((word) => word.replace(/^#+/, ''))
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word) && !/^\d+$/.test(word))
}

function addTerms(target: Map<string, number>, values: string[], weight: number): void {
  for (const value of values) {
    target.set(value, Math.max(target.get(value) ?? 0, weight))
  }
}

function prepareTerms(item: VideoOrganizationItem): Map<string, number> {
  const terms = new Map<string, number>()
  const text = item.text ?? ''
  const textWords = words(text)
  addTerms(terms, textWords, 1)

  const hashtags = [...text.matchAll(/#([\p{L}\p{N}_-]{2,})/gu)].map((match) =>
    normalizePhrase(match[1])
  )
  addTerms(terms, hashtags, 4)
  addTerms(terms, item.tags.flatMap(words), 4.5)

  for (let index = 0; index < textWords.length - 1; index += 1) {
    const phrase = `${textWords[index]} ${textWords[index + 1]}`
    if (phrase.length <= 40) terms.set(phrase, Math.max(terms.get(phrase) ?? 0, 1.35))
  }
  return terms
}

function topicScore(topic: Topic, normalizedText: string, terms: Map<string, number>): number {
  let score = 0
  for (const rawKeyword of topic.keywords) {
    const keyword = normalizePhrase(rawKeyword)
    if (keyword.includes(' ')) {
      if (normalizedText.includes(` ${keyword} `) || normalizedText.startsWith(`${keyword} `) || normalizedText.endsWith(` ${keyword}`) || normalizedText === keyword) score += 5
      continue
    }
    const weight = terms.get(keyword)
    if (weight) score += 2.5 + weight
  }
  return score
}

function titleCase(value: string): string {
  return value
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1))
    .join(' ')
    .slice(0, 80)
}

function decodeVisual(buffer: Buffer | null): Float32Array | null {
  if (!buffer || buffer.byteLength === 0 || buffer.byteLength % 4 !== 0) return null
  const copy = Uint8Array.from(buffer)
  return new Float32Array(copy.buffer)
}

function encodeVisual(vector: Float32Array): Buffer {
  return Buffer.from(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength))
}

export async function extractLocalVisualFeature(path: string): Promise<Float32Array | null> {
  try {
    const { data } = await sharp(path)
      .rotate()
      .resize(VISUAL_SIZE, VISUAL_SIZE, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const pixels = VISUAL_SIZE * VISUAL_SIZE
    const means = [0, 0, 0]
    for (let index = 0; index < pixels; index += 1) {
      means[0] += data[index * 3]
      means[1] += data[index * 3 + 1]
      means[2] += data[index * 3 + 2]
    }
    means[0] /= pixels * 255
    means[1] /= pixels * 255
    means[2] /= pixels * 255

    const vector = new Float32Array(pixels * 3 + 3)
    for (let index = 0; index < pixels; index += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        vector[index * 3 + channel] = data[index * 3 + channel] / 255 - means[channel]
      }
    }
    vector[pixels * 3] = means[0]
    vector[pixels * 3 + 1] = means[1]
    vector[pixels * 3 + 2] = means[2]
    normalizeVector(vector)
    return vector
  } catch {
    return null
  }
}

function normalizeVector(vector: Float32Array): void {
  let magnitude = 0
  for (const value of vector) magnitude += value * value
  magnitude = Math.sqrt(magnitude)
  if (magnitude === 0) return
  for (let index = 0; index < vector.length; index += 1) vector[index] /= magnitude
}

function similarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) return -1
  let result = 0
  for (let index = 0; index < left.length; index += 1) result += left[index] * right[index]
  return result
}

async function loadVisuals(items: VideoOrganizationItem[]): Promise<Map<string, Float32Array | null>> {
  const cached = localVideoFeatures()
  const result = new Map<string, Float32Array | null>()
  const pending = items.filter((item) => {
    const feature = cached.get(item.id)
    return (
      !feature ||
      feature.thumbPath !== item.thumbPath ||
      (item.thumbPath !== null && feature.visual === null)
    )
  })

  for (const item of items) {
    const feature = cached.get(item.id)
    if (feature?.thumbPath === item.thumbPath && (feature.visual || item.thumbPath === null)) {
      result.set(item.id, decodeVisual(feature.visual))
    }
  }
  if (pending.length === 0) return result

  setProgress({ stage: 'visuals', done: 0, total: pending.length, running: true })
  let cursor = 0
  let done = 0
  const writes: LocalVideoFeature[] = []

  const flush = (): void => {
    if (writes.length === 0) return
    saveLocalVideoFeatures(writes.splice(0))
  }

  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      const item = pending[cursor]
      cursor += 1
      const visual = item.thumbPath ? await extractLocalVisualFeature(item.thumbPath) : null
      result.set(item.id, visual)
      writes.push({ postId: item.id, thumbPath: item.thumbPath, visual: visual ? encodeVisual(visual) : null })
      done += 1
      if (writes.length >= 100) flush()
      if (done === pending.length || done % 20 === 0) {
        setProgress({ stage: 'visuals', done, total: pending.length, running: true })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => worker()))
  flush()
  return result
}

function centroid(vectors: Float32Array[]): Float32Array | null {
  if (vectors.length === 0) return null
  const result = new Float32Array(vectors[0].length)
  for (const vector of vectors) {
    for (let index = 0; index < result.length; index += 1) result[index] += vector[index]
  }
  normalizeVector(result)
  return result
}

function createChoices(items: PreparedItem[], lang: Language): Map<string, CategoryDefinition> {
  const definitions = new Map<string, CategoryDefinition>()
  const documentFrequency = new Map<string, number>()
  const totalWeight = new Map<string, number>()
  for (const prepared of items) {
    for (const [term, weight] of prepared.terms) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
      totalWeight.set(term, (totalWeight.get(term) ?? 0) + weight)
    }
  }

  const minimum = items.length < 100 ? 2 : 3
  const maximum = Math.max(10, Math.floor(items.length * 0.16))
  const dynamic = [...documentFrequency]
    .filter(([term, count]) => {
      if (count < minimum || count > maximum || term.length < 3 || term.length > 35) return false
      if (topicKeyword.has(term) || STOP_WORDS.has(term)) return false
      return !term.split(' ').some((word) => STOP_WORDS.has(word))
    })
    .map(([term, count]) => ({
      term,
      count,
      quality:
        Math.sqrt(count) * Math.log(1 + items.length / count) * ((totalWeight.get(term) ?? count) / count)
    }))
    .sort((left, right) => right.quality - left.quality)
    .slice(0, 36)

  for (const topic of TOPICS) {
    definitions.set(topic.id, {
      id: topic.id,
      name: lang === 'fr' ? topic.fr : topic.en,
      keyword: topic.id,
      fixed: true
    })
  }
  for (const candidate of dynamic) {
    const id = `term:${candidate.term}`
    definitions.set(id, {
      id,
      name: titleCase(candidate.term),
      keyword: candidate.term,
      fixed: false
    })
  }

  for (const prepared of items) {
    const normalizedText = ` ${normalizePhrase(`${prepared.item.text ?? ''} ${prepared.item.tags.join(' ')}`)} `
    const scores: { id: string; score: number }[] = []
    for (const topic of TOPICS) {
      const score = topicScore(topic, normalizedText, prepared.terms)
      if (score >= 3.5) scores.push({ id: topic.id, score })
    }
    for (const candidate of dynamic) {
      const weight = prepared.terms.get(candidate.term)
      if (!weight) continue
      const specificity = Math.log(1 + items.length / candidate.count)
      scores.push({ id: `term:${candidate.term}`, score: weight * specificity })
    }
    prepared.choices = scores.sort((left, right) => right.score - left.score)
  }
  return definitions
}

function assignCategories(items: PreparedItem[], definitions: Map<string, CategoryDefinition>): Map<string, PreparedItem[]> {
  const minimum = items.length < 100 ? 2 : 3
  const firstCounts = new Map<string, number>()
  for (const item of items) {
    const first = item.choices[0]
    if (first) firstCounts.set(first.id, (firstCounts.get(first.id) ?? 0) + 1)
  }

  const viable = [...firstCounts]
    .filter(([, count]) => count >= minimum)
    .sort((left, right) => right[1] - left[1])
    .slice(0, MAX_CATEGORIES)
    .map(([id]) => id)
  const allowed = new Set(viable)
  const groups = new Map<string, PreparedItem[]>(viable.map((id) => [id, []]))
  const assigned = new Map<PreparedItem, string>()

  for (const item of items) {
    const choice = item.choices.find((candidate) => allowed.has(candidate.id))
    if (!choice) continue
    groups.get(choice.id)?.push(item)
    assigned.set(item, choice.id)
  }

  // Un créateur spécialisé est un signal local très fort, notamment pour les Reels sans
  // légende. Il n'est utilisé que si au moins 70 % de ses vidéos déjà classées concordent.
  const authors = new Map<string, Map<string, number>>()
  for (const [item, category] of assigned) {
    const author = item.item.authorHandle?.toLocaleLowerCase()
    if (!author) continue
    const counts = authors.get(author) ?? new Map<string, number>()
    counts.set(category, (counts.get(category) ?? 0) + 1)
    authors.set(author, counts)
  }
  for (const item of items) {
    if (assigned.has(item)) continue
    const counts = item.item.authorHandle ? authors.get(item.item.authorHandle.toLocaleLowerCase()) : undefined
    if (!counts) continue
    const ordered = [...counts].sort((left, right) => right[1] - left[1])
    const total = ordered.reduce((sum, entry) => sum + entry[1], 0)
    if (total >= 3 && ordered[0][1] / total >= 0.7) {
      groups.get(ordered[0][0])?.push(item)
      assigned.set(item, ordered[0][0])
    }
  }

  const centroids = new Map<string, Float32Array>()
  for (const [id, members] of groups) {
    const center = centroid(members.map((member) => member.visual).filter((value): value is Float32Array => value !== null))
    if (center && members.length >= 3) centroids.set(id, center)
  }
  for (const item of items) {
    if (assigned.has(item) || !item.visual) continue
    const matches = [...centroids]
      .map(([id, center]) => ({ id, score: similarity(item.visual as Float32Array, center) }))
      .sort((left, right) => right.score - left.score)
    if (
      matches[0]?.score >= VISUAL_THRESHOLD &&
      matches[0].score - (matches[1]?.score ?? -1) >= VISUAL_MARGIN
    ) {
      groups.get(matches[0].id)?.push(item)
      assigned.set(item, matches[0].id)
    }
  }

  for (const [id, members] of [...groups]) {
    if (members.length < minimum || !definitions.has(id)) groups.delete(id)
  }
  return groups
}

function categoryDescription(
  members: PreparedItem[],
  definition: CategoryDefinition,
  lang: Language
): string {
  const frequencies = new Map<string, number>()
  for (const member of members) {
    for (const [term, weight] of member.terms) {
      if (weight < 1.3 || term === definition.keyword || STOP_WORDS.has(term)) continue
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
    }
  }
  const clues = [...frequencies]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([term]) => term)
  if (lang === 'fr') {
    return clues.length > 0
      ? `Rapprochées localement par : ${clues.join(', ')}.`
      : 'Vidéos rapprochées localement par leur contenu et leur style visuel.'
  }
  return clues.length > 0
    ? `Grouped locally using: ${clues.join(', ')}.`
    : 'Videos grouped locally by their content and visual style.'
}

let currentProposal: Promise<AiCollectionPlan> | null = null

export function buildLocalCollectionPlan(
  items: VideoOrganizationItem[],
  visuals: Map<string, Float32Array | null> = new Map(),
  lang: Language = 'en'
): AiCollectionPlan {
  const prepared: PreparedItem[] = items.map((item) => ({
    item,
    terms: prepareTerms(item),
    visual: visuals.get(item.id) ?? null,
    choices: []
  }))
  const definitions = createChoices(prepared, lang)
  const groups = assignCategories(prepared, definitions)
  const suggestions: AiCollectionSuggestion[] = [...groups]
    .sort((left, right) => right[1].length - left[1].length)
    .map(([id, members], index) => {
      const definition = definitions.get(id) as CategoryDefinition
      return {
        id: `local-${index}`,
        name: definition.name,
        description: categoryDescription(members, definition, lang),
        postIds: members.map((member) => member.item.id)
      }
    })
  const assigned = new Set(suggestions.flatMap((suggestion) => suggestion.postIds))
  return {
    suggestions,
    analysedVideos: items.length,
    unassignedVideos: Math.max(0, items.length - assigned.size)
  }
}

async function buildVideoCollectionProposal(): Promise<AiCollectionPlan> {
  const items = videoOrganizationItems()
  if (items.length === 0) return { suggestions: [], analysedVideos: 0, unassignedVideos: 0 }

  setProgress({ stage: 'preparing', done: 0, total: items.length, running: true })
  const visuals = await loadVisuals(items)
  setProgress({ stage: 'grouping', done: 0, total: items.length, running: true })

  const plan = buildLocalCollectionPlan(items, visuals, language())
  setProgress({ stage: 'grouping', done: items.length, total: items.length, running: true })
  return plan
}

export function proposeVideoCollections(): Promise<AiCollectionPlan> {
  if (currentProposal) return currentProposal
  currentProposal = buildVideoCollectionProposal().finally(() => {
    currentProposal = null
    setProgress({ ...progress, running: false })
  })
  return currentProposal
}
