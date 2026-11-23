// Lossless merging of what two devices did to the same thing.
//
// Everything a person creates in the Reader — a stroke, a text highlight, a
// sticky note, an inserted note page, a bookmark — is an item with a stable id,
// and every change to it bumps a version (Excalidraw's `version`, or our own
// `u` timestamp). Merging two copies is then "per id, the newer version wins",
// and deleting is just a newer version marked deleted. So two devices that
// annotated the same page offline both keep everything they did.

// ----- Excalidraw scenes (ink) ---------------------------------------------

// Excalidraw bumps an element's `version` on every change, so per element id
// the higher version is the newer edit; equal versions tie-break on the lower
// `versionNonce` — the same rule its own collaboration uses, so both sides of
// a merge always agree.
function elementWins(a, b) {
  const va = a.version ?? 0;
  const vb = b.version ?? 0;
  if (va !== vb) return va > vb;
  return (a.versionNonce ?? 0) < (b.versionNonce ?? 0);
}

function mergeScenes(serverInk, clientInk) {
  if (!serverInk || Array.isArray(serverInk) || !Array.isArray(serverInk.elements)) return clientInk;
  if (!clientInk || Array.isArray(clientInk) || !Array.isArray(clientInk.elements)) return serverInk;

  const byId = new Map();
  const order = [];
  for (const el of serverInk.elements) {
    if (!el || typeof el.id !== 'string') continue;
    if (!byId.has(el.id)) order.push(el.id);
    byId.set(el.id, el);
  }
  for (const el of clientInk.elements) {
    if (!el || typeof el.id !== 'string') continue;
    const prev = byId.get(el.id);
    if (!prev) {
      order.push(el.id);
      byId.set(el.id, el);
    } else if (elementWins(el, prev)) {
      byId.set(el.id, el);
    }
  }
  const elements = order.map((id) => byId.get(id));
  // Excalidraw stores z-order as fractional-index strings; keep it.
  if (elements.every((el) => typeof el.index === 'string')) {
    elements.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
  }
  const files = { ...(serverInk.files || {}), ...(clientInk.files || {}) };
  return { ...serverInk, ...clientInk, elements, files };
}

// ----- id-keyed lists (marks, bookmarks) -----------------------------------

const TOMBSTONE_MS = 30 * 24 * 3600 * 1000;

// Items: { id, u (ms timestamp of the last change), del?: true, ... }. The
// newer `u` wins; on a tie the server's copy stays, so re-pushing the same
// list is harmless. Deleted items are kept for 30 days so devices that were
// offline still learn about the deletion, then dropped.
function mergeById(serverList, clientList, now = Date.now()) {
  const byId = new Map();
  const order = [];
  const add = (item, preferIncoming) => {
    if (!item || typeof item.id !== 'string') return;
    const prev = byId.get(item.id);
    if (!prev) {
      order.push(item.id);
      byId.set(item.id, item);
    } else if (preferIncoming && (item.u ?? 0) > (prev.u ?? 0)) {
      byId.set(item.id, item);
    }
  };
  for (const item of Array.isArray(serverList) ? serverList : []) add(item, false);
  for (const item of Array.isArray(clientList) ? clientList : []) add(item, true);
  return order
    .map((id) => byId.get(id))
    .filter((item) => !(item.del && (item.u ?? 0) < now - TOMBSTONE_MS));
}

// ----- page layout ---------------------------------------------------------

// A layout is the ordered page list of a document that has note pages
// inserted: { t: 'p', i } for PDF page i, { t: 'n', id, w, h, s, u, del? } for
// a note page (w/h in PDF points, s = paper style). Items are keyed (p<i> /
// n<id>); the order comes from the device that sent its latest layout, and a
// note page only the server knows about (inserted on another device since) is
// slotted in after the page that preceded it there.
function layoutKey(item) {
  return item.t === 'p' ? `p${item.i}` : `n${item.id}`;
}

function mergeLayouts(server, client) {
  if (!Array.isArray(client)) return Array.isArray(server) ? server : null;
  if (!Array.isArray(server)) return client;
  const serverBy = new Map(server.map((it) => [layoutKey(it), it]));
  const out = client.map((it) => {
    const s = serverBy.get(layoutKey(it));
    return s && (s.u ?? 0) > (it.u ?? 0) ? s : it;
  });
  const have = new Set(out.map(layoutKey));
  let prev = null;
  for (const it of server) {
    const key = layoutKey(it);
    if (!have.has(key)) {
      const at = prev ? out.findIndex((x) => layoutKey(x) === prev) : -1;
      out.splice(at + 1, 0, it);
      have.add(key);
    }
    prev = key;
  }
  return out;
}

// Validates a layout from a device: bounded, well-formed items only.
function cleanLayout(layout) {
  if (layout === null) return null;
  if (!Array.isArray(layout) || layout.length > 20000) return undefined;
  const out = [];
  for (const it of layout) {
    if (!it || typeof it !== 'object') return undefined;
    if (it.t === 'p' && Number.isInteger(it.i) && it.i >= 0) out.push({ t: 'p', i: it.i });
    else if (it.t === 'n' && typeof it.id === 'string' && /^[0-9a-zA-Z-]{4,64}$/.test(it.id)) {
      out.push({
        t: 'n',
        id: it.id,
        w: Number.isFinite(it.w) ? it.w : 595,
        h: Number.isFinite(it.h) ? it.h : 842,
        s: typeof it.s === 'string' ? it.s.slice(0, 16) : 'lined',
        u: Number.isFinite(it.u) ? it.u : 0,
        ...(it.del ? { del: true } : {}),
      });
    } else return undefined;
  }
  return out;
}

module.exports = { mergeScenes, mergeById, mergeLayouts, cleanLayout, layoutKey, TOMBSTONE_MS };
