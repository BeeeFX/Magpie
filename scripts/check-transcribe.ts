import { captionLanguage, listeningLanguage, tidyTranscript } from '../src/main/tagging/transcript-text'
import { audioLevel, looksMute, MuteStreak, MUTE_STREAK } from '../src/main/tagging/transcript-guard'

/**
 * Ce que la transcription doit savoir avant d'écouter.
 *
 * Deux décisions, prises sur du texte, et chacune a déjà coûté cher :
 *
 *   — **dans quelle langue écouter.** `transformers.js` n'implémente pas la détection et se
 *     rabat en silence sur l'anglais. Pendant six versions, tout a donc été écouté en anglais,
 *     y compris le français — ce qui ne donne pas une transcription approximative mais une
 *     translittération inventée, partie ensuite dans l'index plein texte *et* dans les vecteurs
 *     de regroupement.
 *   — **quoi garder de ce que Whisper rend.** Sur de la musique il rend un mot, sur la mauvaise
 *     langue il boucle sur une tournure. Le second cas passait le filtre : sept mots distincts
 *     sur vingt-et-un, et une phrase inventée entrait dans l'index comme une vraie.
 *
 * Les deux se vérifient sans base, sans modèle et sans application, donc elles se vérifient
 * ici — c'est tout l'intérêt de les avoir sorties du module qui parle à Electron.
 */

let failures = 0

