import { pageRect, visiblePages } from './geometry';
import { activeMarks, markBounds } from './marks';

// The paper layer: sheets with a soft shadow, the PDF page bitmaps on them,
// ruling on note pages. Everything is drawn in LIGHT colours; dark mode is a
// CSS invert filter on the canvas (see ReaderCanvas), so PDF pages and note
// pages go dark together and match the ink (which uses the same filter).

export const CELL_SIZE = 28; // line/grid spacing on note pages (scene px) — same as Quarc Notes
// The desk the pages lie on: warm, so a white or sepia page glows a little against it.
export const DESK = { white: '#e5e0d6', sepia: '#d7cab0', dark: '#0e0b14' };
export const PAPER = { white: '#ffffff', sepia: '#f5ebd4' };
// Applied to the paper canvas (and the ink preview) in dark mode.
export const DARK_FILTER = 'invert(93%) hue-rotate(180deg)';

const RULING = { line: '#d6e4f0', grid: '#e2e8f0', dot: '#b8c4d2' };

export function drawRuling(ctx, style, sx, sy, w, h, zoom, rect) {
  const cell = CELL_SIZE * zoom;
  if (style === 'empty' || cell < 3) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(sx, sy, w, h);
  ctx.clip();
  const y0 = Math.max(cell, Math.ceil(-sy / cell) * cell);
  const yEnd = Math.min(h, rect.height - sy);
  if (style === 'dotted') {
    ctx.fillStyle = RULING.dot;
    const r = Math.max(1, Math.min(2.2, zoom * 1.4));
    const x0 = Math.max(cell, Math.ceil(-sx / cell) * cell);
    const xEnd = Math.min(w, rect.width - sx);
    for (let y = y0; y < yEnd; y += cell) {
      for (let x = x0; x < xEnd; x += cell) ctx.fillRect(Math.round(sx + x - r / 2), Math.round(sy + y - r / 2), r, r);
    }
  } else {
    ctx.strokeStyle = style === 'squared' ? RULING.grid : RULING.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = y0; y < yEnd; y += cell) {
      const py = Math.round(sy + y) + 0.5;
      ctx.moveTo(sx, py);
      ctx.lineTo(sx + w, py);
    }
    if (style === 'squared') {
      const x0 = Math.max(cell, Math.ceil(-sx / cell) * cell);
      const xEnd = Math.min(w, rect.width - sx);
      for (let x = x0; x < xEnd; x += cell) {
        const px = Math.round(sx + x) + 0.5;
        ctx.moveTo(px, Math.max(sy, 0));
        ctx.lineTo(px, Math.min(sy + h, rect.height));
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

// Draws every visible page onto `canvas` (sized to the viewport, already scaled
// for the device pixel ratio by the caller's buffer size).
// `onlyIndex`: draw just that page (book mode shows one page at a time).
export function drawPaper(canvas, view, rect, layout, raster, { sepia, dark, onlyIndex }) {
  const dpr = window.devicePixelRatio || 1;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  const { scrollX, scrollY, zoom } = view;
  const paper = sepia ? PAPER.sepia : PAPER.white;

  for (const i of onlyIndex != null ? [onlyIndex] : visiblePages(layout, view, rect)) {
    const page = layout.pages[i];
    const r = pageRect(layout, i);
    const sx = (r.x + scrollX) * zoom;
    const sy = (r.y + scrollY) * zoom;
    const w = r.width * zoom;
    const h = r.height * zoom;

    ctx.save();
    if (!dark) {
      ctx.shadowColor = 'rgba(58,40,20,0.26)';
      ctx.shadowBlur = 14;
      ctx.shadowOffsetY = 3;
    }
    ctx.fillStyle = page.kind === 'note' ? paper : '#ffffff';
    ctx.fillRect(sx, sy, w, h);
    ctx.restore();

    if (page.kind === 'pdf') {
      raster?.draw(ctx, page.pdfIndex, { x: sx, y: sy, w, h }, zoom);
      if (sepia) {
        // Tint the white of the page like old paper; the text stays dark.
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = PAPER.sepia;
        ctx.fillRect(sx, sy, w, h);
        ctx.restore();
      }
    } else {
      drawRuling(ctx, page.style, sx, sy, w, h, zoom, rect);
    }
  }
}

// Find-in-text hits, on the highlight layer: violet (not one of the highlight colours), the current hit
// stronger and outlined.
export const FIND_COLORS = { hit: '#d3c2ff', current: '#a98bff', outline: '#6d28d9' };

function drawFinds(ctx, hits, ox, oy, zoom, dark) {
  const pad = 1;
  const box = (x, y, w, h) => [ox + x * zoom - pad, oy + y * zoom - pad, w * zoom + 2 * pad, h * zoom + 2 * pad, Math.min(3, 2.5 * zoom)];
  ctx.save();
  ctx.globalAlpha = dark ? 0.4 : 1;
  ctx.fillStyle = FIND_COLORS.hit;
  for (const [x, y, w, h] of hits.rects) {
    ctx.beginPath();
    ctx.roundRect(...box(x, y, w, h));
    ctx.fill();
  }
  if (hits.current) {
    ctx.globalAlpha = dark ? 0.7 : 1;
    ctx.fillStyle = FIND_COLORS.current;
    ctx.strokeStyle = FIND_COLORS.outline;
    ctx.lineWidth = 1.5;
    for (const [x, y, w, h] of hits.current) {
      ctx.beginPath();
      ctx.roundRect(...box(x, y, w, h));
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

// The highlight layer. Light mode: this canvas is multiplied over the paper
// (CSS mix-blend-mode), so a pastel colour tints the page and the text stays
// black. Dark mode: plain translucent colour over the inverted page.
// `finds`: Map(page key -> { rects: [[x, y, w, h]], current: [[x, y, w, h]] | null }) — the hits of the
// text being searched for (page-local px).
export function drawMarks(canvas, view, rect, layout, marksByPage, { dark, hidden, selectedId, onlyIndex, finds }) {
  const dpr = window.devicePixelRatio || 1;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (hidden) return;
  const { scrollX, scrollY, zoom } = view;

  for (const i of onlyIndex != null ? [onlyIndex] : visiblePages(layout, view, rect)) {
    const marks = activeMarks(marksByPage.get(layout.pages[i].key));
    const hits = finds?.get(layout.pages[i].key);
    if (!marks.length && !hits) continue;
    const r = pageRect(layout, i);
    const ox = (r.x + scrollX) * zoom;
    const oy = (r.y + scrollY) * zoom;
    for (const m of marks) paintMark(ctx, m, ox, oy, zoom, { dark, selectedId });
    if (hits) drawFinds(ctx, hits, ox, oy, zoom, dark);
  }
}

// One highlight / underline / strike-through (and the note marker on it), with the page's top-left corner at
// (ox, oy) on the canvas and `zoom` canvas px per page-local px. Also used to draw a snipped region.
export function paintMark(ctx, m, ox, oy, zoom, { dark = false, selectedId = null } = {}) {
  ctx.save();
  ctx.fillStyle = m.color;
  ctx.strokeStyle = m.color;
  for (const [x, y, w, h] of m.rects) {
    if (m.type === 'hl') {
      ctx.globalAlpha = dark ? 0.38 : 1;
      ctx.fillRect(ox + x * zoom, oy + y * zoom, w * zoom, h * zoom);
    } else {
      ctx.globalAlpha = 1;
      ctx.lineWidth = Math.max(1.5, 1.6 * zoom);
      const ly = m.type === 'ul' ? y + h - 1 : y + h / 2;
      ctx.beginPath();
      ctx.moveTo(ox + x * zoom, oy + ly * zoom);
      ctx.lineTo(ox + (x + w) * zoom, oy + ly * zoom);
      ctx.stroke();
    }
  }
  ctx.restore();
  if (m.id === selectedId) {
    const b = markBounds(m);
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ox + b.x * zoom - 2, oy + b.y * zoom - 2, b.w * zoom + 4, b.h * zoom + 4);
    ctx.restore();
  }
  if (m.note) {
    // A small speech-bubble marker at the end of the highlight.
    const last = m.rects[m.rects.length - 1];
    const bx = ox + (last[0] + last[2]) * zoom + 3;
    const by = oy + last[1] * zoom;
    const s = Math.max(9, Math.min(18, 11 * zoom));
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.roundRect(bx, by, s, s * 0.8, 2.5);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(bx + s * 0.2, by + s * 0.8);
    ctx.lineTo(bx + s * 0.2, by + s * 1.05);
    ctx.lineTo(bx + s * 0.45, by + s * 0.8);
    ctx.fill();
    ctx.restore();
  }
}
