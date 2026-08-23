import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { mediaDir } from '../db'
import type { PostFrames } from './frames'
import {
  organizationItems,
  postImageEmbeddings,
  postImageHashes,
  savePostImageEmbeddings,
  type PostImageEmbedding
} from '../db/queries'

/**
 * Ce que le post *montre*, quand sa légende ne dit rien.
 *
 * Un tiers de la bibliothèque de référence n'a aucun texte exploitable — 9 % rien du tout,
 * 26 % moins de vingt-cinq caractères une fois liens, emojis et arobases retirés. Ces posts
 * ne se ressemblent pas : ils se ressemblent *par le vide*, le modèle de texte lisant à peu
 * près la même chose pour tous. Mesuré : 0,894 de similarité moyenne entre eux, contre 0,836
 * dans la bibliothèque entière. Ils s'agglutinaient donc sur la carte sans rien avoir en
 * commun. Les vignettes, elles, sont déjà sur le disque.
 *
 * Deux encodeurs plutôt qu'un, parce qu'ils ne regardent pas la même chose et que la paire
 * mesure mieux que chacun seul — 3,85 écarts-types entre deux images d'un même carrousel et
 * deux images au hasard, contre 3,49 et 2,96 (cf. `scripts/bench-vision-mix`).
 */

/** La structure et le style. Le plus petit des candidats, et le meilleur : 23 Mo, 26 ms. */
const STRUCTURE_MODEL = 'Xenova/dinov2-small'
/** Le sujet. Sait aussi comparer une image à des mots, ce que DINOv2 ne sait pas faire. */
const MEANING_MODEL = 'Xenova/siglip-base-patch16-224'
/** Entre dans le hash : changer de modèle doit tout réencoder, et rien d'autre ne le doit. */
const VERSION = `${STRUCTURE_MODEL}|${MEANING_MODEL}|q8|v1`

/** L'empreinte d'une lecture, à partir de ce qui l'identifie. */
const hashFor = (identity: string): string =>
  createHash('sha1').update(`${VERSION} ${identity}`).digest('hex').slice(0, 16)

/** Ce qui identifie la lecture d'un post illustré par un clip déjà en cache. */
const clipIdentity = (videoPath: string, frames: number): string =>
  `clip:${videoPath}:${frames}`

/**
 * Les clips dont il faut réellement tirer des images.
 *
 * Répondu sans lancer ffmpeg une seule fois, en comparant l'empreinte déjà en base à celle
 * que cette lecture porterait. C'est ce qui manquait : l'extraction traitait les 4 440 clips
 * du cache à chaque passe, y compris ceux lus la veille, puis jetait le tout en sortant.
 * Une bibliothèque déjà lue redemandait donc une vingtaine de minutes de ffmpeg pour
 * n'écrire aucune ligne — l'étape se donnait « à refaire » indéfiniment.
 *
 * Le nombre d'images retenues entre dans l'empreinte, et il n'est connu qu'après extraction.
 * Mais il est aussi rangé en base à côté du hash : la comparaison reste donc exacte, et
 * aucune empreinte déjà écrite ne change de valeur.
 */
export function framesNeeded(clips: { postId: string; videoPath: string }[]): Set<string> {
  const known = postImageHashes()
  const out = new Set<string>()
  for (const clip of clips) {
    const stored = known.get(clip.postId)
    if (!stored || stored.hash !== hashFor(clipIdentity(clip.videoPath, stored.frames))) {
      out.add(clip.postId)
    }
  }
  return out
}

export const STRUCTURE_DIMS = 384
export const MEANING_DIMS = 768

type Tensor = { data: Float32Array; dims: number[] }
type Vision = (input: unknown) => Promise<Record<string, Tensor>>
interface Encoders {
  process(image: unknown): Promise<{ structure: unknown; meaning: unknown }>
  structure: Vision
  meaning: Vision
}

let loaded: Encoders | null = null
let loading: Promise<Encoders> | null = null

