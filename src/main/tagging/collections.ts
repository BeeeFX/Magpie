import { getDb } from '../db'
import { TOPIC_NAMES } from './organize'
import { interfaceLanguage } from '../settings'
import {
  cutFor,
  DEFAULT_SIZE,
  encodePhrase,
  scoreKeywords,
  type Keyword,
  type Prototype,
  type Scores
} from './prototypes'

/**
 * Les collections, telles qu'on les définit et telles qu'on les corrige.
 *
 * Une collection est une phrase et une ampleur. Tout le reste en découle : le prototype vient
 * de la phrase, l'appartenance vient du prototype, et `collection_posts` n'est qu'un cache de
 * cette appartenance, réécrit à chaque changement. Cela veut dire qu'il n'y a jamais de
 * désaccord possible entre ce que la carte montre et ce que la mosaïque filtre — les deux
 * lisent le même calcul.
 *
 * Trois gestes, et trois seulement :
 *
 *   — **écrire.** Une phrase crée une collection, et la renommer la redéfinit. C'est le geste
 *     le plus rapide qui existe pour classer neuf mille posts, et il ne demande aucun exemple.
 *   — **régler l'ampleur.** Un curseur, de « seulement l'évident » à « tout ce qui y ressemble ».
 *   — **trancher.** Oui ou non sur des posts choisis. Le prototype se déplace, et le verdict est
 *     retenu : ces posts ne changeront plus d'avis tout seuls.
 */

/** Le vecteur transporté en base. Float32, tel quel. */
const toBlob = (vector: Float32Array | null): Buffer | null =>
  vector ? Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength) : null

const fromBlob = (blob: Buffer | null): Float32Array | null =>
  blob ? new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4).slice() : null

interface CollectionDefinition {
  id: number
  name: string
  /** `query` = définie par ses mots ; `manual` = une liste que rien ne recalcule. */
  kind: 'query' | 'manual'
  size: number
  keywords: Keyword[]
}

function definitionOf(id: number): CollectionDefinition | null {
  const db = getDb()
  const row = db
    .prepare('SELECT id, name, kind, target_size AS size FROM collections WHERE id = ?')
    .get(id) as { id: number; name: string; kind: string; size: number } | undefined
  if (!row) return null
  const words = db
    .prepare(
      `SELECT word, weight, vector_text AS text, vector_meaning AS meaning
         FROM collection_keywords WHERE collection_id = ? ORDER BY sort_index, word`
    )
    .all(id) as { word: string; weight: number; text: Buffer | null; meaning: Buffer | null }[]
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === 'query' ? 'query' : 'manual',
    size: row.size,
    keywords: words.map((entry) => ({
      word: entry.word,
      weight: entry.weight,
      vector: { text: fromBlob(entry.text), meaning: fromBlob(entry.meaning) }
    }))
  }
}

/** Ranger un mot et son vecteur. Encodé une seule fois : le modèle n'est réveillé qu'à l'ajout. */
function saveKeyword(id: number, word: string, weight: number, vector: Prototype, order: number): void {
  getDb()
    .prepare(
      `INSERT INTO collection_keywords
         (collection_id, word, weight, vector_text, vector_meaning, sort_index)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(collection_id, word) DO UPDATE SET weight = excluded.weight`
    )
    .run(id, word, weight, toBlob(vector.text), toBlob(vector.meaning), order)
}

/** Les verdicts posés à la main, par collection. */
function verdicts(id: number): { yes: string[]; no: string[] } {
  const rows = getDb()
    .prepare('SELECT post_id AS postId, verdict FROM collection_feedback WHERE collection_id = ?')
    .all(id) as { postId: string; verdict: number }[]
  return {
    yes: rows.filter((row) => row.verdict > 0).map((row) => row.postId),
    no: rows.filter((row) => row.verdict < 0).map((row) => row.postId)
  }
}

