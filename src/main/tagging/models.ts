/**
 * Les quatre modèles, nommés une seule fois.
 *
 * Ils vivaient en constantes privées du fil d'inférence, ce qui allait tant que personne
 * d'autre n'avait besoin de savoir lesquels tournent. Mais **ils pèsent plus que tout le reste
 * de la bibliothèque réunie** — 688 Mo à eux quatre — et trois choses ont besoin de la liste :
 * la comptabilité du disque, la purge de ce qui ne sert plus, et le déplacement de
 * bibliothèque qui doit les emporter.
 *
 * Recopier la liste ailleurs était l'option évidente et c'est exactement celle qui a produit
 * le problème : le cache d'une machine à jour porte **neuf** répertoires de modèles pour
 * quatre modèles utilisés. `clip-vit-base-patch32`, `dinov2-base`, deux `siglip2` et
 * `dinov2-with-registers-small` sont des choix abandonnés en cours de route, soit ~380 Mo que
 * rien ne remarque et que rien ne supprime. Une seconde liste aurait fait la même chose une
 * seconde fois.
 *
 * Ce module n'importe rien, à dessein : le fil d'inférence tourne dans un `utilityProcess` et
 * un script de contrôle le lit sans Electron.
 */

/** La structure et le style. Le plus petit des candidats, et le meilleur : 23 Mo, 26 ms. */
export const STRUCTURE_MODEL = 'Xenova/dinov2-small'
/** Le sujet. Sait aussi comparer une image à des mots, ce que DINOv2 ne sait pas faire. */
export const MEANING_MODEL = 'Xenova/siglip-base-patch16-224'
/** Multilingue à dessein : une bibliothèque française et anglaise mélangées est la norme. */
export const TEXT_MODEL = 'Xenova/multilingual-e5-small'
/** `tiny` transcrit mal le français ; `small` triple le coût pour un gain modeste. */
export const SPEECH_MODEL = 'Xenova/whisper-base'

/**
 * Ce qui doit rester sur le disque.
 *
 * **Dérivée des quatre constantes, jamais écrite à la main.** C'est ce qui rend la purge sûre :
 * elle supprime ce qui n'est pas dans cette liste, donc une liste incomplète effacerait un
 * modèle en service et le ferait retélécharger. Changer un modèle ci-dessus suffit à ce que
 * l'ancien devienne purgeable — sans autre geste, et sans qu'on puisse l'oublier.
 */
export const USED_MODELS: readonly string[] = [
  STRUCTURE_MODEL,
  MEANING_MODEL,
  TEXT_MODEL,
  SPEECH_MODEL
]
