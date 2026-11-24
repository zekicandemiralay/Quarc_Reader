// Shared plumbing for the browser tests: starts the real backend, a stand-in for
// quarc-auth and the production build of the frontend, drives headless Chrome,
// and generates a PDF with text whose position we know.
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { randomBytes } from 'node:crypto';
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..');
export const OUT = process.env.E2E_OUT || join(tmpdir(), 'quarc-reader-e2e');
mkdirSync(OUT, { recursive: true });

// Unusual ports on purpose: a developer's own quarc-auth / dev servers usually sit on
// 3902, 3908 and 4173, and the tests must never collide with (or kill) those.
export const PORTS = {
  auth: Number(process.env.E2E_AUTH_PORT || 39902),
  backend: Number(process.env.E2E_BACKEND_PORT || 39908),
  web: Number(process.env.E2E_WEB_PORT || 44173),
};
export const BASE = `http://localhost:${PORTS.web}`;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const children = [];

function start(name, cmd, args, opts) {
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' && cmd === 'npx' });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  child.on('exit', (code) => {
    if (code && code !== 143 && code !== 1) console.log(`[${name}] exited ${code}\n${log.slice(-1500)}`);
  });
  child.getLog = () => log;
  children.push(child);
  return child;
}

async function waitFor(url, label, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`${label} did not start`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function startStack() {
  const data = mkdtempSync(join(tmpdir(), 'quarc-reader-data-'));
  const env = {
    ...process.env,
    JWT_SECRET: 'e2e-secret',
    // vite preview proxies /api/auth and /api like nginx does in production
    VITE_AUTH_PROXY_TARGET: `http://localhost:${PORTS.auth}`,
    VITE_API_PROXY_TARGET: `http://localhost:${PORTS.backend}`,
  };
  start('auth', process.execPath, [join(here, 'fake-auth.mjs')], { env: { ...env, PORT: String(PORTS.auth) }, cwd: here });
  start('backend', process.execPath, [join(ROOT, 'backend/src/index.js')], { env: { ...env, PORT: String(PORTS.backend), DATA_DIR: data }, cwd: join(ROOT, 'backend') });
  start('web', 'npx', ['vite', 'preview', '--port', String(PORTS.web), '--strictPort', '--host', 'localhost'], { env, cwd: join(ROOT, 'frontend') });
  await waitFor(`http://localhost:${PORTS.auth}/api/auth/me`, 'fake auth');
  await waitFor(`http://localhost:${PORTS.backend}/api/health`, 'backend');
  await waitFor(`${BASE}/`, 'web');
  return { data };
}

export function stopStack() {
  for (const c of children) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F']);
      else c.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

export async function launch() {
  const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) throw new Error('No Chrome/Edge found; set CHROME_PATH');
  return puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1', '--window-size=1280,900', '--hide-scrollbars'],
    defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
    // A page that never answers should fail a test in a minute, not three.
    protocolTimeout: Number(process.env.E2E_PROTOCOL_TIMEOUT || 60000),
  });
}

// ----- a PDF whose text we know ----------------------------------------------------------

export const PDF_LINES = [
  'Call me Ishmael. Some years ago, never mind how long precisely,',
  'having little or no money in my purse, and nothing particular',
  'to interest me on shore, I thought I would sail about a little',
  'and see the watery part of the world.',
];

// `links: true` puts three clickable lines on page 1: a web address, a jump to page 3, and a script (which must not work).
export async function makeTestPdf({ pages = 3, title = 'Moby Dick (test)', author = 'H. Melville', junkBytes = 0, links = false } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setAuthor(author);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Chapter ${p + 1}`, { x: 72, y: 760, size: 28, font: bold, color: rgb(0.1, 0.1, 0.1) });
    PDF_LINES.forEach((line, i) => page.drawText(line, { x: 72, y: 700 - i * 22, size: 13, font, color: rgb(0, 0, 0) }));
    page.drawText(`— page ${p + 1} of ${pages} —`, { x: 230, y: 40, size: 10, font, color: rgb(0.4, 0.4, 0.4) });
  }
  if (links) {
    const ctx = doc.context;
    const first = doc.getPage(0);
    const annots = [];
    const addLink = (text, y, action) => {
      first.drawText(text, { x: 72, y, size: 13, font, color: rgb(0.1, 0.2, 0.8) });
      const w = font.widthOfTextAtSize(text, 13);
      annots.push(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [72, y - 3, 72 + w, y + 13], Border: [0, 0, 0], ...action })));
    };
    addLink('Open the Quarc site', 600, { A: ctx.obj({ S: 'URI', URI: PDFString.of('https://example.com/quarc') }) });
    addLink('Jump to chapter 3', 560, { Dest: [doc.getPage(2).ref, 'XYZ', 0, 842, null] });
    addLink('Run a script', 520, { A: ctx.obj({ S: 'URI', URI: PDFString.of('javascript:alert(1)') }) });
    first.node.set(PDFName.of('Annots'), ctx.obj(annots));
  }
  // Ballast that no page refers to: makes the file big enough that a reader must stream it in ranges.
  if (junkBytes) doc.catalog.set(PDFName.of('QuarcBallast'), doc.context.register(doc.context.stream(randomBytes(junkBytes))));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

export function writePdf(name, bytes) {
  const p = join(OUT, name);
  writeFileSync(p, bytes);
  return p;
}

// ----- tiny assertions ---------------------------------------------------------------------

const results = [];
export function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
  return !!ok;
}
export function section(title) {
  console.log(`\n${title}`);
}
export function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  return failed.length;
}

// ----- browser helpers -------------------------------------------------------------------------

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(fn, { timeout = 15000, every = 150, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`);
    await sleep(every);
  }
}

