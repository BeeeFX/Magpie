import type {
  AiCollectionApplyResult,
  AiCollectionPlan,
  AiCollectionRoute,
  AiCollectionSuggestion,
  Language,
  OrganizerMap,
  OrganizerProgress
} from '@shared/types'
import { app } from 'electron'
import { isAbsolute, join } from 'node:path'
import sharp from 'sharp'
import {
  collectionRemovals,
  listCollections,
  localVideoFeatures,
  organizerRules,
  recordOrganizerApplication,
  saveLocalVideoFeatures,
  organizationItems,
  postImageEmbeddings,
  addToCollection,
  type LocalVideoFeature,
  type OrganizerRuleRow,
  type OrganizationItem
} from '../db/queries'
import { centreVectors, embedItems, embedTexts } from './embeddings'
import { blend, encodeTopicPrompts, toVector, topicStandoff } from './vision'
import { propagateByImage } from './propagate'
import { project, type ProjectedPoint } from './projection'
import { mediaDir } from '../db'
import { readSettings } from '../settings'

const MAX_CATEGORIES = 24
/** Marque les termes de facette — forme du post, plateforme. Jamais un thème, jamais un nom.
 *  Le deux-points ne survit pas à `normalizePhrase`, donc aucun terme réel ne peut collisionner. */
const FACET = 'facet:'
const VISUAL_SIZE = 6
const VISUAL_THRESHOLD = 0.94
const VISUAL_MARGIN = 0.035

/**
 * Rend la main entre deux tranches de calcul.
 *
 * Le regroupement est du calcul pur, et il tourne sur le processus principal : sur une
 * grande vidéothèque il l'occupait sans interruption pendant près d'une seconde après
 * *chaque* synchronisation, fenêtre figée comprise. Le coût est global — il ne dépend pas
 * du nombre de posts rapportés — donc espacer les analyses n'aurait fait que le repousser.
 * On le découpe donc, pour que l'IPC et le rendu passent entre les tranches.
 */
export type Breathe = () => Promise<void>

const NO_BREATHE: Breathe = () => Promise.resolve()
/** Assez large pour que le surcoût soit invisible, assez court pour que la fenêtre réponde. */
const BREATHE_EVERY = 400

interface Topic {
  id: string
  fr: string
  en: string
  keywords: string[]
}

interface PreparedItem {
  item: OrganizationItem
  terms: Map<string, number>
  visual: Float32Array | null
  vector: Float32Array | null
  choices: { id: string; score: number }[]
}

/**
 * Vecteurs de sens, quand ils sont disponibles.
 *
 * Optionnels à dessein : le tri doit rester possible sans modèle téléchargé, et les tests
 * du regroupement n'ont pas à faire tourner un réseau de neurones pour vérifier une règle.
 */
export interface SemanticInput {
  items: Map<string, Float32Array>
  topics: Map<string, Float32Array>
  /**
   * Le même rapprochement, mais vu par l'image.
   *
   * Absent quand aucune image n'a été lue, ou quand la tour texte de SigLIP n'a pas pu être
   * chargée : le classement se poursuit alors sur le texte seul, comme avant.
   */
  vision?: {
    /** Les thèmes encodés par SigLIP, dans l'ordre de `TOPICS`. */
    topics: Float32Array[]
    /** Le vecteur de sujet de chaque post illustré. */
    items: Map<string, Float32Array>
    /** Les identifiants de thème, dans le même ordre que `topics`. */
    ids: string[]
    /** Réglages, pour que les bancs puissent les balayer. Par défaut, ceux mesurés ci-dessous. */
    floor?: number
    weight?: number
  }
}

