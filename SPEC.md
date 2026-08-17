# Magpie — spécification

> Application de bureau pour visualiser, trier et exploiter ses posts sauvegardés sur Instagram,
> X et Reddit dans une seule interface de type moodboard.

Date : 2026-08-10 · Statut : spec validée en interview, prête à implémenter

---

## 1. Le produit en une phrase

Une app desktop qui vit dans la barre des tâches, se connecte à tes comptes Instagram, X et Reddit,
aspire l'intégralité de tes signets en arrière-plan, les tague automatiquement d'après leur contenu
réel, et te les rend dans une grille dense, filtrable et organisable — d'où tu peux copier des liens
en un clic pour les envoyer vers Nitrate.

Usage central : **inspiration**. Ce n'est pas un lecteur, c'est un mur.

---

## 2. Décisions arrêtées

| Sujet | Décision |
|---|---|
| Forme | App desktop Electron, icône tray, sync en arrière-plan |
| OS | Windows + macOS |
| Récupération | Endpoints internes des plateformes avec la session de l'utilisateur (officieux, assumé) |
| Posture de sync | Fond prudent : pagination lente, jitter, arrêt anticipé, backoff |
| Onboarding | L'utilisateur se connecte dans une fenêtre intégrée, puis attend une barre de progression |
| Médias | Cache local de vignettes (WebP) ; vidéos = poster conservée, 3 images extraites pour l'analyse |
| Stockage | 100 % local (SQLite + fichiers), export/import JSON manuel |
| Organisation | Tags libres **+** collections type moodboard **+** favoris |
| Auto-tagging | Règles gratuites **+** Claude en vision sur le contenu réel (clé API, ~1 € au départ) |
| Doublons collection | Avertissement avec « voir lesquels », puis ajout des seuls nouveaux |
| Grille | Masonry dense **et** cartes régulières, commutables, avec curseur de densité |
| Onglets | Rendu local instantané + bouton « voir en vrai » (webview à la demande) |
| Copie | URL canonique en un clic + mode sélection multiple |
| Nitrate | Envoi direct par deep link `nitrate://add?url=…` sur les posts vidéo (Windows) |
| Ordre de build | Instagram → X → Reddit |

---

## 3. Architecture

```
┌─ Electron main ─────────────────────────────────────────────┐
│                                                             │
│  SyncEngine ──▶ InstagramAdapter ─┐                         │
│      │          XAdapter          ├─▶ net.request           │
│      │          RedditAdapter ────┘   (session partitionnée)│
│      ▼                                                      │
│  Normalizer ──▶ SQLite (better-sqlite3, FTS5)               │
│      │                                                      │
│      ├───────▶ MediaCache ──▶ sharp / ffmpeg ──▶ *.webp     │
│      │                                                      │
│      └───────▶ Tagger ──▶ règles ──▶ Claude (Batch API)     │
│                                                             │
│  AuthManager (BrowserWindow de login par plateforme)        │
│  Tray + Scheduler                                           │
└──────────────────────┬──────────────────────────────────────┘
                       │ IPC typée (contextBridge, pas de nodeIntegration)
┌──────────────────────▼──────────────────────────────────────┐
│  Renderer — React + TypeScript + Vite                       │
│  Grille virtualisée · Onglets · Filtres · Tags · Collections│
└─────────────────────────────────────────────────────────────┘
```

**Pourquoi Electron et pas Tauri** : le cœur du projet consiste à héberger des sessions connectées
de sites hostiles à l'automatisation. Electron donne un contrôle total et prévisible sur les
partitions de session, le jar de cookies, l'user-agent et l'interception réseau (`webRequest`).
Le WebView système utilisé par Tauri varie selon l'OS et offre un contrôle nettement plus faible
sur exactement ces points. Le surcoût de poids (~150 Mo) est un prix acceptable ici.

Choix assumé et rediscuté : **Nitrate, l'autre app de l'auteur, est en Tauri/Svelte/Rust**, et
un stack commun aurait permis de recopier son tray, son updater, son installeur et son
empaquetage ffmpeg. La capture de session reste faisable en Tauri (injection d'un shim qui
remplace `fetch` et `XMLHttpRequest` dans la fenêtre de login), mais c'est une technique plus
fragile appliquée précisément au point le plus fragile du projet. Electron l'emporte pour cette
raison, en connaissance du coût.

