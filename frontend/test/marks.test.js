// Run: npm test (from frontend/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newMark, activeMarks, mergeMarks, updateMark, deleteMark, mergeLineRects, hitMark, pointInRects, markBounds, markChanges, restoreMarks } from '../src/reader/marks.js';

const r = (x, y, w, h) => ({ x, y, w, h });

test('the browser\'s many small selection rectangles become one per line', () => {
  // Line 1: three fragments, one overlapping; line 2: one fragment; plus a sliver that is dropped.
  const lines = mergeLineRects([r(10, 100, 40, 12), r(50, 100, 30, 12), r(78, 101, 40, 11), r(10, 120, 60, 12), r(200, 100, 0.5, 12)]);
  assert.deepEqual(lines, [[10, 100, 108, 12], [10, 120, 60, 12]]);
});

test('rectangles on the same line but far apart stay separate; different lines never merge', () => {
  assert.equal(mergeLineRects([r(10, 100, 20, 12), r(200, 100, 20, 12)]).length, 2);
  assert.equal(mergeLineRects([r(10, 100, 100, 12), r(10, 113, 100, 12)]).length, 2);
});

test('marks merge by id: newer wins, ties keep the first, old deletions are dropped', () => {
  const now = Date.now();
  const a = { id: 'a', u: now - 10, note: 'old' };
  const merged = mergeMarks([a, { id: 'gone', u: now - 40 * 24 * 3600 * 1000, del: true }], [{ id: 'a', u: now, note: 'new' }, { id: 'b', u: 1 }], now);
  assert.equal(merged.find((m) => m.id === 'a').note, 'new');
  assert.ok(merged.find((m) => m.id === 'b'));
  assert.equal(merged.find((m) => m.id === 'gone'), undefined);
  // A stale copy never undoes a newer edit.
  assert.equal(mergeMarks([{ id: 'a', u: 50, note: 'edited' }], [{ id: 'a', u: 10, note: 'stale' }]).find((m) => m.id === 'a').note, 'edited');
});

test('editing bumps the timestamp and deleting leaves a tombstone', () => {
  const m = newMark({ type: 'hl', rects: [[0, 0, 10, 10]], text: 'hello' });
  assert.match(m.id, /^[0-9a-f-]{36}$/);
  const before = m.u;
  const edited = updateMark([m], m.id, { note: 'why?' })[0];
  assert.equal(edited.note, 'why?');
  assert.ok(edited.u >= before);
  const removed = deleteMark([edited], m.id);
  assert.equal(removed[0].del, true);
  assert.deepEqual(activeMarks(removed), []);
});

test('a long selection text is capped', () => {
  assert.equal(newMark({ rects: [[0, 0, 1, 1]], text: 'x'.repeat(5000) }).text.length, 2000);
});

test('hit-testing finds the topmost live mark under a point', () => {
  const lower = { id: 'lower', u: 1, rects: [[0, 0, 100, 20]] };
  const upper = { id: 'upper', u: 2, rects: [[50, 0, 100, 20]] };
  const dead = { id: 'dead', u: 3, del: true, rects: [[0, 0, 500, 500]] };
  assert.equal(hitMark([lower, upper, dead], 60, 10).id, 'upper');
  assert.equal(hitMark([lower, upper, dead], 10, 10).id, 'lower');
  assert.equal(hitMark([lower, upper, dead], 400, 400), null);
  assert.equal(pointInRects([[0, 0, 10, 10]], 11, 5, 2), true);
  assert.deepEqual(markBounds({ rects: [[10, 10, 20, 5], [5, 30, 40, 5]] }), { x: 5, y: 10, w: 40, h: 25 });
});

// ----- undo ---------------------------------------------------------------------------

const hl = (id, extra = {}) => ({ id, u: 100, type: 'hl', color: '#ffd43b', rects: [[0, 0, 10, 10]], text: id, ...extra });

test('marks that differ between two lists are found, timestamps ignored', () => {
  const a = hl('a');
  const b = hl('b');
  assert.deepEqual(markChanges([a], [a, b]).ids, ['b']); // created
  assert.deepEqual(markChanges([a, b], [a]).ids, ['b']); // vanished
  assert.deepEqual(markChanges([a, b], [a, { ...b, u: 500 }]).ids, [], 'only the timestamp moved');
  assert.deepEqual(markChanges([a, b], [a, { ...b, note: 'hi' }]).ids, ['b']); // edited
  assert.deepEqual(markChanges([a, b], [a, deleteMark([b], 'b')[0]]).ids, ['b']); // deleted
  assert.deepEqual(markChanges(undefined, undefined).ids, []);
});

test('undoing a created mark deletes it as a tombstone newer than the mark, redo brings it back', () => {
  const a = hl('a');
  const after = [a];
  const { ids, before, after: snapAfter } = markChanges([], after);
  const undone = restoreMarks(after, ids, before, 1000);
  assert.equal(undone.length, 1, 'kept as a tombstone, so the deletion reaches other devices');
  assert.equal(undone[0].del, true);
  assert.ok(undone[0].u > a.u);
  const redone = restoreMarks(undone, ids, snapAfter, 2000);
  assert.equal(redone[0].del, undefined);
  assert.ok(redone[0].u > undone[0].u, 'newer than the tombstone: it wins the merge');
  assert.equal(activeMarks(redone).length, 1);
});

test('undoing an edit puts the old words back, undoing a delete brings the mark back', () => {
  const a = hl('a', { note: 'first' });
  const edited = [{ ...a, note: 'second', u: 200 }];
  const e = markChanges([a], edited);
  const undoneEdit = restoreMarks(edited, e.ids, e.before, 1000);
  assert.equal(undoneEdit[0].note, 'first');
  assert.ok(undoneEdit[0].u > 200);

  const deleted = deleteMark([a], 'a');
  const d = markChanges([a], deleted);
  const undoneDelete = restoreMarks(deleted, d.ids, d.before, 1000);
  assert.equal(undoneDelete[0].del, undefined);
  assert.equal(activeMarks(undoneDelete).length, 1);
});

test('an undo touches only the marks of its step', () => {
  const a = hl('a');
  const b = hl('b');
  const c = hl('c', { u: 300 });
  const { ids, before } = markChanges([a], [a, b]);
  const out = restoreMarks([a, b, c], ids, before, 1000);
  assert.equal(out.find((m) => m.id === 'a').u, 100, 'untouched');
  assert.equal(out.find((m) => m.id === 'c').u, 300, 'a mark added since is left alone');
  assert.equal(out.find((m) => m.id === 'b').del, true);
});

test('the merge keeps an undone mark undone: the tombstone beats the older live copy', () => {
  const a = hl('a');
  const { ids, before } = markChanges([], [a]);
  const tomb = restoreMarks([a], ids, before, 5000);
  // another device still has the live mark (u 100) and merges the tombstone in
  const merged = mergeMarks([a], tomb, 6000);
  assert.equal(activeMarks(merged).length, 0);
});
