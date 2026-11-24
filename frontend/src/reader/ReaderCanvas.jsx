import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Excalidraw, newElementWith, CaptureUpdateAction, reconcileElements, getSceneVersion } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { useTranslation } from 'react-i18next';
import { strokeToFreedrawElement } from '../lib/freehandElement';
import { strokeToPath2D, STROKE_OPTIONS } from '../lib/freehand';
import { recognizeShape, adjustShape, shapeOutline } from '../lib/shapeRecognition';
import useSettings from '../store/settingsStore';
import { clipPolylineByPolygon, boundingBoxIntersectsPolygon, getCuttableOutline, cutOutline } from '../canvas/selectionCut';
import { shapeToElements, inkWidth, eraserHits, EXCALIDRAW_FREEDRAW_SIZE_FACTOR } from '../canvas/elements';
import {
  makeLayout,
  pageRect,
  pageUnder,
  pageAtY,
  visiblePages,
  currentPage,
  pageOffset,
  fitWidthZoom,
  fitPageZoom,
  clampStackView,
  clampPageView,
  viewForPage,
  viewForPosition,
  MAX_ZOOM,
  MIN_ZOOM,
  INSETS,
} from './geometry';
import { bucketElements, signature, sceneFromRows, relayout } from './inkBuckets';
import { PdfRaster } from './pdfRaster';
import { TextLayerManager } from './textLayers';
import { drawPaper, drawMarks, DARK_FILTER, DESK } from './paper';
import { newMark, mergeMarks, updateMark, deleteMark, hitMark, activeMarks, markChanges, restoreMarks } from './marks';
import { History } from './history';
import { LinkIndex, hitLink, destPageIndex } from './pdfLinks';
import { openExternal } from '../lib/openExternal';
import { snapshotScene, diffScene, applyInkChanges } from './inkDiff';
import Toolbar from './Toolbar';
import PageBar from './PageBar';
import SelectionBar from './SelectionBar';
import MarkPopover from './MarkPopover';
import FindBar from './FindBar';
import useFind from './useFind';
import SnipBar from './SnipBar';
import { renderRegion } from './snipRender';
import { MIN_SIZE, CURSORS, handlePoints, hitTest, dragRect, rectFromPoints, clampPoint, outputScale, pastedPictureSize, snipName } from './snip';
import { pushRecent } from '../lib/color';
import { copyImageToClipboard, copyTextToClipboard } from '../lib/clipboard';
import { saveBlob } from '../lib/saveFile';
import { toast } from '../components/Toasts';

const HOLD_MS = 500; // keep the pen still this long at a stroke's end to snap it to a shape
const HOLD_RADIUS = { pen: 6, mouse: 5, touch: 10 }; // screen px of jitter that still counts as "still"
const ERASER_RADIUS = 10; // screen px, for the stylus button / eraser end
const PALM_WINDOW_MS = 500; // touches this soon after pen activity are a resting hand
const PALM_SIZE = 60; // touch contact (CSS px) this big is a palm, not a fingertip
const HIGHLIGHTER_OPACITY = 40;
const TAP_MOVE_TOLERANCE = 10;
const LINK_TAP_MS = 600; // a press on a link that lasts longer is a mark of the pen, not a tap
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_DIST = 40;
const TWO_FINGER_TAP_MS = 300;
const SWIPE_MIN = 60; // book mode: how far a finger must travel to turn the page
const EDGE_TAP_FRACTION = 0.24; // book mode: tapping the outer quarter of the screen turns the page
const SAVE_DELAY_MS = 600;
const POSITION_DELAY_MS = 900;
// Excalidraw's dark theme renders the scene through this filter; the live
// preview (and colour swatches) use it too, so ink looks the same while
// being drawn as after.
const DARK_INK_FILTER = 'invert(93%) hue-rotate(180deg)';

const UI_OPTIONS = {
  canvasActions: {
    changeViewBackgroundColor: false,
    loadScene: false,
    saveToActiveFile: false,
    toggleTheme: false,
    export: false,
    saveAsImage: false,
    clearCanvas: false, // would erase every page at once
  },
};

function isEraserButton(e) {
  return e.pointerType === 'pen' && ((e.buttons & 32) !== 0 || (e.buttons & 2) !== 0 || e.button === 5 || e.button === 2);
}

const layoutSignature = (pages) => pages.map((p) => `${p.key}:${Math.round(p.w)}x${Math.round(p.h)}`).join('|');

