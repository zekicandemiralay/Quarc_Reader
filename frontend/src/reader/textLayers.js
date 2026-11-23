import { pdfjs } from '../lib/pdf';
import { PX_PER_PT, pageRect } from './geometry';
import { mergeLineRects } from './marks';
import { fold, joinItems, findAll, matchSegments, MAX_MATCHES } from './findText';

// The selectable text of PDF pages, as invisible DOM text laid over the page.
//
// The PDF is drawn on a canvas; this is only for *finding* text: selecting it
// (long-press / drag), highlighting it, and snapping a pencil highlighter
// stroke to the words under it. Each visible page gets a wrapper at the page's
// scene rectangle, positioned with a CSS transform that follows the view, and
// inside it pdf.js' own text layer (spans placed and stretched to match the
// glyphs). Pages far from the screen lose their layer again.

const KEEP_MARGIN = 1; // pages beyond the visible ones that keep their text layer

function clipRangeTo(range, node) {
  const bounds = document.createRange();
  bounds.selectNodeContents(node);
  const out = range.cloneRange();
  if (range.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) out.setStart(bounds.startContainer, bounds.startOffset);
  if (range.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) out.setEnd(bounds.endContainer, bounds.endOffset);
  return out;
}

// Grows [i0, i1) in `str` to whole words (what "snapping" a highlight means).
export function expandToWords(str, i0, i1) {
  let a = Math.max(0, Math.min(i0, str.length));
  let b = Math.max(a, Math.min(i1, str.length));
  while (a > 0 && !/\s/.test(str[a - 1])) a--;
  while (b < str.length && !/\s/.test(str[b])) b++;
  return [a, b];
}

export class TextLayerManager {
  constructor(root, pdf) {
    this.root = root;
    this.pdf = pdf;
    this.pages = new Map(); // pageIndex -> { wrapper, container, key, w, h, ready }
    this.interactive = false;
    this.disposed = false;
    this.onRendered = null; // (layoutIndex) => void, when a page's text has been laid out
  }

  // Create/destroy layers for the visible pages and move them with the view.
  sync(layout, view, rect, visible, { enabled, interactive }) {
    if (this.disposed) return;
    this.interactive = interactive;
    this.root.style.pointerEvents = 'none';
    const want = new Set();
    if (enabled) {
      for (const i of visible) {
        for (let k = i - KEEP_MARGIN; k <= i + KEEP_MARGIN; k++) if (k >= 0 && k < layout.n) want.add(k);
      }
    }
    for (const [i, p] of this.pages) {
      if (!want.has(i) || p.key !== layout.pages[i]?.key) this.remove(i);
    }
    for (const i of want) {
      const page = layout.pages[i];
      if (page.kind !== 'pdf') continue;
      if (!this.pages.has(i)) this.create(i, page);
    }
    for (const [i, p] of this.pages) {
      const r = pageRect(layout, i);
      p.wrapper.style.transform = `translate(${(r.x + view.scrollX) * view.zoom}px, ${(r.y + view.scrollY) * view.zoom}px) scale(${view.zoom})`;
      p.wrapper.style.pointerEvents = interactive ? 'auto' : 'none';
    }
  }

  create(i, page) {
    const wrapper = document.createElement('div');
    wrapper.dataset.pageKey = page.key;
    wrapper.style.cssText = `position:absolute;left:0;top:0;width:${page.w}px;height:${page.h}px;transform-origin:0 0;--scale-factor:${PX_PER_PT};`;
    const container = document.createElement('div');
    container.className = 'quarc-text-layer';
    wrapper.appendChild(container);
    this.root.appendChild(wrapper);
    const entry = { wrapper, container, key: page.key, w: page.w, h: page.h, ready: null };
    this.pages.set(i, entry);
    entry.ready = (async () => {
      try {
        const pdfPage = await this.pdf.getPage(page.pdfIndex + 1);
        if (this.disposed || this.pages.get(i) !== entry) return;
        const viewport = pdfPage.getViewport({ scale: PX_PER_PT });
        const layer = new pdfjs.TextLayer({ textContentSource: pdfPage.streamTextContent(), container, viewport });
        await layer.render();
        if (this.disposed || this.pages.get(i) !== entry) return;
        entry.layer = layer;
        this.onRendered?.(i);
      } catch {
        /* a page with no text, or one destroyed while rendering */
      }
    })();
  }

  remove(i) {
    const p = this.pages.get(i);
    if (!p) return;
    p.wrapper.remove();
    this.pages.delete(i);
  }

  zoomOf(p) {
    return p.wrapper.getBoundingClientRect().width / p.w || 1;
  }

  // Whether this page's text has been laid out (find-in-text needs that to know where a hit is).
  hasText(i) {
    return !!this.pages.get(i)?.layer;
  }

