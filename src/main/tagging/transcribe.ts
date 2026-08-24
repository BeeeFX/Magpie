import { spawn } from 'node:child_process'
import { app } from 'electron'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { getDb, mediaDir } from '../db'
import { interfaceLanguage } from '../settings'
import {
  captionLanguage,
  listeningLanguage,
  tidyTranscript,
  type Listening
} from './transcript-text'
import { backgroundTasks } from '../tasks'

/**
 * Transcription locale de l'audio des vidéos.
 *
 * Sur la bibliothèque de référence, un quart des vidéos n'a aucune prose exploitable : la
 * légende médiane fait douze mots d'accroche là où trente secondes de parole en portent
 * quatre-vingts sur le sujet réel. C'est le plus gros gain de signal disponible, et il sert
 * trois choses à la fois — le regroupement, la recherche plein texte, et l'export.
 *
 * Tout est local : le modèle est téléchargé une fois puis lu depuis le disque, et aucun
 * audio ne quitte la machine. Le seul trafic est la descente des vidéos elles-mêmes.
 */

/** `tiny` transcrit mal le français ; `small` triple le coût pour un gain modeste. */
const MODEL = 'Xenova/whisper-base'
/** Whisper travaille en 16 kHz mono, un flottant par échantillon. */
const SAMPLE_RATE = 16_000
/** Au-delà, un reel n'est plus un reel : on évite qu'une vidéo d'une heure bloque la file. */
const MAX_SECONDS = 600
/**
 * Combien de fois insister avant de renoncer.
 *
 * Un échec de lecture n'est pas un verdict : le clip n'est peut-être pas encore descendu, et
 * l'audio est alors tiré de l'URL de la plateforme, qui expire. Trois essais laissent au
 * téléchargement le temps d'arriver sans qu'une vidéo réellement illisible occupe la file
 * pour toujours.
 */
const MAX_ATTEMPTS = 3
/** Reconnaissances refusées d'affilée avant de conclure à la panne et d'arrêter la passe. */
const GIVE_UP = 5

type Recogniser = (
  audio: Float32Array,
  options: { language: string; task: 'transcribe'; chunk_length_s: number; stride_length_s: number }
) => Promise<{ text?: string }>

let recogniser: Recogniser | null = null
let loading: Promise<Recogniser> | null = null

async function load(): Promise<Recogniser> {
  if (recogniser) return recogniser
  if (loading) return loading
  loading = (async () => {
    const { env, pipeline } = await import('@huggingface/transformers')
    env.cacheDir = join(app.getPath('userData'), 'models')
    env.allowLocalModels = false
    const pipe = await pipeline('automatic-speech-recognition', MODEL, { dtype: 'q8' })
    recogniser = pipe as unknown as Recogniser
    return recogniser
  })()
  try {
    return await loading
  } finally {
    loading = null
  }
}

/**
 * Extrait la piste audio, en 16 kHz mono, sans jamais écrire la vidéo sur le disque.
 *
 * ffmpeg lit le fichier local s'il existe, sinon le flux distant, et n'en sort que du son.
 * C'est ce qui permet de transcrire sans conserver les clips : le MP4 transite, seul un
 * tableau d'échantillons en mémoire lui survit — et rien ne touche la limite de cache.
 */
export function extractAudio(source: string, signal?: AbortSignal): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath as string,
      [
        '-nostdin',
        '-loglevel', 'error',
        '-t', String(MAX_SECONDS),
        '-i', source,
        '-vn',
        '-ac', '1',
        '-ar', String(SAMPLE_RATE),
        '-f', 'f32le',
        'pipe:1'
      ],
      { windowsHide: true }
    )

    const chunks: Buffer[] = []
    let bytes = 0
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      bytes += chunk.length
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(0, 400)
    })

    const stop = (): void => {
      child.kill('SIGKILL')
      reject(new Error('Transcription interrompue.'))
    }
    signal?.addEventListener('abort', stop, { once: true })

    child.on('error', reject)
    child.on('close', (code) => {
      signal?.removeEventListener('abort', stop)
      if (code !== 0 && bytes === 0) {
        reject(new Error(stderr.trim() || `ffmpeg a échoué (code ${code}).`))
        return
      }
      const buffer = Buffer.concat(chunks)
      // Une copie plutôt qu'une vue : le tampon concaténé peut être plus long que le nombre
      // d'échantillons complets, et un reste de quelques octets fausserait la dernière valeur.
      const samples = Math.floor(buffer.byteLength / 4)
      const audio = new Float32Array(samples)
      for (let index = 0; index < samples; index += 1) audio[index] = buffer.readFloatLE(index * 4)
      resolve(audio)
    })
  })
}

