// Run: npm test (from frontend/)
// Colour helpers: typing a hex colour, the picker's HSV maths, and the recent-colours list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHex, hexToHsv, hsvToHex, pushRecent } from '../src/lib/color.js';

test('hex colours are accepted in the forms people type them', () => {
  assert.equal(normalizeHex('#E03131'), '#e03131');
  assert.equal(normalizeHex('e03131'), '#e03131');
  assert.equal(normalizeHex(' #abc '), '#aabbcc');
  assert.equal(normalizeHex('F80'), '#ff8800');
});

test('anything else is not a colour', () => {
  for (const bad of ['', '#', '#12', '#12345', '#1234567', 'ggg', 'red', null, undefined]) assert.equal(normalizeHex(bad), null, String(bad));
});

test('the primary and secondary colours convert to the right hue', () => {
  assert.deepEqual(hexToHsv('#ff0000'), { h: 0, s: 1, v: 1 });
  assert.equal(hexToHsv('#00ff00').h, 120);
  assert.equal(hexToHsv('#0000ff').h, 240);
  assert.equal(hexToHsv('#ffff00').h, 60);
  assert.equal(hexToHsv('#00ffff').h, 180);
  assert.equal(hexToHsv('#ff00ff').h, 300);
});

test('greys have no saturation, black has no value', () => {
  assert.deepEqual(hexToHsv('#808080'), { h: 0, s: 0, v: 128 / 255 });
  assert.equal(hexToHsv('#000000').v, 0);
  assert.equal(hexToHsv('#ffffff').s, 0);
});

test('HSV and hex round-trip', () => {
  for (const hex of ['#e03131', '#2f9e44', '#1971c2', '#f08c00', '#7048e8', '#1f2937', '#ffd43b', '#8ce99a', '#74c0fc', '#faa2c1', '#ffc078', '#000000', '#ffffff', '#123456']) {
    assert.equal(hsvToHex(hexToHsv(hex)), hex);
  }
});

test('the hue wraps round and the saturation is kept in range', () => {
  assert.equal(hsvToHex({ h: 360, s: 1, v: 1 }), '#ff0000');
  assert.equal(hsvToHex({ h: -120, s: 1, v: 1 }), '#0000ff');
  assert.equal(hsvToHex({ h: 0, s: 5, v: 2 }), '#ff0000');
  assert.equal(hsvToHex({ h: 0, s: -1, v: 0.5 }), '#808080');
});

test('the recent colours list has the newest first and each colour once', () => {
  let list = [];
  list = pushRecent(list, '#e03131');
  list = pushRecent(list, '#1971c2');
  list = pushRecent(list, '#2f9e44');
  assert.deepEqual(list, ['#2f9e44', '#1971c2', '#e03131']);
  list = pushRecent(list, '#E03131'); // used again, in capitals: moves to the front, no duplicate
  assert.deepEqual(list, ['#e03131', '#2f9e44', '#1971c2']);
});

test('the recent colours list is capped and ignores what is not a colour', () => {
  let list = [];
  for (let i = 0; i < 20; i++) list = pushRecent(list, `#${String(i).padStart(2, '0')}0000`, 12);
  assert.equal(list.length, 12);
  assert.equal(list[0], '#190000');
  assert.deepEqual(pushRecent(['#e03131'], 'nonsense'), ['#e03131']);
  assert.deepEqual(pushRecent(undefined, '#fff'), ['#ffffff']);
});
