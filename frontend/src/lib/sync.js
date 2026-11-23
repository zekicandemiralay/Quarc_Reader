import { create } from 'zustand';
import { db } from './db';
import { apiUrl } from './apiUrl';
import { emit } from './events';
import { toIso } from './time';
import { uploadBlob, setTransfer } from './files';

// Offline-first sync with the server (see backend/src/routes/sync.js).
//
// Every local change goes into Dexie immediately and into the outbox — but only
// for documents the user chose to sync. A "local only" document never produces
// an outbox entry, so nothing about it ever reaches the server.
//
// sync() pushes the outbox, then pulls whatever changed on the server since the
// last pull. Conflicts are resolved on the server without losing anything:
// ink merges stroke by stroke, highlights/bookmarks/note pages merge by id,
// and the device that read last decides the reading position. The PDF files
// themselves travel on their own lane (runUploads), so a 300 MB upload never
// holds up the next highlight.

const CLIENT_ID_KEY = 'quarc_reader_client_id';

// Identifies this device to the server, so its own back-to-back saves are
// never mistaken for a conflict with another device.
export function getClientId() {
  try {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch {
    return 'unknown-device';
  }
}

export const useSyncStatus = create(() => ({
  state: 'idle', // 'idle' | 'syncing' | 'offline' | 'error'
  pending: 0,
  lastSyncedAt: null,
}));

let userId = null;
export function setSyncUser(id) {
  userId = id;
}

// The document fields that travel to the server (everything else in a docs row
// is local: `sync`, `owner`, `opened_at`, `file_ready`, ...).
export const SYNCED_DOC_FIELDS = [
  'title',
  'author',
  'kind',
  'file_sha256',
  'file_size',
  'orig_sha256',
  'page_count',
  'sizes',
  'layout',
  'thumb',
  'progress',
  'progress_at',
  'bookmarks',
  'settings',
  'is_favorite',
];

export function pickSynced(obj) {
  const out = {};
  for (const key of SYNCED_DOC_FIELDS) if (obj[key] !== undefined) out[key] = obj[key];
  return out;
}

async function refreshPending() {
  useSyncStatus.setState({ pending: await db.outbox.count() });
}

// ----- outbox -------------------------------------------------------------------

// Queues a change to a document's metadata. Fields accumulate in one entry, so
// it holds only what changed since the last successful push.
export async function queueDocChange(id, { fields, deleted, purge, keepLocal } = {}) {
  await db.transaction('rw', db.outbox, db.docs, async () => {
    const doc = await db.docs.get(id);
    const key = `d:${id}`;
    const prev = await db.outbox.get(key);
    const entry = prev || { key, kind: 'doc', id, rev: 0, queued_at: Date.now(), base_updated_at: doc?.server_updated_at ?? null, fields: {} };
    entry.rev += 1;
    if (fields) entry.fields = { ...entry.fields, ...pickSynced(fields) };
    if (deleted !== undefined) entry.deleted = deleted;
    if (purge) {
      entry.purge = true;
      entry.keep_local = !!keepLocal;
    }
    await db.outbox.put(entry);
  });
  syncSoon();
}

// Queues one annotated page (its content is read from the `ann` row when pushed).
export async function queueAnn(docId, pageKey) {
  await db.transaction('rw', db.outbox, db.ann, async () => {
    const key = `a:${docId}:${pageKey}`;
    const prev = await db.outbox.get(key);
    const row = await db.ann.get([docId, pageKey]);
    await db.outbox.put({
      key,
      kind: 'ann',
      doc_id: docId,
      page_key: pageKey,
      rev: (prev?.rev || 0) + 1,
      queued_at: prev?.queued_at ?? Date.now(),
      base_updated_at: prev ? prev.base_updated_at : row?.server_updated_at ?? null,
    });
  });
  syncSoon();
}

// ----- server <-> local rows --------------------------------------------------------

export function docFromServer(d, local) {
  return {
    ...(local || {}),
    id: d.id,
    owner: userId,
    sync: 'cloud',
    kind: d.kind || 'pdf',
    title: d.title ?? 'Untitled',
    author: d.author ?? null,
    file_sha256: d.file_sha256 ?? null,
    file_size: d.file_size ?? null,
    orig_sha256: d.orig_sha256 ?? null,
    file_ready: !!d.file_ready,
    page_count: d.page_count ?? 0,
    sizes: d.sizes ?? [],
    layout: d.layout ?? null,
    thumb: d.thumb ?? null,
    progress: d.progress ?? null,
    progress_at: d.progress_at ?? null,
    bookmarks: d.bookmarks ?? [],
    settings: d.settings ?? {},
    is_favorite: d.is_favorite ? 1 : 0,
    is_deleted: d.is_deleted ? 1 : 0,
    created_at: toIso(d.created_at),
    updated_at: toIso(d.updated_at),
    server_updated_at: d.updated_at,
  };
}

export function annFromServer(a) {
  return {
    doc_id: a.doc_id,
    page_key: a.page_key,
    ink_json: JSON.stringify(a.ink ?? { elements: [] }),
    marks_json: JSON.stringify(a.marks ?? []),
    updated_at: toIso(a.updated_at),
    server_updated_at: a.updated_at,
  };
}

// Removes a document and everything kept for it on this device.
export async function removeDocLocally(id) {
  const doc = await db.docs.get(id);
  await db.transaction('rw', db.docs, db.ann, db.blobs, db.outbox, async () => {
    await db.docs.delete(id);
    await db.ann.where('doc_id').equals(id).delete();
    await db.outbox.where('key').startsWith(`a:${id}:`).delete();
    await db.outbox.delete(`d:${id}`);
    if (doc) await dropBlobIfUnused(doc.file_sha256);
    if (doc) await dropBlobIfUnused(doc.orig_sha256);
  });
}

export async function dropBlobIfUnused(sha) {
  if (!sha) return;
  const inUse = await db.docs.filter((d) => d.file_sha256 === sha || d.orig_sha256 === sha).count();
  if (!inUse) await db.blobs.delete(sha);
}

// ----- push -------------------------------------------------------------------

const MAX_BATCH_MUTATIONS = 200;
const MAX_BATCH_BYTES = 12 * 1024 * 1024;

async function buildMutation(e) {
  if (e.kind === 'doc') {
    const m = { kind: 'doc', id: e.id, base_updated_at: e.base_updated_at, fields: e.fields || {} };
    if (e.deleted !== undefined) m.deleted = e.deleted;
    if (e.purge) m.purge = true;
    return m;
  }
  const row = await db.ann.get([e.doc_id, e.page_key]);
  if (!row) return null;
  return {
    kind: 'ann',
    doc_id: e.doc_id,
    page_key: e.page_key,
    base_updated_at: e.base_updated_at,
    ink: JSON.parse(row.ink_json),
    marks: JSON.parse(row.marks_json),
  };
}

async function pushOutbox() {
  const pending = await db.outbox.orderBy('queued_at').toArray();
  if (!pending.length) return;
  const sentRevs = new Map(pending.map((e) => [e.key, e.rev]));

  const batches = [];
  let cur = [];
  let bytes = 0;
  for (const e of pending) {
    const m = await buildMutation(e);
    if (!m) {
      await db.outbox.delete(e.key); // its page was removed since
      continue;
    }
    const size = m.kind === 'ann' ? JSON.stringify(m).length : 400;
    if (cur.length && (cur.length >= MAX_BATCH_MUTATIONS || bytes + size > MAX_BATCH_BYTES)) {
      batches.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(m);
    bytes += size;
  }
  if (cur.length) batches.push(cur);

  for (const mutations of batches) {
    const res = await fetch(apiUrl('/api/sync/push'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ client_id: getClientId(), mutations }),
    });
    if (!res.ok) throw new Error(`push failed: ${res.status}`);
    const { results } = await res.json();
    await applyResults(results, sentRevs);
  }
}

