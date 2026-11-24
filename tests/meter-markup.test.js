// tests/meter-markup.test.js
//
// v1.5.9 regression tests for Claude's redesigned /settings/usage page, which
// replaced the session usage bar's role="progressbar" with a CDS Meter
// (role="meter", aria-valuenow / aria-valuetext / aria-labelledby).
//
// Includes a test against the real captured page dump (tests/fixtures/
// usage-page-2026.html) so any future markup change that breaks parsing is
// caught immediately.
//
// Run with:  node tests/meter-markup.test.js

const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'jsdom') return origResolve.call(this, '/home/claude/node_modules/jsdom', parent, ...rest);
  return origResolve.call(this, req, parent, ...rest);
};

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const blockTags = new Set(['DIV','SECTION','MAIN','P','H1','H2','H3','H4','H5','H6','LI','UL','OL','SPAN','HEADER','FOOTER','NAV','ARTICLE','TR','BR']);

function load(html) {
  const dom = new JSDOM(html, { url: 'https://claude.ai/settings/usage', pretendToBeVisual: true });
  const win = dom.window;
  Object.defineProperty(win.HTMLElement.prototype, 'innerText', {
    get() {
      const walk = (el) => {
        let out = '';
        for (const n of el.childNodes) {
          if (n.nodeType === 3) out += n.nodeValue;
          else if (n.nodeType === 1) {
            const s = walk(n);
            const b = blockTags.has(n.tagName);
            if (b && out && !out.endsWith('\n')) out += '\n';
            out += s;
            if (b && !out.endsWith('\n')) out += '\n';
          }
        }
        return out;
      };
      return walk(this);
    }, configurable: true
  });
  const sb = {
    document: win.document, window: win, location: win.location,
    chrome: { runtime: { onMessage: { addListener(){} }, sendMessage(){} } },
    MutationObserver: win.MutationObserver, NodeFilter: win.NodeFilter,
    Date, setTimeout: () => {}, module: { exports: {} }, console
  };
  vm.createContext(sb);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8') +
    '\nthis.__extract = extractState; this.__bar = readSessionUsageBar; this.__scope = findCurrentSessionScope;',
    sb
  );
  return sb;
}

let passed = 0, failed = 0;
function assert(name, cond, extra) {
  if (cond) { console.log('  PASS ', name); passed++; }
  else      { console.log('  FAIL ', name, extra ? JSON.stringify(extra) : ''); failed++; }
}

// A faithful reproduction of the redesigned Current-session row (CDS Meter).
function meterPage({ resetText = 'Resets in 17 min', valuenow = '21', valuetext = '21% used', labelId = '_r_vn_' } = {}) {
  return `<!doctype html><html><body><main>
    <section>
      <div><h3><span class="flex"><span>Plan usage limits</span><span>Max (5x)</span></span></h3></div>
      <div class="divide-y">
        <div class="flex flex-col gap-6 py-md">
          <div class="flex w-full flex-row flex-wrap items-center justify-between gap-x-lg gap-y-3">
            <div class="flex w-[13rem] shrink-0 flex-col gap-xs">
              <div class="flex items-center gap-1.5"><span id="${labelId}" class="text-body text-primary">Current session</span></div>
              ${resetText ? `<span class="whitespace-nowrap text-footnote text-secondary">${resetText}</span>` : ''}
            </div>
            <div class="flex flex-1 items-center gap-3 pl-6 md:max-w-xl">
              <div data-cds="Meter" data-variant="accent" class="w-full min-w-[200px] flex-1">
                <div data-variant="accent" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${valuenow}" aria-valuetext="${valuetext}" aria-labelledby="${labelId}" class="h-2 bg-accent"></div>
              </div>
              <span class="min-w-[5.5rem] whitespace-nowrap text-right text-footnote text-secondary">${valuetext}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
    <section>
      <div><h3>Weekly limits</h3></div>
      <div class="divide-y"><div class="flex flex-col gap-6 py-md">
        <div class="flex w-full flex-row">
          <div class="flex w-[13rem] shrink-0 flex-col gap-xs">
            <div class="flex items-center gap-1.5"><span id="_r_vp_">All models</span></div>
            <span>Resets Sat 6:29 AM</span>
          </div>
          <div class="flex flex-1 items-center gap-3">
            <div data-cds="Meter"><div role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="41" aria-valuetext="41% used" aria-labelledby="_r_vp_"></div></div>
            <span>41% used</span>
          </div>
        </div>
        <div class="flex w-full flex-row">
          <div class="flex w-[13rem] shrink-0 flex-col gap-xs">
            <div class="flex items-center gap-1.5"><span id="_r_vr_">Fable</span></div>
            <span>Resets Sat 6:29 AM</span>
          </div>
          <div class="flex flex-1 items-center gap-3">
            <div data-cds="Meter"><div role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="70" aria-valuetext="70% used" aria-labelledby="_r_vr_"></div></div>
            <span>70% used</span>
          </div>
        </div>
      </div></div>
    </section>
  </main></body></html>`;
}

