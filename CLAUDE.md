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
  Settings live in `localStorage` `quarc_reader_settings`; `settingsVersion` (3) resets old stored `readMode`/`paperMode`
  once (version < 2) and `fingerMode`/`penSeen` once (version < 3: the finger used to draw by default). `SharedView` never asks
  (local `mode` state; `'ask'` would be an invalid canvas mode). **A finger does not draw by default, and is closed again with every
  document that is opened:** the dock's Finger button is plain component state in `ReaderCanvas` (`fingerOn`, remounted per document
  by `key={doc.id}`), never stored; the setting `fingerMode` (`'scroll'` default | `'draw'`, Settings → Handwriting) only says how
  a reading *starts*. The old `'auto'` mode and `penSeen` are gone; palm rejection (`PALM_WINDOW_MS`) is what protects a hand
  resting next to a stylus when the finger is open. The harness stamps `settingsVersion: 3` — an older stamp would make the app
  drop the settings a test injects.
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
- **Find in text** (Ctrl/Cmd+F, F3 / Ctrl+G = next, Esc, plus a search button in the app bars): `reader/findText.js` is the pure part
  (`fold` = case + NFKD/NFKC + optional accent stripping + Turkish ı/İ + whitespace runs and soft hyphens, with a map back to the
  original index; page text = items joined with `\n` after `hasEOL`; `matchSegments`; hit numbering) and is unit-tested.
  `reader/findIndex.js` reads every page's text once (`getTextContent`, cached per accent setting) and `scanBook` counts hits,
  starting at the page being read so the first hit is known at once; `reader/useFind.js` is the controller (debounce, current
  hit, next/prev with wrap, "reveal when its page's text layer exists"); `FindBar.jsx` is the pill that replaces the tool dock
  while open. **Hits are drawn on the marks canvas** (`paper.js drawFinds`, violet, `finds` param of `drawMarks`) from
  rectangles that `TextLayerManager.findRects` measures on the page's own text-layer spans — so layers must exist
  (`textNeeded` includes `findOpen`) and a hit on a far page appears once the view has gone there. Counting (index) and showing
  (layer) fold the same text the same way, so "the 3rd hit on page 7" means the same thing in both; the index is never mapped to
  DOM offsets. Ctrl+F is caught on `window` in the capture phase (`stopImmediatePropagation`) — Excalidraw 0.18 has its own
  Ctrl+F canvas search that would otherwise open. Not done: words hyphenated over a line break, whole-word / regex, searching
  the whole library, turning a hit into a highlight. A synced document that was never downloaded is read in full by a search.
- **Screen stays on while reading** (`lib/keepAwake.js`, `lib/useKeepAwake.js`, `KeepAwakePlugin.java`; Settings → Reading → `keepAwake`,
  on by default): held while a document is open (Reader and shared view), not in the library, counted so several callers share
  one lock. Android uses the window flag `FLAG_KEEP_SCREEN_ON` through the plugin (the web API is not reliable in a WebView; a
  build without the plugin falls back to it); everywhere else the Screen Wake Lock API, which the browser drops when the page is
  hidden — it is requested again on `visibilitychange`, and the lock's `released` flag is checked as well as its `release` event.
- **Why a document would not open** (`lib/pdfError.js`, the Reader's error screen): pdf.js errors are classified — `signin`
  (401/403), `gone` (404), `server` (5xx), `network` (status 0), `offline`, `invalid`, `invalid-local`, `password` — each with its
  own message, the technical detail shown under it and `console.error`ed. A damaged *local* copy of a synced document is dropped
  automatically and the server's copy is opened; `cacheOffline` keeps a download only when its size (and, up to 150 MB, its
  SHA-256) matches the document's, so a cut-short download or an error page can never be stored as "the file".
