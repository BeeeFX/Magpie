/**
 * Les modèles, dans leur propre processus.
 *
 * `onnxruntime-node` exécute son `run` de façon **synchrone** : la promesse qu'il rend ne fait
 * que repousser l'appel d'un `setImmediate`, puis le calcul natif occupe le fil appelant
 * jusqu'au bout. Tant que ce fil était celui du processus principal, chaque lot d'embeddings,
 * chaque image encodée et chaque chargement de modèle bloquaient la fenêtre — 348 ms rien que
 * pour ouvrir `multilingual-e5-small`, mesuré. Windows déclare une fenêtre « ne répond pas » au
 * bout de cinq secondes ; on n'y était pas, mais on s'en approchait à chaque étape, et rien ne
 * garantissait qu'un modèle plus lourd ou une machine plus lente reste en deçà.
 *
 * Un `utilityProcess` plutôt qu'un `worker_thread`, pour trois raisons : le calcul natif d'ORT
 * ne partage plus rien avec la boucle d'événements de l'interface, une panne du modèle ne peut
 * plus emporter l'application, et les quelque cinq cents mégaoctets que les modèles retiennent
 * se rendent au système en tuant le processus — ce qu'un fil ne sait pas faire.
 *
 * Ce module ne touche ni la base ni les fichiers de la bibliothèque : il reçoit des chemins, du
 * texte et des échantillons, il rend des vecteurs. Tout ce qui décide *quoi* encoder reste du
 * côté du processus principal, avec la base.
 */

/* Les quatre noms de modèles vivent dans `models.ts` : la comptabilité du disque, la purge
   et le déplacement de bibliothèque ont besoin de la même liste, et une seconde copie est
   précisément ce qui a laissé cinq modèles abandonnés sur le disque. Ce module n'importe
   rien, donc le charger ici ne coûte rien au démarrage du processus. */
import { MEANING_MODEL, SPEECH_MODEL, STRUCTURE_MODEL, TEXT_MODEL } from './models'

/** Ce qu'on demande. `id` revient tel quel dans la réponse : c'est ce qui les apparie. */
export type InferenceRequest =
  | { id: number; kind: 'configure'; cacheDir: string }
  | { id: number; kind: 'embed'; texts: string[] }
  | { id: number; kind: 'encode-images'; paths: string[] }
  | { id: number; kind: 'encode-prompts'; prompts: string[] }
  | { id: number; kind: 'transcribe'; audio: Float32Array; language: string }

/**
 * Ce qu'on rend.
 *
 * Les blocs de vecteurs voyagent à plat, avec leur largeur : un tableau de tableaux typés se
 * recopie élément par élément à la traversée, un seul `Float32Array` d'un bloc.
 */
export type InferenceReply =
  | { id: number; ok: true; kind: 'done' }
  | { id: number; ok: true; kind: 'block'; flat: Float32Array; width: number }
  | { id: number; ok: true; kind: 'image'; structure: Float32Array; meaning: Float32Array }
  | { id: number; ok: true; kind: 'text'; text: string }
  | { id: number; ok: false; message: string }

/**
 * Le téléchargement des modèles, pendant qu'il se fait.
 *
 * Un premier rangement télécharge **688 Mo** — mesuré — et l'interface n'en disait rien :
 * « Préparation en cours… », un rond qui tourne, et huit minutes de silence sur une connexion
 * ordinaire. Rien ne distinguait ce cas d'une application figée.
 *
 * `id: 0` parce que ce message ne répond à aucune demande : c'est une diffusion. Les réponses
 * portent l'identifiant de la demande qu'elles closent, et zéro n'en est jamais un.
 */
export interface DownloadProgress {
  id: 0
  kind: 'download'
  /** Le fichier en cours, tel que la bibliothèque le nomme. */
  file: string
  loaded: number
  total: number
}

/** Préfixe attendu par la famille e5, des deux côtés pour une comparaison symétrique. */
const TEXT_PREFIX = 'query: '

