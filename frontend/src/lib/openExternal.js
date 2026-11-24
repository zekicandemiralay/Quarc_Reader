// Opens a web or mail address outside the app: the system browser (desktop: through the Tauri shell plugin, which the
// capability `shell:allow-open` allows; Android and the web: a new tab / the system's handler).
export function openExternal(url) {
  try {
    if (window.__TAURI__?.shell?.open) {
      window.__TAURI__.shell.open(url);
      return;
    }
  } catch {
    /* fall through to the browser way */
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
