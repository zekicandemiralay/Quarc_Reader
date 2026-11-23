const crypto = require('crypto');
const express = require('express');
const { getDb, NOW } = require('../db');
const ds = require('../services/docStore');
const fileStore = require('../services/fileStore');

// ----- owner side (signed in) -----------------------------------------------

const router = express.Router();

const newToken = () => crypto.randomBytes(24).toString('base64url');

function serializeShare(s) {
  return {
    token: s.token,
    doc_id: s.doc_id,
    include_annotations: !!s.include_annotations,
    created_at: s.created_at,
    expires_at: s.expires_at,
    revoked: !!s.revoked_at,
    views: s.views,
    last_viewed_at: s.last_viewed_at,
  };
}

// Create a link for one of your documents. Only documents that are synced
// (i.e. on the server) can be shared — that is checked by the lookup.
router.post('/', (req, res) => {
  const db = getDb();
  const { doc_id: docId, include_annotations: include, expires_days: days } = req.body || {};
  const doc = typeof docId === 'string' ? ds.getDoc(db, req.user.id, docId) : null;
  if (!doc || doc.is_deleted) return res.status(404).json({ error: 'document not found on the server — sync it first' });
  if (!doc.file_sha256 || !fileStore.hasFile(db, req.user.id, doc.file_sha256)) {
    return res.status(409).json({ error: 'the file has not finished uploading yet' });
  }
  const expiresDays = Number.isFinite(days) && days > 0 ? Math.min(days, 3650) : null;
  const token = newToken();
  db.prepare(
    `INSERT INTO shares (token, user_id, doc_id, include_annotations, created_at, expires_at)
     VALUES (?, ?, ?, ?, ${NOW}, ${expiresDays ? `strftime('%Y-%m-%d %H:%M:%f', 'now', '+${Math.floor(expiresDays)} days')` : 'NULL'})`
  ).run(token, req.user.id, docId, include ? 1 : 0);
  res.status(201).json(serializeShare(db.prepare('SELECT * FROM shares WHERE token = ?').get(token)));
});

// Your links, newest first (optionally only for one document).
router.get('/', (req, res) => {
  const db = getDb();
  const rows =
    typeof req.query.doc_id === 'string'
      ? db.prepare('SELECT * FROM shares WHERE user_id = ? AND doc_id = ? ORDER BY created_at DESC').all(req.user.id, req.query.doc_id)
      : db.prepare('SELECT * FROM shares WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(rows.map(serializeShare));
});

// Turn a link off (it stays in the list as revoked, so you can see it was used).
router.delete('/:token', (req, res) => {
  const db = getDb();
  const r = db.prepare(`UPDATE shares SET revoked_at = ${NOW} WHERE token = ? AND user_id = ? AND revoked_at IS NULL`).run(req.params.token, req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'link not found' });
  res.json({ ok: true });
});

// Add a shared document to your own library (a copy of the file, and of the
// owner's annotations if the link includes them). Needs a Quarc account.
router.post('/:token/import', (req, res) => {
  const db = getDb();
  const share = liveShare(db, req.params.token);
  if (!share) return res.status(404).json({ error: 'link not found, expired or turned off' });
  const src = ds.getDoc(db, share.user_id, share.doc_id);
  if (!src || src.is_deleted || !src.file_sha256 || !fileStore.hasFile(db, share.user_id, src.file_sha256)) {
    return res.status(404).json({ error: 'document no longer available' });
  }
  const userId = req.user.id;
  const newId = crypto.randomUUID();
  const clientId = typeof req.body?.client_id === 'string' ? req.body.client_id.slice(0, 64) : null;
  let doc;
  db.transaction(() => {
    fileStore.copyFileTo(db, share.user_id, userId, src.file_sha256);
    const fields = {
      title: src.title,
      author: src.author,
      kind: src.kind,
      file_sha256: src.file_sha256,
      file_size: src.file_size,
      page_count: src.page_count,
      sizes: ds.parseJson(src.sizes_json, []),
      thumb: src.thumb,
    };
    if (share.include_annotations) fields.layout = ds.parseJson(src.layout_json, null);
    doc = ds.insertDoc(db, userId, newId, fields, clientId);
    if (share.include_annotations) {
      db.prepare(
        `INSERT INTO annotations (doc_id, page_key, user_id, ink_json, marks_json, created_at, updated_at, content_updated_at, last_client_id)
         SELECT ?, page_key, ?, ink_json, marks_json, ${NOW}, ${NOW}, ${NOW}, NULL FROM annotations WHERE doc_id = ? AND user_id = ?`
      ).run(newId, userId, src.id, share.user_id);
    }
  })();
  res.status(201).json({ doc: ds.serializeDoc(db, doc) });
});

// ----- reader side (anyone with the link) ------------------------------------

// A link works while it exists, isn't revoked or expired, and its document is
// still there. The token is 192 random bits: the link *is* the credential.
function liveShare(db, token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 64) return null;
  return db
    .prepare(
      `SELECT s.* FROM shares s JOIN documents d ON d.id = s.doc_id
       WHERE s.token = ? AND s.revoked_at IS NULL AND d.is_deleted = 0
         AND (s.expires_at IS NULL OR s.expires_at > ${NOW})`
    )
    .get(token);
}

const publicRouter = express.Router();

publicRouter.get('/shares/:token', (req, res) => {
  const db = getDb();
  const share = liveShare(db, req.params.token);
  if (!share) return res.status(404).json({ error: 'This link was not found, has expired or was turned off.' });
  const doc = ds.getDoc(db, share.user_id, share.doc_id);
  if (!doc.file_sha256 || !fileStore.hasFile(db, share.user_id, doc.file_sha256)) {
    return res.status(404).json({ error: 'This document is not available right now.' });
  }
  db.prepare(`UPDATE shares SET views = views + 1, last_viewed_at = ${NOW} WHERE token = ?`).run(share.token);
  const body = {
    title: doc.title,
    author: doc.author,
    page_count: doc.page_count,
    sizes: ds.parseJson(doc.sizes_json, []),
    include_annotations: !!share.include_annotations,
    expires_at: share.expires_at,
    layout: null,
    annotations: [],
  };
  if (share.include_annotations) {
    body.layout = ds.parseJson(doc.layout_json, null);
    body.annotations = db
      .prepare('SELECT * FROM annotations WHERE doc_id = ? AND user_id = ?')
      .all(doc.id, share.user_id)
      .map(ds.serializeAnn);
  }
  res.json(body);
});

publicRouter.get('/shares/:token/file', (req, res) => {
  const db = getDb();
  const share = liveShare(db, req.params.token);
  if (!share) return res.status(404).json({ error: 'not found' });
  const doc = ds.getDoc(db, share.user_id, share.doc_id);
  if (!doc.file_sha256 || !fileStore.hasFile(db, share.user_id, doc.file_sha256)) return res.status(404).json({ error: 'not found' });
  res.sendFile(fileStore.filePath(share.user_id, doc.file_sha256), {
    headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store' },
  });
});

module.exports = { router, publicRouter };
