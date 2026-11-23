import { fold, joinItems, findAll, totalHits, MAX_MATCHES } from './findText';

// The text of a whole PDF, page by page, and counting a search over all of it.
//
// A page's text is read once (pdf.js parses it in its worker) and kept; folding it for comparison is
// kept too, once per accent setting. So the first search in a long book takes a moment — progress is
// shown as the pages come in — and every later one is instant.
//
// For a document that lives only on the server this reads the whole file (in the byte ranges pdf.js asks
// for); it is what the person asked for by searching.

const AHEAD = 6; // pages whose text is being read while the previous one is being searched
const REPORT_MS = 90; // how often progress is handed on

export class TextIndex {
  constructor(pdf) {
    this.pdf = pdf;
    this.raw = new Map(); // pdf page index -> Promise<string>: the page's text
    this.folded = new Map(); // `${accents}:${page}` -> Promise<string>
  }

  rawText(page) {
    let p = this.raw.get(page);
    if (!p) {
      p = (async () => {
        try {
          const pdfPage = await this.pdf.getPage(page + 1);
          const content = await pdfPage.getTextContent();
          pdfPage.cleanup();
          return joinItems(content.items.filter((it) => typeof it.str === 'string')).joined;
        } catch {
          return ''; // a page that cannot be read has nothing to find; the document may also have been closed
        }
      })();
      this.raw.set(page, p);
    }
    return p;
  }

  foldedText(page, accents) {
    const key = `${accents ? 1 : 0}:${page}`;
    let p = this.folded.get(key);
    if (!p) {
      p = this.rawText(page).then((raw) => fold(raw, { accents, map: false }).text);
      this.folded.set(key, p);
    }
    return p;
  }
}

// Counts the hits of `query` on every page, visiting the pages in `order` (PDF page indexes).
// onProgress({ counts, total, scanned, pages, capped, hasText }) is called as the count grows
// (counts: [{ page, count }] ascending by page) and once more at the end, where `done` is true.
// Stops by itself when `isCancelled()` says so, or at MAX_MATCHES hits.
export async function scanBook(index, { query, accents, order, isCancelled, onProgress }) {
  const needle = fold(query, { accents, map: false }).text;
  const byPage = new Map();
  let total = 0;
  let scanned = 0;
  let hasText = false;
  let capped = false;
  let lastReport = 0;
  let reportedHit = false;

  const report = (done) => {
    const counts = [...byPage].map(([page, count]) => ({ page, count })).sort((a, b) => a.page - b.page);
    onProgress({ counts, total: totalHits(counts), scanned, pages: order.length, capped, hasText, done });
    lastReport = Date.now();
  };

  if (!needle) {
    report(true);
    return;
  }

  const pending = [];
  let next = 0;
  const launch = () => {
    while (pending.length < AHEAD && next < order.length) pending.push(index.foldedText(order[next++], accents));
  };
  launch();
  for (let k = 0; k < order.length; k++) {
    const text = await pending.shift();
    launch();
    if (isCancelled()) return;
    scanned++;
    if (text.trim()) hasText = true;
    const hits = findAll(text, needle, MAX_MATCHES - total);
    if (hits.length) {
      byPage.set(order[k], hits.length);
      total += hits.length;
    }
    if (total >= MAX_MATCHES) {
      capped = true;
      break;
    }
    // The first hit is worth showing at once (the reader jumps to it); the rest in a steady trickle.
    if ((hits.length && !reportedHit) || Date.now() - lastReport >= REPORT_MS) {
      if (hits.length) reportedHit = true;
      report(false);
    }
  }
  if (!isCancelled()) report(true);
}
