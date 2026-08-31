/**
 * Schéma SQLite. Voir SPEC.md §4.
 *
 * Le schéma complet est posé dès M0 même si tout n'est pas encore utilisé : ajouter une
 * colonne à une base vide ne coûte rien, la rétro-adapter une fois qu'elle contient
 * plusieurs milliers de posts coûte beaucoup plus.
 */
export const SCHEMA_VERSION = 28

/**
 * Les paliers 2 à 8, en SQL comme tous les autres.
 *
 * Ils vivaient en fonctions dans db/index.ts, qui importe electron : la vérification
 * check:schema devait alors faire résoudre le binaire Electron pour lire l'échelle des
 * migrations. Ici elles sont à côté du schéma quelles entretiennent, et le contrôle qui
 * compare les deux ne dépend plus de rien.
 */
export const MIGRATION_2_SQL = /* sql */ `
ALTER TABLE media ADD COLUMN video_source TEXT;
ALTER TABLE media ADD COLUMN video_path TEXT;
`

/* Tout ce qui existait avant l'arrivée des vrais comptes vient de la fixture. */
export const MIGRATION_3_SQL = /* sql */ `
ALTER TABLE posts ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;
`

export const MIGRATION_4_SQL = /* sql */ `
ALTER TABLE posts ADD COLUMN label TEXT;
ALTER TABLE collections ADD COLUMN color TEXT;
CREATE INDEX IF NOT EXISTS idx_posts_label ON posts(label) WHERE label IS NOT NULL;
`

export const MIGRATION_5_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS media_variants (
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  quality    TEXT NOT NULL,
  source     TEXT NOT NULL,
  width      INTEGER,
  height     INTEGER,
  bitrate    INTEGER,
  cache_path TEXT,
  PRIMARY KEY (post_id, idx, quality)
);
`

export const MIGRATION_6_SQL = /* sql */ `
ALTER TABLE media ADD COLUMN video_cache_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE media ADD COLUMN video_attempts INTEGER NOT NULL DEFAULT 0;
`

export const MIGRATION_7_SQL = /* sql */ `
ALTER TABLE media ADD COLUMN thumb_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_posts_feed ON posts(
  is_archived, COALESCE(saved_at, discovered_at) DESC, saved_rank ASC, id
);
CREATE INDEX IF NOT EXISTS idx_media_thumb_queue
  ON media(thumb_path, thumb_attempts, post_id, idx);
CREATE INDEX IF NOT EXISTS idx_media_video_queue ON media(
  video_cache_state, video_attempts, video_path, post_id, idx
);
`

export const MIGRATION_8_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS local_video_features (
  post_id    TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  thumb_path TEXT,
  visual     BLOB,
  updated_at INTEGER NOT NULL
);
`
export const MIGRATION_9_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS post_sources (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('saved', 'liked')),
  source_rank INTEGER,
  source_at INTEGER,
  discovered_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, source)
);
CREATE INDEX IF NOT EXISTS idx_post_sources_feed
  ON post_sources(source, source_at DESC, source_rank ASC, post_id);
CREATE TABLE IF NOT EXISTS account_sync_sources (
  platform TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('saved', 'liked')),
  last_sync_at INTEGER,
  last_sync_status TEXT,
  cursor TEXT,
  PRIMARY KEY (platform, source)
);
INSERT OR IGNORE INTO post_sources (post_id, source, source_rank, source_at, discovered_at)
  SELECT id, 'saved', saved_rank, saved_at, discovered_at FROM posts;
INSERT OR IGNORE INTO account_sync_sources (platform, source, last_sync_at, last_sync_status, cursor)
  SELECT platform, 'saved', last_sync_at, last_sync_status, cursor FROM accounts;
`

export const MIGRATION_10_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS organizer_rules (
  rule_key      TEXT PRIMARY KEY,
  collection_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,
  ignored       INTEGER NOT NULL DEFAULT 0 CHECK(ignored IN (0, 1)),
  updated_at    INTEGER NOT NULL,
  CHECK((ignored = 1 AND collection_id IS NULL) OR (ignored = 0 AND collection_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_organizer_rules_collection
  ON organizer_rules(collection_id) WHERE collection_id IS NOT NULL;
`

export const MIGRATION_11_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS collection_removals (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  removed_at    INTEGER NOT NULL,
  PRIMARY KEY (collection_id, post_id)
);
`

export const MIGRATION_12_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS organizer_applications (
  id            INTEGER PRIMARY KEY,
  applied_at    INTEGER NOT NULL,
  collections   INTEGER NOT NULL,
  posts         INTEGER NOT NULL,
  created_ids   TEXT NOT NULL,
  filed         TEXT NOT NULL
);
`