  // Every hit of `needle` (already folded, see findText.fold) on page i, as page-local rectangles —
  // one [x, y, w, h] per line the hit touches — in reading order. The text is rebuilt from the layer's own
  // spans, so a hit is found exactly where the layer has it. null while the page has no laid-out text.
  findRects(i, needle, accents) {
    const p = this.pages.get(i);
    const layer = p?.layer;
    if (!layer || !needle) return null;
    const divs = layer.textDivs;
    // a <br> after a span is the end of a line (pdf.js puts one after the last span of each)
    const page = joinItems(layer.textContentItemsStr.map((str, k) => ({ str, hasEOL: divs[k]?.nextElementSibling?.tagName === 'BR' })));
    const { text, map } = fold(page.joined, { accents });
    const wr = p.wrapper.getBoundingClientRect();
    const zoom = wr.width / p.w || 1;
    const range = document.createRange();
    return findAll(text, needle, MAX_MATCHES).map((a) => {
      const rects = [];
      for (const { item, from, to } of matchSegments(page, map, a, a + needle.length)) {
        const node = divs[item]?.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE) continue;
        range.setStart(node, from);
        range.setEnd(node, to);
        for (const cr of range.getClientRects()) rects.push({ x: (cr.left - wr.left) / zoom, y: (cr.top - wr.top) / zoom, w: cr.width / zoom, h: cr.height / zoom });
      }
      return mergeLineRects(rects);
    });
  }

  // The current text selection as one entry per page it touches:
  // [{ pageIndex, key, rects: [[x, y, w, h]] (page-local px, one per line), text }].
  selection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const out = [];
    for (const [i, p] of this.pages) {
      if (!range.intersectsNode(p.container)) continue;
      const clipped = clipRangeTo(range, p.container);
      const text = clipped.toString().replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const wr = p.wrapper.getBoundingClientRect();
      const zoom = wr.width / p.w || 1;
      const rects = [...clipped.getClientRects()].map((cr) => ({ x: (cr.left - wr.left) / zoom, y: (cr.top - wr.top) / zoom, w: cr.width / zoom, h: cr.height / zoom }));
      const merged = mergeLineRects(rects);
      if (merged.length) out.push({ pageIndex: i, key: p.key, rects: merged, text });
    }
    return out.length ? out.sort((a, b) => a.pageIndex - b.pageIndex) : null;
  }

  // Where the selection ends, on screen (client px), to anchor the action bar.
  selectionAnchor() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const rects = [...sel.getRangeAt(0).getClientRects()];
    if (!rects.length) return null;
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    return { top, bottom, left, right };
  }

  clearSelection() {
    window.getSelection()?.removeAllRanges();
  }

  // The words a pencil stroke passed over: `points` are page-local scene px.
  // Every text span whose line the stroke crossed contributes the stretch
  // between where the stroke entered and left it, widened to whole words.
  // Returns { rects, text } or null if the stroke touched no text.
  async textUnderStroke(pageIndex, points) {
    const p = this.pages.get(pageIndex);
    if (!p) return null;
    await p.ready;
    const wr = p.wrapper.getBoundingClientRect();
    const zoom = wr.width / p.w || 1;
    const rects = [];
    const texts = [];
    for (const span of p.container.querySelectorAll('span')) {
      const node = span.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) continue;
      const str = node.textContent;
      if (!str.trim()) continue;
      const sr = span.getBoundingClientRect();
      const box = { x: (sr.left - wr.left) / zoom, y: (sr.top - wr.top) / zoom, w: sr.width / zoom, h: sr.height / zoom };
      if (box.w < 1 || box.h < 1) continue;
      // The stroke counts on this line if it passes through its middle band.
      const band = box.h * 0.3;
      const inside = points.filter((pt) => pt.y >= box.y + band && pt.y <= box.y + box.h - band && pt.x >= box.x - box.h * 0.3 && pt.x <= box.x + box.w + box.h * 0.3);
      if (inside.length < 2) continue;
      const x0 = Math.max(box.x, Math.min(...inside.map((pt) => pt.x)));
      const x1 = Math.min(box.x + box.w, Math.max(...inside.map((pt) => pt.x)));
      if (x1 - x0 < box.h * 0.4) continue;
      let i0 = Math.floor(((x0 - box.x) / box.w) * str.length);
      let i1 = Math.ceil(((x1 - box.x) / box.w) * str.length);
      [i0, i1] = expandToWords(str, i0, i1);
      if (i1 <= i0 || !str.slice(i0, i1).trim()) continue;
      const range = document.createRange();
      range.setStart(node, i0);
      range.setEnd(node, i1);
      for (const cr of range.getClientRects()) rects.push({ x: (cr.left - wr.left) / zoom, y: (cr.top - wr.top) / zoom, w: cr.width / zoom, h: cr.height / zoom });
      texts.push({ y: box.y, x: box.x, s: str.slice(i0, i1) });
    }
    const merged = mergeLineRects(rects);
    if (!merged.length) return null;
    texts.sort((a, b) => a.y - b.y || a.x - b.x);
    return { rects: merged, text: texts.map((t) => t.s).join(' ').replace(/\s+/g, ' ').trim() };
  }

  dispose() {
    this.disposed = true;
    for (const i of [...this.pages.keys()]) this.remove(i);
  }
}
