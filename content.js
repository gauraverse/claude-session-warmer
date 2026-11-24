// content.js v1.5.9 — Claude Session Warmer
//
// v1.5.9 changes:
//   FIX: Claude's redesigned /settings/usage page replaced the session usage
//        bar's role="progressbar" with a CDS Meter (role="meter", with
//        aria-valuenow / aria-valuetext / aria-labelledby). readSessionUsageBar
//        now reads role="meter" too, prefers the bar whose aria-labelledby
//        points at the "Current session" label, and falls back to parsing
//        aria-valuetext ("21% used"). The legacy role="progressbar" path is
//        kept for backward compatibility. Text parsing ("Resets in X min")
//        was unaffected and still works; this restores the progress-bar
//        positive-active signal (Layer 2) on the new page.
//
// v1.5.8 changes:
//   NEW: readSessionUsageBar() — read aria-valuenow from the Current-session
//        progress bar on the redesigned /settings/usage page. Any non-zero
//        usage is a conclusive positive signal that a session is active.
//   FIX: Page-shape blank fallback is stricter. It now requires a confirmed
//        Current-session DOM scope, no reset text inside it, AND a 0% (or
//        missing) progress bar. Without these signals we return null and
//        let observeUsagePage keep trying rather than push a false blank.
//   FIX: tryAndReport holds blank readings for ~1.2s before pushing them to
//        background. Transient blanks during initial page render no longer
//        leak through. Active readings are pushed immediately.
//
// v1.5.5 changes:
//   FIX: Recognise the new "Current session — Starts when a message is sent"
//        blank-state phrase used by the redesigned /settings/usage page.
//   FIX: Scope reset-time extraction to the Current-session block so it no
//        longer mistakes the Weekly-limits "Resets Sat 6:30 AM" entry for the
//        session reset.
//   FIX: findIsoResetTime no longer relies on the broken `closest('*')` call;
//        it walks ancestors and uses container text for context.
//   FIX: Page-wide blank fallback now ignores the word "Resets" when it only
//        appears inside the Weekly-limits section.
//
// v1.5 changes (kept):
//   #5  ISO datetime path is PRIMARY; free-text is fallback.
//   #12 If a parsed clock time is in the past by < 5 minutes, treat as 'blank'.

// v1.5.8: state for blank-stability check (declared above the init IIFE so
// that it's initialized before observeUsagePage runs).
let pendingBlankAt = 0;
const BLANK_STABILITY_MS = 1200;

(function init() {
  if (/^\/(login|signin|sign-in|signup|sign-up)/i.test(location.pathname)) {
    safeSend({ type: 'state-from-content', state: { kind: 'logged-out' } });
    setupListener();
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
      if (/^\/(login|signin|sign-in|signup|sign-up)/i.test(location.pathname)) {
        sendResponse({ kind: 'logged-out' });
      } else if (location.pathname.startsWith('/settings/usage')) {
        sendResponse(extractState() || { kind: 'unknown' });
      } else {
        sendResponse({ kind: 'unknown' });
      }
      return false;
    }
  });
}

function safeSend(msg) {
  try { chrome.runtime.sendMessage(msg, () => { void chrome.runtime.lastError; }); } catch {}
}

