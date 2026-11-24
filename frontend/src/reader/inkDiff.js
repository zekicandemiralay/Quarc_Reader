// What changed in the drawing, and putting it back — for the reader's undo (see history.js).
//
// The scene is watched, not Excalidraw's own history: after each burst of drawing the scene is compared with what was
// last seen, and the elements that differ become one undo step. Everything is kept PAGE-LOCALLY (x/y relative to the
// page, like the saved ink, see inkBuckets.js), so a step recorded before a note page was inserted above still puts
// its ink back on the right page afterwards.
//
//   last   Map(element id -> { key, el })    the page-local copy of every element as last seen
//   change { id, before, beforeKey, after, afterKey }   before/after are page-local elements, or null (did not exist)

import { pageOfElement, toPageLocal, toScene } from './inkBuckets.js';

// Properties that change without the person having done anything (Excalidraw's bookkeeping).
const BOOKKEEPING = new Set(['version', 'versionNonce', 'updated', 'index']);

export function sameContent(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (BOOKKEEPING.has(k)) continue;
    const x = a[k];
    const y = b[k];
    if (x === y) continue;
    if (x && y && typeof x === 'object' && typeof y === 'object' && JSON.stringify(x) === JSON.stringify(y)) continue;
    return false;
  }
  return true;
}

const randomNonce = () => Math.floor(Math.random() * 2 ** 31);

// The page-local copy of every element, to compare against later.
export function snapshotScene(layout, elements) {
  const last = new Map();
  for (const el of elements) {
    const i = pageOfElement(layout, el);
    last.set(el.id, { key: layout.pages[i].key, el: toPageLocal(layout, el, i) });
  }
  return last;
}

// Compares the scene (scene coordinates) with `last`. Returns the changes, and the new `last`.
// An element whose content is the same and only its version moved is not a change (not the person's doing).
export function diffScene(layout, elements, last) {
  const next = new Map();
  const changes = [];
  for (const el of elements) {
    const i = pageOfElement(layout, el);
    const key = layout.pages[i].key;
    const prev = last.get(el.id);
    if (prev && prev.key === key && prev.el.version === el.version) {
      next.set(el.id, prev);
      continue;
    }
    const local = toPageLocal(layout, el, i);
    next.set(el.id, { key, el: local });
    if (prev && prev.key === key && sameContent(prev.el, local)) continue;
    // Something that was never on the page, or already gone, and is gone now (the pencil's stroke that became a text
    // highlight, a stroke scribbled out before it settled) is nothing to undo.
    if (local.isDeleted && (!prev || prev.el.isDeleted)) continue;
    changes.push({ id: el.id, before: prev ? prev.el : null, beforeKey: prev ? prev.key : null, after: local, afterKey: key });
  }
  return { changes, next };
}

// Puts the 'before' (dir 'undo') or 'after' (dir 'redo') state of every change back into the scene. The elements come
// out with a higher version than anything seen, so the change wins when it is saved and synced. A change whose page
// is not in the layout any more (a deleted note page) is skipped. Returns { elements, skipped }.
export function applyInkChanges(layout, elements, changes, dir, now = Date.now()) {
  const undo = dir === 'undo';
  const pageIndex = new Map(layout.pages.map((p, i) => [p.key, i]));
  const wanted = new Map(changes.map((c) => [c.id, c]));
  let skipped = 0;

  const place = (cur, target, key) => {
    if (target === null) {
      // it did not exist: it is deleted again
      if (!cur || cur.isDeleted) return cur;
      return { ...cur, isDeleted: true, version: cur.version + 1, versionNonce: randomNonce(), updated: now };
    }
    const i = pageIndex.get(key);
    if (i === undefined) {
      skipped++;
      return cur;
    }
    return { ...toScene(layout, target, i), version: Math.max(cur ? cur.version : 0, target.version ?? 0) + 1, versionNonce: randomNonce(), updated: now };
  };

  const out = elements.map((cur) => {
    const c = wanted.get(cur.id);
    if (!c) return cur;
    wanted.delete(cur.id);
    return place(cur, undo ? c.before : c.after, undo ? c.beforeKey : c.afterKey);
  });
  // elements that are not in the scene any more (dropped with a deleted page) and are wanted back
  for (const c of wanted.values()) {
    const target = undo ? c.before : c.after;
    if (target !== null) {
      const placed = place(null, target, undo ? c.beforeKey : c.afterKey);
      if (placed) out.push(placed);
    }
  }
  return { elements: out, skipped };
}
