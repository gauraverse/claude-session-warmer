// background.js v1.2 — Claude Session Warmer
//
// Architecture (corrected after v1.1's broken fetch-based approach):
//
//   STATE READING:
//     • To read session state, we open a real background tab to /settings/usage
//       and let content.js scrape it (claude.ai is a SPA — fetch() of HTML
//       returns an empty shell, so a tab is required for hydration).
//     • Tabs are only opened when state is unknown or stale (>30 min old) —
//       not on a polling schedule. The targeted reset alarm + event triggers
//       are what drive checks.
//
//   TRIGGERS:
//     • chrome.runtime.onStartup    → check & warmup if needed (morning case)
//     • chrome.idle.onStateChanged  → re-check when user returns to machine
//     • Targeted 'reset-fired' alarm → exact reset moment, no polling
//     • Hourly 'safety-check' alarm  → cheap fallback, only acts if stale
//     • Tab navigation to claude.ai when previously logged-out → re-evaluate
//
//   DEDUPE (no duplicate warmups):
//     • Each session window has signature = its nextResetTime (or 'BLANK')
//     • lastWarmedSignature locks a window after we warm it
//     • Auto-warmup refuses to fire same signature twice
//     • Manual warmup button bypasses this entirely

const DEFAULT_SETTINGS = {
  enabled: true,
  message: 'hi',
  model: 'claude-haiku',
  notifications: true,
  quietHoursEnabled: false,
  quietStart: '23:00',
  quietEnd: '06:00',
  selectors: {
    inputArea: '[contenteditable="true"], textarea[placeholder*="Reply" i], textarea[placeholder*="Message" i]',
    sendButton: 'button[aria-label*="Send" i], button[type="submit"]',
    modelSelector: 'button[aria-haspopup="menu"]'
  }
};

const STATE_FRESH_MS = 30 * 60 * 1000;     // state cached for 30 minutes
const TAB_SCRAPE_TIMEOUT_MS = 30000;       // 30s to scrape /settings/usage
const SAFETY_ALARM_HOURS = 4;              // safety net every 4h
const REAUTH_NOTIFY_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const RESET_BUFFER_MS = 30 * 1000;         // wait 30s past reset before firing

// In-memory mutex (best-effort; SW can restart and lose this, but tab-cleanup
// timeouts handle that case).
let evaluating = false;

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get('settings');
  if (!stored.settings) {
    await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  }
  await chrome.alarms.create('safety-check', { periodInMinutes: SAFETY_ALARM_HOURS * 60 });
  setTimeout(() => evaluateAndAct('install'), 1000);
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create('safety-check', { periodInMinutes: SAFETY_ALARM_HOURS * 60 });
  // Give browser a moment to settle, then evaluate.
  setTimeout(() => evaluateAndAct('startup'), 2000);
});

try { chrome.idle.setDetectionInterval(60); } catch {}

chrome.idle.onStateChanged.addListener((newState) => {
  if (newState === 'active') {
    evaluateAndAct('idle-active');
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'reset-fired') evaluateAndAct('reset-alarm');
  else if (alarm.name === 'safety-check') evaluateAndAct('safety');
});