export interface Membership {
  /** Le degré de chaque post, en écarts-types. Sert à la carte thermique. */
  scores: Scores
  /** Ce qui est retenu, après coupe et verdicts. */
  members: string[]
  size: number
}

/**
 * Recalculer l'appartenance, et la ranger.
 *
 * Le seuil d'abord, les verdicts ensuite : un « oui » entre quel que soit son score, un « non »
 * sort quel que soit le sien. C'est l'ordre qui compte — l'inverse laisserait le seuil défaire
 * un geste explicite, et il n'y a rien de plus agaçant qu'un réglage qui annule ce qu'on vient
 * de décider.
 *
 * `collection_posts` est réécrite d'un bloc, dans une transaction. Un recalcul partiel laisserait
 * une collection à moitié à jour, ce qui se verrait dans la mosaïque et dans les comptes.
 */
export function recompute(id: number): Membership | null {
  const definition = definitionOf(id)
  if (!definition) return null
  /* Une liste posée à la main n'a rien à recalculer, et surtout rien à perdre : la réécrire
     depuis un score qu'elle n'a pas la viderait. */
  if (definition.kind !== 'query') return null
  const scores = scoreKeywords(definition.keywords)
  const verdict = verdicts(id)
  const forcedOut = new Set(verdict.no)
  const forcedIn = new Set(verdict.yes)

  const cut = cutFor(scores, definition.size)
  const degrees = new Map<string, number>()
  scores.ids.forEach((postId, at) => {
    const z = scores.z[at]
    if (forcedOut.has(postId)) return
    if (forcedIn.has(postId) || z >= cut) degrees.set(postId, z)
  })
  // Un « oui » sur un post que le prototype ne sait pas noter doit tout de même entrer.
  for (const postId of forcedIn) if (!degrees.has(postId)) degrees.set(postId, cut)

  const db = getDb()
  const now = Date.now()
  db.transaction(() => {
    db.prepare('DELETE FROM collection_posts WHERE collection_id = ?').run(id)
    const insert = db.prepare(
      'INSERT OR REPLACE INTO collection_posts (collection_id, post_id, added_at, degree) VALUES (?, ?, ?, ?)'
    )
    for (const [postId, degree] of degrees) {
      insert.run(id, postId, now, Number.isFinite(degree) ? degree : null)
    }
  })()

  return {
    scores,
    size: definition.size,
    members: [...degrees.keys()]
  }
}

/** Les degrés de toute la bibliothèque, pour peindre la carte thermique. */
export function heatOf(
  id: number
): { postIds: string[]; degrees: number[]; size: number } | null {
  const definition = definitionOf(id)
  if (!definition) return null
  const scores = scoreKeywords(definition.keywords)
  return {
    postIds: scores.ids,
    /* `-Infinity` ne traverse pas JSON : un post que le prototype ne sait pas noter devient un
       degré nul, ce qui est exactement ce que la carte doit en faire — l'éteindre. */
    degrees: Array.from(scores.z, (value) => (Number.isFinite(value) ? value : -9)),
    size: definition.size
  }
}

/**
 * Créer une collection depuis une phrase.
 *
 * Rien d'autre n'est demandé : pas de sélection, pas d'exemple. C'est le point où tout se joue
 * — SigLIP a été entraîné pour que les mots et les images partagent un repère, donc écrire
 * « production musicale » suffit à noter neuf mille posts. Le libellé compte, et beaucoup :
 * mesuré, la phrase nue rend 43,7 % de justesse en zéro-shot contre 24,1 % pour un nom suivi de
 * mots-clés.
 */
export async function createFromPhrase(phrase: string): Promise<number> {
  const clean = phrase.trim()
  if (!clean) throw new Error('Phrase vide')
  const info = getDb()
    .prepare(
      "INSERT INTO collections (name, sort_index, kind, target_size) VALUES (?, 0, 'query', ?)"
    )
    .run(clean, DEFAULT_SIZE)
  const id = Number(info.lastInsertRowid)
  /* Le nom devient le premier mot-clé, et cesse ensuite d'être la définition : renommer
     n'entraîne plus mille posts. C'est la séparation demandée — un nom se lit, des mots
     choisissent. */
  await addKeyword(id, clean, 1)
  return id
}