async function applyResults(results, sentRevs) {
  const changedDocs = new Set();
  const changedAnn = new Map(); // docId -> Set(pageKey)

  await db.transaction('rw', db.outbox, db.docs, db.ann, db.blobs, async () => {
    for (const r of results) {
      const entry = await db.outbox.get(r.key);
      // Edited again while this push was in flight: keep the newer entry.
      const modifiedSince = !!entry && entry.rev !== sentRevs.get(r.key);

      if (r.status === 'error') {
        // Permanent (forbidden / invalid): retrying would block the queue.
        console.warn('Sync dropped a change the server rejected', r);
        if (!modifiedSince) await db.outbox.delete(r.key);
        continue;
      }
      if (r.status !== 'ok' && r.status !== 'gone') continue;
      if (!modifiedSince) await db.outbox.delete(r.key);

      if (r.key.startsWith('d:')) {
        const id = r.key.slice(2);
        if (r.status === 'gone') {
          // Deleted forever elsewhere: drop it here too (unless it is local-only now).
          const local = await db.docs.get(id);
          if (local?.sync === 'cloud') {
            await removeDocLocally(id);
            changedDocs.add(id);
          }
          continue;
        }
        if (r.purged) {
          if (entry?.keep_local) continue; // "stop syncing": the server copy is gone, this one stays
          continue;
        }
        const local = await db.docs.get(id);
        if (!local) continue;
        if (modifiedSince) {
          // A merge result isn't in the newer entry yet: leave its base alone so
          // the server merges again rather than taking it as a follow-up.
          if (!r.doc) await db.outbox.update(r.key, { base_updated_at: r.updated_at });
          continue;
        }
        if (r.doc) await db.docs.put(docFromServer(r.doc, local));
        else await db.docs.update(id, { server_updated_at: r.updated_at });
        changedDocs.add(id);
      } else {
        const [, docId, pageKey] = /^a:([^:]+):(.+)$/.exec(r.key) || [];
        if (!docId) continue;
        if (r.status === 'gone') {
          const local = await db.docs.get(docId);
          if (local?.sync === 'cloud') {
            await removeDocLocally(docId);
            changedDocs.add(docId);
          }
          continue;
        }
        if (modifiedSince) {
          if (!r.merged) await db.outbox.update(r.key, { base_updated_at: r.updated_at });
          continue;
        }
        if (r.ann) {
          await db.ann.put(annFromServer(r.ann));
          if (!changedAnn.has(docId)) changedAnn.set(docId, new Set());
          changedAnn.get(docId).add(pageKey);
        } else {
          await db.ann.update([docId, pageKey], { server_updated_at: r.updated_at });
        }
      }
    }
  });
  if (changedDocs.size) emit('docs-changed', [...changedDocs]);
  for (const [docId, keys] of changedAnn) emit('ann-changed', { docId, pageKeys: [...keys], remote: true });
}

