// Run: npm test (from frontend/)
// Saving a PDF with the annotations in it: build a real PDF, export it with ink,
// shapes, highlights and a note page, and read the result back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream, rgb } from 'pdf-lib';
import { exportAnnotatedPdf, noteConvert } from '../src/reader/exportPdf.js';
import { buildPages, PX_PER_PT } from '../src/reader/geometry.js';
import { newMark } from '../src/reader/marks.js';

async function makePdf(pageCount = 2) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([600, 800]);
    page.drawRectangle({ x: 50, y: 50, width: 100, height: 100, color: rgb(0.9, 0.9, 0.9) });
  }
  return doc.save();
}

// A rotation-0 page: page-local px (y down) -> user space (pt, y up).
const plain = (heightPt) => ({ convert: noteConvert(heightPt) });

const stroke = (extra = {}) => ({
  id: 's1',
  type: 'freedraw',
  x: 100,
  y: 120,
  width: 60,
  height: 20,
  points: [[0, 0], [20, 8], [40, 4], [60, 20]],
  pressures: [0.4, 0.6, 0.7, 0.5],
  simulatePressure: false,
  strokeWidth: 0.6,
  strokeColor: '#e03131',
  opacity: 100,
  isDeleted: false,
  version: 1,
  ...extra,
});

async function contentOf(doc, pageIndex) {
  const page = doc.getPage(pageIndex);
  const contents = page.node.Contents();
  const parts = [];
  const collect = (obj) => {
    if (obj instanceof PDFRawStream) parts.push(Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1'));
    else if (obj instanceof PDFArray) for (let i = 0; i < obj.size(); i++) collect(doc.context.lookup(obj.get(i)));
  };
  collect(contents instanceof PDFArray ? contents : contents);
  return parts.join('\n');
}

function annotsOf(doc, pageIndex) {
  const arr = doc.getPage(pageIndex).node.Annots();
  const out = [];
  if (!arr) return out;
  for (let i = 0; i < arr.size(); i++) out.push(doc.context.lookup(arr.get(i), PDFDict));
  return out;
}

const name = (dict, key) => dict.get(PDFName.of(key))?.toString();

test('a page with ink gains vector drawing operators; untouched pages are unchanged', async () => {
  const pages = buildPages(2, [[2, 600, 800]], null);
  const annotations = new Map([['p0', { ink: { elements: [stroke()] }, marks: [] }]]);
  const out = await exportAnnotatedPdf({ pdfBytes: await makePdf(), pages, annotations, transformFor: async () => plain(800) });
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 2);
  const c0 = await contentOf(doc, 0);
  const c1 = await contentOf(doc, 1);
  assert.match(c0, /1\.?0* 0\.?\d* 0\.?\d* rg|0\.8\d* 0\.1\d* 0\.1\d* rg/, 'the stroke colour (#e03131) is set');
  assert.match(c0, / c\n/, 'smooth curves are drawn');
  assert.match(c0, /\nf\n/, 'and filled');
  assert.ok(c0.length > c1.length, 'the annotated page has more content than the untouched one');
});

test('erased strokes are not saved; translucent ink uses a multiply blend', async () => {
  const pages = buildPages(2, [[2, 600, 800]], null);
  const annotations = new Map([
    ['p0', { ink: { elements: [stroke({ id: 'gone', isDeleted: true }), stroke({ id: 'hl', opacity: 40, strokeColor: '#ffd43b', strokeWidth: 3 })] }, marks: [] }],
  ]);
  const out = await exportAnnotatedPdf({ pdfBytes: await makePdf(), pages, annotations, transformFor: async () => plain(800) });
  const doc = await PDFDocument.load(out);
  const fills = async (i) => ((await contentOf(doc, i)).match(/ rg\n/g) || []).length;
  // Page 1 is untouched (its own content has one fill: the grey square the test PDF draws).
  assert.equal(await fills(0), (await fills(1)) + 1, 'only the live stroke is added; the erased one is not');
  const res = doc.getPage(0).node.Resources();
  const gs = res.lookup(PDFName.of('ExtGState'), PDFDict);
  const first = gs.lookup(gs.keys()[0], PDFDict);
  assert.equal(name(first, 'BM'), '/Multiply');
  assert.equal(first.get(PDFName.of('ca')).toString(), '0.4');
});

