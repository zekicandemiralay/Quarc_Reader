// End-to-end tests for the Reader API against a real (temporary) SQLite
// database and data folder: library + annotation sync, lossless merging,
// resumable file uploads, ownership, and share links. Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quarc-reader-test-'));
process.env.DATA_DIR = tmp;
process.env.DB_PATH = path.join(tmp, 'reader.db');
process.env.JWT_SECRET = 'test-secret';

const { initDb, getDb } = require('../src/db');
const { createApp } = require('../src/index');
const { mergeById, mergeLayouts, mergeScenes } = require('../src/services/merge');

let server;
let base;
const tokenA = jwt.sign({ id: 'user-a', username: 'alice' }, 'test-secret', { expiresIn: '1h' });
const tokenB = jwt.sign({ id: 'user-b', username: 'bob' }, 'test-secret', { expiresIn: '1h' });

async function api(method, url, body, token = tokenA) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Cookie: `token=${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const push = (mutations, client = 'device-1', token) => api('POST', '/api/sync/push', { client_id: client, mutations }, token);
const pull = (since = '', token, limit) => api('GET', `/api/sync/pull?since=${encodeURIComponent(since)}${limit ? `&limit=${limit}` : ''}`, undefined, token);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function putChunk(hash, buf, offset, total, token = tokenA) {
  const res = await fetch(`${base}/api/files/${hash}?offset=${offset}&total=${total}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', Cookie: `token=${token}` },
    body: buf,
  });
  return { status: res.status, body: await res.json() };
}

async function upload(buf, token = tokenA, chunk = 4096) {
  const hash = sha(buf);
  let offset = 0;
  let last;
  while (offset < buf.length) {
    last = await putChunk(hash, buf.subarray(offset, offset + chunk), offset, buf.length, token);
    offset += chunk;
  }
  return { hash, last };
}

const el = (id, version, extra = {}) => ({ id, type: 'freedraw', version, versionNonce: version * 7, isDeleted: false, ...extra });
const pdfBytes = (n, seed = 1) => Buffer.alloc(n, `%PDF-1.4 fake ${seed} `);

