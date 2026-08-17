import { spawn } from 'node:child_process'
import { app } from 'electron'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { getDb, mediaDir } from '../db'
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

type Recogniser = (
  audio: Float32Array,
  options: { language?: string; task: 'transcribe'; chunk_length_s: number; stride_length_s: number }
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

/** Nettoie ce que Whisper produit sur du silence ou de la musique : des répétitions vides. */
export function tidyTranscript(raw: string): string | null {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (text.length < 12) return null
  // Une suite de points, de tirets ou du même mot répété n'apporte rien et pollue l'index.
  if (/^[.\-–—\s·]+$/.test(text)) return null
  const words = text.toLocaleLowerCase().split(' ')
  const distinct = new Set(words)
  if (words.length >= 8 && distinct.size <= 2) return null
  return text
}

export interface TranscribeCandidate {
  postId: string
  idx: number
  /** Chemin local du clip, s'il est déjà en cache. */
  videoPath: string | null
  /** Source distante, utilisée quand le clip n'est pas là. */
  videoSource: string | null
}

/** Vidéos qu'on peut encore transcrire : jamais tentées, et pourvues d'une source. */
export function pendingTranscripts(limit: number): TranscribeCandidate[] {
  return getDb()
    .prepare(
      `SELECT m.post_id AS postId, m.idx, m.video_path AS videoPath, m.video_source AS videoSource
         FROM media m
         JOIN posts p ON p.id = m.post_id
        WHERE p.is_archived = 0
          AND m.kind = 'video'
          AND p.transcript IS NULL
          AND (m.video_path IS NOT NULL OR m.video_source IS NOT NULL)
        GROUP BY m.post_id
        ORDER BY p.discovered_at DESC
        LIMIT ?`
    )
    .all(limit) as TranscribeCandidate[]
}

export function countPendingTranscripts(): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(DISTINCT m.post_id) n
           FROM media m JOIN posts p ON p.id = m.post_id
          WHERE p.is_archived = 0 AND m.kind = 'video' AND p.transcript IS NULL
            AND (m.video_path IS NOT NULL OR m.video_source IS NOT NULL)`
      )
      .get() as { n: number }
  ).n
}

/**
 * Marque le post, même quand rien n'a été compris.
 *
 * Une chaîne vide dit « déjà tenté, rien à en tirer » : sans cela, chaque passe reprendrait
 * les mêmes vidéos muettes et n'avancerait jamais.
 */
export function saveTranscript(postId: string, text: string | null): void {
  getDb()
    .prepare('UPDATE posts SET transcript = ?, updated_at = ? WHERE id = ?')
    .run(text ?? '', Date.now(), postId)
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

    try {
      const recognise = await load()
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
          saveTranscript(candidate.postId, null)
          continue
        }

        try {
          const audio = await extractAudio(source, controller.signal)
          if (audio.length < SAMPLE_RATE) {
            // Moins d'une seconde : il n'y a rien à transcrire, pas la peine de réveiller
            // le modèle.
            saveTranscript(candidate.postId, null)
          } else {
            const output = await recognise(audio, {
              task: 'transcribe',
              // Whisper ne lit que trente secondes d'un coup ; le recouvrement évite de
              // couper un mot à la frontière de deux tranches.
              chunk_length_s: 30,
              stride_length_s: 5
            })
            saveTranscript(candidate.postId, tidyTranscript(String(output.text ?? '')))
          }
        } catch (error) {
          if (controller.signal.aborted) break
          // Un clip illisible ne doit pas arrêter la file : on le marque et on continue.
          console.warn('[magpie] Transcription impossible', candidate.postId, error)
          saveTranscript(candidate.postId, null)
        }

        done += 1
        backgroundTasks.update('transcribe', { kind: 'transcribe', done, total })
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
