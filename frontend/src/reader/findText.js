// Finding text in a PDF — the pure part (no DOM, no pdf.js), so it can be tested on its own.
//
// What a page "says" is the strings of its text items joined in reading order, with a newline after
// the last item of a line (pdf.js marks that with `hasEOL`). Searching compares *folded* text: case,
// compatibility forms (the ligature "ﬁ" → "fi"), accents (optionally) and runs of whitespace — a line
// break counts as a space — are made equal on both sides, and the position of every folded character
// in the original text is remembered so a match can be put back where it was found.
//
// Two stages use this:
//   - counting: a whole book's pages are folded once and `findAll` counts the hits on each (reader/findIndex.js);
//   - showing: for a page whose text layer exists, the same text is rebuilt from the layer's own spans
//     and `matchSegments` says which stretch of which span each hit is (reader/textLayers.js draws it).
// Both run the same functions on the same strings, so "the 3rd hit on page 7" means the same thing in both.

const DROPPED = /[­​-‍⁠﻿]/; // soft hyphen, zero-width characters
const SPACE = /\s/;
const MARKS = /\p{M}/gu;

export const MAX_MATCHES = 3000; // more than this is "3000+": nobody reads that many, and it keeps typing fast

// Folds `str` for comparison. Returns { text, map } where map[k] is the index in `str` of the
// character text[k] came from (left out with { map: false } when only the text is needed).
//
//   accents false (default): é → e, ş → s, İ → i, ı → i — what a person typing on a keyboard without the
//                            letter expects ("cay" finds "çay")
//   accents true:            letters keep their accents (composed, so "e" does not match inside "é");
//                            Turkish İ/ı stay different from i
export function fold(str, { accents = false, map: wantMap = true } = {}) {
  const map = wantMap ? [] : null;
  let text = '';
  for (let i = 0; i < str.length; ) {
    const ch = String.fromCodePoint(str.codePointAt(i));
    const at = i;
    i += ch.length;
    if (DROPPED.test(ch)) continue;
    let f;
    if (SPACE.test(ch)) {
      if (text === '' || text.endsWith(' ')) continue; // no leading space, runs collapse to one
      f = ' ';
    } else if (accents) {
      f = ch.normalize('NFKC').toLowerCase();
    } else {
      f = ch.normalize('NFKD').replace(MARKS, '').replace(/ı/g, 'i').toLowerCase();
    }
    if (map) for (let k = 0; k < f.length; k++) map.push(at);
    text += f;
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    map?.pop();
  }
  return wantMap ? { text, map } : { text };
}

// ----- a page's text ---------------------------------------------------------------------

// items: [{ str, hasEOL }] as pdf.js gives them (or as read back from a text layer).
// → { joined, starts, lengths }: the page's text, and where each item begins in it and how long it is.
export function joinItems(items) {
  const starts = [];
  const lengths = [];
  let joined = '';
  for (const it of items) {
    const str = typeof it.str === 'string' ? it.str : '';
    starts.push(joined.length);
    lengths.push(str.length);
    joined += str;
    if (it.hasEOL) joined += '\n';
  }
  return { joined, starts, lengths };
}

// The start of every non-overlapping occurrence of `needle` in `text` (both folded).
export function findAll(text, needle, limit = Infinity) {
  const out = [];
  if (!needle) return out;
  for (let i = text.indexOf(needle); i !== -1 && out.length < limit; i = text.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

// The hit [a, b) of the folded text (with the `map` from fold()) as stretches of the page's items:
// [{ item, from, to }] — offsets inside that item's string. A hit that runs over a line break touches
// several items.
export function matchSegments(page, map, a, b) {
  const s = map[a];
  const last = map[b - 1];
  const e = last + (page.joined.codePointAt(last) > 0xffff ? 2 : 1);
  const { starts, lengths } = page;
  // first item that ends after s (items are in order, so a binary search)
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] + lengths[mid] > s) hi = mid;
    else lo = mid + 1;
  }
  const out = [];
  for (let k = lo; k < starts.length && starts[k] < e; k++) {
    const from = Math.max(s, starts[k]) - starts[k];
    const to = Math.min(e, starts[k] + lengths[k]) - starts[k];
    if (to > from) out.push({ item: k, from, to });
  }
  return out;
}

// ----- the hits of a whole book ---------------------------------------------------------------
//
// `counts` is [{ page, count }] with page = the PDF page index, ascending, only pages with hits.
// A hit is { page, ordinal } — the ordinal-th (from 0) hit on that page. Hits are numbered in
// reading order across the book: 1 … total.

export const totalHits = (counts) => counts.reduce((n, c) => n + c.count, 0);

export function rankOf(counts, at) {
  let n = 0;
  for (const c of counts) {
    if (c.page === at.page) return n + at.ordinal + 1;
    if (c.page > at.page) break;
    n += c.count;
  }
  return n + at.ordinal + 1;
}

// The first hit on `page` or after it; the very first of the book if there is none further on.
export function firstFrom(counts, page) {
  const c = counts.find((x) => x.page >= page) || counts[0];
  return c ? { page: c.page, ordinal: 0 } : null;
}

// One hit on from `at` (delta 1) or back (delta -1), wrapping round the ends of the book.
export function stepHit(counts, at, delta) {
  if (!counts.length) return null;
  if (!at) return firstFrom(counts, 0);
  const i = counts.findIndex((c) => c.page === at.page);
  if (i < 0) return firstFrom(counts, at.page);
  if (delta > 0) {
    if (at.ordinal + 1 < counts[i].count) return { page: at.page, ordinal: at.ordinal + 1 };
    const next = counts[(i + 1) % counts.length];
    return { page: next.page, ordinal: 0 };
  }
  if (at.ordinal > 0) return { page: at.page, ordinal: at.ordinal - 1 };
  const prev = counts[(i - 1 + counts.length) % counts.length];
  return { page: prev.page, ordinal: prev.count - 1 };
}