before(async () => {
  initDb();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  getDb().close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

test('requires a login for the library, files and sync', async () => {
  assert.equal((await api('GET', '/api/sync/pull', undefined, null)).status, 401);
  assert.equal((await api('GET', '/api/files/usage', undefined, null)).status, 401);
  assert.equal((await api('POST', '/api/shares', {}, null)).status, 401);
  assert.equal((await api('GET', '/api/health', undefined, null)).status, 200);
});

test('creates a document through sync and pulls it back', async () => {
  const r = await push([{ kind: 'doc', id: 'doc-1', fields: { title: 'Moby Dick', author: 'Melville', page_count: 3, sizes: [[3, 595, 842]] } }]);
  assert.equal(r.status, 200);
  assert.equal(r.body.results[0].status, 'ok');
  assert.equal(r.body.results[0].key, 'd:doc-1');
  assert.match(r.body.results[0].updated_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/);

  const p = await pull();
  const doc = p.body.docs.find((d) => d.id === 'doc-1');
  assert.equal(doc.title, 'Moby Dick');
  assert.deepEqual(doc.sizes, [[3, 595, 842]]);
  assert.equal(doc.file_ready, false);
  assert.deepEqual(p.body.deleted, []);
  assert.equal(p.body.more, false);
});

test('drops malformed or oversized fields instead of storing them', async () => {
  await push([
    {
      kind: 'doc',
      id: 'doc-clean',
      fields: {
        title: 'x'.repeat(2000),
        file_sha256: 'not-a-hash',
        sizes: [[0, 1, 1]],
        thumb: 'javascript:alert(1)',
        layout: [{ t: 'zzz' }],
        page_count: -4,
        bogus: 'field',
      },
    },
  ]);
  const doc = (await pull()).body.docs.find((d) => d.id === 'doc-clean');
  assert.equal(doc.title.length, 500);
  assert.equal(doc.file_sha256, null);
  assert.deepEqual(doc.sizes, []);
  assert.equal(doc.thumb, null);
  assert.equal(doc.layout, null);
  assert.equal(doc.page_count, 0);
  assert.equal(doc.bogus, undefined);
});

test('rejects invalid ids, and another user cannot touch your document', async () => {
  const bad = await push([{ kind: 'doc', id: '../../etc', fields: { title: 'x' } }]);
  assert.equal(bad.body.results[0].status, 'error');

  await push([{ kind: 'doc', id: 'alice-only', fields: { title: 'Private' } }]);
  const hijack = await push([{ kind: 'doc', id: 'alice-only', fields: { title: 'Mine now' } }], 'dev-b', tokenB);
  assert.equal(hijack.body.results[0].error, 'forbidden');
  const annHijack = await push([{ kind: 'ann', doc_id: 'alice-only', page_key: 'p0', ink: { elements: [el('e', 1)] } }], 'dev-b', tokenB);
  assert.equal(annHijack.body.results[0].status, 'error');
  assert.equal((await pull('', tokenB)).body.docs.length, 0);
  assert.equal((await pull()).body.docs.find((d) => d.id === 'alice-only').title, 'Private');
});

// ----- files -----------------------------------------------------------------

test('uploads a file in chunks, resumes after an interruption, and serves it with Range', async () => {
  const buf = pdfBytes(10000, 2);
  const hash = sha(buf);
  await push([{ kind: 'doc', id: 'doc-file', fields: { title: 'Upload me', file_sha256: hash, file_size: buf.length } }]);
  const before = (await pull()).body.docs.find((d) => d.id === 'doc-file');
  assert.equal(before.file_ready, false);

  assert.deepEqual((await api('GET', `/api/files/${hash}/status`)).body, { exists: false, received: 0 });
  assert.equal((await putChunk(hash, buf.subarray(0, 4000), 0, buf.length)).body.received, 4000);
  // "Connection drops": the client asks where it is and continues from there.
  assert.equal((await api('GET', `/api/files/${hash}/status`)).body.received, 4000);
  const wrong = await putChunk(hash, buf.subarray(5000, 9000), 5000, buf.length);
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.received, 4000);
  assert.equal((await putChunk(hash, buf.subarray(4000, 8000), 4000, buf.length)).body.received, 8000);
  assert.equal((await putChunk(hash, buf.subarray(8000), 8000, buf.length)).body.exists, true);
  assert.equal((await api('GET', `/api/files/${hash}/status`)).body.exists, true);

  // Other devices learn the file is ready from their next pull.
  const after = (await pull(before.updated_at)).body.docs.find((d) => d.id === 'doc-file');
  assert.equal(after.file_ready, true);

  const full = await fetch(`${base}/api/files/${hash}`, { headers: { Cookie: `token=${tokenA}` } });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'application/pdf');
  assert.equal(sha(Buffer.from(await full.arrayBuffer())), hash);
  const part = await fetch(`${base}/api/files/${hash}`, { headers: { Cookie: `token=${tokenA}`, Range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), buf.subarray(100, 200));
  assert.ok((await api('GET', '/api/files/usage')).body.bytes >= buf.length);
});

test('discards an upload whose bytes do not match the hash in the URL', async () => {
  const buf = pdfBytes(3000, 3);
  const wrongHash = sha(pdfBytes(3000, 99));
  const r = await putChunk(wrongHash, buf, 0, buf.length);
  assert.equal(r.status, 422);
  assert.deepEqual((await api('GET', `/api/files/${wrongHash}/status`)).body, { exists: false, received: 0 });
});

test('refuses more data than declared and files over the size limit', async () => {
  const buf = pdfBytes(2000, 4);
  const hash = sha(buf);
  assert.equal((await putChunk(hash, buf, 0, 1000)).status, 413);
  assert.equal((await putChunk(hash, buf, 0, 5 * 1024 * 1024 * 1024)).status, 413);
  assert.equal((await putChunk('zzz', buf, 0, 2000)).status, 400);
});

test('an optional per-account storage limit stops a new upload that would exceed it', async () => {
  const used = (await api('GET', '/api/files/usage', undefined, tokenB)).body.bytes;
  process.env.MAX_USER_BYTES = String(used + 4000);
  try {
    const fits = pdfBytes(3000, 41);
    assert.equal((await putChunk(sha(fits), fits, 0, fits.length, tokenB)).body.exists, true);
    const tooMuch = pdfBytes(3000, 42);
    const r = await putChunk(sha(tooMuch), tooMuch, 0, tooMuch.length, tokenB);
    assert.equal(r.status, 413);
    assert.equal(r.body.error, 'storage limit reached');
    // The limit is counted per account: with a limit that fits ALICE's own usage, the same file goes through for her.
    const aliceUsed = (await api('GET', '/api/files/usage', undefined, tokenA)).body.bytes;
    process.env.MAX_USER_BYTES = String(aliceUsed + 10000);
    assert.equal((await putChunk(sha(tooMuch), tooMuch, 0, tooMuch.length, tokenA)).body.exists, true);
  } finally {
    delete process.env.MAX_USER_BYTES;
  }
});

test("files are per user: another user cannot read yours, and re-uploading is separate", async () => {
  const { hash } = await upload(pdfBytes(5000, 5));
  const asB = await fetch(`${base}/api/files/${hash}`, { headers: { Cookie: `token=${tokenB}` } });
  assert.equal(asB.status, 404);
  assert.equal((await api('GET', `/api/files/${hash}/status`, undefined, tokenB)).body.exists, false);
});

// ----- annotations -----------------------------------------------------------

test('syncs a page of ink and marks, and pulls it back', async () => {
  await push([{ kind: 'doc', id: 'doc-ann', fields: { title: 'Annotated', page_count: 2 } }]);
  const r = await push([
    {
      kind: 'ann',
      doc_id: 'doc-ann',
      page_key: 'p0',
      ink: { elements: [el('s1', 1), el('s2', 1)] },
      marks: [{ id: 'm1', u: 10, type: 'hl', color: '#ffd43b', text: 'call me Ishmael', quads: [[0, 0, 10, 0, 0, 10, 10, 10]] }],
    },
  ]);
  assert.equal(r.body.results[0].status, 'ok');
  assert.equal(r.body.results[0].key, 'a:doc-ann:p0');
  const ann = (await pull()).body.anns.find((a) => a.doc_id === 'doc-ann' && a.page_key === 'p0');
  assert.equal(ann.ink.elements.length, 2);
  assert.equal(ann.marks[0].text, 'call me Ishmael');
});

test('rejects bad page keys and annotations for unknown documents', async () => {
  const badKey = await push([{ kind: 'ann', doc_id: 'doc-ann', page_key: '../x', ink: { elements: [] } }]);
  assert.equal(badKey.body.results[0].status, 'error');
  const noDoc = await push([{ kind: 'ann', doc_id: 'ghost-doc', page_key: 'p0', ink: { elements: [] } }]);
  assert.equal(noDoc.body.results[0].status, 'error');
});

test('annotations pushed in the same batch as their (new) document are accepted', async () => {
  const r = await push([
    { kind: 'ann', doc_id: 'doc-batch', page_key: 'p0', ink: { elements: [el('b1', 1)] } },
    { kind: 'doc', id: 'doc-batch', fields: { title: 'Batch', page_count: 1 } },
  ]);
  assert.ok(r.body.results.every((x) => x.status === 'ok'));
});

test('two devices drawing on the same page offline keep every stroke', async () => {
  await push([{ kind: 'doc', id: 'doc-merge', fields: { title: 'Merge', page_count: 1 } }]);
  const first = await push([{ kind: 'ann', doc_id: 'doc-merge', page_key: 'p0', ink: { elements: [el('base', 1)] } }], 'dev-1');
  const base0 = first.body.results[0].updated_at;
  await sleep(5);
  // Device 1 draws another stroke…
  await push([{ kind: 'ann', doc_id: 'doc-merge', page_key: 'p0', base_updated_at: base0, ink: { elements: [el('base', 1), el('from-1', 1)] } }], 'dev-1');
  await sleep(5);
  // …and device 2, offline all along, drew on the version it had.
  const r = await push([{ kind: 'ann', doc_id: 'doc-merge', page_key: 'p0', base_updated_at: base0, ink: { elements: [el('base', 1), el('from-2', 1)] } }], 'dev-2');
  assert.equal(r.body.results[0].status, 'ok');
  assert.ok(r.body.results[0].ann, 'the merged page is sent back to the device');
  const ids = r.body.results[0].ann.ink.elements.map((e) => e.id).sort();
  assert.deepEqual(ids, ['base', 'from-1', 'from-2']);
  const stored = (await pull()).body.anns.find((a) => a.doc_id === 'doc-merge');
  assert.deepEqual(stored.ink.elements.map((e) => e.id).sort(), ['base', 'from-1', 'from-2']);
});

test("a device's own consecutive saves never count as a conflict", async () => {
  await push([{ kind: 'doc', id: 'doc-own', fields: { title: 'Own', page_count: 1 } }]);
  const a = await push([{ kind: 'ann', doc_id: 'doc-own', page_key: 'p0', ink: { elements: [el('x', 1)] } }], 'dev-1');
  const base0 = a.body.results[0].updated_at;
  await sleep(5);
  await push([{ kind: 'ann', doc_id: 'doc-own', page_key: 'p0', base_updated_at: base0, ink: { elements: [el('x', 1), el('y', 1)] } }], 'dev-1');
  // The device erases stroke y, still building on the old base: must replace, not resurrect y.
  const r = await push([{ kind: 'ann', doc_id: 'doc-own', page_key: 'p0', base_updated_at: base0, ink: { elements: [el('x', 1), el('y', 2, { isDeleted: true })] } }], 'dev-1');
  assert.equal(r.body.results[0].status, 'ok');
  const stored = (await pull()).body.anns.find((a2) => a2.doc_id === 'doc-own');
  assert.equal(stored.ink.elements.find((e) => e.id === 'y').isDeleted, true);
});

test('text highlights and notes merge by id; deletions propagate; the newer edit wins', async () => {
  // `u` is the device's clock in ms, like in the app (tombstones older than 30 days are dropped).
  const t = Date.now();
  await push([{ kind: 'doc', id: 'doc-marks', fields: { title: 'Marks', page_count: 1 } }]);
  await push([{ kind: 'ann', doc_id: 'doc-marks', page_key: 'p0', marks: [{ id: 'a', u: t + 10, note: 'first' }] }], 'dev-1');
  // Another device adds one, and edits "a" later.
  const r = await push([{ kind: 'ann', doc_id: 'doc-marks', page_key: 'p0', marks: [{ id: 'a', u: t + 20, note: 'edited' }, { id: 'b', u: t + 15 }] }], 'dev-2');
  assert.equal(r.body.results[0].status, 'ok');
  // A stale device re-sends the old "a" and deletes nothing: it must not undo the edit.
  await push([{ kind: 'ann', doc_id: 'doc-marks', page_key: 'p0', marks: [{ id: 'a', u: t + 10, note: 'first' }] }], 'dev-1');
  let marks = (await pull()).body.anns.find((a2) => a2.doc_id === 'doc-marks').marks;
  assert.equal(marks.find((m) => m.id === 'a').note, 'edited');
  assert.ok(marks.find((m) => m.id === 'b'));
  // Deleting is a newer tombstone.
  await push([{ kind: 'ann', doc_id: 'doc-marks', page_key: 'p0', marks: [{ id: 'b', u: t + 30, del: true }] }], 'dev-1');
  marks = (await pull()).body.anns.find((a2) => a2.doc_id === 'doc-marks').marks;
  assert.equal(marks.find((m) => m.id === 'b').del, true);
});

// ----- layout, progress, bookmarks --------------------------------------------

test('note pages inserted on two devices both survive; deleting one propagates', async () => {
  await push([{ kind: 'doc', id: 'doc-layout', fields: { title: 'Layout', page_count: 2 } }]);
  const pagesOf = (...extra) => [{ t: 'p', i: 0 }, ...extra, { t: 'p', i: 1 }];
  const noteA = { t: 'n', id: 'note-aaaa', w: 595, h: 842, s: 'lined', u: 100 };
  const noteB = { t: 'n', id: 'note-bbbb', w: 595, h: 842, s: 'dotted', u: 110 };
  await push([{ kind: 'doc', id: 'doc-layout', fields: { layout: pagesOf(noteA) } }], 'dev-1');
  // Device 2 never saw noteA and inserted its own page after page 1.
  const r = await push([{ kind: 'doc', id: 'doc-layout', fields: { layout: [{ t: 'p', i: 0 }, { t: 'p', i: 1 }, noteB] } }], 'dev-2');
  const keys = r.body.results[0].doc.layout.map((it) => (it.t === 'p' ? `p${it.i}` : it.id));
  assert.deepEqual(keys, ['p0', 'note-aaaa', 'p1', 'note-bbbb']);
  // A newer tombstone wins over a stale live copy.
  const deleted = { ...noteA, u: 200, del: true };
  await push([{ kind: 'doc', id: 'doc-layout', fields: { layout: [{ t: 'p', i: 0 }, deleted, { t: 'p', i: 1 }, noteB] } }], 'dev-1');
  await push([{ kind: 'doc', id: 'doc-layout', fields: { layout: [{ t: 'p', i: 0 }, noteA, { t: 'p', i: 1 }, noteB] } }], 'dev-2');
  const doc = (await pull()).body.docs.find((d) => d.id === 'doc-layout');
  assert.equal(doc.layout.find((it) => it.id === 'note-aaaa').del, true);
});

test('reading progress: the device that read last wins, not the one that synced last', async () => {
  await push([{ kind: 'doc', id: 'doc-prog', fields: { title: 'Prog', page_count: 100 } }]);
  await push([{ kind: 'doc', id: 'doc-prog', fields: { progress: { page: 40, offset: 0.2, pct: 0.4 }, progress_at: '2026-11-22T12:00:00.000Z' } }], 'phone');
  // The tablet read page 10 earlier in the day but only synced now.
  await push([{ kind: 'doc', id: 'doc-prog', fields: { progress: { page: 10, offset: 0, pct: 0.1 }, progress_at: '2026-11-22T08:00:00.000Z' } }], 'tablet');
  let doc = (await pull()).body.docs.find((d) => d.id === 'doc-prog');
  assert.equal(doc.progress.page, 40);
  await push([{ kind: 'doc', id: 'doc-prog', fields: { progress: { page: 55, offset: 0.5, pct: 0.55 }, progress_at: '2026-11-22T13:00:00.000Z' } }], 'tablet');
  doc = (await pull()).body.docs.find((d) => d.id === 'doc-prog');
  assert.equal(doc.progress.page, 55);
});

test('bookmarks from two devices merge', async () => {
  await push([{ kind: 'doc', id: 'doc-bm', fields: { title: 'BM', page_count: 9 } }]);
  await push([{ kind: 'doc', id: 'doc-bm', fields: { bookmarks: [{ id: 'b1', u: 1, page: 3 }] } }], 'dev-1');
  await push([{ kind: 'doc', id: 'doc-bm', fields: { bookmarks: [{ id: 'b2', u: 2, page: 5 }] } }], 'dev-2');
  const doc = (await pull()).body.docs.find((d) => d.id === 'doc-bm');
  assert.deepEqual(doc.bookmarks.map((b) => b.id).sort(), ['b1', 'b2']);
});

// ----- trash, purge, replace ----------------------------------------------------

test('trash and restore keep the document and its annotations', async () => {
  await push([{ kind: 'doc', id: 'doc-trash', fields: { title: 'T', page_count: 1 } }]);
  await push([{ kind: 'ann', doc_id: 'doc-trash', page_key: 'p0', ink: { elements: [el('t1', 1)] } }]);
  await push([{ kind: 'doc', id: 'doc-trash', deleted: true }]);
  assert.equal((await pull()).body.docs.find((d) => d.id === 'doc-trash').is_deleted, 1);
  const r = await push([{ kind: 'doc', id: 'doc-trash', deleted: false }]);
  assert.equal(r.body.results[0].doc.is_deleted, 0);
  assert.equal((await pull()).body.anns.find((a) => a.doc_id === 'doc-trash').ink.elements.length, 1);
});

test('deleting forever removes annotations and file, tells other devices, and blocks resurrection', async () => {
  const buf = pdfBytes(4000, 6);
  const { hash } = await upload(buf);
  await push([{ kind: 'doc', id: 'doc-purge', fields: { title: 'Purge', file_sha256: hash, file_size: buf.length, page_count: 1 } }]);
  await push([{ kind: 'ann', doc_id: 'doc-purge', page_key: 'p0', ink: { elements: [el('p1', 1)] } }]);
  // The file is only collected once it is older than the grace period.
  getDb().prepare("UPDATE files SET created_at = '2020-01-01 00:00:00.000' WHERE sha256 = ?").run(hash);

  const before = (await pull()).body.serverTime;
  const r = await push([{ kind: 'doc', id: 'doc-purge', purge: true }]);
  assert.equal(r.body.results[0].purged, true);
  const p = await pull(before);
  assert.ok(p.body.deleted.includes('doc-purge'));
  assert.equal((await pull()).body.anns.some((a) => a.doc_id === 'doc-purge'), false);
  assert.equal((await api('GET', `/api/files/${hash}/status`)).body.exists, false);
  assert.equal((await push([{ kind: 'doc', id: 'doc-purge', fields: { title: 'Back from the dead' } }])).body.results[0].status, 'gone');
});

test('replacing the original keeps the old file as a safety net until reverted', async () => {
  const original = pdfBytes(3000, 7);
  const annotated = pdfBytes(3500, 8);
  const a = await upload(original);
  const b = await upload(annotated);
  await push([{ kind: 'doc', id: 'doc-repl', fields: { title: 'Repl', file_sha256: a.hash, file_size: original.length, page_count: 1 } }]);
  await push([{ kind: 'doc', id: 'doc-repl', fields: { file_sha256: b.hash, file_size: annotated.length, orig_sha256: a.hash } }]);
  getDb().prepare("UPDATE files SET created_at = '2020-01-01 00:00:00.000'").run();
  await push([{ kind: 'doc', id: 'doc-repl', fields: { title: 'Repl 2' } }]);
  // A later edit that touches the files runs the collector: both are still referenced.
  await push([{ kind: 'doc', id: 'doc-repl', fields: { orig_sha256: a.hash } }]);
  assert.equal((await api('GET', `/api/files/${a.hash}/status`)).body.exists, true);
  assert.equal((await api('GET', `/api/files/${b.hash}/status`)).body.exists, true);
  // Revert: the annotated copy is no longer referenced and is collected.
  await push([{ kind: 'doc', id: 'doc-repl', fields: { file_sha256: a.hash, file_size: original.length, orig_sha256: null } }]);
  assert.equal((await api('GET', `/api/files/${a.hash}/status`)).body.exists, true);
  assert.equal((await api('GET', `/api/files/${b.hash}/status`)).body.exists, false);
});

// ----- sync paging -------------------------------------------------------------

test('a big pull is split into pages and the cursor always moves forward', async () => {
  const drain = async (docId, token, limit) => {
    const seen = new Set();
    let since = '';
    let rounds = 0;
    for (;;) {
      const r = (await pull(since, token, limit)).body;
      rounds++;
      for (const a of r.anns) if (a.doc_id === docId) seen.add(a.page_key);
      since = r.until;
      if (!r.more) break;
      assert.ok(rounds < 30, 'the cursor must keep advancing');
    }
    return { seen, rounds };
  };

  // Written one at a time, a few ms apart: split into several pulls.
  await push([{ kind: 'doc', id: 'doc-big', fields: { title: 'Big', page_count: 60 } }], 'dev-big', tokenB);
  for (let i = 0; i < 25; i++) {
    await push([{ kind: 'ann', doc_id: 'doc-big', page_key: `p${i}`, ink: { elements: [el(`e${i}`, 1)] } }], 'dev-big', tokenB);
    await sleep(3);
  }
  const spread = await drain('doc-big', tokenB, 10);
  assert.equal(spread.seen.size, 25);
  assert.ok(spread.rounds >= 3, `expected several pulls, got ${spread.rounds}`);

  // Written in ONE push (so many rows share a millisecond, e.g. when someone
  // turns on sync for a book they annotated offline): still all delivered.
  await push([{ kind: 'doc', id: 'doc-burst', fields: { title: 'Burst', page_count: 60 } }], 'dev-big', tokenB);
  const burst = [];
  for (let i = 0; i < 40; i++) burst.push({ kind: 'ann', doc_id: 'doc-burst', page_key: `p${i}`, ink: { elements: [el(`b${i}`, 1)] } });
  await push(burst, 'dev-big', tokenB);
  assert.equal((await drain('doc-burst', tokenB, 5)).seen.size, 40);
});

// ----- share links -------------------------------------------------------------

test('share link: needs a finished upload, readable without login, can include annotations, can be revoked', async () => {
  const buf = pdfBytes(6000, 9);
  const hash = sha(buf);
  await push([{ kind: 'doc', id: 'doc-share', fields: { title: 'Shared book', author: 'Me', file_sha256: hash, file_size: buf.length, page_count: 2, sizes: [[2, 595, 842]] } }]);
  await push([{ kind: 'ann', doc_id: 'doc-share', page_key: 'p0', ink: { elements: [el('sh1', 1)] }, marks: [{ id: 'sm', u: 1, type: 'hl', text: 'mine' }] }]);

  // Not uploaded yet.
  assert.equal((await api('POST', '/api/shares', { doc_id: 'doc-share' })).status, 409);
  // Not yours.
  assert.equal((await api('POST', '/api/shares', { doc_id: 'doc-share' }, tokenB)).status, 404);
  await upload(buf);

  const plain = await api('POST', '/api/shares', { doc_id: 'doc-share' });
  assert.equal(plain.status, 201);
  assert.ok(plain.body.token.length >= 30);
  const withInk = await api('POST', '/api/shares', { doc_id: 'doc-share', include_annotations: true });

  // No cookie at all: anyone with the link can read it.
  const pub = await api('GET', `/api/public/shares/${plain.body.token}`, undefined, null);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.title, 'Shared book');
  assert.deepEqual(pub.body.annotations, []);
  const pubInk = await api('GET', `/api/public/shares/${withInk.body.token}`, undefined, null);
  assert.equal(pubInk.body.annotations.length, 1);
  assert.equal(pubInk.body.annotations[0].marks[0].text, 'mine');

  const file = await fetch(`${base}/api/public/shares/${plain.body.token}/file`);
  assert.equal(file.status, 200);
  assert.equal(sha(Buffer.from(await file.arrayBuffer())), hash);

  // Guessing doesn't work.
  assert.equal((await api('GET', '/api/public/shares/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', undefined, null)).status, 404);

  // The owner sees views; revoking turns it off.
  assert.equal((await api('GET', '/api/shares?doc_id=doc-share')).body.find((s) => s.token === plain.body.token).views, 1);
  assert.equal((await api('DELETE', `/api/shares/${plain.body.token}`, undefined, tokenB)).status, 404);
  assert.equal((await api('DELETE', `/api/shares/${plain.body.token}`)).status, 200);
  assert.equal((await api('GET', `/api/public/shares/${plain.body.token}`, undefined, null)).status, 404);
  assert.equal((await fetch(`${base}/api/public/shares/${plain.body.token}/file`)).status, 404);
});

