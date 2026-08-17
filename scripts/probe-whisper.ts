import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { env, pipeline } from '@huggingface/transformers'
import ffmpegPath from 'ffmpeg-static'

/**
 * Mesure jetable : Whisper tourne-t-il via transformers.js, et à quelle cadence.
 *
 * L'enjeu est de savoir si on peut se passer d'un binaire whisper.cpp embarqué. La
 * dépendance ONNX est déjà là pour les embeddings ; si la cadence tient, l'installeur ne
 * grossit que du modèle, téléchargé à la demande.
 */

const run = promisify(execFile)
env.cacheDir = join(tmpdir(), 'magpie-model-check')
env.allowLocalModels = false

/** Génère un extrait parlé synthétique : on mesure la cadence, pas la justesse du texte. */
async function tone(seconds: number): Promise<Float32Array> {
  const out = join(tmpdir(), `magpie-probe-${seconds}.raw`)
  await run(ffmpegPath as string, [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=220:duration=${seconds}`,
    '-ac', '1', '-ar', '16000', '-f', 'f32le', out
  ])
  const { readFile } = await import('node:fs/promises')
  const buffer = await readFile(out)
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
}

async function main(): Promise<void> {
  console.log('Sonde Whisper (transformers.js)')
  for (const model of ['Xenova/whisper-tiny', 'Xenova/whisper-base']) {
    try {
      let started = performance.now()
      const transcribe = await pipeline('automatic-speech-recognition', model, { dtype: 'q8' })
      const loadMs = performance.now() - started

      const seconds = 30
      const audio = await tone(seconds)
      started = performance.now()
      const result = await transcribe(audio, { language: 'french', task: 'transcribe' })
      const ms = performance.now() - started
      const ratio = (seconds * 1000) / ms

      console.log(
        `  ${model.padEnd(26)} chargé ${Math.round(loadMs)} ms | ${seconds} s d'audio en ` +
          `${Math.round(ms)} ms → ${ratio.toFixed(1)}× le temps réel`
      )
      console.log(
        `    44 h de bibliothèque : ${((44 * 3600) / ratio / 3600).toFixed(1)} h | ` +
          `sortie : ${JSON.stringify(String((result as { text?: string }).text ?? '').slice(0, 40))}`
      )
    } catch (error) {
      console.log(`  ${model} — échec : ${error instanceof Error ? error.message : error}`)
    }
  }
}

void main()
