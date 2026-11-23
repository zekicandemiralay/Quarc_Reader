// Page geometry for the reader.
//
// A document is a list of pages — the PDF's own, plus any note pages the user
// inserted — each with its own size. They are laid out as a vertical stack of
// sheets in Excalidraw's scene coordinates, exactly like a Quarc Notes
// notebook (the scene unit is the CSS pixel at 96 dpi; a PDF point is 4/3 of
// one). The stack is only how the pages are *shown*: ink is stored per page in
// page-local coordinates (see inkBuckets.js), so the layout can change (insert
// a page, switch reading mode) without touching what anyone drew.

export const PX_PER_PT = 96 / 72;
export const PAGE_GAP = 40; // scene px between sheets
export const MAX_ZOOM = 8;
export const MIN_ZOOM = 0.05;
// Screen px kept clear around the pages: the toolbar floats over the top and
// the page indicator over the bottom.
export const INSETS = { top: 64, bottom: 64, side: 16 };

export const NOTE_SIZES = {
  A4: { w: 595, h: 842 },
  A5: { w: 420, h: 595 },
  Letter: { w: 612, h: 792 },
};
export const NOTE_STYLES = ['lined', 'squared', 'dotted', 'empty'];

// ----- page sizes -------------------------------------------------------------

// Page sizes are stored run-length encoded in PDF points: [[count, w, h], ...]
// (almost every document is one run).
export function compressSizes(sizes) {
  const runs = [];
  for (const [w, h] of sizes) {
    const last = runs[runs.length - 1];
    if (last && last[1] === w && last[2] === h) last[0]++;
    else runs.push([1, w, h]);
  }
  return runs;
}

export function expandSizes(runs, count) {
  const out = [];
  for (const [n, w, h] of runs || []) for (let i = 0; i < n && out.length < count; i++) out.push([w, h]);
  // Missing sizes (not measured yet): assume the first page's, else A4.
  const fallback = out[0] || [NOTE_SIZES.A4.w, NOTE_SIZES.A4.h];
  while (out.length < count) out.push(fallback);
  return out;
}

// ----- the page list ----------------------------------------------------------

export const pdfKey = (i) => `p${i}`;
export const noteKey = (id) => `n${id}`;

// The ordered pages of a document. `layoutItems` is the document's `layout`
// field (null = just the PDF's pages in order); deleted note pages are left
// out. Sizes are scene px.
export function buildPages(pageCount, sizesRuns, layoutItems) {
  const sizes = expandSizes(sizesRuns, pageCount);
  const pdfPage = (i) => ({ key: pdfKey(i), kind: 'pdf', pdfIndex: i, w: sizes[i][0] * PX_PER_PT, h: sizes[i][1] * PX_PER_PT });
  if (!Array.isArray(layoutItems)) return Array.from({ length: pageCount }, (_, i) => pdfPage(i));
  const pages = [];
  const placed = new Set();
  for (const it of layoutItems) {
    if (it.t === 'p') {
      if (it.i < pageCount && !placed.has(it.i)) {
        pages.push(pdfPage(it.i));
        placed.add(it.i);
      }
    } else if (it.t === 'n' && !it.del) {
      pages.push({ key: noteKey(it.id), kind: 'note', id: it.id, style: it.s || 'lined', w: it.w * PX_PER_PT, h: it.h * PX_PER_PT });
    }
  }
  // A PDF page missing from the layout (a layout written for fewer pages) is
  // never dropped: it goes at the end.
  for (let i = 0; i < pageCount; i++) if (!placed.has(i)) pages.push(pdfPage(i));
  return pages;
}

// The layout field for a document, from the current page list plus the
// tombstones of deleted note pages (so other devices learn they are gone).
export function layoutItemsFor(pages, deletedNotes = []) {
  const items = pages.map((p) =>
    p.kind === 'pdf' ? { t: 'p', i: p.pdfIndex } : { t: 'n', id: p.id, w: Math.round(p.w / PX_PER_PT), h: Math.round(p.h / PX_PER_PT), s: p.style, u: p.u || 0 }
  );
  return [...items, ...deletedNotes];
}

// ----- the stack --------------------------------------------------------------

export function makeLayout(pages) {
  const n = pages.length;
  const tops = new Array(n);
  const lefts = new Array(n);
  let maxW = 0;
  for (const p of pages) maxW = Math.max(maxW, p.w);
  let y = 0;
  for (let i = 0; i < n; i++) {
    tops[i] = y;
    lefts[i] = (maxW - pages[i].w) / 2;
    y += pages[i].h + PAGE_GAP;
  }
  return { n, pages, tops, lefts, maxW, totalH: n ? y - PAGE_GAP : 0 };
}

export const pageRect = (layout, i) => ({ x: layout.lefts[i], y: layout.tops[i], width: layout.pages[i].w, height: layout.pages[i].h });

