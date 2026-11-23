// Run: npm test (from frontend/)
// Every t('key') used in the source exists in English, and Turkish has exactly
// the same keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const en = JSON.parse(readFileSync(join(src, 'i18n/en.json'), 'utf8'));
const tr = JSON.parse(readFileSync(join(src, 'i18n/tr.json'), 'utf8'));

function flatten(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') out.push(...flatten(v, key));
    else out.push(key);
  }
  return out;
}

function sourceFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(jsx?|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

// Keys built at run time: the families they come from.
const DYNAMIC = {
  'canvas.': ['lined', 'squared', 'dotted', 'empty'],
  'import.': ['local.title', 'local.body', 'cloud.title', 'cloud.body'],
  'library.empty.': ['all', 'reading', 'favorites', 'local', 'trash'],
  'library.filter.': ['all', 'reading', 'favorites', 'local', 'trash'],
  'library.importError.': ['password', 'invalid'],
  'library.sortBy.': ['recent', 'title', 'added'],
  'reader.error.': ['missing', 'not-ready', 'offline', 'password', 'invalid', 'invalid-local', 'signin', 'gone', 'server', 'network', 'unknown'],
  'reader.tool.': ['select', 'hand', 'rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'text', 'image', 'eraser', 'cutRect', 'cutFree'],
  'readingStyle.': ['scroll.title', 'scroll.body', 'book.title', 'book.body'],
  'settings.platform.': ['android', 'desktop', 'web'],
  'share.expiry.': ['never', '1d', '7d', '30d'],
  'syncMode.': ['on1', 'on2', 'on3', 'off1', 'off2', 'off3'],
};

test('every translation key used in the code exists in English', () => {
  const have = new Set(flatten(en));
  const used = new Set();
  for (const file of sourceFiles(src)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bt\(\s*(['`])([^'`]+)\1/g)) if (!m[2].includes('${')) used.add(m[2]);
  }
  const missing = [...used].filter((k) => !have.has(k) && !have.has(`${k}_other`));
  assert.deepEqual(missing, []);
  for (const [prefix, names] of Object.entries(DYNAMIC)) {
    for (const n of names) assert.ok(have.has(prefix + n), `missing ${prefix}${n}`);
  }
});

test('Turkish has exactly the same keys as English', () => {
  const a = flatten(en).sort();
  const b = flatten(tr).sort();
  assert.deepEqual(b.filter((k) => !a.includes(k)), [], 'keys only in Turkish');
  assert.deepEqual(a.filter((k) => !b.includes(k)), [], 'keys missing from Turkish');
});

test('placeholders match between the two languages', () => {
  const placeholders = (s) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',');
  const get = (obj, key) => key.split('.').reduce((o, k) => o?.[k], obj);
  for (const key of flatten(en)) assert.equal(placeholders(get(tr, key)), placeholders(get(en, key)), key);
});
