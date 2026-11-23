import { exportToCanvas, getCommonBounds } from '@excalidraw/excalidraw';
import { PX_PER_PT } from './geometry';
import { drawRuling, paintMark } from './paper';
import { activeMarks } from './marks';

// The picture of a region of a page, for "copy image" / "save image" of the snip tool.
//
// It is drawn again from the document, not copied from the screen, so it is sharp however far the page is zoomed
// out: the PDF's own page (pdf.js), the ruling of a note page, the highlights (multiplied over the paper, as on
// screen), and the ink, shapes, text and pictures (drawn by Excalidraw itself, as "Save PDF" does). The paper is
// the page's own — white — whatever paper colour the reader is set to; ink is in the colours it was drawn with.

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Elements whose box (a little widened: strokes have width) touches the region.
function touches(el, r, pad = 12) {
  return el.x - pad < r.x + r.w && el.x + (el.width || 0) + pad > r.x && el.y - pad < r.y + r.h && el.y + (el.height || 0) + pad > r.y;
}

// page: a page of the layout ({ kind, pdfIndex, style, w, h }); rect: { x, y, w, h } page-local px;
// scale: picture px per page-local px; marks: the page's marks; ink: { elements (page-local), files } or null.
// Resolves to { blob (PNG), width, height }.
export async function renderRegion({ pdf, page, rect, scale, marks = [], ink = null }) {
  const W = Math.max(1, Math.round(rect.w * scale));
  const H = Math.max(1, Math.round(rect.h * scale));
  const canvas = canvasOf(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  if (page.kind === 'pdf') {
    const pdfPage = await pdf.getPage(page.pdfIndex + 1);
    const viewport = pdfPage.getViewport({ scale: scale * PX_PER_PT });
    await pdfPage.render({ canvasContext: ctx, viewport, transform: [1, 0, 0, 1, -rect.x * scale, -rect.y * scale], background: '#ffffff' }).promise;
  } else {
    drawRuling(ctx, page.style, -rect.x * scale, -rect.y * scale, page.w * scale, page.h * scale, scale, { width: W, height: H });
  }

  const live = activeMarks(marks);
  if (live.length) {
    const layer = canvasOf(W, H);
    const lctx = layer.getContext('2d');
    for (const m of live) paintMark(lctx, m, -rect.x * scale, -rect.y * scale, scale);
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  }

  const elements = (ink?.elements || []).filter((el) => el && !el.isDeleted && touches(el, rect));
  if (elements.length) {
    const raster = await exportToCanvas({
      elements,
      appState: { exportBackground: false, viewBackgroundColor: 'transparent', exportWithDarkMode: false },
      files: ink.files || {},
      exportPadding: 0,
      getDimensions: (w, h) => ({ width: Math.max(1, Math.ceil(w * scale)), height: Math.max(1, Math.ceil(h * scale)), scale }),
    });
    const [x1, y1, x2, y2] = getCommonBounds(elements);
    ctx.drawImage(raster, (x1 - rect.x) * scale, (y1 - rect.y) * scale, (x2 - x1) * scale, (y2 - y1) * scale);
  }

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The picture could not be made');
  return { blob, width: W, height: H };
}
