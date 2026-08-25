/**
 * Le vocabulaire : comment un post se réduit à des mots.
 *
 * Sorti de `organize` sans rien y changer, pour deux raisons. La première est qu'il y avait
 * désormais deux listes de mots vides dans le projet — celle-ci et une copie dans le nommage des
 * régions — et deux listes divergent toujours. La seconde est qu'`organize` importe Electron :
 * les bancs ne peuvent pas s'en servir, et se réécrivaient donc leur propre découpage, qui ne
 * mesurait alors pas ce que l'application fait.
 */

/**
 * Les mots vides, **normalisés comme le sont les mots des posts**.
 *
 * C'était un piège silencieux : la liste contenait « ça », « très », « forêt » sous leur forme
 * accentuée, alors que `normalizePhrase` retire les accents avant de comparer. Ces entrées-là
 * n'ont donc jamais filtré quoi que ce soit, et « ca » remontait dans les noms de régions. On
 * passe la liste par la même porte que les posts, une fois, au chargement.
 */
export const STOP_WORDS = new Set(
  `a about above after again against ai all am an and any are arent as at avec avoir be because been before being below between both but by can could dans de des did do does doing dont down during each elle en encore est et few for from further get got had has have having he her here hers herself him himself his how i if in into is it its itself je just la le les lui mais me more most my myself ne no nor not nous of off on once only or other our ours ourselves out over own pas plus pour que qui re really same she should so some such sur than that the their theirs them themselves then there these they this those through to too très under until up very vous was we were what when where which while who why will with you your yours yourself yourselves ça comme cette ces ce une un video videos reel reels post posts instagram reddit twitter tiktok x com http https www fyp fy foryou foryoupage viral trending trend explore explorepage follow like likes share watch link bio indie au aux du ni ou si co hi ok oh ce ces cet par sans sous chez tout tous toute toutes bien sont soit ont avait avaient etait etaient fait faire peut deja alors donc meme quand aussi apres avant entre depuis vers chaque autre autres`
    .split(/\s+/)
    /* La même porte que les posts, et pas une copie de ses trois premières lignes : une copie
       diverge, et c'est exactement ce qui s'était produit. */
    .map((word) => normalizePhrase(word))
)

export function normalizePhrase(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^\p{L}\p{N}+# ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function words(value: string): string[] {
  return normalizePhrase(value)
    .replace(/https?\s+\S+/g, ' ')
    .split(' ')
    .map((word) => word.replace(/^#+/, ''))
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word) && !/^\d+$/.test(word))
}

/**
 * Les mots d'un post, mots-dièse compris.
 *
 * Les mots-dièse sont rendus **en plus** de leur forme nue, et non à la place : `#blender` doit
 * pouvoir nommer une région même quand personne n'écrit « blender » en toutes lettres.
 */
export function postTerms(text: string | null, tags: string[] = []): string[] {
  const body = text ?? ''
  const out = words(body)
  for (const match of body.matchAll(/#([\p{L}\p{N}_-]{2,})/gu)) {
    const tag = normalizePhrase(match[1])
    if (tag.length >= 3 && !STOP_WORDS.has(tag)) out.push(tag)
  }
  for (const tag of tags) out.push(...words(tag))
  return out
}