- **Undo / redo is one timeline for everything** (`reader/history.js`, `inkDiff.js`, `marks.js` `markChanges`/`restoreMarks`; wired in
  `ReaderCanvas`: `editMarks`, `commitInkHistory`, `recordOp`). Ctrl/Cmd+Z, Ctrl+Shift+Z, Ctrl+Y (a window-capture `keydown`, skipped in
  text fields and dialogs), the dock buttons and the two-finger tap all go through it. **Excalidraw's own history is not used**: it only
  knows its drawing, has no hook for the host, and `relayout` has to clear it whenever a note page is inserted or deleted. A step is a
  `{undo(), redo()}` pair of closures (may be async; `History` runs them one after the other; one that throws is dropped).
  Where the steps come from: (1) **ink** — the scene is *watched*, not hooked: 250 ms after the last change (not while a pointer is down
  or an element is being dragged/edited) `diffScene` compares it with `inkLastRef` and the elements that differ are one step. Steps are
  kept **page-locally**, so one recorded before a note page was inserted above it still lands on its page; undo/redo are *forward*
  writes (version above anything seen; undoing a creation = a tombstone), so they sync like drawing does. Something that never lived
  (the pencil stroke that snapped to text) is not a step. `commitInkHistory(L)` takes the layout the **scene** is arranged in — the
  relayout effect passes `prev` (`layoutRef.current` is already the new one during that effect), otherwise everything below an inserted
  page looks "moved" and records a phantom step. Every place that rewrites the scene wholesale (`applyInk`, `applyRemote`, relayout)
  must re-baseline `inkLastRef` or its own change becomes a step. (2) **marks** (text highlights, underlines, notes, snap-to-text) — all
  changes go through `editMarks(edits, {coalesce})`; undo is `restoreMarks` = "make these marks what they were, *as of now*" (fresh `u`,
  an absent-before mark becomes a tombstone), never "put the old list back", because the merge keeps the newer `u`. Typing a note is one
  step (coalesced; recorded after a 700 ms pause, on close, or before the next action). (3) **document-level** things — note page
  inserted/deleted, bookmark toggled — are recorded by `Reader.jsx` with `canvasRef.current.recordOp({undo, redo})`; the closures re-read
  the doc from Dexie and tombstone/restore by id (`setNoteDeleted`, `setBookmarkDeleted`); a restored note page gets its ink back from
  `inkRef` in the relayout effect. (4) `history.batch(fn)` makes several records one step — the stylus eraser removes strokes *and*
  highlights in one swipe. Not undoable: reading position, settings, sync mode, Replace in library. The shared (read-only) view has none.
- **Links inside the PDF** (`reader/pdfLinks.js` pure + `LinkIndex`, `lib/openExternal.js`; wired in `ReaderCanvas`: `linksOn`, `linkAt`,
  `openLink`, `tapLink`, `updateLinkHover`): the page is canvas-drawn, so a link only works because we ask pdf.js for the page's
  `getAnnotations()` (once per page, for the pages on screen, from `syncPaper`; `LinkIndex.peek` answers synchronously so a tap never
  waits). Only `Link` annotations the reader can follow count: http/https/mailto (`safeUrl` — never `javascript:`/`file:`/`data:`),
  a destination (named or explicit; `destPageIndex` → layout page), or NextPage/PrevPage/FirstPage/LastPage; others are not links at
  all (so the pen draws on them). A **plain tap** opens one — `startStroke` remembers the link under the pointer-down in `d.tap` and the
  pointer-up drops the stroke (`cancelStroke`) when it moved ≤ `TAP_MOVE_TOLERANCE` within `LINK_TAP_MS`; a drag over the same words
  still draws. Same for a finger that scrolls (`handleTap`, before the book-mode edge turn), a shared link (read-only pan), and the
  text mode (`handleTextTap`, a highlight under the tap is opened first). Not with shapes/eraser/selection/snip (`linksOn`). Web links:
  Tauri `shell.open` or `window.open(_blank, noopener)`; an internal jump goes through `goToPage` and shows a toast with **Back**
  (restores the exact view in scroll mode). Mouse/pen hover outlines the link on the overlay canvas. Not done: the destination's
  scroll position inside the page (the page top is used), links in note pages (they have none), outline/bookmark panel. Android
  `window.open` and the Tauri `shell.open` path were not run on a device.