test('share link: expiry, trashed documents, and adding a shared document to your own library', async () => {
  const buf = pdfBytes(5000, 10);
  const { hash } = await upload(buf);
  await push([{ kind: 'doc', id: 'doc-share2', fields: { title: 'Sharable', file_sha256: hash, file_size: buf.length, page_count: 1, sizes: [[1, 595, 842]] } }]);
  await push([{ kind: 'ann', doc_id: 'doc-share2', page_key: 'p0', ink: { elements: [el('q1', 1)] } }]);

  const expiring = (await api('POST', '/api/shares', { doc_id: 'doc-share2', expires_days: 1 })).body;
  assert.ok(expiring.expires_at);
  getDb().prepare("UPDATE shares SET expires_at = '2020-01-01 00:00:00.000' WHERE token = ?").run(expiring.token);
  assert.equal((await api('GET', `/api/public/shares/${expiring.token}`, undefined, null)).status, 404);

  const link = (await api('POST', '/api/shares', { doc_id: 'doc-share2', include_annotations: true })).body;
  const imported = await api('POST', `/api/shares/${link.token}/import`, { client_id: 'dev-b' }, tokenB);
  assert.equal(imported.status, 201);
  const copy = imported.body.doc;
  assert.notEqual(copy.id, 'doc-share2');
  assert.equal(copy.title, 'Sharable');
  assert.equal(copy.file_ready, true);
  // Bob now has the file and Alice's annotations — as his own copy.
  const mine = await pull('', tokenB);
  assert.ok(mine.body.docs.some((d) => d.id === copy.id));
  assert.equal(mine.body.anns.find((a) => a.doc_id === copy.id).ink.elements[0].id, 'q1');
  assert.equal((await fetch(`${base}/api/files/${hash}`, { headers: { Cookie: `token=${tokenB}` } })).status, 200);
  // Importing needs an account.
  assert.equal((await api('POST', `/api/shares/${link.token}/import`, {}, null)).status, 401);

  // Trashing the document turns the link off.
  await push([{ kind: 'doc', id: 'doc-share2', deleted: true }]);
  assert.equal((await api('GET', `/api/public/shares/${link.token}`, undefined, null)).status, 404);
  assert.equal((await api('POST', `/api/shares/${link.token}/import`, {}, tokenB)).status, 404);
});

