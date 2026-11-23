# Quarc Reader

A PDF reader with **pencil highlighting and note taking**, synced across devices through the Quarc server. Part of the
Quarc suite (see `../MIGRATION.md`); same conventions as Quarc Notes / Calendar: Express + SQLite backend, React + Vite +
Tailwind + Dexie + zustand + i18next (en/tr) frontend, nginx with the Tailscale cert, Capacitor Android, Tauri desktop,
the shared `quarc-auth` login (same `JWT_SECRET`). Ports: public **4008**, backend **3008**, dev backend **3908**.

Decisions made with the owner (don't re-litigate): PDF first, EPUB later (text highlights + notes only, no free ink);
a document is **local-only or synced, chosen per document and changeable later**; "Save PDF" keeps the original and
exports a copy, with an explicit **Replace in library** (original kept as `orig_sha256`, revertible); share links are
read-only for anyone who can reach the server, with a per-link choice of including annotations; note pages can be
inserted between PDF pages; **paper is sepia by default**, and **every opening asks scroll or book** (with a "remember my
choice" box; Settings → Reading → Reading style = Ask me / Scroll / Book is the default, and the View menu changes the
style for that reading only — it is not stored with the document). Adding the app to Quarc Store (SSO kit, catalog, `MIGRATION.md`) is the owner's own step —
leave `Quarc_Store` alone and leave the `// Store` hooks (authStore, MainActivity, manifest, updateCheck) as they are.

## Layout

```
backend/    Express + better-sqlite3. routes/{sync,files,shares}.js, services/{docStore,fileStore,merge}.js
frontend/   src/reader/*  the engine   src/lib/*  data layer   src/pages/*  screens   src/components/*  dialogs
desktop/    Tauri 2 (loads the server URL)        mobile/  Capacitor 6 Android (bundles the web build)
tests/      browser tests: real backend + production build + headless Chrome (tests/README.md)
```

## How it works (the parts that are easy to break)

- **Look and feel** (own identity, not Quarc Notes'): `tailwind.config.js` overrides `neutral` with a warm paper → aubergine
  scale (so the Store-kit components, which use `neutral-*`, restyle too), `accent` is the logo's violet, plus `surface`,
  `sepia`, a system-serif `font-serif` for titles, and `shadow-cover/float/soft`. The reader's chrome is `reader/Toolbar.jsx`
  (floating dock; Excalidraw's own toolbar/menus/footer are hidden by CSS in `ReaderCanvas`) and `reader/PageBar.jsx`
  (page counter + go-to slider + zoom); `INSETS` in `geometry.js` keeps pages clear of both. Library = "continue reading"
  hero + book-cover cards (generated cloth covers when there is no thumbnail).
- **Reading style prompt:** `Reader.jsx` keeps a per-opening `sessionMode` (keyed by route id); `mode = sessionMode ??
  (readMode === 'ask' ? null : readMode)` and `ReaderCanvas` is not mounted until there is a mode (`ReadingStyleDialog`).
  Settings live in `localStorage` `quarc_reader_settings`; `settingsVersion` (2) resets old stored `readMode`/`paperMode`
  once. `SharedView` never asks (local `mode` state; `'ask'` would be an invalid canvas mode).
- **The reader is canvas-based.** Pages stack vertically in Excalidraw's scene coordinates (96 dpi px; a PDF point is
  4/3 px). Layers: paper canvas (PDF bitmaps) → marks canvas (highlights) → Excalidraw (ink) → overlay canvas (live stroke)
  → DOM text layers (selection, only when needed). `reader/geometry.js` is the pure layout/view math.
- **Ink is stored per page in page-local coordinates** (`reader/inkBuckets.js`): `x,y` relative to the page's own
  top-left, under page key `p<index>` (PDF page) or `n<id>` (inserted note page). The stack layout is only how pages are
  *shown*; inserting a page re-lays-out the scene (`relayout`) without touching stored ink. Versions are never changed by
  translation — merging relies on that.
- **Sync = Quarc Notes' protocol, finer grained.** Outbox entries `d:<docId>` (fields that changed) and
  `a:<docId>:<pageKey>` (one annotated page; content read from the `ann` row when pushing). The server merges, never
  overwrites: ink by Excalidraw `version`/`versionNonce`, marks/bookmarks/note pages by id + `u` timestamp with tombstones
  (`merge.js`, mirrored in `reader/marks.js`). **Deleting must be a tombstone** (`isDeleted` + bumped version, `del: true`) —
  an empty list does not propagate (see `library.clearedPage`). Reading position: the device that read last wins.
- **A `sync: 'local'` document must never produce an outbox entry or a request** (privacy guarantee, covered by a
  browser test). Every write path goes through `library.js`, which checks `doc.sync`.
- **PDF bytes** are content-addressed per user on the server (`files/<user>/<sha256>`), uploaded in 8 MB resumable chunks
  with hash verification, served with Range requests. From the server pdf.js is opened with `disableAutoFetch` +
  `disableStream` so only needed ranges are fetched; keeping a copy offline is an explicit/`autoCache` step.
- **Export** (`reader/exportPdf.js`, pure + unit-tested): ink/shapes → vector paths (same perfect-freehand outline as
  Excalidraw), text/images → Excalidraw rasterised PNG (injected), text marks → real `/Highlight|/Underline|/StrikeOut`
  annotations (+ `/Text` for notes), note pages → real pages with their ruling. Coordinates go through pdf.js'
  `viewport.convertToPdfPoint` so rotated/cropped pages work.

## Gotchas found the hard way

- Excalidraw's UI (main menu, Library, help) is hidden with CSS in `ReaderCanvas`; `clearCanvas` is disabled (it would wipe
  every page). Keyboard keys typed while no input has focus go to the page — **Space = page down**.
- Pointer routing happens in the capture phase *before* Excalidraw. The "is this the drawing surface?" test must be
  "inside the reader and not on interactive UI", **not** "target is a canvas": in book mode the ink canvases are
  `clip-path`-ed to the current page, so margin touches land on other elements.
- Text selection moves focus: the note field in `SelectionBar` collapses the document selection, so the captured selection
  is kept while the bar's field has focus.
- React events bubble through portals to the React parent: a menu rendered in a portal inside a clickable card needs
  `stopPropagation` at the card's menu wrapper (Library `DocCard`).
- Excalidraw also renders an empty `[role=dialog]`; target this app's modals via `div[class*="z-[1100]"] [role=dialog]`.
- Book mode shows one page only: paper/marks are drawn for `bookPageRef` alone and Excalidraw's canvases are clipped.
- Dark mode is a CSS invert filter on the paper canvas (and the ink preview) — everything in `paper.js` is drawn in light colours.
- The reader re-applies its opening view every frame for 800 ms (Excalidraw restores its own state asynchronously). Every
  navigation path (`goToPage`, `scrollByScreen`, wheel, pointer) must call `stopInitialView()` or it is silently overridden.
- Test harness: `dumpDb` must never *create* the app's IndexedDB (a plain `open()` of a missing DB makes an empty v1 one that
  blocks the app's own upgrade) and must close its connection.
- Test harness: because every opening asks scroll/book and paper defaults to sepia, `lightMode(page)` injects
  `readMode: 'scroll'` / `paperMode: 'white'` (`testDefaults`, fills only missing keys); only scenario `style` uses the real
  defaults. Tests find library cards by `.cursor-pointer` / `div.group` with a `button[aria-label="More"]`, titles by
  `main p.line-clamp-2`, tabs by `nav button` — the "continue reading" hero is a `role=button` without those classes on purpose.
- A flex container that centres its child (`items-center`) cannot scroll to the child's overflowing top: use `m-auto` on the
  child (see `ReadingStyleDialog`). Floating panels (`useFloatingPosition`) stay below the tool dock (`DOCK_CLEAR`).
- pdf.js is the 4.10 **legacy** build (older Android WebViews); its cMaps/standard fonts are copied to `public/pdfjs/` by
  `scripts/copy-pdfjs-assets.mjs` (prebuild/predev) and are gitignored.

## Commands

```bash
cd backend  && npm test                  # 27 API tests (temp SQLite + data dir)
cd frontend && npm test                  # 98 unit tests (geometry, ink, marks, export, i18n, shapes; i18n lists run-time key families in DYNAMIC)
cd frontend && npm run build && cd ../tests && npm install && npm test   # browser tests (screenshots -> $E2E_OUT)
cd tests && node e2e.mjs reading         # one scenario: local cloud marks export share reading style pen tools library big   (161 checks in all)
cd frontend && npm run dev               # proxies /api/auth -> :3902 (quarc-auth), /api -> :3908
```

The browser tests use ports 39902/39908/44173 (not 3902/3908/4173) so they never collide with a developer's own
services. Don't patch JS test files with shell/Python string replacement — escapes get mangled; edit directly.

## Not done / next

- EPUB (text highlights + typed notes via CFI); two-page spread in book mode (the page-local storage already allows a
  different layout); text search inside a PDF; password-protected PDFs; opening a PDF from Android's file manager
  (VIEW/SEND intent); page thumbnails/outline panel.
- Android/desktop builds are set up (`mobile/`, `desktop/`, `.github/workflows`) but were not built on the dev machine
  (no JDK/Android SDK; Tauri was only `cargo check`-ed) — the first tagged release is the first real build.
