// Run: npm test (from frontend/)
// What changed in the drawing, and putting it back: by page, so it survives pages being inserted above.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPages, makeLayout, pageRect } from '../src/reader/geometry.js';
import { snapshotScene, diffScene, applyInkChanges, sameContent } from '../src/reader/inkDiff.js';

const layoutOf = (items) => makeLayout(buildPages(3, [[3, 600, 800]], items));
const stroke = (id, x, y, extra = {}) => ({ id, type: 'freedraw', x, y, width: 10, height: 10, version: 1, versionNonce: 1, isDeleted: false, points: [[0, 0], [10, 10]], ...extra });
const byId = (els, id) => els.find((e) => e.id === id);

test('a new stroke is a change that did not exist before, kept page-locally', () => {
  const layout = layoutOf(null);
  const last = snapshotScene(layout, []);
  const y1 = pageRect(layout, 1).y;
  const { changes, next } = diffScene(layout, [stroke('a', 50, y1 + 70)], last);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].before, null);
  assert.equal(changes[0].afterKey, 'p1');
  assert.equal(changes[0].after.y, 70, 'page-local, not scene');
  assert.ok(next.has('a'));
});

test('nothing changed means no change, and a version moving alone is not the person\'s doing', () => {
  const layout = layoutOf(null);
  const els = [stroke('a', 20, 20)];
  const last = snapshotScene(layout, els);
  assert.deepEqual(diffScene(layout, els, last).changes, []);
  const bumped = [{ ...els[0], version: 2, versionNonce: 5, updated: 123, index: 'a1' }];
  const r = diffScene(layout, bumped, last);
  assert.deepEqual(r.changes, []);
  assert.equal(r.next.get('a').el.version, 2, 'but what is seen is kept up to date');
});

test('a moved, recoloured or erased element is a change with its old state', () => {
  const layout = layoutOf(null);
  const els = [stroke('a', 20, 20)];
  const last = snapshotScene(layout, els);
  const moved = diffScene(layout, [{ ...els[0], x: 80, version: 2 }], last).changes[0];
  assert.equal(moved.before.x, 20);
  assert.equal(moved.after.x, 80);
  const recoloured = diffScene(layout, [{ ...els[0], strokeColor: '#e03131', version: 2 }], last).changes[0];
  assert.equal(recoloured.before.strokeColor, undefined);
  assert.equal(recoloured.after.strokeColor, '#e03131');
  const erased = diffScene(layout, [{ ...els[0], isDeleted: true, version: 2 }], last).changes[0];
  assert.equal(erased.before.isDeleted, false);
  assert.equal(erased.after.isDeleted, true);
});

test('dragging an element onto another page is a change of page', () => {
  const layout = layoutOf(null);
  const last = snapshotScene(layout, [stroke('a', 20, 20)]);
  const c = diffScene(layout, [stroke('a', 20, pageRect(layout, 2).y + 30, { version: 2 })], last).changes[0];
  assert.equal(c.beforeKey, 'p0');
  assert.equal(c.afterKey, 'p2');
});

test('undo of a new stroke deletes it, redo brings it back, with a higher version each time', () => {
  const layout = layoutOf(null);
  const els = [stroke('a', 20, 20, { version: 3 })];
  const { changes } = diffScene(layout, els, snapshotScene(layout, []));
  const undone = applyInkChanges(layout, els, changes, 'undo', 1000).elements;
  assert.equal(byId(undone, 'a').isDeleted, true);
  assert.ok(byId(undone, 'a').version > 3);
  const redone = applyInkChanges(layout, undone, changes, 'redo', 2000).elements;
  assert.equal(byId(redone, 'a').isDeleted, false);
  assert.equal(byId(redone, 'a').x, 20);
  assert.ok(byId(redone, 'a').version > byId(undone, 'a').version, 'newer than the deletion: it wins when synced');
});

test('undo of an erase brings the stroke back, undo of a move puts it back', () => {
  const layout = layoutOf(null);
  const base = [stroke('a', 20, 20)];
  const last = snapshotScene(layout, base);
  const erasedScene = [{ ...base[0], isDeleted: true, version: 2 }];
  const erase = diffScene(layout, erasedScene, last).changes;
  const back = applyInkChanges(layout, erasedScene, erase, 'undo').elements;
  assert.equal(byId(back, 'a').isDeleted, false);
  assert.ok(byId(back, 'a').version > 2);
  const movedScene = [{ ...base[0], x: 200, y: 300, version: 2 }];
  const move = diffScene(layout, movedScene, last).changes;
  const home = applyInkChanges(layout, movedScene, move, 'undo').elements;
  assert.equal(byId(home, 'a').x, 20);
  assert.equal(byId(home, 'a').y, 20);
});