export const STRUCTURE_DIMS = 384
export const MEANING_DIMS = 768

type Tensor = { data: Float32Array; dims: number[] }
type Vision = (input: unknown) => Promise<Record<string, Tensor>>

/**
 * Le dossier des modèles, dit par le processus principal.
 *
 * Il suit la bibliothèque et non le profil système : déplacer sa bibliothèque sur un autre
 * disque doit emporter les six cents mégaoctets de modèles avec elle. La transcription était
 * restée sur `userData` alors que le texte et les images avaient déménagé — deux dossiers
 * `models` à deux endroits, dont un que plus personne ne nettoyait.
 */
let cacheDir = ''

/** Chargé à la demande, une fois, et gardé : un modèle rouvert coûte le prix du démarrage. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let value: T | null = null
  let loading: Promise<T> | null = null
  return async () => {
    if (value) return value
    if (!loading) {
      loading = load().then((result) => {
        value = result
        loading = null
        return result
      }).catch((error: unknown) => {
        loading = null
        throw error
      })
    }
    return loading
  }
}

async function library(): Promise<typeof import('@huggingface/transformers')> {
  const transformers = await import('@huggingface/transformers')
  transformers.env.cacheDir = cacheDir
  transformers.env.allowLocalModels = false
  return transformers
}

type Extractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>

/**
 * Ce que la bibliothèque rapporte pendant un téléchargement, réémis vers l'hôte.
 *
 * On ne garde que `status: 'progress'` : les autres étapes — `initiate`, `done`, `ready` —
 * ne portent pas d'octets, et les relayer ferait clignoter la barre entre chaque fichier.
 */
function watchDownload(event: {
  status?: string
  file?: string
  loaded?: number
  total?: number
}): void {
  if (event.status !== 'progress' || !event.total) return
  const message: DownloadProgress = {
    id: 0,
    kind: 'download',
    file: event.file ?? '',
    loaded: event.loaded ?? 0,
    total: event.total
  }
  process.parentPort.postMessage(message)
}

const textEncoder = once(async (): Promise<Extractor> => {
  const { pipeline } = await library()
  return (await pipeline('feature-extraction', TEXT_MODEL, {
    dtype: 'q8',
    progress_callback: watchDownload
  })) as unknown as Extractor
})

interface Encoders {
  process(image: unknown): Promise<{ structure: unknown; meaning: unknown }>
  structure: Vision
  meaning: Vision
}

const imageEncoders = once(async (): Promise<Encoders> => {
  const { AutoModel, AutoProcessor, SiglipVisionModel } = await library()
  const [structureProcessor, structureModel, meaningModel] = await Promise.all([
    AutoProcessor.from_pretrained(STRUCTURE_MODEL, { progress_callback: watchDownload }),
    AutoModel.from_pretrained(STRUCTURE_MODEL, { dtype: 'q8', progress_callback: watchDownload }),
    SiglipVisionModel.from_pretrained(MEANING_MODEL, {
      dtype: 'q8',
      progress_callback: watchDownload
    })
  ])
  const meaningProcessor = await AutoProcessor.from_pretrained(MEANING_MODEL, {
    progress_callback: watchDownload
  })
  return {
    process: async (image) => ({
      structure: await structureProcessor(image as never),
      meaning: await meaningProcessor(image as never)
    }),
    structure: (input) => structureModel(input as never) as never,
    meaning: (input) => meaningModel(input as never) as never
  }
})

type Tower = (prompts: string[]) => Promise<{ flat: Float32Array; width: number }>