- **Dock: eraser and colours** (`reader/Toolbar.jsx`, `ColorPanel.jsx`, `ColorPicker.jsx`, `lib/color.js`): the eraser is a dock
  button (Excalidraw's own eraser tool; pressing it again goes back to the pen/highlighter in `settings.tool`) and is not in the
  Tools flyout any more. The preset swatches stay inline in the dock (tests click `button[aria-label="#e03131"]`); the last circle
  (`color-more`) opens the *recent colours* — `penColorHistory` / `hlColorHistory` in the settings, newest first, 12 at most, one list
  per tool, pushed by `changePen` / `changeHighlighter` — and an in-app picker (saturation/brightness square, hue slider, hex box,
  EyeDropper where the browser has it). The picker commits on pointer-up / Enter / (keys) 600 ms after the last one, never per
  pixel, or a drag or a held arrow key would flood the history; the hex box commits only what was typed (leaving it after a drag
  must not add the colour the drag happened to be at).
- **Snip** (dock button `tool-snip`; `openSnip()` for the shared view's header): drag a rectangle on a page, move/resize it by its
  handles, then copy it as a picture, save it, or copy the words in it. `reader/snip.js` is the pure part (rect/handle/drag maths,
  `outputScale`, `pastedPictureSize`), `snipRender.js` redraws the region from the document at full sharpness (pdf.js with a
  `transform` offset, `paintMark` multiplied over it, ink/shapes/text/pictures by Excalidraw's `exportToCanvas`; always the page's
  own white paper, ink in its own colours) and `SnipBar.jsx` replaces the dock while on. The dimming and handles are drawn on a
  canvas of their own (`snipCanvasRef`, z-index 4) — not the overlay canvas, which carries the dark-mode invert filter. Pointer
  routing follows the cut tool (`snipDrag`). Ctrl+C copies the picture (the clipboard write starts inside the key press with a
  *promise*: `ClipboardItem({ 'image/png': promise })`), Ctrl+S saves, Esc leaves; "copy text" is `TextLayerManager.textInRect`.
  Copying a picture needs a secure context; on Android the fallback is the share sheet.
- **Ctrl+V** is Excalidraw's own paste handler (pictures, text, copied elements), which only runs when the focus is inside
  `.excalidraw` and its last pointer position (a `document` `pointermove`) was over its canvas. A window-capture `paste` listener in
  `ReaderCanvas` makes both true (focus, plus a synthetic `pointermove` at the last real pointer or the middle). Afterwards the
  select tool is switched on, and a pasted picture is resized once decoded: Excalidraw first gives it a 100 px square placeholder
  and its `status` stays `'pending'` for ever in an embed (don't wait for `'saved'`); the picture last copied from a region comes
  back at the region's size, any other is limited to 60 % of the page width.
- **"Open with" / share target** (`lib/openWith.js`, started from `main.jsx`): every platform hands a PDF over differently and
  ends as plain `File`s in `store/incomingStore.js`; `App.jsx` (`IncomingFiles`) brings a signed-in user to `/` and `Library`
  takes the files like "Add PDF" (the local/sync question, then the reader) — except that **one PDF you already have is just
  opened** (`findDuplicate`), with no question. Signed out, the files wait in the store. Per platform:
  *Android* `OpenWithPlugin.java` (VIEW + SEND/SEND_MULTIPLE filters in the manifest) copies the content:// stream into
  `cache/incoming/<uuid>.pdf` off the main thread and fires `incoming`; JS calls `takePending()` (also once at start-up — the
  plugin is idempotent), reads the copy with `fetch(Capacitor.convertFileSrc(path))` and calls `discard()`.
  *Desktop* `main.rs`: Windows/Linux get the path as an argument (a second launch is forwarded by `tauri-plugin-single-instance`),
  macOS via `RunEvent::Opened`; each file is added to the fs plugin's **runtime scope** (`fs_scope().allow_file`) — the capability
  has `fs:allow-read-file` with no scope on purpose — and the page is told with `window.__quarcOpenFiles` + a `quarc-open-files`
  event (`eval`, held back until `on_page_load` Finished); the page reads it with `__TAURI__.fs.readFile`.
  *Installed PWA* `manifest.json` `file_handlers` → `launchQueue`, and `share_target` → `sw.js` keeps the POSTed file in the
  `quarc-reader-incoming` cache and redirects to `/?shared=1`. iOS can do none of this (no file handlers in a home-screen app).

## Gotchas found the hard way

- This folder is synced by **Proton Drive**: when a write races its sync it can leave `File (# Name clash <date> <id> #).ext`
  next to the real file and an edit can seem to vanish. After a batch of edits that "succeeded" but is not there, look for such a
  file, diff it against the real one, re-apply, delete it — and never `git add -A` with one present (it is not gitignored).
- **No asset may be named `.mjs`.** pdf.js' worker is a module script, which browsers refuse unless the server calls it JavaScript,
  and the nginx image on the owner's server did not know `.mjs` (it sent a generic download): every PDF then failed with "Setting up
  fake worker failed: error loading dynamically imported module …/pdf.worker.min-<hash>.mjs" — shown as "could not be opened" /
  "could not be read as a PDF". Vite served it right, so no test saw it. `vite.config.js` (`assetFileNames`) now emits it as
  `pdf.worker.min-<hash>.js`, `nginx.conf` has a `location ~* \.mjs$ { default_type text/javascript; }` as well, `sw.js` caches under
  `quarc-reader-v2` (the old cache could hold the wrong-type response for good — `/assets/` is cache-first), and
  `describeOpenError` reports this as `engine`. Browser scenario `mime` serves `dist/` like such a server (`.mjs` → octet-stream).
- Proton Drive can also rename a *build folder* mid-build: `frontend/dist/assets` became `assets (# Name clash … #)` and the
  test app then 404'd its main script (blank page, "no Username input"). Rebuild and check `ls frontend/dist/assets` before running the
  browser tests.
- Browser tests: the toasts stack at the bottom centre, *outside* the reader container, and swallow clicks there (a snip test
  clicked "on the page" and hit a toast). Click somewhere clear.

- Android "open with": `BridgeActivity.load()` already calls `onNewIntent(getIntent())`, so the plugin only needs
  `handleOnNewIntent` (not `load()`); ignore intents with `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY` (recents re-delivers the old
  launch intent) and mark handled ones, or a killed-and-restored app imports the same PDF again. A `file://` URI is refused when
  it points into the app's own data dir. `pathPattern` in the manifest is written `.*\\.pdf` (aapt turns it into `.*\.pdf`).
- Desktop "open with": Windows' installer registers the app as a `.pdf` handler (`fileAssociations`, `rank: Alternate` is only
  honoured on macOS); `RunEvent::Opened` and `#[cfg(target_os = "macos")]` code can't be compiled on Windows — put the `cfg`
  on a block, never on an `if let` statement. The window loads a remote origin, so anything native it may call must be in
  `capabilities/default.json` (`remote.urls`).

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
cd frontend && npm test                  # 184 unit tests (geometry, ink, marks, export, find, snip, colour, open errors, keep-awake, undo history + ink diff, pdf links, i18n, shapes; i18n lists run-time key families in DYNAMIC)
cd frontend && npm run build && cd ../tests && npm install && npm test   # browser tests (screenshots -> $E2E_OUT)
cd tests && node e2e.mjs reading         # one scenario: local cloud marks export share reading style openwith find mime errors awake dock snip pen tools undo links library big   (343 checks in all)
cd frontend && npm run dev               # proxies /api/auth -> :3902 (quarc-auth), /api -> :3908
```

The browser tests use ports 39902/39908/44173 (not 3902/3908/4173) so they never collide with a developer's own
services. Don't patch JS test files with shell/Python string replacement — escapes get mangled; edit directly.

## Not done / next

- EPUB (text highlights + typed notes via CFI); two-page spread in book mode (the page-local storage already allows a
  different layout); password-protected PDFs; page thumbnails/outline panel; find-in-text extras (see its bullet above); opening a PDF
  *link* (http/https) from a browser in the app (the "open with" intent filters only cover content/file URIs).
- Builds: the Android debug APK builds on the dev machine with Android Studio's JDK and SDK (`JAVA_HOME` =
  `C:\Program Files\Android\Android Studio\jbr`, `ANDROID_HOME` = `%LOCALAPPDATA%\Android\Sdk`, then
  `mobile\android\gradlew.bat assembleDebug`); the desktop app builds with `cargo build` (a debug build can be pointed at
  the local test server with the `TAURI_CONFIG` env var plus a temporary capability for that origin, and driven through
  WebView2's `--remote-debugging-port`). Release APK signing, macOS and Linux are only ever built by the release workflow.
  The Android intent handling and the macOS "open" event were not run on a device/Mac; the rest of the open-with path
  (desktop binary, PWA, the web half of Android) was.
