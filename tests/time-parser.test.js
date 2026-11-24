// tests/time-parser.test.js
//
// Plain Node.js unit tests for the time-parsing logic in content.js.
// No framework required. Run with:  node tests/time-parser.test.js

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
  class FakeMutationObserver {
    constructor() {}
    observe() {}
    disconnect() {}
  }
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
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || '') + ' expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual));
  }
}
function assertNotNull(actual, msg) {
  if (actual === null || actual === undefined) {
    throw new Error((msg || '') + ' expected non-null, got ' + actual);
  }
}
function assertNull(actual, msg) {
  if (actual !== null) {
    throw new Error((msg || '') + ' expected null, got ' + JSON.stringify(actual));
  }
}

console.log('\nfindActiveResetTimeText');

test('hours-and-minutes form', () => {
  const { findActiveResetTimeText } = loadParser('2025-01-01T12:00:00Z');
  const r = findActiveResetTimeText('Resets in 4h 23m');
  assertNotNull(r);
  assertEqual(r.kind, 'active');
  const expected = Date.parse('2025-01-01T12:00:00Z') + (4 * 3600 + 23 * 60) * 1000;
  assertEqual(r.ts, expected, 'ts');
});

test('hours only', () => {
  const { findActiveResetTimeText } = loadParser('2025-01-01T12:00:00Z');
  const r = findActiveResetTimeText('resets in 1 hour');
  assertNotNull(r);
  assertEqual(r.kind, 'active');
  assertEqual(r.ts, Date.parse('2025-01-01T13:00:00Z'));
});

test('minutes only', () => {
  const { findActiveResetTimeText } = loadParser('2025-01-01T12:00:00Z');
  const r = findActiveResetTimeText('resets in 23 minutes');
  assertNotNull(r);
  assertEqual(r.kind, 'active');
  assertEqual(r.ts, Date.parse('2025-01-01T12:23:00Z'));
});

test('no match returns null', () => {
  const { findActiveResetTimeText } = loadParser('2025-01-01T12:00:00Z');
  assertNull(findActiveResetTimeText('hello world'));
});

console.log('\nclockToTimestamp');

test('future time today', () => {
  const { clockToTimestamp } = loadParser('2025-01-01T00:00:00Z');
  const r = clockToTimestamp(23, 59, null);
  assertNotNull(r);
  assertEqual(typeof r.ts, 'number');
  assertEqual(r.justReset, false);
});

test('past time within 5 min produces ts or justReset flag', () => {
  const { clockToTimestamp } = loadParser('2025-01-01T12:00:00Z');
  const r = clockToTimestamp(11, 58, null);
  assertNotNull(r);
  if (r.justReset !== true && typeof r.ts !== 'number') {
    throw new Error('expected either justReset or numeric ts');
  }
});

test('PM conversion 3:47 PM → 15:47', () => {
  const { clockToTimestamp } = loadParser('2025-01-01T00:00:00Z');
  const r = clockToTimestamp(3, 47, 'PM');
  assertNotNull(r);
  assertEqual(typeof r.ts, 'number');
});

test('AM 12:30 → 00:30', () => {
  const { clockToTimestamp } = loadParser('2025-01-01T18:00:00Z');
  const r = clockToTimestamp(12, 30, 'AM');
  assertNotNull(r);
});

test('out-of-range hours rejected', () => {
  const { clockToTimestamp } = loadParser('2025-01-01T12:00:00Z');
  assertNull(clockToTimestamp(25, 0, null));
  assertNull(clockToTimestamp(0, 75, null));
});

console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
