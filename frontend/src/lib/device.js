// What a document opens with in the dock: the hand (moves the page) or the pen (writes).
//
// A mouse moves a page by dragging and writes only when asked to; a finger or a stylus on a screen has no other way to
// point, so there the pen starts in hand (and the finger scrolls: see `fingerMode`). The setting `startTool` can force either.

// 'hand' | 'freedraw': the Excalidraw tool a reading starts with.
//   setting      'auto' | 'pen' | 'hand'  (Settings → Handwriting)
//   platform     'android' | 'desktop' | 'web' (lib/updateCheck.getPlatform)
//   finePointer  the primary pointer is precise: a mouse or a trackpad (matchMedia '(pointer: fine)')
export function startToolFor({ setting = 'auto', platform = 'web', finePointer = false } = {}) {
  if (setting === 'pen') return 'freedraw';
  if (setting === 'hand') return 'hand';
  if (platform === 'android') return 'freedraw';
  if (platform === 'desktop') return 'hand';
  return finePointer ? 'hand' : 'freedraw';
}

// Is this a screen driven by a mouse (the desktop app, or a browser on a computer)? The dock then has a Hand button.
export function isMouseDevice(platform, finePointer) {
  return platform === 'desktop' || (platform !== 'android' && finePointer);
}

export function finePointerNow() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches;
}