**Stack**

- `electron` + `electron-builder` (NSIS pour Windows, DMG signé/notarisé pour macOS)
- `better-sqlite3` — synchrone, rapide, FTS5 pour la recherche plein texte
- `sharp` — génération des vignettes WebP · `ffmpeg-static` — extraction des images de vidéo
- `@anthropic-ai/sdk` — tagging par le contenu
- `react` + `vite` + `typescript` + `zustand` (état UI) + `@tanstack/react-virtual` (virtualisation)
- Pas de framework CSS lourd : CSS modules + variables, thèmes clair/sombre

---

## 4. Modèle de données

```sql
CREATE TABLE posts (
  id              TEXT PRIMARY KEY,   -- "<platform>:<native_id>"
  platform        TEXT NOT NULL,      -- 'instagram' | 'x' | 'reddit'
  native_id       TEXT NOT NULL,
  url             TEXT NOT NULL,      -- URL canonique — c'est elle que copie le bouton
  author_handle   TEXT,
  author_name     TEXT,
  author_avatar   TEXT,               -- chemin cache local
  text            TEXT,               -- légende / tweet / titre + selftext
  ai_description  TEXT,               -- description du contenu générée par Claude (indexée FTS)
  kind            TEXT,               -- 'image'|'carousel'|'video'|'text'|'link'
  media_count     INTEGER DEFAULT 0,
  width           INTEGER,            -- dimensions du média principal, indispensables
  height          INTEGER,            -- au layout masonry sans charger l'image
  dominant_color  TEXT,               -- placeholder pendant le chargement
  published_at    INTEGER,            -- epoch ms, quand disponible
  saved_at        INTEGER,            -- quand la plateforme l'expose (voir §5)
  discovered_at   INTEGER NOT NULL,   -- première fois vue par notre sync
  saved_rank      INTEGER,            -- rang dans le flux saved, proxy d'ordre de sauvegarde
  is_favorite     INTEGER DEFAULT 0,
  is_archived     INTEGER DEFAULT 0,
  tag_status      TEXT DEFAULT 'pending',  -- 'pending'|'rules_only'|'tagged'|'skipped'|'error'
  raw             TEXT,               -- payload brut JSON, pour re-parser sans re-sync
  updated_at      INTEGER NOT NULL
);

CREATE TABLE media (
  id            INTEGER PRIMARY KEY,
  post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  idx           INTEGER NOT NULL,     -- position dans un carrousel
  kind          TEXT NOT NULL,        -- 'image' | 'video'
  remote_url    TEXT,                 -- expire — informatif seulement
  thumb_path    TEXT,                 -- notre cache, la source de vérité pour l'affichage
  full_path     TEXT,                 -- rempli seulement si "garder l'original"
  width         INTEGER,
  height        INTEGER
);

CREATE TABLE tags        (id INTEGER PRIMARY KEY, name TEXT UNIQUE, color TEXT,
                          source TEXT);  -- 'user' | 'rule' | 'ai'
CREATE TABLE post_tags   (post_id TEXT, tag_id INTEGER, source TEXT, confidence REAL,
                          PRIMARY KEY (post_id, tag_id));
CREATE TABLE collections (id INTEGER PRIMARY KEY, name TEXT, cover_post_id TEXT,
                          source TEXT, sort_index INTEGER);
CREATE TABLE collection_posts (collection_id INTEGER, post_id TEXT, added_at INTEGER,
                               PRIMARY KEY (collection_id, post_id));
CREATE TABLE accounts    (platform TEXT PRIMARY KEY, handle TEXT, connected_at INTEGER,
                          last_sync_at INTEGER, last_sync_status TEXT, cursor TEXT);

CREATE VIRTUAL TABLE posts_fts USING fts5(text, ai_description, author_handle,
                                          content='posts', content_rowid='rowid');
```

