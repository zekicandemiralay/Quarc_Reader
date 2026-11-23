// The snip tool's geometry — pure, so it can be tested on its own.
//
// A region is { x, y, w, h } in page-local px (the same units as marks and ink: 96 dpi, from the page's top-left
// corner), always inside one page. Hit-testing is done in screen px (handles are the same size at any zoom);
// dragging is done in page-local px.

export const MIN_SIZE = 8; // the smallest region, page-local px
export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export function rectFromPoints(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

// The point moved inside the page (bounds = { w, h }).
export function clampPoint(p, bounds) {
  return { x: clamp(p.x, 0, bounds.w), y: clamp(p.y, 0, bounds.h) };
}

// Where the eight handles are: the corners and the middle of each side.
export function handlePoints(r) {
  const { x, y, w, h } = r;
  return { nw: [x, y], n: [x + w / 2, y], ne: [x + w, y], e: [x + w, y + h / 2], se: [x + w, y + h], s: [x + w / 2, y + h], sw: [x, y + h], w: [x, y + h / 2] };
}

// What a point is on: a handle ('nw' … 'w'), a side (the same names: the side can be grabbed anywhere along it),
// the inside ('move') or nothing (null). `tol` is how near counts as on.
export function hitTest(r, p, tol) {
  const pts = handlePoints(r);
  let best = null;
  let bestD = tol;
  for (const name of HANDLES) {
    const d = Math.hypot(p.x - pts[name][0], p.y - pts[name][1]);
    if (d <= bestD) {
      best = name;
      bestD = d;
    }
  }
  if (best) return best;
  const withinX = p.x >= r.x - tol && p.x <= r.x + r.w + tol;
  const withinY = p.y >= r.y - tol && p.y <= r.y + r.h + tol;
  if (withinX && Math.abs(p.y - r.y) <= tol) return 'n';
  if (withinX && Math.abs(p.y - (r.y + r.h)) <= tol) return 's';
  if (withinY && Math.abs(p.x - r.x) <= tol) return 'w';
  if (withinY && Math.abs(p.x - (r.x + r.w)) <= tol) return 'e';
  if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return 'move';
  return null;
}

// The mouse cursor for what is under it.
export const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move' };

// The region after `kind` ('move' or a handle) was dragged by (dx, dy) from r0, kept inside the page (bounds = { w, h }).
// Dragging an edge past the opposite one turns the region round, as in a paint program; it never gets smaller than `min`.
export function dragRect(r0, kind, dx, dy, bounds, min = MIN_SIZE) {
  if (kind === 'move') {
    return { x: clamp(r0.x + dx, 0, Math.max(0, bounds.w - r0.w)), y: clamp(r0.y + dy, 0, Math.max(0, bounds.h - r0.h)), w: r0.w, h: r0.h };
  }
  let left = r0.x;
  let top = r0.y;
  let right = r0.x + r0.w;
  let bottom = r0.y + r0.h;
  if (kind.includes('w')) left += dx;
  if (kind.includes('e')) right += dx;
  if (kind.includes('n')) top += dy;
  if (kind.includes('s')) bottom += dy;
  let x0 = clamp(Math.min(left, right), 0, bounds.w);
  let x1 = clamp(Math.max(left, right), 0, bounds.w);
  let y0 = clamp(Math.min(top, bottom), 0, bounds.h);
  let y1 = clamp(Math.max(top, bottom), 0, bounds.h);
  const minW = Math.min(min, bounds.w);
  const minH = Math.min(min, bounds.h);
  if (x1 - x0 < minW) {
    if (kind.includes('w') && !kind.includes('e')) x0 = Math.max(0, x1 - minW);
    else x1 = Math.min(bounds.w, x0 + minW);
    if (x1 - x0 < minW) x0 = Math.max(0, x1 - minW);
  }
  if (y1 - y0 < minH) {
    if (kind.includes('n') && !kind.includes('s')) y0 = Math.max(0, y1 - minH);
    else y1 = Math.min(bounds.h, y0 + minH);
    if (y1 - y0 < minH) y0 = Math.max(0, y1 - minH);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// How many image pixels per page-local px: at least as sharp as the screen shows it (zoom × pixel ratio), never
// below 2 (about 190 dpi), and never so many that the picture gets too big for a canvas or the clipboard.
export function outputScale({ w, h, zoom, dpr = 1, minScale = 2, maxSide = 8192, maxPixels = 40e6 }) {
  let s = Math.max(minScale, zoom * dpr);
  s = Math.min(s, maxSide / Math.max(w, h, 1), Math.sqrt(maxPixels / Math.max(w * h, 1)));
  return Math.max(0.1, s);
}

// The size a pasted picture gets on the page (page-local px). A picture is pasted at its own pixel size, which for the
// snip's picture (2+ pixels per page pixel) is twice what was selected, and for a photo can be many times the page:
//   - the picture that was just copied from a region comes back at the region's size (`lastCopy`: the picture's
//     pixel size and the region's size);
//   - anything else is kept as it is unless it is wider than 60% of the page, then scaled down to that.
export function pastedPictureSize({ w, h, pageW, lastCopy = null }) {
  if (lastCopy && Math.abs(w - lastCopy.picW) <= 1 && Math.abs(h - lastCopy.picH) <= 1) return { w: lastCopy.w, h: lastCopy.h };
  const max = pageW * 0.6;
  return w > max ? { w: max, h: (h * max) / w } : { w, h };
}

export function snipName(title, pageNumber) {
  const clean = String(title || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'document';
  return `${clean} - page ${pageNumber}.png`;
}
