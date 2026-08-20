/**
 * Le texte de la transcription, et rien d'autre.
 *
 * Ces fonctions ne touchent ni la base, ni Electron, ni le modèle : elles ne font que lire des
 * chaînes et trancher. C'est ce qui les rend vérifiables — `npm run check:transcribe` les
 * éprouve directement, sans monter une application ni ouvrir une bibliothèque. Elles ont
 * chacune coûté un bug qu'on ne voyait pas : une langue devinée de travers, et une
 * hallucination rangée dans l'index comme une phrase.
 */

/**
 * Dans quelle langue écouter.
 *
 * Whisper multilingue exige qu'on le lui dise : `transformers.js` n'implémente pas la
 * détection et se rabat en silence sur l'anglais (`No language specified - defaulting to
 * English`). Ce n'était pas un détail — du français écouté comme de l'anglais ne rend pas une
 * transcription approximative, il rend une translittération inventée, qui partait ensuite dans
 * l'index plein texte *et* dans les vecteurs de regroupement.
 *
 * La légende est le meilleur indice disponible : elle est écrite par la personne qui parle, et
 * elle est déjà là. Quelques mots outils suffisent à trancher entre les deux langues que Magpie
 * connaît — ce sont les mots les plus fréquents de chacune, et ils n'existent pas dans l'autre.
 * Les mots-dièse gardent leur mot et perdent leur signe : `#painting` est de l'anglais, et le
 * jeter avec le `#` coûtait soixante-quatorze légendes tranchées sur la bibliothèque de
 * référence.
 *
 * Les frontières sont écrites à la main plutôt qu'avec `\b`, et ce n'est pas de la coquetterie.
 * `\b` s'appuie sur `\w`, qui ne connaît que l'ASCII : dans « está », le `á` compte pour un
 * caractère non-mot, donc `\best\b` trouvait le `est` français au milieu d'un mot espagnol. Une
 * légende espagnole partait ainsi en français, et Whisper dans la mauvaise langue n'approxime
 * pas — il boucle sur une phrase inventée. Les classes Unicode ferment cette porte pour toutes
 * les langues voisines à la fois.
 *
 * Ce qui manque aux listes en dit autant que ce qui y est. `on`, `or`, `as`, `a`, `an` et
 * `son` sont anglais *et* français ; `que` et `entre` sont français *et* espagnols ; `qui` est
 * français *et* italien ; `mais` est français *et* portugais. Un marqueur partagé ne
 * discrimine rien : il ajoute du bruit des deux côtés de la comparaison. Ils sont donc
 * écartés, même quand ce sont les mots les plus fréquents de la langue.
 */
const FRENCH_MARKERS =
  /(?<![\p{L}\p{M}\p{N}])(?:le|la|les|des|une|dans|pour|avec|est|sont|c'est|cette|ces|nous|vous|tout|comme|quand|aussi|très|leur|faire|être|du|au|aux|sur|ses|pas|bien|chez|alors|donc|cela|notre|votre|elle|ils|elles|encore|toujours|jamais|sans|sous|mes|tes|vos|nos|cet|ceux|déjà|était|avait)(?![\p{L}\p{M}\p{N}])/giu
const ENGLISH_MARKERS =
  /(?<![\p{L}\p{M}\p{N}])(?:the|and|of|to|in|for|with|is|are|this|that|these|those|but|you|we|not|have|has|had|from|they|their|there|about|when|what|where|which|who|why|how|would|could|should|been|was|were|by|at|it|its|your|my|our|so|all|out|up|just|like|can|will|new|best|more|most|only|also|very|into|over|after|before|make|made|get|got|first|last|here|one|two)(?![\p{L}\p{M}\p{N}])/giu

export type Listening = 'french' | 'english'

/**
 * Ce qu'une légende dit de sa langue, ou rien.
 *
 * Sous vingt-quatre caractères utiles la légende n'est qu'une accroche : deux mots outils tirés
 * au hasard y pèseraient plus que la langue réelle. Les liens ne sont pas de la langue et
 * partent en entier.
 */
export function captionLanguage(caption: string | null): Listening | null {
  const text = (caption ?? '').replace(/https?:\/\/\S+/g, ' ').replace(/[@#]/g, ' ')
  if (text.replace(/\s+/g, '').length < 24) return null
  const french = (text.match(FRENCH_MARKERS) ?? []).length
  const english = (text.match(ENGLISH_MARKERS) ?? []).length
  /* Deux marqueurs au moins, et plus que l'autre langue. Un seul mot ne prouve rien, et se
     tromper coûte cher : les langues voisines partagent nos petits mots. « La nueva temporada
     del anime está programada » ne contient qu'un `la`, ce qui suffisait à le déclarer
     français — et Whisper forcé dans la mauvaise langue n'approxime pas, il boucle. */
  if (french >= 2 && french > english) return 'french'
  if (english >= 2 && english > french) return 'english'
  return null
}

/** La langue à retenir pour un clip : ce que dit sa légende, sinon celle de la bibliothèque. */
export function listeningLanguage(caption: string | null, fallback: Listening): Listening {
  return captionLanguage(caption) ?? fallback
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
  /* La dégénérescence de Whisper ne répète pas un mot, elle répète une tournure : « une fille
     qui me rende une fille qui me rende une fille… ». Sept mots distincts sur vingt-et-un, ce
     qui passait le test précédent sans difficulté et rangeait une phrase inventée dans l'index
     comme une vraie. De la prose tient au-dessus de la moitié de mots distincts ; en dessous
     d'un tiers, il n'y a plus de propos. */
  if (words.length >= 12 && distinct.size / words.length < 0.34) return null
  return text
}
