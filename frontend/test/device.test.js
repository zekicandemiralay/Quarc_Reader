// Run: npm test (from frontend/)
// Which tool a document opens with: the hand on a computer, the pen on a touch screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startToolFor, isMouseDevice } from '../src/lib/device.js';

test('automatic: a mouse starts with the hand, a touch screen with the pen', () => {
  assert.equal(startToolFor({ platform: 'desktop', finePointer: true }), 'hand', 'the desktop app');
  assert.equal(startToolFor({ platform: 'desktop', finePointer: false }), 'hand', 'the desktop app on a touch laptop in tablet mode');
  assert.equal(startToolFor({ platform: 'web', finePointer: true }), 'hand', 'a browser on a computer');
  assert.equal(startToolFor({ platform: 'web', finePointer: false }), 'freedraw', 'a browser on a phone or tablet');
  assert.equal(startToolFor({ platform: 'android', finePointer: true }), 'freedraw', 'the Android app, even with a mouse attached');
  assert.equal(startToolFor({}), 'freedraw', 'unknown: the old behaviour');
});

test('the setting can force either one', () => {
  for (const platform of ['android', 'desktop', 'web']) {
    for (const finePointer of [true, false]) {
      assert.equal(startToolFor({ setting: 'pen', platform, finePointer }), 'freedraw');
      assert.equal(startToolFor({ setting: 'hand', platform, finePointer }), 'hand');
    }
  }
});

test('the Hand button is for screens driven by a mouse', () => {
  assert.equal(isMouseDevice('desktop', false), true);
  assert.equal(isMouseDevice('web', true), true);
  assert.equal(isMouseDevice('web', false), false);
  assert.equal(isMouseDevice('android', true), false);
});
