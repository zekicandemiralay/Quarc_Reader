// Browser tests: the real backend + the production build + headless Chrome.
// Run: npm run build (in ../frontend), then npm test (here). Screenshots go to
// $E2E_OUT (default: the OS temp dir) so a failure can be looked at.
import { readFileSync } from 'node:fs';
import {
  startStack,
  stopStack,
  launch,
  BASE,
  ROOT,
  PORTS,
  check,
  section,
  summary,
  makeTestPdf,
  writePdf,
  login,
  dumpDb,
  shot,
  paperStats,
  inkPixels,
  RED,
  lightMode,
  testDefaults,
  drawStroke,
  waitUntil,
  sleep,
  OUT,
} from './harness.mjs';

const only = process.argv[2]; // optional: run a single scenario by name

async function main() {
  console.log(`output: ${OUT}`);
  const stack = await startStack();
  const browser = await launch();
  const state = {
    dataDir: stack.data, // the backend's data folder (the uploaded PDFs are in files/<user>/<sha256>)
    pdfPath: writePdf('test.pdf', await makeTestPdf()),
    bigPdfPath: writePdf('test-big.pdf', await makeTestPdf({ junkBytes: 6 * 1024 * 1024 })),
    linksPdfPath: writePdf('test-links.pdf', await makeTestPdf({ links: true })),
  };

  try {
    const scenarios = [
      ['local', scenarioLocal],
      ['cloud', scenarioCloud],
      ['marks', scenarioMarks],
      ['export', scenarioExport],
      ['share', scenarioShare],
      ['reading', scenarioReading],
      ['style', scenarioStyle],
      ['openwith', scenarioOpenWith],
      ['find', scenarioFind],
      ['mime', scenarioMime],
      ['errors', scenarioErrors],
      ['awake', scenarioAwake],
      ['dock', scenarioDock],
      ['snip', scenarioSnip],
      ['pen', scenarioPen],
      ['tools', scenarioTools],
      ['undo', scenarioUndo],
      ['links', scenarioLinks],
      ['hand', scenarioHand],
      ['library', scenarioLibrary],
      ['big', scenarioBig],
    ];
    for (const [name, fn] of scenarios) {
      if (only && only !== name) continue;
      try {
        await fn(browser, state);
      } catch (err) {
        // One scenario that throws (a timeout, a missing element) must not hide the others: it counts as a failed check.
        console.error(err);
        check(`scenario "${name}" ran to the end`, false, String(err?.message || err).split('\n')[0]);
      }
    }
  } finally {
    await browser.close();
    stopStack();
  }
  process.exit(summary() ? 1 : 0);
}

// --------------------------------------------------------------------------------------------------

async function scenarioLocal(browser, state) {
  section('A PDF kept on this device only');
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await testDefaults(page);
  const requests = [];
  const errors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  await login(page);
  await page.waitForSelector('text/Your library is empty', { timeout: 10000 }).catch(() => {});
  check('library opens empty after login', (await page.content()).includes('Your library is empty'));
  await shot(page, '01-library-empty');

  // Add a PDF: the app must ASK where it should live.
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('header button:has(svg.lucide-plus)').catch(() => page.evaluate(() => document.querySelector('header button.bg-accent')?.click()))]);
  await chooser.accept([state.pdfPath]);
  await page.waitForSelector('div[class*="z-[1100]"] [role=dialog]', { timeout: 15000 });
  const dialogText = await page.$eval('div[class*="z-[1100]"] [role=dialog]', (el) => el.innerText);
  check('adding a PDF asks local vs sync', /device only/i.test(dialogText) && /Sync with my server/i.test(dialogText), dialogText);
  await shot(page, '02-import-dialog');

  const before = requests.length;
  await page.evaluate(() => [...document.querySelectorAll('div[class*="z-[1100]"] [role=dialog] button')].find((b) => /device only/i.test(b.innerText))?.click());
  await page.waitForFunction(() => location.pathname.startsWith('/read/'), { timeout: 30000 });
  check('after choosing, the document opens in the reader', true);

  await waitUntil(async () => (await paperStats(page))?.dark > 500, { timeout: 30000, label: 'the PDF page to be drawn on the paper canvas' });
  const stats = await paperStats(page);
  check('the PDF is drawn on the paper (text pixels present)', stats.dark > 500, JSON.stringify(stats));
  await sleep(600);
  await shot(page, '03-reader');

  const idx = await page.$eval('.quarc-canvas-page', (el) => el.parentElement.innerText);
  check('page indicator shows 1 / 3', /1\s*\/\s*3/.test(idx), idx.slice(0, 200));

  const db = await dumpDb(page);
  check('the document is stored locally as local-only', db.docs?.length === 1 && db.docs[0].sync === 'local', JSON.stringify(db.docs?.map((d) => d.sync)));
  check('title and author were read from the PDF', db.docs[0].title === 'Moby Dick (test)' && db.docs[0].author === 'H. Melville', `${db.docs[0].title} / ${db.docs[0].author}`);
  check('page count and sizes were measured', db.docs[0].page_count === 3 && JSON.stringify(db.docs[0].sizes) === '[[3,595,842]]', JSON.stringify(db.docs[0].sizes));
  check('a cover thumbnail was made', typeof db.docs[0].thumb === 'string' && db.docs[0].thumb.startsWith('data:image/jpeg'));
  check('the file itself is stored on the device', db.blobs?.length === 1);

  // Privacy: nothing about this document may have left the device.
  await sleep(2500);
  // (A GET /api/sync/pull is only the catch-up for documents synced from elsewhere; it says nothing about local ones.)
  const leaked = requests.filter((u) => /\/api\/(files|shares)|\/api\/sync\/push/.test(u));
  check('a local-only document makes no push, file or share requests', leaked.length === 0, leaked.join('\n'));
  check('and nothing is queued to send', (db.outbox || []).length === 0);

  // ----- writing on it -----
  await lightMode(page);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitUntil(async () => (await paperStats(page))?.dark > 500, { timeout: 30000, label: 'the page to draw again after a reload' });
  await sleep(500);
  await shot(page, '04-reader-light');

  const redBefore = await inkPixels(page, RED);
  await page.click('button[aria-label="#e03131"]');
  const box = await page.$eval('.quarc-canvas-page', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await drawStroke(page, { x: box.x + 200, y: box.y + 420 }, { x: box.x + 600, y: box.y + 430 });
  await sleep(1500);
  const redAfter = await inkPixels(page, RED);
  check('a pen stroke shows up as red ink on the page', redAfter > redBefore + 200, `${redBefore} -> ${redAfter}`);

  let rows = (await dumpDb(page)).ann || [];
  check('the stroke is stored for page 1 only', rows.length === 1 && rows[0].page_key === 'p0', JSON.stringify(rows.map((r) => r.page_key)));
  const ink = JSON.parse(rows[0]?.ink_json || '{"elements":[]}');
  const el = ink.elements[0];
  check('it is a freehand element in PAGE-LOCAL coordinates', el?.type === 'freedraw' && el.x > 0 && el.x < 794 && el.y > 0 && el.y < 1123, JSON.stringify(el && { x: el.x, y: el.y, type: el.type }));
  check('still nothing queued for a local-only document', (await dumpDb(page)).outbox.length === 0);

  // reload: the ink must come back
  await page.reload({ waitUntil: 'networkidle0' });
  await waitUntil(async () => (await paperStats(page))?.dark > 500, { timeout: 30000, label: 'reader after reload' });
  await sleep(800);
  const redReloaded = await inkPixels(page, RED);
  check('after a reload the ink is still there', redReloaded > redBefore + 200, `${redReloaded}`);
  await shot(page, '05-ink-persisted');

  // page 2: ink drawn there belongs to page 2, and page 1's row is untouched
  const p0Before = rows[0]?.ink_json;
  await page.click('button[title="Next page"]');
  await sleep(700);
  await drawStroke(page, { x: box.x + 200, y: box.y + 400 }, { x: box.x + 500, y: box.y + 410 });
  await sleep(1500);
  rows = (await dumpDb(page)).ann || [];
  const keys = rows.map((r) => r.page_key).sort();
  check('a stroke drawn on page 2 is stored under page 2', keys.join() === 'p0,p1', keys.join());
  check("and page 1's stored ink is unchanged", rows.find((r) => r.page_key === 'p0')?.ink_json === p0Before);
  await shot(page, '06-page-2');

  // The 401 is the sign-in check before logging in. Recent Chrome also reports "unload is not allowed" for the listener that
  // Excalidraw itself registers on window (not ours; nothing in src/ uses unload).
  check('no page errors', errors.filter((e) => !/401|Permissions policy violation: unload/.test(e)).length === 0, errors.join('\n'));
  await ctx.close();
}

// --------------------------------------------------------------------------------------------------

const serverPull = (page, since = '') =>
  page.evaluate(async (s) => (await fetch(`/api/sync/pull?since=${encodeURIComponent(s)}`, { credentials: 'include' })).json(), since);

async function chooseOnImport(page, pdfPath, label) {
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.evaluate(() => document.querySelector('header button.bg-accent')?.click())]);
  await chooser.accept([pdfPath]);
  await page.waitForSelector('div[class*="z-[1100]"] [role=dialog]', { timeout: 15000 });
  await page.evaluate((l) => [...document.querySelectorAll('div[class*="z-[1100]"] [role=dialog] button')].find((b) => b.innerText.includes(l))?.click(), label);
}

async function readerReady(page) {
  await page.waitForFunction(() => location.pathname.startsWith('/read/'), { timeout: 30000 });
  await waitUntil(async () => (await paperStats(page))?.dark > 500, { timeout: 30000, label: 'the PDF to be drawn' });
  await sleep(500);
}

async function scenarioCloud(browser, state) {
  section('A synced PDF, and a second device');
  const ctxA = await browser.createBrowserContext();
  const A = await ctxA.newPage();
  await lightMode(A);
  const errorsA = [];
  A.on('pageerror', (e) => errorsA.push(e.message));
  await login(A, 'bob');
  await chooseOnImport(A, state.bigPdfPath, 'Sync with my server');
  await readerReady(A);

  let pull = await waitUntil(async () => {
    const p = await serverPull(A);
    return p.docs?.length === 1 && p.docs[0].file_ready ? p : null;
  }, { timeout: 30000, label: 'the document and its file to reach the server' });
  const doc = pull.docs[0];
  check('the document reached the server with its metadata', doc.title === 'Moby Dick (test)' && doc.page_count === 3 && doc.author === 'H. Melville');
  check('the PDF was uploaded and verified', doc.file_ready === true && !!doc.file_sha256);
  const status = await A.evaluate(async (sha) => (await fetch(`/api/files/${sha}/status`, { credentials: 'include' })).json(), doc.file_sha256);
  check('the server has exactly the file that was added', status.exists === true && status.size === doc.file_size);
  const dbA = await dumpDb(A);
  check('the local copy is marked synced and the outbox drained', dbA.docs[0].sync === 'cloud' && dbA.outbox.length === 0, JSON.stringify(dbA.outbox));

  // ink on device A reaches the server
  await A.click('button[aria-label="#e03131"]');
  const box = await A.$eval('.quarc-canvas-page', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await drawStroke(A, { x: box.x + 200, y: box.y + 420 }, { x: box.x + 600, y: box.y + 430 });
  pull = await waitUntil(async () => {
    const p = await serverPull(A);
    return p.anns?.some((a) => a.page_key === 'p0' && a.ink.elements.length) ? p : null;
  }, { timeout: 30000, label: "device A's stroke to reach the server" });
  check("device A's stroke reached the server, per page", pull.anns.length === 1 && pull.anns[0].page_key === 'p0');

  // ----- device B: a brand-new browser profile, same account -----
  const ctxB = await browser.createBrowserContext();
  const B = await ctxB.newPage();
  await lightMode(B);
  const errorsB = [];
  const requestsB = [];
  B.on('pageerror', (e) => errorsB.push(e.message));
  B.on('request', (r) => requestsB.push({ url: r.url(), range: r.headers().range }));
  // Bytes that really arrived for the file (not the size a response header announced).
  const bytesB = { file: 0 };
  const cdp = await B.createCDPSession();
  await cdp.send('Network.enable');
  const fileRequests = new Set();
  cdp.on('Network.requestWillBeSent', (e) => {
    if (/\/api\/files\/[0-9a-f]{64}$/.test(e.request.url)) fileRequests.add(e.requestId);
  });
  cdp.on('Network.dataReceived', (e) => {
    if (fileRequests.has(e.requestId)) bytesB.file += e.dataLength;
  });
  // Don't keep a copy after the first open: this device should stream the book.
  await testDefaults(B, { autoCache: false });
  await login(B, 'bob');
  await waitUntil(async () => (await dumpDb(B)).docs?.length === 1, { timeout: 30000, label: 'the document to appear on device B' });
  const dbB0 = await dumpDb(B);
  check('device B receives the library entry (and nothing else yet)', dbB0.docs[0].sync === 'cloud' && dbB0.docs[0].title === 'Moby Dick (test)' && (dbB0.blobs || []).length === 0);
  await B.waitForSelector('img[src^="data:image/jpeg"]', { timeout: 10000 }).catch(() => {});
  await shot(B, '10-device-b-library');
  check('the cover thumbnail travelled with it', (await B.$('img[src^="data:image/jpeg"]')) !== null);

  await B.evaluate(() => document.querySelector('.cursor-pointer')?.click());
  await readerReady(B);
  const ranged = requestsB.filter((r) => /\/api\/files\//.test(r.url) && r.range);
  check('device B reads the PDF from the server in byte ranges', ranged.length > 0, requestsB.filter((r) => /api\/files/.test(r.url)).map((r) => `${r.url.slice(-12)} ${r.range}`).join('\n'));
  await sleep(1500); // would a background download have started by now?
  check('...and has fetched only a small part of the 6 MB file to show page 1', bytesB.file < 2 * 1024 * 1024, `${bytesB.file} bytes`);
  await sleep(1000);
  const redB = await inkPixels(B, RED);
  check("device A's ink is on device B's page", redB > 200, `${redB} red pixels`);
  await shot(B, '11-device-b-reader');
  check('with caching off, device B keeps no copy of the file', ((await dumpDb(B)).blobs || []).length === 0);
  // ...until asked: More > Download for offline reading
  await B.evaluate(() => [...document.querySelectorAll('header button')].find((b) => b.getAttribute('aria-label') === 'More')?.click());
  await B.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /Download for offline/.test(b.innerText)), { timeout: 5000 });
  await B.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Download for offline/.test(b.innerText))?.click());
  await waitUntil(async () => ((await dumpDb(B)).blobs || []).length === 1, { timeout: 30000, label: 'the book to be downloaded for offline reading' });
  const cached = (await dumpDb(B)).blobs[0];
  check('"Download for offline reading" keeps the whole verified file on device B', cached.size > 6 * 1024 * 1024 && cached.sha256 === doc.file_sha256, `${cached.size}`);

  // live: a stroke on B shows up on A while A has the page open
  const redA0 = await inkPixels(A, RED);
  await B.click('button[aria-label="#e03131"]');
  const boxB = await B.$eval('.quarc-canvas-page', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await drawStroke(B, { x: boxB.x + 200, y: boxB.y + 500 }, { x: boxB.x + 600, y: boxB.y + 510 });
  await waitUntil(async () => {
    const p = await serverPull(B);
    return p.anns.find((a) => a.page_key === 'p0')?.ink.elements.filter((e) => !e.isDeleted).length === 2;
  }, { timeout: 30000, label: "device B's stroke to reach the server" });
  await A.evaluate(() => window.dispatchEvent(new Event('online'))); // sync now instead of waiting 20s
  await waitUntil(async () => (await inkPixels(A, RED)) > redA0 + 200, { timeout: 30000, label: "device B's stroke to appear on device A" });
  check("device B's stroke appears on device A while it is open (merged, nothing lost)", true);
  await shot(A, '12-device-a-merged');
  const aInk = JSON.parse((await dumpDb(A)).ann[0].ink_json).elements.filter((e) => !e.isDeleted);
  check('device A now holds both strokes', aInk.length === 2, `${aInk.length}`);

  // stopping sync on A removes the server copy and B's copy, and A keeps everything
  await A.evaluate(() => [...document.querySelectorAll('header button')].find((b) => b.getAttribute('aria-label') === 'More')?.click());
  await A.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /Stop syncing/.test(b.innerText)), { timeout: 5000 });
  await A.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Stop syncing/.test(b.innerText))?.click());
  await A.waitForSelector('div[class*="z-[1100]"] [role=dialog]');
  await shot(A, '13-stop-sync-dialog');
  await A.evaluate(() => [...document.querySelectorAll('div[class*="z-[1100]"] [role=dialog] button')].find((b) => b.innerText.trim() === 'Stop syncing')?.click());
  await waitUntil(async () => (await serverPull(A)).docs.length === 0, { timeout: 30000, label: 'the server copy to be removed' });
  check('"Stop syncing" removes the document from the server', true);
  const dbA2 = await dumpDb(A);
  check('device A keeps the file, the document and its ink, now local-only', dbA2.docs[0].sync === 'local' && dbA2.blobs.length === 1 && dbA2.ann.length === 1 && dbA2.outbox.length === 0, JSON.stringify({ sync: dbA2.docs[0].sync, outbox: dbA2.outbox.length }));
  await B.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitUntil(async () => (await dumpDb(B)).docs.length === 0, { timeout: 30000, label: 'device B to drop the document' });
  check('device B drops it on its next sync', true);

  check('no page errors on either device', errorsA.length + errorsB.length === 0, [...errorsA, ...errorsB].join('\n'));
  await ctxA.close();
  await ctxB.close();
}

// --------------------------------------------------------------------------------------------------

// Pixels of a colour on the highlight layer (the second canvas in the reader).
const marksPixels = (page, testSource) =>
  page.evaluate((src) => {
    const test = new Function('r', 'g', 'b', 'a', `return (${src});`);
    const canvas = document.querySelectorAll('.quarc-canvas-page > canvas')[1];
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (test(data[i], data[i + 1], data[i + 2], data[i + 3])) n++;
    return n;
  }, testSource);
const YELLOW = 'a > 200 && r > 230 && g > 180 && b < 110';

