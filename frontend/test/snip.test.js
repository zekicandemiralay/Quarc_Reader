// Run: npm test (from frontend/)
// The snip tool's geometry: drawing a region, grabbing its handles, dragging, and how big the picture is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rectFromPoints, clampPoint, handlePoints, hitTest, dragRect, outputScale, pastedPictureSize, snipName, MIN_SIZE } from '../src/reader/snip.js';

const page = { w: 600, h: 800 };

test('a region is drawn from any corner to the opposite one', () => {
  assert.deepEqual(rectFromPoints({ x: 100, y: 50 }, { x: 30, y: 90 }), { x: 30, y: 50, w: 70, h: 40 });
  assert.deepEqual(rectFromPoints({ x: 10, y: 10 }, { x: 10, y: 10 }), { x: 10, y: 10, w: 0, h: 0 });
});

test('a point is kept inside the page', () => {
  assert.deepEqual(clampPoint({ x: -5, y: 900 }, page), { x: 0, y: 800 });
  assert.deepEqual(clampPoint({ x: 300, y: 400 }, page), { x: 300, y: 400 });
});

test('the handles are the corners and the middle of the sides', () => {
  const h = handlePoints({ x: 10, y: 20, w: 100, h: 60 });
  assert.deepEqual(h.nw, [10, 20]);
  assert.deepEqual(h.se, [110, 80]);
  assert.deepEqual(h.n, [60, 20]);
  assert.deepEqual(h.w, [10, 50]);
});

test('hit-testing finds a handle, a side, the inside, or nothing', () => {
  const r = { x: 100, y: 100, w: 200, h: 120 };
  assert.equal(hitTest(r, { x: 101, y: 99 }, 10), 'nw');
  assert.equal(hitTest(r, { x: 300, y: 220 }, 10), 'se');
  assert.equal(hitTest(r, { x: 200, y: 98 }, 10), 'n'); // middle of the top: the handle itself
  assert.equal(hitTest(r, { x: 150, y: 103 }, 10), 'n'); // anywhere along the top side
  assert.equal(hitTest(r, { x: 297, y: 150 }, 10), 'e');
  assert.equal(hitTest(r, { x: 200, y: 160 }, 10), 'move');
  assert.equal(hitTest(r, { x: 500, y: 500 }, 10), null);
  assert.equal(hitTest(r, { x: 95, y: 160 }, 10), 'w'); // just outside still counts, within the tolerance
});

test('moving keeps the size and stays on the page', () => {
  const r = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(dragRect(r, 'move', 30, -20, page), { x: 130, y: 80, w: 200, h: 100 });
  assert.deepEqual(dragRect(r, 'move', 900, 900, page), { x: 400, y: 700, w: 200, h: 100 });
  assert.deepEqual(dragRect(r, 'move', -900, -900, page), { x: 0, y: 0, w: 200, h: 100 });
});

test('dragging a handle moves only its edges', () => {
  const r = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(dragRect(r, 'e', 50, 999, page), { x: 100, y: 100, w: 250, h: 100 }); // a side handle ignores the other axis
  assert.deepEqual(dragRect(r, 'se', 10, 20, page), { x: 100, y: 100, w: 210, h: 120 });
  assert.deepEqual(dragRect(r, 'nw', 20, 10, page), { x: 120, y: 110, w: 180, h: 90 });
  assert.deepEqual(dragRect(r, 'n', 0, -40, page), { x: 100, y: 60, w: 200, h: 140 });
});

test('a region cannot leave the page', () => {
  const r = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(dragRect(r, 'se', 900, 900, page), { x: 100, y: 100, w: 500, h: 700 });
  assert.deepEqual(dragRect(r, 'nw', -900, -900, page), { x: 0, y: 0, w: 300, h: 200 });
});

test('dragging an edge past the other one turns the region round', () => {
  const r = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(dragRect(r, 'e', -250, 0, page), { x: 50, y: 100, w: 50, h: 100 });
  assert.deepEqual(dragRect(r, 'w', 250, 0, page), { x: 300, y: 100, w: 50, h: 100 });
});

test('a region never gets smaller than the minimum', () => {
  const r = { x: 100, y: 100, w: 200, h: 100 };
  const a = dragRect(r, 'e', -200, 0, page); // exactly to the other side
  assert.equal(a.w, MIN_SIZE);
  assert.equal(a.x, 100);
  const b = dragRect(r, 'w', 199, 0, page);
  assert.equal(b.w, MIN_SIZE);
  assert.equal(b.x + b.w, 300);
  const c = dragRect(r, 'n', 0, 99, page);
  assert.equal(c.h, MIN_SIZE);
});

test('the picture is as sharp as the screen, at least about 190 dpi, and never absurdly big', () => {
  assert.equal(outputScale({ w: 200, h: 100, zoom: 1, dpr: 1 }), 2);
  assert.equal(outputScale({ w: 200, h: 100, zoom: 3, dpr: 2 }), 6);
  const huge = outputScale({ w: 3000, h: 4000, zoom: 8, dpr: 2 });
  assert.ok(3000 * huge * 4000 * huge <= 40e6 * 1.001, `${huge}`);
  assert.ok(4000 * huge <= 8192 * 1.001);
  assert.ok(outputScale({ w: 1, h: 1, zoom: 0.01, dpr: 1 }) >= 2);
});

test('the picture that was just copied comes back at the size of the region, whatever its pixels', () => {
  const lastCopy = { picW: 1066, picH: 250, w: 533, h: 125 };
  assert.deepEqual(pastedPictureSize({ w: 1066, h: 250, pageW: 794, lastCopy }), { w: 533, h: 125 });
  assert.deepEqual(pastedPictureSize({ w: 1066.4, h: 249.6, pageW: 794, lastCopy }), { w: 533, h: 125 }); // rounding in the picture
});

test('any other picture is kept, unless it is wider than 60% of the page', () => {
  assert.deepEqual(pastedPictureSize({ w: 300, h: 200, pageW: 794 }), { w: 300, h: 200 });
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  const big = pastedPictureSize({ w: 4000, h: 3000, pageW: 800 });
  near(big.w, 480);
  near(big.h, 360); // the shape is kept
  const other = pastedPictureSize({ w: 1066, h: 300, pageW: 794, lastCopy: { picW: 1066, picH: 250, w: 533, h: 125 } }); // not the copied one
  near(other.w, 794 * 0.6);
});

test('the file name has the document and the page, and no characters a file system refuses', () => {
  assert.equal(snipName('Moby Dick (test)', 3), 'Moby Dick (test) - page 3.png');
  assert.equal(snipName('a/b: c?*"d"', 12), 'a b c d - page 12.png');
  assert.equal(snipName('', 1), 'document - page 1.png');
});
