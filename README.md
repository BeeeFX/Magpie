<p align="center">
  <img src="docs/assets/magpie-banner.png" alt="Magpie — Bookmarks and likes, beautifully organised" width="100%">
</p>

<p align="center">
  <a href="https://github.com/BeeeFX/Magpie/releases/latest"><img alt="Download Magpie for Windows" src="https://img.shields.io/badge/Download_for_Windows-7C5CFC?style=for-the-badge&logo=windows&logoColor=white"></a>
  <a href="https://github.com/BeeeFX/Magpie/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/BeeeFX/Magpie?style=for-the-badge&label=Latest"></a>
</p>

<p align="center">
  <a href="https://github.com/BeeeFX/Magpie/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/BeeeFX/Magpie?label=release&color=5865F2"></a>
  <a href="https://github.com/BeeeFX/Magpie/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/BeeeFX/Magpie/total?label=downloads&color=5865F2"></a>
  <a href="LICENSE"><img alt="Licence" src="https://img.shields.io/github/license/BeeeFX/Magpie?label=licence&color=5865F2"></a>
</p>

<p align="center">
  <strong>Your Instagram and X bookmarks and likes, together in one calm visual library.</strong><br>
  Browse thousands of saved posts like a moodboard, organise them locally, and find them again.
</p>

<p align="center"><sub>Windows 10/11 · Free and open source · English & French · Light & dark themes</sub></p>

![Magpie visual library with bookmarks and likes](docs/assets/magpie-library.png)

## The things you saved, finally useful

Magpie turns scattered posts into a fast Pinterest-style wall. Connect Instagram or X, choose **Bookmarks**, **Likes**, or **Both**, then browse everything together or filter it instantly. A post that appears in both feeds stays a single item.

| Browse naturally | Organise your way | Stay fast at scale |
| --- | --- | --- |
| Masonry or card grid, hover previews, carousels and an integrated video player. | Collections, tags, favourites, colour labels, search and bulk actions. | Virtualised scrolling and a bounded smart cache designed for libraries with tens of thousands of posts. |

### Made for large libraries

- Sync Instagram and X in parallel, with visible progress and resumable long imports.
- Keep your last search, filters, sorting and scroll position between sessions.
- Stream full images and videos only when opened; choose video quality in the player.
- Use the default **Smart cache** to prepare only the 480p thumbnails you browse.
- Set a disk limit: recently viewed thumbnails stay available while older ones are replaced automatically.
- Choose offline video storage only if you explicitly want a larger local archive.
- Move the complete library and cache to another drive at any time.
- Receive automatic Windows updates in the background.

## Organise locally — no LLM or API key

Magpie can compare captions, hashtags, tags, creators and local visual signatures to suggest useful collections. The analysis runs on your computer and works incrementally, including on very large libraries.

Magpie also *looks* at your posts. Two local vision models read every thumbnail — and three frames from each cached video, because the cover of a clip rarely says what the clip is about. A third of a typical library has no usable caption; measured on a 9,600-post library, filing rose from 1,299 to 2,445 of those posts once the images had a say.

And it *listens*. Whisper transcribes the speech in your videos on your machine, which is often a reel's only real text. Each clip is transcribed in the language it is actually spoken in, guessed from its caption and from the library around it — a French reel heard as English does not come out approximate, it comes out invented.

Nothing is filed without your approval: rename a category, exclude it, or merge related suggestions before creating the collections.

### A map of what you saved

Magpie draws your whole library as a map: one dot per post, placed so that distance *is* similarity. It is a third way to look at what you saved, next to the wall and the cards — the one that shows *what goes with what*. Click any point to open the post in a resizable panel beside the map, name a dense area yourself, and let the island titles tell you where you are.

The map is deliberately stable: positions are frozen once computed, so posts arriving on later syncs are placed against the existing map instead of rearranging it. A place you remember stays where you left it.

### Collections are queries, not folders

A collection is **a name, a few words, and a reach**. Write “music production”, and Magpie scores all of your posts against it — the same local model reads words and images in one shared space, so a phrase alone can file thousands of posts. Add “ableton”, “synth”, “mixing”, each with its own weight: a post belongs if it matches *any* of them, so a narrow word brings its posts in instead of dragging the whole theme towards it.

The reach is a number of posts, not a confidence score, and that is a deliberate honesty: measured on a real library, a phrase that describes nothing you ever saved scores just as high as one at the centre of your interests. Ranking is trustworthy, absolute scores are not — so you set where to stop, and the map shows you the gradient while you do it.

- Selecting a collection paints the whole library as a heatmap, so you see it bleed outward and know what one more notch would catch.
- One post can belong to several collections, because that is how meaning actually works.
- Rename, recolour, merge or delete a collection at any time; renaming only changes the label, never what is inside.
- Hide everything outside the collection when you want to read its shape alone.

![Magpie local collection organiser](docs/assets/magpie-organizer.png)

<p align="center">
  <img src="docs/assets/magpie-welcome.png" alt="Magpie welcome tour with source and smart cache choices" width="48%">
  <img src="docs/assets/magpie-settings.png" alt="Magpie account, source and local organisation settings" width="48%">
</p>

## Install in a minute

1. Open the **[latest Magpie release](https://github.com/BeeeFX/Magpie/releases/latest)**.
2. Download `Magpie-Setup-x.y.z.exe` and follow the installer.
3. Open Magpie, choose where its library should live, then connect Instagram or X.

> Magpie is not code-signed yet, so Windows SmartScreen may show a warning. Check that the publisher page is this repository before continuing.

Magpie checks stable GitHub releases automatically, downloads updates in the background, and asks before restarting to install one.

## Private by default

Your posts, tags, collections, database and cached thumbnails stay on your computer. In Smart cache mode, full media is streamed from its platform only when you open it and is not stored permanently. Platform sessions live in separate Chromium partitions, and Magpie never sees the password entered on the platform's real login page.

Local organisation does not send captions, thumbnails or account data to an external AI service.

## Good to know

Magpie is an independent project and is not affiliated with Meta or X Corp. It uses the private web endpoints used by the platforms themselves, which may change over time. Sync reasonably and follow the terms that apply to your accounts.

Reddit support is currently hidden while its integration is being redesigned. macOS and Linux packages are planned but are not yet tested or signed.

<details>
<summary><strong>For developers and contributors</strong></summary>

### Local development

Requirements: Node.js 22 and npm.

```bash
npm install
npm run dev
```

Checks and Windows packaging:

```bash
npm run typecheck
npm run check:layout
npm run check:db
npm run check:media
npm run check:organizer
npm run check:transcribe
npm run check:map
npm run check:map-density
npm run check:library-guard
npm run check:cells
npm run check:boundaries
npm run build
npm run dist:win
```

### Architecture

- Electron for the desktop shell, isolated platform sessions, background work and updates;
- React + Zustand for the interface;
- SQLite/FTS5 for local storage and search;
- Sharp for bounded 480p thumbnails and FFmpeg for adaptive video streams;
- electron-builder + electron-updater for NSIS releases and differential updates.

A tag matching the `package.json` version triggers the Windows release workflow. It publishes the installer, blockmap and `latest.yml` update manifest to GitHub Releases.

</details>

## License

MIT — see [LICENSE](LICENSE).
