# Magpie — spécification

> Application de bureau pour visualiser, trier et exploiter ses posts sauvegardés sur Instagram
> et X dans une seule interface de type moodboard.

Écrite le 2026-08-10 · Réécrite le 2026-08-26, à la version **0.42.0**

Ce document n'est plus une intention : l'application existe, elle est distribuée, et ce texte
décrit ce qu'elle fait et **pourquoi elle le fait ainsi**. Les raisonnements de la version
initiale sont conservés quand ils tiennent encore ; ceux qui ont été renversés par la mesure
sont réécrits sur place, avec ce qui les a renversés. Ce qui reste promis et non livré est
rassemblé au §14, daté — une spécification qui promet ce qui n'existe pas cesse d'être lisible :
on ne sait plus si une absence est un défaut ou un choix.

La source de vérité du schéma est `src/main/db/schema.ts`, celle des chaînes d'interface
`src/renderer/src/i18n.ts`. Quand ce document et le code divergent, c'est le code qui a raison
et ce document qui a un bug.

---

## 1. Le produit en une phrase

Une app desktop qui vit dans la barre des tâches, se connecte à tes comptes Instagram et X,
aspire l'intégralité de tes signets et de tes likes en arrière-plan, les **lit** — le texte, les
images, la parole des vidéos — et te les rend de trois façons : un mur dense, des cartes
régulières, et une **carte sémantique** où la distance est la ressemblance.

Usage central : **inspiration**. Ce n'est pas un lecteur, c'est un mur — et depuis 0.20, c'est
aussi un endroit où l'on se repère.

---

## 2. Décisions arrêtées

| Sujet | Décision |
|---|---|
| Forme | App desktop Electron, icône tray, sync en arrière-plan |
| OS | Windows livré et signé par personne ; macOS et Linux prévus, ni testés ni signés |
| Récupération | Endpoints internes des plateformes avec la session de l'utilisateur (officieux, assumé) |
| Posture de sync | Fond prudent : pagination lente, jitter, arrêt anticipé, backoff |
| Onboarding | Présentation en cinq écrans, puis connexion dans une fenêtre intégrée |
| Sources | Signets, likes, ou les deux — un post présent dans les deux reste une seule entrée |
| Médias | Vignettes WebP 480 px ; clips en cache pour le survol ; diffusion à la demande sinon |
| Stockage | 100 % local (SQLite + fichiers), déplaçable sur un autre disque |
| Organisation | Tags libres **+** collections **+** favoris **+** étiquettes de couleur |
| Compréhension | **Entièrement locale** : embeddings de texte, deux encodeurs d'image, Whisper |
| Collections | Une **requête** — une phrase, des mots pondérés, une ampleur — pas un dossier |
| Carte | Projection UMAP des vecteurs de sens, positions **figées** une fois calculées |
| Assistant | Magpie n'appelle aucun modèle distant : il **exporte un dossier** qu'on donne au sien |
| Grille | Masonry dense **et** cartes régulières **et** carte, commutables, curseur de densité |
| Copie | URL canonique en un clic + mode sélection multiple |
| Nitrate | Envoi direct par deep link `nitrate://add?url=…` sur les posts vidéo (Windows) |
| Plateformes | Instagram et X livrées ; Reddit implémenté puis **mis en sommeil** (§5.3) |

Deux décisions de 2026-08-10 ont été renversées depuis, et méritent d'être nommées :

- **« Claude en vision sur le contenu réel (clé API, ~1 € au départ) »** — abandonné. Le tri se
  fait par des modèles locaux, et le chemin distant est désactivé dans le code (§8.8).
- **« Volume cible : quelques centaines de signets par plateforme »** — faux d'un ordre de
  grandeur. La bibliothèque de référence en compte 9 850, et c'est elle qui a dicté à peu près
  toutes les décisions de performance depuis (§4, §8.6).

---

## 3. Architecture

