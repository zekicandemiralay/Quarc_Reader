// The system clipboard, for a picture or for text. Needs a secure context (https, localhost) and a user gesture;
// where the browser or WebView does not allow it, the promise rejects and the caller offers something else.

// `png` is a Blob or a promise of one: the write starts straight away (inside the key press or tap, which browsers
// insist on) and the picture can still be on its way.
export async function copyImageToClipboard(png) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Copying pictures is not available here');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

export async function copyTextToClipboard(text) {
  if (!navigator.clipboard?.writeText) throw new Error('Copying text is not available here');
  await navigator.clipboard.writeText(text);
}
