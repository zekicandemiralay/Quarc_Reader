import { exportToCanvas, getCommonBounds } from '@excalidraw/excalidraw';
import { exportAnnotatedPdf } from '../reader/exportPdf';
import { PX_PER_PT } from '../reader/geometry';
import { pdfSource, loadAnnotations } from './library';
import { openPdf, measurePages } from './pdf';

// The browser half of "Save PDF": reads the document's file and annotations,
// lets pdf.js say where each page's corners are (it knows about rotated pages
// and cropped media boxes), and lets Excalidraw draw the text and images.

// Text/images placed with Excalidraw's tools, drawn by Excalidraw itself into
// a transparent PNG — fonts and layout exactly as on screen.
async function rasterize({ elements, files, scale }) {
  const canvas = await exportToCanvas({
    elements,
    appState: { exportBackground: false, viewBackgroundColor: 'transparent', exportWithDarkMode: false },
    files,
    exportPadding: 0,
    getDimensions: (w, h) => ({ width: Math.max(1, Math.ceil(w * scale)), height: Math.max(1, Math.ceil(h * scale)), scale }),
  });
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return null;
  const [x1, y1, x2, y2] = getCommonBounds(elements);
  return { png: new Uint8Array(await blob.arrayBuffer()), bounds: [x1, y1, x2, y2] };
}

async function readBytes(doc) {
  const source = await pdfSource(doc);
  if (!source) throw new Error('The file is not available right now.');
  if (source.blob) return new Uint8Array(await source.blob.arrayBuffer());
  const res = await fetch(source.url, { credentials: 'include' });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// A copy of the document's PDF with its annotations in it. `pdf` is the pdf.js
// document already open in the reader; `pages` its current page list.
export async function buildAnnotatedPdf({ doc, pdf, pages, onProgress }) {
  const pdfBytes = await readBytes(doc);
  const annotations = await loadAnnotations(doc.id);
  const transformFor = async (pdfIndex) => {
    const page = await pdf.getPage(pdfIndex + 1);
    const viewport = page.getViewport({ scale: PX_PER_PT });
    return { convert: (x, y) => viewport.convertToPdfPoint(x, y) };
  };
  const out = await exportAnnotatedPdf({ pdfBytes, pages, annotations, transformFor, rasterize, onProgress });
  return new Blob([out], { type: 'application/pdf' });
}

// What a freshly built file looks like (page count and sizes), for replacing the original.
export async function describePdf(blob) {
  const { pdf, dispose } = await openPdf({ blob });
  try {
    return { page_count: pdf.numPages, sizes: await measurePages(pdf) };
  } finally {
    dispose();
  }
}

export const annotatedName = (title) => `${(title || 'document').replace(/[\\/:*?"<>|]+/g, ' ').trim()} (annotated).pdf`;