/**
 * À partir de quand l'avis de l'image compte, et combien il pèse.
 *
 * Le score est un écart-type : à quel point un thème se détache, sur les 27, pour cette
 * image. Le cosinus brut ne conviendrait pas — son étalement d'une image à l'autre dépasse
 * l'écart entre bon et mauvais thème.
 *
 * Balayé sur la bibliothèque entière, avec et sans l'image (`scripts/bench-vision-topics`).
 * « Classés » compte les posts illustrés qui rejoignent une catégorie ; « vérité » est la
 * justesse sur les 1 347 posts dont les mots-clés désignent un thème et un seul — là où le
 * texte sait de quoi il parle, et donc là où un poids trop haut se verrait :
 *
 *   sans l'image        7 093 classés, 1 299 muets classés — 95,3 %
 *   plancher 2, poids 2 9 157 classés, 2 445 muets classés — 95,3 %   ← retenu
 *   plancher 2, poids 4 9 140 classés, 2 431 muets classés — 94,4 %
 *   plancher 2, poids 6 9 133 classés, 2 423 muets classés — 94,9 %
 *   plancher 2,5        8 057 classés, 1 868 muets classés — 95,5 %
 *   plancher 3          7 123 classés, 1 268 muets classés — 95,4 %
 *
 * Le plancher décide de tout : au-dessus de 2, l'image se tait sur la plupart des posts et
 * on retombe sur le texte seul. Le poids, lui, ne change pas la couverture — les mêmes posts
 * sont concernés — mais un poids fort renverse des attributions que le texte tenait bien :
 * 18 posts cassés pour 5 réparés à poids 4, contre 4 pour 4 à poids 2. On prend donc le plus
 * faible des deux, qui rend la même couverture sans rien coûter.
 *
 * Le gain se lit surtout sur les légendes muettes : 1 299 posts classés sur 2 680 avant,
 * 2 445 après. C'est le tiers de la bibliothèque qui n'a rien à dire de lui-même et qui
 * partait au hasard — la vidéo de guitare rangée dans « Cuisine ».
 */
const VISION_FLOOR = 2
const VISION_WEIGHT = 2

/** Poids du rappel sémantique. Une similarité recentrée de 0,3 est déjà un signal net ; le
 *  facteur la met à l'échelle des scores de mots-clés, où un hashtag vaut 6,5. */
const SEMANTIC_WEIGHT = 14
/** En dessous, c'est du bruit : le nuage recentré place les paires étrangères autour de 0. */
const SEMANTIC_FLOOR = 0.08

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

/**
 * Texte représentatif de chaque thème, à encoder pour le comparer aux posts.
 *
 * Les mots-clés ne reconnaissent que ce qu'ils listent : un post sur Ableton ne rejoignait
 * « Production musicale » que parce que le mot y figurait, et un post sur Bitwig ne
 * rejoignait rien. Comparer les vecteurs rattrape ce que la liste ne prévoit pas.
 */
export const TOPIC_DESCRIPTORS: { id: string; text: string }[] = TOPICS.map((topic) => ({
  id: topic.id,
  text: `${topic.en}, ${topic.fr} — ${topic.keywords.slice(0, 10).join(', ')}`
}))

/**
 * Les thèmes tels qu'on les présente à SigLIP.
 *
 * La phrase nue, et rien d'autre : ni les mots-clés, ni le libellé français. Mesuré, le
 * descripteur du classement textuel — nom suivi de dix mots-clés — fait tomber la justesse
 * de 43,7 % à 24,1 %. SigLIP a appris sur des légendes de photos ; on lui parle donc comme
 * à une légende.
 */
/** Les mots-clés de chaque thème, pour les bancs : ils servent à bâtir une vérité de terrain. */
export const TOPIC_KEYWORDS: { id: string; keywords: string[] }[] = TOPICS.map((topic) => ({
  id: topic.id,
  keywords: topic.keywords
}))

export const TOPIC_PROMPTS = TOPICS.map((topic) => `a photo of ${topic.en.toLowerCase()}`)

/**
 * Les thèmes vus par l'image, ou rien.
 *
 * Rien est un cas normal, pas une panne : aucune image lue, ou tour texte indisponible —
 * pas encore téléchargée, hors ligne. Le classement se poursuit alors sur le texte seul,
 * exactement comme avant. Mais l'échec est *dit* : c'est un `catch` muet à cet endroit qui a
 * fait passer la lecture des images pour un succès pendant six versions.
 */
async function visionTopics(
  images: Map<string, { meaning: Buffer }>
): Promise<SemanticInput['vision']> {
  if (images.size === 0) return undefined
  try {
    const topics = await encodeTopicPrompts(TOPIC_PROMPTS)
    return {
      topics,
      ids: TOPICS.map((topic) => topic.id),
      items: new Map([...images].map(([id, row]) => [id, toVector(row.meaning)]))
    }
  } catch (error) {
    console.warn('[magpie] Thèmes vus par l’image indisponibles, texte seul :', error)
    return undefined
  }
}

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

