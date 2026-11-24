// tests/active-session-guard.test.js
//
// Tests the v1.5.8 belt-and-suspenders guard in maybeWarmup that refuses
// to fire an auto-warmup while the stored state clearly shows an active
// session with time remaining.
//
// Run with:  node tests/active-session-guard.test.js

// Mirror the exact decision logic from maybeWarmup. If this drifts from
// background.js, this test will catch it via the next code review.
function shouldRefuseAutoWarmup(stored, nowMs) {
  if (
    stored.sessionState === 'active' &&
    typeof stored.nextResetTime === 'number' &&
    stored.nextResetTime > nowMs + 2 * 60 * 1000
  ) {
    return true;
  }
  return false;
}

let passed = 0, failed = 0;
function assert(name, cond, extra) {
  if (cond) { console.log('  PASS ', name); passed++; }
  else      { console.log('  FAIL ', name, extra || ''); failed++; }
}

console.log('\nmaybeWarmup auto-warmup guard (v1.5.8)');

const NOW = 1_700_000_000_000;

// 1) Active session with 19 minutes left (the user's exact scenario) —
//    must REFUSE to auto-warm.
{
  const stored = { sessionState: 'active', nextResetTime: NOW + 19 * 60 * 1000 };
  assert('refuses warmup when active session has 19 min left',
    shouldRefuseAutoWarmup(stored, NOW) === true);
}

// 2) Active session with 1 hour left — refuse.
{
  const stored = { sessionState: 'active', nextResetTime: NOW + 60 * 60 * 1000 };
  assert('refuses warmup when active session has 1 hour left',
    shouldRefuseAutoWarmup(stored, NOW) === true);
}

// 3) Active session with 2:01 left — refuse (just past the 2-min threshold).
{
  const stored = { sessionState: 'active', nextResetTime: NOW + 2 * 60 * 1000 + 1000 };
  assert('refuses warmup when active session has just over 2 min left',
    shouldRefuseAutoWarmup(stored, NOW) === true);
}

// 4) Active session with exactly 2 min left — do NOT refuse (allow firing).
//    Strict > means 2-min mark allows the warmup.
{
  const stored = { sessionState: 'active', nextResetTime: NOW + 2 * 60 * 1000 };
  assert('allows warmup when active session has exactly 2 min left',
    shouldRefuseAutoWarmup(stored, NOW) === false);
}

// 5) Active session with 1 minute left — allow.
{
  const stored = { sessionState: 'active', nextResetTime: NOW + 60 * 1000 };
  assert('allows warmup when active session has 1 min left',
    shouldRefuseAutoWarmup(stored, NOW) === false);
}

// 6) Active session that just expired — allow (we want to warm up at reset).
{
  const stored = { sessionState: 'active', nextResetTime: NOW - 1000 };
  assert('allows warmup when active session just expired',
    shouldRefuseAutoWarmup(stored, NOW) === false);
}

// 7) Blank session — allow (this is exactly when we want to warm).
{
  const stored = { sessionState: 'blank', nextResetTime: null };
  assert('allows warmup when session is blank',
    shouldRefuseAutoWarmup(stored, NOW) === false);
}

// 8) Unknown session state — allow.
{
  const stored = { sessionState: 'unknown' };
  assert('allows warmup when session state is unknown',
    shouldRefuseAutoWarmup(stored, NOW) === false);
}

// 9) Empty stored state — allow (fresh install).
{
  assert('allows warmup when stored state is empty',
    shouldRefuseAutoWarmup({}, NOW) === false);
}

// 10) Active state but nextResetTime is bogus (string/null) — allow.
{
  assert('allows warmup when nextResetTime is null',
    shouldRefuseAutoWarmup({ sessionState: 'active', nextResetTime: null }, NOW) === false);
  assert('allows warmup when nextResetTime is missing',
    shouldRefuseAutoWarmup({ sessionState: 'active' }, NOW) === false);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