test('a step recorded before a page was inserted still puts its ink on the right page', () => {
  const before = layoutOf(null); // p0 p1 p2
  const y2 = pageRect(before, 2).y;
  const els = [stroke('s', 40, y2 + 100)]; // drawn on page 3 (index 2)
  const { changes } = diffScene(before, els, snapshotScene(before, []));

  // a note page is inserted after page 1: page 3 moves down
  const after = layoutOf([{ t: 'p', i: 0 }, { t: 'n', id: 'n1', w: 595, h: 842, s: 'lined', u: 1 }, { t: 'p', i: 1 }, { t: 'p', i: 2 }]);
  assert.equal(after.pages[3].key, 'p2');
  const shiftedScene = [{ ...els[0], y: pageRect(after, 3).y + 100 }];

  // the stroke is erased by undo (it was drawn on p2) and brought back by redo — on p2 in the NEW layout
  const undone = applyInkChanges(after, shiftedScene, changes, 'undo').elements;
  assert.equal(byId(undone, 's').isDeleted, true);
  const redone = applyInkChanges(after, undone, changes, 'redo').elements;
  assert.equal(byId(redone, 's').y, pageRect(after, 3).y + 100, 'on page 3 of the new layout, not where the old layout had it');
  assert.equal(byId(redone, 's').isDeleted, false);
});

test('a change on a page that is gone is skipped, not put somewhere else', () => {
  const full = layoutOf([{ t: 'p', i: 0 }, { t: 'n', id: 'n1', w: 595, h: 842, s: 'lined', u: 1 }, { t: 'p', i: 1 }, { t: 'p', i: 2 }]);
  const noteKey = full.pages[1].key;
  const els = [stroke('w', 30, pageRect(full, 1).y + 30)];
  const { changes } = diffScene(full, els, snapshotScene(full, []));
  assert.equal(changes[0].afterKey, noteKey);
  const withoutNote = layoutOf(null);
  const r = applyInkChanges(withoutNote, [], changes, 'redo');
  assert.equal(r.skipped, 1);
  assert.deepEqual(r.elements, []);
});

test('an element that was dropped from the scene is added back when its step is undone', () => {
  const layout = layoutOf(null);
  const gone = stroke('g', 20, 20, { isDeleted: true, version: 2 });
  const live = { ...gone, isDeleted: false, version: 1 };
  const changes = [{ id: 'g', before: toLocal(live), beforeKey: 'p0', after: toLocal(gone), afterKey: 'p0' }];
  const r = applyInkChanges(layout, [], changes, 'undo').elements;
  assert.equal(r.length, 1);
  assert.equal(r[0].isDeleted, false);
  function toLocal(el) {
    return { ...el };
  }
});

test('content comparison ignores Excalidraw\'s bookkeeping and compares points by value', () => {
  assert.equal(sameContent(stroke('a', 1, 1), stroke('a', 1, 1, { version: 9, versionNonce: 3, updated: 5, index: 'x' })), true);
  assert.equal(sameContent(stroke('a', 1, 1), stroke('a', 1, 1, { points: [[0, 0], [10, 10]] })), true);
  assert.equal(sameContent(stroke('a', 1, 1), stroke('a', 1, 1, { points: [[0, 0], [10, 11]] })), false);
  assert.equal(sameContent(stroke('a', 1, 1), stroke('a', 2, 1)), false);
});

test('a stroke that never lived (the pencil\'s stroke that became a text highlight) is not a step', () => {
  const layout = layoutOf(null);
  const empty = snapshotScene(layout, []);
  assert.deepEqual(diffScene(layout, [stroke('t', 20, 20, { isDeleted: true })], empty).changes, []);
  assert.ok(diffScene(layout, [stroke('t', 20, 20, { isDeleted: true })], empty).next.has('t'), 'but it is remembered');
  // erasing a live stroke is a step
  const live = [stroke('a', 20, 20)];
  assert.equal(diffScene(layout, [{ ...live[0], isDeleted: true, version: 2 }], snapshotScene(layout, live)).changes.length, 1);
  // a stroke that was already gone and only moves about is not
  const gone = [stroke('b', 20, 20, { isDeleted: true })];
  assert.deepEqual(diffScene(layout, [{ ...gone[0], x: 90, version: 2 }], snapshotScene(layout, gone)).changes, []);
});
