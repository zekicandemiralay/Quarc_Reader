// Run: npm test (from frontend/)
// The clickable bits of a PDF: which annotations count as links, where they are, where they lead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeUrl, targetOf, linkRect, linksOf, hitLink, destPageIndex, LinkIndex } from '../src/reader/pdfLinks.js';

// A viewport at 4/3 px per point for an 842 pt tall page: PDF y runs up from the bottom, the page's px run down from the top.
const viewport = {
  convertToViewportRectangle: ([x1, y1, x2, y2]) => [(x1 * 4) / 3, ((842 - y1) * 4) / 3, (x2 * 4) / 3, ((842 - y2) * 4) / 3],
  scale: 4 / 3,
};
const link = (extra = {}) => ({ subtype: 'Link', rect: [72, 596, 202, 614], ...extra });

test('only web addresses and mail links may be opened', () => {
  assert.equal(safeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeUrl('  http://example.com  '), 'http://example.com/');
  assert.equal(safeUrl('mailto:me@example.com'), 'mailto:me@example.com');
  for (const bad of ['javascript:alert(1)', 'file:///C:/secret.txt', 'data:text/html,<b>x</b>', 'ftp://example.com', 'not a url', '', null, undefined, 42]) {
    assert.equal(safeUrl(bad), null, String(bad));
  }
});

test('a link annotation becomes an address, a destination, a page action — or nothing', () => {
  assert.deepEqual(targetOf({ url: 'https://example.com/' }), { type: 'url', url: 'https://example.com/' });
  assert.deepEqual(targetOf({ unsafeUrl: 'https://example.com/x' }), { type: 'url', url: 'https://example.com/x' });
  assert.equal(targetOf({ url: 'javascript:alert(1)' }), null, 'a script is not opened');
  assert.equal(targetOf({ unsafeUrl: 'javascript:alert(1)' }), null);
  assert.deepEqual(targetOf({ dest: 'chapter3' }), { type: 'dest', dest: 'chapter3' });
  const explicit = [{ num: 12, gen: 0 }, { name: 'XYZ' }, 0, 842, null];
  assert.deepEqual(targetOf({ dest: explicit }), { type: 'dest', dest: explicit });
  assert.deepEqual(targetOf({ action: 'NextPage' }), { type: 'action', name: 'NextPage' });
  assert.equal(targetOf({ action: 'Print' }), null);
  assert.equal(targetOf({ filename: 'other.pdf', dest: 'x' }), null, 'a jump into another file is not followed');
  assert.equal(targetOf({}), null);
  assert.equal(targetOf(null), null);
});

test('a rectangle in PDF space becomes page-local px, whichever corner it was given from', () => {
  assert.deepEqual(linkRect(viewport, [72, 596, 202, 614]), [96, (842 - 614) * (4 / 3), 130 * (4 / 3), 18 * (4 / 3)]);
  assert.deepEqual(linkRect(viewport, [202, 614, 72, 596]), linkRect(viewport, [72, 596, 202, 614]));
  assert.equal(linkRect(viewport, [10, 10, 10.5, 10.5]), null, 'too small to hit');
  assert.equal(linkRect(viewport, undefined), null);
});

test('a page\'s links are only the link annotations the reader can follow', () => {
  const links = linksOf(viewport, [
    link({ url: 'https://example.com/' }),
    { subtype: 'Widget', rect: [0, 0, 100, 100], url: 'https://nope.example/' },
    link({ url: 'javascript:alert(1)', rect: [72, 500, 202, 520] }),
    link({ dest: 'chapter3', rect: [72, 560, 202, 580] }),
    link({ rect: [72, 400, 202, 420] }), // goes nowhere
  ]);
  assert.equal(links.length, 2);
  assert.deepEqual(links.map((l) => l.target.type), ['url', 'dest']);
  assert.deepEqual(linksOf(viewport, undefined), []);
});

test('the topmost link under a point is found, with a little slack', () => {
  const under = { rect: [0, 0, 100, 40], target: { type: 'url', url: 'https://a.example/' } };
  const over = { rect: [50, 0, 100, 40], target: { type: 'url', url: 'https://b.example/' } };
  assert.equal(hitLink([under, over], 70, 20), over);
  assert.equal(hitLink([under, over], 20, 20), under);
  assert.equal(hitLink([under, over], 300, 20), null);
  assert.equal(hitLink([under], 102, 20), under, '2 px of slack');
  assert.equal(hitLink([under], 110, 20), null);
  assert.equal(hitLink([under], 110, 20, 12), under, 'more for a fingertip');
  assert.equal(hitLink(undefined, 1, 1), null);
});

test('a destination leads to a page: by name, by reference, or by number', async () => {
  const ref = { num: 12, gen: 0 };
  const pdf = {
    getDestination: async (name) => (name === 'chapter3' ? [ref, { name: 'XYZ' }, 0, 842, null] : null),
    getPageIndex: async (r) => (r === ref ? 2 : Promise.reject(new Error('unknown page'))),
  };
  assert.equal(await destPageIndex(pdf, 'chapter3'), 2);
  assert.equal(await destPageIndex(pdf, [ref, { name: 'Fit' }]), 2);
  assert.equal(await destPageIndex(pdf, [4, { name: 'Fit' }]), 4, 'a plain page number');
  assert.equal(await destPageIndex(pdf, 'missing'), -1);
  assert.equal(await destPageIndex(pdf, [{ num: 99, gen: 0 }]), -1);
  assert.equal(await destPageIndex(pdf, []), -1);
});

test('a page\'s links are read once, and a page that cannot be read has none', async () => {
  let reads = 0;
  const pdf = {
    getPage: async (n) => {
      reads++;
      if (n === 3) throw new Error('damaged page');
      return { getViewport: () => viewport, getAnnotations: async () => [link({ url: 'https://example.com/' })] };
    },
  };
  const index = new LinkIndex(pdf);
  assert.equal(index.peek(0), undefined, 'not read yet: a tap does not wait');
  const [a, b] = await Promise.all([index.load(0), index.load(0)]);
  assert.equal(a.length, 1);
  assert.equal(a, b);
  assert.equal(reads, 1);
  assert.equal(index.peek(0).length, 1);
  assert.deepEqual(await index.load(2), []);
  assert.deepEqual(index.peek(2), []);
  index.dispose();
  assert.equal(index.peek(0), undefined);
});