// The on-screen rectangle of the text layer's span that starts with `prefix`.
const spanRect = (page, prefix) =>
  page.evaluate((p) => {
    const span = [...document.querySelectorAll('.quarc-text-layer span')].find((s) => s.textContent.trim().startsWith(p));
    if (!span) return null;
    const r = span.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, prefix);

const marksOf = async (page) => {
  const rows = (await dumpDb(page)).ann || [];
  return rows.flatMap((r) => JSON.parse(r.marks_json).map((m) => ({ ...m, page_key: r.page_key })));
};

async function scenarioMarks(browser, state) {
  section('Highlighting text');
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await lightMode(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, 'carol');
  await chooseOnImport(page, state.pdfPath, 'device only');
  await readerReady(page);

  // ----- select text, highlight it -----
  await page.click('button[aria-label="Select text to highlight"]');
  await waitUntil(() => spanRect(page, 'Call me Ishmael'), { label: 'the text layer to appear' });
  check('text mode puts selectable text over the page', true);
  await page.evaluate(() => {
    const span = [...document.querySelectorAll('.quarc-text-layer span')].find((s) => s.textContent.trim().startsWith('Call me Ishmael'));
    getSelection().selectAllChildren(span);
  });
  await page.waitForSelector('button[aria-label="Highlight"]', { timeout: 5000 });
  await shot(page, '20-selection-bar');
  check('selecting text shows the highlight bar', true);
  await page.click('button[aria-label="Highlight"]');
  await sleep(1500);

  let marks = await marksOf(page);
  check('the highlight is stored as a mark on page 1', marks.length === 1 && marks[0].type === 'hl' && marks[0].page_key === 'p0', JSON.stringify(marks.map((m) => [m.type, m.page_key])));
  check('with the highlighted words', /Call me Ishmael/.test(marks[0]?.text), marks[0]?.text);
  const [rx, ry, rw, rh] = marks[0].rects[0];
  check('and PAGE-LOCAL line rectangles', rx > 0 && rx < 794 && ry > 0 && ry < 1123 && rw > 100 && rh > 8 && rh < 40, JSON.stringify(marks[0].rects));
  check('a text highlight leaves no ink behind', ((await dumpDb(page)).ann || []).every((r) => JSON.parse(r.ink_json).elements.length === 0));
  const yellow = await marksPixels(page, YELLOW);
  check('the highlight is painted on the page', yellow > 1500, `${yellow} yellow pixels`);
  await shot(page, '21-highlighted');

  // ----- tap it to add a note -----
  const r = await spanRect(page, 'Call me Ishmael');
  await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
  await page.waitForSelector('textarea[placeholder="Write a note…"]', { timeout: 5000 });
  await shot(page, '22-mark-popover');
  await page.type('textarea[placeholder="Write a note…"]', 'the famous opening');
  await page.evaluate(() => document.querySelector('textarea[placeholder="Write a note…"]').blur());
  await sleep(1500);
  marks = await marksOf(page);
  check('tapping a highlight opens it, and a typed note is saved on it', marks[0]?.note === 'the famous opening', JSON.stringify(marks[0]));

  // ----- the notes list -----
  await page.click('button[aria-label="Notes and highlights"]');
  await sleep(500);
  const panel = await page.$eval('aside', (el) => el.innerText);
  check('the notes panel lists the highlight with its note and page', /Call me Ishmael/.test(panel) && /the famous opening/.test(panel) && /Page 1/.test(panel), panel);
  await shot(page, '23-notes-panel');
  await page.click('button[aria-label="Close"]');

  // ----- survives a reload -----
  await page.reload({ waitUntil: 'networkidle0' });
  await waitUntil(async () => (await paperStats(page))?.dark > 500, { label: 'reader after reload' });
  await sleep(800);
  check('highlights are still painted after a reload', (await marksPixels(page, YELLOW)) > 1500);

  // ----- pencil highlighter snaps to the words under it -----
  await page.click('button[aria-label="Highlighter"]');
  await waitUntil(() => spanRect(page, 'to interest me'), { label: 'text geometry in highlighter mode' });
  await sleep(500);
  const line = await spanRect(page, 'to interest me');
  const before = (await marksOf(page)).length;
  // "to interest me on shore, I thought I would sail about a little": from partway into
  // "interest" to partway into "shore," (about 8% .. 38% of the line).
  await drawStroke(page, { x: line.x + line.w * 0.09, y: line.y + line.h / 2 }, { x: line.x + line.w * 0.36, y: line.y + line.h / 2 + 1 }, 14);
  await sleep(1800);
  marks = await marksOf(page);
  check('a highlighter stroke over text becomes a real text highlight', marks.length === before + 1, `${before} -> ${marks.length}`);
  const snapped = marks[marks.length - 1];
  const lineWords = 'to interest me on shore, I thought I would sail about a little'.split(' ');
  const words = (snapped?.text || '').split(' ');
  check('it covers the words the pencil passed over', /interest/.test(snapped?.text) && /shore/.test(snapped?.text), snapped?.text);
  check('snapped to WHOLE words (no half-words at either end)', words.length > 0 && words.every((w) => lineWords.includes(w)), snapped?.text);
  check('and it is not freehand ink', ((await dumpDb(page)).ann || []).every((row) => JSON.parse(row.ink_json).elements.length === 0));
  await shot(page, '24-pencil-snap');

  // strokes over blank paper stay freehand ink (well clear of Excalidraw's corner controls)
  await drawStroke(page, { x: line.x + 40, y: line.y + 150 }, { x: line.x + 300, y: line.y + 155 }, 10);
  await sleep(1800);
  const inkRows = ((await dumpDb(page)).ann || []).filter((row) => JSON.parse(row.ink_json).elements.length > 0);
  check('a highlighter stroke over blank paper stays freehand ink', inkRows.length === 1);

  check('no page errors', errors.length === 0, errors.join('\n'));
  await ctx.close();
}

// --------------------------------------------------------------------------------------------------

// Opens a header menu and clicks the item whose text matches.
async function menuClick(page, menuLabel, itemRe) {
  await page.evaluate((l) => [...document.querySelectorAll('header button')].find((b) => b.getAttribute('aria-label') === l)?.click(), menuLabel);
  await page.waitForFunction((src) => [...document.querySelectorAll('button')].some((b) => new RegExp(src).test(b.innerText)), { timeout: 5000 }, itemRe);
  await page.evaluate((src) => [...document.querySelectorAll('button')].find((b) => new RegExp(src).test(b.innerText))?.click(), itemRe);
}

async function waitForDownload(dir, ext = '.pdf', timeout = 30000) {
  const { readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  return waitUntil(() => {
    const f = readdirSync(dir).find((n) => n.endsWith(ext) && !n.endsWith('.crdownload') && /annotated/.test(n));
    return f && statSync(join(dir, f)).size > 0 ? join(dir, f) : null;
  }, { timeout, label: 'the downloaded PDF' });
}

async function scenarioExport(browser, state) {
  section('Note pages, and saving the PDF');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { PDFDocument, PDFName, PDFDict, PDFArray } = await import('pdf-lib');
  const downloads = mkdtempSync(join(tmpdir(), 'quarc-reader-dl-'));
  const ctx = await browser.createBrowserContext();
  // Downloads in an isolated context need the setting scoped to that context.
  const bsession = await browser.target().createCDPSession();
  await bsession.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, browserContextId: ctx.id });
  const page = await ctx.newPage();
  await lightMode(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, 'dave');
  await chooseOnImport(page, state.pdfPath, 'device only');
  await readerReady(page);
  const box = await page.$eval('.quarc-canvas-page', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });

  // ink on page 1
  await page.click('button[aria-label="#e03131"]');
  await drawStroke(page, { x: box.x + 200, y: box.y + 420 }, { x: box.x + 600, y: box.y + 430 });
  // a highlight with a note on page 1
  await page.click('button[aria-label="Select text to highlight"]');
  await waitUntil(() => spanRect(page, 'Call me Ishmael'), { label: 'text layer' });
  await page.evaluate(() => getSelection().selectAllChildren([...document.querySelectorAll('.quarc-text-layer span')].find((s) => s.textContent.trim().startsWith('Call me Ishmael'))));
  await page.waitForSelector('button[aria-label="Add a note"]');
  await page.click('button[aria-label="Add a note"]');
  await page.type('textarea[placeholder="Write a note…"]', 'opening line — Türkçe çğış');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Save')?.click());
  await sleep(1200);
  await page.click('button[aria-label="Select text to highlight"]'); // back to the pen

  // a note page after page 1, with a stroke on it
  await menuClick(page, 'More', 'Insert a note page here');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Lined'), { timeout: 5000 });
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Lined')?.click());
  await waitUntil(async () => /2\s*\/\s*4/.test(await page.$eval('.quarc-canvas-page', (el) => el.parentElement.innerText)), { label: 'the page indicator to show 2 / 4' }).catch(async (err) => {
    await shot(page, '30-note-page-FAILED');
    console.log('  layout:', JSON.stringify((await dumpDb(page)).docs[0]?.layout), '| text:', (await page.$eval('.quarc-canvas-page', (el) => el.parentElement.innerText)).replace(/\n/g, ' ').slice(-80));
    throw err;
  });
  check('inserting a note page makes the document one page longer and jumps to it', true);
  await sleep(1000);
  await shot(page, '30-note-page');
  await drawStroke(page, { x: box.x + 300, y: box.y + 300 }, { x: box.x + 700, y: box.y + 330 });
  await sleep(1500);

  let db = await dumpDb(page);
  const noteItem = (db.docs[0].layout || []).find((it) => it.t === 'n');
  check('the document now has a layout with the note page in it', !!noteItem && db.docs[0].layout.length === 4, JSON.stringify(db.docs[0].layout));
  check("the note page's ink is stored under the note page, not a PDF page", db.ann.some((r) => r.page_key === `n${noteItem.id}` && JSON.parse(r.ink_json).elements.length === 1), db.ann.map((r) => r.page_key).join());
  check('page 1 still holds its own ink and highlight', db.ann.some((r) => r.page_key === 'p0' && JSON.parse(r.ink_json).elements.length === 1 && JSON.parse(r.marks_json).length === 1));

  // ----- save a copy -----
  await menuClick(page, 'More', 'Save PDF');
  await page.waitForSelector('div[class*="z-[1100]"] [role=dialog]');
  await shot(page, '31-export-dialog');
  await page.evaluate(() => [...document.querySelectorAll('div[class*="z-[1100]"] [role=dialog] button')].find((b) => /Save a copy/.test(b.innerText))?.click());
  const file = await waitForDownload(downloads).catch(async (err) => {
    const { readdirSync } = await import('node:fs');
    console.log('  dialog:', (await page.$eval('div[class*="z-[1100]"] [role=dialog]', (el) => el.innerText).catch(() => '(closed)')).replace(/\n/g, ' | ').slice(0, 400));
    console.log('  downloads dir:', JSON.stringify(readdirSync(downloads)), '| errors:', errors.join(' / '));
    await shot(page, '31-export-FAILED');
    throw err;
  });
  const out = await PDFDocument.load(readFileSync(file));
  check('the saved PDF has the note page as a real page (4 pages)', out.getPageCount() === 4, `${out.getPageCount()}`);
  check('the note page has its own size', Math.abs(out.getPage(1).getSize().width - 595) < 2 && Math.abs(out.getPage(1).getSize().height - 842) < 2, JSON.stringify(out.getPage(1).getSize()));
  const annots = (i) => {
    const arr = out.getPage(i).node.Annots();
    const list = [];
    if (arr) for (let k = 0; k < arr.size(); k++) list.push(out.context.lookup(arr.get(k), PDFDict));
    return list;
  };
  const kinds = annots(0).map((a) => a.get(PDFName.of('Subtype')).toString());
  check('page 1 carries a real PDF highlight and a sticky note', kinds.includes('/Highlight') && kinds.includes('/Text'), kinds.join());
  const note = annots(0).find((a) => a.get(PDFName.of('Subtype')).toString() === '/Text');
  check('with the typed note, Turkish letters intact', note?.get(PDFName.of('Contents')).decodeText() === 'opening line — Türkçe çğış', note?.get(PDFName.of('Contents')).decodeText());
  check('the original document in the library is untouched', (await dumpDb(page)).docs[0].file_sha256 === db.docs[0].file_sha256 && !(await dumpDb(page)).docs[0].orig_sha256);
  await page.waitForFunction(() => !document.querySelector('div[class*="z-[1100]"] [role=dialog]'), { timeout: 10000 });

  // ----- replace the original -----
  await menuClick(page, 'More', 'Save PDF');
  await page.waitForSelector('div[class*="z-[1100]"] [role=dialog]');
  await page.evaluate(() => [...document.querySelectorAll('div[class*="z-[1100]"] [role=dialog] button')].find((b) => /Replace the original/.test(b.innerText))?.click());
  await page.waitForFunction(() => [...document.querySelectorAll('div[class*="z-[1100]"] [role=dialog] button')].some((b) => b.innerText.trim() === 'Replace'), { timeout: 5000 });
  await shot(page, '32-replace-confirm');
  await page.evaluate(() => [...document.querySelectorAll('div[class*="z-[1100]"] [role=dialog] button')].find((b) => b.innerText.trim() === 'Replace')?.click());
  await waitUntil(async () => (await dumpDb(page)).docs[0].orig_sha256, { timeout: 40000, label: 'the replacement to be stored' });
  db = await dumpDb(page);
  check('the library document is now the annotated file, with the old one kept as a safety net', db.docs[0].file_sha256 !== db.docs[0].orig_sha256 && db.docs[0].page_count === 4 && db.docs[0].layout === null, JSON.stringify({ pages: db.docs[0].page_count, layout: db.docs[0].layout }));
  check('both files are on the device', db.blobs.length === 2);
  await waitUntil(async () => (await page.$eval('.quarc-canvas-page', (el) => el.parentElement.innerText)).includes('/ 4'), { label: 'reader reloaded with 4 pages' });
  await sleep(1500);
  const live = db.ann.flatMap((r) => JSON.parse(r.ink_json).elements.filter((e) => !e.isDeleted)).length + db.ann.flatMap((r) => JSON.parse(r.marks_json).filter((m) => !m.del)).length;
  check('the ink and highlights are now part of the pages — no longer separate annotations', live === 0, `${live} live items`);
  await page.click('button[title="Next page"]').catch(() => {});
  await page.click('button[title="Previous page"]').catch(() => {});
  await sleep(800);
  const stats = await paperStats(page);
  check("the red ink is drawn into the page itself (it is on the paper layer now)", stats.colored > 300, JSON.stringify(stats));
  await shot(page, '33-replaced');

  // ----- revert -----
  await menuClick(page, 'More', 'Save PDF');
  await page.waitForSelector('div[class*="z-[1100]"] [role=dialog]');
  await page.evaluate(() => [...document.querySelectorAll('div[class*="z-[1100]"] [role=dialog] button')].find((b) => /Revert to the original/.test(b.innerText))?.click());
  await waitUntil(async () => !(await dumpDb(page)).docs[0].orig_sha256, { timeout: 30000, label: 'the revert' });
  db = await dumpDb(page);
  check('reverting brings back the original file and its page count', db.docs[0].page_count === 3 && db.docs[0].file_sha256 === (await import('node:crypto')).createHash('sha256').update(readFileSync(state.pdfPath)).digest('hex'), JSON.stringify({ pages: db.docs[0].page_count }));

  check('no page errors', errors.length === 0, errors.join('\n'));
  await ctx.close();
}

// --------------------------------------------------------------------------------------------------

const MODAL = 'div[class*="z-[1100]"] [role=dialog]';

