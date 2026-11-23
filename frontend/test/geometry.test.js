// Run: npm test (from frontend/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PX_PER_PT,
  PAGE_GAP,
  INSETS,
  compressSizes,
  expandSizes,
  buildPages,
  layoutItemsFor,
  makeLayout,
  pageRect,
  pageAtY,
  pageUnder,
  clampStackView,
  clampPageView,
  viewForPage,
  visiblePages,
  currentPage,
  pageOffset,
  viewForPosition,
  fitPageZoom,
  fitWidthZoom,
} from '../src/reader/geometry.js';

const screen = { width: 800, height: 1000 };

test('page sizes round-trip through run-length encoding', () => {
  const sizes = [[595, 842], [595, 842], [595, 842], [842, 595], [595, 842]];
  const runs = compressSizes(sizes);
  assert.deepEqual(runs, [[3, 595, 842], [1, 842, 595], [1, 595, 842]]);
  assert.deepEqual(expandSizes(runs, 5), sizes);
  // Sizes not measured yet fall back to the first page's.
  assert.deepEqual(expandSizes([[2, 600, 800]], 4), [[600, 800], [600, 800], [600, 800], [600, 800]]);
  assert.equal(expandSizes([], 2)[0][0], 595);
});

test('a plain PDF is its pages in order, in scene px', () => {
  const pages = buildPages(3, [[3, 600, 800]], null);
  assert.deepEqual(pages.map((p) => p.key), ['p0', 'p1', 'p2']);
  assert.equal(pages[0].w, 600 * PX_PER_PT);
  assert.equal(pages[0].h, 800 * PX_PER_PT);
});

test('note pages slot in, deleted ones disappear, and no PDF page is ever dropped', () => {
  const items = [
    { t: 'p', i: 0 },
    { t: 'n', id: 'aaaa', w: 400, h: 500, s: 'dotted', u: 1 },
    { t: 'p', i: 1 },
    { t: 'n', id: 'gone', w: 400, h: 500, s: 'lined', u: 2, del: true },
  ];
  const pages = buildPages(3, [[3, 600, 800]], items);
  assert.deepEqual(pages.map((p) => p.key), ['p0', 'naaaa', 'p1', 'p2']); // p2 was missing from the layout: appended
  assert.equal(pages[1].style, 'dotted');
  assert.equal(pages[1].w, 400 * PX_PER_PT);
  // Page indexes past the document's real page count are ignored.
  assert.deepEqual(buildPages(1, [[1, 600, 800]], [{ t: 'p', i: 0 }, { t: 'p', i: 7 }]).map((p) => p.key), ['p0']);
});

test('layoutItemsFor writes the page list back, keeping tombstones', () => {
  const pages = buildPages(2, [[2, 600, 800]], [{ t: 'p', i: 0 }, { t: 'n', id: 'aaaa', w: 400, h: 500, s: 'lined', u: 5 }, { t: 'p', i: 1 }]);
  const tomb = { t: 'n', id: 'gone', w: 1, h: 1, s: 'lined', u: 9, del: true };
  const items = layoutItemsFor(pages, [tomb]);
  assert.deepEqual(items.map((it) => (it.t === 'p' ? `p${it.i}` : it.id)), ['p0', 'aaaa', 'p1', 'gone']);
  assert.equal(items[1].w, 400);
});

test('the stack puts pages one under another, centred, with a gap', () => {
  const pages = buildPages(3, [[1, 600, 800], [1, 400, 500], [1, 600, 800]], null);
  const layout = makeLayout(pages);
  const w0 = 600 * PX_PER_PT;
  assert.equal(layout.maxW, w0);
  assert.equal(layout.tops[0], 0);
  assert.equal(layout.tops[1], 800 * PX_PER_PT + PAGE_GAP);
  assert.equal(layout.lefts[1], (w0 - 400 * PX_PER_PT) / 2); // narrower page is centred
  assert.equal(layout.totalH, layout.tops[2] + 800 * PX_PER_PT);
  assert.deepEqual(pageRect(layout, 1), { x: layout.lefts[1], y: layout.tops[1], width: 400 * PX_PER_PT, height: 500 * PX_PER_PT });
});

test('which page a point is on: the gap below belongs to the page above, the desk to nobody', () => {
  const layout = makeLayout(buildPages(3, [[3, 600, 800]], null));
  const h = 800 * PX_PER_PT;
  assert.equal(pageAtY(layout, -500), 0);
  assert.equal(pageAtY(layout, h / 2), 0);
  assert.equal(pageAtY(layout, h + PAGE_GAP / 4), 0);
  assert.equal(pageAtY(layout, h + PAGE_GAP * 0.75), 1);
  assert.equal(pageAtY(layout, layout.totalH + 999), 2);
  assert.equal(pageUnder(layout, 10, 10), 0);
  assert.equal(pageUnder(layout, 10, h + PAGE_GAP / 2), -1); // in the gap
  assert.equal(pageUnder(layout, -5, 10), -1); // left of the paper
  assert.equal(pageUnder(layout, 10, layout.tops[2] + 10), 2);
  assert.equal(pageUnder(makeLayout([]), 0, 0), -1);
});