test('shapes: rectangles, ellipses, lines and arrows become stroked paths', async () => {
  const base = { strokeColor: '#1971c2', backgroundColor: 'transparent', strokeWidth: 2, opacity: 100, isDeleted: false, version: 1, angle: 0 };
  const els = [
    { ...base, id: 'r', type: 'rectangle', x: 50, y: 50, width: 100, height: 60 },
    { ...base, id: 'e', type: 'ellipse', x: 200, y: 50, width: 80, height: 60, backgroundColor: '#ffd43b' },
    { ...base, id: 'l', type: 'line', x: 50, y: 200, width: 100, height: 0, points: [[0, 0], [100, 0]] },
    { ...base, id: 'a', type: 'arrow', x: 50, y: 300, width: 100, height: 40, points: [[0, 0], [100, 40]], endArrowhead: 'arrow', strokeStyle: 'dashed' },
    { ...base, id: 'd', type: 'diamond', x: 300, y: 300, width: 60, height: 60 },
  ];
  const out = await exportAnnotatedPdf({
    pdfBytes: await makePdf(1),
    pages: buildPages(1, [[1, 600, 800]], null),
    annotations: new Map([['p0', { ink: { elements: els }, marks: [] }]]),
    transformFor: async () => plain(800),
  });
  const content = await contentOf(await PDFDocument.load(out), 0);
  assert.ok((content.match(/\nS\n/g) || []).length >= 4, 'stroked outlines');
  assert.match(content, /\nB\n/, 'the filled ellipse is filled and stroked');
  assert.match(content, /\[[^\]]+\] 0 d/, 'the dashed arrow sets a dash pattern');
  assert.doesNotMatch(content, /NaN|Infinity/);
});

test('highlights become real PDF annotations with quad points; notes add a sticky note', async () => {
  const pages = buildPages(2, [[2, 600, 800]], null);
  const hl = newMark({ type: 'hl', color: '#ffd43b', rects: [[100, 100, 200, 16], [100, 120, 80, 16]], text: 'call me Ishmael' });
  const noted = newMark({ type: 'ul', color: '#e03131', rects: [[50, 300, 120, 16]], text: 'some years ago', note: 'dating the story — Türkçe çğış' });
  const dead = { ...newMark({ rects: [[0, 0, 10, 10]] }), del: true };
  const out = await exportAnnotatedPdf({
    pdfBytes: await makePdf(),
    pages,
    annotations: new Map([['p1', { ink: { elements: [] }, marks: [hl, noted, dead] }]]),
    transformFor: async () => plain(800),
  });
  const doc = await PDFDocument.load(out);
  assert.equal(annotsOf(doc, 0).length, 0);
  const annots = annotsOf(doc, 1);
  assert.deepEqual(annots.map((a) => name(a, 'Subtype')), ['/Highlight', '/Underline', '/Text']);
  const [h, u, note] = annots;
  const quads = h.lookup(PDFName.of('QuadPoints'), PDFArray);
  assert.equal(quads.size(), 16, 'two lines = two quads = 16 numbers');
  // First line: x 100..300, y from the top 100..116 => PDF y = 800 - 0.75*y.
  const q = [...Array(8).keys()].map((i) => quads.lookup(i).asNumber());
  const toX = (px) => px / PX_PER_PT;
  const toY = (px) => 800 - px / PX_PER_PT;
  assert.deepEqual(q.map((n) => Math.round(n * 1000) / 1000), [toX(100), toY(100), toX(300), toY(100), toX(100), toY(116), toX(300), toY(116)].map((n) => Math.round(n * 1000) / 1000));
  assert.ok(h.get(PDFName.of('AP')), 'has an appearance stream');
  assert.equal(h.lookup(PDFName.of('C'), PDFArray).size(), 3);
  assert.equal(u.get(PDFName.of('Contents')).decodeText(), 'dating the story — Türkçe çğış');
  assert.equal(name(note, 'Name'), '/Comment');
});

test('note pages become real pages in the right place, and carry their own ink', async () => {
  const pages = buildPages(2, [[2, 600, 800]], [
    { t: 'p', i: 0 },
    { t: 'n', id: 'note-aaaa', w: 420, h: 595, s: 'lined', u: 1 },
    { t: 'p', i: 1 },
  ]);
  const annotations = new Map([
    ['nnote-aaaa', { ink: { elements: [stroke({ x: 40, y: 60 })] }, marks: [] }],
    ['p1', { ink: { elements: [stroke({ id: 'on-p1' })] }, marks: [] }],
  ]);
  const seen = [];
  const out = await exportAnnotatedPdf({
    pdfBytes: await makePdf(),
    pages,
    annotations,
    transformFor: async (pdfIndex) => {
      seen.push(pdfIndex);
      return plain(800);
    },
  });
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 3);
  assert.deepEqual(seen, [0, 1]);
  assert.deepEqual(doc.getPage(1).getSize(), { width: 420, height: 595 });
  assert.deepEqual(doc.getPage(2).getSize(), { width: 600, height: 800 });
  assert.match(await contentOf(doc, 1), / c\n/, 'ink on the note page');
  assert.match(await contentOf(doc, 2), / c\n/, 'ink on the page after it — it did not slide onto the note page');
  assert.doesNotMatch(await contentOf(doc, 0), / c\n/);
});