const promptEncoder = once(async (): Promise<Tower> => {
  const { AutoTokenizer, SiglipTextModel } = await library()
  const tokenizer = await AutoTokenizer.from_pretrained(MEANING_MODEL, {
    progress_callback: watchDownload
  })
  const model = await SiglipTextModel.from_pretrained(MEANING_MODEL, {
    dtype: 'q8',
    progress_callback: watchDownload
  })
  return async (prompts) => {
    /* SigLIP est entraîné avec un remplissage fixe à 64 jetons. Laisser le remplissage par
       défaut décale les positions et rend les vecteurs inutilisables : mesuré, la justesse
       tombe au niveau du hasard. */
    const inputs = tokenizer(prompts, { padding: 'max_length', max_length: 64, truncation: true })
    const output = (await model(inputs as never)) as unknown as {
      pooler_output: { dims: number[]; data: Float32Array }
    }
    const [count, width] = output.pooler_output.dims
    const flat = new Float32Array(count * width)
    for (let index = 0; index < count; index += 1) {
      flat.set(unit(output.pooler_output.data.slice(index * width, (index + 1) * width)), index * width)
    }
    return { flat, width }
  }
})

type Recogniser = (
  audio: Float32Array,
  options: { language: string; task: 'transcribe'; chunk_length_s: number; stride_length_s: number }
) => Promise<{ text?: string }>

const speechRecogniser = once(async (): Promise<Recogniser> => {
  const { pipeline } = await library()
  return (await pipeline('automatic-speech-recognition', SPEECH_MODEL, {
    dtype: 'q8',
    progress_callback: watchDownload
  })) as unknown as Recogniser
})

function unit(raw: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < raw.length; i += 1) norm += raw[i] * raw[i]
  norm = Math.sqrt(norm) || 1
  const out = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw[i] / norm
  return out
}

/**
 * Encode une ou plusieurs images d'un même post, et rend la moyenne.
 *
 * Pour une vidéo, trois images valent bien mieux qu'une couverture : le début ne dit souvent
 * rien de la suite. Moyenner des vecteurs unitaires puis renormaliser donne le centre de ce que
 * le post montre.
 */
async function encodeImages(
  paths: string[]
): Promise<{ structure: Float32Array; meaning: Float32Array }> {
  const { RawImage } = await library()
  const models = await imageEncoders()
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
    throw new Error(
      `aucune image lisible (${unreadable ?? `aucun chemin fourni pour ${paths.length} image(s)`})`
    )
  }
  return { structure: unit(structure), meaning: unit(meaning) }
}

async function answer(request: InferenceRequest): Promise<InferenceReply> {
  const { id } = request
  if (request.kind === 'configure') {
    cacheDir = request.cacheDir
    return { id, ok: true, kind: 'done' }
  }
  if (request.kind === 'embed') {
    const encode = await textEncoder()
    const output = await encode(
      request.texts.map((text) => `${TEXT_PREFIX}${text}`),
      { pooling: 'mean', normalize: true }
    )
    const width = output.dims[output.dims.length - 1]
    /* Recopié : la sortie du modèle est une vue sur un tampon qu'il réutilise. */
    return { id, ok: true, kind: 'block', flat: Float32Array.from(output.data), width }
  }
  if (request.kind === 'encode-images') {
    const { structure, meaning } = await encodeImages(request.paths)
    return { id, ok: true, kind: 'image', structure, meaning }
  }
  if (request.kind === 'encode-prompts') {
    const encode = await promptEncoder()
    const { flat, width } = await encode(request.prompts)
    return { id, ok: true, kind: 'block', flat, width }
  }
  const recognise = await speechRecogniser()
  const output = await recognise(request.audio, {
    task: 'transcribe',
    // Sans langue explicite, Whisper écoute tout en anglais et invente le reste.
    language: request.language,
    // Whisper ne lit que trente secondes d'un coup ; le recouvrement évite de couper un mot
    // à la frontière de deux tranches.
    chunk_length_s: 30,
    stride_length_s: 5
  })
  return { id, ok: true, kind: 'text', text: String(output.text ?? '') }
}

process.parentPort.on('message', (event) => {
  const request = event.data as InferenceRequest
  void answer(request)
    .then((reply) => process.parentPort.postMessage(reply))
    .catch((error: unknown) => {
      process.parentPort.postMessage({
        id: request.id,
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      } satisfies InferenceReply)
    })
})