// ----- merge helpers (pure) ----------------------------------------------------

test('mergeById: newer wins, ties keep the server copy, old tombstones are dropped', () => {
  const now = Date.now();
  const merged = mergeById(
    [{ id: 'a', u: 5, v: 'server' }, { id: 'old', u: now - 40 * 24 * 3600 * 1000, del: true }, { id: 'fresh', u: now, del: true }],
    [{ id: 'a', u: 5, v: 'client' }, { id: 'b', u: 1 }],
    now
  );
  assert.equal(merged.find((m) => m.id === 'a').v, 'server');
  assert.ok(merged.find((m) => m.id === 'b'));
  assert.equal(merged.find((m) => m.id === 'old'), undefined);
  assert.ok(merged.find((m) => m.id === 'fresh'));
});

test('mergeLayouts: client order wins, server-only note pages slot in after their neighbour', () => {
  const p = (i) => ({ t: 'p', i });
  const n = (id, u = 1) => ({ t: 'n', id, u });
  const out = mergeLayouts([p(0), n('x'), p(1), n('y')], [p(0), p(1), n('z')]);
  assert.deepEqual(out.map((it) => (it.t === 'p' ? `p${it.i}` : it.id)), ['p0', 'x', 'p1', 'y', 'z']);
  assert.equal(mergeLayouts(null, [p(0)]).length, 1);
  assert.equal(mergeLayouts([p(0)], undefined).length, 1);
});

test('mergeScenes: higher version wins per element, deletions included', () => {
  const merged = mergeScenes({ elements: [el('a', 1), el('b', 2)] }, { elements: [el('a', 2, { isDeleted: true }), el('c', 1)] });
  assert.equal(merged.elements.find((e) => e.id === 'a').isDeleted, true);
  assert.equal(merged.elements.length, 3);
});
