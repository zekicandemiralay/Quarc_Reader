import { PX_PER_PT } from './geometry';

// Draws PDF pages into bitmaps for the paper layer, and keeps them.
//
// Each visible page has up to two bitmaps:
//   base    the whole page at a moderate resolution. Always there first, so
//           scrolling and pinching show *something* instantly (just soft).
//   detail  the same page at the resolution the screen needs right now — the
//           whole page when that is affordable, otherwise only the part on
//           screen (a tile). Rendered after the view settles.
// A page is far bigger than a canvas can be at high zoom (an A4 page at 8x on
// a 2x screen would be ~60 megapixels), which is why detail is a tile.
//
// The bitmaps are in a pool with a pixel budget; pages far from the screen are
// evicted first. One render runs at a time; a newer request for the same
// page/level replaces an older queued one, and renders of pages that left the
// screen are cancelled.

const BASE_PIXELS = 3_500_000; // resolution cap of a page's base bitmap
const DETAIL_PIXELS = 7_000_000; // largest detail bitmap (tile or whole page)
const POOL_PIXELS = 60_000_000; // everything kept, ~240 MB at 4 bytes per pixel
const TILE_MARGIN = 0.18; // extra around the visible part, so a small pan reuses the tile

const pixelsOf = (c) => c.width * c.height;