/** Ajouter un mot à une collection. Le seul moment où le modèle de texte est réveillé. */
export async function addKeyword(
  id: number,
  word: string,
  weight = 1
): Promise<Membership | null> {
  const clean = word.trim()
  if (!clean) return recompute(id)
  const vector = await encodePhrase(clean)
  const order = (
    getDb()
      .prepare(
        'SELECT COALESCE(MAX(sort_index), -1) + 1 AS next FROM collection_keywords WHERE collection_id = ?'
      )
      .get(id) as { next: number }
  ).next
  saveKeyword(id, clean, weight, vector, order)
  return recompute(id)
}

/** Changer le poids d'un mot. Aucun encodage : seul le facteur bouge. */
export function setKeywordWeight(id: number, word: string, weight: number): Membership | null {
  getDb()
    .prepare('UPDATE collection_keywords SET weight = ? WHERE collection_id = ? AND word = ?')
    .run(Math.max(0, Math.min(3, weight)), id, word)
  return recompute(id)
}

export function removeKeyword(id: number, word: string): Membership | null {
  getDb()
    .prepare('DELETE FROM collection_keywords WHERE collection_id = ? AND word = ?')
    .run(id, word)
  return recompute(id)
}

/** Les mots d'une collection, tels que l'écran les affiche. */
export function keywordsOf(id: number): { word: string; weight: number }[] {
  return getDb()
    .prepare(
      'SELECT word, weight FROM collection_keywords WHERE collection_id = ? ORDER BY sort_index, word'
    )
    .all(id) as { word: string; weight: number }[]
}

/** Créer une collection depuis une poignée de posts, sans avoir à la nommer d'abord. */
/**
 * Une collection qui est une liste, et rien d'autre.
 *
 * C'est ce que produit un rangement rapide, et ce que devient une collection qu'on choisit de
 * garder avant une analyse approfondie : « manual » la met hors d'atteinte du recalcul. Elle ne
 * s'affiche pas en chaleur sur la carte — elle n'a pas de définition à montrer — mais elle reste
 * une collection ordinaire partout ailleurs.
 */
export function createManual(name: string, postIds: string[]): number {
  const clean = name.trim() || 'Sans nom'
  const db = getDb()
  const info = db
    .prepare("INSERT INTO collections (name, sort_index, kind) VALUES (?, 0, 'manual')")
    .run(clean)
  const id = Number(info.lastInsertRowid)
  const now = Date.now()
  const insert = db.prepare(
    'INSERT OR REPLACE INTO collection_posts (collection_id, post_id, added_at, degree) VALUES (?, ?, ?, NULL)'
  )
  db.transaction(() => {
    for (const postId of postIds) insert.run(id, postId, now)
  })()
  return id
}

/** Renommer redéfinit : la phrase *est* la collection. */
/**
 * Renommer, et rien de plus.
 *
 * Le nom était la définition : corriger une faute d'orthographe déplaçait mille posts. Ce sont
 * les mots-clés qui choisissent désormais, et un nom ne fait que se lire.
 */
export function rename(id: number, name: string): void {
  const clean = name.trim()
  if (!clean) throw new Error('Nom vide')
  getDb().prepare('UPDATE collections SET name = ? WHERE id = ?').run(clean, id)
}

/** Combien de posts la collection retient. Borné : voir `SIZE_MIN`/`SIZE_MAX` côté écran. */
export function setSize(id: number, size: number): Membership | null {
  const bounded = Math.max(10, Math.min(5000, Math.round(size)))
  getDb().prepare('UPDATE collections SET target_size = ? WHERE id = ?').run(bounded, id)
  return recompute(id)
}

