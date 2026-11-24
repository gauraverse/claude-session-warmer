// tests/blank-state.test.js
//
// Regression tests for v1.5.5 fix. Verifies that:
//   1. The new "Starts when a message is sent" phrase is detected as blank.
//   2. The weekly-limits "Resets Sat 6:30 AM" entry does NOT get parsed as
//      the session reset time.
//
// Run with:  node tests/blank-state.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const csSource = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function makeSandbox(fixedNowIso) {
  const fixed = new Date(fixedNowIso);
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) { super(fixed.getTime()); }
      else { super(...args); }
    }
    static now() { return fixed.getTime(); }
  }
  class FakeMutationObserver { constructor() {} observe() {} disconnect() {} }
  return {
    Date: FakeDate,
    document: { body: null, querySelectorAll: () => [] },
    location: { pathname: '/settings/usage' },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage() {} } },
    MutationObserver: FakeMutationObserver,
    module: { exports: {} },
    setTimeout: () => {},
    console
  };
}

function loadParser(fixedNowIso) {
  const sandbox = makeSandbox(fixedNowIso);
  vm.createContext(sandbox);
  vm.runInContext(csSource, sandbox);
  return sandbox.module.exports;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  PASS  ' + name); passed++; }
  catch (e) { console.log('  FAIL  ' + name); console.log('        ' + (e.message || e)); failed++; }
}
function assertTrue(v, msg) { if (!v) throw new Error(msg || ('expected truthy, got ' + v)); }
function assertFalse(v, msg) { if (v) throw new Error(msg || ('expected falsy, got ' + JSON.stringify(v))); }
function assertNull(v, msg) { if (v !== null) throw new Error(msg || ('expected null, got ' + JSON.stringify(v))); }
function assertEqual(a, e, msg) { if (a !== e) throw new Error((msg||'') + ' expected ' + JSON.stringify(e) + ' got ' + JSON.stringify(a)); }

console.log('\nmatchesBlankPhrase (v1.5.5)');

test('detects "Starts when a message is sent"', () => {
  const { matchesBlankPhrase } = loadParser('2025-01-01T12:00:00Z');
  assertTrue(matchesBlankPhrase('Current session\nStarts when a message is sent'));
});

test('detects "starts when the message is sent"', () => {
  const { matchesBlankPhrase } = loadParser('2025-01-01T12:00:00Z');
  assertTrue(matchesBlankPhrase('Starts when the message is sent'));
});

test('detects legacy "no active session"', () => {
  const { matchesBlankPhrase } = loadParser('2025-01-01T12:00:00Z');
  assertTrue(matchesBlankPhrase('No active session yet'));
});

test('does NOT match unrelated text', () => {
  const { matchesBlankPhrase } = loadParser('2025-01-01T12:00:00Z');
  assertFalse(matchesBlankPhrase('Resets Sat 6:30 AM'));
});

console.log('\nfindActiveResetTimeText weekly-vs-session disambiguation (v1.5.5)');

test('IGNORES "Resets Sat 6:30 AM" (weekly with weekday)', () => {
  const { findActiveResetTimeText } = loadParser('2025-01-01T12:00:00Z');
  const r = findActiveResetTimeText('All models Resets Sat 6:30 AM 11% used');
  assertNull(r, 'weekly entry should not be parsed as session reset');
});

test('IGNORES "Resets Mon 9:00 PM" (weekly with weekday)', () => {
  const { findActiveResetTimeText } = loadParser('2025-01-01T12:00:00Z');
  const r = findActiveResetTimeText('Weekly limits Resets Mon 9:00 PM');
  assertNull(r);
});

test('STILL parses "Resets at 3:47 PM" (legacy session format)', () => {
  const { findActiveResetTimeText } = loadParser('2025-01-01T12:00:00Z');
  const r = findActiveResetTimeText('Current session Resets at 3:47 PM');
  assertTrue(r && r.kind === 'active', 'expected active, got ' + JSON.stringify(r));
});

test('STILL parses "Resets in 4h 23m"', () => {
  const { findActiveResetTimeText } = loadParser('2025-01-01T12:00:00Z');
  const r = findActiveResetTimeText('Current session Resets in 4h 23m');
  assertTrue(r && r.kind === 'active');
  assertEqual(r.ts, Date.parse('2025-01-01T12:00:00Z') + (4 * 3600 + 23 * 60) * 1000);
});

console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
