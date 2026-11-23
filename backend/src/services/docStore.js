// Document + annotation persistence, shared by offline sync (routes/sync.js)
// and share links (routes/shares.js), so both enforce the same rules:
// ownership, field validation, and lossless merging.

const { NOW } = require('../db');
const { SHA_RE, hasFile, gcFiles } = require('./fileStore');
const { mergeScenes, mergeById, mergeLayouts, cleanLayout } = require('./merge');

const MAX_TITLE = 500;
const MAX_THUMB = 80000; // characters of data URL
const MAX_INK_BYTES = 30 * 1024 * 1024;
const PAGE_KEY_RE = /^(p\d{1,6}|n[0-9a-zA-Z-]{4,64})$/;

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Accepts the server's own format or an ISO string from a device.
function normalizeTs(value) {
  if (typeof value !== 'string' || !value) return null;
  return value.replace('T', ' ').replace(/Z$/, '').replace(/[+-]\d\d:\d\d$/, '');
}

const nowTs = (db) => db.prepare(`SELECT ${NOW} AS t`).get().t;

// ----- documents ------------------------------------------------------------

// Row -> API shape (JSON columns parsed; `file_ready` says whether the file
// has finished uploading).
function serializeDoc(db, row) {
  if (!row) return row;
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    kind: row.kind,
    file_sha256: row.file_sha256,
    file_size: row.file_size,
    orig_sha256: row.orig_sha256,
    file_ready: !!(row.file_sha256 && hasFile(db, row.user_id, row.file_sha256)),
    page_count: row.page_count,
    sizes: parseJson(row.sizes_json, []),
    layout: parseJson(row.layout_json, null),
    thumb: row.thumb,
    progress: parseJson(row.progress_json, null),
    progress_at: row.progress_at,
    bookmarks: parseJson(row.bookmarks_json, []),
    settings: parseJson(row.settings_json, {}),
    is_favorite: row.is_favorite ? 1 : 0,
    is_deleted: row.is_deleted ? 1 : 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getDoc(db, userId, id) {
  return db.prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?').get(id, userId);
}

function validSizes(sizes) {
  return (
    Array.isArray(sizes) &&
    sizes.length <= 100000 &&
    sizes.every((r) => Array.isArray(r) && r.length === 3 && Number.isInteger(r[0]) && r[0] > 0 && r[1] > 0 && r[2] > 0 && r[1] < 20000 && r[2] < 20000)
  );
}

// Validates/cleans incoming field values. Unknown or malformed fields are dropped.
function cleanDocFields(fields) {
  const out = {};
  if (!fields || typeof fields !== 'object') return out;
  if (typeof fields.title === 'string') out.title = fields.title.slice(0, MAX_TITLE);
  if (fields.author === null || typeof fields.author === 'string') out.author = fields.author ? fields.author.slice(0, 300) : null;
  if (fields.kind === 'pdf') out.kind = 'pdf';
  if (fields.file_sha256 === null || (typeof fields.file_sha256 === 'string' && SHA_RE.test(fields.file_sha256))) out.file_sha256 = fields.file_sha256;
  if (fields.orig_sha256 === null || (typeof fields.orig_sha256 === 'string' && SHA_RE.test(fields.orig_sha256))) out.orig_sha256 = fields.orig_sha256;
  if (Number.isInteger(fields.file_size) && fields.file_size >= 0) out.file_size = fields.file_size;
  if (Number.isInteger(fields.page_count) && fields.page_count >= 0 && fields.page_count <= 100000) out.page_count = fields.page_count;
  if (fields.sizes !== undefined && validSizes(fields.sizes)) out.sizes = fields.sizes;
  if (fields.layout !== undefined) {
    const layout = cleanLayout(fields.layout);
    if (layout !== undefined) out.layout = layout;
  }
  if (fields.thumb === null || (typeof fields.thumb === 'string' && fields.thumb.startsWith('data:image/') && fields.thumb.length <= MAX_THUMB)) out.thumb = fields.thumb;
  if (fields.progress && typeof fields.progress === 'object' && Number.isFinite(fields.progress.page)) {
    out.progress = {
      page: Math.max(0, Math.floor(fields.progress.page)),
      offset: Number.isFinite(fields.progress.offset) ? fields.progress.offset : 0,
      pct: Number.isFinite(fields.progress.pct) ? Math.min(1, Math.max(0, fields.progress.pct)) : 0,
    };
    out.progress_at = typeof fields.progress_at === 'string' ? fields.progress_at.slice(0, 40) : new Date().toISOString();
  }
  if (Array.isArray(fields.bookmarks) && fields.bookmarks.length <= 5000) out.bookmarks = fields.bookmarks;
  if (fields.settings && typeof fields.settings === 'object' && !Array.isArray(fields.settings)) out.settings = fields.settings;
  if (fields.is_favorite !== undefined) out.is_favorite = fields.is_favorite ? 1 : 0;
  return out;
}

function insertDoc(db, userId, id, fields, clientId) {
  db.prepare(
    `INSERT INTO documents (id, user_id, title, author, kind, file_sha256, file_size, orig_sha256, page_count, sizes_json,
       layout_json, thumb, progress_json, progress_at, bookmarks_json, settings_json, is_favorite, created_at, updated_at, last_client_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW}, ${NOW}, ?)`
  ).run(
    id,
    userId,
    fields.title ?? 'Untitled',
    fields.author ?? null,
    fields.kind || 'pdf',
    fields.file_sha256 ?? null,
    fields.file_size ?? null,
    fields.orig_sha256 ?? null,
    fields.page_count ?? 0,
    JSON.stringify(fields.sizes ?? []),
    fields.layout ? JSON.stringify(fields.layout) : null,
    fields.thumb ?? null,
    fields.progress ? JSON.stringify(fields.progress) : null,
    fields.progress_at ?? null,
    JSON.stringify(mergeById([], fields.bookmarks ?? [])),
    JSON.stringify(fields.settings ?? {}),
    fields.is_favorite ?? 0,
    clientId || null
  );
  return getDoc(db, userId, id);
}

// Applies a field patch to an existing document. Returns the updated row.
function updateDoc(db, userId, current, fields, clientId) {
  const sets = [];
  const values = [];
  const set = (col, val) => {
    sets.push(`${col} = ?`);
    values.push(val);
  };
  for (const col of ['title', 'author', 'kind', 'file_sha256', 'file_size', 'orig_sha256', 'page_count', 'thumb', 'is_favorite']) {
    if (fields[col] !== undefined) set(col, fields[col]);
  }
  if (fields.sizes !== undefined) set('sizes_json', JSON.stringify(fields.sizes));
  if (fields.layout !== undefined) {
    const merged = mergeLayouts(parseJson(current.layout_json, null), fields.layout);
    set('layout_json', merged ? JSON.stringify(merged) : null);
  }
  if (fields.bookmarks !== undefined) set('bookmarks_json', JSON.stringify(mergeById(parseJson(current.bookmarks_json, []), fields.bookmarks)));
  if (fields.settings !== undefined) set('settings_json', JSON.stringify({ ...parseJson(current.settings_json, {}), ...fields.settings }));
  // Reading position: the device that read last wins (its own clock).
  if (fields.progress !== undefined && (!current.progress_at || fields.progress_at > current.progress_at)) {
    set('progress_json', JSON.stringify(fields.progress));
    set('progress_at', fields.progress_at);
  }
  if (!sets.length) return current;
  set('last_client_id', clientId || null);
  sets.push(`updated_at = ${NOW}`);
  db.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...values, current.id, userId);
  return getDoc(db, userId, current.id);
}