console.log('\nrole="meter" markup (v1.5.9)');

// 1) Full new page: text + meter both present → active, correct reset time.
{
  const sb = load(meterPage({ resetText: 'Resets in 17 min', valuenow: '21' }));
  const st = sb.__extract();
  assert('active with reset time when "Resets in 17 min" + meter 21%',
    st && st.kind === 'active' && st.nextResetTime > Date.now(), st);
}

// 2) Meter reads the correct value via the aria-labelledby anchor (21, not
//    41 from "All models" or 70 from "Fable").
{
  const sb = load(meterPage({ valuenow: '21' }));
  const bar = sb.__bar(sb.__scope());
  assert('reads session meter value 21 via aria-labelledby (not weekly rows)',
    bar && bar.value === 21, bar);
}

// 3) Meter-only (reset text stripped) still yields active via the meter.
{
  const sb = load(meterPage({ resetText: '', valuenow: '21' }));
  const st = sb.__extract();
  assert('active via meter alone when reset text is missing',
    st && st.kind === 'active', st);
}

// 4) Meter at 0% and no reset text → blank.
{
  const sb = load(meterPage({ resetText: '', valuenow: '0', valuetext: '0% used' }));
  const st = sb.__extract();
  assert('blank when meter is 0% and no reset text',
    st && st.kind === 'blank', st);
}

// 5) valuenow missing but aria-valuetext present → parsed from valuetext.
{
  const sb = load(meterPage({ resetText: '', valuenow: '', valuetext: '34% used' }));
  const bar = sb.__bar(sb.__scope());
  assert('falls back to aria-valuetext when aria-valuenow is empty',
    bar && bar.value === 34, bar);
}

// 6) Legacy role="progressbar" still works (backward compatibility).
{
  const legacy = meterPage({ valuenow: '21' }).replace(/role="meter"/g, 'role="progressbar"');
  const sb = load(legacy);
  const st = sb.__extract();
  assert('still parses legacy role="progressbar" markup',
    st && st.kind === 'active', st);
}

console.log('\nReal captured page dump (2026 redesign)');

// 7) The actual page the user sent. Must resolve to active with a future
//    reset time (the dump shows "Resets in 17 min", 21% used).
{
  const fixturePath = path.join(__dirname, 'fixtures', 'usage-page-2026.html');
  if (fs.existsSync(fixturePath)) {
    const sb = load(fs.readFileSync(fixturePath, 'utf8'));
    const scope = sb.__scope();
    const st = sb.__extract();
    const bar = sb.__bar(scope);
    assert('real dump: scope is the Current-session block',
      scope && /current\s+session/i.test(scope.innerText || ''), scope?.innerText);
    assert('real dump: meter reads 21%',
      bar && bar.value === 21, bar);
    assert('real dump: extractState is active with future reset',
      st && st.kind === 'active' && st.nextResetTime > Date.now(), st);
  } else {
    console.log('  SKIP  real dump fixture not present at', fixturePath);
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