export const MIGRATION_13_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS post_embeddings (
  post_id    TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  hash       TEXT NOT NULL,
  vector     BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
`

export const MIGRATION_14_SQL = /* sql */ `
ALTER TABLE posts ADD COLUMN transcript TEXT;

-- L'index plein texte gagne une colonne : il faut le refaire, triggers compris. Chercher un
-- reel par ce qui y est dit vaut à lui seul la reconstruction.
DROP TRIGGER IF EXISTS posts_fts_ai;
DROP TRIGGER IF EXISTS posts_fts_ad;
DROP TRIGGER IF EXISTS posts_fts_au;
DROP TABLE IF EXISTS posts_fts;

CREATE VIRTUAL TABLE posts_fts USING fts5(
  text,
  ai_description,
  author_handle,
  transcript,
  content='posts',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER posts_fts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, text, ai_description, author_handle, transcript)
  VALUES (new.rowid, new.text, new.ai_description, new.author_handle, new.transcript);
END;

CREATE TRIGGER posts_fts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, text, ai_description, author_handle, transcript)
  VALUES ('delete', old.rowid, old.text, old.ai_description, old.author_handle, old.transcript);
END;

CREATE TRIGGER posts_fts_au AFTER UPDATE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, text, ai_description, author_handle, transcript)
  VALUES ('delete', old.rowid, old.text, old.ai_description, old.author_handle, old.transcript);
  INSERT INTO posts_fts(rowid, text, ai_description, author_handle, transcript)
  VALUES (new.rowid, new.text, new.ai_description, new.author_handle, new.transcript);
END;

INSERT INTO posts_fts(posts_fts) VALUES('rebuild');
`

/* La table des vecteurs d'image, ajoutee avec l'etape « Lire les images ». Elle etait bien
   dans le schema de creation, mais pas ici : une base existante ne l'a donc jamais recue, et
   l'analyse s'arretait sur « no such table ». Un schema n'est complet que quand la migration
   qui va avec existe. */
export const MIGRATION_15_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS post_image_embeddings (
  post_id    TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  hash       TEXT NOT NULL,
  structure  BLOB NOT NULL,
  meaning    BLOB NOT NULL,
  frames     INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
`

/**
 * La carte, figée, et les frontières que l'utilisateur y a posées.
 *
 * Deux tables, et un invariant qui les lie : **une frontière ne veut rien dire sans les
 * positions contre lesquelles elle a été tracée.** Reprojeter déplace les neuf mille points ;
 * un contour dessiné sur l'ancienne carte désignerait alors n'importe quoi. Les deux tables
 * se vident donc ensemble, et c'est ce que l'avertissement « cela effacera vos frontières »
 * traduit à l'écran.
 *
 * `post_positions` est aussi ce qui rend les frontières utiles au-delà de l'affichage : un
 * post arrivé à la synchro suivante est placé par interpolation de ses voisins déjà posés,
 * tombe dans une région, et prend sa collection. Le modèle UMAP, lui, ne survit pas à la
 * fermeture de l'application — les positions, si.
 *
 * `shape` est la région elle-même : les anneaux de sommets, en JSON, dans le repère unité de
 * la carte. Du vectoriel et non un masque de bits — un masque se pixellise au zoom, ne peut
 * pas être lissé, et n'offre aucune poignée à saisir. Les sommets, eux, sont déjà les points
 * de contrôle de la courbe qu'on trace.
 */
