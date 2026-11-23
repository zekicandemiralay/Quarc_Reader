import {
  PDFDocument,
  PDFName,
  PDFHexString,
  PDFString,
  pushGraphicsState,
  popGraphicsState,
  moveTo,
  lineTo,
  closePath,
  fill,
  stroke,
  fillAndStroke,
  appendBezierCurve,
  setFillingRgbColor,
  setStrokingRgbColor,
  setLineWidth,
  setLineCap,
  setLineJoin,
  setGraphicsState,
  setDashPattern,
  LineCapStyle,
  LineJoinStyle,
} from 'pdf-lib';
import { getStroke } from 'perfect-freehand';
import { PX_PER_PT } from './geometry.js';
import { activeMarks } from './marks.js';

// Saving a PDF with the annotations in it.
//
//  - Pencil ink (freehand strokes, highlighter strokes) and the drawing tools'
//    shapes (lines, arrows, rectangles, ellipses, diamonds) become *vector*
//    paths on the page: sharp at any zoom, with the stroke widths, colours and
//    opacity they had. Freehand uses the same perfect-freehand outline
//    Excalidraw draws on screen, so what you see is what is saved.
//  - Text and images placed with Excalidraw's tools are drawn by Excalidraw
//    itself into a transparent PNG per page (`rasterize`, injected) — fonts
//    and layout come out exactly as on screen.
//  - Text highlights, underlines and strike-throughs become real PDF
//    annotations (/Highlight, /Underline, /StrikeOut with QuadPoints and an
//    appearance stream), and a note becomes a /Text annotation — so other
//    readers (Librera, Acrobat, a browser) show them and can edit them.
//  - Note pages become real pages.
//
// Coordinates: annotations are stored in page-local px (y down, 96 dpi); a
// page's `convert(x, y)` maps one to PDF user space (points, y up), handling
// rotated pages and cropped media boxes. For pages this export adds, it is the
// plain 0.75 scale with a flipped y.

const FREEHAND_FACTOR = 4.25; // Excalidraw draws a freedraw element at size = strokeWidth * 4.25
const RASTER_SCALE = 3;
const VECTOR_TYPES = new Set(['freedraw', 'line', 'arrow', 'rectangle', 'diamond', 'ellipse']);

function hexToRgb(hex, fallback = [0, 0, 0]) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(typeof hex === 'string' ? hex.trim() : '');
  if (!m) return fallback;
  let h = m[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}
const isTransparent = (c) => !c || c === 'transparent';

// ----- paths ----------------------------------------------------------------------------

// A path is a list of segments in page-local px; `build` turns it into PDF operators.
//   { m: [x, y] } | { l: [x, y] } | { c: [x1, y1, x2, y2, x3, y3] } | { z: true }
function quadToCubic(p0, q, p1) {
  return [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1]), p1[0] + (2 / 3) * (q[0] - p1[0]), p1[1] + (2 / 3) * (q[1] - p1[1]), p1[0], p1[1]];
}

// Excalidraw's own smoothing of a freehand outline: a quadratic curve through
// the midpoints of the outline's points.
function freehandPath(outline) {
  if (outline.length < 3) return [];
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const path = [{ m: outline[0] }];
  let cur = outline[0];
  const first = mid(outline[1], outline[2]);
  path.push({ c: quadToCubic(cur, outline[1], first) });
  cur = first;
  for (let i = 2; i < outline.length - 1; i++) {
    const end = mid(outline[i], outline[i + 1]);
    path.push({ c: quadToCubic(cur, outline[i], end) });
    cur = end;
  }
  path.push({ z: true });
  return path;
}

function freedrawOutline(el) {
  const pts = el.points?.length ? el.points : [[0, 0]];
  const input = el.simulatePressure ? pts.map(([x, y]) => [x, y]) : pts.map(([x, y], i) => [x, y, el.pressures?.[i] ?? 0.5]);
  const outline = getStroke(input, {
    simulatePressure: !!el.simulatePressure,
    size: (el.strokeWidth || 1) * FREEHAND_FACTOR,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    easing: (t) => Math.sin((t * Math.PI) / 2),
    last: false,
  });
  return outline.map(([x, y]) => [el.x + x, el.y + y]);
}

