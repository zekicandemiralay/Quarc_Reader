// Run: npm test (from frontend/)
// Which tool a document opens with: the hand on a computer, the pen on a touch screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startToolFor, isMouseDevice } from '../src/lib/device.js';

test('automatic: a computer starts with the hand, a touch screen with the pen', () => {
  assert.equal(startToolFor({ platform: 'desktop', touch: false }), 'hand', 'the desktop app');
  assert.equal(startToolFor({ platform: 'desktop', touch: true }), 'hand', 'the desktop app on a touch laptop in tablet mode');
  assert.equal(startToolFor({ platform: 'web', touch: false }), 'hand', 'a browser on a computer');
  assert.equal(startToolFor({ platform: 'web', touch: true }), 'freedraw', 'a browser on a phone or tablet');
  assert.equal(startToolFor({ platform: 'android', touch: false }), 'freedraw', 'the Android app, even with a mouse attached');
  assert.equal(startToolFor({}), 'hand', 'no touch screen reported (some remote sessions and headless browsers report no pointer at all): a computer');
});

test('the setting can force either one', () => {
  for (const platform of ['android', 'desktop', 'web']) {
    for (const touch of [true, false]) {
      assert.equal(startToolFor({ setting: 'pen', platform, touch }), 'freedraw');
      assert.equal(startToolFor({ setting: 'hand', platform, touch }), 'hand');
    }
  }
});

test('the Hand button is for screens driven by a mouse', () => {
  assert.equal(isMouseDevice('desktop', true), true);
  assert.equal(isMouseDevice('web', false), true);
  assert.equal(isMouseDevice('web', true), false);
  assert.equal(isMouseDevice('android', false), false);
});
