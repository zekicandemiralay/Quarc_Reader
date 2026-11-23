# Quarc Reader

A self-hosted PDF reader made for **reading with a pencil**: paper-like pages, the full Quarc Notes drawing engine on top of
every page, real text highlights and notes, and a library that follows you across devices — or stays on one, your choice
per document. It uses the **same login as every other Quarc app** and runs on the web, Android, Windows/macOS/Linux and
iOS (as a PWA).

**Features**
- **A proper PDF reader** — continuous **scroll** mode and **book** mode (one whole page at a time: swipe, tap the edges, arrow keys),
  pinch/double-tap zoom, jump to any page, reading position remembered per document, bookmarks, light / sepia / dark paper
- **Write on the pages** — the Quarc Notes engine: pressure-sensitive pen, highlighter, hold-to-snap shapes, stylus eraser,
  MS-Paint-style cut selection, every Excalidraw tool (shapes, arrows, text, images), palm rejection, undo/redo
- **Real text highlights** — select text (or just swipe the highlighter over it: it **snaps to the words**) and it becomes a
  highlight / underline / strike-through with an optional note; listed in a notes panel; tap one to edit it
- **Note pages** — insert a blank, lined, squared or dotted page anywhere in a PDF and write on it
- **Save the PDF with your notes in it** — ink as sharp vector lines, highlights as real PDF highlight annotations that other readers show, note pages as real pages. Save a copy, or replace the document in your library (the original is kept and
  can be restored)
- **Your choice per document: local or synced.** Adding a PDF asks whether it stays **on this device only** (never uploaded,
  never synced) or **syncs to your server** (file, highlights, ink, bookmarks, reading position, on every device). Change it any
  time; "stop syncing" removes the server copy and keeps everything on the device
- **Offline-first sync** — everything works offline and syncs when back online; two devices drawing on the same page both keep
  every stroke. Big files go up in resumable 8 MB chunks (verified by SHA-256) and are read from the server in byte ranges
- **Share links** — send a link over Tailscale: anyone who can reach your server can read the document (no account, read-only),
  with or without your annotations, with an optional expiry, revocable any time. A Quarc user can add it to their own library
- English and Türkçe, light / dark / system theme, Android APK, Windows/macOS/Linux desktop apps, and a PWA

---

## Part 1 — Server Setup

For the person who owns and runs the server.

### Requirements

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- A machine that stays on, running [Tailscale](https://tailscale.com) with HTTPS Certificates enabled
- The shared `quarc-auth` login service running (it lives in the Quarc Store repo, in `auth/`)
- Disk space for the PDFs people upload (they are stored once per user, as files, in a Docker volume)

### Install

```bash
docker network create quarcnet-shared      # once per server, if not already done
git clone https://github.com/zekicandemiralay/Quarc_Reader.git
cd Quarc_Reader
cp .env.example .env                       # set JWT_SECRET = the SAME value as Quarc_Store/auth/.env
bash deploy.sh
bash check.sh
```

Open `https://quarcnet0.tail84500c.ts.net:4008` (Music 4000, Notes 4001, Weather 4002, Translate 4003, Cleaning 4004,
Calendar 4005, Store 4006, Sport 4007, **Reader 4008**) and log in with your existing Quarc account.

### Updating, backup, health

```bash
bash deploy.sh                 # git pull + rebuild (or: deploy.sh frontend|backend)
bash backup.sh                 # → ./backup_YYYYMMDD_HHMMSS/  (reader.db + files/ + .env)
bash backup.sh --no-files      # the database only (the PDFs are the big part — copy the volume yourself)
bash restore.sh <backup-dir>
bash check.sh                  # containers, HTTPS, login, database integrity, every PDF present on disk
```

The backup holds `.env` and every user's PDFs together — keep it private. Moving servers: see `../MIGRATION.md` (this app's
data is the `reader_data` volume; keep the same `JWT_SECRET`).

### Configuration

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | *(insecure default)* | Must equal `Quarc_Store/auth/.env`'s value exactly — it is what makes one login work everywhere |
| `SECURE_COOKIE` | `true` | Must match quarc-auth |
| `MAX_FILE_BYTES` | `2147483648` | Largest PDF one upload may be |
| `MAX_USER_BYTES` | *(unlimited)* | Optional cap on everything one account may store (bytes) |