// Rotation of an element about its centre (Excalidraw's `angle`).
function rotator(el) {
  const a = el.angle || 0;
  if (!a) return (p) => p;
  const cx = el.x + (el.width || 0) / 2;
  const cy = el.y + (el.height || 0) / 2;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return ([x, y]) => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos];
}

const KAPPA = 0.5522847498;

function ellipsePath(el, rot) {
  const rx = el.width / 2;
  const ry = el.height / 2;
  const cx = el.x + rx;
  const cy = el.y + ry;
  const P = (x, y) => rot([x, y]);
  return [
    { m: P(cx + rx, cy) },
    { c: [...P(cx + rx, cy + ry * KAPPA), ...P(cx + rx * KAPPA, cy + ry), ...P(cx, cy + ry)] },
    { c: [...P(cx - rx * KAPPA, cy + ry), ...P(cx - rx, cy + ry * KAPPA), ...P(cx - rx, cy)] },
    { c: [...P(cx - rx, cy - ry * KAPPA), ...P(cx - rx * KAPPA, cy - ry), ...P(cx, cy - ry)] },
    { c: [...P(cx + rx * KAPPA, cy - ry), ...P(cx + rx, cy - ry * KAPPA), ...P(cx + rx, cy)] },
    { z: true },
  ];
}

function rectPath(el, rot) {
  const { x, y, width: w, height: h } = el;
  const P = (px, py) => rot([px, py]);
  const r = el.roundness ? Math.min(32, 0.25 * Math.min(w, h)) : 0;
  if (!r) return [{ m: P(x, y) }, { l: P(x + w, y) }, { l: P(x + w, y + h) }, { l: P(x, y + h) }, { z: true }];
  const k = r * (1 - KAPPA);
  return [
    { m: P(x + r, y) },
    { l: P(x + w - r, y) },
    { c: [...P(x + w - k, y), ...P(x + w, y + k), ...P(x + w, y + r)] },
    { l: P(x + w, y + h - r) },
    { c: [...P(x + w, y + h - k), ...P(x + w - k, y + h), ...P(x + w - r, y + h)] },
    { l: P(x + r, y + h) },
    { c: [...P(x + k, y + h), ...P(x, y + h - k), ...P(x, y + h - r)] },
    { l: P(x, y + r) },
    { c: [...P(x, y + k), ...P(x + k, y), ...P(x + r, y)] },
    { z: true },
  ];
}

function diamondPath(el, rot) {
  const { x, y, width: w, height: h } = el;
  const P = (px, py) => rot([px, py]);
  return [{ m: P(x + w / 2, y) }, { l: P(x + w, y + h / 2) }, { l: P(x + w / 2, y + h) }, { l: P(x, y + h / 2) }, { z: true }];
}

// A line/arrow through its points; smooth (Catmull-Rom) when Excalidraw rounded it.
function linearPath(el, rot) {
  const pts = (el.points || []).map(([px, py]) => rot([el.x + px, el.y + py]));
  if (pts.length < 2) return [];
  const path = [{ m: pts[0] }];
  if (el.roundness && pts.length > 2) {
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];
      path.push({ c: [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]] });
    }
  } else {
    for (let i = 1; i < pts.length; i++) path.push({ l: pts[i] });
  }
  return path;
}

