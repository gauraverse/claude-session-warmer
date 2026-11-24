// tests/select-model.test.js
//
// Smoke tests for the v1.5.7 injectedSelectModel function. Verifies the
// click flow against a small synthetic DOM that mimics Claude's model
// picker (button + menu of items).
//
// Requires jsdom, installed at /home/claude/node_modules.
//   node tests/select-model.test.js

const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'jsdom') return origResolve.call(this, '/home/claude/node_modules/jsdom', parent, ...rest);
  return origResolve.call(this, req, parent, ...rest);
};

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Pull just the function we want to test out of background.js by name.
const bgSource = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const fnMatch = bgSource.match(/function injectedSelectModel\([\s\S]*?\n\}\n/);
if (!fnMatch) { console.error('Could not extract injectedSelectModel from background.js'); process.exit(1); }
const injectedSelectModelSrc = fnMatch[0];

const DEFAULT_SELECTORS = {
  modelPicker: 'button[aria-label*="model" i], button[data-testid*="model" i], button[aria-haspopup="menu"]'
};

function makePage(currentLabel, options) {
  const html = `
    <!doctype html><html><body>
      <div id="composer">
        <button id="picker" aria-haspopup="menu" aria-label="Choose model">${currentLabel}</button>
        <div id="menu" role="menu" style="display:none">
          ${options.map(o => `<div role="menuitem">${o}</div>`).join('')}
        </div>
      </div>
    </body></html>`;
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  // Force getBoundingClientRect to return something sensible (jsdom returns zeroes).
  const win = dom.window;
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30 };
  };
  // Wire up the picker so clicking it "opens" the menu.
  const picker = win.document.getElementById('picker');
  const menu = win.document.getElementById('menu');
  picker.addEventListener('click', () => { menu.style.display = 'block'; });
  // Wire up menu items so clicking one updates the picker label and "closes" the menu.
  for (const it of menu.querySelectorAll('[role="menuitem"]')) {
    it.addEventListener('click', () => {
      picker.textContent = it.textContent;
      menu.style.display = 'none';
    });
  }
  return dom;
}

async function runIn(dom, model) {
  const win = dom.window;
  // eslint-disable-next-line no-new-func
  const fn = new win.Function('selectors', 'model', `
    ${injectedSelectModelSrc}
    return injectedSelectModel(model, selectors);
  `);
  return fn(DEFAULT_SELECTORS, model);
}

let passed = 0, failed = 0;
function assert(name, cond, extra) {
  if (cond) { console.log('  PASS ', name); passed++; }
  else      { console.log('  FAIL ', name, extra ? JSON.stringify(extra) : ''); failed++; }
}

(async () => {
  console.log('\ninjectedSelectModel (v1.5.7)');

  // 1) Already on target.
  {
    const dom = makePage('Haiku 4.5', ['Haiku 4.5', 'Sonnet 4.5', 'Opus 4.7']);
    const r = await runIn(dom, 'haiku');
    assert('returns alreadySelected when picker shows target',
      r && r.success === true && r.alreadySelected === true, r);
  }

  // 2) Switch from Sonnet to Haiku.
  {
    const dom = makePage('Sonnet 4.5', ['Haiku 4.5', 'Sonnet 4.5', 'Opus 4.7']);
    const r = await runIn(dom, 'haiku');
    const finalLabel = dom.window.document.getElementById('picker').textContent;
    assert('switches Sonnet → Haiku',
      r && r.success === true && /haiku/i.test(finalLabel), { r, finalLabel });
  }

  // 3) Target not in menu → success:false.
  {
    const dom = makePage('Sonnet 4.5', ['Sonnet 4.5', 'Opus 4.7']);
    const r = await runIn(dom, 'haiku');
    assert('returns success:false when target model is not offered',
      r && r.success === false, r);
  }

  // 4) auto / empty model → no-op success.
  {
    const dom = makePage('Sonnet 4.5', ['Haiku 4.5', 'Sonnet 4.5', 'Opus 4.7']);
    const r = await runIn(dom, 'auto');
    const finalLabel = dom.window.document.getElementById('picker').textContent;
    assert('"auto" model is a no-op (does not switch)',
      r && r.success === true && r.alreadySelected === true && /sonnet/i.test(finalLabel),
      { r, finalLabel });
  }

  // 5) No picker present → success:false.
  {
    const dom = new JSDOM(`<!doctype html><html><body><p>nothing here</p></body></html>`);
    dom.window.HTMLElement.prototype.getBoundingClientRect =
      () => ({ width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30 });
    const r = await runIn(dom, 'haiku');
    assert('returns success:false when no model picker is found',
      r && r.success === false, r);
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
