// tests/progress-bar-active.test.js
//
// Tests the v1.5.8 progress-bar positive-signal detection in extractState.
// The new /settings/usage page has a <div role="progressbar"> next to the
// Current-session row with aria-valuenow="X" indicating % used. Any non-zero
// usage proves the session is currently active.
//
// Run with:  node tests/progress-bar-active.test.js

const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'jsdom') return origResolve.call(this, '/home/claude/node_modules/jsdom', parent, ...rest);
  return origResolve.call(this, req, parent, ...rest);
};

const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');

// Build a Current-session DOM matching the redesigned /settings/usage page.
function buildPage({ resetText = '', usagePct = 0, extraBodyText = '' } = {}) {
  return `<!doctype html><html><body>
    <main>
      <section>
        <div><h3><span><span>Plan usage limits</span><span>Max (5x)</span></span></h3></div>
        <div>
          <div>
            <div class="flex w-full">
              <div class="flex w-[13rem] shrink-0 flex-col gap-xs">
                <div class="flex items-center gap-1.5"><span>Current session</span></div>
                ${resetText ? `<span>${resetText}</span>` : ''}
              </div>
              <div class="flex flex-1">
                <div class="min-w-[200px]">
                  <div role="progressbar" aria-valuenow="${usagePct}" aria-label="Usage"></div>
                </div>
                <span>${usagePct}% used</span>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section>
        <div><h3>Weekly limits</h3></div>
        <div>
          <div class="flex w-full">
            <div class="flex w-[13rem]"><div><span>All models</span></div><span>Resets Sat 6:30 AM</span></div>
            <div class="flex flex-1"><span>7% used</span></div>
          </div>
        </div>
      </section>
      ${extraBodyText}
    </main>
  </body></html>`;
}

// Build a sandbox-loaded extractState bound to a particular page.
function loadExtract(html) {
  const dom = new JSDOM(html, { url: 'https://claude.ai/settings/usage', pretendToBeVisual: true });
  const win = dom.window;
  const blockTags = new Set(['DIV','SECTION','MAIN','P','H1','H2','H3','H4','H5','H6','LI','UL','OL','HEADER','FOOTER','NAV','ARTICLE','TR','BR']);
  Object.defineProperty(win.HTMLElement.prototype, 'innerText', {
    get() {
      const walk = (el) => {
        let out = '';
        for (const node of el.childNodes) {
          if (node.nodeType === 3) out += node.nodeValue;
          else if (node.nodeType === 1) {
            const sub = walk(node);
            if (blockTags.has(node.tagName) && out && !out.endsWith('\n')) out += '\n';
            out += sub;
            if (blockTags.has(node.tagName) && !out.endsWith('\n')) out += '\n';
          }
        }
        return out;
      };
      return walk(this);
    }, configurable: true
  });

  const sandbox = {
    document: win.document, window: win, location: win.location,
    chrome: { runtime: { onMessage: { addListener(){} }, sendMessage(){} } },
    MutationObserver: win.MutationObserver, NodeFilter: win.NodeFilter,
    Date, setTimeout: () => {}, module: { exports: {} }, console
  };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync('/home/claude/work/content.js', 'utf8') + '\nthis.__extract = extractState;',
    sandbox
  );
  return sandbox.__extract;
}

let passed = 0, failed = 0;
function assert(name, cond, extra) {
  if (cond) { console.log('  PASS ', name); passed++; }
  else      { console.log('  FAIL ', name, extra ? JSON.stringify(extra) : ''); failed++; }
}

console.log('\nextractState progress-bar signals (v1.5.8)');

// 1) Resets-in text + 10% used → active.
{
  const extract = loadExtract(buildPage({ resetText: 'Resets in 19 min', usagePct: 10 }));
  const r = extract();
  assert('active when "Resets in 19 min" and 10% used',
    r && r.kind === 'active' && r.nextResetTime > Date.now(), r);
}

// 2) Resets-in text + 0% used → active (the new window may have just started).
{
  const extract = loadExtract(buildPage({ resetText: 'Resets in 4 h 59 min', usagePct: 0 }));
  const r = extract();
  assert('active when "Resets in 4 h 59 min" and 0% used',
    r && r.kind === 'active' && r.nextResetTime > Date.now(), r);
}

// 3) NO reset text, but progress bar at 10% → still ACTIVE via the bar.
//    (Defends against transient renders where the time text hasn't appeared.)
{
  const extract = loadExtract(buildPage({ resetText: '', usagePct: 10 }));
  const r = extract();
  assert('active via progress bar even when reset text is missing',
    r && r.kind === 'active', r);
}

// 4) No reset text AND 0% used → null (we don't know, let observer retry).
{
  const extract = loadExtract(buildPage({ resetText: '', usagePct: 0 }));
  const r = extract();
  // Body text length must be > 100 for extractState to consider it at all.
  // If null, that's fine (we'd retry). If 'blank', that's also acceptable.
  // The thing we must NOT do is claim active here.
  assert('does not falsely report active when no reset and 0% used',
    r === null || r?.kind === 'blank', r);
}

// 5) Explicit "no active session" blank phrase + 0% used → blank.
{
  const extract = loadExtract(buildPage({
    resetText: 'No active session yet',
    usagePct: 0,
    extraBodyText: '<div>Plenty of padding text to push body length over 100 characters. Plenty of padding text to push body length over 100 characters.</div>'
  }));
  const r = extract();
  assert('blank when scoped text contains a blank phrase',
    r && r.kind === 'blank', r);
}

// 6) Page-text-only blank phrase (e.g. "You haven't started a conversation")
//    BUT progress bar shows 10% → ACTIVE wins (this is the key v1.5.8 fix:
//    a non-zero bar overrides a stray full-page blank match).
{
  const extract = loadExtract(buildPage({
    resetText: 'Resets in 12 min',
    usagePct: 10,
    extraBodyText: '<div>You haven\'t started a conversation in archive mode</div>'
  }));
  const r = extract();
  assert('progress bar > 0 overrides a full-page blank-phrase match',
    r && r.kind === 'active', r);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