// If state was logged-out and user navigates to a non-login claude.ai page,
// they probably just signed back in. Re-evaluate.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (!tab.url || !tab.url.startsWith('https://claude.ai/')) return;
  if (/\/(login|signin|sign-in|signup)/i.test(tab.url)) return;
  const { sessionState } = await chrome.storage.local.get('sessionState');
  if (sessionState === 'logged-out') {
    log('Logged-out → claude.ai page detected, re-evaluating');
    evaluateAndAct('post-login');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings & helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getSettings() {
  const stored = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

function isQuietHour(settings) {
  if (!settings.quietHoursEnabled) return false;
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = settings.quietStart.split(':').map(Number);
  const [eh, em] = settings.quietEnd.split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start < end) return mins >= start && mins < end;
  return mins >= start || mins < end;
}

function log(...args) { console.log('[CSW]', ...args); }

// ─────────────────────────────────────────────────────────────────────────────
// Core decision loop
// ─────────────────────────────────────────────────────────────────────────────

async function evaluateAndAct(reason, opts = {}) {
  if (evaluating) {
    log('evaluate already running, skipping:', reason);
    return;
  }
  evaluating = true;
  try {
    log('evaluateAndAct:', reason);
    const settings = await getSettings();
    if (!settings.enabled) { log('disabled'); return; }

    const stored = await chrome.storage.local.get(['sessionState', 'nextResetTime', 'lastUsageFetch']);
    const now = Date.now();
    const isFresh = !opts.force && stored.lastUsageFetch && (now - stored.lastUsageFetch < STATE_FRESH_MS);

    // Optimization: if we already know state and reset is in the future, just sleep.
    if (isFresh && stored.sessionState === 'active' && stored.nextResetTime && stored.nextResetTime > now + 60000) {
      log('Fresh active state, reset still future. Scheduling alarm only.');
      await scheduleResetAlarm(stored.nextResetTime);
      return;
    }

    // Otherwise, refresh state from claude.ai
    const state = await refreshState();
    if (!state) {
      log('refreshState returned null — keeping previous state, no action.');
      return;
    }

    if (state.kind === 'logged-out') {
      notifyReauthIfNeeded();
      return;
    }

    if (isQuietHour(settings)) {
      log('quiet hours, no action');
      // If active, still schedule alarm so we fire when quiet hours end.
      if (state.kind === 'active' && state.nextResetTime > now) {
        await scheduleResetAlarm(state.nextResetTime);
      }
      return;
    }

    if (state.kind === 'blank') {
      await maybeWarmup(settings, 'BLANK', reason);
    } else if (state.kind === 'active') {
      if (now >= state.nextResetTime) {
        await maybeWarmup(settings, state.nextResetTime, reason);
      } else {
        await scheduleResetAlarm(state.nextResetTime);
      }
    }
  } finally {
    evaluating = false;
  }
}

async function maybeWarmup(settings, signature, reason) {
  const { lastWarmedSignature } = await chrome.storage.local.get('lastWarmedSignature');
  if (lastWarmedSignature === signature) {
    log('Already warmed signature', signature, '— skip (dedupe).');
    return;
  }
  log('Auto-warmup for signature', signature, '(reason:', reason, ')');
  const ok = await performWarmup(settings, /*manual=*/false);
  if (ok) {
    await chrome.storage.local.set({ lastWarmedSignature: signature });
    // After 90s, re-evaluate so we discover the new reset time.
    setTimeout(() => evaluateAndAct('post-warmup', { force: true }), 90000);
  }
}

async function scheduleResetAlarm(resetTime) {
  const target = resetTime + RESET_BUFFER_MS;
  const delayMin = Math.max(0.5, (target - Date.now()) / 60000);
  await chrome.alarms.create('reset-fired', { delayInMinutes: delayMin });
  log('Reset alarm in', delayMin.toFixed(1), 'min (target:', new Date(target).toISOString(), ')');
}

// ─────────────────────────────────────────────────────────────────────────────
// State refresh — opens a tab, lets content.js scrape, closes tab.
// Returns: { kind: 'active', nextResetTime } | { kind: 'blank' } | { kind: 'logged-out' } | null
// ─────────────────────────────────────────────────────────────────────────────

async function refreshState() {
  // 1. If a /settings/usage tab is already open, just ask its content script.
  const usageTabs = await chrome.tabs.query({ url: 'https://claude.ai/settings/usage*' });
  for (const t of usageTabs) {
    try {
      const reply = await sendMessageWithTimeout(t.id, { type: 'extract-state' }, 3000);
      if (reply && reply.kind && reply.kind !== 'unknown') {
        log('State from existing usage tab:', reply.kind);
        await persistState(reply);
        return reply;
      }
    } catch {}
  }

  // 2. Open a background tab and wait for the scrape result.
  log('Opening background tab to /settings/usage');
  return scrapeViaBackgroundTab();
}

function sendMessageWithTimeout(tabId, msg, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, msg, (reply) => {
        if (chrome.runtime.lastError) { /* tab may not have CS */ }
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(reply || null);
      });
    } catch {
      if (!done) { done = true; clearTimeout(timer); resolve(null); }
    }
  });
}

