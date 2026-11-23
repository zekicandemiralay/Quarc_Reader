import { db } from './db';
import { emit } from './events';
import { sha256Hex, downloadBlob, fileUrl, setTransfer } from './files';
import { openPdf, measurePages, readMeta, renderThumb } from './pdf';
import { queueDocChange, queueAnn, pickSynced, removeDocLocally, syncSoon, runUploads, sync } from './sync';
import { fileStatus } from './files';

// Everything the library screen and the reader do to documents. The one rule
// that matters most: a document with sync === 'local' NEVER produces an outbox
// entry or a network request, so it provably stays on this device.

const nowIso = () => new Date().toISOString();

// ----- importing ---------------------------------------------------------------------

export class ImportError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const titleFromName = (name) => name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim() || 'Untitled';

const findBySha = (owner, sha) => db.docs.where('owner').equals(owner).filter((d) => d.file_sha256 === sha && !d.is_deleted).first();

// The document in the library that is exactly this file (same bytes), if there is one.
export async function findDuplicate(file, owner) {
  return findBySha(owner, await sha256Hex(await file.arrayBuffer()));
}

// Adds a PDF to the library. `sync` is the user's choice for this document:
// 'local' keeps it on this device only, 'cloud' uploads it and syncs everything
// about it. Resolves to { doc, duplicate }.
export async function importPdf(file, { sync: mode, owner, onStep }) {
  onStep?.('reading');
  const buffer = await file.arrayBuffer();
  const sha = await sha256Hex(buffer);

  const dup = await findBySha(owner, sha);
  if (dup) return { doc: dup, duplicate: true };

  const blob = new Blob([buffer], { type: 'application/pdf' });
  onStep?.('analyzing');
  let opened;
  try {
    opened = await openPdf({ blob });
  } catch (err) {
    if (err?.name === 'PasswordException') throw new ImportError('password', 'This PDF is password-protected.');
    throw new ImportError('invalid', 'This file could not be read as a PDF.');
  }
  let meta;
  let sizes;
  let thumb;
  let pageCount;
  try {
    pageCount = opened.pdf.numPages;
    meta = await readMeta(opened.pdf);
    sizes = await measurePages(opened.pdf);
    thumb = await renderThumb(opened.pdf).catch(() => null);
  } finally {
    opened.dispose();
  }

  const id = crypto.randomUUID();
  const now = nowIso();
  const doc = {
    id,
    owner,
    sync: mode,
    kind: 'pdf',
    title: meta.title || titleFromName(file.name || ''),
    author: meta.author || null,
    file_sha256: sha,
    file_size: blob.size,
    orig_sha256: null,
    file_ready: false,
    page_count: pageCount,
    sizes,
    layout: null,
    thumb,
    progress: null,
    progress_at: null,
    bookmarks: [],
    settings: {},
    is_favorite: 0,
    is_deleted: 0,
    created_at: now,
    updated_at: now,
    opened_at: null,
    server_updated_at: null,
  };
  onStep?.('saving');
  await db.transaction('rw', db.docs, db.blobs, async () => {
    await db.blobs.put({ sha256: sha, blob, size: blob.size, last_used: Date.now() });
    await db.docs.put(doc);
  });
  if (mode === 'cloud') {
    await queueDocChange(id, { fields: doc });
    runUploads();
  }
  emit('docs-changed', [id]);
  return { doc, duplicate: false };
}

// ----- changing a document ------------------------------------------------------------

// Updates fields of a document on this device and, if it is synced, queues them.
export async function updateDoc(id, patch) {
  const doc = await db.docs.get(id);
  if (!doc) return null;
  const next = { ...doc, ...patch, updated_at: nowIso() };
  await db.docs.put(next);
  if (doc.sync === 'cloud') await queueDocChange(id, { fields: patch });
  emit('docs-changed', [id]);
  return next;
}

// Local-only bookkeeping that is not worth syncing (when it was last opened).
export async function markOpened(id) {
  await db.docs.update(id, { opened_at: nowIso() });
  emit('docs-changed', [id]);
}

