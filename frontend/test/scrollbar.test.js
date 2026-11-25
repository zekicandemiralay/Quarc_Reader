// Run: npm test (from frontend/)
// The desktop scroll bar: where the thumb is, how big, and where a drag leads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPages, makeLayout, clampStackView, INSETS } from '../src/reader/geometry.js';
import { stackProgress, stackScrollY, bookProgress, bookPageAt, thumbBox, progressAt, dragTop, MIN_THUMB } from '../src/reader/scrollbar.js';

const layoutOf = (count) => makeLayout(buildPages(count, [[count, 595, 842]], null));
const rect = { width: 1280, height: 900 };

test('at the top of the document the thumb is at the top, at the bottom it is at the bottom', () => {
  const layout = layoutOf(30);
  const zoom = 1.5;
  const top = stackProgress({ zoom, scrollY: INSETS.top / zoom }, rect, layout);
  assert.equal(top.progress, 0);
  const bottomY = (rect.height - INSETS.bottom) / zoom - layout.totalH;
  assert.ok(Math.abs(stackProgress({ zoom, scrollY: bottomY }, rect, layout).progress - 1) < 1e-9);
  const middle = stackProgress({ zoom, scrollY: (INSETS.top / zoom + bottomY) / 2 }, rect, layout);
  assert.ok(Math.abs(middle.progress - 0.5) < 1e-9);
});

test('the thumb is as big as the share of the document that is on screen', () => {
  const few = stackProgress({ zoom: 1, scrollY: INSETS.top }, rect, layoutOf(3));
  const many = stackProgress({ zoom: 1, scrollY: INSETS.top }, rect, layoutOf(300));
  assert.ok(few.visible > many.visible * 50);
  assert.ok(many.visible < 0.01);
  assert.ok(Math.abs(few.visible - (rect.height - INSETS.top - INSETS.bottom) / layoutOf(3).totalH) < 1e-9);
});

test('a document that fits on the screen has no scroll bar', () => {
  const small = makeLayout(buildPages(1, [[1, 200, 200]], null));
  assert.equal(stackProgress({ zoom: 1, scrollY: INSETS.top }, rect, small), null);
  assert.equal(stackProgress({ zoom: 1, scrollY: 0 }, rect, makeLayout([])), null);
});

test('dragging maps back: progress -> scrollY -> progress, and the view never leaves the document', () => {
  const layout = layoutOf(40);
  const zoom = 1.25;
  for (const p of [0, 0.1, 0.5, 0.77, 1]) {
    const y = stackScrollY(p, zoom, rect, layout);
    assert.ok(Math.abs(stackProgress({ zoom, scrollY: y }, rect, layout).progress - p) < 1e-9, `progress ${p}`);
    // the same position the reader itself would allow
    assert.ok(Math.abs(clampStackView(0, y, zoom, rect, layout).scrollY - y) < 1e-9, `inside the document at ${p}`);
  }
  assert.equal(stackScrollY(-5, zoom, rect, layout), stackScrollY(0, zoom, rect, layout));
  assert.equal(stackScrollY(9, zoom, rect, layout), stackScrollY(1, zoom, rect, layout));
});

test('book mode: the thumb is a page slider', () => {
  assert.equal(bookProgress(0, 10), 0);
  assert.equal(bookProgress(9, 10), 1);
  assert.equal(bookProgress(0, 1), 0);
  assert.equal(bookPageAt(0, 10), 0);
  assert.equal(bookPageAt(1, 10), 9);
  assert.equal(bookPageAt(0.5, 11), 5);
  for (let i = 0; i < 25; i++) assert.equal(bookPageAt(bookProgress(i, 25), 25), i, `page ${i} comes back`);
  assert.equal(bookPageAt(2, 5), 4);
  assert.equal(bookPageAt(0.3, 0), 0);
});

test('the thumb never gets tiny and never leaves the track', () => {
  const track = 800;
  assert.equal(thumbBox(0.5, 0.0001, track).h, MIN_THUMB);
  assert.equal(thumbBox(0, 1, track).h, track);
  assert.equal(thumbBox(1, 0.1, track).top + thumbBox(1, 0.1, track).h, track);
  assert.equal(thumbBox(0, 0.1, track).top, 0);
  assert.equal(thumbBox(-1, 0.1, track).top, 0);
  assert.equal(thumbBox(2, 0.1, track).top + thumbBox(2, 0.1, track).h, track);
});

test('a thumb position stands for a progress, and the drag keeps its grip', () => {
  const track = 800;
  const h = 100;
  assert.equal(progressAt(0, h, track), 0);
  assert.equal(progressAt(700, h, track), 1);
  assert.equal(progressAt(350, h, track), 0.5);
  assert.equal(progressAt(5, 800, 800), 0, 'a thumb as long as the track cannot move');
  // grabbed 30 px below the thumb's top: the thumb follows the pointer at that offset
  assert.equal(dragTop(430, 30, h, track), 400);
  assert.equal(dragTop(10, 30, h, track), 0, 'not above the track');
  assert.equal(dragTop(790, 30, h, track), 700, 'not below it');
});
