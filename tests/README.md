# Browser tests

End-to-end tests that drive the **real thing**: the real backend (temporary data folder), a stand-in for quarc-auth
(`fake-auth.mjs`: any username signs in, same JWT cookie), the **production build** of the frontend served by `vite preview`
(which proxies `/api` like nginx does), and headless Chrome/Edge via `puppeteer-core`.

```bash
cd frontend && npm install && npm run build     # the tests run against dist/
cd ../backend && npm install
cd ../tests  && npm install
npm test                                        # everything
node e2e.mjs reading                            # one scenario
E2E_OUT=./out npm test                          # where screenshots go (default: the OS temp dir)
CHROME_PATH=/path/to/chrome npm test            # if Chrome/Edge isn't found automatically
```

They use ports **39902 / 39908 / 44173** (override with `E2E_AUTH_PORT`, `E2E_BACKEND_PORT`, `E2E_WEB_PORT`) so they never
collide with — or kill — a developer's own quarc-auth/dev servers. A test PDF with known text is generated with `pdf-lib`.

The app asks scroll-or-book on every opening and defaults to sepia paper, so `lightMode(page)` also injects test defaults
(`readMode: 'scroll'`, `paperMode: 'white'`, via `testDefaults`) that only fill settings the page does not have yet. Only the
`style` scenario runs with `lightMode(page, { defaults: false })`.

| Scenario | What it proves |
|---|---|
| `local` | The add-a-PDF question; metadata/thumbnail; the PDF is really drawn; pen ink is stored **page-locally**, survives a reload, lands on the right page; **a local-only document makes no push/file/share request** |
| `cloud` | Verified chunked upload; a second device receives library + ink; the PDF is read in byte ranges (a fraction of a 6 MB file for page 1); live merge of strokes between devices; "Stop syncing" |
| `marks` | Text selection → highlight; tap to add a note; the notes panel; the pencil highlighter snapping to whole words (and staying ink over blank paper) |
| `export` | Note pages; the downloaded PDF has real highlight/note annotations (Turkish letters intact) and real pages; Replace in library; Revert |
| `share` | Links for an anonymous (cookie-less) reader, with/without annotations, read-only, import into another account, revoking |
| `reading` | Scroll mode keys/wheel; book mode via arrow keys, **finger swipes** and edge taps; the position is restored on reopening (the style is asked each time, not stored with the document) |
| `style` | The **real defaults**: "scroll or book?" before every opening, nothing drawn until you choose; sepia paper out of the box; "remember my choice" stores it, and with it the document opens straight away; Settings → Reading style → "Ask me" brings the question back |
| `openwith` | A PDF handed to the app from outside: the desktop hand-off (cold start while signed out, while reading, a duplicate, an unreadable path), the installed PWA's file handler, the share target through the real service worker, and the web half of Android's plugin (against a stand-in). The native halves are not run here (see CLAUDE.md for how the desktop binary was driven for real) |
| `pen` | Stylus pressure is stored; the first stylus contact makes fingers scroll; the eraser button erases (as a stored deletion) |
| `tools` | Hold-to-snap makes a clean line; Excalidraw's rectangle and text tools work on the page; the cut selection cuts a stroke into pieces; the saved PDF has vector paths and the typed text drawn as an image |
| `library` | Duplicates, "remember my choice", search, favorites, rename, trash/restore/delete forever, turning sync on later for a document that already has ink |
| `big` | A 300-page book opens fast, far jumps render, memory stays bounded |

Screenshots of key moments are written next to the results — look at them when something fails.
