// tests/reset-preserve.test.js
//
// Regression test for the v1.5.7 fix to performWarmup: the next-reset-time
// must be preserved when a manual warmup is fired during an already-active
// session. Claude's 5-hour session window is anchored to the FIRST message
// of the session, so re-sending a message inside the active window does not
// extend it. Before this fix, performWarmup blindly set
// nextResetTime = Date.now() + 5h every time a warmup succeeded, which
// caused the popup to display "in 5h 0m" instead of the real remaining time.
//
// Run with:  node tests/reset-preserve.test.js

const OPTIMISTIC_SESSION_MS = 5 * 60 * 60 * 1000;

// Mirrors the decision block we put inside performWarmup.
function chooseNextResetTime(existing, nowTs) {
  if (
    existing.sessionState === 'active' &&
    typeof existing.nextResetTime === 'number' &&
    existing.nextResetTime > nowTs + 60 * 1000
  ) {
    return { value: existing.nextResetTime, kind: 'preserved' };
  }
  return { value: nowTs + OPTIMISTIC_SESSION_MS, kind: 'optimistic' };
}

let passed = 0, failed = 0;
function assert(name, cond, extra) {
  if (cond) { console.log('  PASS ', name); passed++; }
  else      { console.log('  FAIL ', name, extra || ''); failed++; }
}

console.log('\nchooseNextResetTime (v1.5.7 fix)');

// 1) Active session with a real future reset → preserve it.
{
  const now = 1_700_000_000_000;
  const realReset = now + 1.5 * 60 * 60 * 1000; // 1h 30m from now
  const r = chooseNextResetTime(
    { sessionState: 'active', nextResetTime: realReset }, now
  );
  assert('preserves an active session\'s real future reset',
    r.kind === 'preserved' && r.value === realReset);
}

// 2) Blank session → use optimistic 5h.
{
  const now = 1_700_000_000_000;
  const r = chooseNextResetTime({ sessionState: 'blank' }, now);
  assert('uses optimistic 5h when session is blank',
    r.kind === 'optimistic' && r.value === now + OPTIMISTIC_SESSION_MS);
}

// 3) Active but reset is already in the past → use optimistic 5h.
//    (Window expired, this warmup is starting a brand-new session.)
{
  const now = 1_700_000_000_000;
  const r = chooseNextResetTime(
    { sessionState: 'active', nextResetTime: now - 30 * 60 * 1000 }, now
  );
  assert('uses optimistic 5h when stored reset is overdue',
    r.kind === 'optimistic' && r.value === now + OPTIMISTIC_SESSION_MS);
}

// 4) Active but reset is < 60s away → treat as effectively expired,
//    use optimistic 5h. (Avoids preserving a value that's about to roll.)
{
  const now = 1_700_000_000_000;
  const r = chooseNextResetTime(
    { sessionState: 'active', nextResetTime: now + 30 * 1000 }, now
  );
  assert('uses optimistic 5h when stored reset is within 60s',
    r.kind === 'optimistic');
}

// 5) Unknown session state → use optimistic 5h.
{
  const now = 1_700_000_000_000;
  const r = chooseNextResetTime({ sessionState: 'unknown' }, now);
  assert('uses optimistic 5h when sessionState is unknown',
    r.kind === 'optimistic');
}

// 6) Active but no nextResetTime stored → use optimistic 5h.
{
  const now = 1_700_000_000_000;
  const r = chooseNextResetTime({ sessionState: 'active' }, now);
  assert('uses optimistic 5h when nextResetTime is missing',
    r.kind === 'optimistic');
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