```
┌─ Electron main ─────────────────────────────────────────────┐
│                                                             │
│  SyncEngine ──▶ InstagramAdapter ─┐                         │
│      │          XAdapter          ├─▶ net.request           │
│      │          (RedditAdapter) ──┘   (session partitionnée)│
│      ▼                                                      │
│  Normalizer ──▶ SQLite (better-sqlite3, FTS5)               │
│      │                                                      │
│      ├─▶ MediaCache ──▶ sharp ────────────▶ *.webp 480 px   │
│      │              └─▶ ffmpeg ───────────▶ clips + images  │
│      │                                                      │
│      └─▶ Organizer ─┬─▶ e5-small ─────────▶ vecteur texte   │
│                     ├─▶ DINOv2 + SigLIP ──▶ vecteurs image  │
│                     ├─▶ whisper-base ─────▶ transcription   │
│                     ├─▶ prototypes ───────▶ collections     │
│                     └─▶ UMAP (worker) ────▶ carte           │
│                                                             │
│  AuthManager · TaskRegistry · Tray · Scheduler · Updater     │
└──────────────────────┬──────────────────────────────────────┘
                       │ IPC typée (contextBridge, pas de nodeIntegration)
┌──────────────────────▼──────────────────────────────────────┐
│  Renderer — React + TypeScript + Vite                       │
│  Masonry · Cartes · Carte sémantique · Filtres · Collections │
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

- `electron` + `electron-builder` (NSIS pour Windows) + `electron-updater`
- `better-sqlite3` — synchrone, rapide, FTS5 pour la recherche plein texte
- `sharp` — vignettes WebP · `ffmpeg-static` — extraction d'images et lecture des clips
- `@huggingface/transformers` — les modèles locaux : `multilingual-e5-small`,
  `Xenova/dinov2-small`, `Xenova/siglip-base-patch16-224`, `whisper-base`
- `umap-js` — la projection de la carte, dans un **fil séparé** : la construction du graphe de
  voisins est atomique et figeait la fenêtre près de trois secondes
- `react` + `vite` + `typescript` + `zustand` (état UI) + virtualisation maison
  (`renderer/src/layout.ts`)
- Pas de framework CSS : variables CSS et thèmes clair/sombre

**Aucune dépendance à un service.** Il n'y a plus de SDK d'API de modèle dans `package.json` ;
c'est une propriété qu'on peut vérifier mécaniquement, et pas seulement une intention.

---

## 4. Modèle de données

SQLite, schéma en version **25**, une échelle de migrations dont l'invariant est tenu par
`npm run check:schema` : une installation neuve exécute `SCHEMA_SQL` seul, donc `SCHEMA_SQL`
doit déjà contenir tout ce que l'échelle produit. Le détail vit dans `src/main/db/schema.ts`,
qui est commenté table par table ; ce qui suit dit **à quoi sert chaque groupe**.

**Le contenu**

- `posts` — l'`id` composite `<plateforme>:<id natif>` garantit qu'un même post ne peut pas être
  dupliqué entre deux syncs, et que les plateformes cohabitent sans collision. `raw` est
  délibéré : quand un adaptateur s'améliore, on re-normalise depuis la base au lieu de retaper la
  plateforme. `transcript` porte la parole des vidéos, `label` l'étiquette de couleur, `is_demo`
  distingue la fixture de démonstration des vrais signets pour pouvoir la retirer d'un geste.
  `ai_description` subsiste, vide, et n'a plus de producteur (§8.8).
- `post_sources` — signet et like sont deux **origines** du même post, chacune avec son rang et
  sa date. C'est ce qui permet « les deux » sans dupliquer une seule ligne.
- `media`, `media_variants` — un rang par média d'un carrousel ; les variantes portent les
  qualités de lecture disponibles et, le cas échéant, leur copie locale.
- `posts_fts` — FTS5 sur légende, description, auteur **et transcription**, en
  `unicode61 remove_diacritics 2` : « cafe » trouve « café ».

**Le rangement**

- `tags`, `post_tags` — tags libres, avec leur source (`user` / `rule`).
- `collections` — nom, couleur, `kind` (`query` ou `manual`), la phrase `query`, son
  `prototype_text` / `prototype_meaning`, et `target_size` : l'ampleur, en nombre de posts.
- `collection_posts` — l'appartenance, avec son `degree`. La clé primaire composite rend le
  doublon structurellement impossible — d'où le comportement décrit au §9. **C'est un cache** :
  l'appartenance vraie est le calcul, cette table n'en est que le résultat matérialisé, réécrit
  à chaque changement de définition. Il ne peut donc pas y avoir de désaccord entre ce que la
  carte montre et ce que la mosaïque filtre.
- `collection_keywords` — les mots d'une collection, leur poids, et leurs vecteurs.
- `collection_feedback`, `collection_removals` — les verdicts et les retraits **à la main**. Le
  second est indispensable : sans cette trace, un post sorti d'une collection y revenait à la
  synchronisation suivante, le rangement défaisant le geste de l'utilisateur.
- `organizer_rules`, `organizer_applications` — les préférences apprises d'un classement, et la
  trace du dernier appliqué. Créer douze collections et y verser des milliers de posts derrière
  un seul bouton demande une confiance qu'on n'a pas encore gagnée : il faut de quoi revenir en
  arrière.

**La compréhension**

- `post_embeddings` — vecteur de sens du texte. Le hash porte sur le texte source : un post dont
  la légende n'a pas bougé n'est jamais réencodé, ce qui rend les analyses suivantes quasi
  gratuites.
- `post_image_embeddings` — `structure` (DINOv2) et `meaning` (SigLIP), plus le nombre d'images
  lues pour ce post. Le hash porte sur le chemin de la vignette **et la version des modèles**.
- `local_video_features` — la signature couleur, repli pour les posts sans aucun texte.
- `post_positions`, `map_state` — les coordonnées de la carte par « regard », et l'empreinte des
  réglages qui les a produites. Voir §8.6 : les positions sont figées, c'est le point entier.
- `map_labels` — les étiquettes posées à la main. Elles retiennent **les posts qui les
  entouraient**, pas une position : une reprojection déplace les neuf mille points, et une
  étiquette figée en coordonnées désignerait alors autre chose.

**Les comptes**

- `accounts`, `account_sync_sources` — un compte par plateforme, un curseur **par source**.

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
  refreshPost?(nativeId: string): Promise<RawItem | null>;   // relien un média expiré
}
```

`refreshPost` est l'ajout tardif qui compte : les URLs médias sont signées et expirent, et sans
lui une vidéo de six mois devenait illisible alors que sa page, elle, s'ouvre parfaitement — la
page regénère un lien à chaque affichage. On fait la même chose (§7).

### 5.1 Instagram

- **Login** : `BrowserWindow` sur `instagram.com/accounts/login/`, partition dédiée. On observe
  les cookies de la partition et on considère la connexion établie dès que `sessionid` et
  `ds_user_id` existent. La 2FA fonctionne naturellement puisque c'est la vraie page.