function setDeleted(db, userId, id, deleted) {
  db.prepare(`UPDATE documents SET is_deleted = ?, updated_at = ${NOW} WHERE id = ? AND user_id = ?`).run(deleted ? 1 : 0, id, userId);
}

function isTombstoned(db, userId, id) {
  return !!db.prepare('SELECT 1 FROM deleted_documents WHERE id = ? AND user_id = ?').get(id, userId);
}

// Deletes a document forever: its annotations and share links go with it
// (cascade), a tombstone lets other devices drop their copies, and its file is
// collected if nothing else uses it.
function purgeDoc(db, userId, id) {
  db.prepare(`INSERT OR REPLACE INTO deleted_documents (id, user_id, deleted_at) VALUES (?, ?, ${NOW})`).run(id, userId);
  db.prepare('DELETE FROM documents WHERE id = ? AND user_id = ?').run(id, userId);
  gcFiles(db, userId);
}

// ----- annotations ----------------------------------------------------------

function getAnn(db, userId, docId, pageKey) {
  return db.prepare('SELECT * FROM annotations WHERE doc_id = ? AND page_key = ? AND user_id = ?').get(docId, pageKey, userId);
}

function serializeAnn(row) {
  return {
    doc_id: row.doc_id,
    page_key: row.page_key,
    ink: parseJson(row.ink_json, { elements: [] }),
    marks: parseJson(row.marks_json, []),
    updated_at: row.updated_at,
  };
}