export async function login(page, username = 'alice') {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
  await page.type('input[placeholder="Username"]', username);
  await page.type('input[placeholder="Password"]', 'pw');
  await Promise.all([page.waitForFunction(() => location.pathname === '/', { timeout: 15000 }), page.click('button[type=submit]')]);
}

// Everything in the app's IndexedDB, with Blobs reduced to their size.
export function dumpDb(page) {
  return page.evaluate(
    () =>
      (async () => {
        // Never CREATE the app's database from the test: a plain open() of a database that does
        // not exist yet makes an empty version-1 one, whose connection would then block the app's
        // own (higher-version) open. Read only what exists, and always release the connection.
        const existing = await indexedDB.databases();
        if (!existing.some((d) => d.name === 'quarc-reader')) return {};
        return new Promise((resolve, reject) => {
          const req = indexedDB.open('quarc-reader');
          req.onerror = () => reject(req.error);
          req.onblocked = () => reject(new Error('indexedDB open blocked'));
          req.onsuccess = () => {
            const db = req.result;
            const out = {};
            const names = [...db.objectStoreNames];
            let pending = names.length;
            if (!pending) {
              db.close();
              resolve(out);
              return;
            }
            for (const name of names) {
              const all = db.transaction(name).objectStore(name).getAll();
              all.onsuccess = () => {
                out[name] = all.result.map((row) => (row && row.blob instanceof Blob ? { ...row, blob: `Blob(${row.blob.size})` } : row));
                if (!--pending) {
                  db.close();
                  resolve(out);
                }
              };
            }
          };
        });
      })()
  );
}

export async function shot(page, name) {
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

// Fraction of "ink" (dark) pixels in the paper canvas, to prove a PDF page really got drawn.
export function paperStats(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.quarc-canvas-page canvas');
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let dark = 0;
    let white = 0;
    let colored = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 200) continue;
      const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (lum < 90) dark++;
      else if (lum > 240) white++;
      if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 60) colored++;
    }
    return { width, height, dark, white, colored };
  });
}

// Counts pixels matching `test(r, g, b, a)` on Excalidraw's canvases (where ink is drawn).
export function inkPixels(page, testSource) {
  return page.evaluate((src) => {
    const test = new Function('r', 'g', 'b', 'a', `return (${src});`);
    let n = 0;
    for (const canvas of document.querySelectorAll('.excalidraw canvas')) {
      if (!canvas.width || !canvas.height) continue;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < data.length; i += 4) if (test(data[i], data[i + 1], data[i + 2], data[i + 3])) n++;
    }
    return n;
  }, testSource);
}

export const RED = 'a > 200 && r > 170 && g < 90 && b < 90';

export async function lightMode(page, { defaults = true } = {}) {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  // The app asks "scroll or book?" every time it opens a document and defaults to sepia paper.
  // Most scenarios are about something else, so they open in scroll mode on white paper unless a
  // scenario asks for the real defaults (`defaults: false`: see scenarioStyle).
  if (defaults) await testDefaults(page);
}

// Fills settings the page does not have yet (never overrides what the app or an earlier call stored),
// before the app starts, on every load of the page.
export async function testDefaults(page, extra = {}) {
  await page.evaluateOnNewDocument(
    (extra) => {
      let current = {};
      try {
        current = JSON.parse(localStorage.getItem('quarc_reader_settings') || '{}');
      } catch {
        /* start from nothing */
      }
      localStorage.setItem('quarc_reader_settings', JSON.stringify({ settingsVersion: 2, readMode: 'scroll', paperMode: 'white', ...extra, ...current }));
    },
    extra
  );
}

// Draw a stroke with the mouse (the pen tool is active by default and the mouse draws with it).
export async function drawStroke(page, from, to, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps + Math.sin(i) * 3);
    await sleep(8);
  }
  await page.mouse.up();
}

export const dirOf = dirname;