function assert(condition: unknown, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${message}`)
}

console.log('La langue, quand la légende la dit')
{
  assert(
    captionLanguage('Voici les meilleures astuces pour réussir cette recette avec les enfants') ===
      'french',
    'une légende française est reconnue'
  )
  assert(
    captionLanguage('Here are the best tips to get this recipe right with the kids at home') ===
      'english',
    'une légende anglaise est reconnue'
  )
  /* Le mot-dièse garde son mot. Sur la bibliothèque de référence, le jeter avec son signe
     coûtait soixante-quatorze légendes qu'on savait pourtant trancher. */
  assert(
    captionLanguage('Variant cover for #GuardiansoftheGalaxy by @AleksiBriclot #ArtStationHQ') ===
      'english',
    'les mots-dièse comptent comme des mots'
  )
}

console.log('\nLa langue, quand la légende ne la dit pas')
{
  assert(captionLanguage(null) === null, 'pas de légende, pas de verdict')
  assert(captionLanguage('🔥🔥') === null, 'des emojis ne sont pas une langue')
  // Sous vingt-quatre caractères utiles, une accroche n'est plus qu'un tirage au sort.
  assert(captionLanguage('a desert place #paint #art') === null, 'une accroche trop courte se tait')
  assert(
    captionLanguage('https://example.com/some/long/path?with=query @someone') === null,
    'un lien n’est pas de la langue'
  )
  /* Le piège des langues voisines. `\b` s'appuie sur `\w`, qui ne connaît que l'ASCII : dans
     « está », le `á` est un caractère non-mot, donc `\best\b` trouvait le `est` français au
     milieu d'un mot espagnol. Une seule occurrence suffisait alors à décider, et Whisper forcé
     en français bouclait sur une phrase inventée. */
  assert(
    captionLanguage(
      'La nueva temporada del anime Black Clover está programada para regresar el 3 de enero'
    ) === null,
    'l’espagnol ne passe pas pour du français'
  )
  assert(captionLanguage('Voici la photo brute, sans retouche') === 'french', 'deux marqueurs suffisent')
  assert(
    captionLanguage('Nel mezzo del cammin di nostra vita mi ritrovai per una selva oscura') === null,
    'l’italien ne passe pas pour du français'
  )
  assert(
    captionLanguage('Mais uma vez a equipe conseguiu terminar o projeto antes do prazo') === null,
    'le portugais ne passe pas pour du français'
  )
}

console.log('\nLa retombée')
{
  assert(
    listeningLanguage(null, 'english') === 'english',
    'sans indice, on suit la langue donnée en repli'
  )
  assert(
    listeningLanguage('Voici les meilleures astuces pour réussir cette recette', 'english') ===
      'french',
    'la légende l’emporte sur le repli'
  )
}

console.log('\nCe qu’on garde de Whisper')
{
  assert(tidyTranscript(' music') === null, 'un mot seul n’est pas une transcription')
  assert(tidyTranscript(' you') === null, 'ni deux lettres')
  assert(tidyTranscript('... ... ...') === null, 'ni une suite de points')
  assert(tidyTranscript('ok ok ok ok ok ok ok ok') === null, 'ni le même mot huit fois')
  /* Le cas relevé : Whisper forcé dans la mauvaise langue. Vingt-et-un mots, sept distincts.
     C'est de la dégénérescence, pas du propos. */
  assert(
    tidyTranscript(
      'Je suis une fille qui me rende une fille qui me rende une fille qui me rende une fille qui me rende'
    ) === null,
    'ni une tournure qui boucle'
  )
  const real =
    "So I'm testing out this iclora called refocus and I intentionally left the subject blurry to see what it would do"
  assert(tidyTranscript(real) === real, 'de la prose est gardée telle quelle')
  assert(
    tidyTranscript('  Deux   espaces   partout  ') === 'Deux espaces partout',
    'les espaces sont normalisés'
  )
}

console.log('\nUne bibliothèque muette, ou un modèle muet')
{
  /** Un tampon de bruit d'un niveau donné : seule son amplitude compte ici. */
  const tone = (level: number, seconds: number): Float32Array => {
    const audio = new Float32Array(Math.round(seconds * 16_000))
    for (let index = 0; index < audio.length; index += 1) audio[index] = index % 2 ? level : -level
    return audio
  }

  assert(audioLevel(new Float32Array(0)) === 0, 'un tampon vide n’a pas de niveau')
  assert(audioLevel(tone(0, 5)) === 0, 'une piste à zéro non plus')
  assert(Math.abs(audioLevel(tone(0.2, 5)) - 0.2) < 1e-6, 'le RMS d’un signal carré est son amplitude')

  const loud = { level: 0.15, seconds: 45 }
  assert(looksMute(loud, null), 'un clip sonore et long dont rien ne sort est suspect')
  assert(!looksMute(loud, 'de la vraie prose transcrite ici'), 'sauf s’il a parlé')
  assert(
    !looksMute({ level: 0.15, seconds: 6 }, null),
    'un clip trop court pour parler ne prouve rien'
  )
  assert(
    !looksMute({ level: 0.0001, seconds: 45 }, null),
    'une vidéo sans piste audio non plus — son verdict est une vérité'
  )

  /* La série, et ce qu'elle rend quand elle casse : les posts à réhabiliter, dans l'ordre. */
  const streak = new MuteStreak()
  let broke = false
  for (let index = 0; index < MUTE_STREAK - 1; index += 1) {
    broke = streak.note(`post-${index}`, true) || broke
  }
  assert(!broke, `${MUTE_STREAK - 1} clips muets d’affilée ne déclarent pas la panne`)
  assert(streak.pending.length === MUTE_STREAK - 1, 'mais la série les retient tous')
  assert(!streak.note('parlant', false), 'un clip qui parle remet le compteur à zéro')
  assert(streak.pending.length === 0, 'et vide la série : rien à réhabiliter')

  const fatal = new MuteStreak()
  let declared = false
  for (let index = 0; index < MUTE_STREAK; index += 1) {
    declared = fatal.note(`post-${index}`, true)
  }
  assert(declared, `${MUTE_STREAK} clips muets d’affilée déclarent la panne`)
  assert(
    fatal.pending.length === MUTE_STREAK && fatal.pending[0] === 'post-0',
    'et rendent la liste complète des verdicts à effacer'
  )
}

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} échec(s).`)
process.exit(failures === 0 ? 0 : 1)
