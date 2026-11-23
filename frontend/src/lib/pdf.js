import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.min.mjs';
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { compressSizes } from '../reader/geometry';

// pdf.js does the reading: parsing, fonts and drawing each page. The "legacy"
// build runs on older Android WebViews too. Its CJK character maps and the 14
// standard fonts are copied into /pdfjs/ at build time (scripts/copy-pdfjs-assets.mjs).
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

export { pdfjs };

const BASE = import.meta.env.BASE_URL || '/';
const OPTIONS = {
  cMapUrl: `${BASE}pdfjs/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${BASE}pdfjs/standard_fonts/`,
  isEvalSupported: false,
  enableXfa: false,
};

// Opens a PDF from a Blob (a file on this device) or a URL (the server; pdf.js
// fetches only the byte ranges it needs). Returns { pdf, dispose }.
export async function openPdf(source) {
  let url;
  let revoke = null;
  if (source.blob) {
    url = URL.createObjectURL(source.blob);
    revoke = url;
  } else {
    url = source.url;
  }
  // From the server only the byte ranges the visible pages need are fetched:
  // no whole-file stream up front and no background download of the rest
  // (a device that chose not to keep a copy must not quietly pull 300 MB; the
  // "keep offline" download is its own explicit step, see library.cacheOffline).
  const remote = source.blob ? {} : { disableAutoFetch: true, disableStream: true, rangeChunkSize: 256 * 1024 };
  const task = pdfjs.getDocument({
    url,
    withCredentials: !!source.withCredentials,
    ...remote,
    ...OPTIONS,
  });
  try {
    const pdf = await task.promise;
    return {
      pdf,
      dispose: () => {
        task.destroy();
        if (revoke) URL.revokeObjectURL(revoke);
      },
    };
  } catch (err) {
    task.destroy();
    if (revoke) URL.revokeObjectURL(revoke);
    throw err;
  }
}

// Every page's displayed size in PDF points (rotation applied), run-length
// encoded. Done in small parallel batches: a 1,000 page book takes a moment.
export async function measurePages(pdf, onProgress) {
  const sizes = new Array(pdf.numPages);
  const BATCH = 24;
  for (let start = 0; start < pdf.numPages; start += BATCH) {
    const end = Math.min(pdf.numPages, start + BATCH);
    await Promise.all(
      Array.from({ length: end - start }, async (_, k) => {
        const page = await pdf.getPage(start + k + 1);
        const vp = page.getViewport({ scale: 1 });
        sizes[start + k] = [Math.round(vp.width * 100) / 100, Math.round(vp.height * 100) / 100];
        page.cleanup();
      })
    );
    onProgress?.(end / pdf.numPages);
  }
  return compressSizes(sizes);
}

export async function readMeta(pdf) {
  try {
    const { info } = await pdf.getMetadata();
    const clean = (s) => (typeof s === 'string' ? s.replace(/\0/g, '').trim() : '');
    return { title: clean(info?.Title), author: clean(info?.Author) };
  } catch {
    return { title: '', author: '' };
  }
}

// A small JPEG of the first page, as a data URL (kept in the document row so
// every device can show a cover without downloading the book).
export async function renderThumb(pdf, targetWidth = 220) {
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: targetWidth / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();
  // Stay well under the server's size limit for a cover.
  for (const q of [0.72, 0.55, 0.4]) {
    const url = canvas.toDataURL('image/jpeg', q);
    if (url.length < 60000) return url;
  }
  return null;
}