function cleanAnnFields(m) {
  const out = {};
  if (m.ink && typeof m.ink === 'object' && !Array.isArray(m.ink) && Array.isArray(m.ink.elements)) {
    const size = JSON.stringify(m.ink).length;
    if (size <= MAX_INK_BYTES) out.ink = m.ink;
  }
  if (Array.isArray(m.marks) && m.marks.length <= 5000) out.marks = m.marks;
  return out;
}

// Another device wrote this page's ink after the version the edit was built
// on, and what it wrote differs from what's being saved now = a real
// conflict. A device's own consecutive saves never conflict.
function hasInkConflict(current, newInkJson, baseTs, clientId) {
  if (!baseTs) return false;
  if (!current.content_updated_at || current.content_updated_at <= baseTs) return false;
  if (clientId && current.last_client_id === clientId) return false;
  return newInkJson !== current.ink_json;
}

// Applies one page's annotations. Marks always merge by id (cheap, and a
// mark added on another device must never vanish); ink merges stroke by
// stroke when another device changed the page meanwhile.
function upsertAnn(db, userId, docId, pageKey, fields, baseTs, clientId, seen) {
  const current = getAnn(db, userId, docId, pageKey);
  const result = { merged: false, stale: false };

  if (!current) {
    db.prepare(
      `INSERT INTO annotations (doc_id, page_key, user_id, ink_json, marks_json, created_at, updated_at, content_updated_at, last_client_id)
       VALUES (?, ?, ?, ?, ?, ${NOW}, ${NOW}, ${NOW}, ?)`
    ).run(
      docId,
      pageKey,
      userId,
      JSON.stringify(fields.ink ?? { elements: [] }),
      JSON.stringify(mergeById([], fields.marks ?? [])),
      clientId || null
    );
    return { ...result, row: getAnn(db, userId, docId, pageKey) };
  }

  if (!baseTs || current.updated_at > baseTs) result.stale = true;
  const sets = [];
  const values = [];
  let inkChanged = false;
  if (fields.ink !== undefined) {
    let ink = fields.ink;
    const incomingJson = JSON.stringify(ink);
    if (!seen?.has(`${docId}|${pageKey}`) && hasInkConflict(current, incomingJson, baseTs, clientId)) {
      ink = mergeScenes(parseJson(current.ink_json, null), ink);
      result.merged = true;
    }
    const json = JSON.stringify(ink);
    if (json !== current.ink_json) {
      sets.push('ink_json = ?');
      values.push(json);
      inkChanged = true;
    }
  }
  if (fields.marks !== undefined) {
    const json = JSON.stringify(mergeById(parseJson(current.marks_json, []), fields.marks));
    if (json !== current.marks_json) {
      sets.push('marks_json = ?');
      values.push(json);
      if (JSON.stringify(fields.marks) !== json) result.merged = true;
    }
  }
  if (sets.length) {
    // A merged result is nobody's own write: if the device sends another edit
    // built on its pre-merge copy, that must merge again instead of counting
    // as its own follow-up save and dropping what was merged in.
    const writer = result.merged ? null : clientId || null;
    if (inkChanged || result.merged) sets.push(`content_updated_at = ${NOW}`);
    sets.push('last_client_id = ?');
    values.push(writer);
    sets.push(`updated_at = ${NOW}`);
    db.prepare(`UPDATE annotations SET ${sets.join(', ')} WHERE doc_id = ? AND page_key = ? AND user_id = ?`).run(...values, docId, pageKey, userId);
  }
  return { ...result, row: getAnn(db, userId, docId, pageKey) };
}

module.exports = {
  PAGE_KEY_RE,
  parseJson,
  normalizeTs,
  nowTs,
  serializeDoc,
  getDoc,
  cleanDocFields,
  insertDoc,
  updateDoc,
  setDeleted,
  isTombstoned,
  purgeDoc,
  getAnn,
  serializeAnn,
  cleanAnnFields,
  upsertAnn,
};
