// "Marks" are what is attached to the *text* of a page, as opposed to ink drawn
// freehand on it: highlights, underlines, strike-throughs and the notes typed
// onto them. They are kept per page, in page-local coordinates, as a list of
// items merged by id (see backend/src/services/merge.js — the same rule runs
// here): { id, u (ms timestamp of the last change), del? }.
//
//   { id, u, type: 'hl' | 'ul' | 'st', color: '#rrggbb',
//     rects: [[x, y, w, h], ...]   one per line of text, page-local px
//     text: 'the highlighted words', note?: 'typed note', del?: true }

export const MARK_COLORS = ['#ffd43b', '#8ce99a', '#74c0fc', '#faa2c1', '#ffc078'];
export const MARK_TYPES = ['hl', 'ul', 'st'];

export function newMark({ type = 'hl', color = MARK_COLORS[0], rects, text = '', note = '' }) {
  return { id: crypto.randomUUID(), u: Date.now(), type, color, rects, text: text.slice(0, 2000), ...(note ? { note } : {}) };
}

export const activeMarks = (marks) => (marks || []).filter((m) => !m.del);

// Same rule as the server's mergeById: per id the newer `u` wins; on a tie the
// existing (first) copy stays. Deleted items are kept 30 days so that devices
// that were offline still learn about the deletion.
const TOMBSTONE_MS = 30 * 24 * 3600 * 1000;
export function mergeMarks(existing, incoming, now = Date.now()) {
  const byId = new Map();
  const order = [];
  const add = (m, prefer) => {
    if (!m || typeof m.id !== 'string') return;
    const prev = byId.get(m.id);
    if (!prev) {
      order.push(m.id);
      byId.set(m.id, m);
    } else if (prefer && (m.u ?? 0) > (prev.u ?? 0)) byId.set(m.id, m);
  };
  for (const m of existing || []) add(m, false);
  for (const m of incoming || []) add(m, true);
  return order.map((id) => byId.get(id)).filter((m) => !(m.del && (m.u ?? 0) < now - TOMBSTONE_MS));
}

export function updateMark(marks, id, patch) {
  return marks.map((m) => (m.id === id ? { ...m, ...patch, u: Date.now() } : m));
}

export function deleteMark(marks, id) {
  return marks.map((m) => (m.id === id ? { ...m, del: true, u: Date.now() } : m));
}

// ----- geometry ----------------------------------------------------------------------

// The browser reports a selection as many small rectangles (one per text
// fragment, often several per line, some overlapping). Merges them into one
// rectangle per line: rectangles that overlap vertically and touch
// horizontally become one; tiny slivers are dropped.
export function mergeLineRects(rects, { minSize = 1.5 } = {}) {
  const items = rects
    .filter((r) => r.w >= minSize && r.h >= minSize)
    .map((r) => ({ ...r }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const r of items) {
    const line = lines.find((l) => {
      const overlap = Math.min(l.y + l.h, r.y + r.h) - Math.max(l.y, r.y);
      return overlap > 0.6 * Math.min(l.h, r.h) && r.x <= l.x + l.w + 4 && r.x + r.w >= l.x - 4;
    });
    if (line) {
      const x1 = Math.max(line.x + line.w, r.x + r.w);
      const y1 = Math.max(line.y + line.h, r.y + r.h);
      line.x = Math.min(line.x, r.x);
      line.y = Math.min(line.y, r.y);
      line.w = x1 - line.x;
      line.h = y1 - line.y;
    } else {
      lines.push(r);
    }
  }
  return lines.sort((a, b) => a.y - b.y || a.x - b.x).map((l) => [l.x, l.y, l.w, l.h]);
}

export function pointInRects(rects, x, y, pad = 0) {
  return rects.some(([rx, ry, rw, rh]) => x >= rx - pad && x <= rx + rw + pad && y >= ry - pad && y <= ry + rh + pad);
}

// The topmost (newest) mark under a page-local point, if any.
export function hitMark(marks, x, y, pad = 2) {
  const live = activeMarks(marks);
  for (let i = live.length - 1; i >= 0; i--) if (pointInRects(live[i].rects, x, y, pad)) return live[i];
  return null;
}

// Bounding box of a mark's rects.
export function markBounds(m) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y, w, h] of m.rects) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w);
    y1 = Math.max(y1, y + h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
