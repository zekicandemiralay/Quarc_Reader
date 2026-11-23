import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Excalidraw, newElementWith, CaptureUpdateAction, reconcileElements, getSceneVersion } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { useTranslation } from 'react-i18next';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Maximize2, Minimize2 } from 'lucide-react';
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
} from './geometry';
import { bucketElements, signature, sceneFromRows, relayout } from './inkBuckets';
import { PdfRaster } from './pdfRaster';
import { TextLayerManager } from './textLayers';
import { drawPaper, drawMarks, DARK_FILTER, DESK } from './paper';
import { newMark, mergeMarks, updateMark, deleteMark, hitMark, activeMarks } from './marks';
import Toolbar from './Toolbar';
import SelectionBar from './SelectionBar';
import MarkPopover from './MarkPopover';

const HOLD_MS = 500; // keep the pen still this long at a stroke's end to snap it to a shape
const HOLD_RADIUS = { pen: 6, mouse: 5, touch: 10 }; // screen px of jitter that still counts as "still"
const ERASER_RADIUS = 10; // screen px, for the stylus button / eraser end
const PALM_WINDOW_MS = 500; // touches this soon after pen activity are a resting hand
const PALM_SIZE = 60; // touch contact (CSS px) this big is a palm, not a fingertip
const HIGHLIGHTER_OPACITY = 40;
const TAP_MOVE_TOLERANCE = 10;
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

const RectSelectIcon = (
  <svg viewBox="0 0 20 20" width={20} height={20} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3.5" y="5" width="13" height="10" rx="1" strokeDasharray="2.5 2.5" />
  </svg>
);
const FreeformSelectIcon = (
  <svg viewBox="0 0 20 20" width={20} height={20} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.5 9.7c-.4-3.1 2.6-5.3 5.4-4.9 3.1.5 5.7 2.1 5.4 5.2-.3 2.9-3.1 4.7-5.9 4.6-2.3-.1-4.6-1.9-4.9-4.9z" strokeDasharray="2.5 2.5" />
  </svg>
);
const ChevronDownIcon = (
  <svg viewBox="0 0 10 6" width={10} height={6} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 1l4 4 4-4" />
  </svg>
);

function isEraserButton(e) {
  return e.pointerType === 'pen' && ((e.buttons & 32) !== 0 || (e.buttons & 2) !== 0 || e.button === 5 || e.button === 2);
}

const layoutSignature = (pages) => pages.map((p) => `${p.key}:${Math.round(p.w)}x${Math.round(p.h)}`).join('|');

