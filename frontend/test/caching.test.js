// Run: npm test (from frontend/)
// A deploy must show up on the next open, not after a hard reload (Shift+F5). Two things have to hold: the server tells the browser
// to revalidate the app shell, and the service worker does not trust the browser's HTTP cache when it loads a page. Neither can be
// run here (no nginx), so the files are checked for the rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// The body of `location <selector> { ... }` in nginx.conf (no nested braces in this file's locations).
function locationBlock(conf, selector) {
  const start = conf.indexOf(`location ${selector} {`);
  assert.ok(start >= 0, `nginx.conf has "location ${selector}"`);
  return conf.slice(start, conf.indexOf('}', start));
}

test('nginx revalidates the app shell and the service worker on every load', () => {
  const conf = read('../nginx.conf');
  for (const selector of ['= /index.html', '= /sw.js', '= /manifest.json']) {
    assert.match(locationBlock(conf, selector), /add_header\s+Cache-Control\s+"no-cache"/, `${selector} is sent with Cache-Control: no-cache`);
  }
});

test('the hashed build files are the only thing a browser may keep without asking', () => {
  const conf = read('../nginx.conf');
  // No blanket long-lived cache for the app: index.html would be cached with it.
  assert.doesNotMatch(conf, /expires\s+(max|\d+[dyMw])/i);
  assert.doesNotMatch(conf, /Cache-Control\s+"[^"]*(max-age|immutable)/i);
});

test('the service worker loads pages past the browser\'s HTTP cache', () => {
  const sw = read('../public/sw.js');
  const nav = sw.slice(sw.indexOf("request.mode === 'navigate'"), sw.indexOf("url.pathname.startsWith('/assets/')"));
  assert.match(nav, /fetch\(request,\s*\{\s*cache:\s*'no-cache'\s*\}\)/, 'a navigation is fetched with cache: no-cache');
});
