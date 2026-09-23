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

/**
 * Les révisions épinglées à la main — **EMPLACEMENT RÉSERVÉ, vide à dessein.**
 *
 * `from_pretrained` tirait la branche `main` de chaque dépôt, sans révision ni somme de contrôle :
 * un changement en amont remplaçait en silence des poids ou un tokenizer, et les vecteurs déjà
 * rangés — dont l'empreinte ne porte que le nom du modèle — cessaient de se comparer aux
 * nouveaux sans que rien ne le dise.
 *
 * Les SHA de commit n'ont pas pu être relevés quand ce correctif a été écrit (huggingface.co
 * injoignable depuis l'environnement de travail), et en inventer serait pire que rien : un SHA
 * faux, c'est un modèle qui ne se télécharge plus. D'où l'épinglage au premier téléchargement
 * (`chooseRevision`), et cette table pour le jour où quelqu'un relève les vrais :
 *
 *   curl -sI https://huggingface.co/Xenova/whisper-base/resolve/main/config.json | grep -i x-repo-commit
 *
 * Un SHA ici ne vaut que pour les installations qui n'ont encore rien téléchargé : celles qui ont
 * déjà leurs fichiers gardent la révision qu'elles ont, et c'est voulu — leurs vecteurs ont été
 * calculés avec ces poids-là. Faire migrer tout le monde vers d'autres poids demande de changer
 * aussi l'empreinte des vecteurs (`embeddingHash`, `VERSION` dans `vision.ts`).
 */
export const PINNED_REVISIONS: Readonly<Record<string, string | null>> = {
  [STRUCTURE_MODEL]: null,
  [MEANING_MODEL]: null,
  [TEXT_MODEL]: null,
  [SPEECH_MODEL]: null
}

/** Un SHA de commit complet — la seule forme de révision qu'on range. */
export function isCommit(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
}

/** Ce que l'on sait d'un modèle au moment de le charger. */
export interface RevisionClues {
  /** La révision rangée par le magasin de modèles (`models/revisions.json`). */
  recorded: string | null
  /** Des fichiers déjà en cache sans révision rangée : un téléchargement d'avant l'épinglage. */
  legacy: boolean
  /** La révision écrite dans `PINNED_REVISIONS`. */
  pinned: string | null
}

/**
 * Quelle révision demander, et d'où vient la réponse.
 *
 * Dans cet ordre, et chaque rang a sa raison :
 *
 *   1. **la révision rangée** — celle dont les vecteurs de cette bibliothèque sont faits ;
 *   2. **des fichiers d'avant l'épinglage** — ils ne changeront plus : un fichier en cache ne
 *      repasse jamais par le réseau. On ne sait pas de quel commit ils viennent, et les
 *      remplacer par ceux d'un SHA, fût-il écrit à la main, retéléchargerait des centaines de
 *      mégaoctets pour des poids peut-être différents de ceux qui ont produit les vecteurs
 *      rangés. Seul un fichier encore absent descendra de `main`, comme avant ;
 *   3. **le SHA écrit à la main**, pour une installation neuve ;
 *   4. sinon **résoudre `main`** une fois, avant la première requête, et ranger ce qu'il
 *      désigne : tous les fichiers viendront du même commit, et les suivants aussi.
 *
 * Les fichiers épinglés se rangent sous les mêmes clés que ceux de `main` (voir `pinnedUrl` dans
 * le fil d'inférence) : c'est le registre, et lui seul, qui distingue les deux cas.
 */
export function chooseRevision(
  clues: RevisionClues
):
  | { revision: string; source: 'recorded' | 'legacy' | 'pinned' }
  | { revision: null; source: 'resolve' } {
  if (isCommit(clues.recorded)) return { revision: clues.recorded, source: 'recorded' }
  if (clues.legacy) return { revision: 'main', source: 'legacy' }
  if (isCommit(clues.pinned)) return { revision: clues.pinned, source: 'pinned' }
  return { revision: null, source: 'resolve' }
}

/**
 * L'adresse d'un fichier du hub, ramenée au commit épinglé.
 *
 * Pourquoi réécrire l'adresse plutôt que passer `revision` à `from_pretrained` — le geste
 * évident, et celui qui a été essayé d'abord : `pipeline()` de transformers.js 4.3.0 ne transmet
 * pas la révision à sa découverte des fichiers (`get_pipeline_files`, puis `get_file_metadata`
 * sans options). Cette découverte relisait `main` — constaté dans Electron sur le fil construit :
 * la première requête du modèle de texte visait `…/resolve/main/config.json` malgré la révision
 * — et cherchait en cache sous les clés de `main`, alors que des fichiers épinglés se rangent
 * sous `<modèle>/<sha>/` : hors ligne, le texte et la parole ne se seraient plus chargés du tout.
 *
 * Réécrite ici — le fil d'inférence enveloppe `env.fetch` avec cette fonction —, l'adresse vise
 * le commit pour **toutes** les requêtes : chargements, sondes, `config.json` de la découverte.
 * Les clés du cache, elles, restent celles de `main` : le rangement sur le disque ne change pas,
 * et une installation d'avant l'épinglage se lit exactement comme avant.
 */
export function pinnedUrl(
  url: string,
  remoteHost: string,
  pins: ReadonlyMap<string, string>
): string {
  const host = remoteHost.endsWith('/') ? remoteHost : `${remoteHost}/`
  for (const [model, commit] of pins) {
    const branch = `${host}${model}/resolve/main/`
    if (url.startsWith(branch)) return `${host}${model}/resolve/${commit}/${url.slice(branch.length)}`
  }
  return url
}
