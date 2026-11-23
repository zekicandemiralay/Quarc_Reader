// Run: npm test (from frontend/)
// Why a PDF would not open: what pdf.js throws, turned into something a person can act on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeOpenError } from '../src/lib/pdfError.js';

const ex = (name, extra = {}) => Object.assign(new Error(`${name} happened`), { name, ...extra });

test('a password-protected PDF is said to be one, wherever it came from', () => {
  assert.equal(describeOpenError(ex('PasswordException')).code, 'password');
  assert.equal(describeOpenError(ex('PasswordException'), { local: true }).code, 'password');
});

test('the server saying no sign-in is a sign-in problem, not a broken file', () => {
  assert.equal(describeOpenError(ex('UnexpectedResponseException', { status: 401 })).code, 'signin');
  assert.equal(describeOpenError(ex('UnexpectedResponseException', { status: 403 })).code, 'signin');
});

test('the server not having the file is its own message', () => {
  assert.equal(describeOpenError(ex('MissingPDFException')).code, 'gone');
  assert.equal(describeOpenError(ex('UnexpectedResponseException', { status: 404 })).code, 'gone');
});

test('a server failure and an unreachable server are told apart', () => {
  assert.equal(describeOpenError(ex('UnexpectedResponseException', { status: 500 })).code, 'server');
  assert.equal(describeOpenError(ex('UnexpectedResponseException', { status: 502 })).code, 'server');
  assert.equal(describeOpenError(ex('UnexpectedResponseException', { status: 0 })).code, 'network');
});

test('being offline wins over a vague failure, but not over what the server actually said', () => {
  assert.equal(describeOpenError(ex('Error'), { online: false }).code, 'offline');
  assert.equal(describeOpenError(ex('UnexpectedResponseException', { status: 404 }), { online: false }).code, 'gone');
});

test('a bad copy on this device is not blamed on the server', () => {
  assert.equal(describeOpenError(ex('InvalidPDFException'), { local: true }).code, 'invalid-local');
  assert.equal(describeOpenError(ex('FormatError'), { local: true }).code, 'invalid-local');
  assert.equal(describeOpenError(ex('Error'), { local: true }).code, 'unknown');
});

test('something that came from the server and is not a PDF is "invalid"', () => {
  assert.equal(describeOpenError(ex('InvalidPDFException')).code, 'invalid');
});

test('anything else is "unknown", and the detail always says what happened', () => {
  const r = describeOpenError(ex('UnexpectedResponseException', { status: 418 }));
  assert.equal(r.code, 'unknown');
  assert.match(r.detail, /UnexpectedResponseException/);
  assert.match(r.detail, /HTTP 418/);
  assert.match(describeOpenError(null).detail, /Error/);
  assert.ok(describeOpenError(ex('X', { message: 'y'.repeat(1000) })).detail.length <= 300);
});