/** Charge les deux modèles, une fois. Le premier appel les télécharge. */
async function load(): Promise<Encoders> {
  if (loaded) return loaded
  if (loading) return loading
  loading = (async () => {
    const { AutoModel, AutoProcessor, SiglipVisionModel, env } = await import(
      '@huggingface/transformers'
    )
    // Tout vit dans le dossier de données de Magpie, comme le modèle de texte.
    env.cacheDir = join(mediaDir(), '..', 'models')
    env.allowLocalModels = false
    const [structureProcessor, structureModel, meaningModel] = await Promise.all([
      AutoProcessor.from_pretrained(STRUCTURE_MODEL),
      AutoModel.from_pretrained(STRUCTURE_MODEL, { dtype: 'q8' }),
      SiglipVisionModel.from_pretrained(MEANING_MODEL, { dtype: 'q8' })
    ])
    const meaningProcessor = await AutoProcessor.from_pretrained(MEANING_MODEL)
    const encoders: Encoders = {
      process: async (image) => ({
        structure: await structureProcessor(image as never),
        meaning: await meaningProcessor(image as never)
      }),
      structure: (input) => structureModel(input as never) as never,
      meaning: (input) => meaningModel(input as never) as never
    }
    loaded = encoders
    loading = null
    return encoders
  })()
  return loading
}

function unit(raw: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < raw.length; i += 1) norm += raw[i] * raw[i]
  norm = Math.sqrt(norm) || 1
  const out = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw[i] / norm
  return out
}

function toBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

export function toVector(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))
}

/**
 * Encode une ou plusieurs images d'un même post, et rend la moyenne.
 *
 * Pour une vidéo, trois images valent bien mieux qu'une couverture : le début ne dit
 * souvent rien de la suite. Moyenner des vecteurs unitaires puis renormaliser donne le
 * centre de ce que le post montre.
 */
async function encode(paths: string[]): Promise<{ structure: Float32Array; meaning: Float32Array }> {
  const { RawImage } = await import('@huggingface/transformers')
  const models = await load()
  const structure = new Float32Array(STRUCTURE_DIMS)
  const meaning = new Float32Array(MEANING_DIMS)
  let counted = 0
  /* Pourquoi la première image a résisté. Les autres peuvent suffire, donc on continue — mais
     si aucune ne passe, c'est la seule chose qu'on saura, et il faut donc l'avoir gardée.
     Ce `catch` était vide : toute la bibliothèque échouait sur « aucune image lisible », un
     message qui ne dit ni quel fichier ni quelle cause, et qui a envoyé chercher la panne
     partout sauf là où elle était. */
  let unreadable: string | null = null
  for (const path of paths) {
    let image
    try {
      image = await RawImage.read(path)
    } catch (error) {
      // Vignette évincée entre le relevé et la lecture : les autres suffisent.
      unreadable ??= `${path} → ${error instanceof Error ? error.message : String(error)}`
      continue
    }
    const inputs = await models.process(image)
    const structureOut = await models.structure(inputs.structure)
    const meaningOut = await models.meaning(inputs.meaning)
    /* DINOv2 : le jeton CLS porte le résumé de l'image, les suivants décrivent des zones.
       SigLIP expose directement sa sortie réduite. */
    const hidden = structureOut.last_hidden_state
    const clsWidth = hidden.dims[hidden.dims.length - 1]
    const cls = unit(hidden.data.slice(0, clsWidth))
    const pooled = unit(meaningOut.pooler_output.data)
    for (let i = 0; i < STRUCTURE_DIMS; i += 1) structure[i] += cls[i]
    for (let i = 0; i < MEANING_DIMS; i += 1) meaning[i] += pooled[i]
    counted += 1
  }
  /* Distinguer les deux « zéro image » : aucun chemin à lire n'est pas la même panne qu'un
     chemin qu'on n'a pas su ouvrir, et les confondre coûtait une passe entière à chaque fois. */
  if (counted === 0) {
    throw new Error(`aucune image lisible (${unreadable ?? `aucun chemin fourni pour ${paths.length} image(s)`})`)
  }
  return { structure: unit(structure), meaning: unit(meaning) }
}

export interface VisionProgress {
  done: number
  total: number
}

/**
 * Lit les images de tous les posts qui en ont une et dont la lecture manque.
 *
 * Reprend là où elle s'est arrêtée : ce qui est déjà en base et dont la vignette n'a pas
 * changé n'est jamais relu. Une bibliothèque déjà lue coûte donc le temps d'une requête.
 */
