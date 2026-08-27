/**
 * Distinguer une bibliothèque muette d'un modèle muet.
 *
 * La transcription sait déjà se défendre contre une reconnaissance qui **lève** : cinq refus
 * d'affilée arrêtent la passe plutôt que de brûler la bibliothèque une vidéo à la fois. Mais
 * une panne ne lève pas toujours. Mesuré le 2026-08-26 sur la bibliothèque de référence :
 * 4 555 posts portaient le verdict « rien à entendre » écrit par une passe qui, elle, n'avait
 * levé nulle part — le modèle rendait « Music », « The End », « you », et `tidyTranscript`
 * concluait honnêtement qu'il n'y avait rien à garder. Rejoué depuis, le même code tire de la
 * parole de treize clips sur vingt de plus de vingt secondes.
 *
 * Vu du code, une panne franche et une bibliothèque de clips musicaux se ressemblent donc
 * exactement. Ce module donne de quoi les séparer, et il le fait sans base, sans modèle et
 * sans Electron — donc `npm run check:transcribe` peut l'exercer.
 *
 * Le signal retenu n'est pas « le modèle n'a rien rendu », qui est banal : un reel sur trois
 * est une boucle musicale et n'a réellement rien à dire. C'est **une série de clips qui avaient
 * du son, qui étaient assez longs pour parler, et dont rien n'est sorti**. Sur une passe saine,
 * ces clips-là rendent du texte deux fois sur trois ; en enchaîner vingt-cinq sans un mot n'est
 * pas une bibliothèque silencieuse, c'est une panne.
 */

/**
 * En dessous, il n'y a pas de son.
 *
 * Un clip sans piste audio ressort à zéro, et une piste présente mais vide reste sous ce seuil.
 * Les vrais clips mesurés se tiennent entre 0,06 et 0,19 de RMS, musique comprise : la marge
 * est large, et c'est voulu — ce seuil ne sert qu'à écarter le silence franc, jamais à juger
 * de ce qu'on entend.
 */
export const SILENCE_RMS = 0.005

/**
 * En deçà, se taire n'a rien d'étonnant.
 *
 * Les clips courts sont des boucles musicales, et n'en tirer aucun mot est le cas normal. Ne
 * compter que les clips assez longs pour porter une phrase enlève au compteur sa principale
 * source de longues séries légitimes — et c'est ce qui permet de fixer un seuil bas.
 */
export const SPEAKING_SECONDS = 20

/**
 * Combien de clips sonores et assez longs peuvent rester sans un mot avant qu'on parle de panne.
 *
 * Mesuré : sur une passe saine, 13 clips sur 20 de cette taille rendent du texte. Vingt-cinq
 * de suite sans rien est de l'ordre du dix-milliardième — donc jamais, à l'échelle d'une
 * bibliothèque. Et les deux erreurs ne coûtent pas la même chose : un faux positif arrête une
 * étape qu'on relance, un faux négatif condamne définitivement la moitié de la bibliothèque.
 * Le seuil penche du côté qui se répare.
 */
export const MUTE_STREAK = 25

/** Le niveau sonore d'un tampon, en RMS. */
export function audioLevel(audio: Float32Array): number {
  if (audio.length === 0) return 0
  let sum = 0
  for (let index = 0; index < audio.length; index += 1) sum += audio[index] * audio[index]
  return Math.sqrt(sum / audio.length)
}

/**
 * Ce clip aurait-il dû dire quelque chose ?
 *
 * Vrai quand il avait du son, qu'il était assez long pour parler, et que rien n'en est sorti.
 * Un seul cas ne prouve rien — c'est leur enchaînement qui compte.
 */
export function looksMute(
  audio: { level: number; seconds: number },
  transcript: string | null
): boolean {
  return (
    transcript === null && audio.level >= SILENCE_RMS && audio.seconds >= SPEAKING_SECONDS
  )
}

/**
 * Le compteur de série, et la seule question qu'on lui pose.
 *
 * Tenu à part pour que la boucle de transcription reste lisible, et pour qu'il s'exerce sans
 * rien monter autour. Il retient les posts de la série en cours : quand la panne est déclarée,
 * ce sont exactement les verdicts à effacer pour que ces vidéos retrouvent la file.
 */
export class MuteStreak {
  private ids: string[] = []

  /** Enregistre un clip et dit si la série est devenue une panne. */
  note(postId: string, mute: boolean): boolean {
    if (!mute) {
      this.ids = []
      return false
    }
    this.ids.push(postId)
    return this.ids.length >= MUTE_STREAK
  }

  /** Les posts de la série en cours, dans l'ordre où ils ont été écoutés. */
  get pending(): readonly string[] {
    return this.ids
  }
}