async function scrapeViaBackgroundTab() {
  return new Promise(async (resolve) => {
    let resolved = false;
    let tab = null;

    const finish = async (state) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      if (tab) {
        try { await chrome.tabs.remove(tab.id); } catch {}
      }
      if (state) await persistState(state);
      resolve(state);
    };

    // Listener: catches state-from-content messages from our tab
    const msgListener = (msg, sender) => {
      if (sender.tab && tab && sender.tab.id === tab.id &&
          msg && msg.type === 'state-from-content' && msg.state) {
        finish(msg.state);
      }
    };
    // Listener: detects redirect to /login
    const updListener = (tabId, info, t) => {
      if (!tab || tabId !== tab.id) return;
      const u = info.url || t.url || '';
      if (u && /\/(login|signin|sign-in|signup)/i.test(u)) {
        finish({ kind: 'logged-out' });
      }
    };
    function cleanup() {
      try { chrome.runtime.onMessage.removeListener(msgListener); } catch {}
      try { chrome.tabs.onUpdated.removeListener(updListener); } catch {}
    }

    chrome.runtime.onMessage.addListener(msgListener);
    chrome.tabs.onUpdated.addListener(updListener);

    try {
      tab = await chrome.tabs.create({ url: 'https://claude.ai/settings/usage', active: false });
    } catch (err) {
      log('tab create failed:', err);
      cleanup();
      resolve(null);
      return;
    }

    // Hard timeout — if scrape never reports, give up.
    setTimeout(async () => {
      if (resolved) return;
      // Check final tab URL in case content script never fired
      try {
        const final = await chrome.tabs.get(tab.id);
        if (final?.url && /\/(login|signin|sign-in|signup)/i.test(final.url)) {
          finish({ kind: 'logged-out' });
          return;
        }
      } catch {}
      log('Scrape timed out, state unknown');
      finish(null);
    }, TAB_SCRAPE_TIMEOUT_MS);
  });
}

async function persistState(state) {
  const update = { lastUsageFetch: Date.now() };
  if (state.kind === 'active') {
    update.sessionState = 'active';
    update.nextResetTime = state.nextResetTime;
  } else if (state.kind === 'blank') {
    update.sessionState = 'blank';
    update.nextResetTime = null;
  } else if (state.kind === 'logged-out') {
    update.sessionState = 'logged-out';
  } else {
    update.sessionState = 'unknown';
  }
  await chrome.storage.local.set(update);
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-auth notification
// ─────────────────────────────────────────────────────────────────────────────

async function notifyReauthIfNeeded() {
  const { lastReauthNotify } = await chrome.storage.local.get('lastReauthNotify');
  const now = Date.now();
  if (lastReauthNotify && now - lastReauthNotify < REAUTH_NOTIFY_COOLDOWN_MS) return;
  await chrome.storage.local.set({ lastReauthNotify: now });
  const settings = await getSettings();
  if (!settings.notifications) return;
  chrome.notifications.create('reauth', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Claude Session Warmer — please log in',
    message: 'Click here to sign back into Claude. Warmups are paused until you do.'
  });
}

chrome.notifications.onClicked.addListener((id) => {
  if (id === 'reauth') {
    chrome.tabs.create({ url: 'https://claude.ai/login' });
    chrome.notifications.clear(id);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Warmup (send the actual "hi" message)
// ─────────────────────────────────────────────────────────────────────────────

async function performWarmup(settings, manual) {
  let tab;
  try {
    const claudeTabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    const reusable = claudeTabs.find(t => t.url && !t.url.includes('/settings/'));

    if (reusable) {
      tab = reusable;
      await chrome.tabs.update(tab.id, { url: 'https://claude.ai/new' });
    } else {
      tab = await chrome.tabs.create({ url: 'https://claude.ai/new', active: false });
    }
    await waitForTabComplete(tab.id);

    // Quick check: did we end up on /login?
    const refreshed = await chrome.tabs.get(tab.id);
    if (refreshed.url && /\/(login|signin|sign-in)/i.test(refreshed.url)) {
      await persistState({ kind: 'logged-out' });
      notifyReauthIfNeeded();
      await chrome.storage.local.set({ lastWarmupTime: Date.now(), lastWarmupResult: 'fail' });
      return false;
    }
  } catch (e) {
    log('tab open/navigate failed:', e);
    await chrome.storage.local.set({ lastWarmupResult: 'fail' });
    return false;
  }

  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectedSendMessage,
      args: [settings.message, settings.selectors]
    });

    const success = !!(result && result.success);
    const updates = {
      lastWarmupTime: Date.now(),
      lastWarmupResult: success ? 'ok' : 'fail'
    };
    if (success) {
      const { totalWarmups = 0 } = await chrome.storage.local.get('totalWarmups');
      updates.totalWarmups = totalWarmups + 1;
    }
    await chrome.storage.local.set(updates);

    if (settings.notifications) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: success
          ? (manual ? 'Manual warmup sent ✅' : 'Claude session started ✅')
          : 'Warmup failed ⚠️',
        message: success
          ? `Sent "${settings.message}".`
          : `Reason: ${(result && result.error) || 'unknown'}. If selectors are stale, fix them in Settings.`
      });
    }
    return success;
  } catch (err) {
    log('executeScript error:', err);
    await chrome.storage.local.set({ lastWarmupResult: 'fail' });
    if (settings.notifications) {
      chrome.notifications.create({
        type: 'basic', iconUrl: 'icons/icon128.png',
        title: 'Claude Session Warmer error',
        message: String(err.message || err)
      });
    }
    return false;
  }
}