async function scenarioShare(browser, state) {
  section('Sharing a link');
  const ctxA = await browser.createBrowserContext();
  await ctxA.overridePermissions(BASE, ['clipboard-read', 'clipboard-write']);
  const A = await ctxA.newPage();
  await lightMode(A);
  const errors = [];
  A.on('pageerror', (e) => errors.push(`A: ${e.message}`));
  // Headless Chrome refuses clipboard writes, so the dialog falls back to showing the link in a
  // browser prompt (right for a user); here that would block the page, so dismiss it.
  A.on('dialog', (d) => d.dismiss().catch(() => {}));
  await login(A, 'frank');
  await chooseOnImport(A, state.pdfPath, 'Sync with my server');
  await readerReady(A);
  const box = await A.$eval('.quarc-canvas-page', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await A.click('button[aria-label="#e03131"]');
  await drawStroke(A, { x: box.x + 200, y: box.y + 420 }, { x: box.x + 600, y: box.y + 430 });
  await A.click('button[aria-label="Select text to highlight"]');
  await waitUntil(() => spanRect(A, 'Call me Ishmael'), { label: 'text layer' });
  await A.evaluate(() => getSelection().selectAllChildren([...document.querySelectorAll('.quarc-text-layer span')].find((s) => s.textContent.trim().startsWith('Call me Ishmael'))));
  await A.waitForSelector('button[aria-label="Highlight"]');
  await A.click('button[aria-label="Highlight"]');
  await waitUntil(async () => {
    const p = await serverPull(A);
    const a = p.anns.find((x) => x.page_key === 'p0');
    return p.docs[0]?.file_ready && a?.ink.elements.length === 1 && a.marks.length === 1;
  }, { timeout: 30000, label: 'the document, file, ink and highlight to reach the server' });

  // ----- make two links -----
  const makeLink = async (includeAnnotations) => {
    await menuClick(A, 'More', 'Share…');
    await A.waitForSelector(MODAL);
    const box2 = await A.$(`${MODAL} input[type=checkbox]`);
    const checked = await box2.evaluate((el) => el.checked);
    if (checked !== includeAnnotations) await box2.click();
    const before = await A.$$eval(`${MODAL} p.font-mono`, (els) => els.map((e) => e.textContent));
    await A.evaluate(() => [...document.querySelectorAll('div[class*="z-[1100]"] [role=dialog] button')].find((b) => /Create link/.test(b.innerText))?.click());
    const links = await waitUntil(async () => {
      const now = await A.$$eval(`${MODAL} p.font-mono`, (els) => els.map((e) => e.textContent));
      return now.length > before.length ? now : null;
    }, { label: 'the new link to be listed' });
    const url = links.find((l) => !before.includes(l));
    await shot(A, includeAnnotations ? '40-share-dialog' : '41-share-dialog-2');
    await A.evaluate(() => [...document.querySelectorAll('div[class*="z-[1100]"] [role=dialog] button')].find((b) => b.getAttribute('title') === 'Close' || b.querySelector('svg.lucide-x'))?.click());
    await A.waitForFunction((sel) => !document.querySelector(sel), {}, MODAL);
    return url;
  };
  const withInk = await makeLink(true);
  const plain = await makeLink(false);
  check('a share link points at this server and carries a long random token', withInk.startsWith(`${BASE}/s/`) && /^[A-Za-z0-9_-]{30,}$/.test(withInk.slice(`${BASE}/s/`.length)), withInk);
  check('two different links were made', withInk !== plain);

  // ----- an anonymous reader (no cookies at all) -----
  const ctxAnon = await browser.createBrowserContext();
  const anon = await ctxAnon.newPage();
  await lightMode(anon);
  const anonErrors = [];
  anon.on('pageerror', (e) => anonErrors.push(e.message));
  await anon.goto(withInk, { waitUntil: 'networkidle0' });
  await waitUntil(async () => (await paperStats(anon))?.dark > 500, { timeout: 30000, label: 'the shared PDF to render' });
  await sleep(800);
  const header = await anon.$eval('header', (el) => el.innerText);
  check('opening the link needs no account and shows who/what', /Moby Dick/.test(header) && /Shared with you/.test(header) && /with annotations/.test(header) && /Sign in to add/.test(header), header.replace(/\n/g, ' | '));
  check('the owner\'s pencil ink is visible', (await inkPixels(anon, RED)) > 200);
  check('and so are the highlights', (await marksPixels(anon, YELLOW)) > 1500);
  await shot(anon, '42-shared-view');

  const darkBefore = await inkPixels(anon, 'a > 200 && r < 90 && g < 90 && b < 90');
  const redBefore = await inkPixels(anon, RED);
  await drawStroke(anon, { x: 300, y: 700 }, { x: 700, y: 720 });
  await sleep(1200);
  check('it is read-only: dragging pans instead of drawing', (await inkPixels(anon, RED)) === redBefore && (await inkPixels(anon, 'a > 200 && r < 90 && g < 90 && b < 90')) === darkBefore);
  const anonDb = await dumpDb(anon).catch(() => ({}));
  check('and nothing is written on the reader\'s device', !(anonDb.ann || []).length && !(anonDb.docs || []).length);

  await anon.goto(plain, { waitUntil: 'networkidle0' });
  await waitUntil(async () => (await paperStats(anon))?.dark > 500, { timeout: 30000, label: 'the plain shared PDF to render' });
  await sleep(600);
  check('a plain link shows the PDF without the owner\'s annotations', (await inkPixels(anon, RED)) === 0 && (await marksPixels(anon, YELLOW)) === 0);
  check('...and says so', !/with annotations/.test(await anon.$eval('header', (el) => el.innerText)));

  // ----- another Quarc user adds it to their own library -----
  const ctxE = await browser.createBrowserContext();
  const E = await ctxE.newPage();
  await lightMode(E);
  E.on('pageerror', (err) => errors.push(`E: ${err.message}`));
  const elog = [];
  E.on('console', (m) => elog.push(`[${m.type()}] ${m.text().slice(0, 200)}`));
  E.on('requestfailed', (r) => elog.push(`[requestfailed] ${r.url().slice(-60)} ${r.failure()?.errorText}`));
  E.on('response', (r) => r.status() >= 400 && elog.push(`[${r.status()}] ${r.url().slice(-60)}`));
  const idbNames = (p) => Promise.race([p.evaluate(async () => JSON.stringify((await indexedDB.databases()).map((d) => `${d.name}@${d.version}`))), sleep(4000).then(() => 'databases() NO ANSWER')]);
  await login(E, 'erin');
  elog.push(`after login: ${await idbNames(E)}`);
  await E.goto(withInk, { waitUntil: 'networkidle0' });
  elog.push(`after share page load: ${await idbNames(E)}`);
  await waitUntil(async () => (await paperStats(E))?.dark > 500, { timeout: 30000, label: 'the shared PDF for a signed-in user' });
  const hdr = await E.$eval('header', (el) => el.innerText);
  check('a signed-in user is offered "Add to my library"', /Add to my library/.test(hdr), hdr);
  await E.evaluate(() => [...document.querySelectorAll('header button')].find((b) => /Add to my library/.test(b.innerText))?.click());
  await E.waitForFunction(() => location.pathname === '/', { timeout: 15000 });
  const erinDocs = await waitUntil(async () => {
    const d = (await dumpDb(E)).docs || [];
    return d.length === 1 ? d : null;
  }, { timeout: 30000, label: "the document to appear in erin's library" }).catch(async (err) => {
    // diagnostics for a rare hang: is the page alive, and what does IndexedDB say?
    const alive = await Promise.race([E.evaluate(() => `alive: ${location.pathname}`), sleep(5000).then(() => 'PAGE DID NOT ANSWER')]);
    const dbs = await Promise.race([E.evaluate(async () => JSON.stringify(await indexedDB.databases())), sleep(5000).then(() => 'indexedDB.databases() DID NOT ANSWER')]);
    const open = await Promise.race([
      E.evaluate(() => new Promise((res) => { const r = indexedDB.open('quarc-reader'); r.onsuccess = () => { const n = [...r.result.objectStoreNames].join(); r.result.close(); res(`open ok, stores: [${n}] v${r.result.version}`); }; r.onerror = () => res(`open error: ${r.error}`); r.onblocked = () => res('open BLOCKED'); })),
      sleep(5000).then(() => 'indexedDB.open DID NOT ANSWER'),
    ]);
    // a second, brand-new page in the same context: is the whole context wedged, or only this page?
    const E2 = await ctxE.newPage();
    await E2.goto(`${BASE}/logo.png`);
    const second = await Promise.race([
      E2.evaluate(() => new Promise((res) => { const r = indexedDB.open('probe2'); r.onsuccess = () => { r.result.close(); res('ok'); }; r.onerror = () => res('error'); })),
      sleep(5000).then(() => 'NO ANSWER'),
    ]);
    console.log('  DIAG:', alive, '|', dbs, '|', open, '| a second page in the same context:', second);
    console.log('  E console/requests:\n    ' + elog.slice(-25).join('\n    '));
    throw err;
  });
  check("it lands in the other user's library as their own synced copy", erinDocs[0].title === 'Moby Dick (test)' && erinDocs[0].sync === 'cloud');
  await waitUntil(async () => ((await dumpDb(E)).ann || []).length === 1, { timeout: 30000, label: 'the annotations to be copied' });
  check("with the owner's annotations, since the link included them", true);
  const erinPull = await serverPull(E);
  check('the file was copied into her own storage (not shared with the owner\'s)', erinPull.docs[0].file_ready === true && erinPull.docs[0].id !== (await serverPull(A)).docs[0].id);

  // ----- turning a link off -----
  await menuClick(A, 'More', 'Share…');
  await A.waitForSelector(MODAL);
  await A.evaluate((url) => {
    const row = [...document.querySelectorAll('div[class*="z-[1100]"] [role=dialog] p.font-mono')].find((p) => p.textContent === url)?.closest('div.flex');
    row?.querySelector('button[title="Turn this link off"]')?.click();
  }, withInk);
  await waitUntil(async () => !(await A.$$eval(`${MODAL} p.font-mono`, (els) => els.map((e) => e.textContent))).includes(withInk), { label: 'the link to disappear from the list' });
  await anon.goto(withInk, { waitUntil: 'networkidle0' });
  await sleep(800);
  const gone = await anon.evaluate(() => document.body.innerText);
  check('a link that was turned off stops working', /not found, has expired or was turned off/.test(gone), gone.slice(0, 200));
  await anon.goto(plain, { waitUntil: 'networkidle0' });
  await waitUntil(async () => (await paperStats(anon))?.dark > 500, { timeout: 30000, label: 'the other link to still work' });
  check('while the other link keeps working', true);

  check('no page errors', errors.length + anonErrors.length === 0, [...errors, ...anonErrors].join('\n'));
  await ctxA.close();
  await ctxAnon.close();
  await ctxE.close();
}

// --------------------------------------------------------------------------------------------------

const indicator = (page) =>
  page.evaluate(() => {
    const pill = [...document.querySelectorAll('.quarc-canvas-page span')].find((s) => /\d+\s*\/\s*\d+/.test(s.textContent) && s.className.includes('tabular-nums'));
    return pill?.textContent.replace(/\s+/g, '') || null;
  });
const waitIndicator = (page, expected, label) =>
  waitUntil(async () => (await indicator(page)) === expected, { label: label || `the page indicator to read ${expected}` }).catch(async (err) => {
    await shot(page, 'FAILED-indicator');
    throw new Error(`${err.message} (it reads ${await indicator(page)})`);
  });

async function swipe(page, from, to, steps = 8) {
  await page.touchscreen.touchStart(from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    await page.touchscreen.touchMove(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await sleep(15);
  }
  await page.touchscreen.touchEnd();
}

async function scenarioReading(browser, state) {
  section('Scroll mode, book mode, and picking up where you left off');
  const book = writePdf('book-40.pdf', await makeTestPdf({ pages: 40, title: 'Forty Pages' }));
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await lightMode(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // A finger scrolls (instead of drawing) so touch gestures can be tested as reading gestures.
  await testDefaults(page, { fingerMode: 'scroll' });
  await login(page, 'gina');
  await chooseOnImport(page, book, 'device only');
  await readerReady(page);
  check('a 40-page book opens', (await indicator(page)) === '1/40', await indicator(page));

  // ----- scroll mode -----
  // Pressing a key the moment the book has appeared must work (the opening view is re-asserted for
  // a short while to survive Excalidraw's async restore, and no navigation may be overridden by it).
  await page.keyboard.press('End');
  await waitIndicator(page, '40/40');
  await waitUntil(async () => (await paperStats(page))?.dark > 500, { label: 'the last page to be drawn after jumping to it' });
  check('End jumps to the last page and it is drawn', true);
  await shot(page, '50-last-page');
  await page.keyboard.press('Home');
  await waitIndicator(page, '1/40');
  // a page is ~1760 px tall at this zoom: four screens later we are on the next page
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('PageDown');
    await sleep(350);
  }
  const afterScroll = await indicator(page);
  check('Page Down scrolls through the book a screen at a time', afterScroll === '2/40', afterScroll);
  // continuous scroll: the wheel moves smoothly across page boundaries
  await page.mouse.move(640, 500);
  for (let i = 0; i < 12; i++) await page.mouse.wheel({ deltaY: 400 });
  await sleep(600);
  const wheeled = parseInt(((await indicator(page)) || '0').split('/')[0], 10);
  check('the mouse wheel scrolls continuously through the pages', wheeled >= 3, `${wheeled}`);
  const paperNow = await waitUntil(async () => {
    const s = await paperStats(page);
    return s && s.dark > 100 && s.white > 100000 ? s : null;
  }, { label: 'scrolled-to pages to be drawn (page paper AND PDF text)' });
  check('pages scrolled into view are drawn with their PDF content', !!paperNow, JSON.stringify(paperNow));

  // ----- switch to book mode -----
  await page.evaluate(() => [...document.querySelectorAll('header button')].find((b) => b.getAttribute('aria-label') === 'View')?.click());
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Book'), { timeout: 5000 });
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Book')?.click());
  await sleep(800);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Both')?.click()); // page turning: swipe + edge taps
  await page.keyboard.press('Escape');
  await sleep(500);
  await page.evaluate(() => document.body.click());
  const start = (await indicator(page)).split('/')[0];
  await shot(page, '51-book-mode');
  const zoomText = await page.evaluate(() => document.querySelector('[data-testid="zoom-level"]')?.textContent || '');
  check('book mode shows one whole page, fitted to the screen', /\d+%/.test(zoomText) && parseInt(zoomText.match(/(\d+)%/)[1], 10) < 120, zoomText);

  await page.keyboard.press('ArrowRight');
  await waitIndicator(page, `${Number(start) + 1}/40`);
  check('the arrow keys turn pages', true);
  await page.keyboard.press('ArrowLeft');
  await waitIndicator(page, `${start}/40`);

  // swipe left = next page, swipe right = previous page (a finger)
  await swipe(page, { x: 900, y: 500 }, { x: 300, y: 505 });
  await waitIndicator(page, `${Number(start) + 1}/40`, 'a left swipe to turn to the next page');
  check('swiping left with a finger turns to the next page', true);
  await swipe(page, { x: 300, y: 500 }, { x: 900, y: 495 });
  await waitIndicator(page, `${start}/40`, 'a right swipe to turn back');
  check('swiping right turns back', true);

  // the outer edge turns the page too
  await page.touchscreen.tap(1240, 500);
  await waitIndicator(page, `${Number(start) + 1}/40`, 'an edge tap to turn the page');
  check('tapping the right edge turns the page', true);
  await page.touchscreen.tap(30, 500);
  await waitIndicator(page, `${start}/40`, 'a left-edge tap to turn back');
  check('tapping the left edge turns back', true);

  // a vertical drag inside a fitted page does not draw or scroll the page away
  const redBefore = await inkPixels(page, 'a > 200 && r < 90 && g < 90 && b < 90');
  await swipe(page, { x: 640, y: 300 }, { x: 645, y: 360 }, 4);
  await sleep(500);
  check('a short drag does not draw (the finger is for reading here)', (await inkPixels(page, 'a > 200 && r < 90 && g < 90 && b < 90')) === redBefore);

  // ----- remember where I was -----
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('ArrowRight');
    await sleep(200);
  }
  const target = `${Number(start) + 6}/40`;
  await waitIndicator(page, target);
  await sleep(4500); // the reading position is saved a moment after you stop
  const prog = (await dumpDb(page)).docs[0];
  check('the reading position is saved with the document', prog.progress?.page === Number(start) + 5, JSON.stringify(prog.progress));
  // The reading style is picked every time a document is opened (see scenarioStyle), so it is not stored with it.
  check('the reading style is not stored with the document', prog.settings?.mode === undefined, JSON.stringify(prog.settings));
  await page.reload({ waitUntil: 'networkidle0' });
  await waitUntil(async () => (await paperStats(page))?.dark > 500, { label: 'the book to reopen' });
  await waitIndicator(page, target, 'the book to reopen on the same page');
  check('reopening resumes on the same page', true);
  await shot(page, '52-resumed');

  check('no page errors', errors.length === 0, errors.join('\n'));
  await ctx.close();
}

// --------------------------------------------------------------------------------------------------

// The out-of-the-box behaviour (no test defaults): sepia paper, and "scroll or book?" on every opening.
async function scenarioStyle(browser, state) {
  section('Reading style is asked on every opening; sepia paper by default');
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await lightMode(page, { defaults: false });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const settings = () => page.evaluate(() => JSON.parse(localStorage.getItem('quarc_reader_settings') || '{}'));
  const remembered = async () => ['scroll', 'book'].includes((await settings()).readMode);
  const openFirstFromLibrary = async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cursor-pointer', { timeout: 10000 });
    await page.evaluate(() => document.querySelector('.cursor-pointer')?.click());
  };
  // The paper's colour, sampled where the page is blank.
  const paperPixel = () =>
    page.evaluate(() => {
      const c = document.querySelector('.quarc-canvas-page canvas');
      const d = c.getContext('2d').getImageData(Math.round(c.width * 0.5), Math.round(c.height * 0.5), 1, 1).data;
      return [d[0], d[1], d[2]];
    });

  await login(page, 'sara');
  await chooseOnImport(page, state.pdfPath, 'device only');
  await page.waitForSelector('[data-testid="style-scroll"]', { timeout: 30000 });
  check('a document asks "scroll or book?" before it opens', !!(await page.$('[data-testid="style-book"]')));
  check('...and nothing is drawn until you choose', (await paperStats(page)) === null);
  check('"remember my choice" starts unticked', (await page.$eval('[data-testid="style-remember"]', (el) => el.checked)) === false);
  await shot(page, '70-reading-style');

  // Book, not remembered.
  await page.click('[data-testid="style-book"]');
  await readerReady(page);
  const [r, g, b] = await paperPixel();
  check('the paper is sepia out of the box', r > 232 && r < 252 && g > 222 && g < 245 && b < 226 && r - b > 18, `rgb(${r},${g},${b})`);
  const zoom = await page.$eval('[data-testid="zoom-level"]', (el) => parseInt(el.textContent, 10));
  check('book mode shows a whole page, fitted', zoom < 120, `${zoom}%`);
  check('a choice that was not remembered is not stored as the default', !(await remembered()));
  await shot(page, '71-book-sepia');

  // Not remembered: asked again.
  await openFirstFromLibrary();
  await page.waitForSelector('[data-testid="style-scroll"]', { timeout: 15000 });
  check('opening it again asks again', true);

  // Scroll, remembered.
  await page.click('[data-testid="style-remember"]');
  await page.click('[data-testid="style-scroll"]');
  await readerReady(page);
  check('"remember my choice" stores the style as the default', (await settings()).readMode === 'scroll', JSON.stringify(await settings()));
  const zoomScroll = await page.$eval('[data-testid="zoom-level"]', (el) => parseInt(el.textContent, 10));
  check('scroll mode fits the page width (zoomed in, unlike book)', zoomScroll > zoom, `${zoomScroll}% vs ${zoom}%`);

  await openFirstFromLibrary();
  await readerReady(page);
  check('with a remembered style the document opens straight away', !(await page.$('[data-testid="style-scroll"]')));

  // Settings: put the question back.
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle0' });
  const pressed = () => page.$$eval('button[aria-pressed="true"]', (els) => els.map((e) => e.innerText.trim()));
  const before = await pressed();
  check('Settings shows the remembered style and sepia as the paper', before.includes('Scroll') && before.includes('Sepia'), before.join());
  await page.evaluate(() => [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.innerText.trim() === 'Ask me')?.click());
  await sleep(300);
  check('"Ask me" in Settings goes back to asking', (await settings()).readMode === 'ask', JSON.stringify(await settings()));
  await shot(page, '72-settings');
  await openFirstFromLibrary();
  await page.waitForSelector('[data-testid="style-scroll"]', { timeout: 15000 });
  check('...and the question comes back', true);

  // The dialog can be left without choosing.
  await page.evaluate(() => [...document.querySelectorAll('button')].find((x) => /Back to library/.test(x.innerText))?.click());
  await page.waitForFunction(() => location.pathname === '/', { timeout: 10000 });
  check('"Back to library" leaves without opening it', true);

  check('no page errors', errors.length === 0, errors.join('\n'));
  await ctx.close();
}

// ---- "Open with": a PDF that reaches the app from outside ------------------------------------------------
// The native halves (Android's OpenWithPlugin, the desktop's main.rs) cannot run here; what runs is the web
// half against stand-ins that behave like them, plus the parts that are really the browser's (launchQueue,
// the service worker's share target).

const IMPORT_DIALOG = 'div[class*="z-[1100]"] [role=dialog]';

async function dialogUp(page) {
  await page.waitForSelector(IMPORT_DIALOG, { timeout: 20000 });
  return page.$eval(IMPORT_DIALOG, (el) => el.innerText);
}

async function chooseInDialog(page, label) {
  await page.evaluate((l) => [...document.querySelectorAll('div[class*="z-[1100]"] [role=dialog] button')].find((b) => b.innerText.includes(l))?.click(), label);
}