test('note pages keep their paper: lined, squared and dotted ruling is drawn, blank is not', async () => {
  const noteWith = (style) =>
    buildPages(1, [[1, 600, 800]], [{ t: 'p', i: 0 }, { t: 'n', id: 'note-bbbb', w: 420, h: 595, s: style, u: 1 }]);
  const contentFor = async (style) => {
    const out = await exportAnnotatedPdf({ pdfBytes: await makePdf(1), pages: noteWith(style), annotations: new Map(), transformFor: async () => plain(800) });
    return contentOf(await PDFDocument.load(out), 1);
  };
  const lined = await contentFor('lined');
  // 595 pt = 793 px of height => lines every 28 px.
  assert.equal((lined.match(/ l\n/g) || []).length, Math.floor((595 / 0.75 - 1) / 28), 'one horizontal rule per 28 px');
  assert.match(lined, /\nS\n/);
  const squared = await contentFor('squared');
  assert.ok((squared.match(/ l\n/g) || []).length > (lined.match(/ l\n/g) || []).length * 1.5, 'squared adds the vertical rules');
  const dotted = await contentFor('dotted');
  assert.match(dotted, /\nf\n/);
  assert.doesNotMatch(dotted, /\nS\n/);
  assert.equal((await contentFor('empty')).trim(), '', 'a blank page is blank');
});

test('text and images are drawn by the rasterizer and placed at its bounds', async () => {
  // 1x1 transparent PNG.
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  let received = null;
  const out = await exportAnnotatedPdf({
    pdfBytes: await makePdf(1),
    pages: buildPages(1, [[1, 600, 800]], null),
    annotations: new Map([
      ['p0', { ink: { elements: [{ id: 't', type: 'text', x: 100, y: 100, width: 80, height: 24, text: 'Merhaba', isDeleted: false }, stroke()] }, marks: [] }],
    ]),
    transformFor: async () => plain(800),
    rasterize: async (req) => {
      received = req;
      return { png, bounds: [100, 100, 180, 124] };
    },
  });
  assert.deepEqual(received.elements.map((e) => e.type), ['text'], 'only the non-vector elements go to the rasterizer');
  const doc = await PDFDocument.load(out);
  assert.match(await contentOf(doc, 0), /\/Image\d* Do|Do\n/, 'an image is drawn');
  // Without a rasterizer the text is skipped instead of failing the whole export.
  const noRaster = await exportAnnotatedPdf({
    pdfBytes: await makePdf(1),
    pages: buildPages(1, [[1, 600, 800]], null),
    annotations: new Map([['p0', { ink: { elements: [{ id: 't', type: 'text', x: 1, y: 1, width: 5, height: 5, isDeleted: false }] }, marks: [] }]]),
    transformFor: async () => plain(800),
  });
  assert.equal((await PDFDocument.load(noRaster)).getPageCount(), 1);
});

test('a rotated page maps through the supplied transform (here: 90 degrees)', async () => {
  // Displayed page is 800 wide x 600 tall; (x, y) px -> user space rotated.
  const rotated = { convert: (x, y) => [y / PX_PER_PT, x / PX_PER_PT] };
  const calls = [];
  await exportAnnotatedPdf({
    pdfBytes: await makePdf(1),
    pages: buildPages(1, [[1, 800, 600]], null),
    annotations: new Map([['p0', { ink: { elements: [] }, marks: [newMark({ rects: [[75, 150, 30, 12]], text: 'x' })] }]]),
    transformFor: async () => ({
      convert: (x, y) => {
        calls.push([x, y]);
        return rotated.convert(x, y);
      },
    }),
  });
  assert.ok(calls.length >= 4, 'the mark was converted through the page transform');
});

test('pages the app cannot transform are skipped, not fatal', async () => {
  const out = await exportAnnotatedPdf({
    pdfBytes: await makePdf(1),
    pages: buildPages(1, [[1, 600, 800]], null),
    annotations: new Map([['p0', { ink: { elements: [stroke()] }, marks: [] }]]),
    transformFor: async () => null,
  });
  assert.equal((await PDFDocument.load(out)).getPageCount(), 1);
});
