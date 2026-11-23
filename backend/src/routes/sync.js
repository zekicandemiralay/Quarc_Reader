const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const ds = require('../services/docStore');
const { gcFiles } = require('../services/fileStore');

const ID_RE = /^[0-9a-zA-Z-]{4,64}$/;

// Pull: everything for this user changed since `since` (the cursor the client
// got from its previous pull) — documents, per-page annotations, and the ids of
// documents deleted forever. The lower bound is inclusive (clients skip
// versions they already have, so re-receiving the boundary is harmless and
// nothing written in the same millisecond as the cursor can slip through).
//
// Annotation rows can be many and large (a heavily annotated book), so a pull
// returns at most `limit` of them; if there are more, `more` is true and
// `until` is where to continue from.
router.get('/pull', (req, res) => {
  const db = getDb();
  const userId = req.user.id;
  const since = ds.normalizeTs(req.query.since) || '1970-01-01 00:00:00';
  const serverTime = ds.nowTs(db);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);

  let until = serverTime;
  let more = false;
  let annRows;
  // Rows written in one push can share a millisecond; if a whole page of them
  // does, widen the page so the cursor still moves forward.
  for (let lim = limit; ; lim *= 4) {
    const rows = db.prepare('SELECT * FROM annotations WHERE user_id = ? AND updated_at >= ? ORDER BY updated_at ASC LIMIT ?').all(userId, since, lim + 1);
    if (rows.length <= lim) {
      annRows = rows;
      break;
    }
    const last = rows[lim - 1].updated_at;
    if (last > since || lim >= 1000000) {
      until = last;
      more = true;
      annRows = rows.filter((r) => r.updated_at <= until);
      break;
    }
  }

  const docs = db
    .prepare('SELECT * FROM documents WHERE user_id = ? AND updated_at >= ? AND updated_at <= ? ORDER BY updated_at ASC')
    .all(userId, since, until)
    .map((r) => ds.serializeDoc(db, r));
  const deleted = db
    .prepare('SELECT id FROM deleted_documents WHERE user_id = ? AND deleted_at >= ? AND deleted_at <= ?')
    .all(userId, since, until)
    .map((r) => r.id);

  res.json({ serverTime, until, more, docs, anns: annRows.map(ds.serializeAnn), deleted });
});

// One mutation. Shapes:
//   { kind: 'doc', id, base_updated_at?, fields?: {changed fields}, deleted?: bool, purge?: bool }
//   { kind: 'ann', doc_id, page_key, base_updated_at?, ink?: {elements, files?}, marks?: [...] }
// `fields` holds only what changed on the device, so concurrent edits of
// different things (a rename here, a new bookmark there) both survive.
function applyDoc(db, userId, clientId, m, ctx) {
  const key = `d:${m.id}`;
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) return { key, status: 'error', error: 'invalid id' };

  const anyRow = db.prepare('SELECT user_id FROM documents WHERE id = ?').get(m.id);
  if (anyRow && anyRow.user_id !== userId) return { key, status: 'error', error: 'forbidden' };

  if (m.purge) {
    if (anyRow) ds.purgeDoc(db, userId, m.id);
    else db.prepare("INSERT OR REPLACE INTO deleted_documents (id, user_id, deleted_at) VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))").run(m.id, userId);
    return { key, status: 'ok', purged: true };
  }

  const fields = ds.cleanDocFields(m.fields);
  let current = ds.getDoc(db, userId, m.id);
  const result = { key, status: 'ok' };

  if (!current) {
    if (ds.isTombstoned(db, userId, m.id)) return { key, status: 'gone' };
    // Trashing/restoring a document the server never received: nothing to do.
    if (!Object.keys(fields).length) return { key, status: 'ok' };
    current = ds.insertDoc(db, userId, m.id, fields, clientId);
  } else if (Object.keys(fields).length) {
    const base = ds.normalizeTs(m.base_updated_at);
    // The device built this edit on an older version than the server has (or
    // doesn't say which): send the result back so it also gets whatever else
    // changed meanwhile.
    if (!base || current.updated_at > base) result.stale = true;
    if (fields.layout !== undefined || fields.bookmarks !== undefined || fields.settings !== undefined) result.merged = true;
    if (fields.file_sha256 !== undefined || fields.orig_sha256 !== undefined) ctx.collect = true;
    current = ds.updateDoc(db, userId, current, fields, clientId);
  }

  if (m.deleted === true && !current.is_deleted) ds.setDeleted(db, userId, m.id, true);
  if (m.deleted === false && current.is_deleted) ds.setDeleted(db, userId, m.id, false);

  current = ds.getDoc(db, userId, m.id);
  result.updated_at = current.updated_at;
  if (result.stale || result.merged || m.deleted === false) result.doc = ds.serializeDoc(db, current);
  delete result.stale;
  delete result.merged;
  return result;
}

function applyAnn(db, userId, clientId, m, seen) {
  const key = `a:${m.doc_id}:${m.page_key}`;
  if (typeof m.doc_id !== 'string' || !ID_RE.test(m.doc_id) || typeof m.page_key !== 'string' || !ds.PAGE_KEY_RE.test(m.page_key)) {
    return { key, status: 'error', error: 'invalid id' };
  }
  const doc = ds.getDoc(db, userId, m.doc_id);
  if (!doc) {
    if (ds.isTombstoned(db, userId, m.doc_id)) return { key, status: 'gone' };
    return { key, status: 'error', error: 'no such document' };
  }
  const fields = ds.cleanAnnFields(m);
  if (!Object.keys(fields).length) return { key, status: 'error', error: 'nothing to save' };

  const { row, merged, stale } = ds.upsertAnn(db, userId, m.doc_id, m.page_key, fields, ds.normalizeTs(m.base_updated_at), clientId, seen);
  const result = { key, status: 'ok', updated_at: row.updated_at };
  // The server's copy now differs from what the device sent (merged strokes,
  // or a version from another device): send it back. `merged` tells the device
  // that the result is nobody's own write, so its next edit must merge again.
  if (merged || stale) result.ann = ds.serializeAnn(row);
  if (merged) result.merged = true;
  return result;
}

// Push: the device's queued offline edits, applied in a single transaction
// (all or nothing). Documents go first, so a page's annotations never arrive
// before the document they belong to.
router.post('/push', (req, res) => {
  const db = getDb();
  const userId = req.user.id;
  const mutations = Array.isArray(req.body.mutations) ? req.body.mutations.slice(0, 500) : [];
  const clientId = typeof req.body.client_id === 'string' ? req.body.client_id.slice(0, 64) : null;
  const ordered = [...mutations.filter((m) => m && m.kind === 'doc'), ...mutations.filter((m) => m && m.kind === 'ann')];
  const seen = new Set();
  const ctx = { collect: false };
  const results = [];

  try {
    db.transaction(() => {
      for (const m of ordered) {
        let r;
        try {
          r = m.kind === 'doc' ? applyDoc(db, userId, clientId, m, ctx) : applyAnn(db, userId, clientId, m, seen);
        } catch (err) {
          r = { key: m.kind === 'doc' ? `d:${m.id}` : `a:${m.doc_id}:${m.page_key}`, status: 'error', error: err.message };
        }
        if (r.status === 'ok' && m.kind === 'ann') seen.add(`${m.doc_id}|${m.page_key}`);
        results.push(r);
      }
      if (ctx.collect) gcFiles(db, userId);
    })();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  res.json({ results });
});

module.exports = router;
