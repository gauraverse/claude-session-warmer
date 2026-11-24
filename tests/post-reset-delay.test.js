// tests/post-reset-delay.test.js
//
// v1.5.10 tests for computePostResetDelayMs — the configurable post-reset
// delay plus random jitter. We extract the function (and the two clamp
// constants + DEFAULT_SETTINGS) out of background.js and exercise it with an
// injectable RNG so the "random" part is deterministic in tests.
//
// Run with:  node tests/post-reset-delay.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const bg = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

// Pull the pieces we need into a sandbox: the two MAX constants, the default
// settings object, and the function itself.
function grab(re, label) {
  const m = bg.match(re);
  if (!m) { console.error('Could not extract', label, 'from background.js'); process.exit(1); }
  return m[0];
}

const defaultsSrc = grab(/const DEFAULT_SETTINGS = \{[\s\S]*?\n\};/, 'DEFAULT_SETTINGS');
const maxDelaySrc = grab(/const POST_RESET_DELAY_MIN_MAX = \d+;/, 'POST_RESET_DELAY_MIN_MAX');
const maxJitterSrc = grab(/const POST_RESET_JITTER_SEC_MAX = \d+;/, 'POST_RESET_JITTER_SEC_MAX');
const fnSrc = grab(/function computePostResetDelayMs\([\s\S]*?\n\}/, 'computePostResetDelayMs');

const sandbox = { Math, Number, console, module: { exports: {} } };
vm.createContext(sandbox);
vm.runInContext(
  `${defaultsSrc}\n${maxDelaySrc}\n${maxJitterSrc}\n${fnSrc}\n` +
  `this.__fn = computePostResetDelayMs; this.__defaults = DEFAULT_SETTINGS; ` +
  `this.__maxDelay = POST_RESET_DELAY_MIN_MAX; this.__maxJitter = POST_RESET_JITTER_SEC_MAX;`,
  sandbox
);
const compute = sandbox.__fn;
const DEF = sandbox.__defaults;

let passed = 0, failed = 0;
function assert(name, cond, extra) {
  if (cond) { console.log('  PASS ', name); passed++; }
  else      { console.log('  FAIL ', name, extra != null ? JSON.stringify(extra) : ''); failed++; }
}

// A fixed RNG: rand() === r for every call. r=0.5 → jitter 0; r=0 → -jitter; r=1 → +jitter.
const fixed = (r) => () => r;

console.log('\ncomputePostResetDelayMs (v1.5.10)');

// 1) rand=0.5 means zero jitter → delay is exactly the base.
{
  const ms = compute({ postResetDelayMin: 5, postResetJitterSec: 30 }, fixed(0.5));
  assert('rand=0.5 yields exactly the base (5 min)', ms === 5 * 60 * 1000, ms);
}

// 2) rand=1 means +full jitter → base + jitter seconds.
{
  const ms = compute({ postResetDelayMin: 5, postResetJitterSec: 30 }, fixed(1));
  assert('rand=1 yields base + 30s', ms === 5 * 60 * 1000 + 30 * 1000, ms);
}

// 3) rand=0 means -full jitter → base - jitter seconds.
{
  const ms = compute({ postResetDelayMin: 5, postResetJitterSec: 30 }, fixed(0));
  assert('rand=0 yields base - 30s', ms === 5 * 60 * 1000 - 30 * 1000, ms);
}

// 4) Never negative: tiny base, huge jitter, rand=0 → floored at 0.
{
  const ms = compute({ postResetDelayMin: 0, postResetJitterSec: 600 }, fixed(0));
  assert('result is floored at 0 (never negative)', ms === 0, ms);
}

// 5) Jitter disabled (0) → always exactly the base regardless of rand.
{
  const a = compute({ postResetDelayMin: 3, postResetJitterSec: 0 }, fixed(0));
  const b = compute({ postResetDelayMin: 3, postResetJitterSec: 0 }, fixed(1));
  assert('jitter 0 → base is exact and stable', a === 3 * 60 * 1000 && b === a, { a, b });
}

// 6) Over-range base is clamped to the max.
{
  const ms = compute({ postResetDelayMin: 9999, postResetJitterSec: 0 }, fixed(0.5));
  assert('base clamped to POST_RESET_DELAY_MIN_MAX', ms === sandbox.__maxDelay * 60 * 1000, ms);
}

// 7) Over-range jitter is clamped to the max.
{
  const ms = compute({ postResetDelayMin: 60, postResetJitterSec: 99999 }, fixed(1));
  assert('jitter clamped to POST_RESET_JITTER_SEC_MAX',
    ms === 60 * 60 * 1000 + sandbox.__maxJitter * 1000, ms);
}

// 8) Missing / invalid settings fall back to defaults.
{
  const ms = compute({}, fixed(0.5));
  assert('empty settings → default base, zero jitter at rand=0.5',
    ms === DEF.postResetDelayMin * 60 * 1000, ms);
  const ms2 = compute(undefined, fixed(0.5));
  assert('undefined settings → default base', ms2 === DEF.postResetDelayMin * 60 * 1000, ms2);
  const ms3 = compute({ postResetDelayMin: 'abc', postResetJitterSec: null }, fixed(0.5));
  assert('non-numeric settings → defaults', ms3 === DEF.postResetDelayMin * 60 * 1000, ms3);
}

// 9) Negative inputs fall back to defaults (not used as-is).
{
  const ms = compute({ postResetDelayMin: -5, postResetJitterSec: -10 }, fixed(0.5));
  assert('negative base/jitter → defaults', ms === DEF.postResetDelayMin * 60 * 1000, ms);
}

// 10) With real Math.random, many samples stay within [base-jitter, base+jitter]
//     and actually vary (not all identical).
{
  const base = 5 * 60 * 1000, jit = 30 * 1000;
  let min = Infinity, max = -Infinity;
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const ms = compute({ postResetDelayMin: 5, postResetJitterSec: 30 });
    if (ms < min) min = ms;
    if (ms > max) max = ms;
    seen.add(ms);
  }
  assert('samples stay within [base-jitter, base+jitter]',
    min >= base - jit && max <= base + jit, { min, max });
  assert('samples actually vary (jitter is live)', seen.size > 50, seen.size);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
