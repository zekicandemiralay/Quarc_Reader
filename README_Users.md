# Quarc Reader — User Guide

Read PDFs, highlight them, write in the margins with a pencil, and keep it all in step across your devices — or keep a
document just on one.

## Getting started

You need [Tailscale](https://tailscale.com) installed and connected. Then:

- **Android:** install the APK from [Releases](https://github.com/zekicandemiralay/Quarc_Reader/releases/latest)
- **Windows / macOS / Linux:** install the desktop app from Releases
- **iOS:** open `https://quarcnet0.tail84500c.ts.net:4008` in Safari → Share → **Add to Home Screen**
- **Anything else:** just open that address in a browser

Sign in with the same username and password as Quarc Music — it is the same account.

## Adding PDFs

Tap **Add PDF** (or drop files on the library). For every PDF you choose where it lives:

| | Keep on this device only | Sync with my server |
|---|---|---|
| Where the file is | Only on this device | On your server, and on any device you open it on |
| Highlights, notes, drawings | Only here | On all your devices |
| Reading position, bookmarks | Only here | On all your devices |
| Share links | Not possible | Yes |
| Works offline | Always | Yes, once downloaded to the device |

Tick **Remember my choice** to stop being asked (change it in Settings → Library and sync). You can change any single
document later: card menu **⋮ → Sync with my server…** or **Stop syncing (keep on this device)…**. Stopping removes the
document from the server and from your other devices; this device keeps the file and everything you wrote.

## Opening a PDF from another app

You don't have to start in Quarc Reader. A PDF you open this way is added to your library exactly like **Add PDF** (you are asked
whether it stays on this device or syncs, unless you ticked "Remember my choice"), then it opens. A PDF you already have just
opens, where you left off.

- **Android:** in a file manager, a mail app, Drive or a download notification, tap the PDF and choose **Quarc Reader** (tap
  **Always** to make it the default), or use **Share → Quarc Reader** — one PDF or several at once.
- **Windows / macOS / Linux:** right-click a PDF → **Open with → Quarc Reader**, or drag it onto the app. If Quarc Reader is
  already open, the PDF opens in that window. (To make it your default PDF app, use your system's "Default apps" setting.)
- **Installed web app (Chrome, Edge):** once you have installed Quarc Reader from the browser, it is offered under **Open with**
  too; on Android, installed this way it also appears in the share sheet.
- **iOS:** not possible for a web app added to the Home Screen — use **Add PDF** inside the app.
- A PDF *link* in a browser is not handled yet: download it first, then open it from the downloads.

## Reading

- **Scroll or book?** Every time you open a document the reader asks how you want to read it. **Scroll** — the pages run
  down the screen. **Book** — one whole page at a time; swipe, tap the left/right edge, or use the arrow keys / Page Up /
  Page Down. Tick **Remember my choice** to stop being asked; change or undo that in **Settings → Reading → Reading style**
  (*Ask me / Scroll / Book*). The **View** menu (top right) switches style for the current reading only.
- **Paper** is sepia by default. Pick white, dark, or "follow theme" as the default in **Settings → Reading → Paper**; the
  **View** menu changes it for one document.
- Double-tap fits the page (and, on a fitted page, zooms to its width); pinch to zoom as far as you need for fine handwriting.
- **Snip part of a page:** tap the **crop** button on the toolbar, then drag a rectangle on a page. The rest of the page dims; drag the
  handles to resize the rectangle or drag inside it to move it. **Copy image** (or **Ctrl+C**) puts a sharp picture of that part
  on the clipboard, **Save image** saves a PNG (on Android it opens the share sheet), **Copy text** copies the words in the
  rectangle. The picture is the page as it is printed; switch **Ink** off to leave out your own drawings and highlights. Press
  **Esc** or the cross to leave.
- **Paste:** **Ctrl+V** puts a picture or text from the clipboard onto the page — a snip you just copied (at the size you selected),
  a screenshot, text from another program — selected, so you can drag it where you want it.
- **Find a word:** press **Ctrl+F** (**Cmd+F** on a Mac) or tap the **search** button at the top. Type, and every place the word
  occurs in the whole document is marked; **Enter** / the arrows go to the next one (**Shift+Enter** back), **Esc** closes. The
  counter ("3 of 17") fills in as the document is searched. Capital letters never matter, and accents don't either unless you
  switch **á** on ("cay" then no longer finds "çay"). A scanned PDF has no text to search. In a document that lives only on
  your server, searching reads all of it once.
- Your place is remembered, and follows you to your other devices for synced documents.
- **Bookmark** this page with the ribbon icon; the list icon shows your bookmarks, highlights and notes.
- Tap the corner button in the page counter to hide the toolbars while you read.

## Writing and highlighting

The floating dock at the top of the page has **Pen**, **Highlighter**, **Eraser**, **Select text** and **Snip**, with colours and
sizes, undo/redo and the **Finger** switch. The **Tools** button next to it opens everything else (shapes, arrows, text,
image…) plus the **cut selection** tools; the slider icon has **Snap shapes** and **Snap to text**. The bar at the bottom turns
pages, jumps to any page (tap the counter) and zooms.

- **Eraser:** the rubber on the dock; drag across a stroke to erase it, press it again to go back to the pen.
- **Colours:** the dots are the ready-made colours. The last, rainbow-coloured dot opens **recent colours** (the ones you used
  lately, newest first — the pen and the highlighter each have their own) and a **colour picker**: drag in the square, slide the
  hue, type or paste a code like `#12ab34`, or pick a colour from anywhere on the screen with the pipette (where your
  browser has one).

- **Pencil / stylus:** pressure-sensitive. The first time a stylus touches the screen, fingers switch to scrolling so a
  resting hand never draws (switch it back with the **Finger** button). Hold the pen still at the end of a stroke to snap it
  to a clean line, circle, rectangle… The eraser end (or the barrel button) erases.
- **Highlighter:** swipe over text — with **Snap to text** on it becomes a real highlight of the whole words; over blank
  paper it stays freehand ink.
- **Select text:** long-press / drag over text, then pick a colour to highlight, underline, strike through, add a note, or copy.
  Tap a highlight any time to change it, write a note on it, or delete it.
- **Note pages:** **⋮ → Insert a note page here…** adds a blank, lined, squared or dotted page after the current one.

## Saving the PDF

**⋮ → Save PDF**

- **Save a copy** — a normal PDF with your ink (sharp vector lines), real highlights/notes and note pages. On Android it
  opens the share sheet (Save to Files, mail, Drive…); on the desktop a Save-as dialog; in a browser it downloads.
- **Replace the original in my library** — the document in your library becomes the annotated one. Your marks become part of
  the pages (no longer editable here); the previous version is kept, and **Revert to the original** brings it back.
  (This changes the copy inside Quarc Reader, not the file on your device that you imported from.)

## Sharing

For a synced document: **⋮ → Share…** → choose whether your highlights/notes/drawings are included and how long the link
lasts → **Create link and copy it**. Anyone on your Tailscale network who has the link can read it — no account needed, read
only. Turn a link off any time in the same dialog. A Quarc user who opens the link can press **Add to my library** to get
their own copy.

## Good to know

- A document kept on one device only is only on that device: back it up, and note that clearing the app's data deletes it.
  Settings → *Clear data on this device* warns you how many such documents you have.
- Password-protected PDFs are not supported yet.
- Library trash: moving to the trash is undoable; **Delete forever** is not.
