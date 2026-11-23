import { useEffect, useRef, useState } from 'react';
import useSettings from '../store/settingsStore';
import { fold, firstFrom, stepHit, rankOf } from './findText';
import { TextIndex, scanBook } from './findIndex';

// Find in the document (Ctrl+F): the controller between the find bar, the book's text and the canvas.
//
//   typing → (after a pause) scanBook counts the hits on every page, starting at the page being read, so the
//            first hit at or after it is known at once; the reader jumps there and the rest is counted in the
//            background ("3 of 17" firms up as pages come in)
//   hits   → drawn on the highlight layer (paper.js drawFinds) for every page whose text layer exists; the
//            rectangles come from that layer (TextLayerManager.findRects), so they sit exactly on the words
//   next / previous → walk the hits (wrapping round the book); the current one is outlined and brought into view
//
// The canvas gives this hook what it needs to move the view; nothing here touches pdf.js or the DOM directly.

const DEBOUNCE_MS = 130;
export const IDLE = { phase: 'idle', rank: 0, total: 0, capped: false, hasText: true };

export default function useFind({ pdf, layoutRef, textRef, open, setOpen, hitsRef, currentLayoutIndex, ensurePage, revealRect, redraw }) {
  const accents = useSettings((s) => s.findAccents);
  const updatePrefs = useSettings((s) => s.update);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState(IDLE);
  const [focusTick, setFocusTick] = useState(0);

  const indexRef = useRef(null);
  const runRef = useRef(0); // which scan is current: older ones stop and are ignored
  const navRef = useRef(0); // which "bring the current hit into view" is current
  const countsRef = useRef([]); // [{ page, count }], page = PDF page index
  const currentRef = useRef(null); // { page, ordinal }
  const rectsRef = useRef(new Map()); // pdf page index -> per hit: [[x, y, w, h]] — pages whose text layer has been seen
  const pendingRef = useRef(null); // { page, ordinal, nav }: the hit to reveal as soon as its page has rectangles
  const wasOpen = useRef(false);

  const live = useRef({});
  live.current = { query, accents, open };

  const keyOf = (pdfIndex) => `p${pdfIndex}`;
  const needle = () => fold(live.current.query, { accents: live.current.accents, map: false }).text;
  const layoutIndexOf = (pdfIndex) => layoutRef.current.pages.findIndex((p) => p.kind === 'pdf' && p.pdfIndex === pdfIndex);

  // What the highlight layer shows: every hit found so far on pages that have text laid out, the current one stronger.
  function publishHits() {
    const cur = currentRef.current;
    const hits = new Map();
    for (const [pdfIndex, perHit] of rectsRef.current) {
      hits.set(keyOf(pdfIndex), { rects: perHit.flat(), current: cur && cur.page === pdfIndex ? perHit[cur.ordinal] || null : null });
    }
    hitsRef.current = hits;
    redraw();
  }

  // Rectangles for a page whose text is laid out. Returns whether it could.
  function measure(layoutIndex) {
    const page = layoutRef.current.pages[layoutIndex];
    const n = needle();
    if (!page || page.kind !== 'pdf' || !n) return false;
    const rects = textRef.current?.findRects(layoutIndex, n, live.current.accents);
    if (!rects) return false;
    rectsRef.current.set(page.pdfIndex, rects);
    return true;
  }

  function measureAll() {
    rectsRef.current.clear();
    for (const li of textRef.current?.pages.keys() || []) measure(li);
  }

  // Brings the pending hit into view once its page has rectangles (now, or when its text layer appears).
  function tryReveal() {
    const want = pendingRef.current;
    if (!want || want.nav !== navRef.current) return;
    const li = layoutIndexOf(want.page);
    if (li < 0) return;
    if (!rectsRef.current.has(want.page)) measure(li);
    const rects = rectsRef.current.get(want.page);
    if (!rects) return; // the page's text is not laid out yet: onPageRendered calls again
    pendingRef.current = null;
    publishHits();
    const rect = rects[want.ordinal]?.[0];
    if (rect) revealRect(li, rect);
  }

  function showCurrent() {
    const cur = currentRef.current;
    if (!cur) return;
    const li = layoutIndexOf(cur.page);
    if (li < 0) return;
    pendingRef.current = { ...cur, nav: ++navRef.current };
    ensurePage(li);
    publishHits();
    tryReveal();
  }

  function setRank(counts) {
    setStatus((s) => ({ ...s, rank: currentRef.current ? rankOf(counts, currentRef.current) : 0 }));
  }

  // The PDF page to start reading hits from: the one on screen (or the next one that has text, if that is a note page).
  function startPage() {
    const L = layoutRef.current;
    for (let k = currentLayoutIndex(); k < L.n; k++) if (L.pages[k].kind === 'pdf') return L.pages[k].pdfIndex;
    return 0;
  }

  function startScan() {
    const token = ++runRef.current;
    navRef.current++;
    pendingRef.current = null;
    currentRef.current = null;
    countsRef.current = [];
    const q = live.current.query;
    const folded = needle();
    if (!folded) {
      rectsRef.current.clear();
      publishHits();
      setStatus(IDLE);
      return;
    }
    indexRef.current ||= new TextIndex(pdf);
    const n = pdf.numPages;
    const start = startPage();
    const order = Array.from({ length: n }, (_, k) => (start + k) % n);
    setStatus({ phase: 'scanning', rank: 0, total: 0, capped: false, hasText: true });
    measureAll(); // the pages on screen show their hits right away
    publishHits();
    scanBook(indexRef.current, {
      query: q,
      accents: live.current.accents,
      order,
      isCancelled: () => token !== runRef.current,
      onProgress: (p) => {
        if (token !== runRef.current) return;
        countsRef.current = p.counts;
        if (!currentRef.current && p.total) {
          currentRef.current = firstFrom(p.counts, start);
          showCurrent();
        }
        setStatus({ phase: p.done ? 'done' : 'scanning', rank: currentRef.current ? rankOf(p.counts, currentRef.current) : 0, total: p.total, capped: p.capped, hasText: p.hasText });
      },
    });
  }

  // A new search whenever the text, the accent setting or the bar being open changes.
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(startScan, query ? DEBOUNCE_MS : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, accents]);

  // Opening needs the pages' text laid out (the canvas makes the text layers while the bar is open);
  // closing takes the hits off the page.
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      redraw();
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    runRef.current++;
    navRef.current++;
    pendingRef.current = null;
    currentRef.current = null;
    countsRef.current = [];
    rectsRef.current.clear();
    hitsRef.current = new Map();
    setStatus(IDLE);
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(
    () => () => {
      runRef.current++;
      navRef.current++;
    },
    []
  );

  function step(delta) {
    const counts = countsRef.current;
    if (!counts.length) return;
    currentRef.current = stepHit(counts, currentRef.current, delta);
    setRank(counts);
    showCurrent();
  }

  return {
    isOpen: open,
    query,
    setQuery,
    status,
    accents,
    focusTick,
    toggleAccents: () => updatePrefs({ findAccents: !accents }),
    next: () => step(1),
    prev: () => step(-1),
    openFind: () => {
      setOpen(true);
      setFocusTick((t) => t + 1);
    },
    closeFind: () => setOpen(false),
    // A page's text has just been laid out: its hits can be drawn.
    onPageRendered: (layoutIndex) => {
      if (!live.current.open) return;
      if (measure(layoutIndex)) {
        publishHits();
        tryReveal();
      }
    },
  };
}