/**
 * Les posts que deux collections se disputent.
 *
 * L'appartenance multiple était le but, mais elle a besoin d'être regardée : un post au-dessus
 * du seuil de trois collections est soit un post riche, soit le signe qu'une de ces collections
 * est trop large. Cette liste est la seule façon de faire la différence, et c'est là que le
 * réglage se fait vraiment.
 */
export function contested(minimum = 2): { postId: string; collectionIds: number[] }[] {
  const rows = getDb()
    .prepare(
      `SELECT post_id AS postId, GROUP_CONCAT(collection_id) AS ids, COUNT(*) AS n
         FROM collection_posts
        GROUP BY post_id
       HAVING n >= ?
        ORDER BY n DESC, post_id
        LIMIT 500`
    )
    .all(minimum) as { postId: string; ids: string; n: number }[]
  return rows.map((row) => ({
    postId: row.postId,
    collectionIds: row.ids.split(',').map((value) => Number(value))
  }))
}

/**
 * Les vingt-sept thèmes, en brouillons.
 *
 * Ils ne sont plus des catégories câblées : ce sont des phrases comme les autres, donc des
 * collections comme les autres — qu'on renomme, qu'on élague, qu'on élargit. Une bibliothèque
 * neuve est classée dès la première analyse, comme avant ; mais devant neuf mille posts, une
 * page blanche serait une corvée, et vingt-sept brouillons à élaguer prennent dix minutes.
 *
 * Appelé une seule fois, et seulement si aucune collection n'existe : ré-amorcer une
 * bibliothèque déjà rangée y remettrait ce que l'utilisateur avait retiré.
 */
export async function seedFromTopics(): Promise<number> {
  const existing = (
    getDb().prepare('SELECT COUNT(*) AS n FROM collections').get() as { n: number }
  ).n
  if (existing > 0) return 0
  const french = interfaceLanguage() === 'fr'
  let made = 0
  for (const topic of TOPIC_NAMES) {
    /* Le nom du thème dans la langue de l'interface, et non son descripteur à mots-clés : c'est
       ce que l'utilisateur va lire et réécrire. Le prototype, lui, encode la phrase telle
       quelle des deux côtés — SigLIP est multilingue, et une collection doit porter le nom
       qu'on lui donnerait, pas une traduction de travail. */
    const name = (french ? topic.fr : topic.en).trim()
    if (!name) continue
    await createFromPhrase(name)
    made += 1
  }
  return made
}

/** Supprimer une collection. Les appartenances et les mots s'en vont avec elle, en cascade. */
export function remove(id: number): void {
  getDb().prepare('DELETE FROM collections WHERE id = ?').run(id)
}

/**
 * Fondre une collection dans une autre.
 *
 * Les mots se réunissent en gardant le poids le plus fort de chaque côté — deux collections
 * qu'on fusionne parce qu'elles disaient la même chose ne doivent pas s'affaiblir l'une l'autre.
 * Les membres posés à la main suivent. Puis la source disparaît : une fusion qui laisserait un
 * doublon vide n'en serait pas une.
 *
 * Une liste manuelle fondue dans une collection à mots-clés lui apporte ses posts en membres
 * épinglés, sans mot : c'est bien ce qu'on veut, ces posts ont été choisis, pas déduits.
 */
export function merge(sourceId: number, targetId: number): Membership | null {
  if (sourceId === targetId) return recompute(targetId)
  const db = getDb()
  db.transaction(() => {
    db.prepare(
      `INSERT INTO collection_keywords
         (collection_id, word, weight, vector_text, vector_meaning, sort_index)
       SELECT ?, word, weight, vector_text, vector_meaning,
              (SELECT COALESCE(MAX(sort_index), -1) + 1 FROM collection_keywords WHERE collection_id = ?)
                + sort_index
         FROM collection_keywords WHERE collection_id = ?
       ON CONFLICT(collection_id, word) DO UPDATE SET weight = MAX(weight, excluded.weight)`
    ).run(targetId, targetId, sourceId)
    /* Les membres épinglés de la source. Pour une collection à mots-clés, le recalcul qui suit
       les remplacera de toute façon ; pour une liste manuelle, ce sont eux qui comptent. */
    db.prepare(
      `INSERT OR IGNORE INTO collection_posts (collection_id, post_id, added_at, degree)
       SELECT ?, post_id, added_at, NULL FROM collection_posts WHERE collection_id = ?`
    ).run(targetId, sourceId)
    db.prepare('DELETE FROM collections WHERE id = ?').run(sourceId)
  })()
  return recompute(targetId)
}