// Reading position. The device that read last wins (progress_at is its clock).
export async function saveProgress(id, progress) {
  const doc = await db.docs.get(id);
  if (!doc) return;
  const at = nowIso();
  await db.docs.update(id, { progress, progress_at: at });
  if (doc.sync === 'cloud') await queueDocChange(id, { fields: { progress, progress_at: at } });
  emit('docs-changed', [id]);
}

// ----- local <-> synced ----------------------------------------------------------------

// Starts syncing a local-only document: uploads the file, then keeps every
// annotation, bookmark and the reading position in step across devices.
export async function enableSync(id) {
  const doc = await db.docs.get(id);
  if (!doc || doc.sync === 'cloud') return;
  const blob = await db.blobs.get(doc.file_sha256);
  if (!blob) throw new Error('The file is not on this device, so it cannot be uploaded.');
  await db.transaction('rw', db.docs, db.ann, db.outbox, async () => {
    // A "stop syncing" that never reached the server is replaced by this.
    await db.outbox.delete(`d:${id}`);
    await db.docs.update(id, { sync: 'cloud', file_ready: false, server_updated_at: null });
  });
  const fresh = await db.docs.get(id);
  await queueDocChange(id, { fields: fresh });
  const anns = await db.ann.where('doc_id').equals(id).toArray();
  for (const row of anns) {
    await db.ann.update([id, row.page_key], { server_updated_at: null });
    await queueAnn(id, row.page_key);
  }
  emit('docs-changed', [id]);
  runUploads();
}

// Stops syncing a document: the copy on the server (and on other devices) is
// deleted, this device keeps the file and everything drawn on it. The file is
// fetched first if only the server had it — otherwise this would lose the book.
export async function disableSync(id, { onProgress } = {}) {
  const doc = await db.docs.get(id);
  if (!doc || doc.sync === 'local') return;
  if (!(await db.blobs.get(doc.file_sha256))) {
    if (!doc.file_ready) throw new Error('The file is not on this device and not on the server yet.');
    await cacheOffline(id, { onProgress });
  }
  await db.transaction('rw', db.docs, db.ann, db.outbox, async () => {
    await db.outbox.where('key').startsWith(`a:${id}:`).delete();
    await db.outbox.delete(`d:${id}`);
    await db.docs.update(id, { sync: 'local', file_ready: false, server_updated_at: null });
    await db.ann.where('doc_id').equals(id).modify({ server_updated_at: null });
  });
  await queueDocChange(id, { purge: true, keepLocal: true });
  setTransfer(id, null);
  emit('docs-changed', [id]);
}

// ----- trash / delete -----------------------------------------------------------------

export async function trashDoc(id) {
  const doc = await db.docs.get(id);
  if (!doc) return;
  await db.docs.update(id, { is_deleted: 1, updated_at: nowIso() });
  if (doc.sync === 'cloud') await queueDocChange(id, { deleted: true });
  emit('docs-changed', [id]);
}

export async function restoreDoc(id) {
  const doc = await db.docs.get(id);
  if (!doc) return;
  await db.docs.update(id, { is_deleted: 0, updated_at: nowIso() });
  if (doc.sync === 'cloud') await queueDocChange(id, { deleted: false });
  emit('docs-changed', [id]);
}

// Deletes a document for good, here and (if it is synced) everywhere.
export async function purgeDoc(id) {
  const doc = await db.docs.get(id);
  if (!doc) return;
  await removeDocLocally(id);
  if (doc.sync === 'cloud') await queueDocChange(id, { purge: true });
  emit('docs-changed', [id]);
}

// ----- the file ------------------------------------------------------------------------

export async function hasLocalFile(doc) {
  return !!(doc.file_sha256 && (await db.blobs.get(doc.file_sha256)));
}

