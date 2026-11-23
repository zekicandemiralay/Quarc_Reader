// Run: npm test (from frontend/)
// Finding text: folding (case, accents, Turkish i, ligatures, whitespace), putting a hit back into the
// page's text items, and numbering the hits of a whole book.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, joinItems, findAll, matchSegments, totalHits, rankOf, firstFrom, stepHit } from '../src/reader/findText.js';

const text = (s, o) => fold(s, o).text;

test('case does not matter', () => {
  assert.equal(text('Call Me ISHMAEL'), 'call me ishmael');
});

test('accents do not matter by default: "cay" finds "çay", Turkish letters included', () => {
  assert.equal(text('Çay ŞİŞE Işık ığ'), 'cay sise isik ig');
  assert.equal(text('café'), 'cafe');
  assert.equal(text('Straße'), 'straße'); // not an accent: stays
});

test('with accents on, letters keep them (and "e" does not match inside "é")', () => {
  assert.equal(text('Çay', { accents: true }), 'çay');
  assert.deepEqual(findAll(text('café', { accents: true }), text('cafe', { accents: true })), []);
  assert.deepEqual(findAll(text('café', { accents: true }), text('café', { accents: true })), [0]);
  // Turkish: İ and ı are letters of their own, not accented i
  assert.notEqual(text('İ', { accents: true }), text('i', { accents: true }));
  assert.notEqual(text('ı', { accents: true }), text('i', { accents: true }));
  assert.equal(text('I', { accents: true }), 'i');
});

test('ligatures and compatibility forms are expanded: "ﬁnal" finds "final"', () => {
  const f = fold('ﬁnal');
  assert.equal(f.text, 'final');
  assert.deepEqual(f.map, [0, 0, 1, 2, 3]); // both letters of the ligature point at it
});

test('whitespace of any kind (a line break too) is one space, none at the ends', () => {
  assert.equal(text('  a \n\t b  c  '), 'a b c');
  const s = '  a \n\t b';
  const f = fold(s);
  assert.equal(f.text, 'a b');
  assert.deepEqual(f.map, [2, 3, s.indexOf('b')]); // the space points at the start of its run
});

test('soft hyphens and zero-width characters vanish', () => {
  assert.equal(text('inter­national'), 'international');
  assert.equal(text('a​b'), 'ab');
});

test('the folded text is the same with and without the map', () => {
  const s = 'Ünïcode ﬂow  with\nlines';
  assert.equal(fold(s, { map: false }).text, fold(s).text);
  assert.equal(fold(s, { map: false }).map, undefined);
});

test('findAll counts non-overlapping hits and respects a limit', () => {
  assert.deepEqual(findAll('aaaa', 'aa'), [0, 2]);
  assert.deepEqual(findAll('abcabcabc', 'bc'), [1, 4, 7]);
  assert.deepEqual(findAll('abcabcabc', 'bc', 2), [1, 4]);
  assert.deepEqual(findAll('abc', ''), []);
  assert.deepEqual(findAll('abc', 'x'), []);
});

// the page "Call me Ishmael.⏎Some years ago" as pdf.js would hand it over
const items = [{ str: 'Call me ' }, { str: 'Ishmael.', hasEOL: true }, { str: 'Some years ago' }];

test('a page is its items joined, a newline after the end of a line', () => {
  const page = joinItems(items);
  assert.equal(page.joined, 'Call me Ishmael.\nSome years ago');
  assert.deepEqual(page.starts, [0, 8, 17]);
  assert.deepEqual(page.lengths, [8, 8, 14]);
});