- **Flux** : `GET /api/v1/feed/saved/posts/?max_id=<cursor>`, plus le flux des likes.
  Headers requis : `x-ig-app-id`, `x-csrftoken`, `x-requested-with: XMLHttpRequest`, UA cohérent
  avec la fenêtre de login. Pagination par `more_available` / `next_max_id`.
- **Médias** : `image_versions2.candidates[]`, `carousel_media[]` pour les carrousels,
  `video_versions[]` + poster pour les reels.
- **⚠️ Instagram n'expose pas la date de sauvegarde.** Le flux est rendu dans l'ordre inverse de
  sauvegarde : on stocke donc `source_rank` comme proxy d'ordre, et `discovered_at` pour tout ce
  qui arrive après le premier backfill. Le tri « par date de sauvegarde » est donc exact pour ce
  qui est capté après l'installation, et seulement *ordonné* pour l'historique antérieur. C'est
  une limite de la plateforme, pas de l'implémentation.
- **La plateforme la plus sensible** : c'est ici que la temporisation compte le plus.

### 5.2 X

La difficulté n'est pas l'endpoint mais ses identifiants, qui changent à chaque déploiement de
X (`queryId` dans l'URL GraphQL, drapeau `features`, en-têtes de transaction).

**Stratégie « apprendre puis rejouer »** — nettement plus robuste que de coder les valeurs en dur :

1. À la connexion, on ouvre `x.com/i/bookmarks` dans une fenêtre invisible de la partition.
2. On intercepte via `webRequest.onBeforeSendHeaders` la requête que la page émet d'elle-même,
   et on en capture l'URL complète et tous les en-têtes.
3. On mémorise ce gabarit (`x-request-template.json`, `x-saved-request-template.json`), on ferme
   la fenêtre, et le moteur de sync rejoue la même requête en ne changeant que le curseur.
4. Si une requête rejouée échoue (403 / schéma inattendu), on ré-apprend automatiquement en
   rouvrant la fenêtre une fois. L'adaptateur se répare seul dans la majorité des cas.

Un gabarit par flux : les signets et les likes ne passent pas par la même requête.

Pagination par curseur dans les instructions de timeline. Le tweet complet arrive dans la
réponse — pas besoin d'un second appel par post.

### 5.3 Reddit — implémenté, puis mis en sommeil

L'adaptateur existe et fonctionnait par les points `.json` du site, qui acceptent la session du
navigateur, sans jamais demander d'enregistrer une application développeur. Il couvrait posts
**et** commentaires sauvegardés, un commentaire devenant un `kind: 'text'` préfixé du titre de
son fil, sans quoi il serait illisible hors contexte.

Il est aujourd'hui retiré de `PUBLIC_PLATFORMS` : le contenu Reddit est majoritairement textuel
et lié, il se comporte mal dans un mur d'images, et sa place dans la carte sémantique n'a pas
été tranchée. Le code reste, et rien de ce qui est masqué n'est atteignable — c'est la condition
pour qu'un masquage soit honnête plutôt qu'un demi-produit.

**Le modèle d'accès reste unique pour toutes** : se connecter dans une fenêtre intégrée, et rien
d'autre. C'est ce qui rend l'application utilisable sans aucune configuration.

---

## 6. Moteur de sync

**Premier sync (backfill)** — le moment que l'utilisateur vit comme « connecte-toi et attends » :

- Pagination séquentielle jusqu'à épuisement, pause aléatoire de 2 à 5 s entre les pages.
- **Les plateformes tournent en parallèle**, chacune à son rythme. La première version les
  enchaînait, au motif que deux backfills simultanés doubleraient la trace laissée — c'était
  faux : Instagram ne voit rien de ce qu'on demande à X. La limitation de débit est par
  plateforme, donc la prudence doit l'être aussi. Le séquentiel ne protégeait de rien et ne
  faisait qu'imposer une attente. Ce qui compte reste en place : une page à la fois **par
  plateforme**, avec ses pauses et son plafond.
- Progression réelle à l'écran, et la grille se remplit **au fur et à mesure**, pas à la fin.
- Le cache des vignettes et la lecture des contenus tournent dans des files séparées, à débit
  limité, pour ne pas retarder l'indexation.

**Syncs suivants (incrémentaux)**

- On s'arrête après 3 pages consécutives sans aucun élément nouveau — typiquement 1 à 2 requêtes.
- Planifié avec jitter, uniquement quand l'app tourne. Bouton « Sync » manuel toujours
  disponible, avec cooldown.
- **« Re-vérifier toute la bibliothèque »** est une action distincte et explicite : elle
  reparcourt l'historique complet pour rattraper d'anciens posts manqués. Elle est séparée parce
  qu'elle coûte cher et qu'un rattrapage collant qui se déclenche tout seul repasse des dizaines
  de pages pour rien.

**Garde-fous**

- Backoff exponentiel sur 429 et 5xx.
- Détection de challenge / checkpoint Instagram → **arrêt immédiat**, aucune reprise automatique,
  notification claire avec la marche à suivre.
- Plafond dur de requêtes par session et par plateforme.
- Aucune requête n'est jamais émise sans action ou planification explicite.

---

## 7. Médias : cache, diffusion, budget

Deux modes, choisis à l'accueil et modifiables ensuite.

**Cache intelligent (défaut)** — on ne prépare que ce qui est regardé. La vignette est produite
localement : plus grande largeur ≤ **480 px**, WebP qualité 76. Le média plein est **diffusé à la
demande** depuis la plateforme quand on l'ouvre, jamais conservé.

**Mode hors-ligne** — une copie locale de chaque vidéo, à la qualité choisie (480p à source).
Plus fiable, beaucoup plus gros ; c'est un choix explicite, jamais un défaut.

Dans les deux cas :

- **Dimensions et couleur dominante** sont extraites à l'ingestion et stockées en base — c'est ce
  qui permet au masonry virtualisé de calculer sa mise en page **sans** charger la moindre image,
  donc de scroller dix mille posts sans à-coups.
- **Le schéma `magpie://`** est déclaré privilégié et sert les médias au renderer : cela permet de
  garder une CSP stricte sans jamais ouvrir `file://`. Il gère les requêtes par plage, donc le
  déplacement dans une vidéo fonctionne.
- **Les liens expirés sont renouvelés** à la volée (§5). Les requêtes concurrentes pour un même
  post partagent le même renouvellement.
- **Un lien resigné ne doit pas invalider le cache.** C'est le piège qui a coûté le plus cher :
  l'identité d'un média avait été dérivée de son URL, donc une URL resignée produisait un nouveau
  nom de fichier, et chaque synchronisation effaçait vignettes et clips pour les refaire. L'identité
  porte désormais sur ce qui ne bouge pas.
- **Budget de disque** : plafond réglable, éviction des plus anciennes vignettes non favorites, et
  un sous-budget distinct pour les vignettes afin qu'un cache de clips saturé ne les emporte pas.
  Les métadonnées, tags et collections survivent toujours à une purge de médias.
- **Pour l'analyse**, on extrait **3 images à 10 %, 50 % et 90 %** de la durée d'un clip déjà en
  cache. La poster d'un reel n'est presque jamais représentative de son contenu. Ces extractions
  sont mémorisées par empreinte : une bibliothèque déjà lue ne repasse pas ffmpeg sur ses 4 400
  clips pour n'écrire aucune ligne, ce qu'elle faisait.

**Le registre du travail de fond** (`tasks.ts`) réunit sync, vignettes, clips, lecture d'images et
transcription en une seule source : un indicateur, une courbe de débit, une pause globale, une
limite de bande passante et un profil de charge. Chaque activité mène sa propre boucle et se
contente d'annoncer où elle en est — le registre observe, il ne travaille pas.

---

## 8. Comprendre la bibliothèque, localement

C'est le cœur du produit, et c'est là que la spécification initiale a le plus changé. Tout ce qui
suit tourne **sur la machine**, sur des modèles téléchargés à la demande.

### 8.1 Règles — gratuit, instantané, aucun réglage

Appliquées à l'ingestion, sans aucun modèle : hashtags de la légende, handle de l'auteur,
plateforme, type de média, domaine des liens partagés. Couvre déjà une bonne part du travail,
particulièrement sur Instagram.

### 8.2 Le texte

`multilingual-e5-small` (~120 Mo). Le vote par mots-clés ne rapprochait que ce qui partageait un
mot. Mesuré : 5,3 ms par post, 53 s pour 10 000. Le recentrage du nuage est indispensable, pas
optionnel — sans lui l'écart entre paires proches et étrangères tombe à 0,050 au lieu de 0,307.

### 8.3 L'image — deux encodeurs, pas un

Un tiers de la bibliothèque de référence n'a aucun texte exploitable : 9 % rien du tout, 26 %
moins de vingt-cinq caractères une fois liens, emojis et arobases retirés. Ces posts ne se
ressemblent pas — ils se ressemblent **par le vide**, le modèle de texte lisant à peu près la
même chose pour tous. Mesuré : 0,894 de similarité moyenne entre eux, contre 0,836 dans la
bibliothèque entière. Ils s'agglutinaient donc sur la carte sans rien avoir en commun.

- `Xenova/dinov2-small` — la structure et le style. 23 Mo, 26 ms.
- `Xenova/siglip-base-patch16-224` — le sujet. Sait aussi comparer une image à des **mots**, ce
  que DINOv2 ne sait pas faire, et c'est ce qui rend §8.5 possible.

Deux plutôt qu'un parce qu'ils ne regardent pas la même chose et que la paire mesure mieux que
chacun seul : 3,85 écarts-types entre deux images d'un même carrousel et deux images au hasard,
contre 3,49 et 2,96 (`scripts/bench-vision-mix`).

Effet mesuré sur le classement : **1 299 posts sans légende correctement rangés sans les images,
2 445 avec.**

### 8.4 La parole

`whisper-base` (~140 Mo). Sur la bibliothèque de référence, un quart des vidéos n'a aucune prose
exploitable et la légende médiane fait douze mots. La langue est devinée depuis la légende et
depuis la bibliothèque autour : un reel français entendu comme de l'anglais n'en sort pas
approximatif, il en sort inventé. Le transcript sert au regroupement, à la recherche plein texte
et à l'export.

### 8.5 Une collection est une requête, pas une région

Le pavage de la carte définissait une collection par sa surface, et c'était trois fois faux. Une
appartenance est **graduée** — un post est plus ou moins « production musicale ». Elle est
**multiple** — un reel de synthé modulaire filmé au macro est dans deux collections. Et surtout
la carte est une **ombre** : UMAP écrase des centaines de dimensions sur deux, donc deux points
voisins à l'écran peuvent être loin en sens. Toute définition géométrique hérite des erreurs de
la projection et les rend permanentes.

Une collection porte donc un **prototype** : un vecteur dans le même espace que les posts.
L'appartenance est la ressemblance à ce vecteur, l'ampleur est un seuil, et la carte ne fait que
le montrer. Reprojeter ne change plus rien, parce que rien n'est défini par la carte.

Deux blocs, et pas trois. Une phrase se projette dans le bloc texte — même modèle que les posts —
et dans le bloc SigLIP, entraîné pour que mots et images vivent dans un seul repère. Le bloc
DINOv2 reste vide : il décrit une *allure*, et aucune tour de texte ne mène là.

Trois gestes, et trois seulement :

- **écrire** — une phrase crée la collection, la renommer la redéfinit. Des mots additionnels,
  chacun avec son poids : un post appartient s'il ressemble à *l'un* d'eux, de sorte qu'un mot
  étroit apporte ses posts au lieu de tirer tout le thème vers lui ;
- **régler l'ampleur** — un curseur, de « seulement l'évident » à « tout ce qui y ressemble » ;
- **trancher** — oui ou non sur des posts choisis. Le prototype se déplace, le verdict est retenu.

**L'ampleur est un nombre de posts, pas un score de confiance, et c'est une honnêteté délibérée.**
Mesuré (`scripts/bench-phrases`) : « 3D et rendu » culmine à 0,264 de ressemblance brute et 5,51
écarts-types ; « comptabilité fiscale », qui ne décrit rien de la bibliothèque, culmine à 0,294 et
5,98. La phrase absente note *plus haut* que la phrase présente. L'espace est trop anisotrope pour
qu'un seuil absolu sépare quoi que ce soit. Ce que les scores disent en revanche est excellent :
**l'ordre**. On expose donc le rang et on laisse l'utilisateur dire où s'arrêter.

### 8.6 La carte

Les vecteurs de §8.2 et §8.3 sont mélangés, réduits par ACP, puis projetés en deux dimensions par
UMAP dans un fil séparé. **La position vient de la projection, pas d'une simulation à ressorts** :
une physique déciderait de l'emplacement des points et les îles ne montreraient alors que la
physique. Ici la distance à l'écran *est* la proximité de sens. Le rebond, l'inertie et le zoom
élastique sont de l'interaction appliquée par-dessus des positions qui ne bougent pas.

L'ACP est passée par la matrice de covariance plutôt que par itération de puissance : la
bibliothèque n'est lue qu'**une fois** pour former `AᵀA`, possible parce que la largeur (1 536)
est plus petite que le nombre de posts (9 790). La projection entière coûtait 91,6 s, dont 64,4
pour cette seule fonction.

**Les régions sont trouvées dans la carte, pas posées dessus.** Les noms venaient des catégories
de l'organiseur, décidées en 1 536 dimensions puis projetées : information juste, mais pas une
*carte* — une carte nomme ce qu'on voit à l'endroit où on le voit, et une catégorie répartie en
trois taches n'a pas d'endroit. On cherche donc les amas là où l'œil les cherche, en trois gestes
(méthode des atlas d'embeddings, arXiv:2504.07285) : un **champ de densité**, une **ligne de
partage des eaux**, une **fusion par persistance** — un col d'un centimètre ne sépare pas deux
montagnes. Sans ce filtre, neuf mille posts donnent des centaines de micro-amas.

Les régions ont des **étages** : 0 se lit de loin, 2 ne se découvre qu'en approchant. C'est le
geste d'une carte routière — le pays, puis les villes, puis les rues — et il vaut ici pour la même
raison : une carte qui montre les mêmes vingt et un noms à tous les zooms ne dit plus rien une
fois qu'on est entré dedans.

**Les positions sont figées** (`post_positions` + `map_state`). Un post arrivé à la
synchronisation suivante est placé contre la carte existante, pas au terme d'une reprojection
générale. Un lieu dont on se souvient reste où il était — c'est la propriété qui fait qu'une carte
est un endroit et pas un graphique.

Un **zoom minimum de ×2** est imposé : plus loin, cent trente mille arêtes se superposent au point
que la carte redevient une nappe informe. Mieux vaut interdire l'échelle que la montrer.

### 8.7 Exporter pour son propre assistant

Magpie n'appelle aucun modèle et n'embarque aucun CLI. Il écrit un dossier — `PROMPT.md`, un
sommaire, un index découpé en tranches, une fiche par post, une liste par collection — que
l'utilisateur donne à l'assistant de son choix. Aucune clé, aucun compte, rien ne part sans lui.

La forme est dictée par une mesure : l'index complet d'une bibliothèque de 9 738 posts pèse 2,1 Mo,
soit un demi-million de jetons. Il est donc découpé en tranches d'environ 1 200 posts, et le prompt
demande de fouiller par motif de texte avant de lire quoi que ce soit.

Découplé du reste : utilisable sans avoir jamais créé une collection ni transcrit une vidéo.

**Ce que l'export ne transporte pas, et c'est sa limite structurelle.** Les fiches contiennent la
légende, la transcription, l'auteur, les tags et les collections — c'est-à-dire du **texte**. Or ce
que Magpie sait de mieux sur un post sans légende est un **vecteur**, et un vecteur n'a pas de
forme écrite. Un assistant qui reçoit le dossier retrouve donc ce que les mots disent, jamais ce
que les images montrent, alors que l'application, elle, le sait. Mesuré le 2026-08-26 sur la
bibliothèque de référence : la collection « Music production » compte 124 posts, dont 92 vidéos ;
24 seulement portent dans leur texte un mot de la famille *vst / plugin / ableton / synth / daw /
mixing / mastering*, et 34 ont une légende de moins de vingt-cinq caractères. Une recherche par
motif dans l'export tout entier trouve `vst` dans 11 fiches et `plugin` dans 30. Voir §12.

### 8.8 Ce qu'on n'appelle plus

Le premier plan reposait sur Claude en vision, en lots, via l'API Batch, avec un écran de clé API
et un compteur de dépense. Il est **débranché** : `LLM_SETTINGS_VISIBLE = false`, aucun SDK dans
les dépendances, `ai_description` sans producteur.

Deux raisons, dans cet ordre :

1. **Un abonnement Claude Pro ou Max ne donne pas accès à l'API.** Ce sont deux facturations
   distinctes, et il n'existe pas de « Se connecter avec Claude » pour une application tierce.
   Demander une clé, c'est demander à l'utilisateur d'ouvrir un second compte facturé — pour une
   fonction qu'il croyait déjà payée.
2. **Les modèles locaux suffisent pour ce qu'on leur demande**, qui est de *rapprocher*, pas de
   décrire. Et ils rendent vraie sans réserve la phrase la plus importante de la page d'accueil.

Qui veut parler de sa bibliothèque avec un assistant exporte un dossier (§8.7) : son abonnement
existant suffit, aucune clé n'entre en jeu.

---

## 9. Interface

**Disposition** : barre latérale (bibliothèque, sources, filtres, collections, tags) · barre
d'outils (recherche, sélection, sync, organisation, téléchargements, filtres, tri, son des
aperçus, densité, mode d'affichage) · zone principale.

### Trois façons de regarder

- **Masonry** — hauteurs variables, métadonnées au survol.
- **Cartes** — hauteur régulière, auteur et extrait toujours visibles.
- **Carte sémantique** — §8.6.

Curseur de densité de 140 à 400 px de colonne visée. Les deux premières sont virtualisées ; la
troisième dessine sur un canevas.

**Le survol anime la carte** — c'est ce qui distingue un mur vivant d'une planche-contact :

- Une **vidéo se lit** au survol, en boucle, son coupé par défaut et réglable. L'élément vidéo
  n'est monté que pendant le survol : il n'y a jamais plus d'un ou deux décodeurs actifs, là où un
  lecteur par carte visible saturerait la machine.
- Un **carrousel défile** ses vues en fondu, avec des points de position, et revient à la première
  image quand la souris sort. Les vues suivantes ne sont chargées qu'au survol.

### La carte, gestes compris

Survoler un point le lit ; cliquer l'ouvre dans un **panneau redimensionnable à côté de la carte**,
sans quitter la carte. La molette zoome, le glissé déplace, `Maj`+glissé entoure un groupe pour le
nommer. Quatre familles de noms s'allument indépendamment — régions, amas, collections, étiquettes
personnelles — parce qu'une collection et un amas disent presque la même chose au même endroit et
qu'empiler deux noms sur la même tache ne sert personne. La couleur des points se relit de cinq
façons : amas, collection, plateforme, type, signets/likes. Un bouton regroupe temporairement par
**style** plutôt que par sujet, et le même bouton ramène ; rien ne le mémorise, parce qu'une carte
qui a quatre versions n'est plus un endroit.

Le nom passe devant le point au survol comme au clic : un titre repose presque toujours sur son
propre amas, donc viser le nom devenait un jeu d'adresse.

### Filtres, tri, recherche

- Sources : bibliothèque entière, signets, likes, favoris.
- Filtres : plateforme, type de média, « sans tag », liens, tag(s), collection(s), étiquette.
- Tri : date de sauvegarde (ou rang en repli), date de publication, auteur, plateforme, aléatoire.
- Recherche plein texte instantanée via FTS5, sur la légende, l'auteur et la transcription,
  insensible aux accents.
- L'état complet — recherche, filtres, tri, défilement — **est conservé entre les sessions**.

### Étiquettes de couleur

Sept teintes fixes — rouge, orange, jaune, vert, bleu, violet, gris — assignables à un post et à
une collection. Elles sont **indépendantes de la couleur d'accent** : ce sont des repères de
rangement, pas de la décoration, et un « rouge » doit rester rouge quelle que soit la teinte de
l'interface. Un post étiqueté porte un liseré et une pastille. La rangée de filtres est **limitée
aux teintes réellement utilisées** : sept cases vides seraient du bruit. C'est le repère le plus
rapide de l'interface — on le voit sans lire, ce qu'aucun tag ne permet.

### Tags et collections

- Tags multiples par post, filtrage par combinaison.
- Collections : un post peut appartenir à plusieurs ; création par une phrase depuis le rail de la
  carte, ou à la main depuis la barre latérale.
- **Sélection en masse** : mode sélection, puis « Ajouter à la collection », tags, favoris.
- **Doublons** : la contrainte de clé primaire les rend impossibles. Quand une partie de la
  sélection est déjà dans la collection, un dialogue annonce le décompte et propose d'ajouter le
  reste.

### L'organisation, écran par écran

« Réorganiser » ouvre un parcours en trois temps : le **choix** entre rapide et approfondi, la
**liste des étapes** à préparer — chacune avec son coût annoncé, ce qu'on perd à la sauter, et sa
progression — puis le **plan** proposé, qu'on corrige avant de l'appliquer. Le travail continue en
arrière-plan si on ferme, et le dernier classement appliqué s'annule en un clic.

### Détail d'un post

Une vue modale par-dessus la grille : média plein, carrousel, lecteur vidéo avec choix de qualité,
plein écran, texte complet, tags éditables, collections, favori, copie du lien, ouverture sur la
plateforme. Flèches pour passer d'un post à l'autre, `Échap` pour sortir.

### Copie — l'usage central

- Un clic sur l'icône de copie d'une carte → URL canonique dans le presse-papier.
- Mode sélection → compteur, « Copier les N liens » (une URL par ligne).

### Envoi vers Nitrate

[Nitrate](https://github.com/BeeeFX/Nitrate) est le compresseur vidéo de l'auteur : on lui donne un
lien, il télécharge via yt-dlp et ré-encode sous une taille cible. La communication passe par un
protocol handler :

```
nitrate://add?url=<encodeURIComponent(url)>
```

Côté Magpie c'est un unique `shell.openExternal()`. **Désactivé par défaut**, activable dans les
réglages, visible seulement sous Windows. Le lien profond est construit par le processus principal,
jamais par l'interface : le renderer ne fournit qu'une URL `http(s)`, ce qui l'empêche de
déclencher un schéma applicatif arbitraire.

### Tray, fenêtre, thème

- Icône permanente ; fermer la fenêtre laisse Magpie actif pour les syncs planifiées.
- **Cadre de fenêtre** : le cadre natif est remplacé par le nôtre — `titleBarOverlay` sous Windows.
  La barre de titre grise du système posée au-dessus de l'application est ce qui distingue le plus
  nettement une page web dans une fenêtre d'une vraie application de bureau.
- **Thème et accent** : sombre, clair, ou système. Le thème est résolu par le processus principal —
  il doit de toute façon le connaître pour colorer les boutons de fenêtre, et deux sources de
  vérité finiraient par diverger. L'accent ne colore que ce qui est actif, jamais le mobilier.
- **Langues** : français et anglais, ou celle du système. `npm run check:i18n` vérifie qu'aucune
  clé ne manque d'un côté.
- **Typographie** : Plus Jakarta Sans Variable, embarquée. Aucune requête réseau, donc compatible
  avec la CSP stricte, et un rendu identique quelles que soient les polices installées.

---

## 10. Sécurité et vie privée

- Aucun serveur, aucune télémétrie, aucun service de modèle. Les seules requêtes sortantes vont
  aux plateformes connectées, au dépôt GitHub pour les mises à jour, et au CDN de Hugging Face au
  premier téléchargement d'un modèle.
- Les sessions vivent dans des partitions Electron isolées, une par plateforme, dans le stockage
  chiffré de Chromium. Magpie ne voit jamais le mot de passe saisi sur la vraie page de connexion.
- Bouton « Déconnecter » par plateforme, qui purge réellement la partition.
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, IPC typée et restreinte,
  CSP stricte, schéma `magpie://` privilégié plutôt que `file://`.
- Aucune page distante n'est chargée dans une fenêtre de Magpie en dehors des fenêtres de
  connexion : « voir en vrai » ouvre le navigateur du système.
- La bibliothèque entière est un dossier déplaçable : base, médias, réglages. Rien n'est captif —
  sous la réserve du §14 sur l'import.

---

## 11. État livré

Les jalons M0–M7 de la version initiale sont dépassés ; les conserver ne renseignait plus
personne. Au 2026-08-26, en version 0.42.0 :

| Domaine | État |
|---|---|
| Coquille, grille, cache, fixture de démonstration | livré |
| Sessions isolées, Instagram et X, signets et likes | livré |
| Sélection en masse, tags, collections, favoris, étiquettes | livré |
| Détail, copie, envoi vers Nitrate | livré |
| Cache intelligent, diffusion, budget, registre du travail de fond | livré |
| Compréhension locale : texte, images, parole | livré |
| Collections-requêtes, carte sémantique, régions | livré |
| Export pour assistant | livré |
| Tray, sync planifiée, réglages, mise à jour automatique | livré |
| Build Windows NSIS + mises à jour différentielles | livré, **non signé** |
| Reddit | en sommeil (§5.3) |
| macOS, Linux | ni testés ni signés |
| Import de bibliothèque | absent (§14) |

Deux outils non prévus par la spec initiale, tous deux justifiés :

- Une **suite de contrôles** exécutables sans lancer l'interface — `check:layout` compare la
  fenêtre de virtualisation à une recherche exhaustive à chaque position de scroll ;
  `check:schema` tient l'invariant des migrations ; `check:map`, `check:islands`, `check:map-*`
  exercent la carte ; `check:library-guard` vérifie qu'une base venue du futur n'est pas
  « réparée ». Plus une famille de bancs (`bench:*`) dont les mesures sont citées dans ce document.
- Un **aperçu navigateur** sur `localhost:5173` pendant `npm run dev`, alimenté par un instantané
  que le processus principal dépose au démarrage. Sert à itérer sur le CSS avec de vraies devtools.
  Volontairement dégradé : filtres, tri et recherche y sont ignorés, pour ne pas dupliquer de
  logique métier côté renderer. La carte y est simulée et ne vaut pas la vraie.

---

## 12. Points ouverts

1. **Donner à l'export ce que les images savent.** C'est le seul endroit où l'application en sait
   nettement plus qu'elle n'en dit (§8.7). Deux pistes, non exclusives : écrire dans chaque fiche
   la **région** de la carte à laquelle le post appartient, ce qui coûte une jointure et donne à
   l'assistant un mot là où il n'y avait rien ; et lui donner les **voisins** d'un post, pour qu'il
   puisse élargir depuis une trouvaille au lieu de ne savoir que chercher des mots.
2. **Le verdict « rien à entendre » se pose encore à tort, et il est définitif.** Sur la
   bibliothèque de référence, 4 555 posts portent `transcript = ''` et un seul porte du texte. Or
   `pendingTranscripts` filtre sur `transcript IS NULL` : ces 4 555 posts ne peuvent plus jamais
   revenir dans la file, l'étape annonce zéro vidéo à faire, et relancer l'organisation ne peut
   rien y changer — l'écran de fin dit alors « tout a été lu » en toute bonne foi.

   Mesuré le 2026-08-26 en rejouant le code actuel sur ces mêmes clips : **13 clips sur 20 de plus
   de vingt secondes en tirent de la parole exploitable** — des tutoriels, des explications, du
   commentaire. Ce n'est ni le son (crête 0,35 à 0,96, RMS 0,06 à 0,19, ~100 % d'échantillons non
   nuls), ni l'extraction, ni la quantification q8 (fp32 se comporte pareil), ni le découpage, ni
   une interférence des encodeurs d'image (8 sur 12 dans les deux sens).

   La garde posée le 2026-08-24 ne couvre que le cas où la reconnaissance **lève**. Une passe qui
   *retourne* « Music » pour tout le monde sans lever ressemble, vue du code, à une bibliothèque de
   vidéos muettes — et écrit le verdict permanent. Il manque la même règle sur les résultats vides :
   N clips d'affilée dont le son a du niveau et dont le modèle ne tire rien est une panne, pas une
   propriété de la bibliothèque. Le niveau sonore est déjà dans le tampon qu'on tient en main, donc
   séparer « vidéo muette » de « modèle muet » ne coûte rien. La réparation des lignes déjà écrites
   suivra le même chemin que la v25 — mais elle ne vaut d'être faite qu'une fois la garde en place.
3. **Comptes multiples par plateforme.** Le modèle suppose un compte par plateforme. Le supporter
   coûte une colonne ; le rétro-adapter coûtera davantage à mesure que la base grossit.
4. **Signature du binaire Windows.** SmartScreen avertit à chaque installation, et c'est le premier
   frein à l'adoption qu'un utilisateur rencontre.
5. **Reddit.** Le remettre suppose de décider ce qu'un post textuel devient dans un mur d'images et
   dans la carte, pas seulement de rallumer l'adaptateur.

---

## 13. Hypothèses retenues

- Un seul compte par plateforme.
- **Volume cible : dix mille posts par bibliothèque**, et l'architecture est dimensionnée pour ça —
  c'est la révision la plus lourde de conséquences par rapport à la version initiale, qui visait
  « quelques centaines par plateforme ».
- Les signets supprimés côté plateforme sont **conservés** localement et marqués `is_archived`
  plutôt que supprimés — perdre une inspiration parce qu'un auteur a fermé son compte serait le
  pire comportement possible pour cet outil.
- L'application est pleinement utilisable sans jamais lancer la moindre analyse : la compréhension
  locale ajoute la carte et les collections-requêtes, elle ne conditionne pas le reste.
- Interface bilingue français / anglais, la langue du système par défaut.

---

## 14. Ce que ce document décrit et que l'application ne fait pas

*Relevé le 2026-08-26, à la version 0.42.0. Vérifié dans le code, pas de mémoire.*

Les intentions ci-dessous gardent leur raison d'être — elles restent écrites plus haut, avec leur
justification — mais elles ne sont **pas** livrées, et aucune n'est en cours.

**§9 — Onglets.** Il n'y en a pas, et la spécification initiale en promettait. Ouvrir un post
affiche une fenêtre modale par-dessus la grille, avec les flèches pour passer d'un post à l'autre
et `Échap` pour sortir. La grille conserve en revanche bien son défilement, ses filtres et sa
sélection, comme promis.

**§9 — « Voir en vrai ».** Aucune webview, et le renderer tourne en bac à sable. Le bouton ouvre
la page dans le navigateur du système. C'est la position la plus sûre, et elle est assumée.

**§9 — Raccourcis de la grille.** `Ctrl+B`, `Ctrl+,` et `Ctrl+K` existent. Les flèches, `Espace`
pour l'aperçu, `F`, `T`, `C`, `Ctrl+A` et `Maj`+clic pour une plage n'existent pas : la sélection
se fait une carte à la fois.

**§9 — Doublons.** L'avertissement est une boîte système avec un décompte, sans « voir lesquels »
ni « ajouter les autres » séparément.

**§9 — Nitrate en sélection multiple.** Un post à la fois.

**§9 — Complétion des tags.** Le champ est libre, sans suggestions.

**§9 — Couverture de collection.** `collections.cover_post_id` existe en base, et rien ne le pose.

**§10 — Import.** L'export Markdown pour assistant existe ; il n'y a **aucun import**, et aucun
export JSON structuré. C'est la seule absence qui contredise un principe énoncé — « rien n'est
captif » — et donc la première à reprendre si la liste doit se raccourcir.

**§8.7 — La richesse de l'export.** Voir le point ouvert n° 1 : le dossier ne transporte que du
texte, alors que l'essentiel de ce que Magpie a compris d'une image est un vecteur. Ce n'est pas
un défaut d'implémentation mais un manque de conception, et il est visible dès qu'on pose à un
assistant une question dont la réponse est dans les images.
