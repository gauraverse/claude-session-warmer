// content.js v1.2 — Claude Session Warmer
// Runs on every claude.ai page. Two responsibilities:
//   1. On /settings/usage, scrape state and proactively report it.
//   2. Respond to extract-state messages from the background.

(function init() {
  // Logged-out detection: /login, /signin, etc. → tell background we're logged out.
  if (/^\/(login|signin|sign-in|signup|sign-up)/i.test(location.pathname)) {
    safeSend({ type: 'state-from-content', state: { kind: 'logged-out' } });
    setupListener(); // still listen for explicit extract-state asks
    return;
  }

  if (location.pathname.startsWith('/settings/usage')) {
    observeUsagePage();
  }

  setupListener();
})();

function setupListener() {
  if (!chrome?.runtime?.onMessage) return;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'extract-state') {
      // Synchronous response — must return state immediately.
      if (/^\/(login|signin|sign-in|signup|sign-up)/i.test(location.pathname)) {
        sendResponse({ kind: 'logged-out' });
      } else if (location.pathname.startsWith('/settings/usage')) {
        sendResponse(extractState() || { kind: 'unknown' });
      } else {
        sendResponse({ kind: 'unknown' });
      }
      return false; // sync response complete
    }
  });
}

function safeSend(msg) {
  try { chrome.runtime.sendMessage(msg, () => { /* ignore lastError */ }); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage page observer
// ─────────────────────────────────────────────────────────────────────────────

function observeUsagePage() {
  // Try once immediately (in case page is already hydrated)
  if (tryAndReport()) return;

  // SPA hydrates async — watch for DOM changes
  const obs = new MutationObserver(() => {
    if (tryAndReport()) obs.disconnect();
  });
  if (document.body) {
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  // Stop watching after 25s regardless
  setTimeout(() => obs.disconnect(), 25000);
}

function tryAndReport() {
  const state = extractState();
  if (state && state.kind && state.kind !== 'unknown') {
    safeSend({ type: 'state-from-content', state });
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// State extraction — the brain.
//
// Returns:
//   { kind: 'active', nextResetTime: number }   — session is running
//   { kind: 'blank' }                           — no active session
//   null / { kind: 'unknown' }                  — can't tell yet
//
// Conservative principles:
//   • Only declare "blank" if the page has clearly hydrated AND mentions
//     usage-related vocabulary AND has no reset-time phrase. Otherwise leave it
//     to the next observation tick.
//   • Never falsely report active when we can't parse a time.
// ─────────────────────────────────────────────────────────────────────────────

function extractState() {
  const text = (document.body?.innerText || '').trim();
  if (text.length < 100) return null; // page not hydrated yet

  // Try active first — look for explicit reset time
  const active = findActiveResetTime(text);
  if (active) return { kind: 'active', nextResetTime: active };

  // ISO datetime fallback
  for (const t of document.querySelectorAll('time[datetime]')) {
    const ctx = (t.closest('*')?.innerText || '').toLowerCase();
    if (ctx.includes('reset') || ctx.includes('refresh')) {
      const d = new Date(t.getAttribute('datetime'));
      if (!isNaN(d.getTime()) && d.getTime() > Date.now()) {
        return { kind: 'active', nextResetTime: d.getTime() };
      }
    }
  }

  // To declare blank, require strong evidence we're on a hydrated usage page.
  const lower = text.toLowerCase();
  const isUsagePage = /usage|messages?\s+(used|remaining|sent)|weekly\s+limit|session\s+limit|current\s+session/i.test(text);
  const explicitlyEmpty = /no\s+(active|current)\s+session|session\s+(has\s+not\s+started|not\s+started\s+yet)|start\s+a\s+(?:conversation|chat)\s+to\s+begin/i.test(text);

  if (explicitlyEmpty) return { kind: 'blank' };

  // Soft-blank inference: clearly the usage page, fully loaded, no reset phrase anywhere.
  // Require a stricter test here to avoid false positives.
  if (isUsagePage && text.length > 300 && !/reset|refresh/i.test(text)) {
    return { kind: 'blank' };
  }

  // Otherwise — unknown. Caller will retry.
  return null;
}

// Parses any of the following from page text:
//   "Resets at 3:47 PM"
//   "Resets at 15:47"
//   "Resets in 4h 23m"
//   "Resets in 4 hours 23 minutes"
//   "Resets in 23 minutes"
//   "Session resets in 1h"
// Returns absolute timestamp (ms) or null.
function findActiveResetTime(rawText) {
  const text = rawText.toLowerCase();

  // 1. Clock time form: "resets at HH:MM[am/pm]"
  let m = text.match(/resets?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?/);
  if (m) {
    const ts = clockToTimestamp(parseInt(m[1]), parseInt(m[2]), m[3]);
    if (ts) return ts;
  }

  // 2. Hours-and-minutes: "resets in 4h 23m" or "resets in 4 hours 23 minutes"
  m = text.match(/resets?\s+in\s+(\d+)\s*(?:h(?:ours?|rs?)?)\s*(?:and\s+)?(?:(\d+)\s*(?:m(?:in(?:utes?)?)?))?/);
  if (m) {
    const hrs = parseInt(m[1]) || 0;
    const mins = parseInt(m[2] || '0') || 0;
    if (hrs || mins) return Date.now() + (hrs * 3600 + mins * 60) * 1000;
  }

  // 3. Minutes-only: "resets in 23 minutes" / "in 23m"
  m = text.match(/resets?\s+in\s+(\d+)\s*(?:m(?:in(?:utes?)?)?)\b/);
  if (m) {
    const mins = parseInt(m[1]) || 0;
    if (mins > 0) return Date.now() + mins * 60 * 1000;
  }

  return null;
}

function clockToTimestamp(hr, min, mer) {
  if (hr < 0 || hr > 23 || min < 0 || min > 59) return null;
  if (mer) {
    const M = mer.toUpperCase();
    if (M === 'PM' && hr < 12) hr += 12;
    if (M === 'AM' && hr === 12) hr = 0;
  }
  const c = new Date();
  c.setHours(hr, min, 0, 0);
  // If the time is in the past, assume it's tomorrow.
  if (c.getTime() <= Date.now()) c.setDate(c.getDate() + 1);
  return c.getTime();
}
