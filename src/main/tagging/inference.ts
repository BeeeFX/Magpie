import { join } from 'node:path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { dataDir } from '../db'
import type { InferenceReply, InferenceRequest } from './inference.worker'

/**
 * Le guichet des modèles, vu du processus principal.
 *
 * Tout ce qui encode — le texte, les images, les phrases de thème, la parole — passe par ici et
 * s'exécute ailleurs. Voir `inference.worker.ts` pour la raison : ORT calcule de façon
 * synchrone, et ce calcul n'a rien à faire sur le fil qui dessine la fenêtre.
 *
 * Le processus démarre au premier encodage, pas au lancement : une bibliothèque qu'on ouvre
 * pour regarder ses posts n'a aucune raison de payer six cents mégaoctets de modèles.
 */

/** Où trouver le script, quel que soit l'empaquetage.
 *
 *  Surtout pas `__dirname` : le bundler extrait les fonctions partagées dans `out/main/chunks/`,
 *  donc `__dirname` y désigne le dossier des morceaux et non celui du script. C'est exactement
 *  l'erreur qu'on a eue en version installée avec le fil de projection. On part donc de la
 *  racine de l'application, stable dans les deux cas.
 *
 *  Et on vise la copie **dans l'archive**, contrairement au fil de projection : un
 *  `utilityProcess` est un vrai processus Node d'Electron, il lit donc l'asar comme un dossier
 *  et résout ses imports depuis `app.asar/node_modules`, où vivent `@huggingface/transformers`
 *  et toute sa parenté. Le déballer l'aurait coupé d'elle. */
export function workerScriptPath(appPath: string): string {
  return join(appPath, 'out', 'main', 'inference.worker.js')
}

/**
 * Au bout de combien de silence on rend les modèles au système.
 *
 * C'est le bénéfice qu'un fil ne pouvait pas donner : les trois familles chargées retiennent
 * quelques centaines de mégaoctets, et une analyse ne se relance pas toutes les cinq minutes.
 * Le processus ne meurt jamais avec une demande en cours ; le rouvrir coûte le chargement d'un
 * modèle, soit moins d'une seconde, et seulement pour celui qu'on redemande.
 */
const IDLE_MS = 5 * 60 * 1000

/**
 * Une demande sans son numéro.
 *
 * `Omit` sur une union la referme en un seul objet aux champs communs — donc, ici, à rien.
 * Le `extends unknown` la fait se distribuer membre par membre, ce qui garde chaque forme
 * intacte et laisse le compilateur refuser un `texts` posé sur une transcription.
 */
type Ask<T> = T extends unknown ? Omit<T, 'id'> : never

interface Pending {
  resolve(reply: InferenceReply): void
  reject(error: Error): void
}

let child: UtilityProcess | null = null
let starting: Promise<UtilityProcess> | null = null
let nextId = 1
let idleTimer: NodeJS.Timeout | null = null
const pending = new Map<number, Pending>()

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (!child || pending.size > 0) return
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (pending.size === 0) stopInference()
  }, IDLE_MS)
  idleTimer.unref?.()
}

/** Une demande qui ne reçoit jamais sa réponse doit échouer, pas attendre indéfiniment. */
function failAll(reason: string): void {
  const waiting = [...pending.values()]
  pending.clear()
  for (const entry of waiting) entry.reject(new Error(reason))
}

function spawn(): Promise<UtilityProcess> {
  if (child) return Promise.resolve(child)
  if (starting) return starting
  const attempt = new Promise<UtilityProcess>((resolve, reject) => {
    const script = workerScriptPath(app.getAppPath())
    const process_ = utilityProcess.fork(script, [], {
      serviceName: 'Magpie models',
      /* Hérité : ce que les modèles écrivent — un téléchargement, un avertissement d'ORT —
         doit apparaître dans le même journal que le reste, sinon il n'existe pour personne. */
      stdio: 'inherit'
    })

    process_.on('message', (message: InferenceReply) => {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      entry.resolve(message)
      armIdleTimer()
    })

    /* Une panne franche de V8 ou du modèle tue le processus. Elle ne peut plus emporter
       l'application avec elle : on le dit aux demandes en vol, et le prochain encodage
       repartira sur un processus neuf. */
    process_.on('exit', () => {
      if (child === process_) child = null
      failAll('Le processus des modèles s’est arrêté. Relancez l’étape.')
    })

    process_.once('spawn', () => {
      child = process_
      starting = null
      resolve(process_)
    })
    process_.once('exit', () => {
      if (starting !== attempt) return
      starting = null
      reject(new Error('Le processus des modèles n’a pas démarré.'))
    })
  })
  starting = attempt
  return attempt
}

async function ask(request: Ask<InferenceRequest>): Promise<InferenceReply> {
  const worker = await spawn()
  const id = nextId
  nextId += 1
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const reply = await new Promise<InferenceReply>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker.postMessage({ ...request, id } as InferenceRequest)
  })
  armIdleTimer()
  if (!reply.ok) throw new Error(reply.message)
  return reply
}

/**
 * Le dossier des modèles, annoncé une fois par processus.
 *
 * Le worker ne connaît pas la bibliothèque : il ne sait ni où elle est ni qu'elle peut
 * déménager. On le lui dit à l'ouverture, et cette configuration se refait toute seule après un
 * redémarrage puisqu'elle est adossée à la même promesse que le processus.
 */
let configured: Promise<unknown> | null = null

async function ready(): Promise<void> {
  const worker = await spawn()
  if (!configured) {
    configured = ask({ kind: 'configure', cacheDir: join(dataDir(), 'models') })
    worker.once('exit', () => {
      configured = null
    })
  }
  await configured
}

function block(reply: InferenceReply): Float32Array[] {
  if (reply.ok !== true || reply.kind !== 'block') throw new Error('Réponse inattendue du modèle.')
  const { flat, width } = reply
  return Array.from({ length: flat.length / width }, (_, index) =>
    flat.slice(index * width, (index + 1) * width)
  )
}

/** Encode un lot de textes. Le préfixe attendu par e5 est ajouté de l'autre côté. */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return []
  await ready()
  return block(await ask({ kind: 'embed', texts }))
}

/** Encode les images d'un même post, et rend la moyenne des deux regards. */
export async function encodeImage(
  paths: string[]
): Promise<{ structure: Float32Array; meaning: Float32Array }> {
  await ready()
  const reply = await ask({ kind: 'encode-images', paths })
  if (reply.ok !== true || reply.kind !== 'image') throw new Error('Réponse inattendue du modèle.')
  return { structure: reply.structure, meaning: reply.meaning }
}

/** Encode des phrases dans le repère des images — la tour texte de SigLIP. */
export async function encodePrompts(prompts: string[]): Promise<Float32Array[]> {
  if (prompts.length === 0) return []
  await ready()
  return block(await ask({ kind: 'encode-prompts', prompts }))
}

/** Reconnaît la parole d'un extrait 16 kHz mono. */
export async function transcribeAudio(audio: Float32Array, language: string): Promise<string> {
  await ready()
  const reply = await ask({ kind: 'transcribe', audio, language })
  if (reply.ok !== true || reply.kind !== 'text') throw new Error('Réponse inattendue du modèle.')
  return reply.text
}

/** Ferme le processus. Appelé en quittant, et par la minuterie d'inactivité. */
export function stopInference(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const worker = child
  child = null
  configured = null
  failAll('Le processus des modèles a été arrêté.')
  worker?.kill()
}