async function scenarioOpenWith(browser, state) {
  section('"Open with": a PDF handed to the app from outside');
  const first = readFileSync(state.pdfPath).toString('base64');
  const second = (await makeTestPdf({ title: 'The Whale (test)', pages: 2 })).toString('base64');
  const titles = async (page) => ((await dumpDb(page)).docs || []).map((d) => d.title).sort();

  // ----- Desktop (Tauri): main.rs sets window.__quarcOpenFiles and fires 'quarc-open-files' -----
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await lightMode(page);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // The page the desktop app shows: the Tauri API (only the fs plugin's readFile, only for the files the
    // app allowed) and, as at a cold start, one file already waiting when the page starts.
    await page.evaluateOnNewDocument(
      (pdfs) => {
        const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const allowed = { 'C:\\Users\\sam\\Books\\moby.pdf': pdfs.first, '/home/sam/books/whale.pdf': pdfs.second };
        window.__tauriReads = [];
        window.__TAURI__ = {
          fs: {
            readFile: async (path) => {
              window.__tauriReads.push(path);
              if (!allowed[path]) throw new Error(`forbidden path: ${path}`);
              return bytes(allowed[path]);
            },
          },
        };
        if (!sessionStorage.getItem('started')) {
          sessionStorage.setItem('started', '1');
          window.__quarcOpenFiles = ['C:\\Users\\sam\\Books\\moby.pdf'];
        }
      },
      { first, second }
    );
    await login(page, 'dora');
    const text = await dialogUp(page);
    check('a PDF the desktop app was started with waits for the sign-in, then is offered to the library', /Add 1 PDF/.test(text) && /device only/.test(text), text.slice(0, 80));
    check('it was read through the fs plugin by the path the app gave', (await page.evaluate(() => window.__tauriReads)).join() === 'C:\\Users\\sam\\Books\\moby.pdf');
    check('...and the hand-off list is emptied (a reload does not open it again)', (await page.evaluate(() => window.__quarcOpenFiles)).length === 0);
    await shot(page, '90-open-with-question');
    await chooseInDialog(page, 'device only');
    await readerReady(page);
    check('choosing opens it in the reader, as a device-only document', (await titles(page)).join() === 'Moby Dick (test)' && (await dumpDb(page)).docs[0].sync === 'local');
    const firstId = await page.evaluate(() => location.pathname.split('/').pop());

    // A second launch (or macOS "open") while reading: you are brought to the library and asked.
    await page.evaluate(() => {
      window.__quarcOpenFiles = ['/home/sam/books/whale.pdf'];
      window.dispatchEvent(new Event('quarc-open-files'));
    });
    const text2 = await dialogUp(page);
    check('a PDF opened while you are reading brings you to the library and asks about it', (await page.evaluate(() => location.pathname)) === '/' && /Add 1 PDF/.test(text2));
    await chooseInDialog(page, 'device only');
    await readerReady(page);
    check('the second one opens too', (await titles(page)).join() === 'Moby Dick (test),The Whale (test)');

    // One you already have is simply opened: nothing to ask.
    await page.evaluate(() => {
      window.__quarcOpenFiles = ['C:\\Users\\sam\\Books\\moby.pdf'];
      window.dispatchEvent(new Event('quarc-open-files'));
    });
    await page.waitForFunction((id) => location.pathname === `/read/${id}`, { timeout: 20000 }, firstId);
    check('a PDF that is already in the library opens straight away, without the question and without a copy', !(await page.$(IMPORT_DIALOG)) && (await titles(page)).length === 2);

    // A path the app did not allow cannot be read: said so, nothing added.
    await page.evaluate(() => {
      window.__quarcOpenFiles = ['C:\\Windows\\secret.pdf'];
      window.dispatchEvent(new Event('quarc-open-files'));
    });
    await waitUntil(async () => /could not be opened from the other app/.test(await page.evaluate(() => document.body.innerText)), { label: 'the failure notice' });
    check('a file that cannot be read is reported, not silently dropped', (await titles(page)).length === 2);
    check('no page errors', errors.length === 0, errors.join('\n'));
    await ctx.close();
  }

  // ----- Installed PWA: the browser's file handler (manifest file_handlers → launchQueue) -----
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await lightMode(page);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(window, 'launchQueue', { configurable: true, value: { setConsumer: (fn) => (window.__launchConsumer = fn) } });
    });
    await login(page, 'eli');
    check('the app registers as the launch handler for PDFs', await page.evaluate(() => typeof window.__launchConsumer === 'function'));
    await page.evaluate(async (b64) => {
      const file = new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'Moby.pdf', { type: 'application/pdf' });
      await window.__launchConsumer({ files: [{ getFile: async () => file }] });
    }, first);
    const text = await dialogUp(page);
    check('a PDF opened with the installed app is offered to the library', /Add 1 PDF/.test(text));
    await chooseInDialog(page, 'device only');
    await readerReady(page);
    check('...and opens', (await titles(page)).join() === 'Moby Dick (test)');
    const manifest = await (await page.goto(`${BASE}/manifest.json`)).json();
    check('the manifest declares the PDF file handler and the share target', manifest.file_handlers?.[0]?.accept?.['application/pdf'] && manifest.share_target?.params?.files?.[0]?.name === 'pdf', JSON.stringify(manifest.share_target));
    check('no page errors', errors.length === 0, errors.join('\n'));
    await ctx.close();
  }

  // ----- Installed PWA: the share sheet (manifest share_target → the service worker) -----
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await lightMode(page);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await login(page, 'fay');
    await page.waitForFunction(() => navigator.serviceWorker?.controller, { timeout: 20000 });
    // What the system does: a real multipart POST navigation to the share target.
    await page.evaluate((b64) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'Shared Book.pdf', { type: 'application/pdf' }));
      const form = Object.assign(document.createElement('form'), { method: 'POST', action: '/share-target', enctype: 'multipart/form-data' });
      const input = Object.assign(document.createElement('input'), { type: 'file', name: 'pdf' });
      input.files = data.files;
      form.append(input);
      document.body.append(form);
      form.submit();
    }, first);
    const text = await dialogUp(page);
    check('a PDF shared to the installed app comes out of the service worker and is offered to the library', /Add 1 PDF/.test(text), text.slice(0, 80));
    check('...and the address bar is back to a plain page', !(await page.evaluate(() => location.search)));
    check('the service worker keeps nothing once the app has it', await page.evaluate(async () => (await (await caches.open('quarc-reader-incoming')).keys()).length === 0));
    await chooseInDialog(page, 'device only');
    await readerReady(page);
    check('...and it opens', (await titles(page)).join() === 'Moby Dick (test)');
    check('no page errors', errors.length === 0, errors.join('\n'));
    await ctx.close();
  }

  // ----- Android: the web half, against a stand-in for OpenWithPlugin.java -----
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await lightMode(page);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await login(page, 'gus'); // signed in first, so the stand-in only has to be the plugin
    await page.evaluateOnNewDocument(
      (pdfs) => {
        const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        // What the plugin has copied into the app's cache; each file is served by "convertFileSrc".
        const urls = {};
        const copy = (path, b64) => (urls[path] = URL.createObjectURL(new Blob([bytes(b64)], { type: 'application/pdf' })));
        copy('/data/cache/incoming/aaa.pdf', pdfs.first);
        copy('/data/cache/incoming/bbb.pdf', pdfs.second);
        const batches = [{ files: [{ path: '/data/cache/incoming/aaa.pdf', name: 'Moby.pdf', size: 1 }], failed: 0 }];
        window.__discarded = [];
        window.__plugin = {
          queue: (batch) => batches.push(batch),
          emit: () => window.__incoming?.(),
        };
        window.Capacitor = {
          isNativePlatform: () => true,
          convertFileSrc: (p) => urls[p] || 'about:blank',
          Plugins: {
            OpenWith: {
              takePending: async () => batches.shift() || { files: [], failed: 0 },
              discard: async ({ paths }) => window.__discarded.push(...paths),
              addListener: (name, fn) => {
                if (name === 'incoming') window.__incoming = fn;
                return { remove: async () => {} };
              },
            },
          },
        };
      },
      { first, second }
    );
    await page.reload({ waitUntil: 'networkidle0' });
    // Cold start: the plugin already has a file when the page asks.
    const text = await dialogUp(page);
    check('a PDF the plugin copied before the page started is offered to the library', /Add 1 PDF/.test(text), text.slice(0, 80));
    check('the cached copy is deleted once it has been read', (await page.evaluate(() => window.__discarded)).join() === '/data/cache/incoming/aaa.pdf');
    await chooseInDialog(page, 'device only');
    await readerReady(page);
    check('...and it opens', (await titles(page)).join() === 'Moby Dick (test)');

    // Warm: another app shares a file (and one that could not be copied) while this one is open.
    await page.evaluate(() => {
      window.__plugin.queue({ files: [{ path: '/data/cache/incoming/bbb.pdf', name: 'Whale.pdf', size: 1 }], failed: 1 });
      window.__plugin.emit();
    });
    const text2 = await dialogUp(page);
    check('a PDF shared while the app is open brings you to the library and asks', (await page.evaluate(() => location.pathname)) === '/' && /Add 1 PDF/.test(text2));
    check('a file the plugin could not copy is reported', /could not be opened from the other app/.test(await page.evaluate(() => document.body.innerText)));
    await chooseInDialog(page, 'device only');
    await readerReady(page);
    check('the shared PDF opens', (await titles(page)).join() === 'Moby Dick (test),The Whale (test)');
    check('no page errors', errors.length === 0, errors.join('\n'));
    await ctx.close();
  }
}

// ---- Find in text (Ctrl+F) ----------------------------------------------------------------------------------

async function scenarioFind(browser, state) {
  section('Find in text (Ctrl+F)');
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await lightMode(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const ctrl = async (key) => {
    await page.keyboard.down('Control');
    await page.keyboard.press(key);
    await page.keyboard.up('Control');
  };
  const countText = () => page.$eval('[data-testid="find-count"]', (el) => el.innerText).catch(() => null);
  const waitCount = (want, timeout = 20000) => waitUntil(async () => (await countText()) === want, { timeout, label: `the find count to read "${want}"` });
  const pageNo = async () => parseInt((await page.$eval('[data-testid="page-counter"]', (el) => el.innerText)).split('/')[0], 10);
  // Pixels of the find colours on the highlight canvas: [all hits, the current hit].
  const hitPixels = () =>
    page.evaluate(() => {
      const c = [...document.querySelectorAll('.quarc-canvas-page canvas')].find((x) => x.style.mixBlendMode === 'multiply');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const near = (i, [r, g, b]) => Math.abs(d[i] - r) < 5 && Math.abs(d[i + 1] - g) < 5 && Math.abs(d[i + 2] - b) < 5 && d[i + 3] > 250;
      let hit = 0;
      let current = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (near(i, [211, 194, 255])) hit++;
        else if (near(i, [169, 139, 255])) current++;
      }
      return [hit, current];
    });
  const inputFocused = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'find-input');
  // Where the current hit is on screen: its bounding box on the highlight canvas, and how tall the canvas is.
  const currentBox = () =>
    page.evaluate(() => {
      const c = [...document.querySelectorAll('.quarc-canvas-page canvas')].find((x) => x.style.mixBlendMode === 'multiply');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let top = Infinity;
      let bottom = -1;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          if (Math.abs(d[i] - 169) < 5 && Math.abs(d[i + 1] - 139) < 5 && Math.abs(d[i + 2] - 255) < 5 && d[i + 3] > 250) {
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
      }
      return { top, bottom, height: c.height };
    });

  await login(page, 'hana');
  await chooseOnImport(page, state.pdfPath, 'device only');
  await readerReady(page);

  await ctrl('KeyF');
  await page.waitForSelector('[data-testid="find-bar"]', { timeout: 5000 });
  check('Ctrl+F opens the find bar with the cursor in it', await inputFocused());
  check('...where the tool dock was', !(await page.$('[data-testid="tool-pen"]')));
  check('...and Excalidraw\'s own search did not open', !(await page.$('.excalidraw .sidebar, .excalidraw .search-input')));

  await page.keyboard.type('ishmael');
  await waitCount('1 of 3');
  check('typing finds every hit in the book: "ishmael" is on 3 pages', true);
  await waitUntil(async () => (await hitPixels())[1] > 100, { label: 'the current hit to be drawn' });
  check('the current hit is drawn on the page', true);
  await shot(page, '95-find');

  await page.keyboard.press('Enter');
  await waitCount('2 of 3');
  await waitUntil(async () => (await pageNo()) === 2, { label: 'page 2' });
  check('Enter goes to the next hit, on the next page', true);
  await waitUntil(async () => (await hitPixels())[1] > 100, { label: 'the hit on page 2 to be drawn' });
  const box = await currentBox();
  check('...and it is on screen, clear of the find bar and the page bar', box.top >= 76 && box.bottom <= box.height - 72, JSON.stringify(box));

  await page.keyboard.down('Shift');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Shift');
  await waitCount('1 of 3');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Shift');
  await waitCount('3 of 3');
  await waitUntil(async () => (await pageNo()) === 3, { label: 'page 3' });
  check('Shift+Enter goes back, and wraps round the book', true);
  await page.keyboard.press('F3');
  await waitCount('1 of 3');
  check('F3 is "next" too, and wraps', true);

  // The same word in capitals, and a phrase over a line break.
  await ctrl('KeyF');
  check('Ctrl+F again selects the text in the box', await page.evaluate(() => { const i = document.activeElement; return i?.selectionStart === 0 && i?.selectionEnd === i?.value.length && i.value.length > 0; }));
  await page.keyboard.type('ISHMAEL');
  await waitUntil(async () => /of 3$/.test((await countText()) || ''), { label: 'the count for ISHMAEL' });
  check('case does not matter', true);
  await ctrl('KeyF');
  await page.keyboard.type('particular to interest');
  await waitUntil(async () => /of 3$/.test((await countText()) || ''), { label: 'the count over a line break' });
  check('a phrase that runs over a line break is found', true);

  // Accents: the toggle is there, remembered, and does not break plain words.
  await page.click('[data-testid="find-accents"]');
  check('the accent switch is remembered in the settings', await waitUntil(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('quarc_reader_settings')).findAccents)) === true, { label: 'findAccents' }).then(() => true));
  await ctrl('KeyF');
  await page.keyboard.type('chapter');
  await waitUntil(async () => /of 3$/.test((await countText()) || ''), { label: 'the count with accents on' });
  check('plain words are found with accents on, too', true);
  await page.click('[data-testid="find-accents"]');

  // Nothing found.
  await ctrl('KeyF');
  await page.keyboard.type('zzzzzz');
  await waitUntil(async () => (await countText()) === 'No matches', { label: 'No matches' });
  await sleep(300);
  const [hits, current] = await hitPixels();
  check('a word that is not there says so and draws nothing', hits === 0 && current === 0, `${hits}/${current} px`);

  // Escape: gone, the dock is back, the hits are off the page.
  await ctrl('KeyF');
  await page.keyboard.type('ishmael');
  await waitCount('1 of 3');
  await page.keyboard.press('Escape');
  await waitUntil(async () => !(await page.$('[data-testid="find-bar"]')), { label: 'the bar to close' });
  await waitUntil(async () => (await hitPixels()).every((n) => n === 0), { label: 'the hits to leave the page' });
  check('Escape closes the bar and takes the hits off the page', true);
  check('...and the tool dock is back', !!(await page.$('[data-testid="tool-pen"]')));

  // The button in the bar, and the last word is still there.
  await page.click('button[aria-label="Find in document"]');
  await page.waitForSelector('[data-testid="find-bar"]');
  check('the search button opens it too, with the last search still in the box', (await page.$eval('[data-testid="find-input"]', (el) => el.value)) === 'ishmael');
  await waitCount('1 of 3');
  await page.click('[data-testid="find-close"]');
  check('no page errors', errors.length === 0, errors.join('\n'));
  await ctx.close();

  // ----- book mode: one page at a time -----
  {
    const ctx2 = await browser.createBrowserContext();
    const p2 = await ctx2.newPage();
    await lightMode(p2, { defaults: false });
    await testDefaults(p2, { readMode: 'book' });
    const errors2 = [];
    p2.on('pageerror', (e) => errors2.push(e.message));
    await login(p2, 'ian');
    await chooseOnImport(p2, state.pdfPath, 'device only');
    await readerReady(p2);
    await p2.keyboard.down('Control');
    await p2.keyboard.press('KeyF');
    await p2.keyboard.up('Control');
    await p2.keyboard.type('chapter 3');
    await p2.waitForFunction(() => document.querySelector('[data-testid="find-count"]')?.innerText === '1 of 1', { timeout: 20000 });
    await waitUntil(async () => parseInt((await p2.$eval('[data-testid="page-counter"]', (el) => el.innerText)).split('/')[0], 10) === 3, { label: 'book mode to turn to page 3' });
    check('in book mode a hit turns to its page', true);
    const zoomBook = await p2.$eval('[data-testid="zoom-level"]', (el) => parseInt(el.textContent, 10));
    check('...and the page is shown whole, as in a book', zoomBook < 120, `${zoomBook}%`);
    await shot(p2, '96-find-book');
    check('no page errors (book mode)', errors2.length === 0, errors2.join('\n'));
    await ctx2.close();
  }

  // ----- a long book: far hits, counted in the background -----
  {
    const long = writePdf('find-300.pdf', await makeTestPdf({ pages: 300, title: 'Long Book (test)' }));
    const ctx3 = await browser.createBrowserContext();
    const p3 = await ctx3.newPage();
    await lightMode(p3);
    const errors3 = [];
    p3.on('pageerror', (e) => errors3.push(e.message));
    await login(p3, 'jules');
    await chooseOnImport(p3, long, 'device only');
    await readerReady(p3);
    await p3.keyboard.down('Control');
    await p3.keyboard.press('KeyF');
    await p3.keyboard.up('Control');
    const t0 = Date.now();
    await p3.keyboard.type('chapter 250');
    await p3.waitForFunction(() => document.querySelector('[data-testid="find-count"]')?.innerText === '1 of 1', { timeout: 40000 });
    const took = Date.now() - t0;
    await waitUntil(async () => parseInt((await p3.$eval('[data-testid="page-counter"]', (el) => el.innerText)).split('/')[0], 10) === 250, { label: 'the view to reach page 250' });
    check('a hit 250 pages away is found and shown', true, `${took} ms`);
    await waitUntil(
      async () =>
        p3.evaluate(() => {
          const c = [...document.querySelectorAll('.quarc-canvas-page canvas')].find((x) => x.style.mixBlendMode === 'multiply');
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 169) < 5 && Math.abs(d[i + 1] - 139) < 5 && Math.abs(d[i + 2] - 255) < 5 && d[i + 3] > 250) return true;
          return false;
        }),
      { label: 'the far hit to be drawn', timeout: 15000 }
    );
    check('...and drawn where it is', true);
    check('searching all 300 pages takes a few seconds, not minutes', took < 30000, `${took} ms`);
    await shot(p3, '97-find-far');
    // Every page has "ishmael": the whole count comes in while reading.
    await p3.keyboard.down('Control');
    await p3.keyboard.press('KeyF');
    await p3.keyboard.up('Control');
    await p3.keyboard.type('ishmael');
    await p3.waitForFunction(() => /of 300$/.test(document.querySelector('[data-testid="find-count"]')?.innerText || ''), { timeout: 40000 });
    check('a word on every page is counted: 300 hits', true);
    check('no page errors (long book)', errors3.length === 0, errors3.join('\n'));
    await ctx3.close();
  }
}

// ---- A web server that does not know ".mjs" ----------------------------------------------------------------------

// pdf.js' worker is a module script; a server that sends ".mjs" files as a generic download (older nginx images) makes the
// browser refuse it and EVERY PDF then fails to open. This serves the production build the way such a server does.
async function scenarioMime(browser, state) {
  section('A web server that serves ".mjs" as a generic download (older nginx): PDFs still open');
  const http = await import('node:http');
  const { readFileSync, existsSync, statSync, readdirSync } = await import('node:fs');
  const { join, extname } = await import('node:path');
  const dist = join(ROOT, 'frontend', 'dist');
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
  const mimeOf = (p) => MIME[extname(p).toLowerCase()] || 'application/octet-stream'; // ".mjs" is not in the table
  const proxy = (req, res, port) => {
    const up = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/auth/')) return proxy(req, res, PORTS.auth);
    if (req.url.startsWith('/api/')) return proxy(req, res, PORTS.backend);
    let file = join(dist, decodeURIComponent(req.url.split('?')[0]));
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
    res.writeHead(200, { 'Content-Type': mimeOf(file) });
    res.end(readFileSync(file));
  });
  const port = PORTS.web + 7;
  await new Promise((resolve) => server.listen(port, resolve));
  const ctx = await browser.createBrowserContext();
  try {
    const mjs = readdirSync(join(dist, 'assets')).filter((n) => /\.mjs$/i.test(n));
    check('no asset of the build keeps the ".mjs" name (the PDF worker is ".js")', mjs.length === 0 && readdirSync(join(dist, 'assets')).some((n) => /^pdf\.worker.*\.js$/.test(n)), mjs.join());

    const page = await ctx.newPage();
    await testDefaults(page);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const B = `http://localhost:${port}`;
    await page.goto(`${B}/login`, { waitUntil: 'networkidle0' });
    await page.type('input[placeholder="Username"]', 'mimi');
    await page.type('input[placeholder="Password"]', 'pw');
    await Promise.all([page.waitForFunction(() => location.pathname === '/', { timeout: 15000 }), page.click('button[type=submit]')]);
    await chooseOnImport(page, state.pdfPath, 'device only');
    await readerReady(page);
    check('adding a PDF and reading it works through such a server', true);
    check('...and the page is drawn (the PDF engine did load)', ((await paperStats(page))?.dark || 0) > 500);
    check('no page errors', errors.length === 0, errors.join('\n'));
  } finally {
    await ctx.close();
    server.close();
  }
}