export async function readImages(options: {
  framesFor?: (postId: string) => PostFrames | null
  /** Le clip en cache d'un post, extraction ou non. Voir `identityOf`. */
  clipOf?: (postId: string) => string | null
  onProgress?: (progress: VisionProgress) => void
  shouldStop?: () => boolean
}): Promise<{
  done: number
  total: number
  stopped: boolean
  failed?: number
  firstError?: string | null
}> {
  const known = postImageEmbeddings()
  const items = organizationItems().filter((item) => item.thumbPath)
  /* Les chemins décidés une fois : la couverture, ou les images tirées du clip quand il est
     en cache. */
  const framesOf = (id: string, cover: string): string[] =>
    options.framesFor?.(id)?.paths ?? [join(mediaDir(), cover)]
  /*
   * Ce qui identifie la lecture d'un post — et donc ce qui décide s'il faut la refaire.
   *
   * Deux différences avec les chemins qu'on vient de décider, et les deux comptent.
   * Le clip plutôt que les images qu'on en tire : celles-ci vivent dans un dossier de
   * travail recréé à chaque session sous un nom tiré au hasard, si bien que l'empreinte
   * d'un post illustré par une vidéo changeait à tout coup. Aucun des 4 440 posts concernés
   * ne pouvait donc se retrouver « déjà lu » : la reprise annoncée plus haut ne valait que
   * pour les images fixes, et chaque passe recommençait les vidéos de zéro.
   * La vignette en chemin relatif plutôt qu'absolu, ensuite : déplacer la bibliothèque
   * changeait toutes les empreintes d'un coup, et redemandait la lecture entière.
   */
  const identityOf = (id: string, cover: string): string => {
    const frames = options.framesFor?.(id)
    if (frames) return clipIdentity(frames.source, frames.paths.length)
    /* Le clip est en cache, mais aucune image n'en a été tirée : c'est que l'extraction l'a
       sauté, et elle ne saute que ce qui est déjà lu. Reprendre l'empreinte rangée en base
       le laisse hors de la liste. Sans ce détour il retomberait sur sa vignette, donc sur
       une autre empreinte, donc dans les posts à lire — et chaque passe aurait réencodé les
       clips qu'elle venait justement de s'épargner. */
    const clip = options.clipOf?.(id)
    const stored = known.get(id)
    if (clip && stored) return clipIdentity(clip, stored.frames)
    return cover
  }
  const hashOf = (id: string, cover: string): string => hashFor(identityOf(id, cover))
  const pending = items.filter((item) => {
    return known.get(item.id)?.hash !== hashOf(item.id, item.thumbPath as string)
  })
  const total = pending.length
  if (total === 0) return { done: 0, total: 0, stopped: false }

  const batch: PostImageEmbedding[] = []
  let done = 0
  let failed = 0
  let firstError: string | null = null
  for (const item of pending) {
    if (options.shouldStop?.()) {
      savePostImageEmbeddings(batch)
      /* Les échecs repartent avec le reste, même ici. Cette sortie-là les laissait derrière
         elle : une passe interrompue dont *tout* échouait rendait un compte rendu propre —
         tant de lus, aucune erreur — alors qu'elle n'avait rien pu écrire. C'est le même
         silence que celui corrigé plus bas, par la même porte de derrière. */
      if (failed > 0) console.warn(`[magpie] ${failed} images illisibles sur ${done} lues : ${firstError}`)
      return { done, total, stopped: true, failed, firstError }
    }
    const paths = framesOf(item.id, item.thumbPath as string)
    const hash = hashOf(item.id, item.thumbPath as string)
    try {
      const { structure, meaning } = await encode(paths)
      batch.push({
        postId: item.id,
        hash,
        structure: toBuffer(structure),
        meaning: toBuffer(meaning),
        frames: paths.length
      })
    } catch (error) {
      /* Un post illisible ne doit pas arreter la passe. Mais avaler l'erreur en silence
         rendait le defaut invisible : quand *tous* echouent — modele qui ne charge pas,
         dossier introuvable — la passe tournait plusieurs minutes, n'ecrivait rien, et
         s'annoncait terminee. On retient donc la premiere cause et on les compte. */
      failed += 1
      if (!firstError) firstError = error instanceof Error ? error.message : String(error)
    }
    done += 1
    /* Vingt échecs d'affilée sans un seul succès : ce n'est plus une vignette abîmée, c'est
       une panne systématique — modèles qui ne chargent pas, dossier introuvable, chemins
       faux. Poursuivre sur neuf mille posts ne changera rien au résultat et ne fait que
       retarder d'un quart d'heure la seule chose utile : la cause. */
    if (failed >= 20 && failed === done) {
      throw new Error(`lecture impossible dès le départ (${failed} échecs d'affilée) : ${firstError}`)
    }
    /* Écriture par paquets : une transaction par post rendait la passe deux fois plus
       lente que le calcul lui-même. */
    if (batch.length >= 64) {
      savePostImageEmbeddings(batch)
      batch.length = 0
    }
    if (done % 16 === 0 || done === total) options.onProgress?.({ done, total })
  }
  savePostImageEmbeddings(batch)
  /* Rien d'ecrit alors qu'on a tout parcouru : ce n'est pas une passe reussie, c'est une
     panne. Elle doit remonter, pas s'afficher comme terminee. */
  if (failed === total && total > 0) {
    throw new Error(`aucune image n'a pu etre lue (${failed} echecs) : ${firstError ?? 'cause inconnue'}`)
  }
  if (failed > 0) console.warn(`[magpie] ${failed} images illisibles sur ${total} : ${firstError}`)
  return { done, total, stopped: false, failed, firstError }
}

