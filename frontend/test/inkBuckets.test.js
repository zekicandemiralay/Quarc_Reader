// Run: npm test (from frontend/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPages, makeLayout, pageRect, PX_PER_PT } from '../src/reader/geometry.js';
import { pageOfElement, toPageLocal, toScene, bucketElements, signature, sceneFromRows, relayout } from '../src/reader/inkBuckets.js';

const layoutOf = (items) => makeLayout(buildPages(3, [[3, 600, 800]], items));
const stroke = (id, x, y, extra = {}) => ({ id, type: 'freedraw', x, y, width: 10, height: 10, version: 1, versionNonce: 1, isDeleted: false, points: [[0, 0], [10, 10]], ...extra });

test('an element belongs to the page under its centre', () => {
  const layout = layoutOf(null);
  const p1 = pageRect(layout, 1);
  assert.equal(pageOfElement(layout, stroke('a', 20, 20)), 0);
  assert.equal(pageOfElement(layout, stroke('b', 20, p1.y + 20)), 1);
  // Hanging over the bottom of page 0, but centred in the upper half of the gap below it: still page 0.
  assert.equal(pageOfElement(layout, stroke('c', 20, p1.y - 40, { height: 10 })), 0);
  // Centred in the lower half of the gap (nearer page 1): page 1.
  assert.equal(pageOfElement(layout, stroke('d', 20, p1.y - 14, { height: 10 })), 1);
});

test('page-local coordinates round-trip and only x/y move (versions untouched)', () => {
  const layout = layoutOf(null);
  const el = stroke('a', 50, pageRect(layout, 2).y + 70, { version: 7, versionNonce: 99, points: [[0, 0], [3, 4]] });
  const local = toPageLocal(layout, el, 2);
  assert.equal(local.x, 50 - pageRect(layout, 2).x);
  assert.equal(local.y, 70);
  assert.equal(local.version, 7);
  assert.equal(local.versionNonce, 99);
  assert.deepEqual(local.points, el.points);
  assert.deepEqual(toScene(layout, local, 2), el);
  assert.equal(el.y, pageRect(layout, 2).y + 70, 'the original is not mutated');
});

test('elements are bucketed per page, and old erasures are dropped', () => {
  const layout = layoutOf(null);
  const now = Date.now();
  const els = [
    stroke('a', 20, 20),
    stroke('b', 20, pageRect(layout, 1).y + 5),
    stroke('c', 30, 30),
    stroke('old-erased', 20, 20, { isDeleted: true, updated: now - 20 * 24 * 3600 * 1000 }),
    stroke('fresh-erased', 20, 20, { isDeleted: true, updated: now - 1000, version: 3 }),
  ];
  const buckets = bucketElements(layout, els, now);
  assert.deepEqual([...buckets.keys()].sort(), ['p0', 'p1']);
  assert.deepEqual(buckets.get('p0').map((e) => e.id), ['a', 'c', 'fresh-erased']);
  assert.equal(buckets.get('p1')[0].y, 5);
  // Erased strokes with no timestamp are kept (can't tell how old they are).
  assert.equal(bucketElements(layout, [stroke('z', 1, 1, { isDeleted: true })], now).get('p0').length, 1);
});

test('a signature changes exactly when something on the page changed', () => {
  const a = [stroke('a', 1, 1), stroke('b', 2, 2)];
  assert.equal(signature(a), signature([stroke('a', 1, 1), stroke('b', 2, 2)]));
  assert.notEqual(signature(a), signature([stroke('a', 1, 1), stroke('b', 2, 2, { version: 2 })]));
  assert.notEqual(signature(a), signature([stroke('a', 1, 1)]));
  assert.notEqual(signature(a), signature([stroke('a', 1, 1), stroke('b', 2, 2, { isDeleted: true })]));
});