// Arrowheads at the end (or start) of an arrow/line, as extra open paths.
function arrowheadPaths(el, rot) {
  const pts = (el.points || []).map(([px, py]) => rot([el.x + px, el.y + py]));
  if (pts.length < 2) return { strokes: [], fills: [] };
  const strokes = [];
  const fills = [];
  const head = (tip, from, kind) => {
    if (!kind) return;
    const dx = tip[0] - from[0];
    const dy = tip[1] - from[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const size = Math.min(len * 0.5, Math.max(12, (el.strokeWidth || 2) * 5));
    const left = [tip[0] - ux * size - uy * size * 0.45, tip[1] - uy * size + ux * size * 0.45];
    const right = [tip[0] - ux * size + uy * size * 0.45, tip[1] - uy * size - ux * size * 0.45];
    if (kind === 'triangle') fills.push([{ m: tip }, { l: left }, { l: right }, { z: true }]);
    else if (kind === 'bar') strokes.push([{ m: [tip[0] - uy * size * 0.45, tip[1] + ux * size * 0.45] }, { l: [tip[0] + uy * size * 0.45, tip[1] - ux * size * 0.45] }]);
    else strokes.push([{ m: left }, { l: tip }, { l: right }]);
  };
  head(pts[pts.length - 1], pts[pts.length - 2], el.endArrowhead);
  head(pts[0], pts[1], el.startArrowhead);
  return { strokes, fills };
}

// The ruling of a note page (same light colours and 28 px spacing as on screen),
// so a lined page is still lined in the saved PDF.
const RULING_CELL = 28;
function rulingOperators(style, wPx, hPx, convert) {
  if (!style || style === 'empty') return [];
  const ops = [pushGraphicsState()];
  if (style === 'dotted') {
    ops.push(setFillingRgbColor(...hexToRgb('#b8c4d2')));
    const r = 1.1;
    for (let y = RULING_CELL; y < hPx; y += RULING_CELL) {
      for (let x = RULING_CELL; x < wPx; x += RULING_CELL) {
        const [a, b, c, d] = [convert(x - r, y - r), convert(x + r, y - r), convert(x + r, y + r), convert(x - r, y + r)];
        ops.push(moveTo(...a), lineTo(...b), lineTo(...c), lineTo(...d), closePath());
      }
    }
    ops.push(fill());
  } else {
    ops.push(setStrokingRgbColor(...hexToRgb(style === 'squared' ? '#e2e8f0' : '#d6e4f0')), setLineWidth(0.5));
    for (let y = RULING_CELL; y < hPx; y += RULING_CELL) ops.push(moveTo(...convert(0, y)), lineTo(...convert(wPx, y)));
    if (style === 'squared') for (let x = RULING_CELL; x < wPx; x += RULING_CELL) ops.push(moveTo(...convert(x, 0)), lineTo(...convert(x, hPx)));
    ops.push(stroke());
  }
  ops.push(popGraphicsState());
  return ops;
}

function pathOperators(path, convert) {
  const ops = [];
  const C = (p) => convert(p[0], p[1]);
  for (const seg of path) {
    if (seg.m) ops.push(moveTo(...C(seg.m)));
    else if (seg.l) ops.push(lineTo(...C(seg.l)));
    else if (seg.c) {
      const [a, b, c] = [C([seg.c[0], seg.c[1]]), C([seg.c[2], seg.c[3]]), C([seg.c[4], seg.c[5]])];
      ops.push(appendBezierCurve(a[0], a[1], b[0], b[1], c[0], c[1]));
    } else if (seg.z) ops.push(closePath());
  }
  return ops;
}

// ----- the exporter -------------------------------------------------------------------------------

export function noteConvert(heightPt) {
  return (x, y) => [x / PX_PER_PT, heightPt - y / PX_PER_PT];
}

// `pdfBytes`      the original file
// `pages`         the page list (geometry.buildPages): pdf pages and note pages, in order
// `annotations`   Map pageKey -> { ink: { elements, files }, marks }
// `transformFor`  (pdfIndex) => { convert(x, y) -> [ux, uy] } for a page of the original PDF
// `rasterize`     optional ({ elements, files }) => Promise<{ png: Uint8Array, bounds: [x1, y1, x2, y2] } | null>
//                 draws text/images that can't be vectors; bounds are in page-local px
export async function exportAnnotatedPdf({ pdfBytes, pages, annotations, transformFor, rasterize, onProgress }) {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });

  // Put the note pages in; after this, page i of the document is pages[i].
  const converters = [];
  const widthsPt = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (p.kind === 'note') {
      const w = p.w / PX_PER_PT;
      const h = p.h / PX_PER_PT;
      doc.insertPage(i, [w, h]);
      converters[i] = { convert: noteConvert(h) };
      widthsPt[i] = w;
    } else {
      converters[i] = (await transformFor(p.pdfIndex)) || null;
    }
  }

  const gsCache = new Map();
  const gsName = (page, alpha, multiply) => {
    const key = `${alpha}|${multiply ? 1 : 0}`;
    if (!gsCache.has(key)) {
      const ref = doc.context.register(doc.context.obj({ Type: 'ExtGState', ca: alpha, CA: alpha, ...(multiply ? { BM: 'Multiply' } : {}) }));
      gsCache.set(key, { name: `QRgs${gsCache.size}`, ref });
    }
    const g = gsCache.get(key);
    page.node.setExtGState(PDFName.of(g.name), g.ref);
    return PDFName.of(g.name);
  };

  for (let i = 0; i < pages.length; i++) {
    const data = annotations.get(pages[i].key);
    const conv = converters[i];
    // A note page keeps its paper: the ruling goes down first, under any ink.
    if (pages[i].kind === 'note' && conv) doc.getPage(i).pushOperators(...rulingOperators(pages[i].style, pages[i].w, pages[i].h, conv.convert));
    if (!data || !conv) {
      onProgress?.((i + 1) / pages.length);
      continue;
    }
    const page = doc.getPage(i);
    const elements = (data.ink?.elements || []).filter((el) => el && !el.isDeleted);

    // --- ink and shapes as vectors, in the order they were drawn ---
    const ops = [];
    for (const el of elements) {
      if (!VECTOR_TYPES.has(el.type)) continue;
      const opacity = Math.min(1, Math.max(0, (el.opacity ?? 100) / 100));
      const rot = rotator(el);
      const strokeColor = hexToRgb(el.strokeColor);
      const inner = [];
      if (el.type === 'freedraw') {
        const path = freehandPath(freedrawOutline(el).map(rot));
        if (!path.length) continue;
        inner.push(setFillingRgbColor(...strokeColor), ...pathOperators(path, conv.convert), fill());
      } else {
        const path = el.type === 'ellipse' ? ellipsePath(el, rot) : el.type === 'rectangle' ? rectPath(el, rot) : el.type === 'diamond' ? diamondPath(el, rot) : linearPath(el, rot);
        if (!path.length) continue;
        const hasFill = !isTransparent(el.backgroundColor) && (el.type !== 'line' && el.type !== 'arrow');
        inner.push(setLineWidth(Math.max(0.2, (el.strokeWidth || 1) * 0.75)), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round));
        if (el.strokeStyle === 'dashed') inner.push(setDashPattern([8 * 0.75, 6 * 0.75], 0));
        else if (el.strokeStyle === 'dotted') inner.push(setDashPattern([1.5 * 0.75, 4 * 0.75], 0));
        inner.push(setStrokingRgbColor(...strokeColor));
        if (hasFill) {
          inner.push(setFillingRgbColor(...hexToRgb(el.backgroundColor)), ...pathOperators(path, conv.convert), isTransparent(el.strokeColor) ? fill() : fillAndStroke());
        } else {
          inner.push(...pathOperators(path, conv.convert), stroke());
        }
        if (el.type === 'arrow' || (el.type === 'line' && (el.startArrowhead || el.endArrowhead))) {
          const { strokes, fills } = arrowheadPaths(el, rot);
          inner.push(setDashPattern([], 0));
          for (const s of strokes) inner.push(...pathOperators(s, conv.convert), stroke());
          inner.push(setFillingRgbColor(...strokeColor));
          for (const f of fills) inner.push(...pathOperators(f, conv.convert), fillAndStroke());
        }
      }
      // A highlighter-like (translucent) freehand stroke multiplies with the page, so text stays readable.
      const multiply = el.type === 'freedraw' && opacity < 1;
      ops.push(pushGraphicsState(), ...(opacity < 1 ? [setGraphicsState(gsName(page, opacity, multiply))] : []), ...inner, popGraphicsState());
    }
    if (ops.length) page.pushOperators(...ops);

    // --- text, images and anything else: Excalidraw draws them ---
    const rest = elements.filter((el) => !VECTOR_TYPES.has(el.type));
    if (rest.length && rasterize) {
      const result = await rasterize({ elements: rest, files: data.ink?.files || {}, scale: RASTER_SCALE });
      if (result?.png) {
        const image = await doc.embedPng(result.png);
        const [x1, y1, x2, y2] = result.bounds;
        const [ax, ay] = conv.convert(x1, y1);
        const [bx, by] = conv.convert(x2, y2);
        // For an unrotated page this is the plain rectangle; a rotated page would need the image rotated too.
        page.drawImage(image, { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) });
      }
    }

    // --- text marks as real PDF annotations ---
    const annots = page.node.Annots() || doc.context.obj([]);
    for (const mark of activeMarks(data.marks)) {
      for (const ref of markAnnotations(doc, mark, conv.convert)) annots.push(ref);
    }
    if (annots.size() && !page.node.Annots()) page.node.set(PDFName.of('Annots'), annots);
    onProgress?.((i + 1) / pages.length);
  }

  return doc.save();
}

