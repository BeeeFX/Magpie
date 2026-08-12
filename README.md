# Magpie

Magpie réunit les posts sauvegardés d’Instagram, X et Reddit dans une bibliothèque visuelle locale, rapide et agréable à parcourir.

> Statut : bêta de bureau. Les intégrations utilisent les sessions web des plateformes et peuvent devoir être adaptées si leurs interfaces privées changent.

## Fonctions

- synchronisation parallèle d’Instagram, X et Reddit, avec reprise des imports interrompus ;
- progression indépendante, compteur et annulation pour chaque plateforme ;
- grille masonry ou cartes, densité réglable, recherche et filtres ;
- lecteur vidéo intégré, volume global, son au survol et navigation post précédent/suivant ;
- qualités vidéo sélectionnables lorsqu’elles sont proposées par la plateforme ;
- favoris, tags, couleurs Finder et collections ;
- multi-sélection, actions groupées et copie de plusieurs liens ;
- tagging automatique facultatif avec OpenAI, Claude, Gemini, DeepSeek ou un endpoint compatible OpenAI ;
- synchronisation planifiée et icône dans la zone de notification ;
- bibliothèque déplaçable sur un autre disque et plafond configurable du cache ;
- interface française et anglaise, thèmes clair et sombre ;
- bouton facultatif « Envoyer vers Nitrate ».

## Confidentialité

Les posts, tags, collections et médias mis en cache restent sur l’ordinateur. Les sessions de plateforme vivent dans trois partitions Chromium isolées. Magpie ne reçoit jamais le mot de passe saisi dans la page officielle de connexion.

Le tagging automatique est désactivé par défaut. Lorsqu’il est activé, le texte et une vignette peuvent être envoyés au fournisseur choisi. La clé API est chiffrée avec le coffre sécurisé du système et n’est pas enregistrée dans `settings.json`.

## Stockage

Par défaut, Electron place la bibliothèque dans le dossier de données utilisateur de Magpie. Les réglages permettent de choisir un dossier vide sur un autre disque. La migration crée un instantané cohérent de la base, copie les médias, conserve l’ancienne bibliothèque en secours, puis redémarre Magpie sur le nouvel emplacement.

Si le disque choisi est absent au démarrage, Magpie affiche le chemin inaccessible au lieu de créer silencieusement une nouvelle bibliothèque vide.

## Installation Windows

Téléchargez `Magpie Setup <version>.exe` depuis la page Releases, puis suivez l’assistant. Les premières versions non signées peuvent déclencher un avertissement SmartScreen.

Les builds macOS et Linux sont configurés mais doivent encore être signés et testés sur leurs systèmes respectifs.

## Développement

Prérequis : Node.js et npm.

```bash
npm install
npm run dev
```

Contrôles locaux :

```bash
npm run typecheck
npm run check:layout
npm run build
npm run dist:win
```

## Architecture

- Electron : processus principal, sessions, SQLite, cache et synchronisation ;
- React + Zustand : interface ;
- better-sqlite3 + FTS5 : bibliothèque et recherche ;
- Sharp : vignettes ;
- ffmpeg : remux des flux vidéo adaptatifs, notamment Reddit ;
- electron-builder : installateurs.

## Avertissement plateformes

Magpie n’est affilié ni à Meta, ni à X Corp., ni à Reddit. Les endpoints web utilisés ne constituent pas des API publiques garanties. Synchronisez avec une cadence raisonnable et respectez les conditions d’utilisation applicables à vos comptes.

## Licence

MIT — voir [LICENSE](LICENSE).