test('the scene is rebuilt from stored pages; rows for removed pages are skipped', () => {
  const layout = layoutOf(null);
  const rows = new Map([
    ['p0', [stroke('a', 20, 20)]],
    ['p2', [stroke('c', 5, 6)]],
    ['nghost', [stroke('x', 1, 1)]],
  ]);
  const scene = sceneFromRows(layout, rows);
  assert.deepEqual(scene.map((e) => e.id), ['a', 'c']);
  assert.equal(scene[1].y, pageRect(layout, 2).y + 6);
});

test('an element stored on two pages (dragged across) keeps its newest version', () => {
  const layout = layoutOf(null);
  const rows = new Map([
    ['p0', [stroke('m', 10, 10, { version: 2 })]],
    ['p1', [stroke('m', 10, 40, { version: 5 })]],
  ]);
  const scene = sceneFromRows(layout, rows);
  assert.equal(scene.length, 1);
  assert.equal(scene[0].version, 5);
  assert.equal(scene[0].y, pageRect(layout, 1).y + 40);
});

test('inserting a note page shifts later ink down but keeps it on its own page', () => {
  const before = layoutOf(null);
  const withNote = makeLayout(
    buildPages(3, [[3, 600, 800]], [{ t: 'p', i: 0 }, { t: 'n', id: 'note-1', w: 420, h: 595, s: 'lined', u: 1 }, { t: 'p', i: 1 }, { t: 'p', i: 2 }])
  );
  const onP0 = stroke('p0-ink', 30, 40);
  const onP1 = stroke('p1-ink', 30, pageRect(before, 1).y + 50);
  const onP2 = stroke('p2-ink', 30, pageRect(before, 2).y + 60);
  const moved = relayout(before, withNote, [onP0, onP1, onP2]);
  assert.equal(moved[0].y, onP0.y, 'page 0 did not move');
  const idx = (key) => withNote.pages.findIndex((p) => p.key === key);
  assert.equal(moved[1].y, pageRect(withNote, idx('p1')).y + 50);
  assert.equal(moved[2].y, pageRect(withNote, idx('p2')).y + 60);
  assert.equal(moved[1].version, onP1.version);
  // And bucketing against the new layout finds each stroke on the same page as before.
  const buckets = bucketElements(withNote, moved);
  assert.deepEqual(buckets.get('p1').map((e) => [e.id, e.y]), [['p1-ink', 50]]);
  assert.deepEqual(buckets.get('p2').map((e) => [e.id, e.y]), [['p2-ink', 60]]);
  // Going back restores the original coordinates exactly.
  const back = relayout(withNote, before, moved);
  assert.deepEqual(back.map((e) => e.y), [onP0.y, onP1.y, onP2.y]);
  assert.ok(PX_PER_PT > 1);
});

test('reordering pages carries each page\'s ink along with it', () => {
  const before = layoutOf(null);
  const after = makeLayout(buildPages(3, [[3, 600, 800]], [{ t: 'p', i: 0 }, { t: 'p', i: 2 }, { t: 'p', i: 1 }]));
  const el = stroke('q', 30, pageRect(before, 1).y + 20);
  const [moved] = relayout(before, after, [el]);
  assert.equal(pageOfElement(after, moved), after.pages.findIndex((p) => p.key === 'p1'));
});

test('ink on a page that left the layout (a deleted note page) is dropped from the scene', () => {
  const withNote = makeLayout(buildPages(2, [[2, 600, 800]], [{ t: 'p', i: 0 }, { t: 'n', id: 'note-1', w: 420, h: 595, s: 'lined', u: 1 }, { t: 'p', i: 1 }]));
  const without = makeLayout(buildPages(2, [[2, 600, 800]], [{ t: 'p', i: 0 }, { t: 'n', id: 'note-1', w: 420, h: 595, s: 'lined', u: 2, del: true }, { t: 'p', i: 1 }]));
  const onNote = stroke('on-note', 30, pageRect(withNote, 1).y + 20);
  const onP1 = stroke('on-p1', 30, pageRect(withNote, 2).y + 20);
  const out = relayout(withNote, without, [onNote, onP1]);
  assert.deepEqual(out.map((e) => e.id), ['on-p1']);
  assert.equal(pageOfElement(without, out[0]), 1);
});