function observeUsagePage() {
  if (tryAndReport()) return;
  const obs = new MutationObserver(() => {
    if (tryAndReport()) obs.disconnect();
  });
  if (document.body) {
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  setTimeout(() => obs.disconnect(), 25000);
}

// v1.5.8: When the mutation observer first sees a blank reading, the page
// may still be loading and the Current-session row may not have rendered
// yet. We hold blank readings for a short stability window and only push
// them to the background if the page is still blank after the delay. Active
// readings are pushed immediately. This prevents transient false-blanks
// during initial render from triggering a warmup.
// (pendingBlankAt + BLANK_STABILITY_MS are declared above the IIFE.)

function tryAndReport() {
  const state = extractState();
  if (!state || !state.kind || state.kind === 'unknown') return false;

  if (state.kind === 'blank') {
    const now = Date.now();
    if (pendingBlankAt === 0) {
      pendingBlankAt = now;
      // Schedule one more attempt after the stability window. If the page
      // is still blank then, we'll report it. If it has resolved to active
      // (or anything else), this is a no-op because that branch reports
      // immediately and disconnects.
      try { setTimeout(() => tryAndReport(), BLANK_STABILITY_MS + 50); } catch {}
      return false;
    }
    if (now - pendingBlankAt < BLANK_STABILITY_MS) return false;
  } else {
    pendingBlankAt = 0;
  }

  safeSend({ type: 'state-from-content', state });
  return true;
}

// ─── State extraction ───────────────────────────────────────────────────────

function extractState() {
  const text = (document.body?.innerText || '').trim();
  if (text.length < 100) return null;

  // Restrict our analysis to the Current-session region whenever we can find it.
  // This stops us from confusing "Resets Sat 6:30 AM" (a Weekly-limits entry on
  // the redesigned page) with the session reset.
  const sessionScope = findCurrentSessionScope();
  const sessionText = (sessionScope?.innerText || '').trim();

  // v1.5.8/1.5.9: Positive active-session signal via the usage bar. If the
  // Current-session row has a meter (role="meter" on the 2026 redesign, or
  // the legacy role="progressbar") with a numeric aria-valuenow > 0, the
  // user has used some of the 5-hour window — meaning a session is
  // *conclusively* active right now, regardless of how the surrounding text
  // reads. We still want to extract the reset time when we can; this only
  // forces us NOT to return blank.
  const usage = readSessionUsageBar(sessionScope);
  const usedFraction = usage && typeof usage.value === 'number' ? usage.value : null;

  // 1) Explicit blank phrases — try the scoped text first, then full page.
  //    A non-zero usage bar overrides the full-page blank match (a row like
  //    "You haven't used Sonnet yet" elsewhere on the page is not about the
  //    session).
  if (matchesBlankPhrase(sessionText)) {
    return { kind: 'blank' };
  }
  if (matchesBlankPhrase(text) && !(usedFraction && usedFraction > 0)) {
    return { kind: 'blank' };
  }

  // 2) ISO datetime is the most authoritative when present.
  const iso = findIsoResetTime(sessionScope);
  if (iso) {
    if (iso > Date.now()) return { kind: 'active', nextResetTime: iso };
    if (Date.now() - iso < 5 * 60 * 1000) {
      // Past ISO within 5 min — usually means we just rolled over to a new
      // window. But if the progress bar shows usage, we're still inside an
      // active session; don't claim blank.
      if (usedFraction && usedFraction > 0) {
        return { kind: 'active', nextResetTime: Date.now() + 60 * 1000 };
      }
      return { kind: 'blank' };
    }
  }

  // 3) Free-text fallback — prefer the scoped section, then the full page.
  const ft =
    findActiveResetTimeText(sessionText) ||
    findActiveResetTimeText(text);
  if (ft && ft.kind === 'active') return { kind: 'active', nextResetTime: ft.ts };
  if (ft && ft.kind === 'just-reset') {
    if (usedFraction && usedFraction > 0) {
      return { kind: 'active', nextResetTime: Date.now() + 60 * 1000 };
    }
    return { kind: 'blank' };
  }

  // 3b) v1.5.8: If we know the session is active from the progress bar but
  //     couldn't find a reset time in text, treat it as active with an
  //     unknown reset. We use a conservative 5-minute placeholder so the
  //     reset alarm fires soon and a fresh scrape happens then.
  if (usedFraction && usedFraction > 0) {
    return { kind: 'active', nextResetTime: Date.now() + 5 * 60 * 1000 };
  }

  // 4) Page-shape fallback — STRICTER in v1.5.8.
  //    Only return blank from this path if ALL of the following are true:
  //      - We have a confirmed Current-session DOM scope (not just a hopeful
  //        full-page text match).
  //      - That scope contains no reset/countdown text.
  //      - The session's progress bar reads exactly 0% (or is missing).
  //    Without these, we'd rather return null and have observeUsagePage
  //    keep trying than push a false blank to the background.
  if (sessionScope) {
    const probe = sessionText;
    const hasResetText = /reset|refresh|\d+\s*h\s*\d*\s*m|\bin\s+\d+\s*(?:h|m)/i.test(probe);
    const hasUsage = !!(usedFraction && usedFraction > 0);
    if (probe.length > 10 && !hasResetText && !hasUsage) {
      return { kind: 'blank' };
    }
  }

  return null;
}

// Locate the Current-session usage bar and read its aria-valuenow.
//
// v1.5.9: Claude's redesigned /settings/usage page switched the bar element
// from role="progressbar" to a CDS Meter component:
//   <div data-cds="Meter" ...>
//     <div role="meter" aria-valuenow="21" aria-valuetext="21% used"
//          aria-labelledby="_r_vn_" ...>
// where "_r_vn_" is the id of the "Current session" <span>. We now:
//   1. Prefer the meter/progressbar whose aria-labelledby points at the
//      Current-session label — the most reliable association.
//   2. Otherwise fall back to the nearest meter/progressbar that is a
//      sibling of the scope within the row container.
// Both role="meter" and the legacy role="progressbar" are matched, so this
// keeps working if Anthropic reverts or A/B-tests the markup.
const USAGE_BAR_SELECTOR = '[role="meter"], [role="progressbar"], [data-cds="Meter"] [aria-valuenow]';

function readValueFromBar(bar) {
  if (!bar) return null;
  // aria-valuenow is the primary numeric signal.
  const rawNow = bar.getAttribute('aria-valuenow');
  let n = rawNow == null ? NaN : parseFloat(rawNow);
  // Fall back to parsing aria-valuetext ("21% used") if valuenow is absent.
  if (Number.isNaN(n)) {
    const vt = bar.getAttribute('aria-valuetext') || '';
    const m = vt.match(/(\d+(?:\.\d+)?)\s*%/);
    if (m) n = parseFloat(m[1]);
  }
  if (!Number.isNaN(n)) {
    const max = parseFloat(bar.getAttribute('aria-valuemax') || '100') || 100;
    return { value: n, min: 0, max };
  }
  return { value: null };
}

function readSessionUsageBar(scope) {
  if (!scope) return null;
  try {
    // 1) Strongest signal: a meter/progressbar explicitly labelled by the
    //    Current-session <span>. Find the labelling id inside the scope, then
    //    look document-wide for a bar that references it.
    const labelEl = scope.querySelector('[id]');
    // The "Current session" span is usually the first id-bearing element in
    // the scope. Collect all ids in the scope to be safe.
    const ids = [];
    scope.querySelectorAll('[id]').forEach((el) => {
      const t = (el.textContent || '').trim();
      if (/^current\s+session$/i.test(t)) ids.push(el.id);
    });
    for (const id of ids) {
      const labelled = document.querySelector(
        `[role="meter"][aria-labelledby="${id}"], [role="progressbar"][aria-labelledby="${id}"]`
      );
      if (labelled) return readValueFromBar(labelled);
    }

    // 2) Fallback: walk up a few levels from the scope and grab the first
    //    meter/progressbar in the same row container.
    let container = scope.parentElement;
    for (let i = 0; i < 4 && container; i++) {
      const bar = container.querySelector(USAGE_BAR_SELECTOR);
      if (bar) return readValueFromBar(bar);
      container = container.parentElement;
    }
  } catch {}
  return null;
}

function matchesBlankPhrase(t) {
  if (!t) return false;
  return (
    /no\s+(active|current)\s+session/i.test(t) ||
    /session\s+(has\s+not\s+started|not\s+started\s+yet)/i.test(t) ||
    /start\s+a\s+(?:conversation|chat)\s+to\s+begin/i.test(t) ||
    /starts?\s+when\s+(?:a\s+|the\s+)?message\s+is\s+sent/i.test(t) ||
    /(?:no|haven['’]?t)\s+(?:started|sent)\s+(?:a\s+|any\s+)?(?:message|conversation|chat)/i.test(t)
  );
}

// Locate the DOM block that wraps the "Current session" heading + its details,
// so we can reason about it independently of the Weekly-limits block.
function findCurrentSessionScope() {
  try {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const v = (node.nodeValue || '').trim();
      if (/^current\s+session$/i.test(v)) {
        let el = node.parentElement;
        // Climb until we have a container that includes the heading AND
        // the next sibling info (bar / "starts when…" / "resets…"), but
        // stops short of pulling in the Weekly-limits block.
        for (let i = 0; i < 6 && el && el.parentElement; i++) {
          const text = (el.innerText || '').toLowerCase();
          if (
            text.length > (v.length + 4) &&
            (/starts when|resets?\b|% used|used\b|\bin\s+\d+\s*(?:h|m)/i.test(text))
          ) {
            return el;
          }
          el = el.parentElement;
        }
        return el || null;
      }
    }
  } catch {}
  return null;
}

function findIsoResetTime(scope) {
  const root = scope || document;
  const nodes = root.querySelectorAll
    ? root.querySelectorAll('time[datetime]')
    : document.querySelectorAll('time[datetime]');
  for (const t of nodes) {
    // Walk a few ancestors to gather context — "reset" / "refresh" must
    // appear in a nearby container for this <time> to count as the
    // session-reset marker.
    let ctx = '';
    let p = t;
    for (let i = 0; i < 4 && p; i++) {
      ctx = ((p.innerText || '') + ' ' + ctx).toLowerCase();
      if (ctx.includes('reset') || ctx.includes('refresh')) break;
      p = p.parentElement;
    }
    if (!ctx.includes('reset') && !ctx.includes('refresh')) continue;
    // When we are NOT scoped, reject if the surrounding text is clearly the
    // weekly-limits row (avoids mis-using a weekly reset).
    if (!scope && /weekly\s+limit|all\s+models|sonnet\s+only|claude\s+design/i.test(ctx)) continue;
    const d = new Date(t.getAttribute('datetime'));
    if (!isNaN(d.getTime())) return d.getTime();
  }
  return null;
}

function findActiveResetTimeText(rawText) {
  if (!rawText) return null;
  const text = rawText.toLowerCase();

  // "resets at 3:47 pm" / "resets 3:47pm" — explicit clock time.
  // Negative lookahead avoids matching weekly entries like "Resets Sat 6:30 AM"
  // (we don't want a weekday name immediately before/after the time).
  let m = text.match(/resets?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?\b/);
  if (m) {
    // Reject if a weekday word appears between "resets" and the time.
    const before = text.slice(Math.max(0, m.index - 16), m.index);
    if (!/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s*$/i.test(before)) {
      const parsed = clockToTimestamp(parseInt(m[1]), parseInt(m[2]), m[3]);
      if (parsed) {
        if (parsed.justReset) return { kind: 'just-reset' };
        return { kind: 'active', ts: parsed.ts };
      }
    }
  }

  // "resets in 3h 12m" / "resets in 3 hours and 12 minutes"
  m = text.match(/resets?\s+in\s+(\d+)\s*(?:h(?:ours?|rs?)?)\s*(?:and\s+)?(?:(\d+)\s*(?:m(?:in(?:utes?)?)?))?/);
  if (m) {
    const hrs = parseInt(m[1]) || 0;
    const mins = parseInt(m[2] || '0') || 0;
    if (hrs || mins) return { kind: 'active', ts: Date.now() + (hrs * 3600 + mins * 60) * 1000 };
  }

  // "resets in 12m"
  m = text.match(/resets?\s+in\s+(\d+)\s*(?:m(?:in(?:utes?)?)?)\b/);
  if (m) {
    const mins = parseInt(m[1]) || 0;
    if (mins > 0) return { kind: 'active', ts: Date.now() + mins * 60 * 1000 };
  }

  // "in 3h 12m" only when the surrounding text mentions session/window.
  m = text.match(/\bin\s+(\d+)\s*h(?:ours?|rs?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?\b/);
  if (m && /session|window/.test(text)) {
    const hrs = parseInt(m[1]) || 0;
    const mins = parseInt(m[2] || '0') || 0;
    if (hrs || mins) return { kind: 'active', ts: Date.now() + (hrs * 3600 + mins * 60) * 1000 };
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
  const diff = c.getTime() - Date.now();
  if (diff < 0) {
    if (-diff < 5 * 60 * 1000) return { justReset: true };
    c.setDate(c.getDate() + 1);
  }
  return { ts: c.getTime(), justReset: false };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { findActiveResetTimeText, clockToTimestamp, matchesBlankPhrase };
}
