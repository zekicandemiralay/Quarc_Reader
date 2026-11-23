// Keeps the screen on while a document is being read: a page can take minutes to read, and a screen that dims or locks
// meanwhile is a nuisance.
//
//   Android (the app)  the window flag FLAG_KEEP_SCREEN_ON, through our KeepAwake plugin (KeepAwakePlugin.java) — that is
//                      reliable in a WebView, which the web API below is not always
//   everywhere else    the Screen Wake Lock API (Chrome, Edge, Safari 16.4+, Firefox 126+; the desktop app's webview). The
//                      browser drops the lock whenever the page is hidden (another tab, a minimised window), so it is asked
//                      for again each time the page becomes visible.
//
// Counted: several callers can ask at once and the screen is let go when the last one lets go. Never throws — a browser
// that refuses (battery saver, an old version) simply leaves the system's own screen timeout in charge.

let holders = 0;
let sentinel = null;
let requesting = false;
let listening = false;

const env = () => globalThis;
const androidPlugin = () => {
  const cap = env().window?.Capacitor;
  return cap?.isNativePlatform?.() ? cap.Plugins?.KeepAwake ?? null : null;
};

async function requestWebLock() {
  const nav = env().navigator;
  const doc = env().document;
  if (!holders || sentinel || requesting || !nav?.wakeLock?.request) return;
  if (doc?.visibilityState && doc.visibilityState !== 'visible') return;
  requesting = true;
  try {
    const lock = await nav.wakeLock.request('screen');
    if (!holders) {
      // Everyone let go while the request was on its way.
      Promise.resolve(lock.release?.()).catch(() => {});
      return;
    }
    sentinel = lock;
    lock.addEventListener?.('release', () => {
      if (sentinel === lock) sentinel = null;
    });
  } catch {
    /* refused: asked again the next time the page is shown */
  } finally {
    requesting = false;
  }
}

function onVisibilityChange() {
  if (env().document?.visibilityState !== 'visible') return;
  // The browser let the lock go when the page was hidden: normally with a 'release' event, but the lock's own
  // `released` flag is the truth if an event was missed.
  if (sentinel?.released) sentinel = null;
  requestWebLock();
}

// Asks for the screen to stay on. Returns the function that lets go (safe to call twice).
export function keepAwake() {
  holders++;
  if (holders === 1) {
    const android = androidPlugin();
    if (android) {
      Promise.resolve()
        .then(() => android.enable())
        .catch(() => requestWebLock()); // an older build without the plugin method: try the web API
    } else {
      requestWebLock();
    }
    if (!listening && env().document?.addEventListener) {
      env().document.addEventListener('visibilitychange', onVisibilityChange);
      listening = true;
    }
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    holders = Math.max(0, holders - 1);
    if (holders > 0) return;
    Promise.resolve()
      .then(() => androidPlugin()?.disable())
      .catch(() => {});
    const lock = sentinel;
    sentinel = null;
    if (lock) Promise.resolve(lock.release?.()).catch(() => {});
  };
}
