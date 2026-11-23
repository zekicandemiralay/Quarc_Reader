// Ink is drawn in Excalidraw in *scene* coordinates (the stacked layout, see
// geometry.js) but stored per page in *page-local* coordinates: x/y relative to
// the page's own top-left corner. That keeps what someone wrote on page 12
// attached to page 12 when pages are inserted before it, when the layout
// changes, and when two devices sync — and lets us save and send only the
// pages that changed instead of the whole book.
//
// Only x/y are shifted. Linear elements (strokes, lines, arrows) keep their
// points relative to their own x/y, so nothing else changes — in particular
// `version` and `versionNonce` stay as they are, which is what merging relies on.

import { pageAtY, pageRect } from './geometry.js';

const DELETED_RETENTION_MS = 14 * 24 * 3600 * 1000; // erased strokes are kept this long so offline devices sync the erase

// Which page an element belongs to: the one under its centre (the gap below a
// page belongs to it).
export function pageOfElement(layout, el) {
  return pageAtY(layout, (el.y || 0) + (el.height || 0) / 2);
}

export function shifted(el, dx, dy) {
  return { ...el, x: el.x + dx, y: el.y + dy };
}

export const toPageLocal = (layout, el, i) => {
  const r = pageRect(layout, i);
  return shifted(el, -r.x, -r.y);
};

export const toScene = (layout, el, i) => {
  const r = pageRect(layout, i);
  return shifted(el, r.x, r.y);
};

// Same element id in two pages' rows (it was dragged from one page to another):
// the newest version is the real one. Same rule as the server's merge.
export function elementWins(a, b) {
  const va = a.version ?? 0;
  const vb = b.version ?? 0;
  if (va !== vb) return va > vb;
  return (a.versionNonce ?? 0) < (b.versionNonce ?? 0);
}

// Groups the scene's elements by page. Returns Map<pageKey, element[]> with
// page-local coordinates; erased elements older than the retention window are
// dropped.
export function bucketElements(layout, elements, now = Date.now()) {
  const buckets = new Map();
  for (const el of elements) {
    if (el.isDeleted && (el.updated || 0) < now - DELETED_RETENTION_MS && el.updated) continue;
    const i = pageOfElement(layout, el);
    const key = layout.pages[i].key;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(toPageLocal(layout, el, i));
  }
  return buckets;
}

// A cheap fingerprint of one page's elements, to see what changed since the
// last save without serialising the whole book: id@version for each.
export function signature(elements) {
  let s = '';
  for (const el of elements) s += `${el.id}@${el.version}${el.isDeleted ? 'd' : ''};`;
  return s;
}

// The scene (scene coordinates) for stored rows: Map<pageKey, element[]>
// (page-local) -> elements, placed by the current layout. Rows for pages that
// aren't in the layout (a deleted note page) are skipped; an element that
// appears in two rows keeps its newest version.
export function sceneFromRows(layout, rows) {
  const indexByKey = new Map(layout.pages.map((p, i) => [p.key, i]));
  const best = new Map();
  const order = [];
  for (const [key, elements] of rows) {
    const i = indexByKey.get(key);
    if (i === undefined) continue;
    for (const el of elements) {
      if (!el || typeof el.id !== 'string') continue;
      const placed = toScene(layout, el, i);
      const prev = best.get(el.id);
      if (!prev) order.push(el.id);
      if (!prev || elementWins(placed, prev)) best.set(el.id, placed);
    }
  }
  const out = order.map((id) => best.get(id));
  if (out.every((el) => typeof el.index === 'string')) out.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
  return out;
}

// Moves every element from one layout to another (inserting a note page
// shifts everything below it; a different reading layout moves pages around).
// Each element stays attached to its page. Elements on a page that is not in
// the new layout (a deleted note page) are dropped from the scene — they would
// otherwise float over whatever page now sits at their old position.
export function relayout(oldLayout, newLayout, elements) {
  const newIndex = new Map(newLayout.pages.map((p, i) => [p.key, i]));
  const out = [];
  for (const el of elements) {
    const oi = pageOfElement(oldLayout, el);
    const ni = newIndex.get(oldLayout.pages[oi].key);
    if (ni === undefined) continue;
    const a = pageRect(oldLayout, oi);
    const b = pageRect(newLayout, ni);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    out.push(dx || dy ? shifted(el, dx, dy) : el);
  }
  return out;
}