// What pdf.js should open: the copy on this device if there is one, else the
// server's (streamed with Range requests). null = not available right now.
export async function pdfSource(doc) {
  const local = doc.file_sha256 ? await db.blobs.get(doc.file_sha256) : null;
  if (local) {
    db.blobs.update(doc.file_sha256, { last_used: Date.now() });
    return { blob: local.blob, local: true };
  }
  if (doc.sync === 'cloud' && doc.file_ready && doc.file_sha256) return { url: fileUrl(doc.file_sha256), withCredentials: true, local: false };
  return null;
}

const VERIFY_HASH_UP_TO = 150 * 1024 * 1024; // bytes

// Keeps a synced document's file on this device, for reading offline.
export async function cacheOffline(id, { onProgress } = {}) {
  const doc = await db.docs.get(id);
  if (!doc || !doc.file_sha256) return;
  if (await db.blobs.get(doc.file_sha256)) return;
  setTransfer(id, { state: 'downloading', pct: 0 });
  try {
    const blob = await downloadBlob(fileUrl(doc.file_sha256), {
      onProgress: (pct) => {
        setTransfer(id, { pct });
        onProgress?.(pct);
      },
    });
    // Only the real file is ever kept: a copy that was cut short or is an error page would be read instead of the
    // server's and the document would not open. (The hash needs the whole file in memory, so very big ones get the size check only.)
    if (doc.file_size && blob.size !== doc.file_size) throw new Error(`The download was incomplete (${blob.size} of ${doc.file_size} bytes).`);
    if (blob.size <= VERIFY_HASH_UP_TO && (await sha256Hex(await blob.arrayBuffer())) !== doc.file_sha256) throw new Error('The download was damaged.');
    await db.blobs.put({ sha256: doc.file_sha256, blob, size: blob.size, last_used: Date.now() });
    setTransfer(id, null);
    emit('docs-changed', [id]);
  } catch (err) {
    setTransfer(id, { state: 'error', error: err.message });
    throw err;
  }
}

// Frees the offline copy of a synced document (it stays on the server). Local-only documents have no other copy, so they are never evicted.
export async function removeOfflineCopy(id) {
  const doc = await db.docs.get(id);
  if (!doc || doc.sync !== 'cloud' || !doc.file_ready) return false;
  await db.blobs.delete(doc.file_sha256);
  emit('docs-changed', [id]);
  return true;
}

// Replaces a document's file with `blob` (an exported copy with the ink
// burned in): the old file is kept as `orig_sha256` so it can be restored.
// `clearAnnotations` removes the page ink/marks that are now part of the file.
export async function replaceFile(id, blob, { clearAnnotations, meta }) {
  const doc = await db.docs.get(id);
  if (!doc) throw new Error('document not found');
  const sha = await sha256Hex(await blob.arrayBuffer());
  await db.blobs.put({ sha256: sha, blob, size: blob.size, last_used: Date.now() });
  const patch = { file_sha256: sha, file_size: blob.size, orig_sha256: doc.orig_sha256 || doc.file_sha256, file_ready: false };
  // The new file has every page of the old one plus the note pages as real
  // pages, so the page list is simply the PDF's pages again.
  if (meta) Object.assign(patch, { page_count: meta.page_count, sizes: meta.sizes, layout: null });
  await db.docs.update(id, { ...patch, updated_at: nowIso() });
  if (doc.sync === 'cloud') await queueDocChange(id, { fields: patch });
  if (clearAnnotations) {
    const rows = await db.ann.where('doc_id').equals(id).toArray();
    for (const row of rows) await savePageAnnotations(id, row.page_key, clearedPage(row), { force: true });
  }
  emit('docs-changed', [id]);
  if (doc.sync === 'cloud') runUploads();
}

