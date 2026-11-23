# Building the Quarc Reader desktop app

The desktop app is a [Tauri 2](https://tauri.app) window that loads the Quarc Reader
server (`https://quarcnet0.tail84500c.ts.net:4008`). Everything — the library, the
offline cache, the pencil tools — is the same web app; the desktop shell adds a native
"Save as" dialog for **Save PDF** and an installer.

## Prerequisites (one-time setup)

1. **Rust** — https://rustup.rs (restart your terminal afterwards)
2. **Node.js** — https://nodejs.org (v18 or newer)
3. **WebView2** — already installed on Windows 10/11
   (https://developer.microsoft.com/en-us/microsoft-edge/webview2/ if missing)

## Icons

`logo.png` (1024 px) is an export of the master `QuarcNet/logos/reader.svg`. After changing it:

```
cd desktop
npx tauri icon logo.png
```

## Build the installer

```
cd desktop
npm install
npm run build
```

The installer is written to `src-tauri/target/release/bundle/nsis/Quarc Reader_1.0.0_x64-setup.exe`.
Pushing a `vX.Y.Z` tag builds the Windows, macOS and Linux installers (and the Android APK)
in GitHub Actions — see `.github/workflows/desktop-release.yml`.

## Capabilities

The window shows a remote origin, so `src-tauri/capabilities/default.json` lists it under
`remote.urls`; the dialog and fs plugins are allowed only to save the file the person picks
in the "Save as" dialog. If the server address ever changes, change it in
`tauri.conf.json` **and** in that capability.

## Certificate requirement

Users must install and trust the server certificate **before** opening the app, exactly as
described in Quarc Music's `README_Users.md` (Windows section) — the same Tailscale cert
covers every Quarc app on this host. The desktop app uses WebView2, which reads from the
Windows certificate store, so installing the cert for Edge/Chrome is sufficient.
