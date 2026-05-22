# MegaStream

A browser-based streaming client for [MEGA](https://mega.nz). Browse your MEGA drive, stream video files directly without downloading the whole file first, and manage metadata — all from a clean, fast UI.

## Features

- **Login with persisted session** — log in once with MEGA credentials; the session is saved to `localStorage` and restored on reload.
- **Folder browsing with hash routing** — every folder has a URL (`#/folder/<id>`). Refresh, share, or bookmark deep links and land back in the same place.
- **Seekable video streaming** — videos are served through a Service Worker that proxies ranged `Range` requests into `megajs` download streams. The browser's `<video>` element gets full seek/scrub support without buffering the entire file.
- **Thumbnails from MEGA file attributes** — lazily decrypts FA type 0 (thumbnail) blobs as the user scrolls, with in-memory caching.
- **Per-video detail page** — `#/file/<id>` renders a full-width player (capped at 1920px), inline rename, editable memo, upload date, resolution, duration, size, and node ID.
- **Inline rename** — pencil button (hover-revealed) on every file/folder card and on the detail page. `Enter` to save, `Esc` to cancel.
- **Memos** — free-form notes per file, stored as MEGA custom node attributes (`_memo`) so they're encrypted with the node key and persist across clients.
- **Multi-file uploads** — file picker, parallel uploads (max 3 concurrent), per-file progress with backpressure handling, cancel mid-upload. A floating panel tracks all jobs.
- **Quota indicator** — storage and transfer bandwidth used / total, sourced from `getAccountInfo`.

## Tech stack

- [Svelte 5](https://svelte.dev) (runes, no SvelteKit)
- TypeScript
- [Vite 8](https://vitejs.dev)
- [Tailwind CSS 4](https://tailwindcss.com)
- [megajs](https://github.com/tonygomes/megajs) — MEGA SDK
- Service Worker for ranged streaming
- Web Crypto API for decoding MEGA file attribute payloads (AES-CBC)

## Getting started

```sh
npm install
npm run dev      # vite dev server
npm run build    # production build
npm run check    # svelte-check + tsc
npm run preview  # preview the production build
```

Open the dev server URL, log in with your MEGA email and password, and start browsing.

> **Note**: MEGA credentials are sent directly to MEGA's servers from your browser. The session blob in `localStorage` is enough to re-authenticate — treat it like a password.

## Architecture notes

### Routing

Hash routing lives in `src/lib/router.svelte.ts`. Three routes:

- `#` — home (root folder)
- `#/folder/<id>` — folder view
- `#/file/<id>` — video detail

The router exposes a reactive `router.current` and a `navigate()` helper. `App.svelte` has a single `$effect` that derives `pathFolders` and `nodes` from `router.current + storage`, so refresh / direct URL entry / rename-then-back all converge on the same listing.

### Streaming

`src/lib/stream.ts` registers a Service Worker (`public/sw.js`) and assigns each play session a random ID. The Service Worker intercepts requests to `/__mega_stream/<sessionId>`, asks the page (via `postMessage`) for the requested byte range, and the page calls `node.download({ start, end })` and streams chunks back. This sidesteps the need to materialize the full encrypted blob and gives the `<video>` element first-class range support.

### File attributes (FA)

MEGA stores thumbnails / previews / media metadata in a separate channel encoded into a node's `fa` string. `src/lib/fileAttribute.ts` patches `megajs`'s `File.prototype.loadMetadata` to capture the `fa` field at load time, then decodes type 0 (thumbnail) by:

1. Parsing the `type*hash` entries
2. Calling MEGA's `ufa` endpoint to get a POST URL
3. POSTing the handle bytes
4. AES-CBC decrypting with a synthetic PKCS7 trailer trick (MEGA uses zero-padding; Web Crypto wants PKCS7)
5. Trimming trailing JPEG padding to the `FFD9` end-of-image marker

### Memos & rename

Memos use `MutableFile.setAttributes({ _memo: value })` — the underscore prefix is the MEGA convention for app-specific custom keys. Rename uses `MutableFile.rename()`. Both are encrypted with the node key.

### Uploads

`src/lib/upload.svelte.ts` runs a simple queue with a concurrency cap of 3. Each job reads the browser `File` via `file.stream().getReader()` and writes chunks into the `megajs` `Writable` returned by `folder.upload(...)`, awaiting the `drain` event when `write()` returns false. Job state is exposed as a reactive store and rendered by `UploadPanel.svelte`. Completion triggers MEGA's `add` event on `Storage`, which `App.svelte` listens for to refresh the current folder.

## Project layout

```
src/
  App.svelte              — root component, route → folder/file resolution
  lib/
    router.svelte.ts      — hash router with reactive state
    mega.ts               — MegaService: listChildren, isVideo, setMemo, renameFile
    session.ts            — login / persist / restore
    stream.ts             — Service Worker streaming bridge
    thumbnails.ts         — lazy thumbnail loader with cache
    fileAttribute.ts      — FA decoder
    upload.svelte.ts      — upload queue & job store
    components/
      Navbar.svelte
      Breadcrumb.svelte
      QuotaInfo.svelte
      FileCard.svelte     — grid card with inline rename & memo
      VideoView.svelte    — detail page
      UploadPanel.svelte  — floating upload progress panel
      LoginScreen.svelte
public/
  sw.js                   — Service Worker for ranged streaming
```

## License

Personal project — no license declared. Use at your own discretion.
