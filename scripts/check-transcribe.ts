import { captionLanguage, listeningLanguage, tidyTranscript } from '../src/main/tagging/transcript-text'

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

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} échec(s).`)
process.exit(failures === 0 ? 0 : 1)