// ---- The screen stays on while a document is open ---------------------------------------------------------------

async function scenarioAwake(browser, state) {
  section('The screen is kept on while reading');
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await lightMode(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // A stand-in for the Screen Wake Lock API that records what the app asks for.
  await page.evaluateOnNewDocument(() => {
    window.__wl = { log: [], held: 0, drop: () => {} };
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: async (type) => {
          window.__wl.log.push(`request ${type}`);
          window.__wl.held++;
          const handlers = [];
          const lock = {
            released: false,
            addEventListener: (_t, fn) => handlers.push(fn),
            release: async () => {
              if (lock.released) return;
              lock.released = true;
              window.__wl.held--;
              window.__wl.log.push('release');
            },
          };
          // what a browser does to the lock of a page that has been hidden
          window.__wl.drop = () => {
            if (lock.released) return;
            lock.released = true;
            window.__wl.held--;
            handlers.forEach((h) => h());
          };
          return lock;
        },
      },
    });
  });
  const wl = () => page.evaluate(() => window.__wl);
  const setSwitch = async (on) => {
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle0' });
    const sw = await page.evaluateHandle(() => [...document.querySelectorAll('p')].find((p) => p.textContent === 'Keep the screen on while reading').parentElement.parentElement.querySelector('[role=switch]'));
    if (((await sw.evaluate((el) => el.getAttribute('aria-checked'))) === 'true') !== on) await sw.click();
    return (await sw.evaluate((el) => el.getAttribute('aria-checked'))) === (on ? 'true' : 'false');
  };

  await login(page, 'wanda');
  await chooseOnImport(page, state.pdfPath, 'device only');
  await readerReady(page);
  await waitUntil(async () => (await wl()).held === 1, { label: 'the screen lock while reading' });
  check('opening a document asks for the screen to be kept on', (await wl()).log[0] === 'request screen');

  await page.click('button[aria-label="Back to library"]');
  await page.waitForFunction(() => location.pathname === '/', { timeout: 10000 });
  await waitUntil(async () => (await wl()).held === 0, { label: 'the screen lock to be let go' });
  check('leaving the document lets the screen go', true);

  await page.evaluate(() => (window.__wl.log.length = 0));
  await sleep(500);
  check('the library alone does not keep the screen on', (await wl()).held === 0 && (await wl()).log.length === 0);

  // hidden and shown again: the browser drops its lock when the page is hidden, the app asks again when it is shown
  await page.evaluate(() => document.querySelector('.cursor-pointer')?.click());
  await readerReady(page);
  await waitUntil(async () => (await wl()).held === 1, { label: 'the lock again' });
  await page.evaluate(() => {
    window.__hidden = true;
    window.__wl.drop(); // the browser lets the lock of a hidden page go
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__hidden ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(300);
  const hiddenLog = (await wl()).log.filter((l) => l === 'request screen').length;
  await page.evaluate(() => {
    window.__hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(500);
  check('nothing is asked for while the page is hidden', hiddenLog === 1, `${hiddenLog} requests`);
  check('...and when the page is shown again the screen is kept on again', (await wl()).log.filter((l) => l === 'request screen').length === 2);

  // the setting
  check('Settings has a switch for it, on by default', await setSwitch(true));
  check('switched off in Settings', await setSwitch(false));
  await page.evaluate(() => (window.__wl.log.length = 0));
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.querySelector('.cursor-pointer')?.click());
  await readerReady(page);
  await sleep(600);
  check('with the switch off, an open document does not ask for it', (await wl()).held === 0 && !(await wl()).log.includes('request screen'));

  check('no page errors', errors.length === 0, errors.join('\n'));
  await ctx.close();
}

// ---- When a synced document will not open: say why, and mend what can be mended ---------------------------------

async function scenarioErrors(browser, state) {
  section('A synced document that will not open: the reason is told, not just "could not be opened"');
  const { readdirSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await lightMode(page);
  await testDefaults(page, { autoCache: false }); // a second device that keeps no copy of its own
  await page.setCacheEnabled(false); // the server's answers must really be asked for, not remembered by the browser
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const message = () => page.$eval('[data-testid="reader-error"]', (el) => el.innerText).catch(() => '');
  const detail = () => page.$eval('[data-testid="reader-error-detail"]', (el) => el.innerText).catch(() => '');
  const open = async (id) => page.goto(`${BASE}/read/${id}`, { waitUntil: 'networkidle0' });
  // A second device: the file is on the server, not in this browser.
  const dropLocalCopy = () =>
    page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const r = indexedDB.open('quarc-reader');
          r.onerror = () => reject(r.error);
          r.onsuccess = () => {
            const db = r.result;
            const tx = db.transaction('blobs', 'readwrite');
            tx.objectStore('blobs').clear();
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
          };
        })
    );

  await login(page, 'olga');
  await chooseOnImport(page, state.pdfPath, 'Sync with my server');
  await readerReady(page);
  const doc = await waitUntil(async () => {
    const p = await serverPull(page);
    return p.docs?.length === 1 && p.docs[0].file_ready ? p.docs[0] : null;
  }, { timeout: 30000, label: 'the file to reach the server' });
  await dropLocalCopy();

  // ----- the healthy case first: read from the server -----
  await open(doc.id);
  await readerReady(page);
  check('read from the server (this device has no copy), the document opens', ((await dumpDb(page)).blobs || []).length === 0);

  // ----- the sign-in has expired (the cookie is gone, the library still shows) -----
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.deleteCookie(...(await page.cookies()));
  await page.waitForSelector('.cursor-pointer', { timeout: 10000 });
  await page.evaluate(() => document.querySelector('.cursor-pointer')?.click());
  await waitUntil(async () => /sign-in has expired/.test(await message()), { timeout: 20000, label: 'the sign-in message' });
  check('an expired sign-in says so (not "could not be opened as a PDF")', /Sign in again to read it/.test(await message()), await message());
  check('...with what the server answered, for the record', /HTTP 401/.test(await detail()), await detail());
  await shot(page, '100-error-signin');
  await page.click('[data-testid="reader-signin"]');
  await page.waitForFunction(() => location.pathname === '/login', { timeout: 10000 });
  check('"Sign in again" goes to the sign-in page', true);
  await login(page, 'olga');

  // ----- a damaged copy on this device -----
  await page.evaluate(
    (sha) =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('quarc-reader');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction('blobs', 'readwrite');
          const junk = new Blob(['<html>this is not a PDF</html>'], { type: 'application/pdf' });
          tx.objectStore('blobs').put({ sha256: sha, blob: junk, size: junk.size, last_used: Date.now() });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
        };
      }),
    doc.file_sha256
  );
  check('a damaged copy is on this device (an error page that was saved as the PDF)', ((await dumpDb(page)).blobs || []).length === 1);
  await open(doc.id);
  await readerReady(page);
  check('...and is dropped by itself: the document opens from the server', ((await dumpDb(page)).blobs || []).length === 0 && !(await page.$('[data-testid="reader-error"]')));

  // ----- the server no longer has the file -----
  for (const user of readdirSync(join(state.dataDir, 'files'))) rmSync(join(state.dataDir, 'files', user, doc.file_sha256), { force: true });
  await open(doc.id);
  await waitUntil(async () => /does not have this file/.test(await message()), { timeout: 20000, label: 'the missing-file message' });
  check('a file the server does not have says so', /does not have this file/.test(await message()), await message());
  check('...and offers to try again', await page.$$eval('button', (els) => els.some((b) => b.innerText.trim() === 'Try again')));
  await shot(page, '102-error-gone');

  check('no page errors', errors.length === 0, errors.join('\n'));
  await ctx.close();
}

// ---- The dock: the eraser, colours, the colour history and the picker -----------------------------------------

async function scenarioDock(browser, state) {
  section('The dock: eraser button, colour history and picker');
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await lightMode(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const settings = () => page.evaluate(() => JSON.parse(localStorage.getItem('quarc_reader_settings') || '{}'));
  const elements = async () => ((await dumpDb(page)).ann || []).flatMap((r) => JSON.parse(r.ink_json).elements);
  const pressed = (testId) => page.$eval(`[data-testid="${testId}"]`, (el) => el.getAttribute('aria-pressed'));
  const openMore = async () => {
    await page.click('[data-testid="color-more"]');
    await page.waitForSelector('[data-testid="color-picker"]');
  };
  const recent = () => page.$$eval('[data-testid="recent-color"]', (els) => els.map((e) => e.getAttribute('data-color')));

  await login(page, 'kim');
  await chooseOnImport(page, state.pdfPath, 'device only');
  await readerReady(page);
  const box = await page.$eval('.quarc-canvas-page', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });

  // ----- the eraser is on the dock, not in the Tools flyout -----
  check('the eraser has its own button on the dock', !!(await page.$('[data-testid="tool-eraser"]')));
  await page.click('[data-testid="tools-menu"]');
  await page.waitForSelector('[data-testid="tool-rectangle"]', { visible: true });
  check('...and is no longer in the Tools flyout', (await page.$$('[data-testid="tool-eraser"]')).length === 1);
  await page.keyboard.press('Escape');

  await page.click('button[aria-label="#e03131"]');
  await drawStroke(page, { x: box.x + 300, y: box.y + 600 }, { x: box.x + 700, y: box.y + 604 });
  await sleep(1600);
  check('a stroke is drawn', (await elements()).filter((e) => !e.isDeleted).length === 1);

  await page.click('[data-testid="tool-eraser"]');
  check('the eraser button turns the eraser on', (await pressed('tool-eraser')) === 'true' && (await pressed('tool-pen')) !== 'true');
  await page.mouse.move(box.x + 500, box.y + 560);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(box.x + 500, box.y + 560 + i * 10);
    await sleep(15);
  }
  await page.mouse.up();
  await sleep(1600);
  const afterErase = await elements();
  check('dragging it across the stroke erases it (stored as a deletion)', afterErase.filter((e) => !e.isDeleted).length === 0 && afterErase.some((e) => e.isDeleted));
  await page.click('[data-testid="tool-eraser"]');
  check('pressing it again goes back to the pen', (await pressed('tool-pen')) === 'true' && (await pressed('tool-eraser')) !== 'true');

  // ----- colours: history, the picker, a hex code -----
  await openMore();
  check('the colour list opens with a picker', !!(await page.$('[data-testid="color-area"]')) && !!(await page.$('[data-testid="color-hue"]')) && !!(await page.$('[data-testid="color-hex"]')));
  check('the colour used so far (the red of the first stroke) is in the history', (await recent()).join() === '#e03131', (await recent()).join());
  await shot(page, '98-colour-picker');
  await page.keyboard.press('Escape');

  await page.click('button[aria-label="#1971c2"]');
  await page.click('button[aria-label="#2f9e44"]');
  await openMore();
  check('colours that were used are listed, newest first', (await recent()).join() === '#2f9e44,#1971c2,#e03131', (await recent()).join());

  await page.click('[data-testid="color-hex"]', { clickCount: 3 });
  await page.keyboard.type('#12ab34');
  await page.keyboard.press('Enter');
  await waitUntil(async () => (await settings()).penColor === '#12ab34', { label: 'the typed colour to be used' });
  check('a hex code that is typed becomes the pen colour', true);
  check('...and goes to the top of the history', (await recent()).join() === '#12ab34,#2f9e44,#1971c2,#e03131', (await recent()).join());

  // dragging in the square
  const area = await page.$eval('[data-testid="color-area"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.move(area.x + area.w * 0.8, area.y + area.h * 0.3);
  await page.mouse.down();
  await page.mouse.move(area.x + area.w * 0.6, area.y + area.h * 0.4, { steps: 5 });
  await page.mouse.up();
  const dragged = (await settings()).penColor;
  check('dragging in the colour square picks a colour', /^#[0-9a-f]{6}$/.test(dragged) && dragged !== '#12ab34', dragged);
  check('...which is remembered too: once, when let go (leaving the hex box does not add another)', (await recent())[0] === dragged && (await recent()).length === 5, (await recent()).join());

  // the hue slider: holding an arrow key is one colour in the history, not twenty
  const before = (await settings()).penColor;
  await page.focus('[data-testid="color-hue"]');
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
  await waitUntil(async () => (await settings()).penColor !== before, { label: 'the hue slider to change the colour' });
  await sleep(300);
  check('the hue slider changes the colour', true);
  check('...as one entry in the history, however many key presses', (await recent()).length === 6 && (await recent())[1] === dragged, (await recent()).join());

  // a wrong code is not a colour: back to the one in use
  const inUse = (await settings()).penColor;
  await page.click('[data-testid="color-hex"]', { clickCount: 3 });
  await page.keyboard.type('zzz');
  await page.keyboard.press('Enter');
  check('something that is not a colour code is ignored', (await settings()).penColor === inUse && (await page.$eval('[data-testid="color-hex"]', (el) => el.value.toLowerCase())) === inUse);

  // a colour from the list
  await page.click('[data-testid="recent-color"][data-color="#1971c2"]');
  await waitUntil(async () => (await settings()).penColor === '#1971c2', { label: 'a recent colour to be picked' });
  check('a colour from the history can be picked again', (await recent())[0] === '#1971c2', (await recent()).join());
  await page.keyboard.press('Escape');

  // it draws with the chosen colour
  await page.click('[data-testid="color-more"]');
  await page.click('[data-testid="color-hex"]', { clickCount: 3 });
  await page.keyboard.type('#12ab34');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await drawStroke(page, { x: box.x + 300, y: box.y + 650 }, { x: box.x + 700, y: box.y + 654 });
  await sleep(1600);
  const stroke = (await elements()).filter((e) => !e.isDeleted && e.type === 'freedraw').pop();
  check('the pen draws in the colour that was typed', stroke?.strokeColor === '#12ab34', stroke?.strokeColor);

  // the history is kept
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-testid="color-more"]', { timeout: 15000 }).catch(() => {});
  await readerReady(page);
  await openMore();
  check('the history is still there after reopening', (await recent())[0] === '#12ab34' && (await recent()).includes('#1971c2'), (await recent()).join());
  await page.keyboard.press('Escape');

  // the highlighter has a history of its own
  await page.click('[data-testid="tool-highlighter"]');
  await openMore();
  check('the highlighter has its own history (empty here, and it says so)', (await recent()).length === 0 && /colours you use will be listed here/i.test(await page.evaluate(() => document.body.innerText)), (await recent()).join());
  await page.keyboard.press('Escape');

  check('no page errors', errors.length === 0, errors.join('\n'));
  await ctx.close();
}

// ---- Snip: copy or save a region of a page, and paste ------------------------------------------------------------