/**
 * La langue de la bibliothèque, pour les vidéos dont la légende ne dit rien.
 *
 * Un tiers des clips est dans ce cas, et il fallait bien parier. Parier sur la langue de
 * l'interface était tentant et faux : sur la bibliothèque de référence, 63 % des légendes de
 * vidéos sont anglaises contre 3,7 % françaises — mille cinq cents clips auraient été écoutés
 * en français chez quelqu'un qui sauvegarde de l'anglais, simplement parce que son application
 * est en français. On demande donc à la bibliothèque elle-même, ce qui reste juste dans les deux
 * sens : une bibliothèque française répondra le français.
 *
 * Compté une fois par passe. Quelques milliers de légendes et deux expressions régulières, c'est
 * l'affaire de quelques millisecondes, et le résultat ne bouge pas pendant qu'on transcrit.
 */
export function libraryLanguage(): Listening {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT p.text AS caption
         FROM posts p JOIN media m ON m.post_id = p.id
        WHERE m.kind = 'video' AND p.text IS NOT NULL`
    )
    .all() as { caption: string }[]
  let french = 0
  let english = 0
  for (const row of rows) {
    const verdict = captionLanguage(row.caption)
    if (verdict === 'french') french += 1
    else if (verdict === 'english') english += 1
  }
  // Une bibliothèque neuve ou muette ne dit rien : la langue de l'interface est alors le seul
  // indice qui reste sur la personne devant l'écran.
  if (french === english) return interfaceLanguage() === 'fr' ? 'french' : 'english'
  return french > english ? 'french' : 'english'
}

export interface TranscribeCandidate {
  postId: string
  idx: number
  /** Chemin local du clip, s'il est déjà en cache. */
  videoPath: string | null
  /** Source distante, utilisée quand le clip n'est pas là. */
  videoSource: string | null
  /** La légende, seul indice de la langue parlée avant d'avoir écouté. */
  caption: string | null
}

/**
 * Vidéos qu'on peut encore transcrire : sans verdict, pourvues d'une source, et pas encore
 * abandonnées.
 *
 * Les clips déjà en cache passent devant, et les tentatives déjà essuyées passent derrière.
 * Ce n'est pas cosmétique : un échec ne condamne plus le post, il le renvoie en fin de file,
 * et pendant qu'on traite les autres son clip a le temps de descendre — auquel cas l'essai
 * suivant lira le fichier local au lieu d'une URL de CDN périmée.
 */
export function pendingTranscripts(limit: number): TranscribeCandidate[] {
  return getDb()
    .prepare(
      `SELECT m.post_id AS postId, m.idx, m.video_path AS videoPath, m.video_source AS videoSource,
              p.text AS caption
         FROM media m
         JOIN posts p ON p.id = m.post_id
        WHERE p.is_archived = 0
          AND m.kind = 'video'
          AND p.transcript IS NULL
          AND p.transcript_attempts < ?
          AND (m.video_path IS NOT NULL OR m.video_source IS NOT NULL)
        GROUP BY m.post_id
        ORDER BY p.transcript_attempts ASC, MAX(m.video_path IS NOT NULL) DESC,
                 p.discovered_at DESC
        LIMIT ?`
    )
    .all(MAX_ATTEMPTS, limit) as TranscribeCandidate[]
}

export function countPendingTranscripts(): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(DISTINCT m.post_id) n
           FROM media m JOIN posts p ON p.id = m.post_id
          WHERE p.is_archived = 0 AND m.kind = 'video' AND p.transcript IS NULL
            AND p.transcript_attempts < ?
            AND (m.video_path IS NOT NULL OR m.video_source IS NOT NULL)`
      )
      .get(MAX_ATTEMPTS) as { n: number }
  ).n
}

/**
 * Le verdict, même quand rien n'a été compris.
 *
 * Une chaîne vide dit « écouté, rien à en tirer » : sans cela, chaque passe reprendrait les
 * mêmes vidéos muettes et n'avancerait jamais. Elle ne dit plus que cela — un échec de
 * lecture passe par `noteTranscriptFailure`, qui ne conclut rien.
 */
export function saveTranscript(postId: string, text: string | null): void {
  getDb()
    .prepare('UPDATE posts SET transcript = ?, updated_at = ? WHERE id = ?')
    .run(text ?? '', Date.now(), postId)
}

/**
 * Une tentative qui n'a rien pu écouter.
 *
 * On compte, on ne tranche pas : le post reste sans transcription et repassera, jusqu'à
 * `MAX_ATTEMPTS`. C'est toute la différence avec l'ancien comportement, qui écrivait le même
 * « rien à en tirer » pour une vidéo muette et pour une URL expirée — et perdait
 * définitivement la seconde.
 */
export function noteTranscriptFailure(postId: string): void {
  getDb()
    .prepare('UPDATE posts SET transcript_attempts = transcript_attempts + 1 WHERE id = ?')
    .run(postId)
}

let running: Promise<void> | null = null
let abort: AbortController | null = null

export function isTranscribing(): boolean {
  return running !== null
}

export function stopTranscribing(): void {
  abort?.abort()
  abort = null
}

/**
 * Transcrit tout ce qui reste, une vidéo à la fois.
 *
 * Une seule à la fois volontairement : le modèle occupe déjà tous les cœurs, en lancer
 * plusieurs ne ferait que les faire se battre. Le profil de charge agit sur le reste du
 * travail de fond, pas ici.
 */