const ReaderCanvas = forwardRef(function ReaderCanvas(
  { docId, pdf, pages, annotations, readOnly = false, mode, paper, initialPosition, onSavePage, onPosition, onPageChange, onMarksChange, onTurn, chrome = true, onToggleChrome, topInset = 0 },
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

  // ---------- UI state ----------

  const [activeToolType, setActiveToolType] = useState('freedraw');
  const [textMode, setTextMode] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectionTool, setSelectionTool] = useState(null);
  const [selectionVariant, setSelectionVariant] = useState('rect');
  const [selectionMenuOpen, setSelectionMenuOpen] = useState(false);
  const [toolbarPortalEl, setToolbarPortalEl] = useState(null);
  const [selBar, setSelBar] = useState(null); // { anchor, items } while text is selected
  const [markPop, setMarkPop] = useState(null); // { pageKey, mark, anchor }

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
  const textNeeded = textMode || (isDrawTool && tool === 'highlighter' && snapText && !readOnly);

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
    drawMarks(marksCanvasRef.current, view, rect, L, marksRef.current, { dark: p.dark, hidden: false, selectedId: markPopRef.current?.mark.id, onlyIndex });
    clipInk(book && L.n ? pageRect(L, onlyIndex) : null, view, rect);
    textRef.current?.sync(L, view, rect, visible, { enabled: textNeededRef.current, interactive: textModeRef.current });

    const index = currentPage(L, view, rect);
    if (modeRef.current === 'book' && index !== bookPageRef.current) bookPageRef.current = index;
    if (index !== currentIndexRef.current) {
      currentIndexRef.current = index;
      setCurrentIndex(index);
      onPageChange?.(index);
    }
    clearTimeout(positionTimer.current);
    positionTimer.current = setTimeout(reportPosition, POSITION_DELAY_MS);

    clearTimeout(settleTimer.current);
    if (!settled) settleTimer.current = setTimeout(() => syncPaper(currentView(), { settled: true }), 160);
  }
  const textNeededRef = useRef(false);
  textNeededRef.current = textNeeded;

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
    for (const canvas of [paperRef.current, marksCanvasRef.current, overlayRef.current]) {
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
    textRef.current = text;
    scheduleSyncPaper();
    return () => {
      raster.dispose();
      text.dispose();
      rasterRef.current = null;
      textRef.current = null;
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
      saveNow(prev); // anything unsaved is stored against the layout it was drawn in
      const moved = relayout(prev, layout, api.getSceneElementsIncludingDeleted());
      api.updateScene({ elements: moved, captureUpdate: CaptureUpdateAction.NEVER });
      api.history?.clear?.();
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
    if (getSceneVersion(elements) !== savedVersion.current) scheduleSave();
  }

  useEffect(() => {
    if (savedVersion.current === null) savedVersion.current = getSceneVersion(initial.elements);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sendShortcut(key, shift = false) {
    const target = containerRef.current?.querySelector('.excalidraw');
    target?.dispatchEvent(
      new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, metaKey: true, shiftKey: shift, bubbles: true, cancelable: true })
    );
  }
  const undo = () => sendShortcut('z');
  const redo = () => sendShortcut('z', true);

  // ---------- tools ----------

  function selectDrawMode(next) {
    setTextMode(false);
    clearTextSelection();
    updatePrefs({ tool: next });
    apiRef.current?.setActiveTool({ type: 'freedraw' });
    setSelectionTool(null);
  }

  function changePen(patch) {
    setTextMode(false);
    updatePrefs({ tool: 'pen', ...(patch.color ? { penColor: patch.color } : {}), ...(patch.size ? { penSize: patch.size } : {}) });
    apiRef.current?.setActiveTool({ type: 'freedraw' });
  }

  function changeHighlighter(patch) {
    setTextMode(false);
    updatePrefs({ tool: 'highlighter', ...(patch.color ? { hlColor: patch.color } : {}), ...(patch.size ? { hlSize: patch.size } : {}) });
    apiRef.current?.setActiveTool({ type: 'freedraw' });
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
    for (const it of items) {
      const mark = newMark({ type, color, rects: it.rects, text: it.text, note });
      changeMarks(it.key, [...(marksRef.current.get(it.key) || []), mark]);
    }
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
      ctx.strokeStyle = '#6965db';
      ctx.fillStyle = 'rgba(105, 101, 219, 0.08)';
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
            changeMarks(r.key, [...(marksRef.current.get(r.key) || []), newMark({ type: 'hl', color: d.color, rects: found.rects, text: found.text })]);
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
    if (er.pending.size) {
      const elements = api.getSceneElementsIncludingDeleted().map((el) => (er.pending.has(el.id) ? newElementWith(el, { isDeleted: true }) : el));
      api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      scheduleSave();
    }
    const byPage = new Map();
    for (const [id, key] of er.marks) byPage.set(key, [...(byPage.get(key) || []), id]);
    for (const [key, ids] of byPage) {
      let next = marksRef.current.get(key) || [];
      for (const id of ids) next = deleteMark(next, id);
      changeMarks(key, next);
    }
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
    const onUi = !!e.target.closest?.('button, input, textarea, select, a, label, .Island, [role=dialog], [data-selection-bar], aside');
    const onSurface = !onUi && !!containerRef.current?.contains(e.target);
    const onText = !!e.target.closest?.('.quarc-text-layer');
    if (!onSurface && !(textModeRef.current && onText)) return;
    stopInertia();
    stopInitialView();

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
    const fingerSelects = e.pointerType !== 'touch' || p.fingerDraws;
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

    if (isDrawToolRef.current || selectionToolRef.current || p.readOnly) {
      consume(e);
      touchTrack.current = { pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, consumed: true };
      // A finger that draws still scrolls when it lands on the desk.
      if (!(p.fingerDraws && !selectionToolRef.current && startStroke(e))) beginPan(e);
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
    if (ignoredTouches.current.has(e.pointerId)) {
      consume(e);
      return;
    }
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
    const sel = selectionDrawing.current;
    if (sel && e.pointerId === sel.pointerId) {
      consume(e);
      finalizeSelection();
      return;
    }
    if (drawing.current && e.pointerId === drawing.current.pointerId) {
      consume(e);
      if (e.type === 'pointercancel') cancelStroke();
      else endStroke();
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
    }, 30);
  }

  // Wheel / trackpad: scrolling and zooming are Excalidraw's own; in book mode
  // pushing past the end of the page turns it.
  const wheelAccum = useRef(0);
  const wheelTimer = useRef(null);
  function handleWheelCapture(e) {
    stopInitialView();
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

  // ---------- MS-Paint-style cut selection ----------

  useEffect(() => {
    if (activeToolType !== 'selection') setSelectionTool(null);
  }, [activeToolType]);

  function selectTool(modeName) {
    setSelectionTool((prev) => {
      const next = prev === modeName ? null : modeName;
      if (next) apiRef.current?.setActiveTool({ type: 'selection' });
      return next;
    });
  }

  function chooseSelectionVariant(modeName) {
    setSelectionVariant(modeName);
    setSelectionMenuOpen(false);
    setSelectionTool(modeName);
    apiRef.current?.setActiveTool({ type: 'selection' });
  }

  useEffect(() => {
    if (!selectionMenuOpen) return undefined;
    const handleOutside = (e) => {
      if (!e.target.closest?.('.quarc-selection-tool')) setSelectionMenuOpen(false);
    };
    document.addEventListener('pointerdown', handleOutside, true);
    return () => document.removeEventListener('pointerdown', handleOutside, true);
  }, [selectionMenuOpen]);

  // Excalidraw's tool row (".App-toolbar > .Stack_horizontal") is a real,
  // persistent DOM node; our selection button is portaled into it so it
  // looks and behaves like a native tool.
  useEffect(() => {
    if (readOnly) return undefined;
    let cancelled = false;
    let raf;
    const poll = () => {
      if (cancelled) return;
      const el = containerRef.current?.querySelector('.App-toolbar > .Stack_horizontal');
      if (el) setToolbarPortalEl(el);
      else raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [readOnly]);

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
    api.updateScene({ elements: finalElements, appState: appStatePatch, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    scheduleSave();
    // Hand straight over to plain select, so the next drag moves the cut.
    setSelectionTool(null);
  }

  function renderSelectionToolButton() {
    if (!toolbarPortalEl || readOnly) return null;
    const icon = selectionVariant === 'freeform' ? FreeformSelectIcon : RectSelectIcon;
    return createPortal(
      <div className="quarc-selection-tool" style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
        <label className="ToolIcon" title={t('canvas.selectionTool')}>
          <input type="radio" className="ToolIcon_type_radio ToolIcon_size_medium" checked={selectionTool === selectionVariant} onChange={() => selectTool(selectionVariant)} />
          <div className="ToolIcon__icon">{icon}</div>
        </label>
        <button type="button" className="quarc-selection-tool__caret" title={t('canvas.selectionToolVariant')} onClick={() => setSelectionMenuOpen((v) => !v)}>
          {ChevronDownIcon}
        </button>
        {selectionMenuOpen && (
          <div className="dropdown-menu quarc-selection-tool__menu">
            <div className="dropdown-menu-container Island" style={{ '--padding': 2 }}>
              {[
                ['rect', RectSelectIcon, t('canvas.rectSelect')],
                ['freeform', FreeformSelectIcon, t('canvas.freeSelect')],
              ].map(([modeName, ic, label]) => (
                <button
                  key={modeName}
                  type="button"
                  className={`dropdown-menu-item dropdown-menu-item-base${selectionVariant === modeName ? ' dropdown-menu-item--selected' : ''}`}
                  onClick={() => chooseSelectionVariant(modeName)}
                >
                  <div className="dropdown-menu-item__text">
                    {ic}
                    {label}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>,
      toolbarPortalEl
    );
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
      const incoming = sceneFromRows(L, remote);
      if (Object.keys(files).length) api.addFiles(Object.values(files));
      const merged = reconcileElements(api.getSceneElementsIncludingDeleted(), incoming, api.getAppState());
      api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
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
      changeMarks(pageKey, updateMark(marksRef.current.get(pageKey) || [], id, patch));
    },
    removeMark(pageKey, id) {
      changeMarks(pageKey, deleteMark(marksRef.current.get(pageKey) || [], id));
      setMarkPop(null);
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
  const desk = dark ? DESK.dark : paper === 'sepia' ? DESK.sepia : DESK.light;
  const n = layout.n;
  const showToolbar = !readOnly && chrome;

  return (
    <div className="flex h-full min-h-0 flex-col">
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
        />
      )}
      <div
        ref={containerRef}
        className={`quarc-reader-surface quarc-canvas-page relative min-h-0 flex-1 overflow-hidden ${isDrawTool ? 'quarc-pen-active' : ''} ${textMode ? 'quarc-text-mode' : ''} ${chrome ? 'quarc-chrome' : ''}`}
        style={{ backgroundColor: desk, cursor: selectionTool ? 'crosshair' : undefined, marginTop: topInset }}
        onPointerDownCapture={handlePointerDownCapture}
        onPointerMoveCapture={handlePointerMoveCapture}
        onPointerUpCapture={handlePointerUpCapture}
        onPointerCancelCapture={handlePointerUpCapture}
        onWheelCapture={handleWheelCapture}
        onLostPointerCapture={(e) => {
          if (drawing.current?.pointerId === e.pointerId) endStroke();
        }}
      >
        <style>{`
          .quarc-canvas-page.quarc-pen-active .App-menu__left { display: none !important; }
          .quarc-canvas-page .main-menu-trigger, .quarc-canvas-page .sidebar-trigger, .quarc-canvas-page .help-icon { display: none !important; }
          .quarc-canvas-page:not(.quarc-chrome) .layer-ui__wrapper .App-toolbar-container, .quarc-canvas-page:not(.quarc-chrome) .App-menu__left { display: none !important; }
          .quarc-canvas-page.quarc-text-mode .layer-ui__wrapper { display: none !important; }
          .quarc-canvas-page.quarc-text-mode .excalidraw canvas { pointer-events: none !important; }
          .quarc-canvas-page .excalidraw { --color-primary: #f59e0b; --color-primary-darker: #d97706; --color-primary-darkest: #b45309; --color-primary-light: #fef3c7; --color-primary-light-darker: #fde68a; --color-primary-hover: #d97706; }
          .quarc-canvas-page .excalidraw.theme--dark { --color-primary-light: #78350f; --color-primary-light-darker: #92400e; }
          .quarc-canvas-page .quarc-selection-tool { margin-left: 2px; }
          .quarc-canvas-page .quarc-selection-tool__caret { width: 14px; align-self: stretch; display: flex; align-items: center; justify-content: center; border: 0; background: transparent; cursor: pointer; color: var(--color-on-surface); border-radius: var(--border-radius-md); }
          .quarc-canvas-page .quarc-selection-tool__caret:hover { background-color: var(--button-hover-bg); }
          .quarc-canvas-page .quarc-selection-tool__menu { left: 0; z-index: 2; min-width: 9.5rem; }
          .quarc-canvas-page .quarc-selection-tool__menu .dropdown-menu-container { display: flex; flex-direction: column; gap: 2px; padding: 4px; }
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
              changeMarks(markPop.pageKey, next);
              setMarkPop((p) => (p ? { ...p, mark: next.find((m) => m.id === p.mark.id) || p.mark } : p));
            }}
            onDelete={() => {
              changeMarks(markPop.pageKey, deleteMark(marksRef.current.get(markPop.pageKey) || [], markPop.mark.id));
              setMarkPop(null);
            }}
            onClose={() => setMarkPop(null)}
          />
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-[4] flex justify-center">
          <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-neutral-200 bg-white/90 p-1 text-sm shadow-lg backdrop-blur dark:border-neutral-700 dark:bg-neutral-800/90">
            <button
              type="button"
              title={t('canvas.prevPage')}
              disabled={currentIndex === 0}
              onClick={() => turnPage(-1)}
              className="rounded-full p-1.5 text-neutral-600 hover:bg-neutral-100 disabled:opacity-30 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              {mode === 'book' ? <ChevronLeft size={16} /> : <ChevronUp size={16} />}
            </button>
            <span className="min-w-[4rem] text-center tabular-nums text-neutral-700 dark:text-neutral-200">
              {currentIndex + 1} / {n}
            </span>
            <button
              type="button"
              title={t('canvas.nextPage')}
              disabled={currentIndex >= n - 1}
              onClick={() => turnPage(1)}
              className="rounded-full p-1.5 text-neutral-600 hover:bg-neutral-100 disabled:opacity-30 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              {mode === 'book' ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
            </button>
            {onToggleChrome && (
              <button
                type="button"
                title={chrome ? t('reader.hideBars') : t('reader.showBars')}
                onClick={onToggleChrome}
                className="rounded-full p-1.5 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700"
              >
                {chrome ? <Maximize2 size={15} /> : <Minimize2 size={15} />}
              </button>
            )}
          </div>
        </div>
        {renderSelectionToolButton()}
      </div>
    </div>
  );
});

export default ReaderCanvas;