const ReaderCanvas = forwardRef(function ReaderCanvas(
  { docId, title = '', pdf, pages, annotations, readOnly = false, mode, paper, initialPosition, onSavePage, onPosition, onPageChange, onMarksChange, onTurn, chrome = true, onToggleChrome, topInset = 0 },
  ref
) {
  const { t, i18n } = useTranslation();
  const isDark = useSettings((s) => s.isDark);
  const fingerMode = useSettings((s) => s.fingerMode);
  const penSeen = useSettings((s) => s.penSeen);
  const shapeSnap = useSettings((s) => s.shapeSnap);
  const snapText = useSettings((s) => s.snapText);
  const pageTurn = useSettings((s) => s.pageTurn);
  const tool = useSettings((s) => s.tool);
  const penColor = useSettings((s) => s.penColor);
  const penSize = useSettings((s) => s.penSize);
  const hlColor = useSettings((s) => s.hlColor);
  const hlSize = useSettings((s) => s.hlSize);
  const updatePrefs = useSettings((s) => s.update);
  const dark = paper === 'dark';
  const fingerDraws = !readOnly && (fingerMode === 'draw' || (fingerMode === 'auto' && !penSeen));

  // ---------- document state ----------

  const layout = useMemo(() => makeLayout(pages), [pages]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // What is stored for each page; read once per document, then owned here.
  const initial = useMemo(() => {
    const rows = new Map();
    const files = {};
    for (const [key, a] of annotations) {
      rows.set(key, a.ink?.elements || []);
      Object.assign(files, a.ink?.files || {});
    }
    return { elements: sceneFromRows(makeLayout(pages), rows), files };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  const marksRef = useRef(null);
  const inkRef = useRef(null);
  const sigRef = useRef(null);
  if (marksRef.current === null) {
    marksRef.current = new Map();
    inkRef.current = new Map();
    sigRef.current = new Map();
    for (const [key, a] of annotations) {
      marksRef.current.set(key, a.marks || []);
      inkRef.current.set(key, a.ink || { elements: [], files: {} });
      sigRef.current.set(key, signature(a.ink?.elements || []));
    }
  }
  const dirtyMarks = useRef(new Set());

  // Undo / redo for everything done in this document, in one timeline (see history.js). The drawing is watched rather than
  // asked: inkLastRef is the page-local copy of the scene as last seen, and each burst of drawing that differs from it is a step.
  const historyRef = useRef(null);
  if (historyRef.current === null) historyRef.current = new History();
  const history = historyRef.current;
  const inkLastRef = useRef(null);
  const inkTimer = useRef(null);
  const inkVersionRef = useRef(null);
  const pendingMarks = useRef(null); // a run of edits to one mark (typing a note), recorded as one step when it pauses

  // ---------- UI state ----------

  const [activeToolType, setActiveToolType] = useState('freedraw');
  const [textMode, setTextMode] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectionTool, setSelectionTool] = useState(null);
  const [zoomPct, setZoomPct] = useState(100);
  const [selBar, setSelBar] = useState(null); // { anchor, items } while text is selected
  const [markPop, setMarkPop] = useState(null); // { pageKey, mark, anchor }
  const [findOpen, setFindOpen] = useState(false); // the find-in-text bar (Ctrl+F)
  const findHitsRef = useRef(new Map()); // page key -> the hits to draw (see useFind)
  const findRef = useRef(null);
  // The snip tool: a region of one page to copy or save. snipRef is the live region ({ pageIndex, key, x, y, w, h },
  // page-local px); snipRect mirrors it into state once it is chosen, for the bar.
  const [snipOn, setSnipOn] = useState(false);
  const [snipRect, setSnipRect] = useState(null);
  const [snipBusy, setSnipBusy] = useState(false);
  const snipAnnotations = useSettings((s) => s.snipAnnotations);
  const snipOnRef = useRef(false);
  snipOnRef.current = snipOn;
  const snipRef = useRef(null);
  const snipDrag = useRef(null);
  const snipCanvasRef = useRef(null);
  const snipActions = useRef({});
  const toolBeforeSnip = useRef(null);
  const lastCopy = useRef(null); // the last picture copied from a region (its pixel size and the region's), see pastedPictureSize
  const lastPointer = useRef(null); // where the pointer last was (client px), for pasting there
  const linksRef = useRef(null); // LinkIndex: the clickable links of each page
  const hoverLink = useRef(null); // { link, index }: the link under the mouse/pen, outlined as a hint
  const penHistory = useSettings((s) => s.penColorHistory);
  const hlHistory = useSettings((s) => s.hlColorHistory);

  const apiRef = useRef(null);
  const containerRef = useRef(null);
  const paperRef = useRef(null);
  const marksCanvasRef = useRef(null);
  const overlayRef = useRef(null);
  const textRootRef = useRef(null);
  const rasterRef = useRef(null);
  const textRef = useRef(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const gestureRect = useRef(null);
  const prefsRef = useRef({});
  prefsRef.current = { fingerDraws, shapeSnap, snapText, pageTurn, dark, paper, mode, readOnly, tool, penColor, penSize, hlColor, hlSize };
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const bookPageRef = useRef(0);
  const currentIndexRef = useRef(0);
  const textModeRef = useRef(false);
  textModeRef.current = textMode;
  const selectionToolRef = useRef(null);
  selectionToolRef.current = selectionTool;
  const markPopRef = useRef(null);
  markPopRef.current = markPop;

  const drawing = useRef(null);
  const erasing = useRef(null);
  const eraserCursor = useRef(null);
  const selectionDrawing = useRef(null);
  const touchPoints = useRef(new Map());
  const ignoredTouches = useRef(new Set());
  const touchPan = useRef(null);
  const touchTrack = useRef(null);
  const pinchTrack = useRef(null);
  const pinchRAF = useRef(null);
  const twoFingerTap = useRef(null);
  const lastTap = useRef(null);
  const lastPenActivity = useRef(0);
  const inertiaRAF = useRef(null);
  const overlayRAF = useRef(null);
  const paperRAF = useRef(null);
  const initialViewRAF = useRef(null);
  const settleTimer = useRef(null);
  const positionTimer = useRef(null);
  const saveTimer = useRef(null);
  const savedVersion = useRef(null);

  const isDrawTool = activeToolType === 'freedraw' && !textMode;
  const isDrawToolRef = useRef(isDrawTool);
  isDrawToolRef.current = isDrawTool;
  // Text layers exist only when something needs the words: selecting, snapping a highlighter, finding.
  const textNeeded = textMode || (isDrawTool && tool === 'highlighter' && snapText && !readOnly) || findOpen || snipOn;
  const eraserOn = activeToolType === 'eraser' && !textMode && !selectionTool && !snipOn;

  // ---------- view (scroll/zoom) + paper ----------

  function currentView() {
    const st = apiRef.current?.getAppState();
    return st ? { scrollX: st.scrollX, scrollY: st.scrollY, zoom: st.zoom.value } : null;
  }

  // The zoom range and the area the view may show depend on the reading mode:
  // scroll mode shows the whole stack, book mode only the current page.
  function zoomLimits() {
    const rect = sizeRef.current;
    const L = layoutRef.current;
    if (modeRef.current === 'book') {
      const p = L.pages[bookPageRef.current] || L.pages[0];
      return { min: fitPageZoom(rect, p.w, p.h), max: MAX_ZOOM };
    }
    return { min: Math.max(MIN_ZOOM, fitWidthZoom(rect, L.maxW) * 0.3), max: MAX_ZOOM };
  }

  function clampView(scrollX, scrollY, zoom) {
    const rect = sizeRef.current;
    const L = layoutRef.current;
    return modeRef.current === 'book' ? clampPageView(scrollX, scrollY, zoom, rect, L, bookPageRef.current) : clampStackView(scrollX, scrollY, zoom, rect, L);
  }

  function visibleRegion(i, view, rect) {
    const L = layoutRef.current;
    const r = pageRect(L, i);
    const x0 = Math.max(0, -view.scrollX - r.x);
    const y0 = Math.max(0, -view.scrollY - r.y);
    const x1 = Math.min(r.width, rect.width / view.zoom - view.scrollX - r.x);
    const y1 = Math.min(r.height, rect.height / view.zoom - view.scrollY - r.y);
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  function syncPaper(view = currentView(), { settled = false } = {}) {
    const rect = sizeRef.current;
    if (!view || !rect.width || !paperRef.current) return;
    const L = layoutRef.current;
    const p = prefsRef.current;
    const raster = rasterRef.current;
    const dpr = window.devicePixelRatio || 1;

    const visible = visiblePages(L, view, rect);
    // Read the links of the pages on screen (once each), so that a tap on one is answered at once.
    for (const i of visible) if (L.pages[i].kind === 'pdf') linksRef.current?.load(L.pages[i].pdfIndex);
    // Ask for bitmaps: the base of the visible pages and their neighbours at
    // once, the sharp detail only when the view has settled.
    if (raster) {
      for (const i of visiblePages(L, view, rect, rect.height * 0.6)) {
        const page = L.pages[i];
        if (page.kind !== 'pdf') continue;
        raster.ensure(page.pdfIndex, page.w, page.h, view.zoom * dpr, visibleRegion(i, view, rect), { detail: settled && visible.includes(i) });
      }
      raster.keepOnly(visiblePages(L, view, rect, rect.height * 1.5).map((i) => (L.pages[i].kind === 'pdf' ? L.pages[i].pdfIndex : -1)));
    }
    // Book mode shows one page, like a book: nothing of the neighbours — not their
    // paper, their highlights, or (clipped below) their ink — may show around it.
    const book = modeRef.current === 'book';
    const onlyIndex = book ? Math.min(bookPageRef.current, L.n - 1) : undefined;
    drawPaper(paperRef.current, view, rect, L, raster, { sepia: p.paper === 'sepia', dark: p.dark, onlyIndex });
    drawMarks(marksCanvasRef.current, view, rect, L, marksRef.current, { dark: p.dark, hidden: false, selectedId: markPopRef.current?.mark.id, onlyIndex, finds: findHitsRef.current });
    clipInk(book && L.n ? pageRect(L, onlyIndex) : null, view, rect);
    textRef.current?.sync(L, view, rect, visible, { enabled: textNeededRef.current, interactive: textModeRef.current });
    drawSnip();

    const index = currentPage(L, view, rect);
    if (modeRef.current === 'book' && index !== bookPageRef.current) bookPageRef.current = index;
    if (index !== currentIndexRef.current) {
      currentIndexRef.current = index;
      setCurrentIndex(index);
      onPageChange?.(index);
    }
    const pct = Math.round(view.zoom * 100);
    if (pct !== zoomPctRef.current) {
      zoomPctRef.current = pct;
      setZoomPct(pct);
    }
    clearTimeout(positionTimer.current);
    positionTimer.current = setTimeout(reportPosition, POSITION_DELAY_MS);

    clearTimeout(settleTimer.current);
    if (!settled) settleTimer.current = setTimeout(() => syncPaper(currentView(), { settled: true }), 160);
  }
  const textNeededRef = useRef(false);
  textNeededRef.current = textNeeded;
  const zoomPctRef = useRef(100);

  // The zoom buttons of the page bar: zoom about the middle of the screen.
  function zoomBy(factor) {
    stopInitialView();
    const v = currentView();
    const rect = sizeRef.current;
    if (!v || !rect.width) return;
    const { min, max } = zoomLimits();
    const zoom = Math.min(Math.max(v.zoom * factor, min), max);
    const cx = rect.width / 2 / v.zoom - v.scrollX;
    const cy = rect.height / 2 / v.zoom - v.scrollY;
    applyView({ zoom, ...clampView(rect.width / 2 / zoom - cx, rect.height / 2 / zoom - cy, zoom) });
  }

  // Restricts Excalidraw's drawing canvases (the ink, not its toolbar) to one
  // page's rectangle, or lifts the restriction.
  const inkCanvases = useRef(null);
  function clipInk(pageScene, view, rect) {
    if (!inkCanvases.current || inkCanvases.current.some((c) => !c.isConnected)) {
      inkCanvases.current = [...(containerRef.current?.querySelectorAll('.excalidraw canvas') || [])];
    }
    let clip = '';
    if (pageScene) {
      const x = (pageScene.x + view.scrollX) * view.zoom;
      const y = (pageScene.y + view.scrollY) * view.zoom;
      const w = pageScene.width * view.zoom;
      const h = pageScene.height * view.zoom;
      clip = `inset(${Math.max(0, y)}px ${Math.max(0, rect.width - (x + w))}px ${Math.max(0, rect.height - (y + h))}px ${Math.max(0, x)}px)`;
    }
    for (const c of inkCanvases.current) if (c.style.clipPath !== clip) c.style.clipPath = clip;
  }

  function scheduleSyncPaper() {
    if (paperRAF.current) return;
    paperRAF.current = requestAnimationFrame(() => {
      paperRAF.current = null;
      syncPaper();
    });
  }

  function reportPosition() {
    const view = currentView();
    const rect = sizeRef.current;
    if (!view || !rect.width) return;
    const L = layoutRef.current;
    const i = modeRef.current === 'book' ? bookPageRef.current : currentPage(L, view, rect);
    const offset = modeRef.current === 'book' ? 0 : pageOffset(L, view, rect, i);
    onPosition?.({ page: i, offset, pct: L.n > 1 ? Math.min(1, (i + offset) / (L.n - 1)) : 0 });
  }

  function applyView(view) {
    apiRef.current?.updateScene({ appState: { scrollX: view.scrollX, scrollY: view.scrollY, zoom: { value: view.zoom } } });
    syncPaper(view);
  }

  // Clamps any view change (wheel, Excalidraw's zoom buttons, hand tool).
  function handleScrollChange(scrollX, scrollY, zoom) {
    const rect = sizeRef.current;
    const api = apiRef.current;
    if (!api || !rect.width) return;
    const { min, max } = zoomLimits();
    const z = Math.min(Math.max(zoom.value, min), max);
    const c = clampView(scrollX, scrollY, z);
    if (z !== zoom.value || Math.abs(c.scrollX - scrollX) > 0.01 || Math.abs(c.scrollY - scrollY) > 0.01) {
      api.updateScene({ appState: { scrollX: c.scrollX, scrollY: c.scrollY, zoom: { value: z } } });
    }
    syncPaper({ ...c, zoom: z });
  }

  function resyncView() {
    const v = currentView();
    if (v) handleScrollChange(v.scrollX, v.scrollY, { value: v.zoom });
  }

  function startingView() {
    const rect = sizeRef.current;
    const L = layoutRef.current;
    const pos = initialPosition || { page: 0, offset: 0 };
    const page = Math.min(Math.max(pos.page || 0, 0), Math.max(0, L.n - 1));
    if (modeRef.current === 'book') {
      bookPageRef.current = page;
      const p = L.pages[page];
      return viewForPage(L, page, fitPageZoom(rect, p.w, p.h), rect);
    }
    const zoom = Math.min(Math.max(fitWidthZoom(rect, L.maxW), zoomLimits().min), MAX_ZOOM);
    return viewForPosition(L, page, pos.offset || 0, zoom, rect);
  }

  function resizeCanvases() {
    const el = containerRef.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = el.getBoundingClientRect();
    sizeRef.current = { width: rect.width, height: rect.height };
    for (const canvas of [paperRef.current, marksCanvasRef.current, overlayRef.current, snipCanvasRef.current]) {
      if (!canvas) continue;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    }
  }

  // The PDF bitmaps and the selectable text.
  useEffect(() => {
    const raster = new PdfRaster(pdf, { onUpdate: scheduleSyncPaper });
    rasterRef.current = raster;
    const text = new TextLayerManager(textRootRef.current, pdf);
    text.onRendered = (i) => findRef.current?.onPageRendered(i);
    textRef.current = text;
    const links = new LinkIndex(pdf);
    linksRef.current = links;
    hoverLink.current = null;
    scheduleSyncPaper();
    return () => {
      raster.dispose();
      text.dispose();
      links.dispose();
      rasterRef.current = null;
      textRef.current = null;
      linksRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf]);

  // Keep canvases locked to the container through any resize.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    resizeCanvases();
    const ro = new ResizeObserver(() => {
      resizeCanvases();
      resyncView();
      drawOverlay();
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open where the user left off, re-asserted for a short while: Excalidraw
  // applies its own initialData restore asynchronously and would otherwise
  // revert an earlier view update (found empirically in Quarc Notes).
  useEffect(() => {
    const start = performance.now();
    const tick = () => {
      if (apiRef.current && sizeRef.current.width) applyView(startingView());
      if (performance.now() - start < 800) initialViewRAF.current = requestAnimationFrame(tick);
    };
    initialViewRAF.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(initialViewRAF.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const stopInitialView = () => cancelAnimationFrame(initialViewRAF.current);

  // Paper tint / theme / mode changes. Changing the reading mode re-fits the
  // view for it: book mode shows the whole current page, scroll mode returns to
  // page width at the same place in the book.
  const prevModeRef = useRef(mode);
  useEffect(() => {
    if (prevModeRef.current !== mode) {
      prevModeRef.current = mode;
      const i = Math.min(currentIndexRef.current, Math.max(0, layoutRef.current.n - 1));
      const L = layoutRef.current;
      const rect = sizeRef.current;
      if (rect.width && L.n) {
        if (mode === 'book') {
          bookPageRef.current = i;
          const p = L.pages[i];
          applyView(viewForPage(L, i, fitPageZoom(rect, p.w, p.h), rect));
        } else {
          const zoom = Math.min(Math.max(fitWidthZoom(rect, L.maxW), zoomLimits().min), MAX_ZOOM);
          applyView(viewForPosition(L, i, 0, zoom, rect));
        }
      }
    } else {
      resyncView();
    }
    scheduleSyncPaper();
    drawOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper, mode, textNeeded, textMode]);

  // Page list changes (a note page inserted or deleted here or on another
  // device): move every page's ink with its page, and forget the undo history —
  // it would otherwise move things back to where their page used to be.
  const layoutSigRef = useRef(null);
  useEffect(() => {
    const sig = layoutSignature(pages);
    if (layoutSigRef.current === null) {
      layoutSigRef.current = sig;
      layoutRef.previous = layout;
      return;
    }
    if (sig === layoutSigRef.current) return;
    layoutSigRef.current = sig;
    const prev = layoutRef.previous;
    layoutRef.previous = layout;
    const api = apiRef.current;
    if (api && prev) {
      flushPending(prev); // the scene is still arranged in the old layout: compare it as that, or everything below the new page looks moved
      saveNow(prev); // anything unsaved is stored against the layout it was drawn in
      let moved = relayout(prev, layout, api.getSceneElementsIncludingDeleted());
      // A page that is back (a deleted note page restored by undo) gets its ink back; relayout dropped it with the page.
      const had = new Set(prev.pages.map((p) => p.key));
      const rows = new Map();
      for (const p of layout.pages) if (!had.has(p.key)) rows.set(p.key, inkRef.current.get(p.key)?.elements || []);
      if ([...rows.values()].some((els) => els.length)) {
        const present = new Set(moved.map((el) => el.id));
        const back = sceneFromRows(layout, rows).filter((el) => !present.has(el.id));
        if (back.length) moved = [...moved, ...back];
      }
      api.updateScene({ elements: moved, captureUpdate: CaptureUpdateAction.NEVER });
      api.history?.clear?.(); // Excalidraw's own history is not used (history.js is), and its positions are stale now
      // The new layout is the new "as last seen": the move is not a step.
      inkLastRef.current = snapshotScene(layout, api.getSceneElementsIncludingDeleted());
      inkVersionRef.current = getSceneVersion(api.getSceneElementsIncludingDeleted());
    }
    if (bookPageRef.current >= layout.n) bookPageRef.current = Math.max(0, layout.n - 1);
    requestAnimationFrame(() => {
      resyncView();
      scheduleSyncPaper();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);

  // ---------- saving ----------

  // Splits the scene into pages and hands every page that changed to the
  // owner (which stores and syncs it).
  function saveNow(againstLayout) {
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const api = apiRef.current;
    if (!api || readOnly) return;
    const L = againstLayout || layoutRef.current;
    const all = api.getSceneElementsIncludingDeleted();
    const version = getSceneVersion(all);
    if (version === savedVersion.current && !dirtyMarks.current.size) return;
    savedVersion.current = version;
    const buckets = bucketElements(L, all);
    const files = api.getFiles();
    const valid = new Set(L.pages.map((p) => p.key));
    const keys = new Set([...buckets.keys(), ...sigRef.current.keys(), ...dirtyMarks.current]);
    for (const key of keys) {
      if (!valid.has(key)) continue;
      const els = buckets.get(key) || [];
      const sig = signature(els);
      const inkChanged = sig !== (sigRef.current.get(key) ?? '');
      if (!inkChanged && !dirtyMarks.current.has(key)) continue;
      const pageFiles = {};
      for (const el of els) {
        if (el.type === 'image' && !el.isDeleted && el.fileId && files[el.fileId]) pageFiles[el.fileId] = files[el.fileId];
      }
      const ink = inkChanged ? { elements: els, files: pageFiles } : inkRef.current.get(key) || { elements: [], files: {} };
      inkRef.current.set(key, ink);
      sigRef.current.set(key, sig);
      onSavePage?.(key, { ink, marks: marksRef.current.get(key) || [] });
    }
    dirtyMarks.current.clear();
  }

  function scheduleSave() {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveNow(), SAVE_DELAY_MS);
  }

  // Never lose the last strokes: save on leaving the page and when the app
  // goes to the background (Android may kill it there).
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') {
        saveNow();
        reportPosition();
      }
    };
    const onPageHide = () => {
      saveNow();
      reportPosition();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      if (saveTimer.current) saveNow();
      reportPosition();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function changeMarks(pageKey, next) {
    marksRef.current.set(pageKey, next);
    dirtyMarks.current.add(pageKey);
    scheduleSave();
    scheduleSyncPaper();
    onMarksChange?.(pageKey, next);
  }

  // ---------- Excalidraw wiring ----------

  function handleExcalidrawAPI(api) {
    apiRef.current = api;
  }

  function handleExcalidrawChange(elements, appState) {
    const toolType = appState?.activeTool?.type;
    if (toolType && toolType !== activeToolType) setActiveToolType(toolType);
    const version = getSceneVersion(elements);
    if (version !== savedVersion.current) scheduleSave();
    // The first look at the scene, before anyone has touched it, is what everything is compared with later.
    if (inkLastRef.current === null) {
      inkLastRef.current = snapshotScene(layoutRef.current, elements);
      inkVersionRef.current = version;
    } else if (version !== inkVersionRef.current) {
      inkVersionRef.current = version;
      scheduleInkCommit();
    }
  }

  // ---------- undo / redo ----------

  const INK_SETTLE_MS = 250; // quiet time after the last change to the drawing before it is taken as one step
  const MARKS_COALESCE_MS = 700; // edits to one mark closer together than this are one step

  // The drawing changed: take it as a step once it has settled (no pointer down, nothing being typed, dragged or resized).
  function scheduleInkCommit() {
    clearTimeout(inkTimer.current);
    inkTimer.current = setTimeout(() => {
      const st = apiRef.current?.getAppState();
      const busy = st && (st.cursorButton === 'down' || st.newElement || st.editingTextElement || st.multiElement || st.selectedElementsAreBeingDragged || st.resizingElement || st.isResizing || st.isRotating);
      if (busy || drawing.current || erasing.current) scheduleInkCommit();
      else commitInkHistory();
    }, INK_SETTLE_MS);
  }

  // Records what changed in the drawing since the last look, as one step.
  // `L` is the layout the scene is arranged in: the current one, except while pages are being moved (see the relayout effect).
  function commitInkHistory(L = layoutRef.current) {
    clearTimeout(inkTimer.current);
    finishMarksEdit();
    const api = apiRef.current;
    if (!api || readOnly) return;
    const elements = api.getSceneElementsIncludingDeleted();
    if (inkLastRef.current === null) {
      inkLastRef.current = snapshotScene(L, elements);
      return;
    }
    const { changes, next } = diffScene(L, elements, inkLastRef.current);
    inkLastRef.current = next;
    if (changes.length) history.record({ undo: () => applyInk(changes, 'undo'), redo: () => applyInk(changes, 'redo') });
  }

  // Puts a step's drawing back (or forward) — without it being a new step.
  function applyInk(changes, dir) {
    const api = apiRef.current;
    if (!api) return;
    const L = layoutRef.current;
    const { elements } = applyInkChanges(L, api.getSceneElementsIncludingDeleted(), changes, dir);
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
    inkLastRef.current = snapshotScene(L, api.getSceneElementsIncludingDeleted());
    inkVersionRef.current = getSceneVersion(api.getSceneElementsIncludingDeleted());
    scheduleSave();
  }

  // Everything that is waiting to become a step, made one — before anything else is recorded, or undone.
  function flushPending(L) {
    finishMarksEdit();
    commitInkHistory(L);
  }

  // A step for a change to the marks of one page. Undoing is "make these marks what they were, as of now" (see restoreMarks).
  function recordMarksStep(pageKey, before, after) {
    const { ids, before: was, after: now } = markChanges(before, after);
    if (!ids.length) return;
    const apply = (snapshot) => changeMarks(pageKey, restoreMarks(marksRef.current.get(pageKey) || [], ids, snapshot));
    history.record({ undo: () => apply(was), redo: () => apply(now) });
  }

  // Changes to the marks — edits: [{ pageKey, next }] — as one step. With `coalesce` (typing a note) a run of edits to the
  // same thing is one step, recorded once it pauses.
  function editMarks(edits, { coalesce = null } = {}) {
    if (coalesce) {
      let run = pendingMarks.current;
      if (!run || run.key !== coalesce) {
        flushPending();
        run = { key: coalesce, before: new Map(), timer: null };
        pendingMarks.current = run;
      }
      clearTimeout(run.timer);
      for (const { pageKey, next } of edits) {
        if (!run.before.has(pageKey)) run.before.set(pageKey, marksRef.current.get(pageKey) || []);
        changeMarks(pageKey, next);
      }
      run.timer = setTimeout(finishMarksEdit, MARKS_COALESCE_MS);
      return;
    }
    flushPending();
    history.batch(() => {
      for (const { pageKey, next } of edits) {
        const before = marksRef.current.get(pageKey) || [];
        changeMarks(pageKey, next);
        recordMarksStep(pageKey, before, next);
      }
    });
  }

  function finishMarksEdit() {
    const run = pendingMarks.current;
    if (!run) return;
    pendingMarks.current = null;
    clearTimeout(run.timer);
    history.batch(() => {
      for (const [pageKey, before] of run.before) recordMarksStep(pageKey, before, marksRef.current.get(pageKey) || []);
    });
  }

  const undo = () => {
    if (readOnly) return Promise.resolve(false);
    flushPending();
    return history.undo();
  };
  const redo = () => {
    if (readOnly) return Promise.resolve(false);
    flushPending();
    return history.redo();
  };
  const undoRef = useRef({});
  undoRef.current = { undo, redo };

  // Ctrl/Cmd+Z, Ctrl+Shift+Z and Ctrl+Y: this timeline, not Excalidraw's (which only knows its drawing, and is cleared when the
  // pages shift). Not while typing in a field — that has an undo of its own.
  useEffect(() => {
    const onKey = (e) => {
      if (prefsRef.current.readOnly || !e.key || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      const wantsUndo = k === 'z' && !e.shiftKey;
      const wantsRedo = (k === 'z' && e.shiftKey) || k === 'y';
      if (!wantsUndo && !wantsRedo) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (document.querySelector('div[class*="z-[1100]"] [role=dialog]')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (wantsUndo) undoRef.current.undo();
      else undoRef.current.redo();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    if (savedVersion.current === null) savedVersion.current = getSceneVersion(initial.elements);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // ---------- tools ----------

  function selectDrawMode(next) {
    setTextMode(false);
    clearTextSelection();
    updatePrefs({ tool: next });
    apiRef.current?.setActiveTool({ type: 'freedraw' });
    setSelectionTool(null);
  }

  // A colour that is picked is also remembered (newest first) for the "recent colours" of that tool.
  function changePen(patch) {
    setTextMode(false);
    const color = patch.color ? { penColor: patch.color, penColorHistory: pushRecent(useSettings.getState().penColorHistory, patch.color) } : {};
    updatePrefs({ tool: 'pen', ...color, ...(patch.size ? { penSize: patch.size } : {}) });
    apiRef.current?.setActiveTool({ type: 'freedraw' });
  }

  function changeHighlighter(patch) {
    setTextMode(false);
    const color = patch.color ? { hlColor: patch.color, hlColorHistory: pushRecent(useSettings.getState().hlColorHistory, patch.color) } : {};
    updatePrefs({ tool: 'highlighter', ...color, ...(patch.size ? { hlSize: patch.size } : {}) });
    apiRef.current?.setActiveTool({ type: 'freedraw' });
  }

  // The eraser button of the dock: on, and back to the pen or highlighter you had.
  function toggleEraser() {
    if (eraserOn) selectDrawMode(tool);
    else chooseTool('eraser');
  }

  function toggleTextMode() {
    setTextMode((on) => {
      const next = !on;
      if (next) {
        apiRef.current?.setActiveTool({ type: 'hand' });
        setSelectionTool(null);
      } else {
        apiRef.current?.setActiveTool({ type: 'freedraw' });
        clearTextSelection();
      }
      return next;
    });
  }

  // ---------- text selection -> highlights ----------

  function clearTextSelection() {
    textRef.current?.clearSelection();
    setSelBar(null);
  }

  const selBarRef = useRef(null);
  selBarRef.current = selBar;

  useEffect(() => {
    if (!textMode) return undefined;
    const onSelection = () => {
      // Typing a note moves focus into the bar's text field, which collapses
      // the selection in the page. The bar keeps what was selected until it is
      // saved or dismissed.
      if (document.activeElement?.closest?.('[data-selection-bar]')) return;
      const items = textRef.current?.selection();
      const anchor = textRef.current?.selectionAnchor();
      setSelBar(items && anchor ? { items, anchor } : null);
    };
    document.addEventListener('selectionchange', onSelection);
    return () => document.removeEventListener('selectionchange', onSelection);
  }, [textMode]);

  function markSelection(type, color, note) {
    const items = selBarRef.current?.items || textRef.current?.selection();
    if (!items) return;
    // A selection over several pages is still one highlight to undo.
    editMarks(
      items.map((it) => ({
        pageKey: it.key,
        next: [...(marksRef.current.get(it.key) || []), newMark({ type, color, rects: it.rects, text: it.text, note })],
      }))
    );
    clearTextSelection();
  }

  function copySelection() {
    const items = selBarRef.current?.items || textRef.current?.selection();
    if (!items) return;
    const text = items.map((i) => i.text).join('\n');
    navigator.clipboard?.writeText(text).catch(() => {});
    clearTextSelection();
  }

  // ---------- live overlay (stroke preview, snapped shape, eraser, selection) ----------

  function scheduleOverlay() {
    if (overlayRAF.current) return;
    overlayRAF.current = requestAnimationFrame(() => {
      overlayRAF.current = null;
      drawOverlay();
    });
  }

  function drawOverlay() {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    const d = drawing.current;
    if (d) {
      ctx.save();
      const v = currentView();
      if (v && d.sheet) {
        ctx.beginPath();
        ctx.rect((d.sheet.x + v.scrollX) * v.zoom, (d.sheet.y + v.scrollY) * v.zoom, d.sheet.width * v.zoom, d.sheet.height * v.zoom);
        ctx.clip();
      }
      ctx.globalAlpha = d.highlighter ? HIGHLIGHTER_OPACITY / 100 : 1;
      if (d.shape) {
        const pts = shapeOutline(d.shape.current);
        ctx.strokeStyle = d.color;
        ctx.lineWidth = inkWidth(d.size, d.highlighter ? 0.5 : avgPressure(d));
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
      } else if (d.points.length) {
        const path = strokeToPath2D(
          d.points.map((p) => [p.x, p.y, p.pressure]),
          { ...STROKE_OPTIONS, size: d.size, last: false }
        );
        ctx.fillStyle = d.color;
        ctx.fill(path);
      }
      ctx.restore();
    }

    // The link under the mouse or pen: a soft violet outline.
    const hl = hoverLink.current;
    const hv = hl && !d ? currentView() : null;
    if (hv) {
      const pr = pageRect(layoutRef.current, hl.index);
      const [lx, ly, lw, lh] = hl.link.rect;
      ctx.save();
      ctx.strokeStyle = 'rgba(124, 58, 237, 0.85)';
      ctx.fillStyle = 'rgba(124, 58, 237, 0.10)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect((pr.x + lx + hv.scrollX) * hv.zoom - 1, (pr.y + ly + hv.scrollY) * hv.zoom - 1, lw * hv.zoom + 2, lh * hv.zoom + 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    drawPendingErasure(ctx);
    const e = eraserCursor.current;
    if (e) {
      ctx.save();
      ctx.strokeStyle = 'rgba(115,115,115,0.9)';
      ctx.fillStyle = 'rgba(115,115,115,0.12)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(e.x, e.y, ERASER_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    const sel = selectionDrawing.current;
    if (sel && sel.points.length >= 2) {
      const pts = sel.points;
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#7c3aed';
      ctx.fillStyle = 'rgba(124, 58, 237, 0.08)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (sel.mode === 'rect') {
        const a = pts[0];
        const b = pts[pts.length - 1];
        ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      } else {
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---------- strokes ----------

  function localPoint(ev, rect, d) {
    const raw = ev.pressure;
    const pressure = d && (d.highlighter || d.pointerType !== 'pen') ? 0.5 : raw > 0 ? raw : 0.5;
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top, pressure };
  }

  function avgPressure(d) {
    if (!d.points.length) return 0.5;
    const sum = d.points.reduce((acc, p) => acc + p.pressure, 0);
    return Math.min(1, Math.max(0.05, sum / d.points.length));
  }

  function capture(e) {
    try {
      containerRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
  }

  // The page (scene rect) under a container-relative point, or null when the
  // point is on the desk around / between pages — or, in book mode, on a page
  // that is not the one being shown.
  function pageUnderPoint(p) {
    const v = currentView();
    if (!v) return null;
    const L = layoutRef.current;
    const x = p.x / v.zoom - v.scrollX;
    const y = p.y / v.zoom - v.scrollY;
    const i = pageUnder(L, x, y);
    if (i < 0) return null;
    if (modeRef.current === 'book' && i !== bookPageRef.current) return null;
    const r = pageRect(L, i);
    return { x: r.x, y: r.y, width: r.width, height: r.height, index: i, key: L.pages[i].key, kind: L.pages[i].kind, pdfIndex: L.pages[i].pdfIndex };
  }

  function shapeOnSheet(shape, d) {
    const v = currentView();
    const r = d.sheet;
    if (!v || !r) return true;
    const tol = 0.5;
    return shapeOutline(shape).every((pt) => {
      const x = pt.x / v.zoom - v.scrollX;
      const y = pt.y / v.zoom - v.scrollY;
      return x >= r.x - tol && x <= r.x + r.width + tol && y >= r.y - tol && y <= r.y + r.height + tol;
    });
  }

  // Ink only goes on paper: a stroke can't start on the desk, and one that
  // runs off the page is cut at its edge (see endStroke).
  function startStroke(e) {
    const rect = containerRef.current.getBoundingClientRect();
    gestureRect.current = rect;
    const sheet = pageUnderPoint(localPoint(e, rect));
    if (!sheet) return false;
    const p = prefsRef.current;
    const highlighter = p.tool === 'highlighter';
    const d = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      highlighter,
      color: highlighter ? p.hlColor : p.penColor,
      size: highlighter ? p.hlSize : p.penSize,
      points: [],
      shape: null,
      holdAnchor: null,
      holdTimer: null,
      sheet,
      // Where and when it began, and the link there: a stroke that is only a tap on a link opens the link instead.
      tap: { x: e.clientX, y: e.clientY, at: performance.now(), hit: linksOn() ? linkAt(e.clientX, e.clientY, linkPad(e)) : null },
    };
    d.points.push(localPoint(e, rect, d));
    drawing.current = d;
    capture(e);
    scheduleOverlay();
    return true;
  }

  function moveStroke(e) {
    const d = drawing.current;
    const rect = gestureRect.current;
    const native = e.nativeEvent || e;
    const events = native.getCoalescedEvents?.();
    for (const ev of events && events.length ? events : [native]) d.points.push(localPoint(ev, rect, d));
    const p = d.points[d.points.length - 1];
    if (d.shape) {
      const next = adjustShape(d.shape.base, d.shape.grab, p);
      if (shapeOnSheet(next, d)) d.shape.current = next;
    } else if (prefsRef.current.shapeSnap && !(d.highlighter && prefsRef.current.snapText)) {
      const radius = HOLD_RADIUS[d.pointerType] ?? 6;
      if (!d.holdAnchor || Math.hypot(p.x - d.holdAnchor.x, p.y - d.holdAnchor.y) > radius) {
        d.holdAnchor = p;
        clearTimeout(d.holdTimer);
        d.holdTimer = setTimeout(() => trySnap(d), HOLD_MS);
      }
    }
    scheduleOverlay();
  }

  // Pen held still at the end of a stroke: turn it into a clean shape that
  // keeps following the pen until it's lifted.
  function trySnap(d) {
    if (drawing.current !== d || d.shape) return;
    const shape = recognizeShape(d.points);
    if (!shape || !shapeOnSheet(shape, d)) return;
    const grab = d.points[d.points.length - 1];
    d.shape = { base: shape, grab, current: shape };
    try {
      navigator.vibrate?.(12);
    } catch {
      /* no vibration support */
    }
    scheduleOverlay();
  }

  function cancelStroke() {
    if (drawing.current) clearTimeout(drawing.current.holdTimer);
    drawing.current = null;
    scheduleOverlay();
  }

  function commitInk(d, added) {
    const api = apiRef.current;
    if (!api || !added.length) return;
    const existing = api.getSceneElementsIncludingDeleted();
    // Highlighter goes underneath the ink, like on paper.
    const elements = d.highlighter ? [...added, ...existing] : [...existing, ...added];
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    scheduleSave();
    commitInkHistory(); // each stroke is a step of its own
  }

  function endStroke() {
    const d = drawing.current;
    if (!d) return;
    clearTimeout(d.holdTimer);
    drawing.current = null;
    scheduleOverlay();
    const api = apiRef.current;
    if (!api) return;
    const st = api.getAppState();
    const zoom = st.zoom.value;
    const toScene = (p) => ({ x: p.x / zoom - st.scrollX, y: p.y / zoom - st.scrollY });
    const opacity = d.highlighter ? HIGHLIGHTER_OPACITY : 100;

    if (d.shape) {
      const strokeWidth = inkWidth(d.size, d.highlighter ? 0.5 : avgPressure(d)) / zoom;
      commitInk(d, shapeToElements(d.shape.current, toScene, { color: d.color, strokeWidth, opacity, zoom }));
      return;
    }

    const pts = d.points.map((p) => ({ ...toScene(p), pressure: p.pressure }));
    // A tap is a dot (the i's and full stops of handwriting).
    if (pts.length === 1) pts.push({ ...pts[0], x: pts[0].x + 0.1 / zoom });
    const r = d.sheet;
    const freehand = () => {
      const onSheet = (p) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
      const runs = pts.every(onSheet)
        ? [pts]
        : clipPolylineByPolygon(pts, [
            { x: r.x, y: r.y },
            { x: r.x + r.width, y: r.y },
            { x: r.x + r.width, y: r.y + r.height },
            { x: r.x, y: r.y + r.height },
          ]).insideRuns;
      const added = runs
        .filter((run) => run.length >= 2)
        .map((run) => {
          const el = strokeToFreedrawElement({ points: run, color: d.color, size: d.size / (EXCALIDRAW_FREEDRAW_SIZE_FACTOR * zoom), simulatePressure: false });
          el.opacity = opacity;
          el.roughness = 0;
          return el;
        });
      commitInk(d, added);
    };

    // A highlighter stroke over text becomes a real text highlight (searchable,
    // listed in the highlights panel, exported as a PDF highlight); anywhere
    // else — or with "snap to text" off — it stays freehand ink.
    if (d.highlighter && prefsRef.current.snapText && r.kind === 'pdf' && textRef.current) {
      const local = pts.map((p) => ({ x: p.x - r.x, y: p.y - r.y }));
      textRef.current
        .textUnderStroke(r.index, local)
        .then((found) => {
          if (found) {
            editMarks([{ pageKey: r.key, next: [...(marksRef.current.get(r.key) || []), newMark({ type: 'hl', color: d.color, rects: found.rects, text: found.text })] }]);
            try {
              navigator.vibrate?.(8);
            } catch {
              /* no vibration support */
            }
          } else freehand();
        })
        .catch(freehand);
      return;
    }
    freehand();
  }

  // ---------- stylus-button eraser ----------
  //
  // Like Excalidraw's own eraser: strokes touched during the gesture are
  // shown faded, and all deleted together when the pen lifts — one undo step.
  // Highlights the eraser passes over are removed too.

  function eraseAt(p) {
    const api = apiRef.current;
    const er = erasing.current;
    if (!api || !er) return;
    const st = api.getAppState();
    const zoom = st.zoom.value;
    const scene = { x: p.x / zoom - st.scrollX, y: p.y / zoom - st.scrollY };
    const radius = ERASER_RADIUS / zoom;
    for (const el of api.getSceneElements()) {
      if (!er.pending.has(el.id) && eraserHits(el, scene, radius)) er.pending.set(el.id, el);
    }
    const L = layoutRef.current;
    const i = pageUnder(L, scene.x, scene.y);
    if (i >= 0) {
      const r = pageRect(L, i);
      const key = L.pages[i].key;
      const m = hitMark(marksRef.current.get(key), scene.x - r.x, scene.y - r.y, radius);
      if (m) er.marks.set(m.id, key);
    }
  }

  function startErase(e) {
    const rect = containerRef.current.getBoundingClientRect();
    gestureRect.current = rect;
    const p = localPoint(e, rect);
    erasing.current = { pointerId: e.pointerId, last: p, pending: new Map(), marks: new Map() };
    eraserCursor.current = p;
    capture(e);
    eraseAt(p);
    scheduleOverlay();
  }

  function moveErase(e) {
    const er = erasing.current;
    const p = localPoint(e, gestureRect.current);
    // Sample along the movement so fast swipes don't skip strokes.
    const steps = Math.max(1, Math.ceil(Math.hypot(p.x - er.last.x, p.y - er.last.y) / (ERASER_RADIUS / 2)));
    for (let i = 1; i <= steps; i++) {
      eraseAt({ x: er.last.x + ((p.x - er.last.x) * i) / steps, y: er.last.y + ((p.y - er.last.y) * i) / steps });
    }
    er.last = p;
    eraserCursor.current = p;
    scheduleOverlay();
  }

  function endErase() {
    const er = erasing.current;
    erasing.current = null;
    eraserCursor.current = null;
    scheduleOverlay();
    const api = apiRef.current;
    if (!api || !er) return;
    flushPending();
    // The strokes and the highlights one swipe of the eraser removed come back together: one step.
    history.batch(() => {
      if (er.pending.size) {
        const elements = api.getSceneElementsIncludingDeleted().map((el) => (er.pending.has(el.id) ? newElementWith(el, { isDeleted: true }) : el));
        api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        scheduleSave();
        commitInkHistory();
      }
      const byPage = new Map();
      for (const [id, key] of er.marks) byPage.set(key, [...(byPage.get(key) || []), id]);
      const edits = [];
      for (const [key, ids] of byPage) {
        let next = marksRef.current.get(key) || [];
        for (const id of ids) next = deleteMark(next, id);
        edits.push({ pageKey: key, next });
      }
      if (edits.length) editMarks(edits);
    });
  }

  // Fades the strokes an erase gesture has touched so far.
  function drawPendingErasure(ctx) {
    const er = erasing.current;
    const api = apiRef.current;
    if (!er?.pending.size || !api) return;
    const st = api.getAppState();
    const zoom = st.zoom.value;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.82)';
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const el of er.pending.values()) {
      const outline = getCuttableOutline(el);
      if (!outline) {
        ctx.fillRect((el.x + st.scrollX) * zoom, (el.y + st.scrollY) * zoom, el.width * zoom, el.height * zoom);
        continue;
      }
      const w = el.type === 'freedraw' ? el.strokeWidth * EXCALIDRAW_FREEDRAW_SIZE_FACTOR * 1.6 : el.strokeWidth + 2;
      ctx.lineWidth = w * zoom + 3;
      ctx.beginPath();
      outline.forEach((pt, i) => {
        const x = (pt.x + st.scrollX) * zoom;
        const y = (pt.y + st.scrollY) * zoom;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      if (outline.length === 1) ctx.lineTo((outline[0].x + st.scrollX) * zoom + 0.1, (outline[0].y + st.scrollY) * zoom);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- paging ----------

  function goToPage(i, { keepZoom = false } = {}) {
    stopInitialView(); // a navigation in the first moments must not be overridden by the opening view
    const L = layoutRef.current;
    const rect = sizeRef.current;
    const index = Math.min(Math.max(i, 0), L.n - 1);
    if (modeRef.current === 'book') {
      bookPageRef.current = index;
      const p = L.pages[index];
      const v = currentView();
      const zoom = keepZoom && v ? Math.max(v.zoom, fitPageZoom(rect, p.w, p.h)) : fitPageZoom(rect, p.w, p.h);
      applyView(viewForPage(L, index, zoom, rect));
    } else {
      const v = currentView();
      const zoom = v?.zoom ?? fitWidthZoom(rect, L.maxW);
      const y = L.tops[index];
      const c = clampStackView(rect.width / (2 * zoom) - L.maxW / 2, 64 / zoom - y, zoom, rect, L);
      applyView({ zoom, ...c });
    }
    onTurn?.(index);
  }

  function turnPage(delta) {
    const from = modeRef.current === 'book' ? bookPageRef.current : currentIndexRef.current;
    const next = from + delta;
    if (next < 0 || next >= layoutRef.current.n) return false;
    goToPage(next);
    return true;
  }

  // ---------- links inside the PDF ----------
  //
  // A plain tap (no drag, no hold) on a link of the page opens it, whatever pen is in hand: the stroke that the tap would have
  // started is dropped. Only where a tap has no other meaning — with the pen, highlighter or text tools, or in a shared link —
  // not while shapes, the eraser, selection or snip are in use.

  function linksOn() {
    const p = prefsRef.current;
    if (snipOnRef.current || selectionToolRef.current || erasing.current) return false;
    return isDrawToolRef.current || textModeRef.current || !!p.readOnly;
  }

  // The link under a screen point: { link, index } (index = its page in the layout), or null. Only pages whose links were read.
  function linkAt(clientX, clientY, pad = 2) {
    const rect = containerRef.current?.getBoundingClientRect();
    const v = currentView();
    const links = linksRef.current;
    if (!rect || !v || !links) return null;
    const L = layoutRef.current;
    const x = (clientX - rect.left) / v.zoom - v.scrollX;
    const y = (clientY - rect.top) / v.zoom - v.scrollY;
    const index = pageUnder(L, x, y);
    if (index < 0 || L.pages[index].kind !== 'pdf') return null;
    if (modeRef.current === 'book' && index !== bookPageRef.current) return null; // only one page is shown there
    const r = pageRect(L, index);
    const link = hitLink(links.peek(L.pages[index].pdfIndex), x - r.x, y - r.y, pad / v.zoom);
    return link ? { link, index } : null;
  }

  const linkPad = (e) => (e.pointerType === 'touch' ? 6 : 2);

  // Opens what a link leads to: a web address outside the reader, or another page — with a way back.
  function openLink(link) {
    const target = link.target;
    if (target.type === 'url') {
      openExternal(target.url);
      return;
    }
    const from = modeRef.current === 'book' ? bookPageRef.current : currentIndexRef.current;
    const backView = currentView();
    const go = (index) => {
      if (index < 0 || index >= layoutRef.current.n || index === from) return;
      goToPage(index);
      toast(t('link.jumped', { n: index + 1 }), {
        action: {
          label: t('link.back'),
          onClick: () => {
            stopInitialView();
            if (modeRef.current === 'book' || !backView) goToPage(from);
            else applyView(backView);
          },
        },
      });
    };
    if (target.type === 'action') {
      const n = layoutRef.current.n;
      go({ NextPage: from + 1, PrevPage: from - 1, FirstPage: 0, LastPage: n - 1 }[target.name] ?? -1);
      return;
    }
    destPageIndex(pdf, target.dest).then((pdfIndex) => go(layoutRef.current.pages.findIndex((p) => p.kind === 'pdf' && p.pdfIndex === pdfIndex)));
  }

  // A tap at a pointer event's position: opens the link there, if there is one. True when it did.
  function tapLink(e) {
    if (!linksOn()) return false;
    const hit = linkAt(e.clientX, e.clientY, linkPad(e));
    if (!hit) return false;
    openLink(hit.link);
    return true;
  }

  function clearLinkHover() {
    if (!hoverLink.current) return;
    hoverLink.current = null;
    scheduleOverlay();
  }

  // The mouse or pen hovering over a link outlines it (so that it can be told from the text around it).
  function updateLinkHover(e) {
    const hit = e.pointerType !== 'touch' && e.buttons === 0 && linksOn() ? linkAt(e.clientX, e.clientY) : null;
    if ((hit?.link || null) === (hoverLink.current?.link || null)) return;
    hoverLink.current = hit;
    scheduleOverlay();
  }

  // ---------- find in text (Ctrl+F) ----------

  // Brings page li on screen unless (part of) it already is.
  function ensurePage(li) {
    if (modeRef.current === 'book') {
      if (bookPageRef.current !== li) goToPage(li, { keepZoom: true });
      return;
    }
    const v = currentView();
    if (!v || !visiblePages(layoutRef.current, v, sizeRef.current).includes(li)) goToPage(li);
  }

  // Scrolls (without changing the zoom) so a rectangle of page li — [x, y, w, h], page-local px — is in the
  // clear part of the screen, between the find bar and the page bar; nothing moves if it already is.
  function revealRect(li, [x, y, w, h]) {
    stopInitialView();
    const v = currentView();
    const rect = sizeRef.current;
    if (!v || !rect.width) return;
    const r = pageRect(layoutRef.current, li);
    const left = (r.x + x + v.scrollX) * v.zoom;
    const top = (r.y + y + v.scrollY) * v.zoom;
    const right = left + w * v.zoom;
    const bottom = top + h * v.zoom;
    const air = 12;
    const fitsX = left >= INSETS.side + air && right <= rect.width - INSETS.side - air;
    const fitsY = top >= INSETS.top + air && bottom <= rect.height - INSETS.bottom - air;
    if (fitsX && fitsY) return;
    const midY = (INSETS.top + rect.height - INSETS.bottom) / 2;
    const scrollY = fitsY ? v.scrollY : midY / v.zoom - (r.y + y + h / 2);
    const scrollX = fitsX ? v.scrollX : rect.width / 2 / v.zoom - (r.x + x + w / 2);
    applyView({ zoom: v.zoom, ...clampView(scrollX, scrollY, v.zoom) });
  }

  const find = useFind({
    pdf,
    layoutRef,
    textRef,
    open: findOpen,
    setOpen: setFindOpen,
    hitsRef: findHitsRef,
    currentLayoutIndex: () => (modeRef.current === 'book' ? bookPageRef.current : currentIndexRef.current),
    ensurePage,
    revealRect,
    redraw: scheduleSyncPaper,
  });
  findRef.current = find;

  // One screen further down, with a little overlap so the eye keeps its place.
  function scrollByScreen(dir) {
    stopInitialView();
    const v = currentView();
    const rect = sizeRef.current;
    if (!v) return;
    const dy = ((rect.height - 128) * 0.92) / v.zoom;
    const c = clampView(v.scrollX, v.scrollY - dir * dy, v.zoom);
    applyView({ ...c, zoom: v.zoom });
  }

  // Double-tap: fit the page; on a fitted page, zoom to the page width around
  // where you tapped (handy on phones in portrait).
  function toggleFit(clientY) {
    const rect = containerRef.current?.getBoundingClientRect();
    const v = currentView();
    if (!rect || !v) return;
    const L = layoutRef.current;
    const sceneY = (clientY - rect.top) / v.zoom - v.scrollY;
    const i = modeRef.current === 'book' ? bookPageRef.current : pageAtY(L, sceneY);
    const p = L.pages[i];
    const fitP = fitPageZoom(rect, p.w, p.h);
    const fitW = Math.min(fitWidthZoom(rect, p.w), MAX_ZOOM);
    if (Math.abs(v.zoom - fitP) < 0.01 && fitW > fitP * 1.08) {
      const r = pageRect(L, i);
      const scrollY = (clientY - rect.top) / fitW - sceneY;
      const scrollX = rect.width / (2 * fitW) - (r.x + r.width / 2);
      applyView({ zoom: fitW, ...clampView(scrollX, scrollY, fitW) });
    } else if (modeRef.current === 'book') {
      applyView(viewForPage(L, i, fitP, rect));
    } else {
      const zoom = Math.min(Math.max(fitWidthZoom(rect, L.maxW), zoomLimits().min), MAX_ZOOM);
      const scrollY = (clientY - rect.top) / zoom - sceneY;
      applyView({ zoom, ...clampView(rect.width / (2 * zoom) - L.maxW / 2, scrollY, zoom) });
    }
  }

  // ---------- finger scrolling, pinch, taps ----------

  function stopInertia() {
    if (inertiaRAF.current) cancelAnimationFrame(inertiaRAF.current);
    inertiaRAF.current = null;
  }

  function panBy(dx, dy) {
    const v = currentView();
    const rect = sizeRef.current;
    if (!v || !rect.width) return false;
    const c = clampView(v.scrollX + dx / v.zoom, v.scrollY + dy / v.zoom, v.zoom);
    const moved = Math.abs(c.scrollX - v.scrollX) > 0.001 || Math.abs(c.scrollY - v.scrollY) > 0.001;
    if (moved) applyView({ ...c, zoom: v.zoom });
    return moved;
  }

  function startInertia(vx, vy) {
    stopInertia();
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(48, now - last);
      last = now;
      const decay = Math.pow(0.94, dt / 16);
      vx *= decay;
      vy *= decay;
      if (Math.hypot(vx, vy) < 0.03 || !panBy(vx * dt, vy * dt)) {
        inertiaRAF.current = null;
        return;
      }
      inertiaRAF.current = requestAnimationFrame(step);
    };
    inertiaRAF.current = requestAnimationFrame(step);
  }

  function startPinch() {
    const v = currentView();
    if (!v) return;
    const [p1, p2] = [...touchPoints.current.values()];
    pinchTrack.current = {
      prevDist: Math.hypot(p2.x - p1.x, p2.y - p1.y),
      prevMidX: (p1.x + p2.x) / 2,
      prevMidY: (p1.y + p2.y) / 2,
      zoom: v.zoom,
      scrollX: v.scrollX,
      scrollY: v.scrollY,
    };
  }

  // Incremental (frame-to-frame) pinch: a single noisy touch sample can't
  // throw the rest of the gesture off (found in Quarc Notes).
  function updatePinch() {
    const api = apiRef.current;
    const rect = containerRef.current?.getBoundingClientRect();
    const pin = pinchTrack.current;
    if (!api || !rect || !rect.width || !pin) return;
    const [p1, p2] = [...touchPoints.current.values()];
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    if (dist < 8 || pin.prevDist < 8) {
      pin.prevDist = dist;
      pin.prevMidX = midX;
      pin.prevMidY = midY;
      return;
    }
    const { min, max } = zoomLimits();
    const zoom = Math.min(Math.max(pin.zoom * (dist / pin.prevDist), min), max);
    const anchorX = (pin.prevMidX - rect.left) / pin.zoom - pin.scrollX;
    const anchorY = (pin.prevMidY - rect.top) / pin.zoom - pin.scrollY;
    const c = clampView((midX - rect.left) / zoom - anchorX, (midY - rect.top) / zoom - anchorY, zoom);
    applyView({ ...c, zoom });
    Object.assign(pin, { prevDist: dist, prevMidX: midX, prevMidY: midY, zoom, scrollX: c.scrollX, scrollY: c.scrollY });
  }

  // Does the current page fit entirely on screen (so a swipe can only mean "turn")?
  function pageFitsScreen() {
    const v = currentView();
    const rect = sizeRef.current;
    const L = layoutRef.current;
    const p = L.pages[bookPageRef.current];
    if (!v || !p) return false;
    return p.w * v.zoom <= rect.width + 1 && p.h * v.zoom <= rect.height + 1;
  }

  function handleTap(e, track) {
    const moved = Math.hypot(e.clientX - track.startClientX, e.clientY - track.startClientY);
    if (moved > TAP_MOVE_TOLERANCE) {
      lastTap.current = null;
      return;
    }
    // A finger on a link opens it (before the page-turning edge, and not as half of a double-tap).
    if (e.type !== 'pointercancel' && tapLink(e)) {
      lastTap.current = null;
      return;
    }
    // Book mode: tapping the outer edge turns the page.
    if (modeRef.current === 'book' && e.pointerType === 'touch' && prefsRef.current.pageTurn !== 'swipe') {
      const rect = containerRef.current.getBoundingClientRect();
      const fx = (e.clientX - rect.left) / rect.width;
      if (fx < EDGE_TAP_FRACTION || fx > 1 - EDGE_TAP_FRACTION) {
        lastTap.current = null;
        turnPage(fx < 0.5 ? -1 : 1);
        return;
      }
    }
    const now = Date.now();
    const last = lastTap.current;
    if (last && now - last.time < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_TAP_DIST) {
      lastTap.current = null;
      toggleFit(e.clientY);
    } else {
      lastTap.current = { time: now, x: e.clientX, y: e.clientY };
    }
  }

  // ---------- pointer routing (capture phase, before Excalidraw) ----------
  //
  //  - Pen/mouse/finger strokes while the pen tool is on are drawn by us
  //    (real pressure, hold-to-snap, highlighter). Every other tool gets
  //    the input natively, so Excalidraw's eraser/select/shapes/text work.
  //  - The stylus button / eraser end erases strokes, whatever the tool.
  //  - Fingers: draw (if "finger draws" is on), else one finger scrolls the
  //    page (with momentum; in book mode a swipe turns it), two fingers
  //    pinch-zoom/pan, two-finger tap undoes, double-tap fits. Touches near
  //    pen activity or with a palm-sized contact are a resting hand.
  //  - Text mode: one finger/mouse belongs to the text layer (selection);
  //    only a second finger (pinch) and the wheel are ours.

  function consume(e) {
    e.stopPropagation();
    e.preventDefault();
  }

  function handlePointerDownCapture(e) {
    // Only the drawing surface itself: taps on any UI floating above it
    // (Excalidraw's toolbar and menus, the page navigator, text being
    // edited) must keep working normally with every pointer type.
    // (Not simply "is a canvas": in book mode the ink canvases are clipped to the page, so a
    // touch in the margin beside it lands on whatever is underneath.)
    const onUi = !!e.target.closest?.('button, input, textarea, select, a, label, .Island, [role=dialog], [data-selection-bar], [data-overlay], aside');
    const onSurface = !onUi && !!containerRef.current?.contains(e.target);
    const onText = !!e.target.closest?.('.quarc-text-layer');
    if (!onSurface && !(textModeRef.current && onText)) return;
    stopInertia();
    stopInitialView();
    clearLinkHover();

    if (textModeRef.current) {
      // A second finger starts a pinch even over the text; one pointer is the text layer's.
      if (e.pointerType === 'touch') {
        touchPoints.current.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });
        if (touchPoints.current.size >= 2) {
          consume(e);
          startPinch();
        }
      }
      return;
    }

    const p = prefsRef.current;
    // (In a shared link, which is read-only, a finger has nothing to draw: it chooses the snip region.)
    const fingerSelects = e.pointerType !== 'touch' || p.fingerDraws || (p.readOnly && snipOnRef.current);
    // Snip tool: a drag chooses (or moves, or resizes) the region.
    if (snipOnRef.current && fingerSelects && !(e.pointerType === 'touch' && Date.now() - lastPenActivity.current < PALM_WINDOW_MS)) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      consume(e);
      if (snipDrag.current) return;
      if (e.pointerType === 'pen') lastPenActivity.current = Date.now();
      startSnipDrag(e);
      return;
    }
    if (selectionToolRef.current && fingerSelects && !(e.pointerType === 'touch' && Date.now() - lastPenActivity.current < PALM_WINDOW_MS)) {
      if (selectionDrawing.current) {
        consume(e);
        return;
      }
      if (e.pointerType === 'pen') lastPenActivity.current = Date.now();
      consume(e);
      const rect = containerRef.current.getBoundingClientRect();
      gestureRect.current = rect;
      selectionDrawing.current = { pointerId: e.pointerId, mode: selectionToolRef.current, points: [localPoint(e, rect)] };
      capture(e);
      return;
    }

    if (e.pointerType === 'pen') {
      lastPenActivity.current = Date.now();
      if (!useSettings.getState().penSeen) updatePrefs({ penSeen: true });
      // A palm that landed just before the pen: undo its scroll.
      if (touchPan.current) {
        applyView(touchPan.current.startView);
        touchPan.current = null;
      }
      if (drawing.current?.pointerType === 'touch') cancelStroke();
      if (p.readOnly) {
        consume(e);
        beginPan(e);
        return;
      }
      if (isEraserButton(e)) {
        consume(e);
        startErase(e);
        return;
      }
      if (!isDrawToolRef.current) return;
      consume(e);
      startStroke(e);
      return;
    }

    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return;
      if (p.readOnly) {
        consume(e);
        beginPan(e);
        return;
      }
      if (!isDrawToolRef.current) return;
      consume(e);
      startStroke(e);
      return;
    }

    if (e.pointerType !== 'touch') return;
    const palm =
      (e.width > PALM_SIZE && e.height > PALM_SIZE) || drawing.current?.pointerType === 'pen' || erasing.current || Date.now() - lastPenActivity.current < PALM_WINDOW_MS;
    if (palm) {
      consume(e);
      ignoredTouches.current.add(e.pointerId);
      return;
    }

    touchPoints.current.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });

    if (touchPoints.current.size >= 2) {
      // The first finger was really the start of a pinch.
      if (drawing.current?.pointerType === 'touch') cancelStroke();
      touchPan.current = null;
      touchTrack.current = null;
      consume(e);
      startPinch();
      twoFingerTap.current = touchPoints.current.size === 2 ? { start: Date.now(), moved: false } : null;
      return;
    }

    if (isDrawToolRef.current || selectionToolRef.current || snipOnRef.current || p.readOnly) {
      consume(e);
      touchTrack.current = { pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, consumed: true };
      // A finger that draws still scrolls when it lands on the desk.
      if (!(p.fingerDraws && !selectionToolRef.current && !snipOnRef.current && startStroke(e))) beginPan(e);
      return;
    }

    // Other tools: only pre-empt what looks like the second tap of a
    // double-tap, so Excalidraw's own double-tap zoom doesn't fire too.
    const now = Date.now();
    const last = lastTap.current;
    const secondTap = !!last && now - last.time < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_TAP_DIST;
    touchTrack.current = { pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, consumed: secondTap };
    if (secondTap) consume(e);
  }

  // One finger (or a mouse/pen in the read-only view) drags the page.
  function beginPan(e) {
    touchPan.current = {
      pointerId: e.pointerId,
      lastX: e.clientX,
      lastY: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      startView: currentView(),
      samples: [{ t: performance.now(), x: e.clientX, y: e.clientY }],
      pointerType: e.pointerType,
    };
    if (e.pointerType !== 'touch') touchPoints.current.delete(e.pointerId);
    capture(e);
  }

  function handlePointerMoveCapture(e) {
    if (e.pointerType === 'pen') lastPenActivity.current = Date.now();
    lastPointer.current = { x: e.clientX, y: e.clientY };
    updateLinkHover(e);
    if (ignoredTouches.current.has(e.pointerId)) {
      consume(e);
      return;
    }
    const snipD = snipDrag.current;
    if (snipD && e.pointerId === snipD.pointerId) {
      consume(e);
      moveSnipDrag(e);
      return;
    }
    if (snipOnRef.current && !snipD && e.pointerType === 'mouse') updateSnipCursor(e);
    const sel = selectionDrawing.current;
    if (sel && e.pointerId === sel.pointerId) {
      consume(e);
      sel.points.push(localPoint(e, gestureRect.current));
      scheduleOverlay();
      return;
    }
    if (drawing.current && e.pointerId === drawing.current.pointerId) {
      consume(e);
      moveStroke(e);
      return;
    }
    if (erasing.current && e.pointerId === erasing.current.pointerId) {
      consume(e);
      moveErase(e);
      return;
    }

    const pan0 = touchPan.current;
    if (pan0 && pan0.pointerId === e.pointerId && pan0.pointerType !== 'touch') {
      consume(e);
      panBy(e.clientX - pan0.lastX, e.clientY - pan0.lastY);
      pan0.lastX = e.clientX;
      pan0.lastY = e.clientY;
      return;
    }

    if (!touchPoints.current.has(e.pointerId)) return;
    const tp = touchPoints.current.get(e.pointerId);
    tp.x = e.clientX;
    tp.y = e.clientY;

    if (touchPoints.current.size >= 2 && pinchTrack.current) {
      consume(e);
      if (twoFingerTap.current && Math.hypot(tp.x - tp.startX, tp.y - tp.startY) > 12) twoFingerTap.current.moved = true;
      if (!pinchRAF.current) {
        pinchRAF.current = requestAnimationFrame(() => {
          pinchRAF.current = null;
          if (touchPoints.current.size >= 2 && pinchTrack.current) updatePinch();
        });
      }
      return;
    }

    const pan = touchPan.current;
    if (pan && pan.pointerId === e.pointerId) {
      consume(e);
      // Content follows the finger.
      panBy(e.clientX - pan.lastX, e.clientY - pan.lastY);
      pan.lastX = e.clientX;
      pan.lastY = e.clientY;
      const now = performance.now();
      pan.samples.push({ t: now, x: e.clientX, y: e.clientY });
      while (pan.samples.length > 2 && now - pan.samples[0].t > 100) pan.samples.shift();
      return;
    }

    if (touchTrack.current?.pointerId === e.pointerId && touchTrack.current.consumed) consume(e);
  }

  function handlePointerUpCapture(e) {
    if (ignoredTouches.current.delete(e.pointerId)) {
      consume(e);
      return;
    }
    const snipD = snipDrag.current;
    if (snipD && e.pointerId === snipD.pointerId) {
      consume(e);
      endSnipDrag();
      return;
    }
    const sel = selectionDrawing.current;
    if (sel && e.pointerId === sel.pointerId) {
      consume(e);
      finalizeSelection();
      return;
    }
    if (drawing.current && e.pointerId === drawing.current.pointerId) {
      consume(e);
      const tap = drawing.current.tap;
      const isTap = !!tap?.hit && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) <= TAP_MOVE_TOLERANCE && performance.now() - tap.at < LINK_TAP_MS;
      if (e.type === 'pointercancel') cancelStroke();
      else if (isTap) {
        cancelStroke(); // not a mark of the pen: a tap on a link
        openLink(tap.hit.link);
      } else endStroke();
      if (e.pointerType === 'touch') {
        touchPoints.current.delete(e.pointerId);
        touchTrack.current = null;
      }
      return;
    }
    if (erasing.current && e.pointerId === erasing.current.pointerId) {
      consume(e);
      endErase();
      return;
    }
    const pan0 = touchPan.current;
    if (pan0 && pan0.pointerId === e.pointerId && pan0.pointerType !== 'touch') {
      touchPan.current = null;
      consume(e);
      if (e.type !== 'pointercancel' && Math.hypot(e.clientX - pan0.startX, e.clientY - pan0.startY) <= TAP_MOVE_TOLERANCE) tapLink(e); // a shared link: a tap opens a link
      return;
    }
    if (!touchPoints.current.has(e.pointerId)) {
      if (textModeRef.current && e.pointerType !== 'touch') handleTextTap(e);
      return;
    }

    const wasPinching = touchPoints.current.size >= 2 && !!pinchTrack.current;
    const track = touchTrack.current?.pointerId === e.pointerId ? touchTrack.current : null;
    const pan = touchPan.current?.pointerId === e.pointerId ? touchPan.current : null;
    const tpEntry = touchPoints.current.get(e.pointerId);
    touchPoints.current.delete(e.pointerId);

    if (touchPoints.current.size < 2) {
      pinchTrack.current = null;
      if (pinchRAF.current) cancelAnimationFrame(pinchRAF.current);
      pinchRAF.current = null;
    }
    const tap = twoFingerTap.current;
    if (tap && touchPoints.current.size === 0) {
      twoFingerTap.current = null;
      if (!tap.moved && Date.now() - tap.start < TWO_FINGER_TAP_MS && !textModeRef.current) undo();
    }

    if (pan) {
      touchPan.current = null;
      consume(e);
      // Book mode, whole page on screen: a swipe turns the page.
      const dx = e.clientX - pan.startX;
      const dy = e.clientY - pan.startY;
      if (modeRef.current === 'book' && prefsRef.current.pageTurn !== 'tap' && pageFitsScreen()) {
        const horizontal = Math.abs(dx) > SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.4;
        const vertical = Math.abs(dy) > SWIPE_MIN * 1.3 && Math.abs(dy) > Math.abs(dx) * 1.4;
        if (horizontal || vertical) {
          turnPage((horizontal ? dx : dy) < 0 ? 1 : -1);
          if (track) touchTrack.current = null;
          return;
        }
      }
      const samples = pan.samples;
      if (samples.length >= 2) {
        const a = samples[0];
        const b = samples[samples.length - 1];
        const dt = b.t - a.t;
        if (dt > 0 && performance.now() - b.t < 60) startInertia((b.x - a.x) / dt, (b.y - a.y) / dt);
      }
    }
    if (track) {
      touchTrack.current = null;
      if (track.consumed) consume(e);
      if (!textModeRef.current) handleTap(e, track);
      return;
    }
    if (wasPinching) consume(e);
    if (textModeRef.current && tpEntry && !wasPinching) handleTextTap(e);
  }

  // A tap (not a drag) in text mode that lands on a highlight opens it.
  function handleTextTap(e) {
    window.setTimeout(() => {
      if (window.getSelection()?.toString()) return; // a selection, not a tap
      const rect = containerRef.current?.getBoundingClientRect();
      const v = currentView();
      if (!rect || !v) return;
      const L = layoutRef.current;
      const x = (e.clientX - rect.left) / v.zoom - v.scrollX;
      const y = (e.clientY - rect.top) / v.zoom - v.scrollY;
      const i = pageUnder(L, x, y);
      if (i < 0) {
        setMarkPop(null);
        return;
      }
      const r = pageRect(L, i);
      const key = L.pages[i].key;
      const mark = hitMark(marksRef.current.get(key), x - r.x, y - r.y, 3);
      setMarkPop(mark ? { pageKey: key, mark, anchor: { x: e.clientX, y: e.clientY } } : null);
      if (!mark) tapLink(e); // a link on plain text opens (a highlight on it is opened first: it can be edited)
    }, 30);
  }

  // Wheel / trackpad: scrolling and zooming are Excalidraw's own; in book mode
  // pushing past the end of the page turns it.
  const wheelAccum = useRef(0);
  const wheelTimer = useRef(null);
  function handleWheelCapture(e) {
    stopInitialView();
    clearLinkHover();
    if (modeRef.current !== 'book' || e.ctrlKey || e.metaKey) return;
    const v = currentView();
    if (!v) return;
    const c = clampView(v.scrollX, v.scrollY - e.deltaY / v.zoom, v.zoom);
    const atEdge = Math.abs(c.scrollY - (v.scrollY - e.deltaY / v.zoom)) > 0.5;
    if (!atEdge) {
      wheelAccum.current = 0;
      return;
    }
    wheelAccum.current += e.deltaY;
    clearTimeout(wheelTimer.current);
    wheelTimer.current = setTimeout(() => (wheelAccum.current = 0), 250);
    if (Math.abs(wheelAccum.current) > 120) {
      const dir = wheelAccum.current > 0 ? 1 : -1;
      wheelAccum.current = 0;
      turnPage(dir);
    }
  }

  // Keyboard: page turning and the reading shortcuts.
  useEffect(() => {
    const onKey = (e) => {
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const book = modeRef.current === 'book';
      switch (e.key) {
        case 'PageDown':
        case 'ArrowRight':
          if (book) turnPage(1);
          else if (e.key === 'PageDown') scrollByScreen(1);
          else return;
          break;
        case ' ':
          if (book) turnPage(e.shiftKey ? -1 : 1);
          else scrollByScreen(e.shiftKey ? -1 : 1);
          break;
        case 'PageUp':
        case 'ArrowLeft':
          if (book) turnPage(-1);
          else if (e.key === 'PageUp') scrollByScreen(-1);
          else return;
          break;
        case 'ArrowDown':
          if (book && pageFitsScreen()) turnPage(1);
          else return;
          break;
        case 'ArrowUp':
          if (book && pageFitsScreen()) turnPage(-1);
          else return;
          break;
        case 'Home':
          goToPage(0);
          break;
        case 'End':
          goToPage(layoutRef.current.n - 1);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Find in text: Ctrl+F / Cmd+F opens the bar — before the browser's own find, and before Excalidraw's canvas
  // search, which this replaces — F3 / Ctrl+G go to the next hit (Shift: the previous), Esc closes the bar.
  useEffect(() => {
    const onKey = (e) => {
      const f = findRef.current;
      if (!f || !e.key) return;
      if (document.querySelector('div[class*="z-[1100]"] [role=dialog]')) return; // a dialog has the floor
      const key = e.key.toLowerCase();
      const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
      let handled = true;
      if (mod && key === 'f') f.openFind();
      else if (f.isOpen && (key === 'f3' || (mod && key === 'g'))) (e.shiftKey ? f.prev : f.next)();
      else if (f.isOpen && key === 'escape') f.closeFind();
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // ---------- snip: copy or save a region of a page ----------
  //
  // The dock's Snip button: drag a rectangle on a page (the rest dims), move or resize it by its handles, then copy
  // it as a picture (Ctrl+C), save it, or copy the words in it. The picture is drawn again from the document at
  // full sharpness (snipRender.js). Ctrl+V pastes a picture or text (from here or from any other program) onto
  // the page, as a thing that can be moved at once.

  function snipToScreen(s) {
    const v = currentView();
    const r = pageRect(layoutRef.current, s.pageIndex);
    return { x: (r.x + s.x + v.scrollX) * v.zoom, y: (r.y + s.y + v.scrollY) * v.zoom, w: s.w * v.zoom, h: s.h * v.zoom };
  }

  // The dimmed page around the region, its outline and the eight handles — on a canvas of its own, above the page
  // and below the bars, redrawn with every change of the view so it stays on the page.
  function drawSnip() {
    const canvas = snipCanvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;
    ctx.clearRect(0, 0, W, H);
    const s = snipRef.current;
    if (!snipOnRef.current || !s || !currentView()) return;
    const r = snipToScreen(s);
    ctx.save();
    ctx.fillStyle = 'rgba(24, 16, 40, 0.45)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.fill('evenodd');
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#7c3aed';
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.setLineDash([]);
    if (r.w >= 14 && r.h >= 14) {
      ctx.fillStyle = '#ffffff';
      for (const [hx, hy] of Object.values(handlePoints(r))) {
        ctx.beginPath();
        ctx.roundRect(hx - 5, hy - 5, 10, 10, 3);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function setSnip(next) {
    snipRef.current = next;
    setSnipRect(next ? { ...next } : null);
    drawSnip();
  }

  function pageBounds(pageIndex) {
    const r = pageRect(layoutRef.current, pageIndex);
    return { w: r.width, h: r.height };
  }

  function startSnipDrag(e) {
    const v = currentView();
    if (!v) return;
    const box = containerRef.current.getBoundingClientRect();
    gestureRect.current = box;
    const pt = localPoint(e, box);
    const cur = snipRef.current;
    const hit = cur ? hitTest(snipToScreen(cur), pt, e.pointerType === 'touch' ? 18 : 10) : null;
    if (hit) {
      capture(e);
      snipDrag.current = { pointerId: e.pointerId, kind: hit, start: pt, rect0: { x: cur.x, y: cur.y, w: cur.w, h: cur.h }, zoom: v.zoom, bounds: pageBounds(cur.pageIndex) };
      return;
    }
    const pg = pageUnderPoint(pt);
    if (!pg) {
      setSnip(null); // a press on the desk beside the pages: no region
      return;
    }
    capture(e);
    const bounds = { w: pg.width, h: pg.height };
    const anchor = clampPoint({ x: pt.x / v.zoom - v.scrollX - pg.x, y: pt.y / v.zoom - v.scrollY - pg.y }, bounds);
    snipDrag.current = { pointerId: e.pointerId, kind: 'new', anchor, origin: pg, bounds };
    snipRef.current = { pageIndex: pg.index, key: pg.key, x: anchor.x, y: anchor.y, w: 0, h: 0 };
    drawSnip();
  }

  function moveSnipDrag(e) {
    const d = snipDrag.current;
    const v = currentView();
    if (!d || !v) return;
    const pt = localPoint(e, gestureRect.current);
    if (d.kind === 'new') {
      const p = clampPoint({ x: pt.x / v.zoom - v.scrollX - d.origin.x, y: pt.y / v.zoom - v.scrollY - d.origin.y }, d.bounds);
      snipRef.current = { ...snipRef.current, ...rectFromPoints(d.anchor, p) };
    } else {
      snipRef.current = { ...snipRef.current, ...dragRect(d.rect0, d.kind, (pt.x - d.start.x) / d.zoom, (pt.y - d.start.y) / d.zoom, d.bounds) };
    }
    drawSnip();
  }

  function endSnipDrag() {
    const d = snipDrag.current;
    snipDrag.current = null;
    const s = snipRef.current;
    if (!s) return;
    // A click (or a sliver) is not a region: it clears the last one.
    if (d?.kind === 'new' && (s.w < MIN_SIZE || s.h < MIN_SIZE)) setSnip(null);
    else setSnip({ ...s });
  }

  // The cursor over the region: the handle's arrows, a cross-hair elsewhere.
  function updateSnipCursor(e) {
    const el = containerRef.current;
    const s = snipRef.current;
    if (!el || !currentView()) return;
    const box = el.getBoundingClientRect();
    const hit = s ? hitTest(snipToScreen(s), { x: e.clientX - box.left, y: e.clientY - box.top }, 10) : null;
    el.style.cursor = CURSORS[hit] || 'crosshair';
  }

  function startSnip() {
    if (snipOnRef.current) return;
    snipOnRef.current = true;
    setFindOpen(false);
    toolBeforeSnip.current = { textMode: textModeRef.current, tool: activeToolType };
    setTextMode(false);
    clearTextSelection();
    setSelectionTool(null);
    apiRef.current?.setActiveTool({ type: 'selection' });
    setSnip(null);
    setSnipOn(true);
  }

  function stopSnip({ restore = true } = {}) {
    if (!snipOnRef.current) return;
    snipOnRef.current = false;
    snipDrag.current = null;
    setSnip(null);
    setSnipOn(false);
    if (containerRef.current) containerRef.current.style.cursor = '';
    const prev = toolBeforeSnip.current;
    toolBeforeSnip.current = null;
    if (restore && prev) {
      if (prev.textMode) {
        setTextMode(true);
        apiRef.current?.setActiveTool({ type: 'hand' });
      } else {
        apiRef.current?.setActiveTool({ type: prev.tool || 'freedraw' });
      }
    }
    scheduleSyncPaper(); // the text layers can go again
  }

  // The picture of the region: the page, and (unless switched off) my highlights, ink, shapes, text and pictures.
  async function snipPicture() {
    const s = snipRef.current;
    const L = layoutRef.current;
    const page = s && L.pages[s.pageIndex];
    if (!page) return null;
    const v = currentView();
    const scale = outputScale({ w: s.w, h: s.h, zoom: v?.zoom || 1, dpr: window.devicePixelRatio || 1 });
    const withInk = useSettings.getState().snipAnnotations;
    const api = apiRef.current;
    const ink = withInk && api ? { elements: bucketElements(L, api.getSceneElements()).get(page.key) || [], files: api.getFiles() } : null;
    const out = await renderRegion({ pdf, page, rect: s, scale, marks: withInk ? marksRef.current.get(page.key) || [] : [], ink });
    return { ...out, name: snipName(title, s.pageIndex + 1) };
  }

  async function snipAct(kind) {
    if (snipBusy || !snipRef.current) return;
    setSnipBusy(true);
    try {
      if (kind === 'text') {
        const s = snipRef.current;
        const text = await textRef.current?.textInRect(s.pageIndex, s);
        if (!text) {
          toast(t('snip.noText'));
          return;
        }
        await copyTextToClipboard(text);
        toast(t('snip.textCopied'));
      } else if (kind === 'save') {
        const pic = await snipPicture();
        if (!pic) return;
        const result = await saveBlob(pic.blob, pic.name);
        if (result !== 'cancelled') toast(result === 'saved' ? t('snip.saved') : result === 'shared' ? t('snip.shared') : t('snip.downloaded'));
      } else {
        // The clipboard write starts at once, with the picture still to come: browsers want it inside the key press / tap.
        const made = snipPicture();
        const region = { w: snipRef.current.w, h: snipRef.current.h };
        try {
          await copyImageToClipboard(made.then((p) => p.blob));
          const pic = await made;
          lastCopy.current = { picW: pic.width, picH: pic.height, ...region };
          toast(t('snip.copied'));
        } catch {
          const pic = await made.catch(() => null);
          if (pic && window.Capacitor?.isNativePlatform?.()) {
            await saveBlob(pic.blob, pic.name);
            toast(t('snip.copyFallback'));
          } else {
            toast(t('snip.copyFailed'), { duration: 7000 });
          }
        }
      }
    } catch {
      toast(t('snip.failed'));
    } finally {
      setSnipBusy(false);
    }
  }
  snipActions.current = { copy: () => snipAct('copy'), save: () => snipAct('save'), text: () => snipAct('text'), stop: () => stopSnip() };

  // Snip keys: Esc leaves the tool; Ctrl/Cmd+C copies the picture of the region, Ctrl/Cmd+S saves it.
  useEffect(() => {
    const onKey = (e) => {
      if (!snipOnRef.current || !e.key) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (document.querySelector('div[class*="z-[1100]"] [role=dialog]')) return;
      const key = e.key.toLowerCase();
      const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
      let handled = true;
      if (key === 'escape') snipActions.current.stop();
      else if (mod && key === 'c' && snipRef.current) snipActions.current.copy();
      else if (mod && key === 's' && snipRef.current) snipActions.current.save();
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Opening the find bar and the snip tool both want the top of the page: the last one wins.
  useEffect(() => {
    if (findOpen) stopSnip();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen]);

  // Ctrl+V: Excalidraw does the pasting (pictures, text, things copied from here) but only when it has the focus and the
  // pointer last rested on its canvas — so make that so, with the paste going where the pointer is (else the middle).
  // What was pasted is selected: switch to the select tool so it can be moved straight away.
  useEffect(() => {
    const onPaste = () => {
      if (prefsRef.current.readOnly) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (document.querySelector('div[class*="z-[1100]"] [role=dialog]')) return;
      const container = containerRef.current;
      const ex = container?.querySelector('.excalidraw');
      if (!ex) return;
      if (!ex.contains(document.activeElement)) ex.focus({ preventScroll: true });
      const box = container.getBoundingClientRect();
      const last = lastPointer.current;
      const over = last && last.x >= box.left && last.x <= box.right && last.y >= box.top && last.y <= box.bottom && document.elementFromPoint(last.x, last.y) instanceof HTMLCanvasElement;
      const at = over ? last : { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: at.x, clientY: at.y, bubbles: true }));
      selectAfterPaste();
    };
    window.addEventListener('paste', onPaste, true);
    return () => window.removeEventListener('paste', onPaste, true);
  }, []);

  // Once what was pasted is selected: switch to the select tool; and bring a pasted picture to a sensible size as soon as
  // it has loaded (it arrives at its own pixel size — see pastedPictureSize), keeping its centre where it was put.
  function selectAfterPaste() {
    const api = apiRef.current;
    if (!api) return;
    const before = JSON.stringify(api.getAppState().selectedElementIds || {});
    const existing = new Set(api.getSceneElementsIncludingDeleted().map((el) => el.id));
    const sized = new Set();
    const lastDims = new Map();
    let tries = 0;
    let switched = false;
    const timer = setInterval(() => {
      tries++;
      const selected = api.getAppState().selectedElementIds || {};
      if (!switched) {
        if (Object.keys(selected).length && JSON.stringify(selected) !== before) {
          switched = true;
          stopSnip({ restore: false });
          chooseTool('selection');
        } else if (tries > 25) {
          clearInterval(timer);
          return;
        }
      }
      if (!switched) return;
      const L = layoutRef.current;
      const fix = new Map();
      const files = api.getFiles();
      const zoom = api.getAppState().zoom.value;
      let waiting = 0;
      for (const el of api.getSceneElements()) {
        if (el.type !== 'image' || existing.has(el.id) || !selected[el.id] || sized.has(el.id)) continue;
        // Until the picture has been decoded Excalidraw gives it a 100 px square placeholder; wait for the real size, and
        // for it to stop changing.
        const dims = `${el.width}x${el.height}`;
        const placeholder = Math.abs(el.width - 100 / zoom) < 0.01 && Math.abs(el.height - 100 / zoom) < 0.01;
        const steady = lastDims.get(el.id) === dims;
        lastDims.set(el.id, dims);
        if (!el.fileId || !files[el.fileId] || !(el.width > 1) || placeholder || !steady) {
          waiting++;
          continue;
        }
        sized.add(el.id);
        const pageW = pageRect(L, pageAtY(L, el.y + el.height / 2)).width;
        const size = pastedPictureSize({ w: el.width, h: el.height, pageW, lastCopy: lastCopy.current });
        if (Math.abs(size.w - el.width) > 0.5) fix.set(el.id, { x: el.x + (el.width - size.w) / 2, y: el.y + (el.height - size.h) / 2, width: size.w, height: size.h });
      }
      if (fix.size) {
        api.updateScene({ elements: api.getSceneElementsIncludingDeleted().map((el) => (fix.has(el.id) ? newElementWith(el, fix.get(el.id)) : el)), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      }
      if (!waiting || tries > 60) clearInterval(timer);
    }, 100);
  }

  // ---------- MS-Paint-style cut selection ----------

  useEffect(() => {
    if (activeToolType !== 'selection') setSelectionTool(null);
  }, [activeToolType]);

  // The dock's "Tools" flyout: any of Excalidraw's own tools (its toolbar is hidden)...
  function chooseTool(type) {
    setTextMode(false);
    clearTextSelection();
    setSelectionTool(null);
    apiRef.current?.setActiveTool({ type });
  }

  // ...or the cut selection (rectangle or free-form).
  function chooseCut(modeName) {
    setTextMode(false);
    clearTextSelection();
    setSelectionTool(modeName);
    apiRef.current?.setActiveTool({ type: 'selection' });
  }

  // Cuts every stroke/shape crossing the drawn region at its boundary and
  // selects the inside pieces as one group (see canvas/selectionCut.js).
  function finalizeSelection() {
    const sel = selectionDrawing.current;
    selectionDrawing.current = null;
    scheduleOverlay();
    const api = apiRef.current;
    if (!sel || !api) return;
    const st = api.getAppState();
    const zoom = st.zoom.value;
    const toScene = (p) => ({ x: p.x / zoom - st.scrollX, y: p.y / zoom - st.scrollY });

    let polygon;
    if (sel.mode === 'rect') {
      const a = toScene(sel.points[0]);
      const b = toScene(sel.points[sel.points.length - 1]);
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const maxY = Math.max(a.y, b.y);
      if (maxX - minX < 3 || maxY - minY < 3) return;
      polygon = [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
      ];
    } else {
      if (sel.points.length < 3) return;
      polygon = sel.points.map(toScene);
      const xs = polygon.map((p) => p.x);
      const ys = polygon.map((p) => p.y);
      if (Math.max(...xs) - Math.min(...xs) < 3 || Math.max(...ys) - Math.min(...ys) < 3) return;
    }

    const newElements = [];
    const selectedElementIds = {};
    for (const el of api.getSceneElementsIncludingDeleted()) {
      if (el.isDeleted) {
        newElements.push(el);
        continue;
      }
      const outline = getCuttableOutline(el);
      if (outline) {
        // Pieces are prepared to meet at the cut without a gap (see cutOutline).
        const shape = el.type !== 'freedraw';
        const { insideRuns, outsideRuns } = cutOutline(outline, polygon, { shape, step: Math.max(0.25, el.strokeWidth / 2) });
        if (insideRuns.length === 0) {
          newElements.push(el);
          continue;
        }
        if (outsideRuns.length === 0) {
          newElements.push(el);
          selectedElementIds[el.id] = true;
          continue;
        }
        // A cut shape's pieces become ink of the same visible width (a
        // freedraw of strokeWidth w is drawn ~6w wide at even pressure).
        const size = shape ? el.strokeWidth / (EXCALIDRAW_FREEDRAW_SIZE_FACTOR * 2 * Math.SQRT1_2) : el.strokeWidth;
        const piece = (run) => {
          const p = strokeToFreedrawElement({ points: run, color: el.strokeColor, size, simulatePressure: el.type === 'freedraw' && el.simulatePressure });
          p.opacity = el.opacity;
          return p;
        };
        // Replaced, not just dropped: a deletion (bumped version) is what
        // tells other devices' copies to let go of the uncut original.
        newElements.push(newElementWith(el, { isDeleted: true }));
        for (const run of outsideRuns) if (run.length >= 2) newElements.push(piece(run));
        for (const run of insideRuns) {
          if (run.length < 2) continue;
          const p = piece(run);
          newElements.push(p);
          selectedElementIds[p.id] = true;
        }
      } else {
        newElements.push(el);
        if (boundingBoxIntersectsPolygon(el, polygon)) selectedElementIds[el.id] = true;
      }
    }

    // Several selected pieces share a fresh group, so Excalidraw draws one
    // box around them instead of one per piece.
    let finalElements = newElements;
    const ids = Object.keys(selectedElementIds);
    const appStatePatch = { selectedElementIds, selectedGroupIds: {} };
    if (ids.length > 1) {
      const groupId = crypto.randomUUID();
      finalElements = newElements.map((el) => (selectedElementIds[el.id] ? newElementWith(el, { groupIds: [...el.groupIds, groupId] }) : el));
      appStatePatch.selectedGroupIds = { [groupId]: true };
    }
    flushPending();
    api.updateScene({ elements: finalElements, appState: appStatePatch, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    scheduleSave();
    commitInkHistory(); // the cut is one step
    // Hand straight over to plain select, so the next drag moves the cut.
    setSelectionTool(null);
  }

  // ---------- the owner's handle on the canvas ----------

  useImperativeHandle(ref, () => ({
    goToPage,
    turnPage,
    currentIndex: () => (modeRef.current === 'book' ? bookPageRef.current : currentIndexRef.current),
    flush: () => saveNow(),
    undo,
    redo,
    fit: () => toggleFit(sizeRef.current.height / 2 + (containerRef.current?.getBoundingClientRect().top || 0)),
    openFind: () => findRef.current?.openFind(),
    openSnip: () => startSnip(),
    marks: () => marksRef.current,
    // Another device changed these pages: merge them in, stroke by stroke.
    applyRemote(rows) {
      const api = apiRef.current;
      if (!api) return;
      const L = layoutRef.current;
      const remote = new Map();
      const files = {};
      for (const [key, row] of rows) {
        remote.set(key, row.ink?.elements || []);
        Object.assign(files, row.ink?.files || {});
      }
      flushPending(); // what the person has just drawn is theirs: a step, before the other device's work comes in
      const incoming = sceneFromRows(L, remote);
      if (Object.keys(files).length) api.addFiles(Object.values(files));
      const merged = reconcileElements(api.getSceneElementsIncludingDeleted(), incoming, api.getAppState());
      api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
      // ...and what came in is nobody's step to undo
      inkLastRef.current = snapshotScene(L, api.getSceneElementsIncludingDeleted());
      inkVersionRef.current = getSceneVersion(api.getSceneElementsIncludingDeleted());
      for (const [key, row] of rows) {
        sigRef.current.set(key, signature(row.ink?.elements || []));
        inkRef.current.set(key, row.ink || { elements: [], files: {} });
        const mergedMarks = mergeMarks(marksRef.current.get(key), row.marks);
        marksRef.current.set(key, mergedMarks);
        if (JSON.stringify(mergedMarks) !== JSON.stringify(row.marks || [])) dirtyMarks.current.add(key);
        onMarksChange?.(key, mergedMarks);
      }
      savedVersion.current = null;
      scheduleSave();
      scheduleSyncPaper();
    },
    // Highlights panel: edit / delete / reveal a mark.
    updateMark(pageKey, id, patch) {
      editMarks([{ pageKey, next: updateMark(marksRef.current.get(pageKey) || [], id, patch) }], { coalesce: `edit:${id}` });
    },
    removeMark(pageKey, id) {
      editMarks([{ pageKey, next: deleteMark(marksRef.current.get(pageKey) || [], id) }]);
      setMarkPop(null);
    },
    // Something done outside the canvas (a note page inserted, a bookmark added) that undo should take back: { undo, redo }.
    recordOp(op) {
      flushPending();
      history.record(op);
    },
    revealMark(pageKey, mark) {
      const L = layoutRef.current;
      const i = L.pages.findIndex((p) => p.key === pageKey);
      if (i < 0) return;
      goToPage(i);
      if (modeRef.current !== 'book') {
        const v = currentView();
        const rect = sizeRef.current;
        const r = pageRect(L, i);
        const y = r.y + (mark.rects[0]?.[1] || 0);
        applyView({ zoom: v.zoom, ...clampView(v.scrollX, rect.height / 2 / v.zoom - y, v.zoom) });
      }
    },
  }));

  // ---------- render ----------

  const inkFilter = dark ? DARK_INK_FILTER : undefined;
  const desk = dark ? DESK.dark : paper === 'sepia' ? DESK.sepia : DESK.white;
  const n = layout.n;
  const showToolbar = !readOnly && chrome && !findOpen && !snipOn; // the find bar and the snip bar take the dock's place while open

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={containerRef}
        className={`quarc-reader-surface quarc-canvas-page relative min-h-0 flex-1 overflow-hidden ${isDrawTool ? 'quarc-pen-active' : ''} ${textMode ? 'quarc-text-mode' : ''} ${chrome ? 'quarc-chrome' : ''}`}
        style={{ backgroundColor: desk, cursor: selectionTool || snipOn ? 'crosshair' : undefined, marginTop: topInset }}
        onPointerDownCapture={handlePointerDownCapture}
        onPointerMoveCapture={handlePointerMoveCapture}
        onPointerUpCapture={handlePointerUpCapture}
        onPointerLeave={clearLinkHover}
        onPointerCancelCapture={handlePointerUpCapture}
        onWheelCapture={handleWheelCapture}
        onLostPointerCapture={(e) => {
          if (drawing.current?.pointerId === e.pointerId) endStroke();
        }}
      >
        <style>{`
          /* Excalidraw's own chrome is replaced by the dock and the page bar: its tool island, its
             main menu / library / help buttons, its zoom + undo footer and the "scroll back" hint. */
          .quarc-canvas-page .App-toolbar-container,
          .quarc-canvas-page .App-bottom-bar,
          .quarc-canvas-page .mobile-misc-tools-container,
          .quarc-canvas-page .main-menu-trigger,
          .quarc-canvas-page .sidebar-trigger,
          .quarc-canvas-page .help-icon,
          .quarc-canvas-page .layer-ui__wrapper__footer,
          .quarc-canvas-page .scroll-back-to-content,
          .quarc-canvas-page .undo-redo-buttons,
          .quarc-canvas-page .zoom-actions { display: none !important; }
          .quarc-canvas-page.quarc-pen-active .App-menu__left { display: none !important; }
          .quarc-canvas-page:not(.quarc-chrome) .App-menu__left { display: none !important; }
          .quarc-canvas-page.quarc-text-mode .layer-ui__wrapper { display: none !important; }
          .quarc-canvas-page.quarc-text-mode .excalidraw canvas { pointer-events: none !important; }
          /* What is left of Excalidraw's UI (the style panel for shapes) wears the app's colours. */
          .quarc-canvas-page .excalidraw {
            --color-primary: #7c3aed; --color-primary-darker: #6d28d9; --color-primary-darkest: #5b21b6;
            --color-primary-light: #f1e9ff; --color-primary-light-darker: #e2d3ff; --color-primary-hover: #6d28d9;
            --island-bg-color: #fffdf9; --border-radius-lg: 1rem; --border-radius-md: 0.7rem;
            --shadow-island: 0 12px 32px -10px rgb(36 22 66 / 0.35), 0 3px 8px rgb(36 22 66 / 0.10);
          }
          .quarc-canvas-page .excalidraw.theme--dark { --color-primary-light: #3b2570; --color-primary-light-darker: #4a2f8a; --island-bg-color: #272333; }
        `}</style>
        <canvas ref={paperRef} className="pointer-events-none absolute inset-0" style={{ filter: dark ? DARK_FILTER : undefined }} />
        <canvas ref={marksCanvasRef} className="pointer-events-none absolute inset-0" style={{ mixBlendMode: dark ? 'normal' : 'multiply' }} />
        <Excalidraw
          excalidrawAPI={handleExcalidrawAPI}
          initialData={{
            elements: initial.elements,
            files: initial.files,
            appState: {
              viewBackgroundColor: 'transparent',
              activeTool: { type: 'freedraw' },
              currentItemRoughness: 0,
              currentItemStrokeColor: penColor,
            },
          }}
          onChange={handleExcalidrawChange}
          onScrollChange={handleScrollChange}
          viewModeEnabled={readOnly}
          theme={dark ? 'dark' : 'light'}
          langCode={i18n.language === 'tr' ? 'tr-TR' : 'en'}
          UIOptions={UI_OPTIONS}
        />
        <canvas ref={overlayRef} className="pointer-events-none absolute inset-0" style={{ filter: inkFilter }} />
        <div ref={textRootRef} className="absolute inset-0 overflow-hidden" style={{ pointerEvents: 'none', zIndex: 3 }} />
        <canvas ref={snipCanvasRef} className="pointer-events-none absolute inset-0" style={{ zIndex: 4 }} />

        {showToolbar && (
          <Toolbar
            drawMode={isDrawTool ? tool : null}
            textMode={textMode}
            onDrawMode={selectDrawMode}
            onTextMode={toggleTextMode}
            pen={{ color: penColor, size: penSize }}
            highlighter={{ color: hlColor, size: hlSize }}
            onPenChange={changePen}
            onHighlighterChange={changeHighlighter}
            snapText={snapText}
            onToggleSnapText={() => updatePrefs({ snapText: !snapText })}
            shapeSnap={shapeSnap}
            onToggleShapeSnap={() => updatePrefs({ shapeSnap: !shapeSnap })}
            fingerDraws={fingerDraws}
            onToggleFinger={() => updatePrefs({ fingerMode: fingerDraws ? 'scroll' : 'draw' })}
            onUndo={undo}
            onRedo={redo}
            inkFilter={inkFilter}
            activeTool={activeToolType}
            cutMode={selectionTool}
            onTool={chooseTool}
            onCut={chooseCut}
            eraserOn={eraserOn}
            onEraser={toggleEraser}
            onSnip={startSnip}
            penHistory={penHistory}
            hlHistory={hlHistory}
          />
        )}

        {findOpen && <FindBar find={find} />}
        {snipOn && (
          <SnipBar
            snip={{
              rect: snipRect,
              busy: snipBusy,
              annotations: snipAnnotations,
              onToggleAnnotations: () => updatePrefs({ snipAnnotations: !snipAnnotations }),
              onCopy: () => snipAct('copy'),
              onSave: () => snipAct('save'),
              onCopyText: () => snipAct('text'),
              onClose: () => stopSnip(),
            }}
          />
        )}

        {selBar && textMode && (
          <SelectionBar
            anchor={selBar.anchor}
            container={containerRef.current}
            defaultColor={hlColor}
            onMark={markSelection}
            onCopy={copySelection}
            onClose={clearTextSelection}
          />
        )}
        {markPop && (
          <MarkPopover
            mark={markPop.mark}
            anchor={markPop.anchor}
            container={containerRef.current}
            readOnly={readOnly}
            onChange={(patch) => {
              const next = updateMark(marksRef.current.get(markPop.pageKey) || [], markPop.mark.id, patch);
              // typing a note is one step, not one per letter
              editMarks([{ pageKey: markPop.pageKey, next }], { coalesce: `edit:${markPop.mark.id}` });
              setMarkPop((p) => (p ? { ...p, mark: next.find((m) => m.id === p.mark.id) || p.mark } : p));
            }}
            onDelete={() => {
              editMarks([{ pageKey: markPop.pageKey, next: deleteMark(marksRef.current.get(markPop.pageKey) || [], markPop.mark.id) }]);
              setMarkPop(null);
            }}
            onClose={() => {
              finishMarksEdit();
              setMarkPop(null);
            }}
          />
        )}

        <PageBar
          mode={mode}
          index={currentIndex}
          n={n}
          zoomPct={zoomPct}
          onPrev={() => turnPage(-1)}
          onNext={() => turnPage(1)}
          onGoTo={(i) => goToPage(i)}
          onZoom={zoomBy}
          chrome={chrome}
          onToggleChrome={onToggleChrome}
        />
      </div>
    </div>
  );
});

export default ReaderCanvas;
