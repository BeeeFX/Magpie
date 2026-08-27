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
  Browse thousands of saved posts like a moodboard, organise them on your own machine —<br>
  and see the whole thing at once, as a map.
</p>

<p align="center"><sub>Windows 10/11 · Free and open source · English & French · Light & dark themes</sub></p>

![Magpie visual library with bookmarks and likes](docs/assets/magpie-library.png)

## The things you saved, finally useful

Magpie turns scattered posts into a fast Pinterest-style wall. Connect Instagram or X, choose **Bookmarks**, **Likes**, or **Both**, and browse it all together. A post saved in both feeds stays a single item.

| Browse naturally | Organise your way | Stay fast at scale |
| --- | --- | --- |
| Masonry wall, regular cards, or the map. Hover previews with sound, carousels, and an integrated video player. | Collections, tags, favourites, colour labels, accent-insensitive search and bulk actions. | Virtualised scrolling and a bounded smart cache, built for libraries of tens of thousands of posts. |

## A wall you want to keep scrolling

A moodboard works when you see things you were not looking for.

<p align="center">
  <img src="docs/assets/magpie-wall.png" alt="The masonry wall at its densest, a contact sheet of saved posts" width="32%">
  <img src="docs/assets/magpie-cards.png" alt="Card view, with the author and an excerpt on every post" width="32%">
  <img src="docs/assets/magpie-search.png" alt="Searching the library, with a post's details revealed on hover" width="32%">
</p>

- **Two grids, one slider.** Masonry lets every post keep its own height; cards give them all the same. Columns from 140 to 400 px — contact sheet or gallery.
- **Hover brings it to life.** Videos play in place, muted until you want the sound; carousels fade through their views. Only the tile under the cursor is mounted, so nothing stutters.
- **Find it instantly.** Platform, media type, untagged, favourites — plus accent-insensitive search across captions, authors and tags.
- **Ten thousand posts scroll like ten.** Sizes and dominant colours are read at import, so the wall lays itself out without loading a single image.

## Organise locally — no account, no API key, no cloud

Magpie sorts your library into collections by itself, entirely on your machine. Two paths:

![Magpie's local organiser, offering a quick pass or a thorough one](docs/assets/magpie-organizer.png)

**Quick** reads captions, hashtags, tags, creators and thumbnails, then proposes collections for you to correct. A few minutes.

**Thorough** goes further, and unlocks the map. Two vision models look at every thumbnail and at three frames from each cached video, because the cover of a clip rarely says what the clip is about. Whisper transcribes what is spoken, in the language it is actually spoken in. One to two hours, resumable, and it tells you what each step costs before you start.

Looking is what makes the difference: a third of a typical library has no usable caption. On a 9,600-post library, filing rose from 1,299 to 2,445 of those posts once the images had a say.

Nothing is locked in — what it proposes are ordinary collections, and one click undoes the whole run.

## Push it further: your whole library as one picture

Once the thorough pass has run, Magpie draws everything you saved as a map — **one dot per post, placed so that distance is similarity**. Dense areas name themselves, zooming in reveals finer regions inside the big ones, and clicking a point opens the post beside the map. Positions are frozen once computed, so a place you remember stays put.

Collections work the same way: **a name, a few words, and a reach**. Write “music production”, add “ableton”, “synth”, “mixing” with their own weights, and a phrase alone can file thousands of posts. Ranking is trustworthy, absolute scores are not — so you decide where to stop, and the map paints the gradient while you do.

<p align="center">
  <img src="docs/assets/magpie-map.png" alt="The Magpie semantic map, one dot per post, with named regions" width="48%">
  <img src="docs/assets/magpie-collections.png" alt="A collection defined by words and a reach, next to the map" width="48%">
</p>

## Hand your library to your own assistant

Magpie writes out a folder that Claude, ChatGPT or any other assistant can read on its own: captions, transcripts, authors, tags and collections, plus a prompt you can edit. No key, no account, and nothing leaves your machine unless you hand over the folder yourself.

## Made for large libraries

- Sync Instagram and X in parallel, with visible progress and resumable long imports.
- **Smart cache** by default: only the 480p thumbnails you browse, under a disk limit you set. Full media streams when you open it, and offline video storage stays an explicit choice.
- Pause background work or cap its bandwidth from one panel.
- Keep your last search, filters, sorting and scroll position between sessions.
- Move the library to another drive at any time; updates install themselves in the background.

<p align="center">
  <img src="docs/assets/magpie-welcome.png" alt="Magpie's welcome tour explaining what the app does" width="48%">
  <img src="docs/assets/magpie-settings.png" alt="Magpie account, sync and local organisation settings" width="48%">
</p>

## Install in a minute

1. Open the **[latest Magpie release](https://github.com/BeeeFX/Magpie/releases/latest)**.
2. Download `Magpie-Setup-x.y.z.exe` and follow the installer.
3. Open Magpie, choose where its library should live, then connect Instagram or X.

> Magpie is not code-signed yet, so Windows SmartScreen may show a warning. Check that the publisher page is this repository before continuing.

## Private by default

Your posts, tags, collections, database and cached thumbnails stay on your computer. Platform sessions live in separate Chromium partitions, and Magpie never sees the password entered on the platform's real login page.

Reading your images, transcribing your videos, grouping them and drawing the map all run locally. No captions, thumbnails or account data are sent to an external AI service.

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

Type checking, the guard suite and Windows packaging:

```bash
npm run typecheck
npm run check:db
npm run check:media
npm run check:organizer
npm run check:vision
npm run check:transcribe
npm run check:map
npm run check:islands
npm run check:library-guard
npm run build
npm run dist:win
```

`npm run preview:web` opens the interface in an ordinary browser against a snapshot written by the last `npm run dev`, which is enough to iterate on layout and CSS without Electron around.

### Architecture

- Electron for the desktop shell, isolated platform sessions, background work and updates;
- React + Zustand for the interface, with a hand-rolled virtualised layout;
- SQLite/FTS5 for local storage and search;
- `@huggingface/transformers` for the local text, vision and Whisper models, and `umap-js` in a worker thread for the map projection;
- Sharp for bounded 480p thumbnails and FFmpeg for adaptive video streams and frame extraction;
- electron-builder + electron-updater for NSIS releases and differential updates.

A tag matching the `package.json` version triggers the Windows release workflow. It publishes the installer, blockmap and `latest.yml` update manifest to GitHub Releases.

</details>

## License

MIT — see [LICENSE](LICENSE).
