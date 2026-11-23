// "Open with Quarc Reader": every way a PDF can reach the app from outside ends up here as plain
// File objects, which are handed to the library exactly like files picked with "Add PDF".
//
//   Android (Capacitor)  the OpenWith plugin (OpenWithPlugin.java) copies what a file manager /
//                        mail app / the share sheet handed to the app into its cache and tells us;
//                        we read the copy back through the WebView's local file server
//   Desktop (Tauri)      the Rust side puts the paths of the files the app was started with (or
//                        that a second launch forwarded) in window.__quarcOpenFiles and fires
//                        'quarc-open-files'; the fs plugin reads them (only those files are allowed)
//   Installed PWA        Chromium's file handler (manifest `file_handlers` → launchQueue), and the
//                        share target (manifest `share_target` → sw.js keeps the file in a cache)
//
// Started once, from main.jsx. Nothing here knows about accounts: the files wait in useIncoming
// until someone is signed in and the library is on screen.

import i18n from '../i18n';
import useIncoming from '../store/incomingStore';
import { toast } from '../components/Toasts';

export const SHARED_CACHE = 'quarc-reader-incoming';

const baseName = (path) => String(path).split(/[\\/]/).pop() || 'document.pdf';

function deliver(files, failed = 0) {
  if (files.length) useIncoming.getState().push(files);
  if (failed) toast(i18n.t('library.openFailed', { count: failed }), { duration: 7000 });
}

// ----- Android ------------------------------------------------------------------------------

const androidPlugin = () => (window?.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins?.OpenWith ?? null : null);

async function pullAndroid() {
  const plugin = androidPlugin();
  if (!plugin) return;
  let waiting;
  try {
    waiting = await plugin.takePending();
  } catch {
    return;
  }
  const entries = waiting?.files || [];
  const files = [];
  let failed = waiting?.failed || 0;
  for (const entry of entries) {
    try {
      const res = await fetch(window.Capacitor.convertFileSrc(entry.path));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      files.push(new File([await res.blob()], entry.name || 'document.pdf', { type: 'application/pdf' }));
    } catch {
      failed++;
    }
  }
  // They are in memory now; the copies in the app's cache are no longer needed.
  if (entries.length) Promise.resolve(plugin.discard({ paths: entries.map((e) => e.path) })).catch(() => {});
  deliver(files, failed);
}

// ----- Desktop (Tauri) ----------------------------------------------------------------------

async function pullTauri() {
  const paths = window.__quarcOpenFiles;
  window.__quarcOpenFiles = [];
  if (!paths?.length) return;
  const read = window.__TAURI__?.fs?.readFile;
  const files = [];
  let failed = 0;
  for (const path of paths) {
    try {
      if (!read) throw new Error('no file access');
      files.push(new File([await read(path)], baseName(path), { type: 'application/pdf' }));
    } catch {
      failed++;
    }
  }
  deliver(files, failed);
}

// ----- Installed PWA ------------------------------------------------------------------------

async function pullLaunchQueue(params) {
  const handles = params?.files || [];
  const files = [];
  let failed = 0;
  for (const handle of handles) {
    try {
      files.push(await handle.getFile());
    } catch {
      failed++;
    }
  }
  deliver(files, failed);
}

// The service worker keeps what the share sheet sent (POST /share-target) until the app is open.
async function pullShared() {
  if (!('caches' in window) || !(await caches.has(SHARED_CACHE))) return;
  const cache = await caches.open(SHARED_CACHE);
  const files = [];
  let failed = 0;
  for (const request of await cache.keys()) {
    try {
      const res = await cache.match(request);
      const name = decodeURIComponent(res.headers.get('X-File-Name') || '') || 'document.pdf';
      files.push(new File([await res.blob()], name, { type: 'application/pdf' }));
    } catch {
      failed++;
    }
    await cache.delete(request);
  }
  if (new URLSearchParams(location.search).has('shared')) history.replaceState(history.state, '', location.pathname);
  deliver(files, failed);
}

// ----------------------------------------------------------------------------------------------

let started = false;

export function startOpenWith() {
  if (started) return;
  started = true;

  const android = androidPlugin();
  if (android) {
    android.addListener('incoming', pullAndroid);
    pullAndroid();
  }

  window.addEventListener('quarc-open-files', pullTauri);
  pullTauri();

  window.launchQueue?.setConsumer?.(pullLaunchQueue);
  pullShared().catch(() => {});
}