function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export class PdfRaster {
  constructor(pdf, { onUpdate } = {}) {
    this.pdf = pdf;
    this.onUpdate = onUpdate || (() => {});
    this.entries = new Map(); // pageIndex -> { base, detail, used }
    this.queue = []; // { page, level, scale, region, key }
    this.running = null; // { job, task }
    this.disposed = false;
    this.tick = 0;
  }

  entry(i) {
    let e = this.entries.get(i);
    if (!e) {
      e = { base: null, detail: null, used: 0 };
      this.entries.set(i, e);
    }
    return e;
  }

  // Asks for page `i` (sized w x h scene px) to be sharp enough for `need`
  // device pixels per scene pixel, with `visible` the part of it on screen
  // (page-local scene px, or null for "all of it").
  ensure(i, w, h, need, visible, { detail = true } = {}) {
    if (this.disposed) return;
    const e = this.entry(i);
    e.used = ++this.tick;

    const baseScale = Math.min(need, Math.sqrt(BASE_PIXELS / (w * h)));
    if (!e.base || e.base.scale < baseScale * 0.7) this.enqueue({ i, level: 'base', scale: baseScale, region: null });
    // While the view is still moving only the base matters; the sharp tile is
    // asked for once it settles.
    if (!detail) return;

    const baseHas = e.base ? e.base.scale : 0;
    if (need <= Math.max(baseHas, baseScale) * 1.08) {
      // The base is sharp enough; a stale detail would only waste memory.
      if (e.detail && e.detail.scale < need * 0.9) this.dropDetail(e);
      this.cancelQueued(i, 'detail');
      return;
    }

    let region = { x: 0, y: 0, w, h };
    if (w * h * need * need > DETAIL_PIXELS) {
      const v = visible || region;
      const mx = v.w * TILE_MARGIN;
      const my = v.h * TILE_MARGIN;
      region = clipRect({ x: v.x - mx, y: v.y - my, w: v.w + 2 * mx, h: v.h + 2 * my }, w, h);
      // Keep within the pixel cap even on a huge screen.
      const px = region.w * region.h * need * need;
      if (px > DETAIL_PIXELS) {
        const k = Math.sqrt(DETAIL_PIXELS / px);
        const cx = region.x + region.w / 2;
        const cy = region.y + region.h / 2;
        region = clipRect({ x: cx - (region.w * k) / 2, y: cy - (region.h * k) / 2, w: region.w * k, h: region.h * k }, w, h);
      }
    }
    const d = e.detail;
    const sharp = d && d.scale >= need * 0.9 && d.scale <= need * 1.7;
    if (sharp && contains(d.region, visible || { x: 0, y: 0, w, h })) return;
    this.enqueue({ i, level: 'detail', scale: need, region });
  }

  enqueue(job) {
    job.key = `${job.i}:${job.level}`;
    this.queue = this.queue.filter((j) => j.key !== job.key);
    this.queue.push(job);
    this.pump();
  }

  cancelQueued(i, level) {
    const key = `${i}:${level}`;
    this.queue = this.queue.filter((j) => j.key !== key);
    if (this.running?.job.key === key) this.running.task?.cancel();
  }

  // Cancels everything for pages not in `keep` (they left the screen).
  keepOnly(keep) {
    const set = new Set(keep);
    this.queue = this.queue.filter((j) => set.has(j.i));
    if (this.running && !set.has(this.running.job.i)) this.running.task?.cancel();
  }

  dropDetail(e) {
    if (e.detail) {
      e.detail.canvas.width = 0;
      e.detail = null;
    }
  }

  async pump() {
    if (this.running || this.disposed) return;
    // The most recently asked-for job first: it is what the user is looking at now.
    const job = this.queue.pop();
    if (!job) return;
    this.running = { job, task: null };
    try {
      const page = await this.pdf.getPage(job.i + 1);
      if (this.disposed) return;
      const s = job.scale * PX_PER_PT; // device px per PDF point
      const viewport = page.getViewport({ scale: s });
      const region = job.region || { x: 0, y: 0, w: viewport.width / job.scale, h: viewport.height / job.scale };
      const canvas = newCanvas(region.w * job.scale, region.h * job.scale);
      const ctx = canvas.getContext('2d', { alpha: false });
      const task = page.render({
        canvasContext: ctx,
        viewport,
        transform: job.region ? [1, 0, 0, 1, -region.x * job.scale, -region.y * job.scale] : undefined,
        background: '#ffffff',
      });
      this.running.task = task;
      await task.promise;
      page.cleanup();
      const e = this.entry(job.i);
      const slot = job.level;
      if (e[slot]) e[slot].canvas.width = 0;
      e[slot] = { canvas, scale: job.scale, region };
      this.evict();
      this.onUpdate(job.i);
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException' && !this.disposed) console.warn('PDF page render failed', err);
    } finally {
      this.running = null;
      if (!this.disposed) this.pump();
    }
  }

  // Frees the least recently used pages' bitmaps until the pool fits its budget.
  evict() {
    let total = 0;
    for (const e of this.entries.values()) {
      if (e.base) total += pixelsOf(e.base.canvas);
      if (e.detail) total += pixelsOf(e.detail.canvas);
    }
    if (total <= POOL_PIXELS) return;
    const byAge = [...this.entries.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [i, e] of byAge) {
      if (total <= POOL_PIXELS) break;
      if (e.detail) {
        total -= pixelsOf(e.detail.canvas);
        this.dropDetail(e);
      }
      if (total > POOL_PIXELS && e.base) {
        total -= pixelsOf(e.base.canvas);
        e.base.canvas.width = 0;
        e.base = null;
      }
      if (!e.base && !e.detail) this.entries.delete(i);
    }
  }

  // Draws page `i` into `ctx` at the screen rectangle `dest` (CSS px). `zoom`
  // is screen px per scene px. Returns false if nothing is ready yet.
  draw(ctx, i, dest, zoom) {
    const e = this.entries.get(i);
    if (!e || (!e.base && !e.detail)) return false;
    e.used = ++this.tick;
    if (e.base) ctx.drawImage(e.base.canvas, dest.x, dest.y, dest.w, dest.h);
    const d = e.detail;
    if (d && (!e.base || d.scale >= e.base.scale)) {
      ctx.drawImage(d.canvas, dest.x + d.region.x * zoom, dest.y + d.region.y * zoom, d.region.w * zoom, d.region.h * zoom);
    }
    return true;
  }

  dispose() {
    this.disposed = true;
    this.queue = [];
    this.running?.task?.cancel();
    for (const e of this.entries.values()) {
      if (e.base) e.base.canvas.width = 0;
      if (e.detail) e.detail.canvas.width = 0;
    }
    this.entries.clear();
  }
}

function clipRect(r, w, h) {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  return { x, y, w: Math.max(1, Math.min(w, r.x + r.w) - x), h: Math.max(1, Math.min(h, r.y + r.h) - y) };
}

function contains(outer, inner) {
  const eps = 0.5;
  return inner.x >= outer.x - eps && inner.y >= outer.y - eps && inner.x + inner.w <= outer.x + outer.w + eps && inner.y + inner.h <= outer.y + outer.h + eps;
}
