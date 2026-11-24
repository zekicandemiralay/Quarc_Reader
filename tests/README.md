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
| `find` | Ctrl+F: the bar replaces the dock and takes focus; hits across the book are counted and drawn (current one outlined, in the clear part of the screen); Enter / Shift+Enter / F3 step and wrap; case, a phrase over a line break, the accent switch; "no matches"; Escape; book mode; a hit 250 pages away in a 300-page book and all 300 hits counted |
| `mime` | The production build served like an older nginx (`.mjs` as a generic download): no asset keeps the `.mjs` name, and adding and reading a PDF still works — the PDF engine's worker loads |
| `errors` | A synced document read from the server (this device keeps no copy) that will not open says **why**: an expired sign-in (401, "Sign in again"), a damaged copy kept on the device (dropped by itself, the server's copy opens), a file the server no longer has (404, "Try again"); each with the technical detail |
| `awake` | The screen is kept on while a document is open (a recording stand-in for the Screen Wake Lock API): asked for on opening, let go on leaving, not held in the library, asked for again when a hidden page is shown, and off when the Settings switch is off |
| `dock` | The eraser is a dock button (on, erases as a stored deletion, off → back to the pen) and not in the Tools flyout; the colour list: recent colours newest first, a typed hex code, dragging in the square, the hue slider (one history entry however many key presses), a wrong code ignored, picking from the history, the pen drawing in the typed colour, the history surviving a reload, the highlighter's own history |
| `snip` | The Snip tool: drag a region (outside dimmed), Ctrl+C puts a sharp picture of it on the clipboard (the page, my ink only when "Ink" is on), "Copy text", "Save image" (a PNG named after the document and page), resize by a handle, move, click / press on the desk clears, Esc; Ctrl+V pastes a picture (at the region's size, stored with its file) and text, and switches to the select tool |
| `pen` | Stylus pressure is stored; a finger scrolls by default (the stylus does not change that); the eraser button erases (as a stored deletion); a finger drag draws nothing until the Finger button is pressed, and the next opening of the document has it closed again |
| `tools` | Hold-to-snap makes a clean line; Excalidraw's rectangle and text tools work on the page; the cut selection cuts a stroke into pieces; the saved PDF has vector paths and the typed text drawn as an image |
| `undo` | One undo/redo timeline for everything: a stroke, a snap-to-text highlight, an inserted note page, a bookmark and a stroke on the note page are undone newest first (each leaving a stored tombstone, so it syncs) and redone in order; dock buttons and Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y; a new action ends the redo list; one swipe of the stylus eraser over a stroke and a highlight is one step, the dock eraser is a step; a deleted note page comes back with its ink; a note page inserted above a stroke is not a step of that stroke |
| `links` | Links inside a PDF (a test file with three on page 1): hovering outlines a link; a tap on a web link opens its address and leaves no pen dot; dragging over it draws instead; a `javascript:` link is not followed; a tap on a jump goes to page 3 with a Back button that returns; taps also work in the select-text mode and with the highlighter, not with the eraser |
| `library` | Duplicates, "remember my choice", search, favorites, rename, trash/restore/delete forever, turning sync on later for a document that already has ink |
| `big` | A 300-page book opens fast, far jumps render, memory stays bounded |

Screenshots of key moments are written next to the results — look at them when something fails.