function prepareTerms(item: OrganizationItem): Map<string, number> {
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

  /* La forme du post porte un peu de sens : un carrousel est presque toujours une liste ou un
     tutoriel, un lien nu est une lecture à garder. Poids délibérément faible — c'est un
     départage entre deux candidats à égalité, jamais une raison de créer une catégorie. Le
     préfixe réservé les exclut du minage : sans lui, « Kind Image » deviendrait un thème. */
  addTerms(terms, [`${FACET}kind ${item.kind}`, `${FACET}on ${item.platform}`], 0.8)
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

/**
 * La base conserve seulement le nom des vignettes mises en cache. Les passer directement
 * à sharp les faisait chercher dans le dossier d'installation de Magpie. Après quelques
 * milliers d'ouvertures invalides en parallèle, libvips pouvait terminer brutalement le
 * processus principal sous Windows. Accepter aussi un chemin absolu garde cette fonction
 * testable et reste compatible avec d'anciennes bibliothèques.
 */
export function resolveLocalThumbnailPath(path: string, baseDir = mediaDir()): string {
  return isAbsolute(path) ? path : join(baseDir, path)
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

async function loadVisuals(items: OrganizationItem[]): Promise<Map<string, Float32Array | null>> {
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
      const visual = item.thumbPath
        ? await extractLocalVisualFeature(resolveLocalThumbnailPath(item.thumbPath))
        : null
      result.set(item.id, visual)
      writes.push({ postId: item.id, thumbPath: item.thumbPath, visual: visual ? encodeVisual(visual) : null })
      done += 1
      if (writes.length >= 100) flush()
      if (done === pending.length || done % 20 === 0) {
        setProgress({ stage: 'visuals', done, total: pending.length, running: true })
      }
    }
  }

  // sharp/libvips parallélise déjà le décodage en interne. Deux travaux simultanés gardent
  // l'analyse rapide sans soumettre le module natif à une rafale de milliers de lectures.
  await Promise.all(Array.from({ length: Math.min(2, pending.length) }, () => worker()))
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

async function createChoices(
  items: PreparedItem[],
  lang: Language,
  breathe: Breathe,
  semantic: SemanticInput | null
): Promise<Map<string, CategoryDefinition>> {
  const definitions = new Map<string, CategoryDefinition>()
  const documentFrequency = new Map<string, number>()
  const totalWeight = new Map<string, number>()
  for (const [index, prepared] of items.entries()) {
    for (const [term, weight] of prepared.terms) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
      totalWeight.set(term, (totalWeight.get(term) ?? 0) + weight)
    }
    if (index % BREATHE_EVERY === BREATHE_EVERY - 1) await breathe()
  }

  const minimum = items.length < 100 ? 2 : 3
  const maximum = Math.max(10, Math.floor(items.length * 0.16))
  const dynamic = [...documentFrequency]
    .filter(([term, count]) => {
      if (term.startsWith(FACET)) return false
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

  // Passe la plus lourde du regroupement : chaque vidéo est confrontée à tous les thèmes
  // fixes puis à tous les termes retenus.
  for (const [index, prepared] of items.entries()) {
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
    /* Rappel sémantique : un post sur Bitwig ne figurait dans aucune liste de mots-clés et
       ne rejoignait donc rien, alors que son vecteur le place tout près de « Production
       musicale ». Le score s'ajoute au lieu de remplacer — les mots-clés restent le signal
       le plus sûr quand ils tombent juste, et le nommage continue d'en dépendre. */
    if (semantic && prepared.vector) {
      for (const [topicId, topicVector] of semantic.topics) {
        const similarity = dotProduct(prepared.vector, topicVector)
        if (similarity < SEMANTIC_FLOOR) continue
        const existing = scores.find((entry) => entry.id === topicId)
        const bonus = (similarity - SEMANTIC_FLOOR) * SEMANTIC_WEIGHT
        if (existing) existing.score += bonus
        else scores.push({ id: topicId, score: bonus })
      }
    }
    /* Ce que le post *montre*, en troisième avis. Il s'ajoute comme le rappel sémantique, et
       pour la même raison : les mots-clés restent le signal le plus sûr, et c'est d'eux que
       dépend le nommage de la catégorie. Mais un tiers de la bibliothèque n'a aucun texte
       exploitable, et ces posts-là ne rejoignaient rien — ou pire, rejoignaient n'importe
       quoi, comme cette vidéo de guitare dont la seule légende est un lien et qui se
       retrouvait en « Cuisine ». */
    const vision = semantic?.vision
    const meaning = vision?.items.get(prepared.item.id)
    if (vision && meaning) {
      const floor = vision.floor ?? VISION_FLOOR
      const weight = vision.weight ?? VISION_WEIGHT
      const standoff = topicStandoff(meaning, vision.topics)
      standoff.forEach((value, topicIndex) => {
        if (value < floor) return
        const topicId = vision.ids[topicIndex]
        const bonus = (value - floor) * weight
        const existing = scores.find((entry) => entry.id === topicId)
        if (existing) existing.score += bonus
        else scores.push({ id: topicId, score: bonus })
      })
    }
    prepared.choices = scores.sort((left, right) => right.score - left.score)
    if (index % BREATHE_EVERY === BREATHE_EVERY - 1) await breathe()
  }
  return definitions
}

/** Produit scalaire de deux vecteurs normalisés — leur similarité cosinus. */
function dotProduct(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) return 0
  let total = 0
  for (let index = 0; index < left.length; index += 1) total += left[index] * right[index]
  return total
}

async function assignCategories(
  items: PreparedItem[],
  definitions: Map<string, CategoryDefinition>,
  breathe: Breathe
): Promise<{ groups: Map<string, PreparedItem[]>; routes: AiCollectionRoute[] }> {
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
  // Chaque vidéo restante est comparée à tous les barycentres : l'autre passe coûteuse.
  for (const [index, item] of items.entries()) {
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
    if (index % BREATHE_EVERY === BREATHE_EVERY - 1) await breathe()
  }

  for (const [id, members] of [...groups]) {
    if (members.length < minimum || !definitions.has(id)) groups.delete(id)
  }

  const available = new Set(groups.keys())
  const routes: AiCollectionRoute[] = []
  for (const item of items) {
    const primary = assigned.get(item)
    if (!primary || !available.has(primary)) continue
    const rankedRuleKeys = [
      primary,
      ...item.choices.map((choice) => choice.id).filter((id) => available.has(id))
    ].filter((id, index, all) => all.indexOf(id) === index)
    routes.push({ postId: item.item.id, rankedRuleKeys })
  }
  return { groups, routes }
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
/** Vecteurs recentrés de la dernière analyse. La carte les réutilise plutôt que de réencoder
 *  toute la bibliothèque pour afficher les mêmes points. */
let lastSemanticVectors: Map<string, Float32Array> | null = null
/** Recette de la derniere analyse : en changer doit refaire la carte, pas la reprendre. */
/** Dernier plan produit. La carte le réutilise au lieu de relancer toute l'analyse. */
let lastPlan: AiCollectionPlan | null = null
/** Dernière projection. Rouvrir l'organisateur ne doit pas refaire neuf secondes de calcul. */
let lastProjection: ProjectedPoint[] | null = null

export async function buildLocalCollectionPlan(
  items: OrganizationItem[],
  visuals: Map<string, Float32Array | null> = new Map(),
  lang: Language = 'en',
  breathe: Breathe = NO_BREATHE,
  semantic: SemanticInput | null = null
): Promise<AiCollectionPlan> {
  const prepared: PreparedItem[] = []
  for (const [index, item] of items.entries()) {
    prepared.push({
      item,
      terms: prepareTerms(item),
      visual: visuals.get(item.id) ?? null,
      vector: semantic?.items.get(item.id) ?? null,
      choices: []
    })
    if (index % BREATHE_EVERY === BREATHE_EVERY - 1) await breathe()
  }
  const definitions = await createChoices(prepared, lang, breathe, semantic)
  const { groups, routes } = await assignCategories(prepared, definitions, breathe)
  const suggestions: AiCollectionSuggestion[] = [...groups]
    .sort((left, right) => right[1].length - left[1].length)
    .map(([id, members], index) => {
      const definition = definitions.get(id) as CategoryDefinition
      return {
        id: `local-${index}`,
        ruleKeys: [id],
        name: definition.name,
        description: categoryDescription(members, definition, lang),
        postIds: members.map((member) => member.item.id)
      }
    })
  const assigned = new Set(suggestions.flatMap((suggestion) => suggestion.postIds))
  return {
    suggestions,
    routes,
    analysedVideos: items.length,
    unassignedVideos: Math.max(0, items.length - assigned.size)
  }
}

/**
 * Retire du plan les vidéos que l'utilisateur avait sorties à la main de la collection que
 * cette catégorie alimente.
 *
 * Le chemin automatique honorait déjà ces retraits, mais l'écran de proposition, lui,
 * continuait de les afficher — et « tout appliquer » les remettait donc en place. Une
 * catégorie n'est reliée à une collection que par une règle mémorisée ou par son nom :
 * c'est exactement la résolution que fait l'application du plan, d'où le résolveur passé
 * en paramètre plutôt qu'un accès direct à la base.
 */
export function withoutRemovedPosts(
  plan: AiCollectionPlan,
  resolveCollectionId: (ruleKeys: string[], name: string) => number | null,
  removals: Map<number, Set<string>>
): AiCollectionPlan {
  if (removals.size === 0) return plan

  // Chaque règle apprend quelles vidéos elle n'a plus le droit de proposer.
  const blockedByRuleKey = new Map<string, Set<string>>()
  const suggestions = plan.suggestions.map((suggestion) => {
    const collectionId = resolveCollectionId(suggestion.ruleKeys, suggestion.name)
    const removed = collectionId === null ? undefined : removals.get(collectionId)
    if (!removed) return suggestion
    for (const ruleKey of suggestion.ruleKeys) {
      const blocked = blockedByRuleKey.get(ruleKey) ?? new Set<string>()
      for (const postId of removed) blocked.add(postId)
      blockedByRuleKey.set(ruleKey, blocked)
    }
    return { ...suggestion, postIds: suggestion.postIds.filter((postId) => !removed.has(postId)) }
  })

  // La redistribution suit : une vidéo écartée d'une catégorie ne doit pas y revenir par la
  // bande lorsqu'une autre catégorie est exclue.
  const routes = plan.routes.map((route) => ({
    ...route,
    rankedRuleKeys: route.rankedRuleKeys.filter(
      (ruleKey) => !blockedByRuleKey.get(ruleKey)?.has(route.postId)
    )
  }))

  const assigned = new Set(suggestions.flatMap((suggestion) => suggestion.postIds))
  return {
    suggestions: suggestions.filter((suggestion) => suggestion.postIds.length > 0),
    routes,
    analysedVideos: plan.analysedVideos,
    unassignedVideos: Math.max(0, plan.analysedVideos - assigned.size)
  }
}

/** Résolution identique à celle de l'application d'un plan : règle mémorisée, sinon nom. */
function organizerCollectionResolver(): (ruleKeys: string[], name: string) => number | null {
  const byRuleKey = new Map(
    organizerRules()
      .filter((rule) => !rule.ignored && rule.collectionId !== null)
      .map((rule) => [rule.ruleKey, rule.collectionId as number])
  )
  const byName = new Map(
    listCollections().map((collection) => [collection.name.toLocaleLowerCase(), collection.id])
  )
  return (ruleKeys, name) => {
    for (const ruleKey of ruleKeys) {
      const known = byRuleKey.get(ruleKey)
      if (known !== undefined) return known
    }
    return byName.get(name.trim().toLocaleLowerCase()) ?? null
  }
}

async function buildVideoCollectionProposal(): Promise<AiCollectionPlan> {
  const items = organizationItems()
  if (items.length === 0) {
    return { suggestions: [], routes: [], analysedVideos: 0, unassignedVideos: 0 }
  }

  const breathe = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

  setProgress({ stage: 'preparing', done: 0, total: items.length, running: true })
  const visuals = await loadVisuals(items)

  /* Le modèle peut manquer — pas encore téléchargé, ou hors ligne au premier lancement. Ce
     n'est pas une erreur : le tri par mots-clés reste entier, il rappelle simplement moins. */
  let semantic: SemanticInput | null = null
  /* Lu une seule fois : trois lectures servaient trois usages — le classement, la carte et la
     propagation — et chacune ramenait deux blobs pour chacun des 9 606 posts. */
  const images = postImageEmbeddings()
  try {
    setProgress({ stage: 'embedding', done: 0, total: items.length, running: true })
    const vectors = await embedItems(items, breathe, (progress) =>
      setProgress({
        stage: 'embedding',
        done: progress.done,
        total: progress.total,
        running: true
      })
    )
    if (vectors.size > 0) {
      // Les thèmes sont recentrés avec les posts : comparer un vecteur recentré à un vecteur
      // brut n'aurait aucun sens, les deux doivent vivre dans le même repère.
      const topicIds = TOPIC_DESCRIPTORS.map((topic) => topic.id)
      const topicVectors = await embedTexts(TOPIC_DESCRIPTORS.map((topic) => topic.text))
      const together = new Map(vectors)
      topicIds.forEach((id, index) => together.set(`topic:${id}`, topicVectors[index]))
      const centred = centreVectors(together)
      semantic = {
        items: new Map([...vectors.keys()].map((id) => [id, centred.get(id) as Float32Array])),
        topics: new Map(topicIds.map((id) => [id, centred.get(`topic:${id}`) as Float32Array])),
        vision: await visionTopics(images)
      }
      /* La carte voit les trois signaux ; le rapprochement aux thèmes n'en voit qu'un.
         Les thèmes sont des phrases : les comparer à un vecteur qui contient deux blocs
         d'image n'aurait pas de sens, ils ne vivent pas dans ce repère. La projection, elle,
         gagne à tout voir — c'est là que se joue « ce qui se ressemble est côte à côte ». */
      const placed = blend(vectors, images)
      if (lastSemanticVectors?.size !== placed.size) lastProjection = null
      lastSemanticVectors = placed
    }
  } catch (error) {
    console.warn('[magpie] Embeddings indisponibles, tri par mots-clés seul :', error)
  }

  setProgress({ stage: 'grouping', done: 0, total: items.length, running: true })
  const plan = await buildLocalCollectionPlan(items, visuals, language(), breathe, semantic)
  /* Ce que les mots n'ont pas su classer, les voisins d'image le savent souvent : un post
     sans légende montre pourtant la même chose que ceux qui l'entourent. La propagation
     n'ajoute jamais qu'à ce qui manquait. */
  const filled = propagateByImage(
    plan,
    images,
    items.map((item) => item.id)
  )
  if (filled.adopted > 0) {
    console.log(`[magpie] ${filled.adopted} posts classés par leurs voisins d'image`)
  }
  setProgress({ stage: 'grouping', done: items.length, total: items.length, running: true })
  lastPlan = withoutRemovedPosts(filled.plan, organizerCollectionResolver(), collectionRemovals())
  return lastPlan
}

/**
 * Le plan, plus une position pour chaque post.
 *
 * La carte n'est pas un second calcul : elle réutilise exactement les vecteurs et le plan de
 * l'analyse, et n'y ajoute qu'une projection. Un point et sa catégorie racontent donc la même
 * chose, ce qui serait faux si les deux étaient calculés séparément.
 */
export async function buildOrganizerMap(): Promise<OrganizerMap> {
  /* Le plan vient d'être calculé par l'écran qui nous appelle : le redemander relançait
     toute l'analyse une seconde fois — chargement des vignettes, regroupement, tout. */
  const plan = lastPlan ?? (await proposeVideoCollections())
  const vectors = lastSemanticVectors
  if (!vectors || vectors.size === 0) return { points: [], plan }

  try {
    if (!lastProjection || lastProjection.length !== vectors.size) {
      setProgress({ stage: 'projecting', done: 0, total: 100, running: true })
      lastProjection = await project(vectors, (done, total) =>
        setProgress({ stage: 'projecting', done, total, running: true })
      )
    }
  } finally {
    // Toujours, y compris sur échec : sinon l'indicateur reste violet et animé sans fin.
    setProgress({ stage: 'idle', done: 0, total: 0, running: false })
  }

  const groupOf = new Map<string, string>()
  for (const suggestion of plan.suggestions) {
    for (const postId of suggestion.postIds) groupOf.set(postId, suggestion.id)
  }
  const details = new Map(organizationItems().map((item) => [item.id, item]))

  return {
    plan,
    points: lastProjection.flatMap((point) => {
      const item = details.get(point.id)
      if (!item) return []
      return [
        {
          id: point.id,
          x: point.x,
          y: point.y,
          group: groupOf.get(point.id) ?? null,
          thumbUrl: item.thumbPath ? `magpie://thumb/${item.thumbPath}` : null,
          platform: item.platform,
          kind: item.kind,
          sources: item.sources
        }
      ]
    })
  }
}

export function proposeVideoCollections(): Promise<AiCollectionPlan> {
  if (currentProposal) return currentProposal
  currentProposal = buildVideoCollectionProposal().finally(() => {
    // Sans cela, une analyse qui échoue laisse la tâche « Organisation » affichée pour
    // toujours, et l'indicateur de téléchargement animé avec elle.
    setProgress({ stage: 'idle', done: 0, total: 0, running: false })
    currentProposal = null
    setProgress({ ...progress, running: false })
  })
  return currentProposal
}

let automaticApply: Promise<AiCollectionApplyResult> | null = null

export function rememberedOrganizerDestinations(
  routes: AiCollectionRoute[],
  rules: OrganizerRuleRow[],
  removals: Map<number, Set<string>> = new Map()
): Map<number, string[]> {
  const remembered = new Map(rules.map((rule) => [rule.ruleKey, rule]))
  const postsByCollection = new Map<number, string[]>()
  for (const route of routes) {
    const destination = route.rankedRuleKeys
      .map((ruleKey) => remembered.get(ruleKey))
      .find((rule) => rule && !rule.ignored && rule.collectionId !== null)
    if (!destination?.collectionId) continue
    // Un post que l'utilisateur a sorti de cette collection n'y retourne pas, et n'est pas
    // non plus reversé dans la destination suivante : il a écarté ce rangement-là, il n'a
    // pas demandé qu'on lui en cherche un autre.
    if (removals.get(destination.collectionId)?.has(route.postId)) continue
    const posts = postsByCollection.get(destination.collectionId) ?? []
    posts.push(route.postId)
    postsByCollection.set(destination.collectionId, posts)
  }
  return postsByCollection
}

/** Applique les destinations apprises sans recréer ni renommer les collections. */
export function applyRememberedOrganizerRules(): Promise<AiCollectionApplyResult> {
  if (automaticApply) return automaticApply
  const idle: AiCollectionApplyResult = {
    collections: 0,
    added: 0,
    alreadyThere: 0,
    joinedExisting: []
  }
  automaticApply = (async () => {
    const remembered = organizerRules()
    if (remembered.length === 0) return idle

    const plan = await proposeVideoCollections()
    const postsByCollection = rememberedOrganizerDestinations(
      plan.routes,
      remembered,
      collectionRemovals()
    )

    let added = 0
    let alreadyThere = 0
    /* Un rangement automatique se défaisait jusqu'ici sans trace : l'utilisateur voyait des
       posts apparaître dans ses collections après une synchronisation, sans rien pour les en
       sortir d'un geste. On l'enregistre comme un classement manuel. Seules les collections
       existantes sont concernées, donc rien à supprimer en annulant. */
    const filed: Array<{ collectionId: number; postIds: string[] }> = []
    for (const [collectionId, postIds] of postsByCollection) {
      const result = addToCollection(collectionId, postIds)
      added += result.added
      alreadyThere += result.alreadyThere.length
      const untouched = new Set(result.alreadyThere)
      const freshly = postIds.filter((postId) => !untouched.has(postId))
      if (freshly.length > 0) filed.push({ collectionId, postIds: freshly })
    }
    if (added > 0) {
      recordOrganizerApplication({
        collections: filed.length,
        posts: added,
        createdCollectionIds: [],
        filed
      })
    }
    return { collections: postsByCollection.size, added, alreadyThere, joinedExisting: [] }
  })().finally(() => {
    automaticApply = null
  })
  return automaticApply ?? Promise.resolve(idle)
}