/**
 * Qui appartient à quoi, une collection par post.
 *
 * L'appartenance est multiple par construction, mais colorer un point demande d'en choisir
 * **une** — un pixel n'a qu'une teinte. On prend celle où le post compte le plus, son degré
 * étant justement une mesure de cela. Les appartenances posées à la main passent devant toutes
 * les autres : leur degré est nul en base, et un choix explicite ne se laisse pas doubler par un
 * calcul.
 *
 * Sert à deux choses à l'écran, et c'est pour cela que la réponse est unique : teinter les points
 * à la couleur de leur collection, et poser le nom de chaque collection au milieu des siens.
 */
export function membership(): {
  id: number
  name: string
  color: string | null
  postIds: string[]
}[] {
  const rows = getDb()
    .prepare(
      `SELECT cp.post_id AS postId, cp.collection_id AS collectionId
         FROM collection_posts cp
         JOIN (
           SELECT post_id, MAX(COALESCE(degree, 1e9)) AS best
             FROM collection_posts GROUP BY post_id
         ) top ON top.post_id = cp.post_id AND COALESCE(cp.degree, 1e9) = top.best
        GROUP BY cp.post_id`
    )
    .all() as { postId: string; collectionId: number }[]

  const rooms = new Map<number, string[]>()
  for (const row of rows) {
    const list = rooms.get(row.collectionId)
    if (list) list.push(row.postId)
    else rooms.set(row.collectionId, [row.postId])
  }

  return (
    getDb()
      .prepare(
        "SELECT id, name, color FROM collections WHERE kind = 'query' ORDER BY sort_index, name COLLATE NOCASE"
      )
      .all() as { id: number; name: string; color: string | null }[]
  ).map((row) => ({ ...row, postIds: rooms.get(row.id) ?? [] }))
}

/**
 * Ne garder que les collections désignées, et mettre celles-là hors d'atteinte.
 *
 * Appelé avant une analyse approfondie qui succède à un rangement rapide. Les deux produisent
 * chacun un jeu de collections couvrant la bibliothèque ; les laisser cohabiter donnerait deux
 * fois les mêmes thèmes sous deux noms, et personne ne saurait lequel fait foi. On demande donc,
 * plutôt que de choisir à la place de l'utilisateur.
 *
 * Ce qu'on garde passe en « manual » : plus aucun recalcul n'y touche, et la carte ne l'affiche
 * pas — elle n'a pas de définition à montrer. Ce n'est pas une archive figée pour autant : c'est
 * une collection ordinaire partout ailleurs, qu'on peut ouvrir, filtrer et exporter.
 */
export function keepOnly(ids: number[]): { kept: number; removed: number } {
  const db = getDb()
  const keep = new Set(ids.map(Number))
  const all = (db.prepare('SELECT id FROM collections').all() as { id: number }[]).map(
    (row) => row.id
  )
  const doomed = all.filter((id) => !keep.has(id))
  db.transaction(() => {
    for (const id of keep) {
      db.prepare("UPDATE collections SET kind = 'manual' WHERE id = ?").run(id)
      /* Les mots ne servent plus à rien sur une liste, et les laisser ferait ressortir la
         collection au premier recalcul si son genre était un jour remis à « query ». */
      db.prepare('DELETE FROM collection_keywords WHERE collection_id = ?').run(id)
    }
    for (const id of doomed) db.prepare('DELETE FROM collections WHERE id = ?').run(id)
  })()
  return { kept: keep.size, removed: doomed.length }
}