test('stack view: stays on screen, narrow content is centred, short content is centred', () => {
  const layout = makeLayout(buildPages(10, [[10, 600, 800]], null));
  const zoom = 1;
  // Dragged far down / up: pinned to the first/last page's edge.
  assert.equal(clampStackView(0, 5000, zoom, screen, layout).scrollY, INSETS.top / zoom);
  const bottom = clampStackView(0, -1e9, zoom, screen, layout).scrollY;
  assert.equal(bottom, (screen.height - INSETS.bottom) / zoom - layout.totalH);
  // A page wider than the free area can't be dragged past the side insets…
  assert.equal(clampStackView(123, 0, zoom, screen, layout).scrollX, INSETS.side / zoom);
  // …a page narrower than the screen is horizontally centred whatever scrollX was.
  const narrow = makeLayout(buildPages(10, [[10, 300, 400]], null));
  const c = clampStackView(123, 0, zoom, screen, narrow);
  assert.equal(c.scrollX, (INSETS.side + (screen.width - 2 * INSETS.side) / 2) / zoom - narrow.maxW / 2);
  // A one-page document that fits is centred vertically.
  const one = makeLayout(buildPages(1, [[1, 300, 300]], null));
  const v = clampStackView(0, 0, 1, screen, one);
  assert.equal(v.scrollY, (INSETS.top + (screen.height - INSETS.top - INSETS.bottom) / 2) - one.totalH / 2);
});

test('book view: showing a page centres it when it fits and starts at its top when it does not', () => {
  const layout = makeLayout(buildPages(5, [[5, 600, 800]], null));
  const fit = fitPageZoom(screen, layout.pages[0].w, layout.pages[0].h);
  const v = viewForPage(layout, 2, fit, screen);
  const r = pageRect(layout, 2);
  // The page's centre is at the middle of the free area.
  const cy = (r.y + r.height / 2 + v.scrollY) * v.zoom;
  assert.ok(Math.abs(cy - (INSETS.top + (screen.height - INSETS.top - INSETS.bottom) / 2)) < 1);
  const cx = (r.x + r.width / 2 + v.scrollX) * v.zoom;
  assert.ok(Math.abs(cx - screen.width / 2) < 1);
  // Zoomed in so the page is taller than the screen: top edge at the inset.
  const big = viewForPage(layout, 2, fit * 2, screen);
  assert.ok(Math.abs((r.y + big.scrollY) * big.zoom - INSETS.top) < 1);
  // Book view never lets you scroll to the neighbouring page.
  const clamped = clampPageView(0, -1e9, fit * 2, screen, layout, 2);
  assert.ok((r.y + r.height + clamped.scrollY) * fit * 2 >= screen.height - INSETS.bottom - 0.5);
});

test('fit zooms', () => {
  assert.equal(fitWidthZoom({ width: 832, height: 600 }, 800), 1);
  assert.equal(fitPageZoom({ width: 832, height: 10000 }, 800, 400), 1); // width-limited
  assert.ok(fitPageZoom({ width: 5000, height: 464 }, 800, 800) < 1); // height-limited
});

test('visible pages, the page being read, and reading position', () => {
  const layout = makeLayout(buildPages(20, [[20, 600, 800]], null));
  const h = 800 * PX_PER_PT;
  const zoom = 0.5;
  // Viewing the top.
  const top = { zoom, scrollX: 0, scrollY: 0 };
  assert.deepEqual(visiblePages(layout, top, screen), [0, 1]);
  assert.equal(currentPage(layout, top, screen), 0);
  // Scrolled so the middle of the screen is mid-page 7.
  const target = layout.tops[7] + h / 2;
  const view = { zoom, scrollX: 0, scrollY: screen.height / 2 / zoom - target };
  assert.equal(currentPage(layout, view, screen), 7);
  assert.ok(Math.abs(pageOffset(layout, view, screen, 7) - 0.5) < 1e-9);
  assert.ok(visiblePages(layout, view, screen).includes(7));
  // Restoring a saved position puts the same spot at the middle again.
  const back = viewForPosition(layout, 7, 0.5, zoom, screen);
  assert.equal(currentPage(layout, back, screen), 7);
  assert.ok(Math.abs(pageOffset(layout, back, screen, 7) - 0.5) < 0.001);
  // Position beyond the ends is clamped instead of showing nothing.
  const end = viewForPosition(layout, 19, 1, zoom, screen);
  assert.deepEqual(visiblePages(layout, end, screen).includes(19), true);
});