/**
 * Les trois signaux réunis en un seul vecteur, pour la carte et pour le regroupement.
 *
 * Deux précautions, toutes deux mesurées (cf. `scripts/bench-blend`).
 *
 * **Centrer chaque bloc.** Leurs ressemblances n'ont pas le même étalement — 0,026 pour le
 * texte, 0,113 pour la structure, 0,086 pour le sujet. Or ce qui classe les voisins est
 * l'étalement, pas la moyenne : à poids égaux, l'image imposait quatre fois plus son ordre
 * que le texte. Retirer le vecteur moyen du bloc enlève ce fond commun et ramène les trois
 * dans le même registre — 0,103 / 0,106 / 0,116.
 *
 * **Puis renormaliser par post.** Garder la longueur du résidu ferait office de confiance —
 * une légende vide tombe sur la moyenne, son résidu est minuscule — mais ne rapporte rien à
 * la mesure (17,0 % contre 16,8) et coûte un défaut : la projection travaillant en distance
 * euclidienne, tous les posts peu informatifs se retrouveraient près de l'origine, donc
 * agglutinés au centre de la carte. C'est exactement le défaut qu'on corrige.
 *
 * Sans ces deux précautions, le mélange fait *moins bien que le texte seul* : 9,2 % contre
 * 12,3. Avec, et aux poids ci-dessous : 16,8 %.
 *
 * Ces poids ont longtemps été un réglage parmi huit, exposé dans l'interface faute de savoir
 * lequel valait le mieux. La question est tranchée : rejouées sur la bibliothèque entière une
 * fois les images enfin lues, les huit se classent de 17,6 % à 5,6 %, et celles-ci arrivent
 * premières — devant « sujet » à 15,8 et « image » à 14,0, cette dernière faisant même moins
 * bien que le texte seul. Les sept autres ont donc été retirées ; `scripts/bench-recipes`
 * garde leur table et rejoue le classement.
 */
export const BLEND = { text: 0.6, structure: 0.1, meaning: 0.3 }

/**
 * Les regards possibles sur la carte de l'écran principal.
 *
 * À ne pas confondre avec `BLEND`, qui reste le seul mélange de la fenêtre d'organisation :
 * là, il s'agit de **classer**, et il y a une bonne réponse — mesurée, 17,6 % de precision@10
 * contre 14,0 pour « image ». Ici il s'agit d'**explorer**, et l'intention change d'un moment à
 * l'autre : on cherche parfois ce qui parle du même sujet, parfois ce qui se ressemble
 * graphiquement. Aucune mesure ne tranche entre deux intentions.
 *
 * Les autres poids sont dans `scripts/bench-recipes` avec leur classement, pour qu'on sache ce
 * qu'on perd en précision quand on choisit un regard plutôt que le meilleur.
 */
export const MAP_LAYOUTS = {
  /** Le meilleur à la mesure. Le défaut. */
  equilibre: BLEND,
  /** Ce que l'image représente prend la main. */
  sujet: { text: 0.4, structure: 0, meaning: 0.6 },
  /** L'allure : composition, palette, trait. Regroupe ce qui *se ressemble*. */
  style: { text: 0.45, structure: 0.4, meaning: 0.15 },
  /** Sans les images. Le comportement d'avant 0.18, utile comme point de comparaison. */
  texte: { text: 1, structure: 0, meaning: 0 }
} as const

export type MapLayout = keyof typeof MAP_LAYOUTS

/**
 * Le regard demandé, ramené à un regard connu.
 *
 * Il arrivait du renderer et était casté sans regarder. C'était à peu près sans conséquence
 * tant qu'un regard inconnu ne produisait qu'un mélange vide ; depuis que les projections se
 * rangent par regard, cette chaîne devient une **clé en base**, et n'importe quoi y entrerait.
 */
