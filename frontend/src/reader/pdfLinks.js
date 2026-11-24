// The clickable bits of a PDF: a web address, or a jump to another page (a table of contents, a footnote mark, "see page 12").
//
// pdf.js reports them as "link annotations" of a page. The reader draws pages itself, so nothing is clickable unless it is
// asked: each page's links are read once (`LinkIndex`, like the page text for Find), turned into page-local rectangles (the
// same px as marks and ink) and hit-tested when the reader sees a plain tap — see ReaderCanvas `linkAt` / `openLink`.

import { PX_PER_PT } from './geometry.js';

// What a link may open outside the reader. Anything else (javascript:, file:, data:, ...) is not a link here.
const OPENABLE = new Set(['http:', 'https:', 'mailto:']);

export function safeUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  return OPENABLE.has(url.protocol) ? url.href : null;
}

const PAGE_ACTIONS = new Set(['NextPage', 'PrevPage', 'FirstPage', 'LastPage']);

// What a pdf.js link annotation does, as { type: 'url', url } | { type: 'dest', dest } | { type: 'action', name }, or null when
// it is something the reader does not do (a file to launch, a script, a form action, an address it will not open).
export function targetOf(annotation) {
  const a = annotation || {};
  if (a.url || a.unsafeUrl) {
    const url = safeUrl(a.url) || safeUrl(a.unsafeUrl);
    return url ? { type: 'url', url } : null;
  }
  if (a.filename || a.attachment) return null;
  if (a.dest) return { type: 'dest', dest: a.dest };
  if (PAGE_ACTIONS.has(a.action)) return { type: 'action', name: a.action };
  return null;
}

// [x, y, w, h] in page-local px for a rectangle in PDF user space (rotation and crop box are the viewport's business), or
// null for one too small to hit.
export function linkRect(viewport, rect) {
  if (!Array.isArray(rect) || rect.length < 4) return null;
  const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(rect);
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);
  return w >= 2 && h >= 2 ? [x, y, w, h] : null;
}

// The links of a page: [{ rect: [x, y, w, h], target }].
export function linksOf(viewport, annotations) {
  const out = [];
  for (const a of annotations || []) {
    if (a?.subtype !== 'Link') continue;
    const target = targetOf(a);
    const rect = target && linkRect(viewport, a.rect);
    if (rect) out.push({ rect, target });
  }
  return out;
}

// The topmost link under a page-local point (`pad` px of slack around each, for a fingertip).
export function hitLink(links, x, y, pad = 2) {
  for (let i = (links?.length || 0) - 1; i >= 0; i--) {
    const [rx, ry, rw, rh] = links[i].rect;
    if (x >= rx - pad && x <= rx + rw + pad && y >= ry - pad && y <= ry + rh + pad) return links[i];
  }
  return null;
}

// The PDF page (0-based) a destination points at, or -1. A destination is a name (looked up in the document) or an explicit
// array [page reference, how to show it, ...].
export async function destPageIndex(pdf, dest) {
  try {
    const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || !explicit.length) return -1;
    const target = explicit[0];
    if (Number.isInteger(target)) return target;
    if (target && typeof target === 'object') return await pdf.getPageIndex(target);
  } catch {
    /* a destination the document does not have */
  }
  return -1;
}

// Every page's links, read once. `peek` answers at once (undefined until read) so a tap never waits for pdf.js.
export class LinkIndex {
  constructor(pdf) {
    this.pdf = pdf;
    this.reading = new Map(); // pdf page index -> Promise<links>
    this.ready = new Map(); // pdf page index -> links
    this.disposed = false;
  }

  peek(index) {
    return this.ready.get(index);
  }

  load(index) {
    let p = this.reading.get(index);
    if (!p) {
      p = (async () => {
        const page = await this.pdf.getPage(index + 1);
        const annotations = await page.getAnnotations({ intent: 'display' });
        return linksOf(page.getViewport({ scale: PX_PER_PT }), annotations);
      })().catch(() => []); // a page whose links cannot be read simply has none
      this.reading.set(index, p);
      p.then((links) => {
        if (!this.disposed) this.ready.set(index, links);
      });
    }
    return p;
  }

  dispose() {
    this.disposed = true;
    this.reading.clear();
    this.ready.clear();
  }
}
