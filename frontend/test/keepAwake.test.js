// Run: npm test (from frontend/)
// Keeping the screen on while reading: one lock however many ask, let go with the last, asked for again when the page
// becomes visible, and the Android window flag instead of the web API in the app.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const set = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
const tick = () => new Promise((r) => setTimeout(r, 5));

// A stand-in for the browser: a wakeLock that records, and a document that can be shown or hidden.
function fakeBrowser({ refuse = false } = {}) {
  const log = [];
  const locks = [];
  const doc = {
    visibilityState: 'visible',
    listeners: [],
    addEventListener(type, fn) {
      if (type === 'visibilitychange') this.listeners.push(fn);
    },
    setVisible(v) {
      this.visibilityState = v ? 'visible' : 'hidden';
      for (const l of this.listeners) l();
    },
  };
  set('document', doc);
  set('navigator', {
    wakeLock: {
      request: async (type) => {
        if (refuse) throw new Error('NotAllowedError');
        log.push(`request ${type}`);
        const handlers = [];
        const lock = {
          released: false,
          addEventListener: (_t, fn) => handlers.push(fn),
          release: async () => {
            lock.released = true;
            log.push('release');
          },
          // what a browser does when the page is hidden
          dropped: () => {
            lock.released = true;
            handlers.forEach((h) => h());
          },
          // ...and a browser that forgets to say so (only the `released` flag changes)
          droppedQuietly: () => {
            lock.released = true;
          },
        };
        locks.push(lock);
        return lock;
      },
    },
  });
  set('window', {});
  return { log, locks, doc };
}

let mod;
beforeEach(async () => {
  // a fresh module (its counters) for each test
  mod = await import(`../src/lib/keepAwake.js?${Math.random()}`);
});

test('asking requests one screen lock, however many ask, and the last to let go releases it', async () => {
  const { log } = fakeBrowser();
  const a = mod.keepAwake();
  const b = mod.keepAwake();
  await tick();
  assert.deepEqual(log, ['request screen']);
  a();
  await tick();
  assert.deepEqual(log, ['request screen']); // still wanted
  b();
  await tick();
  assert.deepEqual(log, ['request screen', 'release']);
});

test('letting go twice is harmless', async () => {
  const { log } = fakeBrowser();
  const a = mod.keepAwake();
  const b = mod.keepAwake();
  await tick();
  a();
  a();
  await tick();
  assert.deepEqual(log, ['request screen']); // b still holds it
  b();
  await tick();
  assert.equal(log.filter((l) => l === 'release').length, 1);
});

test('the lock the browser drops when the page is hidden is asked for again when it is shown', async () => {
  const { log, locks, doc } = fakeBrowser();
  const off = mod.keepAwake();
  await tick();
  doc.setVisible(false);
  locks[0].dropped();
  await tick();
  assert.equal(log.length, 1); // hidden: nothing to ask for
  doc.setVisible(true);
  await tick();
  assert.deepEqual(log, ['request screen', 'request screen']);
  off();
});

test('a lock dropped without a release event is noticed from its released flag', async () => {
  const { log, locks, doc } = fakeBrowser();
  const off = mod.keepAwake();
  await tick();
  doc.setVisible(false);
  locks[0].droppedQuietly();
  doc.setVisible(true);
  await tick();
  assert.deepEqual(log, ['request screen', 'request screen']);
  off();
});

test('nothing is requested while the page is hidden', async () => {
  const { log, doc } = fakeBrowser();
  doc.visibilityState = 'hidden';
  const off = mod.keepAwake();
  await tick();
  assert.deepEqual(log, []);
  doc.setVisible(true);
  await tick();
  assert.deepEqual(log, ['request screen']);
  off();
});

test('a browser that refuses, or has no wake lock at all, is not an error', async () => {
  fakeBrowser({ refuse: true });
  const off = mod.keepAwake();
  await tick();
  off();
  set('navigator', {});
  const off2 = mod.keepAwake();
  await tick();
  off2();
  assert.ok(true);
});

test('letting go while the request is still on its way releases the lock that arrives', async () => {
  const { log } = fakeBrowser();
  const off = mod.keepAwake();
  off(); // before the browser has answered
  await tick();
  assert.deepEqual(log, ['request screen', 'release']);
});

test('in the Android app the window flag is used, not the web API', async () => {
  const { log } = fakeBrowser();
  const calls = [];
  set('window', { Capacitor: { isNativePlatform: () => true, Plugins: { KeepAwake: { enable: async () => calls.push('enable'), disable: async () => calls.push('disable') } } } });
  const a = mod.keepAwake();
  const b = mod.keepAwake();
  await tick();
  assert.deepEqual(calls, ['enable']);
  assert.deepEqual(log, []);
  a();
  b();
  await tick();
  assert.deepEqual(calls, ['enable', 'disable']);
  assert.deepEqual(log, []);
});

test('an app build without the plugin falls back to the web API', async () => {
  const { log } = fakeBrowser();
  set('window', { Capacitor: { isNativePlatform: () => true, Plugins: { KeepAwake: { enable: async () => Promise.reject(new Error('no such method')) } } } });
  const off = mod.keepAwake();
  await tick();
  await tick();
  assert.deepEqual(log, ['request screen']);
  off();
});