export function asMapLayout(value: unknown): MapLayout {
  return typeof value === 'string' && value in MAP_LAYOUTS ? (value as MapLayout) : 'equilibre'
}

/**
 * Ce que SigLIP sait faire et dont personne ne se servait : comparer une image à des mots.
 *
 * Le classement en thèmes ne voyait que le texte du post, parce que les thèmes sont des
 * phrases et qu'un vecteur d'image ne vit pas dans le même repère. SigLIP, lui, a été
 * entraîné pour que les deux vivent dans le *même* : c'est la raison pour laquelle il avait
 * été retenu plutôt qu'un encodeur d'images seul. Sa tour texte restait inutilisée.
 *
 * Mesuré sur 1 347 posts dont le texte donne un thème sans ambiguïté : à partir de la seule
 * image, elle retrouve ce thème dans 43,7 % des cas et le place dans les trois premiers
 * 71,2 % du temps — contre 3,7 % au hasard sur 27 thèmes.
 *
 * Un coût à connaître : la tour texte est un téléchargement de 111 Mo, en plus des deux
 * encodeurs d'images. Il n'a lieu qu'une fois, et seulement si des images ont été lues.
 */
interface TextTower {
  encode: (prompts: string[]) => Promise<Float32Array[]>
}

let textTower: TextTower | null = null
let textTowerLoading: Promise<TextTower> | null = null

async function loadTextTower(): Promise<TextTower> {
  if (textTower) return textTower
  if (!textTowerLoading) {
    textTowerLoading = (async () => {
      const { AutoTokenizer, SiglipTextModel, env } = await import('@huggingface/transformers')
      env.cacheDir = join(mediaDir(), '..', 'models')
      env.allowLocalModels = false
      const tokenizer = await AutoTokenizer.from_pretrained(MEANING_MODEL)
      const model = await SiglipTextModel.from_pretrained(MEANING_MODEL, { dtype: 'q8' })
      const tower: TextTower = {
        encode: async (prompts: string[]): Promise<Float32Array[]> => {
          /* SigLIP est entraîné avec un remplissage fixe à 64 jetons. Laisser le
             remplissage par défaut décale les positions et rend les vecteurs inutilisables :
             mesuré, la justesse tombe au niveau du hasard. */
          const inputs = tokenizer(prompts, {
            padding: 'max_length',
            max_length: 64,
            truncation: true
          })
          const output = (await model(inputs as never)) as unknown as {
            pooler_output: { dims: number[]; data: Float32Array }
          }
          const [count, width] = output.pooler_output.dims
          const flat = output.pooler_output.data
          return Array.from({ length: count }, (_, index) =>
            unit(Float32Array.from(flat.slice(index * width, (index + 1) * width)))
          )
        }
      }
      textTower = tower
      textTowerLoading = null
      return tower
    })()
  }
  return await textTowerLoading
}

/**
 * Les thèmes, vus par SigLIP, dans le repère des images.
 *
 * Le libellé compte, et beaucoup : les descripteurs du classement textuel — nom du thème
 * suivi de dix mots-clés — ne rendent que 24,1 %, là où la phrase nue « a photo of … » en
 * rend 43,7. SigLIP a appris sur des légendes de photos, pas sur des listes de mots.
 */
export async function encodeTopicPrompts(prompts: string[]): Promise<Float32Array[]> {
  const tower = await loadTextTower()
  return tower.encode(prompts)
}

/**
 * À quel point chaque thème se détache, pour cette image.
 *
 * Le cosinus brut ne se compare pas d'un post à l'autre : il vaut 0,040 en moyenne pour le
 * bon thème, mais son étalement d'une image à l'autre dépasse l'écart entre bon et mauvais
 * thème. On le standardise donc sur les thèmes du post lui-même — le score répond alors à
 * « ce thème se détache-t-il, pour cette image », ce qui est comparable partout.
 */
export function topicStandoff(meaning: Float32Array, topics: Float32Array[]): number[] {
  const sims = topics.map((topic) => {
    let total = 0
    for (let i = 0; i < topic.length; i += 1) total += topic[i] * meaning[i]
    return total
  })
  const mean = sims.reduce((a, b) => a + b, 0) / sims.length
  const spread =
    Math.sqrt(sims.reduce((a, b) => a + (b - mean) ** 2, 0) / sims.length) || 1
  return sims.map((value) => (value - mean) / spread)
}