L'`id` composite garantit qu'un même post ne peut pas être dupliqué entre deux syncs, et que
les trois plateformes cohabitent sans collision.

Le champ `raw` est délibéré : quand un adaptateur s'améliore (nouveau champ extrait), on
re-normalise depuis la base au lieu de retaper la plateforme.

La clé primaire de `collection_posts` rend les doublons structurellement impossibles — d'où le
comportement décrit en §9.

---

## 5. Adaptateurs

Interface commune, un fichier par plateforme :

```ts
interface PlatformAdapter {
  platform: Platform;
  isConnected(): Promise<boolean>;
  connect(): Promise<Account>;          // ouvre la fenêtre de login
  disconnect(): Promise<void>;
  fetchPage(cursor?: string): Promise<{ items: RawItem[]; nextCursor?: string; done: boolean }>;
  normalize(item: RawItem): Post;
  fetchCollections?(): Promise<RawCollection[]>;
}
```

### 5.1 Instagram — premier implémenté

- **Login** : `BrowserWindow` sur `instagram.com/accounts/login/`, partition `persist:ig`.
  On observe les cookies de la partition et on considère la connexion établie dès que `sessionid`
  et `ds_user_id` existent. La 2FA fonctionne naturellement puisque c'est la vraie page.
- **Flux** : `GET /api/v1/feed/saved/posts/?max_id=<cursor>`
  Headers requis : `x-ig-app-id` (id de l'app web), `x-csrftoken` (cookie `csrftoken`),
  `x-requested-with: XMLHttpRequest`, UA cohérent avec la fenêtre de login.
  Pagination : la réponse porte `more_available` et `next_max_id`.
- **Collections** : `GET /api/v1/collections/list/`, puis le flux de chaque collection.
- **Médias** : `image_versions2.candidates[]` (on prend le plus grand ≤ 1080),
  `carousel_media[]` pour les carrousels, `video_versions[]` + `image_versions2` comme poster
  pour les reels.
- **⚠️ Instagram n'expose pas la date de sauvegarde.** Le flux est rendu dans l'ordre inverse
  de sauvegarde : on stocke donc `saved_rank` (position dans le flux) comme proxy d'ordre, et
  `discovered_at` pour tout ce qui arrive après le premier backfill. Le tri « par date de
  sauvegarde » est donc exact pour tout ce qui est capté après l'installation, et seulement
  *ordonné* (sans dates réelles) pour l'historique antérieur. C'est une limite de la plateforme,
  pas de l'implémentation.
- **Plateforme la plus sensible des trois** : c'est ici que la temporisation compte le plus.

### 5.2 X

La difficulté n'est pas l'endpoint mais ses identifiants, qui changent à chaque déploiement de
X (`queryId` dans l'URL GraphQL, drapeau `features`, en-têtes de transaction).

**Stratégie « apprendre puis rejouer »** — nettement plus robuste que de coder les valeurs en dur :

1. À la connexion, on ouvre `x.com/i/bookmarks` dans une fenêtre invisible de la partition.
2. On intercepte via `webRequest.onBeforeSendHeaders` la requête `Bookmarks` que la page émet
   d'elle-même, et on en capture l'URL complète et tous les en-têtes.
3. On mémorise ce gabarit, on ferme la fenêtre, et le moteur de sync rejoue ensuite la même
   requête en ne changeant que le curseur.
4. Si une requête rejouée échoue (403 / schéma inattendu), on ré-apprend automatiquement en
   rouvrant la fenêtre une fois. L'adaptateur se répare seul dans la majorité des cas.

Pagination par curseur dans les instructions de timeline. Le tweet complet arrive dans la
réponse (auteur, texte, médias, métriques) — pas besoin d'un second appel par post.

### 5.3 Reddit

Reddit possède une vraie API OAuth, mais s'en servir imposerait d'enregistrer une application
développeur pour obtenir un identifiant client — une étape de configuration de plus, pour la
seule plateforme qui en demanderait une. On passe donc par les points `.json` du site, qui
acceptent la session du navigateur :
`GET https://www.reddit.com/user/<me>/saved.json?limit=100&raw_json=1&after=<cursor>`.

**Les trois plateformes partagent ainsi un modèle unique** : se connecter dans une fenêtre
intégrée, et rien d'autre. C'est ce qui rend l'application utilisable sans aucune configuration.

Couvre posts **et** commentaires sauvegardés — un commentaire devient un `kind: 'text'` préfixé
du titre du fil dont il vient, sans quoi il serait illisible hors contexte.

---

## 6. Moteur de sync

**Premier sync (backfill)** — le moment que l'utilisateur vit comme « connecte-toi et attends » :

- Pagination séquentielle jusqu'à épuisement, pause aléatoire de 2 à 5 s entre les pages.
- **Les plateformes tournent en parallèle**, chacune à son rythme. La première version les
  enchaînait, au motif que deux backfills simultanés doubleraient la trace laissée —
  c'était faux : Instagram ne voit rien de ce qu'on demande à Reddit. La limitation de
  débit est par plateforme, donc la prudence doit l'être aussi. Le séquentiel ne protégeait
  de rien et ne faisait qu'imposer une attente. Ce qui compte reste en place : une page à
  la fois **par plateforme**, avec ses pauses et son plafond.
- Progression réelle à l'écran : « Instagram — 1 240 signets récupérés… », et la grille se
  remplit **au fur et à mesure**, pas à la fin. Ordre de grandeur : ~50 items par page, donc
  environ 3 à 4 minutes pour 2 000 signets Instagram.
- Le cache des vignettes et le tagging tournent dans des files séparées, en parallèle et à débit
  limité, pour ne pas retarder l'indexation.

**Syncs suivants (incrémentaux)** :

- On s'arrête après 3 pages consécutives sans aucun élément nouveau — typiquement 1 à 2 requêtes.
- Planifié une fois par jour, avec jitter, uniquement quand l'app tourne. Bouton « Sync » manuel
  toujours disponible, avec cooldown pour éviter le martèlement.

**Garde-fous** :

- Backoff exponentiel sur 429 et 5xx.
- Détection de challenge / checkpoint Instagram → **arrêt immédiat**, aucune reprise automatique,
  notification claire à l'utilisateur avec la marche à suivre.
- Plafond dur de requêtes par session et par plateforme.
- Aucune requête n'est jamais émise sans action ou planification explicite.

---

## 7. Cache média

- Vignette : plus grande largeur ≤ 640 px, WebP qualité 80. Ordre de grandeur 30–80 Mo pour
  1 000 posts.
- Dimensions et couleur dominante extraites à l'ingestion et stockées en base — c'est ce qui
  permet au masonry virtualisé de calculer sa mise en page **sans** charger la moindre image,
  donc de scroller 5 000 posts sans à-coups.
- **Vidéos** : on conserve la poster frame comme vignette d'affichage, **et le clip lui-même en
  cache local** — les URLs vidéo des plateformes sont signées et expirent au même titre que
  celles des images. C'est ce clip que lit la carte au survol.
- Pour l'analyse, on extrait en plus **3 images à 10 %, 50 % et 90 %** de la durée via `ffmpeg`,
  on les envoie au tagger, puis on les supprime. La poster d'un reel n'est presque jamais
  représentative de son contenu — c'est ce qui fait la différence entre un tag juste et un tag
  à côté.
- Bouton « garder l'original » par post, pour archiver en pleine résolution ce qui compte.
- Réglages : plafond de taille du cache, purge LRU des non-favoris, bouton « vider le cache »
  (les métadonnées, tags et collections survivent toujours à une purge de médias).

---

## 8. Auto-tagging

Deux étages, l'un gratuit et immédiat, l'autre optionnel et payant à l'usage.

### 8.1 Règles — gratuit, instantané, aucun réglage

Appliquées à l'ingestion, sans aucun modèle : hashtags de la légende Instagram, handle de
l'auteur, subreddit, plateforme, type de média, domaine des liens partagés. Couvre déjà une bonne
part du travail, particulièrement sur Instagram.

### 8.2 Claude — tags fondés sur le contenu réel

C'est ce qui répond à la demande : taguer d'après **ce qu'il y a dans l'image ou la vidéo**, pas
d'après ce que la légende raconte.

- **Entrée par post** : la vignette (ou les 3 images extraites pour une vidéo), la légende,
  l'auteur, et ta taxonomie de tags existante — pour qu'il réutilise tes tags plutôt que d'en
  inventer un synonyme à chaque fois.
- **Sortie** : 3 à 6 tags, plus une description libre du contenu, stockée dans `ai_description` et
  indexée en recherche plein texte. C'est cette description qui permet de chercher
  « intérieur béton lumière rasante » sur un post dont la légende ne dit rien.
- **Lots de 8 vignettes par requête**, pour amortir le prompt de taxonomie.
- **Via l'API Batch** (moitié prix, non urgent) : la file tourne en fond après le sync, l'app
  reste utilisable, les tags apparaissent au fil de l'eau.
- **Modèle** : Haiku 4.5 par défaut, bascule Sonnet 5 possible dans les réglages pour des tags
  plus fins.
- Chaque tag généré est marqué `source: 'ai'` — visuellement distinct, éditable, supprimable
  en masse. Rien n'est jamais figé.

**Coût réel** — une vignette 640 px vaut environ 700 tokens :

| Modèle | ~500 posts, tarif standard | Via l'API Batch |
|---|---|---|
| Haiku 4.5 ($1 / $5 par MTok) | ~0,70 € | **~0,35 €** |
| Sonnet 5 (tarif promo actuel) | ~1,40 € | ~0,70 € |

Ordre de grandeur : le premier tagging complet coûte moins qu'un café, puis quelques centimes
par lot de nouveaux signets. Un compteur de dépense est affiché dans les réglages, avec un
plafond mensuel configurable.

### 8.3 Configuration de la clé API — dire les choses clairement

**Un abonnement Claude Pro ou Max ne donne pas accès à l'API** : ce sont deux facturations
distinctes, et il n'existe pas de « Se connecter avec Claude » pour une application tierce.

C'est précisément pourquoi Magpie ne cherche plus à appeler un modèle lui-même. Qui veut
parler de sa bibliothèque avec un assistant **exporte un dossier** (§8.5) et le lui donne :
son abonnement existant suffit, aucune clé n'entre en jeu, et le tri reste identique pour
tout le monde. La clé API ci-dessous ne concerne que l'étiquetage automatique, resté
optionnel et masqué.

Le parcours réel :

1. Un écran unique dans les réglages, avec un bouton qui ouvre la console Anthropic à la bonne page.
2. L'utilisateur colle sa clé.
3. Un appel de test confirme immédiatement qu'elle fonctionne.

La clé est chiffrée via `safeStorage` (DPAPI sur Windows, Keychain sur macOS), jamais écrite en
clair, jamais transmise ailleurs qu'à l'API Anthropic. Le tagging par IA est **entièrement
optionnel** : sans clé, l'app fonctionne avec les règles seules et les tags manuels.

### 8.4 Compréhension locale : embeddings de texte et transcription

Rouvert et fait. Deux modèles locaux, téléchargés à la demande, jamais rien qui sorte de la
machine :

- **Embeddings de texte** (`multilingual-e5-small`, ~120 Mo) — le vote par mots-clés ne
  rapprochait que ce qui partageait un mot. Mesuré : 5,3 ms par post, 53 s pour 10 000. Le
  recentrage du nuage est indispensable, pas optionnel — sans lui l'écart entre paires
  proches et étrangères tombe à 0,050 au lieu de 0,307.
- **Transcription** (`whisper-base`, ~140 Mo) — sur la bibliothèque de référence, un quart
  des vidéos n'a aucune prose exploitable et la légende médiane fait douze mots. Le
  transcript sert au regroupement, à la recherche plein texte et à l'export.

La **similarité visuelle** reste écartée : une fois du texte partout, elle n'apporte plus
grand-chose. La signature couleur 6×6 demeure comme repli pour les posts sans aucun texte.

Ces vecteurs donnent aussi ses coordonnées à la carte sémantique (§9) : la position d'un
point *est* la projection de son sens, jamais le résultat d'une simulation à ressorts.

### 8.5 Exporter pour son propre assistant

Magpie n'appelle aucun modèle et n'embarque aucun CLI. Il écrit un dossier — un sommaire, un
index découpé en tranches, une fiche par post, une liste par collection, et un prompt système
modifiable — que l'utilisateur donne à l'assistant de son choix.

La forme est dictée par une mesure : l'index complet d'une bibliothèque de 9 738 posts pèse
2,1 Mo, soit un demi-million de jetons. Il est donc découpé en tranches d'environ 74 k jetons,
et le prompt demande de fouiller par motif de texte avant de lire quoi que ce soit.

Découplé du reste : utilisable sans avoir jamais créé une collection ni transcrit une vidéo.

---

## 9. Interface

**Disposition** : barre latérale (plateformes, collections, tags, favoris) · barre d'outils
(recherche, tri, mode de grille, curseur de densité, mode sélection) · zone principale
(barre d'onglets + contenu).

**Grille**

- Deux modes commutables : *masonry* (hauteurs variables, métadonnées au survol) et
  *cartes* (hauteur régulière, auteur et extrait toujours visibles).
- Curseur de densité : largeur de colonne cible de 140 à 400 px.
- Virtualisée dans les deux modes.
- Badge de plateforme discret en coin de carte.

**Le survol anime la carte** — c'est ce qui distingue un mur vivant d'une planche-contact :

- Une **vidéo se lit** au survol, en boucle et sans son. L'élément vidéo n'est monté que
  pendant le survol : il n'y a jamais plus d'un ou deux décodeurs actifs, là où un lecteur par
  carte visible saturerait la machine.
- Un **carrousel défile** ses vues en fondu, avec des points de position façon Pinterest, et
  revient à la première image quand la souris sort. Les vues suivantes ne sont chargées qu'au
  survol : une grille de carrousels ne tire pas cinq images par carte au premier rendu.

**Filtres et tri**

- Filtre plateforme : Instagram / X / Reddit, isolément ou combinés — un simple jeu de bascules,
  jamais une navigation séparée.
- Tri : date de sauvegarde (ou `saved_rank` en repli), date de publication, auteur, plateforme,
  aléatoire (utile en mode inspiration).
- Filtres additionnels : type de média, tag(s), collection, favoris, « sans tag ».
- Recherche plein texte instantanée via FTS5, sur la légende, l'auteur **et la description
  générée par Claude**.

**Étiquettes de couleur**

Sept teintes fixes — rouge, orange, jaune, vert, bleu, violet, gris — assignables à un post
depuis la vue détaillée, et à une collection depuis le panneau. Elles sont **indépendantes de
la couleur d'accent** : ce sont des repères de rangement, pas de la décoration, et un « rouge »
doit rester rouge quelle que soit la teinte choisie pour l'interface.

Un post étiqueté porte un liseré de sa teinte et une pastille en pied de carte. Le panneau
affiche une rangée de pastilles pour filtrer, **limitée aux teintes réellement utilisées** :
sept cases vides seraient du bruit. C'est le repère le plus rapide de l'interface — on le voit
sans lire, ce qu'aucun tag ne permet.

**Tags et collections**

- Tags multiples par post, autocomplétion, filtrage par combinaison. Les tags générés par l'IA
  sont visuellement distincts des tiens et supprimables en masse.
- Collections nommées type moodboard, un post peut appartenir à plusieurs, image de couverture,
  vue dédiée.
- **Sélection en masse** : filtrer par tag, `Ctrl+A`, « Ajouter à la collection ». C'est le flux
  principal pour construire une collection à partir d'un tag.
- **Doublons** : un post est dans une collection ou il n'y est pas — la contrainte de clé
  primaire rend le doublon impossible. Quand une partie de la sélection y est déjà, on affiche
  « 12 des 34 sont déjà dans *Références 3D* », avec **[voir lesquels]** (pour vérifier que tu ne
  confonds pas deux posts proches), **[ajouter les 22 autres]** et **[annuler]**.

**Onglets**

- Ouvrir un post = nouvel onglet interne, rendu **local** et instantané : média, auteur, texte
  complet, date, tags éditables, bouton copier, bouton « voir en vrai ».
- « Voir en vrai » charge la page réelle dans une webview **dans le même onglet** — pour les
  commentaires et les fils Reddit — sans quitter l'app.
- L'onglet Grille est permanent et **conserve son scroll, ses filtres et sa sélection**. C'est
  l'exigence explicite : on revient au mur exactement là où on l'avait laissé, y compris après
  redémarrage de l'app.
- Navigation clavier : `Ctrl/Cmd+Tab` entre onglets, `Esc` retour à la grille, flèches dans la
  grille, `Espace` aperçu rapide, `F` favori, `T` tag, `C` copier.

**Copie** — l'usage central

- Un clic sur l'icône de copie d'une carte → URL canonique dans le presse-papier, confirmation
  visuelle brève.
- Mode sélection (bascule, ou `Shift+clic` pour une plage) → cases à cocher, compteur flottant,
  « Copier les 34 liens » (une URL par ligne).
- `Ctrl/Cmd+C` copie la sélection courante, ou le post survolé si rien n'est sélectionné.

**Envoi vers Nitrate**

[Nitrate](https://github.com/BeeeFX/Nitrate) est le compresseur vidéo de l'auteur : on lui donne
un lien, il télécharge via yt-dlp et ré-encode sous une taille cible. Son extension navigateur
communique avec l'app de bureau par un simple protocol handler :

```
nitrate://add?url=<encodeURIComponent(url)>
```

Côté Magpie c'est donc un unique `shell.openExternal()`. Concrètement :

- **Désactivé par défaut**, activable dans les réglages. Le lien profond est construit par le
  processus principal, jamais par l'interface : le renderer ne fournit qu'une URL `http(s)`, ce
  qui l'empêche de déclencher un schéma applicatif arbitraire.
- Bouton **« Envoyer vers Nitrate »** sur tout post comportant une vidéo, à côté du bouton copier.
- Sur une sélection multiple : « Envoyer les 12 vidéos », avec **échelonnement de ~300 ms** entre
  les appels pour ne pas saturer le handler, et confirmation au-delà de 10 éléments.
- Le bouton n'apparaît **que sous Windows** (Nitrate n'existe pas encore sur macOS) et reste
  désactivable dans les réglages.
- Le bouton copier reste dans tous les cas : il sert pour les posts non-vidéo et pour tout usage
  hors Nitrate.

**Tray**

- Icône permanente ; menu : Ouvrir, Sync maintenant, dernier sync, Pause de la sync, Quitter.
- Badge sur le nombre de nouveaux signets depuis la dernière ouverture.

**Cadre de fenêtre** : le cadre natif est remplacé par le nôtre — `titleBarOverlay` sous
Windows, qui laisse l'OS dessiner ses boutons aux couleurs qu'on lui donne, et `hiddenInset`
sous macOS. La barre de titre grise du système posée au-dessus de l'application est ce qui
distingue le plus nettement une page web dans une fenêtre d'une vraie application de bureau.

**Thème et accent** : sombre, clair, ou suivi du système. Le thème est résolu par le processus
principal — il doit de toute façon le connaître pour colorer les boutons de fenêtre, et deux
sources de vérité finiraient par diverger. Cinq accents au choix ; l'accent ne colore que ce qui
est actif, jamais le mobilier.

**Réglages** (`Ctrl/⌘+,`) : thème, accent, mode et densité par défaut, taille du cache avec
purge, accès au dossier de données. Les fonctions non encore livrées y figurent explicitement,
avec leur jalon — mieux vaut une liste honnête qu'un réglage qui ne fait rien.

**Typographie** : Geist Variable, embarquée dans l'application. Aucune requête réseau, donc
compatible avec la CSP stricte, et un rendu identique quelles que soient les polices installées.

---

## 10. Sécurité et vie privée

- Aucun serveur, aucune télémétrie. Les seules requêtes sortantes vont aux plateformes connectées
  et — si et seulement si le tagging IA est activé — à l'API Anthropic.
- Les sessions vivent dans des partitions Electron isolées, une par plateforme, dans le stockage
  chiffré de Chromium ; la clé API Anthropic et les jetons hors cookies passent par `safeStorage`
  (DPAPI sur Windows, Keychain sur macOS).
- Bouton « Déconnecter » par plateforme, qui purge réellement la partition.
- `contextIsolation: true`, `nodeIntegration: false`, IPC typée et restreinte, CSP stricte sur
  le renderer. Les webviews « voir en vrai » tournent dans une partition séparée de celle du sync.
- Export JSON complet (métadonnées, tags, collections, favoris) + option d'archive avec les
  médias. Import symétrique. Tu n'es jamais captif de l'app.

---

## 11. Jalons

| # | Contenu | Résultat visible |
|---|---|---|
| **M0** ✅ | Coquille Electron, schéma SQLite, **fixture Instagram figée**, grille masonry + cartes virtualisées, cache vignettes | L'app est belle et navigable sur données figées, sans jamais toucher au compte |
| **M1** ✅ | Sessions isolées + connexion intégrée, **les trois adaptateurs**, moteur de sync + backfill + progression | « Je me connecte, j'attends, tout est là » |
| **M2** | Sélection en masse et actions par lot (tags, collections, favoris) | L'app devient un outil, pas une visionneuse |
| **M3** ✅ | Vue détaillée, copie, envoi vers Nitrate, édition des tags et collections | Le flux d'usage complet |
| **M4** | Tagger : règles, extraction ffmpeg, file Claude en Batch, écran de clé API, compteur de coût | Les posts se rangent tout seuls d'après leur contenu |
| **M5** | Adaptateur X (apprendre-puis-rejouer) | Deuxième plateforme |
| **M6** | Adaptateur Reddit (OAuth) | Les trois plateformes réunies |
| **M7** | Tray + sync planifiée, export/import, réglages, builds signés Win + macOS | Livrable |

M0 est délibérément la plus grosse tranche visuelle : tu vois le produit que tu as en tête avant
qu'on ait dépensé le moindre risque sur les endpoints.

**M0 est livré** (voir [README.md](README.md) pour le démarrage). Deux ajouts non prévus par la
spec initiale, tous deux justifiés :

- `npm run check:layout` et `npm run check:db` vérifient le moteur de mise en page et la couche
  SQL sans lancer l'interface. Le premier compare la fenêtre de virtualisation à une recherche
  exhaustive à chaque position de scroll — une carte qui disparaîtrait au scroll est le genre de
  bug qui se voit tout de suite mais se debugue mal.
- Un **aperçu navigateur** sur `localhost:5173` pendant `npm run dev`, alimenté par un
  instantané que le processus principal dépose au démarrage. Sert à itérer sur le CSS avec de
  vraies devtools. Volontairement dégradé : filtres, tri et recherche y sont ignorés, pour ne
  pas dupliquer de logique métier côté renderer.

---

## 12. Points ouverts

1. **Comptes Instagram multiples ?** Le modèle actuel suppose un compte par plateforme. Le
   supporter plus tard coûte une colonne, le rétro-adapter coûte davantage — à trancher avant M1.
2. **Extraction des images de vidéo** — `ffmpeg` sait chercher directement dans une URL distante
   (`-ss <t> -i <url> -frames:v 1`) si le CDN accepte les requêtes par plage, ce qui évite de
   télécharger la vidéo entière pour trois images. À vérifier empiriquement sur les CDN
   d'Instagram et de X au moment de M4 ; sinon, repli sur un téléchargement partiel.

## 13. Hypothèses retenues faute de précision

- Un seul compte par plateforme pour la v1.
- Volume cible : quelques centaines de signets par plateforme. Toute l'architecture tient sans
  effort à cette échelle, et la virtualisation encaisse un ordre de grandeur de plus.
- Les signets supprimés côté plateforme sont **conservés** localement et marqués `is_archived`
  plutôt que supprimés — perdre une inspiration parce qu'un auteur a fermé son compte serait
  le pire comportement possible pour cet outil.
- Le tagging IA est désactivé par défaut ; l'app est pleinement utilisable sans clé API.
- Langue de l'interface : français, structure prête pour l'i18n.