test('a hit is put back into the items it came from, over a line break too', () => {
  const page = joinItems(items);
  const { text: t, map } = fold(page.joined);
  const needle = text('ishmael. some');
  const [a] = findAll(t, needle);
  assert.deepEqual(matchSegments(page, map, a, a + needle.length), [
    { item: 1, from: 0, to: 8 },
    { item: 2, from: 0, to: 4 },
  ]);
  // inside one item
  const n2 = text('me ish');
  const [b] = findAll(t, n2);
  assert.deepEqual(matchSegments(page, map, b, b + n2.length), [
    { item: 0, from: 5, to: 8 },
    { item: 1, from: 0, to: 3 },
  ]);
});

test('a hit inside a ligature covers the whole ligature', () => {
  const page = joinItems([{ str: 'ofﬁce' }]); // "ofﬁce"
  const { text: t, map } = fold(page.joined);
  assert.equal(t, 'office');
  const [a] = findAll(t, 'fice');
  assert.deepEqual(matchSegments(page, map, a, a + 4), [{ item: 0, from: 2, to: 5 }]);
  // ...even when only half of it is searched for
  const [c] = findAll(t, 'ff');
  assert.deepEqual(matchSegments(page, map, c, c + 2), [{ item: 0, from: 1, to: 3 }]);
});

test('empty items do not confuse the mapping', () => {
  const page = joinItems([{ str: 'ab' }, { str: '' }, { str: 'cd', hasEOL: true }, { str: '' }, { str: 'ef' }]);
  const { text: t, map } = fold(page.joined);
  assert.equal(t, 'abcd ef');
  const [a] = findAll(t, 'bcd e');
  assert.deepEqual(matchSegments(page, map, a, a + 5), [
    { item: 0, from: 1, to: 2 },
    { item: 2, from: 0, to: 2 },
    { item: 4, from: 0, to: 1 },
  ]);
});

// ----- numbering the hits of a book -----------------------------------------------------------

const counts = [
  { page: 1, count: 2 },
  { page: 4, count: 1 },
];

test('hits are numbered in reading order across the book', () => {
  assert.equal(totalHits(counts), 3);
  assert.equal(rankOf(counts, { page: 1, ordinal: 0 }), 1);
  assert.equal(rankOf(counts, { page: 1, ordinal: 1 }), 2);
  assert.equal(rankOf(counts, { page: 4, ordinal: 0 }), 3);
});

test('the first hit is the first one on this page or after it, else the first of the book', () => {
  assert.deepEqual(firstFrom(counts, 0), { page: 1, ordinal: 0 });
  assert.deepEqual(firstFrom(counts, 1), { page: 1, ordinal: 0 });
  assert.deepEqual(firstFrom(counts, 2), { page: 4, ordinal: 0 });
  assert.deepEqual(firstFrom(counts, 5), { page: 1, ordinal: 0 });
  assert.equal(firstFrom([], 0), null);
});

test('next and previous walk the hits and wrap round the book', () => {
  assert.deepEqual(stepHit(counts, { page: 1, ordinal: 0 }, 1), { page: 1, ordinal: 1 });
  assert.deepEqual(stepHit(counts, { page: 1, ordinal: 1 }, 1), { page: 4, ordinal: 0 });
  assert.deepEqual(stepHit(counts, { page: 4, ordinal: 0 }, 1), { page: 1, ordinal: 0 });
  assert.deepEqual(stepHit(counts, { page: 4, ordinal: 0 }, -1), { page: 1, ordinal: 1 });
  assert.deepEqual(stepHit(counts, { page: 1, ordinal: 1 }, -1), { page: 1, ordinal: 0 });
  assert.deepEqual(stepHit(counts, { page: 1, ordinal: 0 }, -1), { page: 4, ordinal: 0 });
  assert.deepEqual(stepHit([{ page: 3, count: 1 }], { page: 3, ordinal: 0 }, 1), { page: 3, ordinal: 0 });
  assert.equal(stepHit([], null, 1), null);
});

test('a position on a page that has no hits any more (the query changed) falls back to the next page with hits', () => {
  assert.deepEqual(stepHit(counts, { page: 2, ordinal: 0 }, 1), { page: 4, ordinal: 0 });
});