async function scenarioSnip(browser, state) {
  section('Snip a region: copy, save, copy text; paste');
  const { mkdtempSync, readdirSync, statSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const downloads = mkdtempSync(join(tmpdir(), 'quarc-reader-snip-'));
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(BASE, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  const bsession = await browser.target().createCDPSession();
  await bsession.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, browserContextId: ctx.id });
  const page = await ctx.newPage();
  await lightMode(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const ctrl = async (key) => {
    await page.keyboard.down('Control');
    await page.keyboard.press(key);
    await page.keyboard.up('Control');
  };
  const hint = () => page.$eval('[data-testid="snip-hint"]', (el) => el.innerText).catch(() => '');
  const regionSize = async () => {
    const m = /(\d+) × (\d+)/.exec(await hint());
    return m ? { w: +m[1], h: +m[2] } : null;
  };
  const spanBox = (text) =>
    page.evaluate((t) => {
      const s = [...document.querySelectorAll('.quarc-text-layer span')].find((x) => x.textContent.includes(t));
      if (!s) return null;
      const r = s.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, text);
  const drag = async (a, b, steps = 10) => {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps });
    await page.mouse.up();
  };
  // The picture on the clipboard: its size and what is in it.
  const clipImage = () =>
    page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const item = items.find((i) => i.types.includes('image/png'));
      if (!item) return null;
      const bmp = await createImageBitmap(await item.getType('image/png'));
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const cx = c.getContext('2d');
      cx.drawImage(bmp, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      let red = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 200 && d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) dark++;
        if (d[i + 3] > 200 && d[i] > 170 && d[i + 1] < 90 && d[i + 2] < 90) red++;
      }
      return { w: c.width, h: c.height, dark, red, corner: [...cx.getImageData(2, 2, 1, 1).data] };
    });
  // How dim the snip canvas is (alpha 0–255) at a point outside the region and at one inside it (client coordinates).
  const snipPixels = (outside, inside) =>
    page.evaluate(
      (o, i) => {
        const c = [...document.querySelectorAll('.quarc-canvas-page canvas')].find((x) => x.style.zIndex === '4');
        const r = c.getBoundingClientRect();
        const alphaAt = (p) => c.getContext('2d').getImageData(Math.round((p.x - r.left) * (c.width / r.width)), Math.round((p.y - r.top) * (c.height / r.height)), 1, 1).data[3];
        return { outside: alphaAt(o), inside: alphaAt(i) };
      },
      outside,
      inside
    );
  const elements = async () => ((await dumpDb(page)).ann || []).flatMap((r) => JSON.parse(r.ink_json).elements).filter((e) => !e.isDeleted);

  await login(page, 'lea');
  await chooseOnImport(page, state.pdfPath, 'device only');
  await readerReady(page);
  await page.bringToFront();

  // a red stroke between the heading and the first line (it is in the region) — drawn before the tool is on
  await page.click('button[aria-label="#e03131"]');
  const box = await page.$eval('.quarc-canvas-page', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });

  await page.click('[data-testid="tool-snip"]');
  await page.waitForSelector('[data-testid="snip-bar"]');
  check('the Snip button on the dock opens the snip bar, in place of the dock', !(await page.$('[data-testid="tool-pen"]')));
  check('it says what to do, and nothing can be copied yet', /Drag on a page/.test(await hint()) && (await page.$eval('[data-testid="snip-copy"]', (el) => el.disabled)));

  await waitUntil(async () => (await spanBox('Call me Ishmael')) && (await spanBox('Chapter 1')), { label: 'the page text to be laid out' });
  const head = await spanBox('Chapter 1');
  const line = await spanBox('Call me Ishmael');
  const a = { x: Math.min(head.x, line.x) - 20, y: head.y - 12 };
  const b = { x: line.x + line.w + 20, y: line.y + line.h + 6 };
  await drag(a, b);
  await waitUntil(async () => (await regionSize()) !== null, { label: 'the region size' });
  const size1 = await regionSize();
  check('dragging on the page chooses a region, and its size is shown', size1.w > 300 && size1.h > 60, JSON.stringify(size1));
  check('...which enables copying', !(await page.$eval('[data-testid="snip-copy"]', (el) => el.disabled)));
  const px = await snipPixels({ x: 60, y: b.y + 150 }, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  check('everything outside the region is dimmed, inside it is clear', px.outside > 60 && px.inside === 0, JSON.stringify(px));
  await shot(page, '99-snip');

  // ----- copy the picture with Ctrl+C -----
  await ctrl('KeyC');
  const first = await waitUntil(async () => (await clipImage()) || null, { timeout: 20000, label: 'the picture on the clipboard' });
  check('Ctrl+C puts a picture of the region on the clipboard', first.w > 600 && first.h > 100, `${first.w}x${first.h}`);
  check('...sharper than the screen (at least 2 picture pixels per page pixel)', first.w >= size1.w * 1.9, `${first.w} for ${size1.w}`);
  check('...of the page itself: its text is in it, not the dimming', first.dark > 400 && first.corner[0] > 245 && first.corner[1] > 245 && first.corner[2] > 245, `${first.dark} dark px, corner ${first.corner}`);

  // ----- annotations: the red stroke is in only when they are included -----
  await page.click('[data-testid="snip-close"]');
  await page.click('[data-testid="tool-pen"]');
  await drawStroke(page, { x: (a.x + b.x) / 2 - 100, y: (head.y + head.h + line.y) / 2 }, { x: (a.x + b.x) / 2 + 100, y: (head.y + head.h + line.y) / 2 + 3 });
  await sleep(1600);
  check('a stroke is drawn in the region', (await elements()).length === 1);
  await page.click('[data-testid="tool-snip"]');
  await waitUntil(async () => !!(await spanBox('Call me Ishmael')), { label: 'the text layer again' });
  await drag(a, b);
  await waitUntil(async () => (await regionSize()) !== null, { label: 'the region again' });
  await ctrl('KeyC');
  const withInk = await waitUntil(async () => {
    const c = await clipImage();
    return c && c.red > 30 ? c : null;
  }, { timeout: 20000, label: 'a picture with the ink in it' });
  check('my ink is in the picture', withInk.red > 30, `${withInk.red} red px`);
  check('the annotations switch is on by default', (await page.$eval('[data-testid="snip-annotations"]', (el) => el.getAttribute('aria-pressed'))) === 'true');
  await page.click('[data-testid="snip-annotations"]');
  await ctrl('KeyC');
  const without = await waitUntil(async () => {
    const c = await clipImage();
    return c && c.red === 0 && c.dark > 400 ? c : null;
  }, { timeout: 20000, label: 'a picture without the ink' });
  check('switched off, the picture is the plain page', without.red === 0 && without.dark > 400);

  // ----- copy text -----
  await page.click('[data-testid="snip-text"]');
  const text = await waitUntil(async () => {
    const s = await page.evaluate(() => navigator.clipboard.readText());
    return /Call me Ishmael/.test(s) ? s : null;
  }, { timeout: 15000, label: 'the text on the clipboard' });
  check('"Copy text" copies the words in the region, line by line', /Chapter 1\r?\nCall me Ishmael\. Some years ago/.test(text), JSON.stringify(text));
  check('...and only those: the line below the region is left out', !/having little/.test(text));

  // ----- save -----
  await page.click('[data-testid="snip-save"]');
  const file = await waitUntil(() => {
    const f = readdirSync(downloads).find((n) => n.endsWith('.png') && !n.endsWith('.crdownload'));
    return f && statSync(join(downloads, f)).size > 0 ? f : null;
  }, { timeout: 20000, label: 'the saved picture' });
  const fileBytes = readFileSync(join(downloads, file));
  check('"Save image" downloads a PNG named after the document and page', fileBytes.subarray(1, 4).toString() === 'PNG' && /^Moby Dick \(test\) - page 1\.png$/.test(file), file);

  // ----- resize and move -----
  const r0 = await regionSize();
  const midY = (a.y + b.y) / 2;
  await drag({ x: b.x, y: midY }, { x: b.x - 250, y: midY });
  await waitUntil(async () => ((await regionSize())?.w || 0) < r0.w - 100, { label: 'the region to get narrower' });
  const r1 = await regionSize();
  check('dragging a handle resizes the region', r1.w < r0.w - 100 && r1.h === r0.h, `${r0.w}x${r0.h} -> ${r1.w}x${r1.h}`);
  await drag({ x: (a.x + b.x - 250) / 2 + 20, y: midY }, { x: (a.x + b.x - 250) / 2 + 80, y: midY + 15 });
  const r2 = await regionSize();
  check('dragging inside it moves it, the size stays', r2.w === r1.w && r2.h === r1.h, `${r2.w}x${r2.h}`);
  await page.mouse.click(60, 560); // a click on the page, away from the region (and from the toasts at the bottom)
  await waitUntil(async () => (await regionSize()) === null, { label: 'a click to clear the region' });
  check('a plain click on the page clears the region', await page.$eval('[data-testid="snip-copy"]', (el) => el.disabled));
  await drag(a, b);
  await waitUntil(async () => (await regionSize()) !== null, { label: 'a new region' });
  await drag({ x: 6, y: 300 }, { x: 8, y: 320 }, 3); // on the desk, in the margin beside the page
  await waitUntil(async () => (await regionSize()) === null, { label: 'a press on the desk to clear the region' });
  check('a press on the desk beside the page clears it too', true);

  // ----- put a picture on the clipboard again (the text copy replaced it), then leave -----
  await drag(a, b);
  await waitUntil(async () => (await regionSize()) !== null, { label: 'a region to copy' });
  const copiedSize = await regionSize();
  await ctrl('KeyC');
  await waitUntil(async () => (await clipImage()) !== null, { timeout: 20000, label: 'the picture on the clipboard again' });
  await sleep(500);

  // ----- Esc -----
  await page.keyboard.press('Escape');
  await waitUntil(async () => !(await page.$('[data-testid="snip-bar"]')), { label: 'the snip bar to close' });
  check('Escape leaves the tool and the dock is back', !!(await page.$('[data-testid="tool-pen"]')));
  check('...with the pen as it was', (await page.$eval('[data-testid="tool-pen"]', (el) => el.getAttribute('aria-pressed'))) === 'true');

  // ----- paste: a picture, and text -----
  const pasteEvent = (kind) =>
    page.evaluate(async (what) => {
      const dt = new DataTransfer();
      if (what === 'image') {
        const items = await navigator.clipboard.read();
        const blob = await items.find((i) => i.types.includes('image/png')).getType('image/png');
        dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
      } else {
        dt.setData('text/plain', 'Pasted note 123');
      }
      (document.activeElement || document.body).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, kind);
  const before = (await elements()).length;
  await page.mouse.move(box.x + 300, box.y + 640);
  await pasteEvent('image');
  const withPicture = await waitUntil(async () => {
    const els = await elements();
    return els.length > before && els.some((e) => e.type === 'image') ? els : null;
  }, { timeout: 15000, label: 'the pasted picture to be stored' });
  check('Ctrl+V pastes a picture from the clipboard onto the page', !!withPicture);
  const pasted = await waitUntil(async () => {
    const img = (await elements()).find((e) => e.type === 'image');
    return img && Math.abs(img.width - copiedSize.w) < 4 ? img : null;
  }, { timeout: 15000, label: 'the pasted picture to be brought to the size of the region' }).catch(async () => (await elements()).find((e) => e.type === 'image'));
  check('...at the size of the region that was copied (not twice that)', Math.abs(pasted.width - copiedSize.w) < 4 && Math.abs(pasted.height - copiedSize.h) < 4, `${Math.round(pasted.width)}x${Math.round(pasted.height)} for ${copiedSize.w}x${copiedSize.h}; status ${pasted.status}`);
  const files = (await dumpDb(page)).ann.map((r) => Object.keys(JSON.parse(r.ink_json).files || {})).flat();
  check('...and the picture itself is stored with the page', files.length >= 1, files.join());
  check('...and the select tool is on, so it can be moved at once', (await page.$eval('[data-testid="tools-menu"]', (el) => el.getAttribute('aria-pressed'))) === 'true');
  await shot(page, '99-pasted');

  await pasteEvent('text');
  const withText = await waitUntil(async () => {
    const els = await elements();
    return els.find((e) => e.type === 'text' && /Pasted note 123/.test(e.text)) || null;
  }, { timeout: 15000, label: 'the pasted text to be stored' });
  check('Ctrl+V pastes text as a text element', !!withText);

  check('no page errors', errors.length === 0, errors.join('\n'));
  await ctx.close();
}

// A stylus: pointer events with pointerType 'pen' and a pressure per sample.
async function penStroke(cdp, pts, { buttons = 1, button = 'left' } = {}) {
  const ev = (type, p) => cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button, buttons: type === 'mouseReleased' ? 0 : buttons, clickCount: 1, force: p.f ?? 0.5, pointerType: 'pen' });
  await ev('mousePressed', pts[0]);
  for (const p of pts.slice(1)) {
    await ev('mouseMoved', p);
    await sleep(10);
  }
  await ev('mouseReleased', pts[pts.length - 1]);
}

async function scenarioPen(browser, state) {
  section('The stylus');
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await lightMode(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, 'ines');
  await chooseOnImport(page, state.pdfPath, 'device only');
  await readerReady(page);
  const cdp = await page.createCDPSession();
  const box = await page.$eval('.quarc-canvas-page', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });

  const toolbarText = () => page.$eval('[data-testid="finger-toggle"]', (el) => el.title);
  check('a finger scrolls by default: drawing with it is closed', /Finger scrolls/.test(await toolbarText()));

  await page.click('button[aria-label="#e03131"]');
  const red0 = await inkPixels(page, RED);
  // pressure ramps up then down across the stroke
  const pts = Array.from({ length: 24 }, (_, i) => ({ x: box.x + 200 + i * 18, y: box.y + 420 + Math.sin(i / 3) * 6, f: 0.15 + 0.8 * Math.sin((i / 23) * Math.PI) }));
  await penStroke(cdp, pts);
  await sleep(1500);
  check('a stylus stroke is drawn', (await inkPixels(page, RED)) > red0 + 200);
  const ink = JSON.parse((await dumpDb(page)).ann[0].ink_json).elements[0];
  const pressures = ink?.pressures || [];
  check('with its real pressure, not a flat width', ink?.simulatePressure === false && pressures.length > 10 && Math.max(...pressures) - Math.min(...pressures) > 0.3, JSON.stringify({ sim: ink?.simulatePressure, min: Math.min(...pressures), max: Math.max(...pressures) }));
  check('using a stylus does not open the finger either', /Finger scrolls/.test(await toolbarText()));
  await shot(page, '60-pressure-stroke');

  // the eraser (stylus button / eraser end) removes strokes it passes over
  const redWithInk = await inkPixels(page, RED);
  await penStroke(cdp, [{ x: box.x + 150, y: box.y + 421 }, ...Array.from({ length: 30 }, (_, i) => ({ x: box.x + 150 + i * 18, y: box.y + 421 }))], { buttons: 2, button: 'right' });
  await sleep(1500);
  check('the stylus eraser button erases ink', (await inkPixels(page, RED)) < redWithInk - 150, `${redWithInk} -> ${await inkPixels(page, RED)}`);
  const after = JSON.parse((await dumpDb(page)).ann[0].ink_json).elements;
  check('the erasure is stored as a deletion (so other devices erase it too)', after.length === 1 && after[0].isDeleted === true, JSON.stringify(after.map((e) => e.isDeleted)));

  // ----- the finger: closed whenever a document opens, opened for one reading with the dock button -----
  const red1 = await inkPixels(page, RED);
  await swipe(page, { x: box.x + 300, y: box.y + 560 }, { x: box.x + 600, y: box.y + 566 }, 10);
  await sleep(1200);
  check('a finger drag does not draw while it is closed', (await inkPixels(page, RED)) === red1);
  await page.click('[data-testid="finger-toggle"]');
  check('the Finger button opens it', /Finger draws/.test(await toolbarText()));
  await swipe(page, { x: box.x + 300, y: box.y + 620 }, { x: box.x + 600, y: box.y + 626 }, 10);
  await sleep(1500);
  check('and then a finger draws', (await inkPixels(page, RED)) > red1 + 100, `${red1} -> ${await inkPixels(page, RED)}`);
  check('the opened finger is not stored as a setting', JSON.parse(await page.evaluate(() => localStorage.getItem('quarc_reader_settings') || '{}')).fingerMode !== 'draw');
  await page.reload({ waitUntil: 'networkidle0' });
  await waitUntil(async () => (await paperStats(page))?.dark > 500, { label: 'the reader after a reload' });
  await sleep(600);
  check('opening the document again closes it again, every time', /Finger scrolls/.test(await toolbarText()));
  // An older version of the app saved the finger as open ('draw'): that is reset once...
  await page.evaluate(() => localStorage.setItem('quarc_reader_settings', JSON.stringify({ settingsVersion: 2, fingerMode: 'draw', readMode: 'scroll', paperMode: 'white' })));
  await page.reload({ waitUntil: 'networkidle0' });
  await waitUntil(async () => (await paperStats(page))?.dark > 500, { label: 'the reader after the upgrade' });
  await sleep(600);
  check('a finger that an older version left open is closed after the update', /Finger scrolls/.test(await toolbarText()));
  // ...while choosing Settings -> Finger draws -> afterwards is kept.
  await page.evaluate(() => localStorage.setItem('quarc_reader_settings', JSON.stringify({ settingsVersion: 3, fingerMode: 'draw', readMode: 'scroll', paperMode: 'white' })));
  await page.reload({ waitUntil: 'networkidle0' });
  await waitUntil(async () => (await paperStats(page))?.dark > 500, { label: 'the reader with the setting' });
  await sleep(600);
  check('the Settings choice "Finger draws" is kept: a document then opens with it open', /Finger draws/.test(await toolbarText()));
  check('no page errors', errors.length === 0, errors.join('\n'));
  await ctx.close();
}

// --------------------------------------------------------------------------------------------------

async function scenarioTools(browser, state) {
  section('The other tools: shapes, text, hold-to-snap, cut selection — and saving them');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { PDFDocument } = await import('pdf-lib');
  const downloads = mkdtempSync(join(tmpdir(), 'quarc-reader-dl-'));
  const ctx = await browser.createBrowserContext();
  const bsession = await browser.target().createCDPSession();
  await bsession.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, browserContextId: ctx.id });
  const page = await ctx.newPage();
  await lightMode(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, 'kai');
  await chooseOnImport(page, state.pdfPath, 'device only');
  await readerReady(page);
  const box = await page.$eval('.quarc-canvas-page', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const elements = async () => ((await dumpDb(page)).ann || []).flatMap((r) => JSON.parse(r.ink_json).elements).filter((e) => !e.isDeleted);
  // The pen has its own button on the dock; every other tool is in the Tools flyout.
  const tool = async (name) => {
    if (name === 'freedraw') return page.click('[data-testid="tool-pen"]');
    await page.click('[data-testid="tools-menu"]');
    await page.waitForSelector(`[data-testid="tool-${name}"]`, { visible: true });
    return page.click(`[data-testid="tool-${name}"]`);
  };

  // ----- hold the pen still at the end of a stroke: it becomes a clean line -----
  await page.click('button[aria-label="#1971c2"]');
  await page.mouse.move(box.x + 200, box.y + 700);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(box.x + 200 + i * 40, box.y + 700 + (i % 2) * 3);
    await sleep(10);
  }
  await sleep(900); // hold still
  await page.mouse.up();
  await sleep(1500);
  let els = await elements();
  check('holding the pen still at the end of a stroke snaps it to a clean line', els.some((e) => e.type === 'line'), els.map((e) => e.type).join());
  await shot(page, '90-snapped-line');

  // ----- Excalidraw's own tools: a rectangle -----
  await tool('rectangle');
  await page.mouse.move(box.x + 250, box.y + 520);
  await page.mouse.down();
  await page.mouse.move(box.x + 450, box.y + 600, { steps: 8 });
  await page.mouse.up();
  await sleep(1500);
  els = await elements();
  check('the rectangle tool draws a rectangle on the page', els.some((e) => e.type === 'rectangle'), els.map((e) => e.type).join());

  // ----- the text tool -----
  await tool('text');
  await page.mouse.click(box.x + 500, box.y + 540);
  await sleep(400);
  await page.keyboard.type('Merhaba dünya');
  await page.keyboard.press('Escape');
  await sleep(1500);
  els = await elements();
  const text = els.find((e) => e.type === 'text');
  check('the text tool puts typed text on the page', !!text && /Merhaba/.test(text.text), JSON.stringify(text && text.text));
  const pageKeys = ((await dumpDb(page)).ann || []).map((r) => r.page_key);
  check('all of it is stored on page 1', pageKeys.join() === 'p0', pageKeys.join());
  await shot(page, '91-tools');

  // ----- cut selection: select across a stroke and it is cut at the boundary -----
  await tool('freedraw');
  await page.click('button[aria-label="#e03131"]');
  await drawStroke(page, { x: box.x + 200, y: box.y + 640 }, { x: box.x + 700, y: box.y + 644 }, 20);
  await sleep(1500);
  const before = (await elements()).filter((e) => e.type === 'freedraw').length;
  await tool('cut-rect');
  await page.mouse.move(box.x + 380, box.y + 610);
  await page.mouse.down();
  await page.mouse.move(box.x + 520, box.y + 680, { steps: 8 });
  await page.mouse.up();
  await sleep(1800);
  const all = ((await dumpDb(page)).ann || []).flatMap((r) => JSON.parse(r.ink_json).elements);
  const live = all.filter((e) => !e.isDeleted && e.type === 'freedraw');
  check('the cut selection cuts a stroke at the selection boundary into pieces', live.length >= before + 2, `${before} strokes -> ${live.length}`);
  check('and the uncut original is replaced (a stored deletion, so other devices let go of it)', all.some((e) => e.isDeleted && e.type === 'freedraw'));
  await shot(page, '92-cut-selection');

  // ----- save a copy: shapes as vectors, the text drawn by Excalidraw -----
  await page.keyboard.press('Escape');
  await menuClick(page, 'More', 'Save PDF');
  await page.waitForSelector(MODAL);
  await page.evaluate(() => [...document.querySelectorAll('div[class*="z-[1100]"] [role=dialog] button')].find((b) => /Save a copy/.test(b.innerText))?.click());
  const file = await waitForDownload(downloads);
  const out = await PDFDocument.load(readFileSync(file));
  check('the saved PDF has the same 3 pages', out.getPageCount() === 3);
  const { PDFRawStream, decodePDFRawStream, PDFArray } = await import('pdf-lib');
  const content = (() => {
    const c = out.getPage(0).node.Contents();
    const parts = [];
    const collect = (o) => {
      if (o instanceof PDFRawStream) parts.push(Buffer.from(decodePDFRawStream(o).decode()).toString('latin1'));
      else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) collect(out.context.lookup(o.get(i)));
    };
    collect(c);
    return parts.join('\n');
  })();
  check('the pen strokes and shapes are vector paths', (content.match(/\nf\n|\nS\n|\nB\n/g) || []).length >= 4, `${(content.match(/\nS\n/g) || []).length} S, ${(content.match(/\nf\n/g) || []).length} f`);
  check('the typed text came out (Excalidraw drew it) as an image on the page', /\/Image\d* Do|\bDo\n/.test(content) || (out.getPage(0).node.Resources()?.lookup?.(await import('pdf-lib').then((m) => m.PDFName.of('XObject'))) ?? null) !== null);
  await shot(page, '93-after-export');

  check('no page errors', errors.length === 0, errors.join('\n'));
  await ctx.close();
}

// What the person has made, as the database holds it (undone things are tombstones, so only live ones count).
async function madeSoFar(page) {
  const db = await dumpDb(page);
  const rows = db.ann || [];
  const doc = db.docs?.[0] || {};
  const ink = rows.flatMap((r) => JSON.parse(r.ink_json).elements.filter((e) => !e.isDeleted).map((e) => ({ ...e, page_key: r.page_key })));
  const marks = rows.flatMap((r) => JSON.parse(r.marks_json).filter((m) => !m.del).map((m) => ({ ...m, page_key: r.page_key })));
  const notes = (doc.layout || []).filter((it) => it.t === 'n' && !it.del);
  const bookmarks = (doc.bookmarks || []).filter((b) => !b.del);
  return { ink: ink.length, marks: marks.length, notes: notes.length, bookmarks: bookmarks.length, detail: { ink, marks, notes, bookmarks, layout: doc.layout || [] } };
}
const made = (m) => `ink ${m.ink}, highlights ${m.marks}, note pages ${m.notes}, bookmarks ${m.bookmarks}`;