// ----- pull -------------------------------------------------------------------

async function getCursor() {
  const row = await db.meta.get('sync_cursor');
  return row?.value || '';
}

async function pullFromServer() {
  const changedDocs = new Set();
  const changedAnn = new Map();
  for (let round = 0; round < 200; round++) {
    const since = await getCursor();
    const res = await fetch(apiUrl(`/api/sync/pull?since=${encodeURIComponent(since)}`), { credentials: 'include' });
    if (!res.ok) throw new Error(`pull failed: ${res.status}`);
    const { until, more, docs, anns, deleted = [] } = await res.json();

    await db.transaction('rw', db.docs, db.ann, db.outbox, db.meta, db.blobs, async () => {
      for (const d of docs) {
        // Local changes still queued: keep them. The push answers with the
        // server's version if this copy was out of date.
        if (await db.outbox.get(`d:${d.id}`)) continue;
        const local = await db.docs.get(d.id);
        if (local && local.sync === 'local') continue;
        if (local && local.server_updated_at === d.updated_at && local.file_ready === !!d.file_ready) continue;
        await db.docs.put(docFromServer(d, local));
        changedDocs.add(d.id);
      }
      for (const a of anns) {
        if (await db.outbox.get(`a:${a.doc_id}:${a.page_key}`)) continue;
        const local = await db.ann.get([a.doc_id, a.page_key]);
        if (local && local.server_updated_at === a.updated_at) continue;
        await db.ann.put(annFromServer(a));
        if (!changedAnn.has(a.doc_id)) changedAnn.set(a.doc_id, new Set());
        changedAnn.get(a.doc_id).add(a.page_key);
      }
      for (const id of deleted) {
        if (await db.outbox.get(`d:${id}`)) continue;
        const local = await db.docs.get(id);
        if (local?.sync === 'cloud') {
          await removeDocLocally(id);
          changedDocs.add(id);
        }
      }
      await db.meta.put({ key: 'sync_cursor', value: until });
    });
    if (!more) break;
  }
  if (changedDocs.size) emit('docs-changed', [...changedDocs]);
  for (const [docId, keys] of changedAnn) emit('ann-changed', { docId, pageKeys: [...keys], remote: true });
}

