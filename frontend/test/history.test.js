// Run: npm test (from frontend/)
// The undo timeline: steps in order, redo, batching, and steps that run one after the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../src/reader/history.js';

// A step that logs what it does.
const step = (log, name, { delay = 0 } = {}) => ({
  undo: async () => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    log.push(`undo ${name}`);
  },
  redo: async () => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    log.push(`redo ${name}`);
  },
});

test('undo takes steps back in the reverse order, redo forward again', async () => {
  const h = new History();
  const log = [];
  h.record(step(log, 'stroke'));
  h.record(step(log, 'highlight'));
  h.record(step(log, 'note page'));
  assert.equal(await h.undo(), true);
  assert.equal(await h.undo(), true);
  assert.equal(await h.undo(), true);
  assert.equal(await h.undo(), false); // nothing left
  assert.deepEqual(log, ['undo note page', 'undo highlight', 'undo stroke']);
  log.length = 0;
  await h.redo();
  await h.redo();
  assert.deepEqual(log, ['redo stroke', 'redo highlight']);
  assert.equal(h.canUndo, true);
  assert.equal(h.canRedo, true);
});

test('a new step removes what could have been redone', async () => {
  const h = new History();
  const log = [];
  h.record(step(log, 'a'));
  h.record(step(log, 'b'));
  await h.undo();
  assert.equal(h.canRedo, true);
  h.record(step(log, 'c'));
  assert.equal(h.canRedo, false);
  assert.equal(await h.redo(), false);
  log.length = 0;
  await h.undo();
  await h.undo();
  assert.deepEqual(log, ['undo c', 'undo a']);
});

test('everything recorded in a batch is one step, undone in reverse', async () => {
  const h = new History();
  const log = [];
  h.record(step(log, 'before'));
  h.batch(() => {
    h.record(step(log, 'ink'));
    h.record(step(log, 'marks'));
  });
  await h.undo();
  assert.deepEqual(log, ['undo marks', 'undo ink']);
  assert.equal(h.undoStack.length, 1, 'the earlier step is still there');
  log.length = 0;
  await h.redo();
  assert.deepEqual(log, ['redo ink', 'redo marks']);
});

test('a batch of one is just that step, an empty batch is nothing, batches nest', async () => {
  const h = new History();
  const log = [];
  h.batch(() => h.record(step(log, 'only')));
  h.batch(() => {});
  assert.equal(h.undoStack.length, 1);
  h.batch(() => {
    h.batch(() => {
      h.record(step(log, 'x'));
      h.record(step(log, 'y'));
    });
  });
  assert.equal(h.undoStack.length, 2);
  await h.undo();
  assert.deepEqual(log, ['undo y', 'undo x']);
});

test('quick presses run one after the other, even when a step takes time', async () => {
  const h = new History();
  const log = [];
  h.record(step(log, 'slow', { delay: 30 }));
  h.record(step(log, 'fast'));
  const results = await Promise.all([h.undo(), h.undo(), h.undo()]);
  assert.deepEqual(results, [true, true, false]);
  assert.deepEqual(log, ['undo fast', 'undo slow']);
});

test('a step that fails is dropped and does not stop the others', async () => {
  const errors = [];
  const h = new History({ onError: (e) => errors.push(e.message) });
  const log = [];
  h.record(step(log, 'good'));
  h.record({ undo: async () => Promise.reject(new Error('boom')), redo: async () => {} });
  assert.equal(await h.undo(), false);
  assert.deepEqual(errors, ['boom']);
  assert.equal(h.canRedo, false, 'not left on the redo stack half done');
  assert.equal(await h.undo(), true);
  assert.deepEqual(log, ['undo good']);
});

test('the oldest steps are forgotten past the limit', async () => {
  const h = new History({ limit: 3 });
  const log = [];
  for (const n of ['a', 'b', 'c', 'd', 'e']) h.record(step(log, n));
  assert.equal(h.undoStack.length, 3);
  while (await h.undo());
  assert.deepEqual(log, ['undo e', 'undo d', 'undo c']);
});

test('listeners hear about every change, and can stop listening', async () => {
  const h = new History();
  let heard = 0;
  const off = h.subscribe(() => heard++);
  h.record(step([], 'a'));
  await h.undo();
  assert.equal(heard, 2);
  off();
  await h.redo();
  assert.equal(heard, 2);
});