/**
 * Le centre d'un nuage de vecteurs.
 *
 * Public parce qu'un prototype de collection doit être centré par **la même** moyenne que les
 * posts qu'il va noter. Le centrage n'est pas un détail de mise en forme : c'est lui qui étale
 * les distances dans un espace anisotrope, et deux vecteurs centrés par deux moyennes
 * différentes ne se comparent plus.
 */
export function blockMean(vectors: Float32Array[]): Float64Array {
  const dims = vectors[0]?.length ?? 0
  const mean = new Float64Array(dims)
  if (vectors.length === 0) return mean
  for (const vector of vectors) {
    for (let i = 0; i < dims; i += 1) mean[i] += vector[i] / vectors.length
  }
  return mean
}

/** Retire un centre donné, puis renormalise. */
export function centreBy(vector: Float32Array, mean: Float64Array): Float32Array {
  const out = new Float32Array(vector.length)
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] - (mean[i] ?? 0)
  return unit(out)
}

function centred(vectors: Float32Array[]): Float32Array[] {
  if (vectors.length === 0) return []
  const mean = blockMean(vectors)
  return vectors.map((vector) => centreBy(vector, mean))
}

/**
 * Un vecteur par post, prêt pour la projection et le regroupement.
 *
 * Un post sans image garde son texte à pleine force : lui coller un bloc image nul le
 * rapprocherait de tous les autres posts sans image, ce qui recréerait l'agglutination par
 * le vide qu'on cherche à défaire.
 */
export function blend(
  text: Map<string, Float32Array>,
  images: Map<string, PostImageEmbedding>,
  weights: { text: number; structure: number; meaning: number } = BLEND
): Map<string, Float32Array> {
  const ids = [...text.keys()]
  if (ids.length === 0) return new Map()
  const illustrated = ids.filter((id) => images.has(id))
  const textBlock = centred(ids.map((id) => text.get(id) as Float32Array))
  const structureBlock = centred(
    illustrated.map((id) => toVector((images.get(id) as PostImageEmbedding).structure))
  )
  const meaningBlock = centred(
    illustrated.map((id) => toVector((images.get(id) as PostImageEmbedding).meaning))
  )
  const structureAt = new Map(illustrated.map((id, index) => [id, structureBlock[index]]))
  const meaningAt = new Map(illustrated.map((id, index) => [id, meaningBlock[index]]))

  const width = textBlock[0].length
  const out = new Map<string, Float32Array>()
  /* La racine, et non le poids lui-même : mettre deux blocs côte à côte fait que leur
     ressemblance est la *somme des produits*, donc chaque bloc multiplié par `w` contribue
     en `w²`. Appliquer 0,6 / 0,1 / 0,3 directement revenait à peser 0,36 / 0,01 / 0,09 —
     mesuré à 15,9 % au lieu de 16,8. */
  const share = {
    text: Math.sqrt(weights.text),
    structure: Math.sqrt(weights.structure),
    meaning: Math.sqrt(weights.meaning)
  }
  ids.forEach((id, index) => {
    // Une recette peut annuler un bloc : il ne doit alors pas peser, même à zéro près.
    const structure = weights.structure > 0 ? structureAt.get(id) : undefined
    const meaning = weights.meaning > 0 ? meaningAt.get(id) : undefined
    const vector = new Float32Array(width + STRUCTURE_DIMS + MEANING_DIMS)
    /* Le texte reprend tout le poids quand le post n'a *aucun* bloc d'image — sans quoi il
       resterait seul avec une fraction de lui-même et se rapprocherait des autres posts sans
       image, ce qui est l'agglutination par le vide qu'on corrige.
       Exiger les *deux* blocs, ce que faisait la version précédente, se retournait dès qu'une
       recette en annulait un : « sujet » supprime la structure, et le texte repassait alors
       à pleine force au lieu des 0,4 demandés. La recette ne faisait pas ce qu'elle disait. */
    const illustrated = Boolean(structure || meaning)
    const textWeight = illustrated ? share.text : 1
    for (let i = 0; i < width; i += 1) vector[i] = textBlock[index][i] * textWeight
    if (structure) {
      for (let i = 0; i < STRUCTURE_DIMS; i += 1) {
        vector[width + i] = structure[i] * share.structure
      }
    }
    if (meaning) {
      for (let i = 0; i < MEANING_DIMS; i += 1) {
        vector[width + STRUCTURE_DIMS + i] = meaning[i] * share.meaning
      }
    }
    out.set(id, vector)
  })
  return out
}