// ----- uploads (their own lane) -----------------------------------------------------

let uploading = false;

// Sends the PDF of every synced document the server doesn't have yet. Runs
// beside sync(), not inside it: a big upload must not delay the next highlight.
export async function runUploads() {
  if (uploading || !userId || !navigator.onLine) return;
  uploading = true;
  try {
    const docs = await db.docs.where('owner').equals(userId).filter((d) => d.sync === 'cloud' && !d.is_deleted && d.file_sha256 && !d.file_ready).toArray();
    for (const d of docs) {
      const blob = await db.blobs.get(d.file_sha256);
      if (!blob) continue; // a copy from another device that is still being replaced: nothing here to send
      try {
        setTransfer(d.id, { state: 'uploading', pct: 0, error: undefined });
        await uploadBlob(d.file_sha256, blob.blob, { onProgress: (pct) => setTransfer(d.id, { pct }) });
        await db.docs.update(d.id, { file_ready: true });
        setTransfer(d.id, null);
        emit('docs-changed', [d.id]);
      } catch (err) {
        setTransfer(d.id, { state: 'error', error: err.message });
      }
    }
  } finally {
    uploading = false;
  }
}

// ----- the loop ------------------------------------------------------------------

let syncing = false;
let syncAgain = false;

export async function sync() {
  if (!userId) return;
  if (syncing) {
    syncAgain = true;
    return;
  }
  if (!navigator.onLine) {
    useSyncStatus.setState({ state: 'offline' });
    await refreshPending();
    return;
  }
  syncing = true;
  useSyncStatus.setState({ state: 'syncing' });
  try {
    do {
      syncAgain = false;
      await pushOutbox();
      await pullFromServer();
    } while (syncAgain);
    useSyncStatus.setState({ state: 'idle', lastSyncedAt: new Date().toISOString() });
    runUploads();
  } catch {
    // Offline or server unreachable — retried on the next trigger.
    useSyncStatus.setState({ state: navigator.onLine ? 'error' : 'offline' });
  } finally {
    syncing = false;
    await refreshPending();
  }
}

// Debounced trigger for local edits: drawing doesn't fire a request per stroke.
let soonTimer = null;
export function syncSoon(delay = 1500) {
  clearTimeout(soonTimer);
  soonTimer = setTimeout(sync, delay);
  refreshPending();
}

export function startSyncLoop(id) {
  setSyncUser(id);
  sync();
  const onOnline = () => sync();
  const onOffline = () => useSyncStatus.setState({ state: 'offline' });
  const onVisible = () => {
    if (document.visibilityState === 'visible') sync();
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisible);
  const interval = setInterval(sync, 20000);
  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    document.removeEventListener('visibilitychange', onVisible);
    clearInterval(interval);
  };
}