Ports: public `4008`, backend `3008` (internal). Everything the app stores lives in one volume, `reader_data`: `reader.db`
and `files/<user>/<sha256>`.

---

## Part 2 — User setup

See **[README_Users.md](README_Users.md)**. Short version: have Tailscale connected, then open the URL, install the APK or the
desktop app from [Releases](https://github.com/zekicandemiralay/Quarc_Reader/releases/latest), or (iOS) Share → Add to Home Screen.

---

## Part 3 — How it works

```
backend/    Express + SQLite. documents, per-page annotations, files (content-addressed), share links
frontend/   React 18 + Vite + Tailwind + Dexie (IndexedDB) + zustand + i18next + Excalidraw + pdf.js + pdf-lib
desktop/    Tauri 2 wrapper (loads the server URL; native Save-as dialog)
mobile/     Capacitor 6 Android wrapper (bundles the web build; share sheet for Save PDF)
tests/      browser tests (real backend + production build + headless Chrome)
```

**Storage model.** A document is a PDF plus what was added to it. Ink, highlights and notes are stored **per page** in
page-local coordinates (page key `p<index>` for a PDF page, `n<id>` for an inserted note page), so inserting pages or
changing the layout never moves anyone's ink, and sync sends only the pages that changed. The server never overwrites: ink
merges stroke by stroke, highlights/bookmarks/note pages merge by id, deletions are tombstones, and the device that read
last decides the reading position. A document set to *local only* never produces a single request.

### API

All under `/api/`; login is the cookie set by quarc-auth.

| Method | Endpoint | |
|---|---|---|
| GET | `/api/sync/pull?since=` | Documents, annotated pages and deletions changed since the cursor (paged) |
| POST | `/api/sync/push` | The device's queued changes (`kind: 'doc'` fields / `kind: 'ann'` page ink + marks) |
| GET | `/api/files/:sha256/status` | Does the server have this file, or how many bytes of it |
| PUT | `/api/files/:sha256?offset=&total=` | Upload one chunk; the file is kept only if its SHA-256 matches |
| GET | `/api/files/:sha256` | Download (Range requests) |
| GET | `/api/files/usage` | Bytes stored for you |
| POST / GET / DELETE | `/api/shares`, `/api/shares/:token` | Create / list / turn off share links |
| POST | `/api/shares/:token/import` | Add a shared document to your own library |
| GET | `/api/public/shares/:token` (`/file`) | What a link shows — **no login**, the token is the credential |

---

## Development

```bash
cd backend  && npm install && npm test                  # API: sync, merging, resumable uploads, ownership, share links
cd frontend && npm install && npm test                  # geometry, ink buckets, highlights, PDF export, translations
cd backend  && PORT=3908 JWT_SECRET=dev DATA_DIR=./data npm start
cd frontend && npm run dev                              # proxies /api/auth → :3902 (quarc-auth), /api → :3908
```

Browser tests (screenshots land in `$E2E_OUT`): `cd frontend && npm run build && cd ../tests && npm install && npm test` —
see [tests/README.md](tests/README.md).

### Releasing

Tag `vX.Y.Z` and push. `.github/workflows/desktop-release.yml` builds the Windows/macOS/Linux installers and the signed
Android APK (`Quarc-Reader-Android.apk`) and publishes a GitHub release; the apps check it for updates. Repository secrets:
`KEYSTORE_BASE64` (this app's own keystore, key alias `quarc-reader`) and `KEYSTORE_PASSWORD`. Keep the keystore safe —
Android only accepts updates signed with the same key.

### Logo

Master: `QuarcNet/logos/reader.svg` (+ `logos/adaptive/reader-*.svg`). `frontend/public/logo.png` (512 px),
`desktop/logo.png` and `mobile/resources/icon.png` (1024 px) are exports. To regenerate the platform icons:

```bash
cd desktop && npx tauri icon logo.png
cd ../mobile && npm run icons
```

### Adding it to Quarc Store

Not done here (it is a separate step): follow `Quarc_Store/sso-kit/README.md` (installs the SSO files, the `StoreLoginButton`,
the required-update gate), add the app to the Store catalog, and list it in `../MIGRATION.md`. The places the kit patches are
marked in `authStore.js`, `MainActivity.java`, `AndroidManifest.xml` and `updateCheck.js`.