export function transcribeAll(): Promise<void> {
  if (running) return running
  const controller = new AbortController()
  abort = controller

  running = (async () => {
    const total = countPendingTranscripts()
    if (total === 0) return
    let done = 0
    backgroundTasks.update('transcribe', { kind: 'transcribe', done, total })

    /* Un post ne compte qu'une fois dans la progression, même s'il est réessayé : sans ce
       registre, trois tentatives sur le même clip feraient avancer la barre de trois crans
       pour un seul post, et le compte dépasserait le total annoncé. */
    const counted = new Set<string>()
    /* Décidée une fois, avant d'écouter quoi que ce soit : c'est la même réponse pour toute la
       passe, et la demander par clip relirait des milliers de légendes pour rien. */
    const fallbackLanguage = libraryLanguage()
    try {
      const recognise = await load()
      /* Reconnaissances refusées d'affilée. Remise à zéro dès qu'une réussit : ce qu'on
         surveille est une panne franche, pas un taux d'échec. */
      let refused = 0
      for (;;) {
        if (controller.signal.aborted) break
        if (backgroundTasks.isPaused() || backgroundTasks.isTaskPaused('transcribe')) {
          await new Promise((resolve) => setTimeout(resolve, 600))
          continue
        }
        const batch = pendingTranscripts(1)
        if (batch.length === 0) break
        const candidate = batch[0]
        const source = candidate.videoPath
          ? join(mediaDir(), candidate.videoPath)
          : candidate.videoSource
        if (!source) {
          noteTranscriptFailure(candidate.postId)
          continue
        }

        /* Deux temps, et deux verdicts qui ne se confondent plus.

           **Extraire le son** peut échouer, et la source dit alors quoi en conclure. Sur un
           fichier local, l'échec porte sur la vidéo : le cas courant est un clip sans la
           moindre piste audio, et le réessayer ne changera jamais rien — c'est un verdict. Sur
           une source distante, il porte sur la descente, une URL de CDN expirée avant tout, et
           la reprise vaut quelque chose : le clip aura peut-être été mis en cache d'ici là.

           **Reconnaître la parole**, en revanche, n'apprend rien sur la vidéo quand ça échoue.
           On avait le son : si le modèle lève, c'est le modèle qui a un problème, pas le clip.
           Confondre les deux a coûté cher — 4 529 vidéos définitivement déclarées muettes sur
           une bibliothèque réelle, alors que leur piste audio était intacte et que la même
           reconnaissance, rejouée depuis, les transcrit sans broncher. Une passe qui échoue ne
           doit rien conclure. */
        let audio: Float32Array
        try {
          audio = await extractAudio(source, controller.signal)
        } catch (error) {
          if (controller.signal.aborted) break
          console.warn('[magpie] Son inextractible', candidate.postId, error)
          if (candidate.videoPath) saveTranscript(candidate.postId, null)
          else noteTranscriptFailure(candidate.postId)
          continue
        }

        if (audio.length < SAMPLE_RATE) {
          /* Moins d'une seconde depuis un fichier local : il n'y a rien à transcrire, pas la
             peine de réveiller le modèle. Depuis une source distante en revanche, un flux vide
             ne prouve rien sur la vidéo — seulement sur la descente. */
          if (candidate.videoPath) saveTranscript(candidate.postId, null)
          else noteTranscriptFailure(candidate.postId)
          continue
        }

        try {
          const output = await recognise(audio, {
            task: 'transcribe',
            // Sans langue explicite, Whisper écoute tout en anglais et invente le reste.
            language: listeningLanguage(candidate.caption, fallbackLanguage),
            // Whisper ne lit que trente secondes d'un coup ; le recouvrement évite de couper
            // un mot à la frontière de deux tranches.
            chunk_length_s: 30,
            stride_length_s: 5
          })
          saveTranscript(candidate.postId, tidyTranscript(String(output.text ?? '')))
          refused = 0
        } catch (error) {
          if (controller.signal.aborted) break
          console.warn('[magpie] Reconnaissance impossible', candidate.postId, error)
          noteTranscriptFailure(candidate.postId)
          refused += 1
          /* Et surtout : on s'arrête. Une reconnaissance qui échoue d'affilée sur des clips
             dont on a bien tiré le son n'est pas une suite de malchances, c'est une panne —
             modèle absent, machine hors ligne, format refusé. Continuer brûlerait la
             bibliothèque entière à raison d'une tentative par vidéo, en silence. Mieux vaut une
             étape qui échoue franchement et qu'on peut relancer. */
          if (refused >= GIVE_UP) {
            throw new Error(
              `La reconnaissance a échoué ${refused} fois de suite alors que le son était ` +
                `disponible. L'étape s'arrête sans rien conclure sur ces vidéos : ` +
                `${error instanceof Error ? error.message : String(error)}`
            )
          }
        }

        if (!counted.has(candidate.postId)) {
          counted.add(candidate.postId)
          done += 1
          backgroundTasks.update('transcribe', { kind: 'transcribe', done, total })
        }
      }
    } finally {
      backgroundTasks.clear('transcribe')
    }
  })().finally(() => {
    running = null
    abort = null
  })

  return running
}