// Self-contained — runs in page context.
function injectedSendMessage(message, selectors) {
  return new Promise((resolve) => {
    const TIMEOUT = 18000;
    const start = Date.now();

    const findInput = () => {
      const sels = selectors.inputArea.split(',').map(s => s.trim());
      for (const sel of sels) {
        try {
          const el = document.querySelector(sel);
          if (el) return el;
        } catch {}
      }
      return null;
    };
    const findSend = () => {
      const sels = selectors.sendButton.split(',').map(s => s.trim());
      for (const sel of sels) {
        try {
          const el = document.querySelector(sel);
          if (el && !el.disabled && !el.getAttribute('aria-disabled')) return el;
        } catch {}
      }
      return null;
    };
    const tryType = () => {
      const input = findInput();
      if (!input) return false;
      try { input.focus(); } catch {}
      if (input.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(input, message);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        // contenteditable
        input.textContent = message;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
      }
      return true;
    };
    const trySend = () => {
      const btn = findSend();
      if (!btn) return false;
      btn.click();
      return true;
    };

    let typed = false;
    const tick = () => {
      if (Date.now() - start > TIMEOUT) {
        resolve({ success: false, error: 'Timed out finding input or send button.' });
        return;
      }
      if (!typed) {
        if (tryType()) typed = true;
        else { setTimeout(tick, 400); return; }
      }
      // Give React time to enable the send button after input event
      setTimeout(() => {
        if (trySend()) {
          resolve({ success: true });
        } else {
          // Enter key fallback
          const input = findInput();
          if (input) {
            input.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
            }));
            resolve({ success: true, note: 'Enter fallback used.' });
          } else {
            resolve({ success: false, error: 'Send button not found.' });
          }
        }
      }, 800);
    };
    tick();
  });
}

async function waitForTabComplete(tabId) {
  return new Promise(async (resolve) => {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') { resolve(); return; }
    } catch { resolve(); return; }

    let done = false;
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete' && !done) {
        done = true;
        chrome.tabs.onUpdated.removeListener(listener);
        // Give SPA an extra moment to mount the chat input
        setTimeout(resolve, 1500);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      if (!done) {
        done = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }, 18000);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Messages from popup & content script
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'manual-warmup') {
        const settings = await getSettings();
        const ok = await performWarmup(settings, /*manual=*/true);
        if (ok) setTimeout(() => evaluateAndAct('post-manual-warmup', { force: true }), 90000);
        sendResponse({ ok });
      } else if (msg?.type === 'manual-refresh-state') {
        await evaluateAndAct('manual-refresh', { force: true });
        sendResponse({ ok: true });
      } else if (msg?.type === 'evaluate-now') {
        await evaluateAndAct('evaluate-now', { force: true });
        sendResponse({ ok: true });
      } else if (msg?.type === 'state-from-content' && msg.state) {
        // Content script proactively reporting (e.g. user visited /settings/usage)
        await persistState(msg.state);
        // If we got a fresh active state, schedule alarm
        if (msg.state.kind === 'active' && typeof msg.state.nextResetTime === 'number') {
          if (msg.state.nextResetTime > Date.now()) {
            await scheduleResetAlarm(msg.state.nextResetTime);
          }
        }
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false });
      }
    } catch (err) {
      log('onMessage handler error:', err);
      try { sendResponse({ ok: false, error: String(err) }); } catch {}
    }
  })();
  return true; // keep channel open for async response
});