async function scenarioUndo(browser, state) {
  section('Undo and redo take back everything, not just strokes');
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await lightMode(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await login(page, 'uma');
  await chooseOnImport(page, state.pdfPath, 'device only');
  await readerReady(page);
  const box = await page.$eval('.quarc-canvas-page', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const settle = () => sleep(1700);
  const press = async (key, { shift = false } = {}) => {
    await page.keyboard.down('Control');
    if (shift) await page.keyboard.down('Shift');
    await page.keyboard.press(key);
    if (shift) await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await settle();
  };
  const undoButton = async () => {
    await page.click('[data-testid="undo"]');
    await settle();
  };
  const redoButton = async () => {
    await page.click('[data-testid="redo"]');
    await settle();
  };

  // ----- make five different things -----
  // 1. a stroke on page 1
  await page.click('button[aria-label="#e03131"]');
  await drawStroke(page, { x: box.x + 200, y: box.y + 640 }, { x: box.x + 600, y: box.y + 650 });
  await settle();
  // 2. a highlight made by the pencil highlighter, snapped to the words under it
  await page.click('[data-testid="tool-highlighter"]');
  await waitUntil(() => spanRect(page, 'to interest me'), { label: 'text geometry in highlighter mode' });
  await sleep(500);
  const line = await spanRect(page, 'to interest me');
  await drawStroke(page, { x: line.x + line.w * 0.09, y: line.y + line.h / 2 }, { x: line.x + line.w * 0.36, y: line.y + line.h / 2 + 1 }, 14);
  await settle();
  await page.click('[data-testid="tool-pen"]');
  let m = await madeSoFar(page);
  check('a stroke and a snapped highlight are there', m.ink === 1 && m.marks === 1, made(m));
  // 3. a note page after page 1
  await menuClick(page, 'More', 'Insert a note page here');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Lined'), { timeout: 5000 });
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Lined')?.click());
  await waitIndicator(page, '2/4');
  await sleep(900);
  // 4. a bookmark on it
  await page.click('button[aria-label="Bookmark this page"]');
  await settle();
  // 5. a stroke on the note page
  await drawStroke(page, { x: box.x + 300, y: box.y + 300 }, { x: box.x + 700, y: box.y + 330 });
  await settle();
  m = await madeSoFar(page);
  check('all five are made: 2 strokes, a highlight, a note page, a bookmark', m.ink === 2 && m.marks === 1 && m.notes === 1 && m.bookmarks === 1, made(m));
  const noteKey = `n${m.detail.notes[0]?.id}`;
  check('the second stroke is on the note page', m.detail.ink.some((e) => e.page_key === noteKey));
  await shot(page, '95-undo-made');

  // ----- undo them one by one with the dock button, newest first -----
  await undoButton();
  m = await madeSoFar(page);
  check('undo 1: the stroke on the note page goes', m.ink === 1 && m.notes === 1 && m.bookmarks === 1 && m.marks === 1, made(m));
  await undoButton();
  m = await madeSoFar(page);
  check('undo 2: the bookmark goes', m.bookmarks === 0 && m.notes === 1 && m.marks === 1, made(m));
  await undoButton();
  m = await madeSoFar(page);
  check('undo 3: the note page goes (the document is back to 3 pages)', m.notes === 0 && m.marks === 1 && m.ink === 1 && m.detail.layout.length === 4, made(m));
  check('...as a deletion that is kept, so it syncs', m.detail.layout.some((it) => it.t === 'n' && it.del === true), JSON.stringify(m.detail.layout));
  await waitUntil(async () => /\/\s*3/.test((await indicator(page)) || ''), { label: 'the page count to be 3 again' });
  await undoButton();
  m = await madeSoFar(page);
  check('undo 4: the text highlight made by the pencil goes', m.marks === 0 && m.ink === 1, made(m));
  await page.click('button[aria-label="Notes and highlights"]');
  await sleep(500);
  check('...and the notes list no longer shows it', !/interest/.test(await page.$eval('aside', (el) => el.innerText)));
  await page.click('button[aria-label="Close"]');
  await undoButton();
  m = await madeSoFar(page);
  check('undo 5: the first stroke goes', m.ink === 0 && m.marks === 0 && m.notes === 0 && m.bookmarks === 0, made(m));
  check('...and nothing is painted red any more', (await inkPixels(page, RED)) < 30, `${await inkPixels(page, RED)} red pixels`);
  await undoButton();
  m = await madeSoFar(page);
  check('undo with nothing left changes nothing and breaks nothing', m.ink === 0 && m.marks === 0 && m.notes === 0 && errors.length === 0, made(m));

  // ----- redo them in the same order -----
  await redoButton();
  m = await madeSoFar(page);
  check('redo 1: the first stroke is back', m.ink === 1 && m.marks === 0, made(m));
  await redoButton();
  m = await madeSoFar(page);
  check('redo 2: the highlight is back, on its words', m.marks === 1 && /interest/.test(m.detail.marks[0]?.text || ''), made(m));
  await redoButton();
  m = await madeSoFar(page);
  check('redo 3: the note page is back', m.notes === 1 && m.detail.notes[0].id === noteKey.slice(1), made(m));
  await redoButton();
  await redoButton();
  m = await madeSoFar(page);
  check('redo 4 and 5: the bookmark and the stroke on the note page', m.bookmarks === 1 && m.ink === 2 && m.detail.ink.some((e) => e.page_key === noteKey), made(m));
  await redoButton();
  m = await madeSoFar(page);
  check('redo with nothing left changes nothing', m.ink === 2 && m.marks === 1 && m.notes === 1 && m.bookmarks === 1, made(m));
  await shot(page, '96-undo-redone');

  // ----- the keyboard does the same -----
  await press('KeyZ');
  m = await madeSoFar(page);
  check('Ctrl+Z undoes the last thing', m.ink === 1 && m.bookmarks === 1, made(m));
  await press('KeyZ');
  m = await madeSoFar(page);
  check('...and the one before it (a bookmark, not only strokes)', m.bookmarks === 0, made(m));
  await press('KeyZ', { shift: true });
  m = await madeSoFar(page);
  check('Ctrl+Shift+Z redoes', m.bookmarks === 1 && m.ink === 1, made(m));
  await press('KeyY');
  m = await madeSoFar(page);
  check('Ctrl+Y redoes too', m.ink === 2 && m.bookmarks === 1, made(m));

  // ----- doing something new ends the redo list -----
  await press('KeyZ');
  await drawStroke(page, { x: box.x + 200, y: box.y + 520 }, { x: box.x + 640, y: box.y + 540 });
  await settle();
  m = await madeSoFar(page);
  check('a new stroke after an undo is kept', m.ink === 2, made(m));
  await press('KeyY');
  m = await madeSoFar(page);
  check('...and the undone stroke can no longer be redone over it', m.ink === 2, made(m));

  // ----- a swipe of the eraser over a stroke and a highlight is one step -----
  await page.keyboard.press('Home');
  await sleep(900);
  await page.click('[data-testid="tool-highlighter"]');
  await waitUntil(() => spanRect(page, 'to interest me'), { label: 'text geometry again' });
  await sleep(500);
  const line2 = await spanRect(page, 'to interest me');
  await page.click('[data-testid="tool-pen"]');
  await drawStroke(page, { x: line2.x + line2.w * 0.5, y: line2.y - 40 }, { x: line2.x + line2.w * 0.5 + 6, y: line2.y + 50 }, 10);
  await settle();
  const before = await madeSoFar(page);
  // the stylus' eraser button, swept along the highlighted line, across the stroke
  const cdp = await page.createCDPSession();
  const ey = line2.y + line2.h / 2;
  await penStroke(cdp, [{ x: line2.x + 4, y: ey }, ...Array.from({ length: 24 }, (_, i) => ({ x: line2.x + 4 + ((line2.w - 8) * (i + 1)) / 24, y: ey }))], { buttons: 2, button: 'right' });
  await settle();
  const erased = await madeSoFar(page);
  check('one swipe of the eraser took a stroke and a highlight', erased.ink === before.ink - 1 && erased.marks === before.marks - 1, `${made(before)} -> ${made(erased)}`);
  await press('KeyZ');
  const unerased = await madeSoFar(page);
  check('one undo brings both back', unerased.ink === before.ink && unerased.marks === before.marks, made(unerased));
  await press('KeyY');
  const reerased = await madeSoFar(page);
  check('and one redo takes both away again', reerased.ink === erased.ink && reerased.marks === erased.marks, made(reerased));
  await press('KeyZ');

  // the eraser button on the dock (Excalidraw's own eraser) is undone too
  await page.click('[data-testid="tool-eraser"]');
  await page.mouse.move(line2.x + line2.w * 0.5 + 3, line2.y - 30);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(line2.x + line2.w * 0.5 + 3, line2.y - 30 + i * 8);
    await sleep(15);
  }
  await page.mouse.up();
  await settle();
  const dockErased = await madeSoFar(page);
  check('the dock eraser takes the stroke away', dockErased.ink === before.ink - 1, `${made(before)} -> ${made(dockErased)}`);
  await page.click('[data-testid="tool-eraser"]'); // back to the pen
  await press('KeyZ');
  const dockBack = await madeSoFar(page);
  check('and undo brings it back', dockBack.ink === before.ink, made(dockBack));

  // ----- deleting a note page can be undone, with what was written on it -----
  await page.click('button[aria-label="Notes and highlights"]');
  await sleep(500);
  await page.evaluate(() => [...document.querySelectorAll('aside button')].find((b) => /Page 2/.test(b.innerText))?.click());
  await waitIndicator(page, '2/4');
  await sleep(700);
  const withNote = await madeSoFar(page);
  await menuClick(page, 'More', 'Delete this note page');
  await settle();
  const gone = await madeSoFar(page);
  check('deleting the note page removes it', gone.notes === 0, made(gone));
  await press('KeyZ');
  const back = await madeSoFar(page);
  check('undo brings the note page back', back.notes === 1 && back.detail.notes[0].id === withNote.detail.notes[0].id, made(back));
  check('...with the stroke written on it', back.detail.ink.some((e) => e.page_key === noteKey), JSON.stringify(back.detail.ink.map((e) => e.page_key)));
  await waitUntil(async () => (await indicator(page)) !== null && /\/\s*4/.test((await indicator(page)) || ''), { label: 'four pages again' });
  await page.keyboard.press('Home');
  await sleep(500);
  await page.click('button[aria-label="Notes and highlights"]');
  await sleep(400);
  await page.evaluate(() => [...document.querySelectorAll('aside button')].find((b) => /Page 2/.test(b.innerText))?.click());
  await sleep(1500);
  const red = await inkPixels(page, RED);
  check('the stroke on the restored note page is drawn again', red > 200, `${red} red pixels`);
  await shot(page, '97-undo-note-restored');

  // ----- the dock buttons and a reload: what was undone stays undone -----
  await page.reload({ waitUntil: 'networkidle0' });
  await waitUntil(async () => (await indicator(page)) !== null, { label: 'reader after reload' }); // it opens where it was left: on a note page, which has no text to wait for
  await sleep(1800);
  const afterReload = await madeSoFar(page);
  check('after a reload everything that is not undone is still there', afterReload.ink === back.ink && afterReload.marks === back.marks && afterReload.notes === 1, made(afterReload));

  // ----- a note page inserted ABOVE a stroke does not turn that stroke into a step of its own -----
  await page.keyboard.press('End');
  await sleep(1000);
  await drawStroke(page, { x: box.x + 300, y: box.y + 300 }, { x: box.x + 650, y: box.y + 320 });
  await settle();
  const below = await madeSoFar(page);
  check('a stroke on the last page', below.ink === afterReload.ink + 1 && below.detail.ink.some((e) => e.page_key === 'p2'), made(below));
  await page.keyboard.press('Home');
  await sleep(1000);
  await menuClick(page, 'More', 'Insert a note page here');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Lined'), { timeout: 5000 });
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Lined')?.click());
  await waitIndicator(page, '2/5');
  await settle();
  const inserted = await madeSoFar(page);
  check('a second note page goes in above it', inserted.notes === 2 && inserted.ink === below.ink, made(inserted));
  await press('KeyZ');
  const undoneInsert = await madeSoFar(page);
  check('one undo takes that page away again (the shifted stroke is not a step)', undoneInsert.notes === 1 && undoneInsert.ink === below.ink && undoneInsert.detail.ink.some((e) => e.page_key === 'p2'), made(undoneInsert));
  await press('KeyZ');
  const undoneStroke = await madeSoFar(page);
  check('the next undo takes the stroke itself', undoneStroke.ink === below.ink - 1 && undoneStroke.notes === 1, made(undoneStroke));

  check('no page errors', errors.length === 0, errors.join('\n'));
  await ctx.close();
}

// Pixels of the link-hover outline (violet, on the canvas that is drawn above the ink).
const violetPixels = (page) =>
  page.evaluate(() => {
    let n = 0;
    for (const canvas of document.querySelectorAll('.quarc-canvas-page canvas')) {
      if (canvas.closest('.excalidraw') || !canvas.width || !canvas.height) continue;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 120 && Math.abs(data[i] - 124) < 14 && Math.abs(data[i + 1] - 58) < 14 && Math.abs(data[i + 2] - 237) < 14) n++;
    }
    return n;
  });

async function scenarioLinks(browser, state) {
  section('Links inside a PDF open on a plain tap');
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await lightMode(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Opening a new tab is recorded instead (the headless browser would open one nobody can see).
  await page.evaluateOnNewDocument(() => {
    window.__opened = [];
    window.open = (url) => {
      window.__opened.push(String(url));
      return null;
    };
  });
  await login(page, 'lena');
  await chooseOnImport(page, state.linksPdfPath, 'device only');
  await readerReady(page);
  const opened = () => page.evaluate(() => window.__opened);
  const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const tap = async (r) => {
    const c = centre(r);
    await page.mouse.click(c.x, c.y);
    await sleep(500);
  };

  // Where the lines are: the text layer shows them while the highlighter is on, and the view stays when the pen comes back.
  await page.click('[data-testid="tool-highlighter"]');
  await waitUntil(() => spanRect(page, 'Open the Quarc site'), { label: 'text geometry' });
  await sleep(700);
  const site = await spanRect(page, 'Open the Quarc site');
  const jump = await spanRect(page, 'Jump to chapter 3');
  const script = await spanRect(page, 'Run a script');
  await page.click('[data-testid="tool-pen"]');
  await sleep(600);
  check('the three link lines are on the page', !!site && !!jump && !!script);

  // ----- hovering -----
  await page.mouse.move(centre(site).x, centre(site).y);
  await sleep(500);
  const hovered = await violetPixels(page);
  check('the mouse over a link outlines it', hovered > 30, `${hovered} outline pixels`);
  await shot(page, '99-link-hover');
  await page.mouse.move(centre(site).x, site.y - 150);
  await sleep(500);
  check('...and the outline goes when the mouse leaves it', (await violetPixels(page)) < 5);

  // ----- a web address -----
  await tap(site);
  check('a tap on a web link opens its address', JSON.stringify(await opened()) === JSON.stringify(['https://example.com/quarc']), JSON.stringify(await opened()));
  await sleep(1300);
  check('...and the pen leaves no dot behind', (await madeSoFar(page)).ink === 0, made(await madeSoFar(page)));

  // ----- a drag over the same words is still writing -----
  await drawStroke(page, { x: site.x + 3, y: site.y + site.h / 2 }, { x: site.x + site.w - 3, y: site.y + site.h / 2 + 4 }, 10);
  await sleep(1500);
  check('dragging the pen over a link draws, it does not open it', (await opened()).length === 1 && (await madeSoFar(page)).ink === 1, `${(await opened()).length} opened, ${made(await madeSoFar(page))}`);

  // ----- a script is not a link -----
  await tap(script);
  check('a link that runs a script is not followed', (await opened()).length === 1, JSON.stringify(await opened()));

  // ----- a jump to another page, and the way back -----
  await tap(jump);
  await waitIndicator(page, '3/3');
  check('a tap on an in-document link goes to its page', true);
  const toasts = await page.evaluate(() => [...document.querySelectorAll('[class*="z-[1200]"]')].map((el) => el.innerText).join(' | '));
  check('with a "Back" button to return', /Page 3/.test(toasts) && /Back/.test(toasts), toasts);
  await shot(page, '99-link-jumped');
  await page.evaluate(() => [...document.querySelectorAll('[class*="z-[1200]"] button')].find((b) => b.innerText.trim() === 'Back')?.click());
  await waitIndicator(page, '1/3');
  await sleep(600);
  check('Back returns to where the link was', true);

  // ----- the other ways of reading -----
  await page.click('button[aria-label="Select text to highlight"]');
  await waitUntil(() => spanRect(page, 'Open the Quarc site'), { label: 'text layer' });
  await sleep(500);
  const siteText = await spanRect(page, 'Open the Quarc site');
  await tap(siteText);
  await sleep(300);
  check('in the select-text mode a tap on a link opens it as well', (await opened()).length === 2, JSON.stringify(await opened()));
  await page.click('button[aria-label="Select text to highlight"]'); // back to the pen
  await sleep(500);

  await page.click('[data-testid="tool-highlighter"]');
  await sleep(600);
  await tap(site);
  check('with the highlighter too, and it highlights nothing', (await opened()).length === 3 && (await madeSoFar(page)).marks === 0, `${(await opened()).length} opened, ${made(await madeSoFar(page))}`);
  await page.click('[data-testid="tool-pen"]');
  await sleep(500);

  // ----- tools that use the tap themselves leave the links alone -----
  await page.click('[data-testid="tool-eraser"]');
  await sleep(300);
  await tap(site);
  check('with the eraser a tap does not open links', (await opened()).length === 3, JSON.stringify(await opened()));
  await page.click('[data-testid="tool-eraser"]');

  check('no page errors', errors.length === 0, errors.join('\n'));
  await ctx.close();
}

// Opens the first document of the library (waits for the card: the library fills from IndexedDB a moment after the page loads).
async function openFirstDocument(page) {
  await page.waitForSelector('main p.line-clamp-2', { timeout: 20000 });
  await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll('main p.line-clamp-2')].find((p) => p.textContent.length)?.closest('.cursor-pointer, div.group')?.click());
  await page.waitForFunction(() => location.pathname.startsWith('/read/'), { timeout: 20000 });
}

// A rough picture of the paper: dark pixels per horizontal band. It changes when the page is moved.
const paperBands = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector('.quarc-canvas-page canvas');
    const { width, height } = canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const bands = new Array(12).fill(0);
    for (let y = 0; y < height; y++) {
      let n = 0;
      for (let x = 0; x < width; x += 2) if ((data[(y * width + x) * 4] + data[(y * width + x) * 4 + 1] + data[(y * width + x) * 4 + 2]) / 3 < 90) n++;
      bands[Math.min(11, Math.floor((y * 12) / height))] += n;
    }
    return bands.join(',');
  });