// Puts the original file back after "replace original".
export async function revertToOriginal(id) {
  const doc = await db.docs.get(id);
  if (!doc?.orig_sha256) return;
  if (!(await db.blobs.get(doc.orig_sha256))) {
    if (doc.sync === 'cloud') {
      setTransfer(id, { state: 'downloading', pct: 0 });
      const blob = await downloadBlob(fileUrl(doc.orig_sha256), { onProgress: (pct) => setTransfer(id, { pct }) });
      await db.blobs.put({ sha256: doc.orig_sha256, blob, size: blob.size, last_used: Date.now() });
      setTransfer(id, null);
    } else throw new Error('The original is no longer on this device.');
  }
  const stillOnServer = doc.sync === 'cloud' ? await fileStatus(doc.orig_sha256).catch(() => ({ exists: false })) : { exists: false };
  const orig = await db.blobs.get(doc.orig_sha256);
  // The original may have fewer pages than the annotated copy (note pages were
  // real pages there), so measure it again.
  const opened = await openPdf({ blob: orig.blob });
  let pageCount;
  let sizes;
  try {
    pageCount = opened.pdf.numPages;
    sizes = await measurePages(opened.pdf);
  } finally {
    opened.dispose();
  }
  const patch = {
    file_sha256: doc.orig_sha256,
    file_size: orig.size,
    orig_sha256: null,
    file_ready: !!stillOnServer.exists,
    page_count: pageCount,
    sizes,
    layout: null,
  };
  await db.docs.update(id, { ...patch, updated_at: nowIso() });
  if (doc.sync === 'cloud') await queueDocChange(id, { fields: patch });
  emit('docs-changed', [id]);
  if (doc.sync === 'cloud') runUploads();
}

// ----- annotations -----------------------------------------------------------------------

// Everything drawn on a document: Map<pageKey, { ink: {elements, files}, marks }>.
export async function loadAnnotations(docId) {
  const rows = await db.ann.where('doc_id').equals(docId).toArray();
  const out = new Map();
  for (const row of rows) {
    let ink = { elements: [], files: {} };
    let marks = [];
    try {
      ink = JSON.parse(row.ink_json) || ink;
      marks = JSON.parse(row.marks_json) || [];
    } catch {
      /* a damaged row reads as an empty page */
    }
    if (!Array.isArray(ink.elements)) ink = { elements: [], files: {} };
    out.set(row.page_key, { ink, marks });
  }
  return out;
}

// A page with everything on it erased — as *tombstones*, not empty lists: the
// server merges marks by id and ink stroke by stroke, so an erasure only
// reaches other devices if it is a newer version of each item marked deleted.
export function clearedPage(row) {
  let ink = { elements: [], files: {} };
  let marks = [];
  try {
    ink = JSON.parse(row.ink_json) || ink;
    marks = JSON.parse(row.marks_json) || [];
  } catch {
    /* damaged row: nothing to erase */
  }
  const u = Date.now();
  return {
    ink: {
      ...ink,
      elements: (ink.elements || []).map((el) =>
        el.isDeleted ? el : { ...el, isDeleted: true, version: (el.version || 0) + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: u }
      ),
    },
    marks: marks.map((m) => (m.del ? m : { ...m, del: true, u })),
  };
}

// Saves one page's ink and marks. Unchanged pages and pages that never had
// anything are skipped, so calling this for every page on every save is cheap.
export async function savePageAnnotations(docId, pageKey, { ink, marks }, { force = false } = {}) {
  const doc = await db.docs.get(docId);
  if (!doc) return false;
  const inkJson = JSON.stringify(ink ?? { elements: [] });
  const marksJson = JSON.stringify(marks ?? []);
  const prev = await db.ann.get([docId, pageKey]);
  if (!prev && !force && !(ink?.elements?.length || marks?.length)) return false;
  if (prev && prev.ink_json === inkJson && prev.marks_json === marksJson) return false;
  await db.ann.put({
    doc_id: docId,
    page_key: pageKey,
    ink_json: inkJson,
    marks_json: marksJson,
    updated_at: nowIso(),
    server_updated_at: prev?.server_updated_at ?? null,
  });
  if (doc.sync === 'cloud') await queueAnn(docId, pageKey);
  emit('ann-changed', { docId, pageKeys: [pageKey], remote: false });
  return true;
}

export { sync, syncSoon, pickSynced };