// ----- text marks -> annotations --------------------------------------------------------------------

const SUBTYPES = { hl: 'Highlight', ul: 'Underline', st: 'StrikeOut' };

function markAnnotations(doc, mark, convert) {
  const color = hexToRgb(mark.color, [1, 0.83, 0.23]);
  const quads = [];
  const xs = [];
  const ys = [];
  for (const [x, y, w, h] of mark.rects) {
    // Acrobat's order: top-left, top-right, bottom-left, bottom-right.
    const corners = [convert(x, y), convert(x + w, y), convert(x, y + h), convert(x + w, y + h)];
    for (const [cx, cy] of corners) {
      quads.push(cx, cy);
      xs.push(cx);
      ys.push(cy);
    }
  }
  if (!quads.length) return [];
  const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const subtype = SUBTYPES[mark.type] || 'Highlight';
  const num = (a) => doc.context.obj(a);

  // Appearance: what a viewer draws if it doesn't generate its own.
  const g = [];
  const quadCount = quads.length / 8;
  for (let q = 0; q < quadCount; q++) {
    const c = quads.slice(q * 8, q * 8 + 8);
    const [tlx, tly, trx, try_, blx, bly, brx, bry] = c;
    if (subtype === 'Highlight') g.push(`${tlx} ${tly} m ${trx} ${try_} l ${brx} ${bry} l ${blx} ${bly} l h f`);
    else {
      const [lx, ly, rx, ry] = subtype === 'Underline' ? [blx, bly, brx, bry] : [(tlx + blx) / 2, (tly + bly) / 2, (trx + brx) / 2, (try_ + bry) / 2];
      g.push(`${lx} ${ly} m ${rx} ${ry} l S`);
    }
  }
  const body = `/GS0 gs ${subtype === 'Highlight' ? `${color.join(' ')} rg` : `${color.join(' ')} RG 1 w`} ${g.join(' ')}`;
  const ext = doc.context.obj({ GS0: { Type: 'ExtGState', BM: subtype === 'Highlight' ? 'Multiply' : 'Normal', ca: 1, CA: 1 } });
  const form = doc.context.stream(body, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: num(rect),
    Resources: doc.context.obj({ ExtGState: ext }),
  });
  const ap = doc.context.obj({ N: doc.context.register(form) });

  const dict = {
    Type: 'Annot',
    Subtype: subtype,
    Rect: num(rect),
    QuadPoints: num(quads),
    C: num(color),
    F: 4,
    CA: 1,
    Subj: PDFHexString.fromText('Quarc Reader'),
    Contents: PDFHexString.fromText(mark.note || ''),
    AP: ap,
  };
  const refs = [doc.context.register(doc.context.obj(dict))];

  // A note on the text: a sticky-note icon at the end of the last line.
  if (mark.note) {
    const [lx, ly, lw, lh] = mark.rects[mark.rects.length - 1];
    const [ax, ay] = convert(lx + lw + 2, ly);
    const [bx, by] = convert(lx + lw + 2 + 16, ly + 16);
    const noteRect = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
    refs.push(
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Text',
          Rect: num(noteRect),
          Name: 'Comment',
          C: num(color),
          F: 28,
          Open: false,
          Contents: PDFHexString.fromText(mark.note),
          T: PDFString.of('Quarc Reader'),
        })
      )
    );
  }
  return refs;
}

