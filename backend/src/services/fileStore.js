// Where uploaded PDFs live: <DATA_DIR>/files/<user>/<sha256>. Files are named
// by the SHA-256 of their bytes (so a re-upload of the same file is a no-op
// and a corrupted upload can never be mistaken for the real one) and belong to
// one user — two users uploading the same PDF store it twice on purpose.
//
// Uploads arrive in chunks and are resumable: the partial file is kept in
// <DATA_DIR>/uploads, the client asks how many bytes arrived (GET status) and
// continues from there. Only a complete file whose hash matches is moved into
// place and registered.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, NOW } = require('../db');

const SHA_RE = /^[0-9a-f]{64}$/;
const MAX_FILE_BYTES = () => Number(process.env.MAX_FILE_BYTES) || 2 * 1024 * 1024 * 1024;
// Optional cap on everything one account may store (0 / unset = unlimited).
const MAX_USER_BYTES = () => Number(process.env.MAX_USER_BYTES) || 0;
const GRACE_MS = 60 * 60 * 1000; // a file this young is never garbage-collected (its document row may still be on the way)
const PARTIAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const safeUser = (userId) => String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
const filesDir = (userId) => path.join(DATA_DIR(), 'files', safeUser(userId));
const uploadsDir = () => path.join(DATA_DIR(), 'uploads');
const filePath = (userId, sha) => path.join(filesDir(userId), sha);
const partPath = (userId, sha) => path.join(uploadsDir(), `${safeUser(userId)}-${sha}.part`);

function hasFile(db, userId, sha) {
  return !!db.prepare('SELECT 1 FROM files WHERE user_id = ? AND sha256 = ?').get(userId, sha);
}

function partialSize(userId, sha) {
  try {
    return fs.statSync(partPath(userId, sha)).size;
  } catch {
    return 0;
  }
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

// Appends one chunk (a request body stream) to the partial file. Resolves to
// the number of bytes written; rejects if the chunk would exceed `limit`.
function appendChunk(userId, sha, stream, limit) {
  fs.mkdirSync(uploadsDir(), { recursive: true });
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(partPath(userId, sha), { flags: 'a' });
    let written = 0;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      out.destroy();
      reject(err);
    };
    stream.on('data', (buf) => {
      written += buf.length;
      if (written > limit) {
        stream.unpipe(out);
        fail(Object.assign(new Error('chunk too large'), { code: 'TOO_LARGE' }));
      }
    });
    stream.on('aborted', () => fail(Object.assign(new Error('aborted'), { code: 'ABORTED' })));
    stream.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (!failed) resolve(written);
    });
    stream.pipe(out);
  });
}

// Moves a verified, complete partial upload into place.
function commitUpload(db, userId, sha, size) {
  fs.mkdirSync(filesDir(userId), { recursive: true });
  fs.renameSync(partPath(userId, sha), filePath(userId, sha));
  db.prepare(`INSERT OR REPLACE INTO files (user_id, sha256, size, created_at) VALUES (?, ?, ?, ${NOW})`).run(userId, sha, size);
  // Other devices learn the file is ready from their next pull.
  db.prepare(`UPDATE documents SET updated_at = ${NOW} WHERE user_id = ? AND (file_sha256 = ? OR orig_sha256 = ?)`).run(userId, sha, sha);
}

function abandonUpload(userId, sha) {
  fs.rmSync(partPath(userId, sha), { force: true });
}

// Adds an already-stored file to another user's library (used when someone
// adds a shared document to their own).
function copyFileTo(db, fromUserId, toUserId, sha) {
  if (hasFile(db, toUserId, sha)) return;
  const row = db.prepare('SELECT size FROM files WHERE user_id = ? AND sha256 = ?').get(fromUserId, sha);
  if (!row) throw new Error('file missing');
  fs.mkdirSync(filesDir(toUserId), { recursive: true });
  fs.copyFileSync(filePath(fromUserId, sha), filePath(toUserId, sha));
  db.prepare(`INSERT OR REPLACE INTO files (user_id, sha256, size, created_at) VALUES (?, ?, ?, ${NOW})`).run(toUserId, sha, row.size);
}

// Deletes this user's files that no document points to any more (replaced or
// purged documents), and stale partial uploads. Documents in the trash still
// count: restoring one must find its file.
function gcFiles(db, userId) {
  const referenced = new Set();
  for (const r of db.prepare('SELECT file_sha256 AS a, orig_sha256 AS b FROM documents WHERE user_id = ?').all(userId)) {
    if (r.a) referenced.add(r.a);
    if (r.b) referenced.add(r.b);
  }
  const cutoff = Date.now() - GRACE_MS;
  let removed = 0;
  for (const f of db.prepare('SELECT sha256, created_at FROM files WHERE user_id = ?').all(userId)) {
    if (referenced.has(f.sha256)) continue;
    if (Date.parse(`${f.created_at.replace(' ', 'T')}Z`) > cutoff) continue;
    fs.rmSync(filePath(userId, f.sha256), { force: true });
    db.prepare('DELETE FROM files WHERE user_id = ? AND sha256 = ?').run(userId, f.sha256);
    removed++;
  }
  return removed;
}

function gcPartials() {
  let dir;
  try {
    dir = fs.readdirSync(uploadsDir());
  } catch {
    return;
  }
  for (const name of dir) {
    const p = path.join(uploadsDir(), name);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > PARTIAL_MAX_AGE_MS) fs.rmSync(p, { force: true });
    } catch {
      /* already gone */
    }
  }
}

function totalBytes(db, userId) {
  return db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE user_id = ?').get(userId).n;
}

module.exports = {
  SHA_RE,
  MAX_FILE_BYTES,
  MAX_USER_BYTES,
  filePath,
  partPath,
  hasFile,
  partialSize,
  hashFile,
  appendChunk,
  commitUpload,
  abandonUpload,
  copyFileTo,
  gcFiles,
  gcPartials,
  totalBytes,
};