export const MIGRATION_16_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS map_labels (
  id         TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  anchors    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS post_positions (
  post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  x       REAL NOT NULL,
  y       REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_boundaries (
  name       TEXT PRIMARY KEY,
  shape      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

/**
 * Les étiquettes que l'utilisateur pose lui-même sur la carte.
 *
 * Un titre visuel, pour nommer un endroit dense que l'analyse n'a pas nommé. La carte en a
 * besoin : elle place les posts sans jamais dire ce qu'est cet amas lumineux entre deux
 * collections.
 *
 * `anchors` retient **les posts qui l'entouraient**, pas une position. C'est la différence qui
 * compte : une reprojection déplace les neuf mille points, et une étiquette figée en
 * coordonnées désignerait alors autre chose — exactement le défaut qu'on a payé sur les
 * frontières. Accrochée à ses voisins, elle se repose à leur nouveau centre de gravité et
 * continue de nommer ce qu'elle nommait.
 */
export const MIGRATION_17_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS map_labels (
  id         TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  anchors    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`

/**
 * Compter les tentatives de transcription, et rendre leur chance aux abandonnées.
 *
 * `transcript = ''` voulait dire deux choses à la fois : « écouté, il n'y avait rien à en
 * tirer » et « la lecture a échoué ». Les deux menaient au même endroit — un post que plus
 * aucune passe ne reprendrait jamais. Or l'échec est fréquent et réparable : quand le clip
 * n'est pas encore en cache, l'audio est tiré de l'URL de la plateforme, et une URL de CDN
 * expire. Relevé sur la bibliothèque de référence, vingt posts marqués vides au hasard :
 * treize étaient de la musique sans parole — le verdict était juste —, deux n'avaient aucune
 * piste audio, et cinq portaient une phrase entière que l'application avait perdue.
 *
 * D'où une colonne de tentatives, sur le modèle de `media.thumb_attempts` : un échec ne
 * conclut plus rien, il compte. Trois échecs valent renoncement, ce qui borne la file sans
 * condamner un clip pour une URL périmée. `''` retrouve alors son seul sens : écouté, rien
 * dedans.
 *
 * Et les vides déjà en base repartent à zéro. Ils ont été écrits par le code qui confondait
 * les deux cas ; les garder, c'est garder la perte. Rien ne se relance tout seul pour autant
 * — la transcription ne démarre que sur demande, l'étape annoncera simplement de nouveau
 * son compte.
 */
export const MIGRATION_18_SQL = /* sql */ `
ALTER TABLE posts ADD COLUMN transcript_attempts INTEGER NOT NULL DEFAULT 0;
UPDATE posts SET transcript = NULL WHERE transcript = '';
`

/**
 * Une collection cesse d'être une liste et devient une requête.
 *
 * Ce qu'elle porte désormais : une phrase, deux vecteurs, une ampleur. La phrase est ce que
 * l'utilisateur écrit — « production musicale » — et SigLIP la place dans le même repère que
 * les images, ce qui fait qu'un mot peut noter neuf mille posts. L'ampleur est le seuil, en
 * écarts-types de la distribution de cette collection : elle se lit toujours de la même façon,
 * quel que soit le nombre de collections voisines.
 *
 * L'ampleur est un **nombre de posts**, et non un seuil de confiance. Ce n'est pas un choix de
 * commodité : mesuré, une phrase étrangère à la bibliothèque note aussi haut qu'une phrase
 * centrale — « comptabilité fiscale » culmine plus haut que « 3D et rendu ». Un seuil de
 * confiance aurait donc inventé quatre cents membres à n'importe quoi. L'ordre, lui, est juste ;
 * on garde donc les N premiers, N étant choisi à vue par la personne qui regarde.
 *
 * `collection_posts` reste la vérité pour tout le reste de l'application — la mosaïque, les
 * comptes, l'export. Elle n'est plus saisie à la main mais **recalculée** à partir de la
 * requête, avec le degré d'appartenance à côté de chaque ligne. C'est ce qui permet de tout
 * changer ici sans rien casser ailleurs : en aval, une collection reste une liste de posts.
 *
 * Et `collection_feedback` garde les verdicts. Un « oui » ou un « non » ne se contente pas de
 * déplacer le prototype : il force aussi l'appartenance du post concerné. Sans cela, cliquer
 * « non » sur un post qui reste au-dessus du seuil ne changerait rien de visible, et l'interface
 * mentirait sur l'effet du geste.
 */
export const MIGRATION_19_SQL = /* sql */ `
ALTER TABLE collections ADD COLUMN query TEXT;
ALTER TABLE collections ADD COLUMN prototype_text BLOB;
ALTER TABLE collections ADD COLUMN prototype_meaning BLOB;
ALTER TABLE collections ADD COLUMN target_size INTEGER NOT NULL DEFAULT 300;
ALTER TABLE collection_posts ADD COLUMN degree REAL;

CREATE TABLE IF NOT EXISTS collection_feedback (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  verdict       INTEGER NOT NULL,
  at            INTEGER NOT NULL,
  PRIMARY KEY (collection_id, post_id)
);
`

/**
 * Le nom d'une collection et sa définition cessent d'être la même chose.
 *
 * Une phrase unique était un raccourci commode et une limite dure : renommer redéfinissait, et
 * « Production musicale » ne pouvait pas vouloir dire *aussi* « ableton », « synthétiseur »,
 * « mixage ». Or c'est exactement ainsi qu'on pense une catégorie — par une poignée de mots dont
 * **un seul suffit**, pas par leur moyenne. La moyenne dilue : ajouter « ableton » à un thème
 * large déplaçait tout le thème au lieu d'y faire entrer les posts Ableton.
 *
 * D'où des mots-clés, chacun avec son poids. Le score d'un post est le **meilleur** de ses
 * `poids × ressemblance` : une union pondérée, pas un centre de gravité. Un mot fort attire, un
 * mot faible complète, et retirer un mot ne déforme pas les autres.
 *
 * `kind` sépare deux natures de collections qui n'ont pas à se ressembler. Une collection
 * `query` est définie par ses mots et recalculée ; une collection `manual` est une liste de
 * posts, posée à la main ou par un rangement rapide, que rien ne recalcule. Les deux vivent
 * ensemble dans `collection_posts` — c'est ce qui permet à la mosaïque de continuer à ne
 * connaître que des listes.
 */
export const MIGRATION_20_SQL = /* sql */ `
ALTER TABLE collections ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual';

CREATE TABLE IF NOT EXISTS collection_keywords (
  collection_id   INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  word            TEXT NOT NULL,
  weight          REAL NOT NULL DEFAULT 1,
  vector_text     BLOB,
  vector_meaning  BLOB,
  sort_index      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, word)
);

-- Les collections nées d'une phrase deviennent des collections à mots-clés, avec cette phrase
-- pour premier mot. Rien n'est perdu et rien ne bouge : un mot unique donne le même résultat
-- qu'une phrase unique.
UPDATE collections SET kind = 'query' WHERE query IS NOT NULL;

INSERT OR IGNORE INTO collection_keywords
  (collection_id, word, weight, vector_text, vector_meaning, sort_index)
SELECT id, query, 1, prototype_text, prototype_meaning, 0
  FROM collections WHERE query IS NOT NULL AND trim(query) <> '';
`

/**
 * Ce qui a produit les positions rangées dans post_positions.
 *
 * Sans elle, la carte figée ne pouvait pas savoir si elle était encore valable : la seule
 * question posée était « y a-t-il des positions ? », jamais « viennent-elles des mêmes
 * réglages ? ». Un changement de recette ou de voisinage aurait donc été servi depuis
 * l’ancienne carte, indéfiniment et sans que rien ne le signale.
 *
 * Le nombre de posts n'entre **pas** dans l'empreinte, et c'est délibéré : des posts qui
 * arrivent ne doivent pas déplacer la carte, ils viennent s’y poser. C’est déjà ce que fait
 * `placeAgainstFrozen`, et sa règle de couverture décide seule quand reprojeter pour de bon.
 */
export const MIGRATION_21_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS map_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  fingerprint TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
`

/**
 * Les frontières s'en vont.
 *
 * Leur édition a quitté l'interface en 0.29.0 quand une collection est devenue une requête ;
 * depuis, le seul appelant passait `showBoundaries={false}` en dur. La table restait, et sur
 * les bases migrées elle portait encore une colonne `mask` là où le code interrogeait
 * `shape` — donc « no such column » à chaque appel, sur une base pourtant à jour. Une
 * migration publiée puis corrigée sur place ne reconstruit rien chez ceux qui l’ont déjà
 * passée : la corriger demandait ce palier neuf. Autant la retirer.
 */
export const MIGRATION_22_SQL = /* sql */ `
DROP TABLE IF EXISTS collection_boundaries;
`

/**
 * Les colonnes filles des clés étrangères, indexées.
 *
 * `collection_posts` a pour clé primaire (collection_id, post_id) : l'index composite sert
 * les recherches par collection, mais aucune ne part du post. Or trois chemins le font —
 * `collectionsForPost()` à chaque ouverture du panneau de détail, et la sous-requête
 * corrélée de l'export, **une fois par post**. Chacun balayait la table entière.
 *
 * Même chose pour les autres colonnes filles : avec `foreign_keys = ON`, SQLite les parcourt
 * à chaque suppression de post pour vérifier la contrainte.
 */
export const MIGRATION_23_SQL = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_collection_posts_post ON collection_posts(post_id);
CREATE INDEX IF NOT EXISTS idx_collection_removals_post ON collection_removals(post_id);
CREATE INDEX IF NOT EXISTS idx_collection_feedback_post ON collection_feedback(post_id);
CREATE INDEX IF NOT EXISTS idx_collections_cover ON collections(cover_post_id)
  WHERE cover_post_id IS NOT NULL;
`

/**
 * Une carte figée par regard, et non plus une seule.
 *
 * Les positions n'étaient rangées que pour le mélange équilibré ; les autres regards vivaient
 * dans une carte en mémoire, perdue à la fermeture et vidée dès qu'un plan était reconstruit.
 * Chaque bascule coûtait donc une projection entière — 43,8 s mesurées sur la bibliothèque de
 * référence — ce qui interdisait de rendre les regards à l'écran. Avec le regard dans la clé,
 * la seconde visite coûte ce que coûte une lecture : deux millisecondes.
 *
 * Les positions existantes deviennent celles du regard équilibré, qui est le seul qu'elles
 * aient jamais décrit. Rien n'est reprojeté : la carte de tout le monde reste la carte qu'ils
 * connaissent.
 *
 * `post_id` reprend un index à lui : il n'est plus en tête de la clé primaire, et
 * `foreign_keys = ON` parcourt cette colonne à chaque suppression de post — voir
 * MIGRATION_23_SQL, même raison.
 */
export const MIGRATION_24_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS post_positions_next (
  layout  TEXT NOT NULL,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  x       REAL NOT NULL,
  y       REAL NOT NULL,
  PRIMARY KEY (layout, post_id)
);
INSERT OR IGNORE INTO post_positions_next (layout, post_id, x, y)
  SELECT 'equilibre', post_id, x, y FROM post_positions;
DROP TABLE post_positions;
ALTER TABLE post_positions_next RENAME TO post_positions;
CREATE INDEX IF NOT EXISTS idx_post_positions_post ON post_positions(post_id);

CREATE TABLE IF NOT EXISTS map_state_next (
  layout      TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
-- La reprise n'a lieu que si l'ancienne forme est là. Le contrôle de schéma rejoue l'échelle
-- entière par-dessus SCHEMA_SQL, où map_state porte déjà sa clé neuve : lire id sans
-- précaution y lève, et une migration qui ne se rejoue pas ne se vérifie pas.
INSERT OR IGNORE INTO map_state_next (layout, fingerprint, updated_at)
  SELECT 'equilibre', fingerprint, updated_at FROM map_state
   WHERE EXISTS (SELECT 1 FROM pragma_table_info('map_state') WHERE name = 'id');
DROP TABLE map_state;
ALTER TABLE map_state_next RENAME TO map_state;
`

/**
 * Les vidéos déclarées muettes par une passe qui échouait retrouvent leur file.
 *
 * MIGRATION_18_SQL avait déjà fait ce ménage, contre un bug qui confondait « écouté, rien à en
 * tirer » et « pas pu écouter ». La distinction avait été posée au bon endroit — mais un cas
 * restait confondu : une reconnaissance qui **lève** sur un clip local était comptée comme un
 * verdict, alors qu'elle n'apprend rien sur la vidéo. Une panne du modèle a donc suffi à
 * condamner tout ce qu'elle touchait, une vidéo à la fois, sans que rien ne s'en aperçoive :
 * l'étape annonçait ensuite zéro vidéo à faire et se terminait en une seconde.
 *
 * Relevé sur une bibliothèque réelle : 4 529 vidéos sur 4 530 portaient le verdict « muette »
 * alors que leur piste audio était intacte — rejouée depuis, la même reconnaissance les
 * transcrit sans broncher. C'est près de la moitié de la bibliothèque qui avait perdu la
 * parole, et avec elle ce que le classement pouvait lire des vidéos.
 *
 * On remet donc à zéro, comme en v18. Les vidéos réellement muettes repasseront une fois par
 * ffmpeg et retrouveront leur verdict en quelques secondes ; les autres retrouveront leur voix.
 * Rien ne se relance tout seul : la transcription ne démarre que sur demande, l'étape annoncera
 * simplement de nouveau son compte.
 */
export const MIGRATION_25_SQL = /* sql */ `
UPDATE posts SET transcript = NULL WHERE TRIM(COALESCE(transcript, '')) = '';
`

/**
 * Le même ménage, une troisième fois — et cette fois avec de quoi ne pas le refaire.
 *
 * La v18 puis la v25 ont chacune rendu leur file aux vidéos déclarées muettes par une passe
 * qui échouait. La v25 a corrigé le cas où la reconnaissance **lève**. Mais une panne ne lève
 * pas toujours : mesuré le 2026-08-26, la passe relancée juste après la v25 a réécrit le même
 * verdict sur 4 555 posts sans lever une seule fois — le modèle rendait « Music », « The End »,
 * « you », et `tidyTranscript` concluait honnêtement qu'il n'y avait rien à garder. Rejoué
 * depuis, le même code tire de la parole de treize clips sur vingt de plus de vingt secondes.
 *
 * Réparer une troisième fois sans rien changer d'autre serait un rite, pas un correctif. Cette
 * migration ne part donc qu'accompagnée de `transcript-guard` : une série de clips qui avaient
 * du son et la durée de parler sans en tirer un mot arrête désormais la passe et efface les
 * verdicts de la série. Le nettoyage ci-dessous est ce qui reste à rendre aux vidéos que les
 * deux passes précédentes ont fait taire.
 *
 * Comme en v18 et en v25 : rien ne se relance tout seul, et les vidéos réellement muettes
 * repasseront une fois par ffmpeg pour retrouver leur verdict en quelques secondes.
 */
export const MIGRATION_26_SQL = /* sql */ `
UPDATE posts SET transcript = NULL WHERE TRIM(COALESCE(transcript, '')) = '';
`

/**
 * Deux collections ne peuvent plus porter le même nom.
 *
 * Rien ne l'interdisait, et `createCollection` insérait sans vérifier. On pouvait donc créer
 * deux « Musique », l'une depuis le panneau latéral et l'autre depuis la vue détaillée — puis
 * la barre de sélection en résolvait une **au hasard**, par comparaison insensible à la casse,
 * en rangeant des posts dans celle qu'on ne regardait pas.
 *
 * Le dédoublonnage précède l'index, et il est déterministe : le plus petit identifiant garde
 * son nom, les autres reçoivent un suffixe numéroté. Du SQL pur, rejouable sur une base vide —
 * l'`UPDATE` ne touche alors aucune ligne — donc `check:schema` peut le rejouer sur une
 * connexion nue, sans aucune fonction enregistrée.
 */
export const MIGRATION_27_SQL = /* sql */ `
UPDATE collections SET name = name || ' (' || (
  SELECT COUNT(*) FROM collections AS earlier
   WHERE earlier.name = collections.name COLLATE NOCASE AND earlier.id < collections.id
) || ')'
WHERE EXISTS (
  SELECT 1 FROM collections AS earlier
   WHERE earlier.name = collections.name COLLATE NOCASE AND earlier.id < collections.id
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_name ON collections(name COLLATE NOCASE);
`

/**
 * De quoi rétablir des collections supprimées.
 *
 * L'écran « Que garder ? » supprimait définitivement toutes les collections en un clic. Son
 * bouton principal, dans un écran où l'on venait de cliquer sur « Approfondi » pour lancer une
 * analyse — pas pour faire du ménage — et avec **toutes les cases décochées par défaut**.
 *
 * On a d'abord cru pouvoir s'appuyer sur l'annulation existante : `revertOrganizerApplication`
 * ne sait que **défaire un classement**, c'est-à-dire désarchiver des posts et supprimer les
 * collections qu'il a lui-même créées. Rien, chez elle, ne peut recréer ce qui a été détruit.
 *
 * D'où cet instantané. Une seule ligne, remplacée à chaque fois, comme
 * `organizer_applications` : ce n'est pas un historique, c'est un filet pour le geste qu'on
 * vient de faire.
 *
 * Les prototypes ne sont pas conservés — ce sont des vecteurs recalculés à la passe suivante.
 * Ce qu'on garde est ce qui ne se recalcule pas : le nom, la couleur, les mots-clés et leurs
 * poids, et l'appartenance des posts, qui peut contenir des ajouts faits à la main.
 */
export const MIGRATION_28_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS collection_snapshots (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  taken_at  INTEGER NOT NULL,
  payload   TEXT NOT NULL
);
`

export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS posts (
  id              TEXT PRIMARY KEY,
  platform        TEXT NOT NULL,
  native_id       TEXT NOT NULL,
  url             TEXT NOT NULL,
  author_handle   TEXT,
  author_name     TEXT,
  author_avatar   TEXT,
  text            TEXT,
  ai_description  TEXT,
  -- Transcription locale de l'audio. C'est souvent le seul texte d'un Reel : sur la
  -- bibliothèque de référence, un quart des vidéos n'ont aucune prose exploitable.
  transcript      TEXT,
  transcript_attempts INTEGER NOT NULL DEFAULT 0,
  kind            TEXT NOT NULL,
  media_count     INTEGER NOT NULL DEFAULT 0,
  width           INTEGER,
  height          INTEGER,
  dominant_color  TEXT,
  published_at    INTEGER,
  saved_at        INTEGER,
  discovered_at   INTEGER NOT NULL,
  saved_rank      INTEGER,
  is_favorite     INTEGER NOT NULL DEFAULT 0,
  is_archived     INTEGER NOT NULL DEFAULT 0,
  -- Données de démonstration issues de la fixture, à distinguer des vrais signets pour
  -- pouvoir les retirer d'un geste au premier compte connecté.
  is_demo         INTEGER NOT NULL DEFAULT 0,
  -- Étiquette de couleur façon Finder : un repère qu'on voit sans lire.
  label           TEXT,
  tag_status      TEXT NOT NULL DEFAULT 'pending',
  raw             TEXT,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_platform  ON posts(platform);
CREATE INDEX IF NOT EXISTS idx_posts_saved     ON posts(saved_at DESC, saved_rank ASC);
CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_favorite  ON posts(is_favorite) WHERE is_favorite = 1;
CREATE INDEX IF NOT EXISTS idx_posts_label     ON posts(label) WHERE label IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_feed      ON posts(
  is_archived, COALESCE(saved_at, discovered_at) DESC, saved_rank ASC, id
);

CREATE TABLE IF NOT EXISTS post_sources (
  post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  source        TEXT NOT NULL CHECK(source IN ('saved', 'liked')),
  source_rank   INTEGER,
  source_at     INTEGER,
  discovered_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, source)
);
CREATE INDEX IF NOT EXISTS idx_post_sources_feed ON post_sources(source, source_at DESC, source_rank ASC, post_id);

CREATE TABLE IF NOT EXISTS media (
  id          INTEGER PRIMARY KEY,
  post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  remote_url  TEXT,
  source_path TEXT,
  thumb_path  TEXT,
  thumb_attempts INTEGER NOT NULL DEFAULT 0,
  -- Source du clip : chemin local ou URL distante, résolue comme celle de l'image.
  video_source TEXT,
  -- Clip en cache, servi au survol. Distinct de full_path, qui est l'archivage en
  -- pleine résolution demandé explicitement par l'utilisateur.
  video_path  TEXT,
  video_cache_state TEXT NOT NULL DEFAULT 'pending',
  video_attempts INTEGER NOT NULL DEFAULT 0,
  full_path   TEXT,
  width       INTEGER,
  height      INTEGER,
  UNIQUE (post_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_media_post ON media(post_id);
CREATE INDEX IF NOT EXISTS idx_media_thumb_queue ON media(thumb_path, thumb_attempts, post_id, idx);
CREATE INDEX IF NOT EXISTS idx_media_video_queue ON media(
  video_cache_state, video_attempts, video_path, post_id, idx
);

CREATE TABLE IF NOT EXISTS media_variants (
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  quality    TEXT NOT NULL,
  source     TEXT NOT NULL,
  width      INTEGER,
  height     INTEGER,
  bitrate    INTEGER,
  cache_path TEXT,
  PRIMARY KEY (post_id, idx, quality)
);

CREATE TABLE IF NOT EXISTS tags (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color  TEXT,
  source TEXT NOT NULL DEFAULT 'user'
);

CREATE TABLE IF NOT EXISTS post_tags (
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source     TEXT NOT NULL DEFAULT 'user',
  confidence REAL,
  PRIMARY KEY (post_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags(tag_id);

CREATE TABLE IF NOT EXISTS collections (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  cover_post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
  source        TEXT NOT NULL DEFAULT 'local',
  color         TEXT,
  sort_index    INTEGER NOT NULL DEFAULT 0,
  -- La phrase qui définit la collection, et le prototype qu'elle produit. Voir MIGRATION_19.
  query         TEXT,
  prototype_text    BLOB,
  prototype_meaning BLOB,
  target_size   INTEGER NOT NULL DEFAULT 300,
  -- « query » = définie par ses mots-clés et recalculée ; « manual » = une liste qu'on ne touche pas.
  kind          TEXT NOT NULL DEFAULT 'manual'
);

-- La clé primaire composite rend le doublon structurellement impossible : c'est ce qui
-- fonde le comportement du dialogue d'ajout décrit dans SPEC.md §9.
CREATE TABLE IF NOT EXISTS collection_posts (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  added_at      INTEGER NOT NULL,
  -- À quel point ce post appartient, en écarts-types. Nul pour une appartenance posée à la main.
  degree        REAL,
  PRIMARY KEY (collection_id, post_id)
);

CREATE TABLE IF NOT EXISTS collection_keywords (
  collection_id   INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  word            TEXT NOT NULL,
  weight          REAL NOT NULL DEFAULT 1,
  vector_text     BLOB,
  vector_meaning  BLOB,
  sort_index      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, word)
);

CREATE TABLE IF NOT EXISTS collection_feedback (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  verdict       INTEGER NOT NULL,
  at            INTEGER NOT NULL,
  PRIMARY KEY (collection_id, post_id)
);

-- Retraits décidés à la main. Le classement automatique les relit avant d'ajouter quoi que
-- ce soit : sans cette trace, un post sorti d'une collection y revenait à la
-- synchronisation suivante, le rangement défaisant alors le geste de l'utilisateur.
CREATE TABLE IF NOT EXISTS collection_removals (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  removed_at    INTEGER NOT NULL,
  PRIMARY KEY (collection_id, post_id)
);

-- Trace du dernier classement appliqué, et d'elle seule. Créer douze collections et y
-- verser des milliers de vidéos est une action lourde derrière un seul bouton : sans de
-- quoi revenir en arrière, elle demande une confiance qu'on n'a pas encore gagnée.
-- La colonne created_ids liste les collections nées de ce classement, filed ce qu'il a rangé.
CREATE TABLE IF NOT EXISTS collection_snapshots (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  taken_at  INTEGER NOT NULL,
  payload   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organizer_applications (
  id            INTEGER PRIMARY KEY,
  applied_at    INTEGER NOT NULL,
  collections   INTEGER NOT NULL,
  posts         INTEGER NOT NULL,
  created_ids   TEXT NOT NULL,
  filed         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  platform         TEXT PRIMARY KEY,
  handle           TEXT,
  connected_at     INTEGER,
  last_sync_at     INTEGER,
  last_sync_status TEXT,
  cursor           TEXT
);

CREATE TABLE IF NOT EXISTS account_sync_sources (
  platform         TEXT NOT NULL,
  source           TEXT NOT NULL CHECK(source IN ('saved', 'liked')),
  last_sync_at     INTEGER,
  last_sync_status TEXT,
  cursor           TEXT,
  PRIMARY KEY (platform, source)
);

-- Petite signature visuelle calculée localement à partir de la vignette. Elle permet à
-- l'organisateur de ne retraiter que les nouveaux médias lors des analyses suivantes.
CREATE TABLE IF NOT EXISTS local_video_features (
  post_id     TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  thumb_path  TEXT,
  visual      BLOB,
  updated_at  INTEGER NOT NULL
);

-- Vecteur de sens du texte d'un post, calculé localement. Le hash porte sur le texte
-- source : un post dont la légende n'a pas bougé n'est jamais réencodé, ce qui rend les
-- analyses suivantes quasi gratuites même sur une grande bibliothèque.
CREATE TABLE IF NOT EXISTS post_embeddings (
  post_id    TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  hash       TEXT NOT NULL,
  vector     BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Vecteurs de sens de l'image d'un post, calculés localement par deux encodeurs qui ne
-- regardent pas la même chose : DINOv2 la structure et le style, SigLIP le sujet. Mesurés
-- meilleurs ensemble que chacun seul (cf. scripts/bench-vision-mix).
--
-- Le hash porte sur le chemin de la vignette et la version des modèles : une vignette
-- réécrite — l'éviction du cache en produit — est réencodée, le reste jamais.
CREATE TABLE IF NOT EXISTS post_image_embeddings (
  post_id    TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  hash       TEXT NOT NULL,
  structure  BLOB NOT NULL,
  meaning    BLOB NOT NULL,
  frames     INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- Préférences apprises lors du premier tri local. Plusieurs clés peuvent pointer vers
-- la même collection : c'est ainsi qu'une fusion « 3D + Blender » reste valable pour les
-- prochains posts, même si la collection est ensuite renommée.
CREATE TABLE IF NOT EXISTS organizer_rules (
  rule_key       TEXT PRIMARY KEY,
  collection_id  INTEGER REFERENCES collections(id) ON DELETE CASCADE,
  ignored        INTEGER NOT NULL DEFAULT 0 CHECK(ignored IN (0, 1)),
  updated_at     INTEGER NOT NULL,
  CHECK((ignored = 1 AND collection_id IS NULL) OR (ignored = 0 AND collection_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_organizer_rules_collection
  ON organizer_rules(collection_id) WHERE collection_id IS NOT NULL;

-- Les étiquettes posées à la main sur la carte. anchors retient les posts qui
-- entouraient l'étiquette, pas une position : une reprojection déplace les neuf mille
-- points, et une étiquette figée en coordonnées désignerait alors autre chose.
--
-- Elle manquait ici. Seules les migrations 16 et 17 la créaient, donc toute installation
-- neuve démarrait sans cette table et mapLabels() échouait à chaque ouverture de la
-- carte — en silence, le seul appelant avalant l'erreur dans un catch.
CREATE TABLE IF NOT EXISTS map_labels (
  id         TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  anchors    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Une carte figée par regard : voir MIGRATION_24_SQL.
CREATE TABLE IF NOT EXISTS post_positions (
  layout  TEXT NOT NULL,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  x       REAL NOT NULL,
  y       REAL NOT NULL,
  PRIMARY KEY (layout, post_id)
);

-- Les réglages qui ont produit ces positions, regard par regard : voir MIGRATION_21_SQL
-- pour l'empreinte elle-même, MIGRATION_24_SQL pour la clé.
CREATE TABLE IF NOT EXISTS map_state (
  layout      TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  text,
  ai_description,
  author_handle,
  transcript,
  content='posts',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS posts_fts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, text, ai_description, author_handle, transcript)
  VALUES (new.rowid, new.text, new.ai_description, new.author_handle, new.transcript);
END;

CREATE TRIGGER IF NOT EXISTS posts_fts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, text, ai_description, author_handle, transcript)
  VALUES ('delete', old.rowid, old.text, old.ai_description, old.author_handle, old.transcript);
END;

CREATE TRIGGER IF NOT EXISTS posts_fts_au AFTER UPDATE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, text, ai_description, author_handle, transcript)
  VALUES ('delete', old.rowid, old.text, old.ai_description, old.author_handle, old.transcript);
  INSERT INTO posts_fts(rowid, text, ai_description, author_handle, transcript)
  VALUES (new.rowid, new.text, new.ai_description, new.author_handle, new.transcript);
END;

-- Colonnes filles des clés étrangères : voir MIGRATION_23_SQL.
CREATE INDEX IF NOT EXISTS idx_collection_posts_post ON collection_posts(post_id);
CREATE INDEX IF NOT EXISTS idx_collection_removals_post ON collection_removals(post_id);
CREATE INDEX IF NOT EXISTS idx_collection_feedback_post ON collection_feedback(post_id);
CREATE INDEX IF NOT EXISTS idx_collections_cover ON collections(cover_post_id)
;
CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_name ON collections(name COLLATE NOCASE)
  WHERE cover_post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_post_positions_post ON post_positions(post_id);
`

/**
 * L'échelle des migrations : une entrée par palier, la clé est la version produite.
 *
 * Invariant tenu par check:schema — une installation neuve exécute SCHEMA_SQL seul, donc
 * SCHEMA_SQL doit déjà contenir tout ce que cette échelle produit. Une table ajoutée ici et
 * oubliée là-bas ne manque à personne qui migre, et manque à tout le monde qui installe.
 *
 * Et une migration publiée ne se corrige pas sur place : ses CREATE TABLE IF NOT EXISTS ne
 * reconstruisent rien chez ceux qui l'ont déjà passée. Une correction prend un palier neuf.
 */
export const MIGRATIONS: Record<number, string> = {
  2: MIGRATION_2_SQL,
  3: MIGRATION_3_SQL,
  4: MIGRATION_4_SQL,
  5: MIGRATION_5_SQL,
  6: MIGRATION_6_SQL,
  7: MIGRATION_7_SQL,
  8: MIGRATION_8_SQL,
  9: MIGRATION_9_SQL,
  10: MIGRATION_10_SQL,
  11: MIGRATION_11_SQL,
  12: MIGRATION_12_SQL,
  13: MIGRATION_13_SQL,
  14: MIGRATION_14_SQL,
  15: MIGRATION_15_SQL,
  16: MIGRATION_16_SQL,
  17: MIGRATION_17_SQL,
  18: MIGRATION_18_SQL,
  19: MIGRATION_19_SQL,
  20: MIGRATION_20_SQL,
  21: MIGRATION_21_SQL,
  22: MIGRATION_22_SQL,
  23: MIGRATION_23_SQL,
  24: MIGRATION_24_SQL,
  25: MIGRATION_25_SQL,
  26: MIGRATION_26_SQL,
  27: MIGRATION_27_SQL,
  28: MIGRATION_28_SQL
}
