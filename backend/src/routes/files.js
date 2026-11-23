const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const fileStore = require('../services/fileStore');

const { SHA_RE } = fileStore;

// How much of this user's storage is used (for Settings).
router.get('/usage', (req, res) => {
  res.json({ bytes: fileStore.totalBytes(getDb(), req.user.id) });
});

// Does the server have this file? If not, how many bytes of it has it received
// so far — the client resumes an interrupted upload from there.
router.get('/:sha/status', (req, res) => {
  const sha = String(req.params.sha).toLowerCase();
  if (!SHA_RE.test(sha)) return res.status(400).json({ error: 'invalid hash' });
  const db = getDb();
  if (fileStore.hasFile(db, req.user.id, sha)) {
    return res.json({ exists: true, size: db.prepare('SELECT size FROM files WHERE user_id = ? AND sha256 = ?').get(req.user.id, sha).size });
  }
  res.json({ exists: false, received: fileStore.partialSize(req.user.id, sha) });
});

// Upload one chunk: PUT /api/files/<sha256>?offset=<bytes already sent>&total=<file size>
// with the raw bytes as the body. The offset must match what the server has
// (409 + { received } otherwise). When the last chunk lands the whole file is
// hashed; it is only kept if the hash is the one in the URL.
router.put('/:sha', async (req, res) => {
  const sha = String(req.params.sha).toLowerCase();
  if (!SHA_RE.test(sha)) return res.status(400).json({ error: 'invalid hash' });
  const offset = Number(req.query.offset ?? 0);
  const total = Number(req.query.total);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(total) || total <= 0 || offset > total) {
    return res.status(400).json({ error: 'invalid offset/total' });
  }
  if (total > fileStore.MAX_FILE_BYTES()) {
    req.resume();
    return res.status(413).json({ error: 'file too large' });
  }

  const db = getDb();
  const userId = req.user.id;
  if (fileStore.hasFile(db, userId, sha)) {
    req.resume();
    return res.json({ exists: true });
  }
  const have = fileStore.partialSize(userId, sha);
  if (offset !== have) {
    req.resume();
    return res.status(409).json({ error: 'offset mismatch', received: have });
  }
  // The account's storage limit (if the server has one) is checked when a file starts.
  const quota = fileStore.MAX_USER_BYTES();
  if (quota && offset === 0 && fileStore.totalBytes(db, userId) + total > quota) {
    req.resume();
    return res.status(413).json({ error: 'storage limit reached', limit: quota });
  }

  let written;
  try {
    written = await fileStore.appendChunk(userId, sha, req, total - offset);
  } catch (err) {
    if (err.code === 'TOO_LARGE') {
      fileStore.abandonUpload(userId, sha);
      return res.status(413).json({ error: 'more data than declared' });
    }
    if (err.code === 'ABORTED') return undefined; // the client went away; it will ask for status and resume
    return res.status(500).json({ error: err.message });
  }

  const received = offset + written;
  if (received < total) return res.json({ received });

  try {
    const actual = await fileStore.hashFile(fileStore.partPath(userId, sha));
    if (actual !== sha) {
      fileStore.abandonUpload(userId, sha);
      return res.status(422).json({ error: 'hash mismatch — upload discarded' });
    }
    fileStore.commitUpload(db, userId, sha, total);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  return res.json({ exists: true });
});

// Download. Express' sendFile answers Range requests, so pdf.js can open a
// big PDF straight from here and fetch only the pages being read.
router.get('/:sha', (req, res) => {
  const sha = String(req.params.sha).toLowerCase();
  if (!SHA_RE.test(sha)) return res.status(400).json({ error: 'invalid hash' });
  if (!fileStore.hasFile(getDb(), req.user.id, sha)) return res.status(404).json({ error: 'not found' });
  res.sendFile(fileStore.filePath(req.user.id, sha), {
    headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, max-age=31536000, immutable' },
  });
});

module.exports = router;