// The real defaults — except for what the app asks every time (reading style) and the sepia paper — and a stand-in for opening a new tab.
const realDefaults = (page) =>
  page.evaluateOnNewDocument(() => {
    let current = {};
    try {
      current = JSON.parse(localStorage.getItem('quarc_reader_settings') || '{}');
    } catch {
      /* start from nothing */
    }
    localStorage.setItem('quarc_reader_settings', JSON.stringify({ settingsVersion: 3, readMode: 'scroll', paperMode: 'white', ...current }));
    window.__opened = [];
    window.open = (url) => {
      window.__opened.push(String(url));
      return null;
    };
  });

async function scenarioHand(browser, state) {
  section('On a computer the hand is in hand: the mouse moves the page until the pen is pressed');
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await realDefaults(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const pressed = (testId) => page.$eval(`[data-testid="${testId}"]`, (el) => el.getAttribute('aria-pressed'));
  const ink = async () => (await madeSoFar(page)).ink;
  const opened = () => page.evaluate(() => window.__opened);

  await login(page, 'pia');
  await chooseOnImport(page, state.linksPdfPath, 'device only');
  await readerReady(page);
  const box = await page.$eval('.quarc-canvas-page', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  check('the dock has a Hand button, and it is the one in hand', !!(await page.$('[data-testid="tool-hand"]')) && (await pressed('tool-hand')) === 'true');
  check('the pen and the highlighter are not selected', (await pressed('tool-pen')) !== 'true' && (await pressed('tool-highlighter')) !== 'true');
  await shot(page, '99-hand-default');

  // Where the link is: the highlighter shows the text; the hand button takes it away again.
  await page.click('[data-testid="tool-highlighter"]');
  await waitUntil(() => spanRect(page, 'Open the Quarc site'), { label: 'text geometry' });
  await sleep(600);
  const site = await spanRect(page, 'Open the Quarc site');
  check('pressing the highlighter takes it in hand instead of the hand', (await pressed('tool-highlighter')) === 'true' && (await pressed('tool-hand')) !== 'true');
  await page.click('[data-testid="tool-hand"]');
  await sleep(500);
  check('pressing the hand takes it back', (await pressed('tool-hand')) === 'true' && (await pressed('tool-highlighter')) !== 'true');

  // ----- a tap on a link opens it -----
  await page.mouse.click(site.x + site.w / 2, site.y + site.h / 2);
  await sleep(600);
  check('with the hand a click on a link opens it', JSON.stringify(await opened()) === JSON.stringify(['https://example.com/quarc']), JSON.stringify(await opened()));
  await sleep(1200);
  check('...and writes nothing', (await ink()) === 0);

  // ----- a drag moves the page and writes nothing -----
  const before = await paperBands(page);
  await page.mouse.move(box.x + 640, box.y + 700);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(box.x + 640, box.y + 700 - i * 25);
    await sleep(15);
  }
  await page.mouse.up();
  await sleep(1500);
  check('dragging with the mouse writes nothing', (await ink()) === 0);
  check('...it moves the page', (await paperBands(page)) !== before);

  // ----- the pen: the mouse writes -----
  await page.click('[data-testid="tool-pen"]');
  check('pressing the pen takes it in hand', (await pressed('tool-pen')) === 'true' && (await pressed('tool-hand')) !== 'true');
  await drawStroke(page, { x: box.x + 300, y: box.y + 600 }, { x: box.x + 700, y: box.y + 610 });
  await sleep(1600);
  check('and then the mouse writes', (await ink()) === 1);
  await page.click('[data-testid="tool-hand"]');
  await drawStroke(page, { x: box.x + 300, y: box.y + 650 }, { x: box.x + 700, y: box.y + 660 });
  await sleep(1600);
  check('with the hand again it writes nothing', (await ink()) === 1 && (await pressed('tool-hand')) === 'true');

  // ----- the eraser and select-text give back what was in hand -----
  await page.click('[data-testid="tool-eraser"]');
  check('the eraser is in hand', (await pressed('tool-eraser')) === 'true' && (await pressed('tool-hand')) !== 'true');
  await page.click('[data-testid="tool-eraser"]');
  check('pressing it again gives the hand back (not the pen)', (await pressed('tool-hand')) === 'true' && (await pressed('tool-pen')) !== 'true');
  await page.click('[data-testid="tool-pen"]');
  await page.click('[data-testid="tool-eraser"]');
  await page.click('[data-testid="tool-eraser"]');
  check('and after the pen, the pen', (await pressed('tool-pen')) === 'true');
  await page.click('[data-testid="tool-hand"]');
  await page.click('button[aria-label="Select text to highlight"]');
  await sleep(500);
  await page.click('button[aria-label="Select text to highlight"]');
  await sleep(500);
  check('leaving select-text mode gives the hand back', (await pressed('tool-hand')) === 'true' && (await pressed('tool-pen')) !== 'true');

  // ----- the setting -----
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle0' });
  const choose = async (label) => {
    await page.evaluate((l) => {
      const row = [...document.querySelectorAll('p')].find((p) => p.textContent === 'Start with').parentElement.parentElement;
      [...row.querySelectorAll('button')].find((b) => b.textContent === l)?.click();
    }, label);
    await sleep(300);
    return page.evaluate((l) => {
      const row = [...document.querySelectorAll('p')].find((p) => p.textContent === 'Start with').parentElement.parentElement;
      return [...row.querySelectorAll('button')].find((b) => b.textContent === l)?.getAttribute('aria-pressed');
    }, label);
  };
  check('Settings has "Start with": Automatic is chosen', (await page.evaluate(() => [...[...document.querySelectorAll('p')].find((p) => p.textContent === 'Start with').parentElement.parentElement.querySelectorAll('button')].find((b) => b.textContent === 'Automatic')?.getAttribute('aria-pressed'))) === 'true');
  check('...Pen can be chosen', (await choose('Pen')) === 'true');
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await openFirstDocument(page);
  await waitUntil(async () => (await paperStats(page))?.dark > 100, { label: 'the document to open again' });
  await sleep(800);
  check('with Pen chosen a document opens with the pen in hand', (await pressed('tool-pen')) === 'true' && (await pressed('tool-hand')) !== 'true');

  check('no page errors', errors.length === 0, errors.join('\n'));

  // ----- a touch screen starts with the pen, and has no Hand button -----
  const touch = await ctx.newPage();
  await touch.setViewport({ width: 820, height: 1100, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await touch.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await realDefaults(touch);
  await touch.evaluateOnNewDocument(() => localStorage.setItem('quarc_reader_settings', JSON.stringify({ settingsVersion: 3, readMode: 'scroll', paperMode: 'white' })));
  try {
    await touch.goto(BASE, { waitUntil: 'networkidle0' });
    const coarse = await touch.evaluate(() => matchMedia('(pointer: coarse)').matches);
    if (!coarse) {
      console.log('  (this browser does not emulate a coarse pointer: the touch-screen check is covered by the unit tests only)');
    } else {
      await openFirstDocument(touch);
      await touch.waitForSelector('[data-testid="tool-pen"]', { timeout: 20000 });
      await sleep(800);
      check('on a touch screen a document opens with the pen in hand', (await touch.$eval('[data-testid="tool-pen"]', (el) => el.getAttribute('aria-pressed'))) === 'true');
      check('...and the dock has no Hand button', !(await touch.$('[data-testid="tool-hand"]')));
    }
  } catch (err) {
    check('the touch-screen check ran', false, String(err?.message || err).split('\n')[0]);
  }
  await touch.close();
  await ctx.close();
}

async function cardMenu(page, title, itemRe) {
  const ok = await page.evaluate((t) => {
    const card = [...document.querySelectorAll('div.group, div.cursor-pointer')].find((c) => c.innerText.includes(t) && c.querySelector('button[aria-label="More"]'));
    card?.querySelector('button[aria-label="More"]')?.click();
    return !!card;
  }, title);
  if (!ok) throw new Error(`no card titled ${title}`);
  await page.waitForFunction((src) => [...document.querySelectorAll('button')].some((b) => new RegExp(src).test(b.innerText)), { timeout: 5000 }, itemRe);
  await page.evaluate((src) => [...document.querySelectorAll('button')].find((b) => new RegExp(src).test(b.innerText))?.click(), itemRe);
}

const cardTitles = (page) => page.$$eval('main p.line-clamp-2', (els) => els.map((e) => e.textContent.trim()).sort());
const clickTab = (page, label) => page.evaluate((l) => [...document.querySelectorAll('nav button')].find((b) => b.innerText.startsWith(l))?.click(), label);

async function scenarioLibrary(browser, state) {
  section('The library');
  const { PDFDocument } = await import('pdf-lib');
  const second = writePdf('second.pdf', await makeTestPdf({ pages: 2, title: 'Second Book', author: 'B' }));
  const third = writePdf('third.pdf', await makeTestPdf({ pages: 2, title: 'Third Book', author: 'C' }));
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await lightMode(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, 'hana');

  // ----- adding: the same file twice is one document -----
  await chooseOnImport(page, state.pdfPath, 'device only');
  await readerReady(page);
  // draw something on it while it is still local-only
  const box = await page.$eval('.quarc-canvas-page', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await page.click('button[aria-label="#e03131"]');
  await drawStroke(page, { x: box.x + 200, y: box.y + 420 }, { x: box.x + 600, y: box.y + 430 });
  await sleep(1500);
  await page.click('button[aria-label="Back to library"]');
  await page.waitForFunction(() => location.pathname === '/');
  await chooseOnImport(page, state.pdfPath, 'device only');
  await waitUntil(async () => /already in your library/.test(await page.evaluate(() => document.body.innerText)), { label: 'the duplicate notice' });
  check('adding the same PDF again does not make a second copy', ((await dumpDb(page)).docs || []).length === 1);
  // ...it opens the one you already have
  await page.waitForFunction(() => location.pathname.startsWith('/read/'), { timeout: 15000 });
  check('and takes you to the existing document', true);
  await page.click('button[aria-label="Back to library"]');
  await page.waitForFunction(() => location.pathname === '/');

  // ----- "remember my choice" -----
  await chooseOnImport(page, second, 'Sync with my server');
  // ("remember" was not ticked, so the next one still asks)
  await readerReady(page);
  await page.click('button[aria-label="Back to library"]');
  await page.waitForFunction(() => location.pathname === '/');
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.evaluate(() => document.querySelector('header button.bg-accent')?.click())]);
  await chooser.accept([third]);
  await page.waitForSelector(MODAL);
  check('without "remember", every new PDF asks again', true);
  await page.evaluate(() => (document.querySelector('div[class*="z-[1100]"] [role=dialog] input[type=checkbox]')).click());
  await page.evaluate(() => [...document.querySelectorAll('div[class*="z-[1100]"] [role=dialog] button')].find((b) => /device only/.test(b.innerText))?.click());
  await readerReady(page);
  check('the choice can be remembered as the default', (await page.evaluate(() => JSON.parse(localStorage.getItem('quarc_reader_settings')).syncChoice)) === 'local');
  await page.click('button[aria-label="Back to library"]');
  await page.waitForFunction(() => location.pathname === '/');
  await sleep(500);
  check('three documents in the library', (await cardTitles(page)).join('|') === 'Moby Dick (test)|Second Book|Third Book', (await cardTitles(page)).join('|'));
  const dbA = (await dumpDb(page)).docs;
  check('each kept the choice made for it (one synced, two local)', dbA.filter((d) => d.sync === 'cloud').length === 1 && dbA.filter((d) => d.sync === 'local').length === 2, JSON.stringify(dbA.map((d) => [d.title, d.sync])));
  await shot(page, '70-library');

  // ----- search, favorites, rename -----
  await page.type('input[placeholder="Search your library"]', 'second');
  await sleep(300);
  check('search filters the library as you type', (await cardTitles(page)).join('|') === 'Second Book');
  await page.evaluate(() => { const i = document.querySelector('input[placeholder="Search your library"]'); i.select(); });
  await page.keyboard.press('Backspace');
  await cardMenu(page, 'Third Book', 'Add to favorites');
  await sleep(300);
  await clickTab(page, 'Favorites');
  await sleep(300);
  await shot(page, '72-favorites');
  check('favorites are listed under Favorites', (await cardTitles(page)).join('|') === 'Third Book', `${(await cardTitles(page)).join('|')} | search box: "${await page.$eval('input[placeholder="Search your library"]', (e) => e.value)}" | favs in db: ${JSON.stringify((await dumpDb(page)).docs.map((d) => [d.title, d.is_favorite]))}`);
  await clickTab(page, 'This device only');
  await sleep(300);
  check('"This device only" lists exactly the documents that are not synced', (await cardTitles(page)).join('|') === 'Moby Dick (test)|Third Book', (await cardTitles(page)).join('|'));
  await clickTab(page, 'All');

  await cardMenu(page, 'Second Book', 'Rename');
  await page.waitForSelector(MODAL);
  await page.$eval(`${MODAL} input`, (el) => { el.select(); });
  await page.keyboard.type('Second Book (renamed)');
  await page.evaluate(() => [...document.querySelectorAll('div[class*="z-[1100]"] [role=dialog] button')].find((b) => b.innerText.trim() === 'Save')?.click());
  await sleep(500);
  check('a document can be renamed', (await cardTitles(page)).includes('Second Book (renamed)'));
  const renamedOnServer = await waitUntil(async () => (await serverPull(page)).docs.find((d) => d.title === 'Second Book (renamed)'), { timeout: 30000, label: 'the rename to reach the server' });
  check('and the rename of a synced document reaches the server', !!renamedOnServer);

  // ----- trash -----
  await cardMenu(page, 'Third Book', 'Move to trash');
  await sleep(300);
  check('a document moved to the trash leaves the library', !(await cardTitles(page)).includes('Third Book'));
  await clickTab(page, 'Trash');
  await sleep(300);
  check('and is listed in the trash', (await cardTitles(page)).join('|') === 'Third Book');
  await cardMenu(page, 'Third Book', 'Restore');
  await sleep(300);
  await clickTab(page, 'All');
  await sleep(300);
  check('restoring brings it back', (await cardTitles(page)).includes('Third Book'));
  const blobsBefore = ((await dumpDb(page)).blobs || []).length;
  await cardMenu(page, 'Third Book', 'Move to trash');
  await sleep(300);
  await clickTab(page, 'Trash');
  await sleep(300);
  await cardMenu(page, 'Third Book', 'Delete forever');
  await page.waitForSelector(MODAL);
  const warning = await page.$eval(MODAL, (el) => el.innerText);
  check('deleting forever warns that a local-only document cannot be recovered', /not synced anywhere/.test(warning), warning.replace(/\n/g, ' '));
  await page.evaluate(() => [...document.querySelectorAll('div[class*="z-[1100]"] [role=dialog] button')].find((b) => b.innerText.trim() === 'Delete')?.click());
  await sleep(800);
  const dbEnd = await dumpDb(page);
  check("it is gone from the device, file included", dbEnd.docs.length === 2 && dbEnd.blobs.length === blobsBefore - 1, `${dbEnd.docs.length} docs, ${dbEnd.blobs.length}/${blobsBefore} blobs`);
  await clickTab(page, 'All');

  // ----- turn on sync for a document that already has ink -----
  const before = await serverPull(page);
  check('the first document is still only on this device', !before.docs.some((d) => d.title === 'Moby Dick (test)'));
  await cardMenu(page, 'Moby Dick', 'Sync with my server');
  await page.waitForSelector(MODAL);
  await shot(page, '71-turn-on-sync');
  const text = await page.$eval(MODAL, (el) => el.innerText);
  check('the dialog says what turning sync on does', /uploaded to your Quarc server/i.test(text), text.replace(/\n/g, ' '));
  await page.evaluate(() => [...document.querySelectorAll('div[class*="z-[1100]"] [role=dialog] button')].find((b) => b.innerText.trim() === 'Start syncing')?.click());
  const synced = await waitUntil(async () => {
    const p = await serverPull(page);
    const d = p.docs.find((x) => x.title === 'Moby Dick (test)');
    return d?.file_ready && p.anns.some((a) => a.doc_id === d.id && a.ink.elements.length) ? p : null;
  }, { timeout: 40000, label: 'the existing document, file and ink to reach the server' });
  check('turning sync on later uploads the file and the ink that was already written', !!synced);
  check('and the library marks it as synced', ((await dumpDb(page)).docs.find((d) => d.title === 'Moby Dick (test)') || {}).sync === 'cloud');

  check('no page errors', errors.length === 0, errors.join('\n'));
  await ctx.close();
}

// --------------------------------------------------------------------------------------------------

async function scenarioBig(browser) {
  section('A 300-page book');
  const big = writePdf('book-300.pdf', await makeTestPdf({ pages: 300, title: 'Three Hundred Pages' }));
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await lightMode(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, 'jo');
  const t0 = Date.now();
  await chooseOnImport(page, big, 'device only');
  await readerReady(page);
  const opened = Date.now() - t0;
  check('importing and opening 300 pages takes a few seconds, not minutes', opened < 25000, `${opened} ms`);
  const doc = (await dumpDb(page)).docs[0];
  check('all 300 page sizes were measured', doc.page_count === 300 && JSON.stringify(doc.sizes) === '[[300,595,842]]', JSON.stringify(doc.sizes));

  // jump around: far jumps must render the destination page, and the pool must not grow without bound
  const heapMB = async () => Math.round((await page.metrics()).JSHeapUsedSize / 1048576);
  const heap0 = await heapMB();
  let jumpMs = 0;
  for (const key of ['End', 'Home', 'End', 'Home', 'End']) {
    const s = Date.now();
    await page.keyboard.press(key);
    await waitIndicator(page, key === 'End' ? '300/300' : '1/300');
    await waitUntil(async () => (await paperStats(page))?.dark > 500, { label: `page to draw after ${key}` });
    jumpMs = Math.max(jumpMs, Date.now() - s);
  }
  check('jumping to the last/first page renders it quickly', jumpMs < 4000, `slowest ${jumpMs} ms`);
  // scroll through ~40 pages with the wheel
  await page.mouse.move(640, 500);
  await page.keyboard.press('Home');
  await sleep(500);
  for (let i = 0; i < 150; i++) {
    await page.mouse.wheel({ deltaY: 500 });
    if (i % 10 === 0) await sleep(30);
  }
  await sleep(1200);
  const at = parseInt(((await indicator(page)) || '0').split('/')[0], 10);
  check('wheel-scrolling a long way goes through the book', at > 20, `page ${at}`);
  await waitUntil(async () => (await paperStats(page))?.dark > 100, { label: 'pages to draw after a long scroll' });
  const heap1 = await heapMB();
  check('memory stays bounded (JS heap)', heap1 < heap0 + 250 && heap1 < 700, `${heap0} MB -> ${heap1} MB`);
  await shot(page, '80-big-book');

  // ink on a late page is stored under that page only
  await page.keyboard.press('End');
  await waitIndicator(page, '300/300');
  await sleep(800);
  const box = await page.$eval('.quarc-canvas-page', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await drawStroke(page, { x: box.x + 300, y: box.y + 300 }, { x: box.x + 600, y: box.y + 320 });
  await sleep(1500);
  const rows = (await dumpDb(page)).ann || [];
  check('ink on the last page is stored under p299', rows.length === 1 && rows[0].page_key === 'p299', rows.map((r) => r.page_key).join());
  check('no page errors', errors.length === 0, errors.join('\n'));
  await ctx.close();
}

main().catch((err) => {
  console.error(err);
  stopStack();
  process.exit(2);
});