// Which page a scene y belongs to (the gap below a page belongs to it).
export function pageAtY(layout, y) {
  if (!layout.n) return 0;
  let lo = 0;
  let hi = layout.n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (layout.tops[mid] - PAGE_GAP / 2 <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// The page whose paper is under a scene point, or -1 (desk / gap).
export function pageUnder(layout, x, y) {
  if (!layout.n) return -1;
  const i = pageAtY(layout, y);
  const r = pageRect(layout, i);
  return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height ? i : -1;
}

// ----- views ------------------------------------------------------------------
// A view is { scrollX, scrollY, zoom } in Excalidraw's own terms: a scene point
// (x, y) is at screen ((x + scrollX) * zoom, (y + scrollY) * zoom).

export const fitWidthZoom = (rect, w) => Math.max(MIN_ZOOM, (rect.width - 2 * INSETS.side) / w);
export const fitPageZoom = (rect, w, h) => Math.max(MIN_ZOOM, Math.min((rect.width - 2 * INSETS.side) / w, (rect.height - INSETS.top - INSETS.bottom) / h));

// Scroll mode keeps the stack on screen: no pushing it past the insets, and
// content narrower than the screen stays centred.
export function clampStackView(scrollX, scrollY, zoom, rect, layout) {
  const axis = (scroll, view, content, lead, trail) => {
    const min = (view - trail) / zoom - content;
    const max = lead / zoom;
    if (min > max) return (lead + (view - lead - trail) / 2) / zoom - content / 2;
    return Math.min(Math.max(scroll, min), max);
  };
  return {
    scrollX: axis(scrollX, rect.width, layout.maxW, INSETS.side, INSETS.side),
    scrollY: axis(scrollY, rect.height, layout.totalH, INSETS.top, INSETS.bottom),
  };
}

// Book mode shows one page at a time: the view stays within that page (and
// centres it when it is smaller than the screen).
export function clampPageView(scrollX, scrollY, zoom, rect, layout, i) {
  const r = pageRect(layout, i);
  const axis = (scroll, view, start, size, lead, trail) => {
    const min = (view - trail) / zoom - (start + size);
    const max = lead / zoom - start;
    if (min > max) return (lead + (view - lead - trail) / 2) / zoom - (start + size / 2);
    return Math.min(Math.max(scroll, min), max);
  };
  return {
    scrollX: axis(scrollX, rect.width, r.x, r.width, INSETS.side, INSETS.side),
    scrollY: axis(scrollY, rect.height, r.y, r.height, INSETS.top, INSETS.bottom),
  };
}

// The view that shows page `i` at `zoom`: centred if it fits, else its top edge.
export function viewForPage(layout, i, zoom, rect) {
  const r = pageRect(layout, i);
  const free = rect.height - INSETS.top - INSETS.bottom;
  const fits = r.height * zoom <= free + 0.5;
  const scrollY = fits ? (INSETS.top + free / 2) / zoom - (r.y + r.height / 2) : INSETS.top / zoom - r.y;
  const scrollX = rect.width / (2 * zoom) - (r.x + r.width / 2);
  return { zoom, ...clampPageView(scrollX, scrollY, zoom, rect, layout, i) };
}

// Pages whose sheet intersects the viewport (with an optional margin in screen px).
export function visiblePages(layout, view, rect, margin = 0) {
  if (!layout.n) return [];
  const top = -view.scrollY - margin / view.zoom;
  const bottom = top + (rect.height + 2 * margin) / view.zoom;
  const first = pageAtY(layout, top);
  const out = [];
  for (let i = first; i < layout.n && layout.tops[i] <= bottom; i++) {
    if (layout.tops[i] + layout.pages[i].h >= top) out.push(i);
  }
  return out;
}

// The page being read: the one under the middle of the screen (gaps count as
// the page above), i.e. what "page 12 of 300" means.
export function currentPage(layout, view, rect) {
  return pageAtY(layout, rect.height / 2 / view.zoom - view.scrollY);
}

// How far down the page the middle of the screen is (0..1), to resume reading
// at the same spot on a screen of any size.
export function pageOffset(layout, view, rect, i) {
  const y = rect.height / 2 / view.zoom - view.scrollY - layout.tops[i];
  return Math.min(1, Math.max(0, y / layout.pages[i].h));
}

// The view that puts a saved reading position (page + offset 0..1) in the
// middle of the screen, at a given zoom.
export function viewForPosition(layout, i, offset, zoom, rect) {
  const y = layout.tops[i] + offset * layout.pages[i].h;
  const scrollY = rect.height / 2 / zoom - y;
  const scrollX = rect.width / (2 * zoom) - layout.maxW / 2;
  return { zoom, ...clampStackView(scrollX, scrollY, zoom, rect, layout) };
}
