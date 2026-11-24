// background.js v1.5.10 — Claude Session Warmer
//
// v1.5.10 changes:
//   NEW: Configurable post-reset delay + jitter. Two new settings control
//        when a warmup fires after the 5-hour window resets:
//          - postResetDelayMin: base delay in minutes (default 1) before the
//            extension checks the session and, if it wasn't started by the
//            user, sends the warmup. This is the "if timer not started on its
//            own" grace period.
//          - postResetJitterSec: random +/- seconds added to the base
//            (default 30) so the warmup never lands at the exact same offset
//            twice (sometimes a few seconds early, sometimes late).
//        scheduleResetAlarm now computes base + jitter via
//        computePostResetDelayMs(). NOTE: Chrome alarms won't fire sooner
//        than ~1 minute, so keep the base >= ~2 min for the jitter to visibly
//        move the real fire time.
//
// v1.5.8 changes:
//   FIX: Belt-and-suspenders guard in maybeWarmup. Before any auto-warmup
//        fires, re-read the stored state. If sessionState is 'active' and
//        nextResetTime is still more than 2 minutes in the future, REFUSE
//        the warmup and re-schedule the reset alarm. Manual warmups (which
//        go through performWarmup directly) bypass this guard — the user
//        clicked, so we trust them. This blocks the "extension keeps sending
//        hi while session is running" failure mode regardless of how the
//        bad signal reached maybeWarmup (transient blank read, race with
//        a tab navigation, stale stored state from an older version, etc.).
//   FIX: Page-shape blank fallback in content.js is now stricter. It only
//        fires when we have a confirmed Current-session DOM scope AND that
//        scope shows no reset/countdown info AND no progress-bar usage.
//        Previously a partial DOM read could leak a false blank back to
//        the background.
//   NEW: Positive active-session detection via progress bar. When the
//        Current-session row has a <div role="progressbar"> with aria-
//        valuenow > 0, the session is conclusively active regardless of
//        text parsing — the user has used some of the window.
//   NEW: content.js no longer reports {kind:'blank'} from observeUsagePage's
//        mutation-observer pass until the page has been stable for ~1.2s.
//        This prevents a transient blank read during initial render from
//        being pushed to background.
//
// v1.5.7 changes:
//   FIX: Manual warmup no longer overwrites the existing reset time with a
//        fresh 5-hour window. Claude's 5-hour session is anchored to the
//        FIRST message of the session, so re-sending inside an active window
//        does not extend it. performWarmup now preserves the existing
//        nextResetTime when the session is already active and the reset is
//        still in the future. The post-warmup-eval scrape will replace it
//        with the truth from /settings/usage either way.
//   NEW: `model` setting is back. Default is 'haiku' (lowest tier). Before
//        sending the warmup, the extension switches the chat to the chosen
//        model. If model picking fails (e.g. Claude's UI changed), the
//        warmup proceeds with whatever model is currently selected.
//   UI:  Recent activity panel removed from the popup. The Settings page
//        still has the full diagnostic log viewer.
//
// v1.5.6 changes:
//   FIX: performWarmup now closes the tab it creates after the message has
//        been accepted by the backend (URL navigates to /chat/*). The user's
//        pre-existing /new tab is reused without being closed.
//   FIX: On a confirmed warmup, optimistically set sessionState='active' with
//        a 5-hour reset window so the popup immediately shows "Running".
//        The post-warmup-eval scrape replaces this with the real reset time.
//   FIX: persistState() ignores 'blank' readings for 10 minutes after a
//        successful warmup, so usage-page lag can't clobber the active state.
//   FIX: maybeWarmup() skips 'BLANK' fires when a recent warmup succeeded,
//        preventing a re-warm loop while the usage page catches up.
//   TUNE: post-warmup-eval delay 2 -> 5 min.
//
// v1.5.5 changes:
//   FIX: When refreshState() returns null (e.g. the usage page format changed
//        and the content script can't parse it), fall back to the stored state.
//        Stored "active" with overdue nextResetTime now triggers a warmup
//        instead of a silent return. Stored "blank" also triggers a warmup.
//        The existing 90s rate-limit and signature dedupe in maybeWarmup
//        prevent duplicate fires.
//
// v1.5 changes (from review):
//   #2  All long delays moved from setTimeout to chrome.alarms (SW-restart safe).
//   #3  Alarm minimum delay clamped to >= 1 minute (cross-Chrome safe).
//   #4  performWarmup no longer hijacks /chat/* tabs; only reuses /new (or opens fresh).
//   #6  injectedSendMessage uses a multi-strategy insert (execCommand → paste → fallback)
//       to handle ProseMirror/Lexical contenteditable, plus full keydown+keypress+keyup.
//   #7  Mutex persisted in chrome.storage.local with 60s TTL (survives SW restart).
//   #9  Re-evaluates on tab nav not only when previously logged-out but also unknown/stale.
//   #10 chrome.idle.setDetectionInterval moved into onInstalled/onStartup.
//   #11 Quiet-hours skip now schedules an alarm at quietEnd so warmup fires when window opens.
//   #15 waitForChatInputReady polls for the actual input element instead of fixed delay.
//   #16 Background scrape tab is opened with ?csw=scrape sentinel; SW-startup sweeps
//       any leaked sentinel tabs left over from a prior crash.
//   #18 lastReauthNotify cleared on next successful active/blank state read.
//   #19 chrome.runtime.lastError checks added on tab/scripting/notification calls.
//   #22 Safety alarm interval reduced from 4h → 1h (cheap, evaluateAndAct short-circuits
//       when state is fresh).
//   #23 log() also pushes lines into a ring buffer in chrome.storage.local for popup display.

const DEFAULT_SETTINGS = {
  enabled: true,
  message: 'hi',
  model: 'haiku',
  notifications: true,
  // v1.5.10: how long after the 5-hour window resets to wait before checking
  // the session and (if it hasn't been started by the user) firing a warmup.
  // Base delay in minutes, plus a random +/- jitter in seconds so the warmup
  // never lands at the exact same offset twice.
  postResetDelayMin: 1,
  postResetJitterSec: 30,
  quietHoursEnabled: false,
  quietStart: '23:00',
  quietEnd: '06:00',
  selectors: {
    inputArea: '[contenteditable="true"], div[role="textbox"], textarea[placeholder*="Reply" i], textarea[placeholder*="Message" i]',
    sendButton: 'button[aria-label*="Send" i], button[type="submit"]',
    modelPicker: 'button[aria-label*="model" i], button[data-testid*="model" i], button[aria-haspopup="menu"]'
  }
};

const STATE_FRESH_MS = 30 * 60 * 1000;
const TAB_SCRAPE_TIMEOUT_MS = 30000;
const SAFETY_ALARM_HOURS = 1;
const REAUTH_NOTIFY_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const RESET_BUFFER_MS = 30 * 1000; // legacy fallback when settings are absent
const ALARM_MIN_DELAY_MIN = 1;
// v1.5.10: clamps for the configurable post-reset delay + jitter.
const POST_RESET_DELAY_MIN_MAX = 120;   // up to 2 hours base delay
const POST_RESET_JITTER_SEC_MAX = 600;  // up to +/- 10 min of jitter
const EVALUATING_TTL_MS = 60 * 1000;
const SCRAPE_TAB_SENTINEL = 'csw=scrape';
const LOG_BUFFER_CAP = 200;
// v1.5.6: how long we trust an optimistic active state after a successful
// warmup. During this window: blank scrape readings are ignored, and BLANK
// re-warms are suppressed.
const POST_WARMUP_GRACE_MS = 10 * 60 * 1000;
// v1.5.6: assumed session length when we set state optimistically (Claude's
// rolling 5-hour window). Real reset time replaces this on the next scrape.
const OPTIMISTIC_SESSION_MS = 5 * 60 * 60 * 1000;
// v1.5.6: how long to wait for /new to navigate to /chat/* after sending,
// before giving up on confirming the message was accepted.
const CHAT_NAV_TIMEOUT_MS = 15000;
// v1.5.6: post-warmup-eval delay — usage page can lag a few minutes after
// a session starts.
const POST_WARMUP_EVAL_DELAY_MIN = 5;

// ─── Lifecycle ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get('settings');
  if (!stored.settings) {
    await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  }
  await chrome.alarms.create('safety-check', { periodInMinutes: SAFETY_ALARM_HOURS * 60 });
  try { chrome.idle.setDetectionInterval(60); } catch {}
  await sweepLeakedScrapeTabs();
  // Evaluate immediately rather than scheduling an alarm 1 min out.
  // The async listener keeps the SW alive while this runs.
  await evaluateAndAct('install');
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create('safety-check', { periodInMinutes: SAFETY_ALARM_HOURS * 60 });
  try { chrome.idle.setDetectionInterval(60); } catch {}
  await sweepLeakedScrapeTabs();
  // Evaluate immediately on browser open — no 1-min alarm delay.
  await evaluateAndAct('startup');
});

chrome.idle.onStateChanged.addListener((newState) => {
  if (newState === 'active') evaluateAndAct('idle-active');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  switch (alarm.name) {
    case 'reset-fired':        evaluateAndAct('reset-alarm'); break;
    case 'safety-check':       evaluateAndAct('safety'); break;
    case 'post-warmup-eval':   evaluateAndAct('post-warmup', { force: true }); break;
    case 'quiet-end-eval':     evaluateAndAct('quiet-end'); break;
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (!tab.url || !tab.url.startsWith('https://claude.ai/')) return;
  if (/\/(login|signin|sign-in|signup)/i.test(tab.url)) return;
  if (tab.url.includes(SCRAPE_TAB_SENTINEL)) return;
  const { sessionState, lastUsageFetch } = await chrome.storage.local.get(
    ['sessionState', 'lastUsageFetch']
  );
  const stale = !lastUsageFetch || (Date.now() - lastUsageFetch > STATE_FRESH_MS);
  if (sessionState === 'logged-out' || sessionState === 'unknown' || !sessionState || stale) {
    log('claude.ai nav detected, re-evaluating (state:', sessionState, 'stale:', stale, ')');
    evaluateAndAct('post-nav');
  }
});

// ─── Settings & helpers ────────────────────────────────────────────────────

async function getSettings() {
  const stored = await chrome.storage.sync.get('settings');
  const merged = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  merged.selectors = { ...DEFAULT_SETTINGS.selectors, ...(merged.selectors || {}) };
  return merged;
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

function msUntilQuietEnd(settings) {
  const now = new Date();
  const [eh, em] = settings.quietEnd.split(':').map(Number);
  const end = new Date(now);
  end.setHours(eh, em, 0, 0);
  if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1);
  return end.getTime() - now.getTime();
}

async function scheduleAlarm(name, delayMin) {
  const safe = Math.max(ALARM_MIN_DELAY_MIN, delayMin);
  await chrome.alarms.create(name, { delayInMinutes: safe });
  log('Alarm scheduled:', name, 'in', safe.toFixed(2), 'min');
}

function log(...args) {
  const line = '[CSW] ' + args.map(a => {
    try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  console.log(line);
  try {
    chrome.storage.local.get('logBuffer').then(({ logBuffer }) => {
      const arr = Array.isArray(logBuffer) ? logBuffer : [];
      arr.push({ t: Date.now(), m: line });
      while (arr.length > LOG_BUFFER_CAP) arr.shift();
      chrome.storage.local.set({ logBuffer: arr }).catch(() => {});
    }).catch(() => {});
  } catch {}
}

async function acquireEvaluatingLock() {
  const { evaluatingLock } = await chrome.storage.local.get('evaluatingLock');
  const now = Date.now();
  if (evaluatingLock && (now - evaluatingLock) < EVALUATING_TTL_MS) return false;
  await chrome.storage.local.set({ evaluatingLock: now });
  return true;
}
async function releaseEvaluatingLock() {
  await chrome.storage.local.set({ evaluatingLock: null });
}

// ─── Core decision loop ────────────────────────────────────────────────────

async function evaluateAndAct(reason, opts = {}) {
  const got = await acquireEvaluatingLock();
  if (!got) {
    log('evaluate locked, skipping:', reason);
    return;
  }
  try {
    log('evaluateAndAct:', reason);
    const settings = await getSettings();
    if (!settings.enabled) { log('disabled'); return; }

    const stored = await chrome.storage.local.get(['sessionState', 'nextResetTime', 'lastUsageFetch']);
    const now = Date.now();
    const isFresh = !opts.force && stored.lastUsageFetch && (now - stored.lastUsageFetch < STATE_FRESH_MS);

    if (isFresh && stored.sessionState === 'active' && stored.nextResetTime && stored.nextResetTime > now + 60000) {
      log('Fresh active state. Scheduling alarm only.');
      await scheduleResetAlarm(stored.nextResetTime, settings);
      return;
    }

    const state = await refreshState();
    if (!state) {
      // v1.5.5 FIX: do not silently bail when the scrape can't read the page.
      // If we already know the stored state is overdue-active or blank, act on
      // it. The 90s rate-limit and signature dedupe in maybeWarmup still apply.
      log('refreshState null — falling back to stored state:', stored.sessionState);
      if (isQuietHour(settings)) {
        log('quiet hours active');
        const untilEnd = msUntilQuietEnd(settings);
        await scheduleAlarm('quiet-end-eval', untilEnd / 60000);
        return;
      }
      if (stored.sessionState === 'active' && stored.nextResetTime && now >= stored.nextResetTime) {
        await maybeWarmup(settings, stored.nextResetTime, reason + '-fallback');
      } else if (stored.sessionState === 'blank') {
        await maybeWarmup(settings, 'BLANK', reason + '-fallback');
      } else if (stored.sessionState === 'active' && stored.nextResetTime && stored.nextResetTime > now) {
        await scheduleResetAlarm(stored.nextResetTime, settings);
      }
      return;
    }

    if (state.kind === 'logged-out') {
      notifyReauthIfNeeded();
      return;
    }

    await chrome.storage.local.set({ lastReauthNotify: null });

    if (isQuietHour(settings)) {
      log('quiet hours active');
      const untilEnd = msUntilQuietEnd(settings);
      await scheduleAlarm('quiet-end-eval', untilEnd / 60000);
      if (state.kind === 'active' && state.nextResetTime > now) {
        await scheduleResetAlarm(state.nextResetTime, settings);
      }
      return;
    }

    if (state.kind === 'blank') {
      await maybeWarmup(settings, 'BLANK', reason);
    } else if (state.kind === 'active') {
      if (now >= state.nextResetTime) {
        await maybeWarmup(settings, state.nextResetTime, reason);
      } else {
        await scheduleResetAlarm(state.nextResetTime, settings);
      }
    }
  } finally {
    await releaseEvaluatingLock();
  }
}

async function maybeWarmup(settings, signature, reason) {
  const stored = await chrome.storage.local.get([
    'lastWarmedSignature', 'lastWarmupTime', 'lastWarmupResult',
    'sessionState', 'nextResetTime'
  ]);

  // v1.5.8: BELT-AND-SUSPENDERS GUARD. Refuse to fire an auto-warmup when
  // the stored state clearly shows an active session with more than 2 min
  // until reset. This is the last line of defense against the "extension
  // keeps sending hi while session is running" failure mode, regardless of
  // how the bad call reached maybeWarmup (transient blank read on initial
  // page load, race with tabs.onUpdated, stale signature, etc.). The reset
  // alarm is re-scheduled so we still fire at the correct moment. Manual
  // warmups bypass this — they go through performWarmup directly.
  if (
    stored.sessionState === 'active' &&
    typeof stored.nextResetTime === 'number' &&
    stored.nextResetTime > Date.now() + 2 * 60 * 1000
  ) {
    const min = Math.round((stored.nextResetTime - Date.now()) / 60000);
    log('Guard: active session with ~' + min + ' min left — refusing auto-warmup. (reason:', reason, 'sig:', signature, ')');
    await scheduleResetAlarm(stored.nextResetTime, settings);
    return;
  }

  // Hard rate-limit: never fire two warmups within 90 seconds, regardless of
  // signature. Catches rapid-fire triggers (e.g. onStartup + tabs.onUpdated
  // arriving close together) and post-warmup-eval re-checks.
  if (stored.lastWarmupTime && (Date.now() - stored.lastWarmupTime) < 90 * 1000) {
    log('Last warmup <90s ago, skip rate-limit. (signature was', signature, ')');
    return;
  }
  // v1.5.6: After a successful warmup, the usage page can take a few minutes
  // to register the new active session. While that's happening, do NOT fire
  // another BLANK warmup — we already have an active session.
  if (signature === 'BLANK' && stored.lastWarmupResult === 'ok' && stored.lastWarmupTime &&
      (Date.now() - stored.lastWarmupTime) < POST_WARMUP_GRACE_MS) {
    log('Recent successful warmup — suppressing BLANK re-warm.');
    return;
  }
  // Signature dedupe applies only to numeric reset-time signatures, NOT to
  // 'BLANK'. The previous 'BLANK' string signature was sticky forever, which
  // meant a second blank state after a future reset cycle would be skipped.
  if (typeof signature === 'number' && stored.lastWarmedSignature === signature) {
    log('Already warmed reset window', signature, '— skip dedupe.');
    return;
  }
  log('Auto-warmup signature', signature, '(reason:', reason, ')');
  const ok = await performWarmup(settings, false);
  if (ok) {
    await chrome.storage.local.set({ lastWarmedSignature: signature });
    await scheduleAlarm('post-warmup-eval', POST_WARMUP_EVAL_DELAY_MIN);
  }
}

// v1.5.10: Compute the post-reset delay in ms = base + random jitter.
//   base   = postResetDelayMin minutes (clamped 0..120)
//   jitter = uniform random in [-J, +J] seconds, J = postResetJitterSec
//            (clamped 0..600). So the warmup sometimes fires a few seconds
//            early, sometimes a few seconds late — never the exact same
//            offset twice.
// `rand` is injectable for deterministic tests (defaults to Math.random).
// The result is floored at 0 (never negative) and returned in milliseconds.
// NOTE: Chrome alarms won't fire sooner than ~1 minute (ALARM_MIN_DELAY_MIN),
// so for the jitter to visibly move the fire time keep the base >= ~2 min.
function computePostResetDelayMs(settings, rand = Math.random) {
  let baseMin = Number(settings && settings.postResetDelayMin);
  if (!Number.isFinite(baseMin) || baseMin < 0) baseMin = DEFAULT_SETTINGS.postResetDelayMin;
  baseMin = Math.min(baseMin, POST_RESET_DELAY_MIN_MAX);

  let jitterSec = Number(settings && settings.postResetJitterSec);
  if (!Number.isFinite(jitterSec) || jitterSec < 0) jitterSec = DEFAULT_SETTINGS.postResetJitterSec;
  jitterSec = Math.min(jitterSec, POST_RESET_JITTER_SEC_MAX);

  const baseMs = baseMin * 60 * 1000;
  // Uniform in [-jitterSec, +jitterSec] seconds.
  const jitterMs = jitterSec > 0 ? Math.round((rand() * 2 - 1) * jitterSec * 1000) : 0;
  return Math.max(0, baseMs + jitterMs);
}

async function scheduleResetAlarm(resetTime, settings) {
  if (!settings) {
    try { settings = await getSettings(); } catch { settings = DEFAULT_SETTINGS; }
  }
  const delayMs = computePostResetDelayMs(settings);
  const target = resetTime + delayMs;
  const delayMin = (target - Date.now()) / 60000;
  await scheduleAlarm('reset-fired', delayMin);
  log('Reset alarm: base', (settings.postResetDelayMin ?? '?'), 'min, jitter +/-',
      (settings.postResetJitterSec ?? '?'), 's ->', Math.round(delayMs / 1000), 's after reset');
}

// ─── State refresh ─────────────────────────────────────────────────────────

async function refreshState() {
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
  log('Opening background tab to /settings/usage');
  return scrapeViaBackgroundTab();
}

function sendMessageWithTimeout(tabId, msg, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, msg, (reply) => {
        void chrome.runtime.lastError;
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
      if (tab) { try { await chrome.tabs.remove(tab.id); } catch {} }
      if (state) await persistState(state);
      resolve(state);
    };

    const msgListener = (msg, sender) => {
      if (sender.tab && tab && sender.tab.id === tab.id &&
          msg && msg.type === 'state-from-content' && msg.state) {
        finish(msg.state);
      }
    };
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
      tab = await chrome.tabs.create({
        url: 'https://claude.ai/settings/usage?' + SCRAPE_TAB_SENTINEL,
        active: false
      });
    } catch (err) {
      log('tab create failed:', err && err.message ? err.message : String(err));
      cleanup();
      resolve(null);
      return;
    }

    setTimeout(async () => {
      if (resolved) return;
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

async function sweepLeakedScrapeTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://claude.ai/settings/usage*' });
    for (const t of tabs) {
      if (t.url && t.url.includes(SCRAPE_TAB_SENTINEL)) {
        try { await chrome.tabs.remove(t.id); log('Swept leaked scrape tab', t.id); } catch {}
      }
    }
  } catch (e) {
    log('sweep error:', e && e.message ? e.message : String(e));
  }
}

async function persistState(state) {
  const update = { lastUsageFetch: Date.now() };

  // v1.5.6: Don't let a slow usage-page update overwrite the optimistic
  // active state we set right after a successful warmup. If we're inside
  // the post-warmup grace window and the scrape says blank, just refresh
  // the timestamp and keep our active state.
  if (state.kind === 'blank') {
    const grace = await chrome.storage.local.get([
      'lastWarmupTime', 'lastWarmupResult', 'sessionState'
    ]);
    if (
      grace.sessionState === 'active' &&
      grace.lastWarmupResult === 'ok' &&
      grace.lastWarmupTime &&
      (Date.now() - grace.lastWarmupTime) < POST_WARMUP_GRACE_MS
    ) {
      log('persistState: ignoring blank during post-warmup grace window.');
      await chrome.storage.local.set({ lastUsageFetch: update.lastUsageFetch });
      return;
    }
  }

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

// ─── Re-auth notification ──────────────────────────────────────────────────

async function notifyReauthIfNeeded() {
  const { lastReauthNotify } = await chrome.storage.local.get('lastReauthNotify');
  const now = Date.now();
  if (lastReauthNotify && now - lastReauthNotify < REAUTH_NOTIFY_COOLDOWN_MS) return;
  await chrome.storage.local.set({ lastReauthNotify: now });
  const settings = await getSettings();
  if (!settings.notifications) return;
  try {
    chrome.notifications.create('reauth', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Claude Session Warmer — please log in',
      message: 'Click here to sign back into Claude. Warmups are paused until you do.'
    }, () => { void chrome.runtime.lastError; });
  } catch {}
}

chrome.notifications.onClicked.addListener((id) => {
  if (id === 'reauth') {
    chrome.tabs.create({ url: 'https://claude.ai/login' });
    chrome.notifications.clear(id);
  }
});

// ─── Warmup ────────────────────────────────────────────────────────────────

function isReusableTabUrl(url) {
  if (!url || !url.startsWith('https://claude.ai/')) return false;
  try {
    const u = new URL(url);
    if (u.pathname === '/' || u.pathname === '/new' || u.pathname === '/new/') return true;
  } catch {}
  return false;
}

async function performWarmup(settings, manual) {
  let tab;
  let createdTab = false;
  try {
    const claudeTabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    const reusable = claudeTabs.find(t => isReusableTabUrl(t.url));

    if (reusable) {
      tab = reusable;
      await chrome.tabs.update(tab.id, { url: 'https://claude.ai/new' });
    } else {
      tab = await chrome.tabs.create({ url: 'https://claude.ai/new', active: false });
      createdTab = true;
    }
    await waitForTabComplete(tab.id);

    const refreshed = await chrome.tabs.get(tab.id);
    if (refreshed.url && /\/(login|signin|sign-in)/i.test(refreshed.url)) {
      await persistState({ kind: 'logged-out' });
      notifyReauthIfNeeded();
      await chrome.storage.local.set({ lastWarmupTime: Date.now(), lastWarmupResult: 'fail' });
      if (createdTab) { try { await chrome.tabs.remove(tab.id); } catch {} }
      return false;
    }

    await waitForChatInputReady(tab.id, settings.selectors);
  } catch (e) {
    log('tab open/navigate failed:', e && e.message ? e.message : String(e));
    await chrome.storage.local.set({ lastWarmupTime: Date.now(), lastWarmupResult: 'fail' });
    if (createdTab && tab) { try { await chrome.tabs.remove(tab.id); } catch {} }
    return false;
  }

  try {
    // v1.5.7: Best-effort model switch before sending. If this fails (selector
    // mismatch, UI changed, etc.) the warmup still proceeds with whatever
    // model is currently selected on the page.
    if (settings.model && settings.model !== 'auto') {
      try {
        const [{ result: modelResult } = {}] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: injectedSelectModel,
          args: [settings.model, settings.selectors]
        });
        if (modelResult && modelResult.success) {
          if (modelResult.alreadySelected) {
            log('Model already set to', settings.model);
          } else {
            log('Switched model to', settings.model);
          }
        } else {
          log('Model switch skipped:', (modelResult && modelResult.error) || 'unknown reason');
        }
      } catch (e) {
        log('Model switch threw, continuing anyway:', e && e.message ? e.message : String(e));
      }
    }

    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectedSendMessage,
      args: [settings.message, settings.selectors]
    });

    const success = !!(result && result.success);

    // v1.5.6: After dispatch, wait for the page to navigate to /chat/* —
    // that's how Claude confirms the message was accepted by the backend
    // and a session has been created. If we close the tab before this we
    // risk aborting the in-flight request.
    let chatNavigated = false;
    if (success) {
      chatNavigated = await waitForChatNavigation(tab.id, CHAT_NAV_TIMEOUT_MS);
      if (!chatNavigated) log('Chat navigation not seen within', CHAT_NAV_TIMEOUT_MS, 'ms; closing anyway');
    }

    const updates = {
      lastWarmupTime: Date.now(),
      lastWarmupResult: success ? 'ok' : 'fail'
    };
    if (success) {
      const { totalWarmups = 0 } = await chrome.storage.local.get('totalWarmups');
      updates.totalWarmups = totalWarmups + 1;

      // v1.5.6: Only mark the session active if Claude actually navigated to
      // /chat/* — that's the backend's confirmation. If the click dispatched
      // but no nav happened, the message probably failed silently, so leave
      // sessionState alone and let the next eval figure it out.
      if (chatNavigated) {
        updates.sessionState = 'active';
        updates.lastUsageFetch = Date.now();

        // v1.5.7 FIX: Don't overwrite an already-known future reset time with
        // a fresh 5-hour optimistic window. Claude's 5-hour session window is
        // anchored to the FIRST message of the session — sending another
        // message while a session is active does not restart the window.
        // This was particularly visible on manual warmups: clicking "Warm up"
        // during an active session was rolling the displayed reset to "in 5h"
        // when the real reset (e.g. "in 1h 47m") was already known and stored.
        // The post-warmup-eval scrape will replace whichever value we pick
        // here with the real reset time from /settings/usage shortly after.
        const existing = await chrome.storage.local.get(['sessionState', 'nextResetTime']);
        const nowTs = Date.now();
        if (
          existing.sessionState === 'active' &&
          typeof existing.nextResetTime === 'number' &&
          existing.nextResetTime > nowTs + 60 * 1000
        ) {
          updates.nextResetTime = existing.nextResetTime;
          log('Preserving existing reset time:', new Date(existing.nextResetTime).toISOString());
        } else {
          updates.nextResetTime = nowTs + OPTIMISTIC_SESSION_MS;
          log('Setting optimistic 5h reset time:', new Date(updates.nextResetTime).toISOString());
        }
      }
    }
    await chrome.storage.local.set(updates);

    if (success && chatNavigated) {
      await scheduleResetAlarm(updates.nextResetTime, settings);
    }

    // v1.5.6: Close the tab we created, so the user isn't left with a stray
    // chat tab. Never close a tab the user already had open.
    if (createdTab) {
      // Brief settle for the UI/network to finish.
      await sleep(1500);
      try {
        await chrome.tabs.remove(tab.id);
        log('Closed warmup tab', tab.id);
      } catch (e) {
        log('Could not close warmup tab:', e && e.message ? e.message : String(e));
      }
    }

    if (settings.notifications) {
      try {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: success
            ? (manual ? 'Manual warmup sent' : 'Claude session started')
            : 'Warmup failed',
          message: success
            ? `Sent "${settings.message}".`
            : `Reason: ${(result && result.error) || 'unknown'}. If selectors are stale, fix them in Settings.`
        }, () => { void chrome.runtime.lastError; });
      } catch {}
    }
    return success;
  } catch (err) {
    log('executeScript error:', err && err.message ? err.message : String(err));
    await chrome.storage.local.set({ lastWarmupTime: Date.now(), lastWarmupResult: 'fail' });
    if (createdTab && tab) { try { await chrome.tabs.remove(tab.id); } catch {} }
    if (settings.notifications) {
      try {
        chrome.notifications.create({
          type: 'basic', iconUrl: 'icons/icon128.png',
          title: 'Claude Session Warmer error',
          message: String((err && err.message) || err)
        }, () => { void chrome.runtime.lastError; });
      } catch {}
    }
    return false;
  }
}

// v1.5.6: Poll the tab URL until it transitions away from /new to /chat/*.
// That transition confirms Claude accepted the message and created a session.
async function waitForChatNavigation(tabId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let url = '';
    try {
      const t = await chrome.tabs.get(tabId);
      url = t && t.url ? t.url : '';
    } catch {
      return false; // tab gone
    }
    if (/^https:\/\/claude\.ai\/chat\//.test(url)) return true;
    await sleep(500);
  }
  return false;
}

async function waitForChatInputReady(tabId, selectors) {
  const start = Date.now();
  const deadline = start + 15000;
  while (Date.now() < deadline) {
    try {
      const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sels) => {
          const list = sels.split(',').map(s => s.trim());
          for (const sel of list) {
            try { if (document.querySelector(sel)) return true; } catch {}
          }
          return false;
        },
        args: [selectors.inputArea]
      });
      if (result === true) {
        log('Chat input ready after', Date.now() - start, 'ms');
        return;
      }
    } catch {}
    await sleep(400);
  }
  log('waitForChatInputReady: deadline reached, attempting send anyway');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// v1.5.7: Best-effort attempt to switch the chat to the requested model
// before the warmup message is sent. Runs in the page's context.
//
// Strategy:
//   1. Find a likely model-picker button. Candidates (in priority order):
//        a. Anything matching the user-configured selector that contains
//           "haiku" / "sonnet" / "opus" in its label or visible text.
//        b. Buttons with aria-haspopup that contain a model name.
//        c. Any small button whose visible text mentions a model name.
//   2. If the button already shows the requested model, return success.
//   3. Click the button to open the menu.
//   4. Find a [role="menuitem"] / [role="option"] whose text contains the
//      requested model name; click it.
//   5. Best-effort cleanup: dispatch Escape to close the menu.
//
// The function is intentionally tolerant — if anything fails we resolve
// with success:false and the caller logs but continues.
function injectedSelectModel(model, selectors) {
  return new Promise((resolve) => {
    const TIMEOUT = 6000;
    const start = Date.now();
    const target = String(model || '').toLowerCase();
    if (!target || target === 'auto') {
      resolve({ success: true, alreadySelected: true });
      return;
    }

    const visible = (el) => {
      if (!el) return false;
      try {
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return false;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      } catch {}
      return true;
    };

    const labelOf = (el) => {
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const txt  = (el.innerText || el.textContent || '').toLowerCase();
      const dt   = (el.getAttribute('data-testid') || '').toLowerCase();
      return aria + ' | ' + txt + ' | ' + dt;
    };

    const looksLikeModelPicker = (el) => {
      const lbl = labelOf(el);
      // Must mention a model name OR explicitly the word "model".
      return /\b(haiku|sonnet|opus)\b/.test(lbl) || /\bmodel\b/.test(lbl);
    };

    const findPickerButton = () => {
      // 1) User-configured selector first.
      try {
        const sel = (selectors && selectors.modelPicker) ||
          'button[aria-label*="model" i], button[data-testid*="model" i], button[aria-haspopup="menu"]';
        const sels = sel.split(',').map(s => s.trim()).filter(Boolean);
        for (const s of sels) {
          try {
            const list = document.querySelectorAll(s);
            for (const el of list) {
              if (!visible(el)) continue;
              if (looksLikeModelPicker(el)) return el;
            }
          } catch {}
        }
      } catch {}

      // 2) Any visible button with aria-haspopup that mentions a model.
      try {
        const candidates = document.querySelectorAll('button[aria-haspopup]');
        for (const el of candidates) {
          if (!visible(el)) continue;
          if (looksLikeModelPicker(el)) return el;
        }
      } catch {}

      // 3) Last resort: any small visible button whose text mentions a model.
      try {
        const all = document.querySelectorAll('button');
        for (const el of all) {
          if (!visible(el)) continue;
          const t = (el.innerText || '').trim();
          if (!t || t.length > 60) continue;
          if (/\b(haiku|sonnet|opus)\b/i.test(t)) return el;
        }
      } catch {}

      return null;
    };

    const findMenuItemForTarget = () => {
      const items = document.querySelectorAll(
        '[role="menuitem"], [role="menuitemradio"], [role="option"]'
      );
      for (const it of items) {
        if (!visible(it)) continue;
        const t = (it.innerText || it.textContent || '').toLowerCase();
        if (t.includes(target)) return it;
      }
      return null;
    };

    const closeMenu = () => {
      try {
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
          bubbles: true, cancelable: true
        }));
      } catch {}
    };

    const btn = findPickerButton();
    if (!btn) {
      resolve({ success: false, error: 'model picker not found' });
      return;
    }

    // If the picker already shows the target, no work needed.
    const btnLabel = (btn.innerText || btn.textContent || '');
    if (new RegExp('\\b' + target + '\\b', 'i').test(btnLabel)) {
      resolve({ success: true, alreadySelected: true });
      return;
    }

    try { btn.click(); } catch (e) {
      resolve({ success: false, error: 'picker click failed' });
      return;
    }

    const tick = () => {
      if (Date.now() - start > TIMEOUT) {
        closeMenu();
        resolve({ success: false, error: 'timed out finding ' + target + ' menu item' });
        return;
      }
      const item = findMenuItemForTarget();
      if (item) {
        try { item.click(); } catch {}
        // Brief settle so the DOM updates and the menu closes before we
        // start typing the warmup message.
        setTimeout(() => resolve({ success: true }), 350);
        return;
      }
      setTimeout(tick, 200);
    };
    setTimeout(tick, 200);
  });
}

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
          if (!el) continue;
          if (el.disabled) continue;
          if (el.getAttribute('aria-disabled') === 'true') continue;
          return el;
        } catch {}
      }
      return null;
    };

    const insertIntoTextarea = (input, text) => {
      try { input.focus(); } catch {}
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };

    const insertIntoContentEditable = (input, text) => {
      try { input.focus(); } catch {}

      // Strategy A: select all, delete, insertText via execCommand
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(input);
        sel.removeAllRanges();
        sel.addRange(range);
        if (document.execCommand) {
          document.execCommand('delete', false);
          const ok = document.execCommand('insertText', false, text);
          if (ok && (input.innerText || '').includes(text)) return true;
        }
      } catch {}

      // Strategy B: paste event with DataTransfer
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        input.dispatchEvent(evt);
        if ((input.innerText || '').includes(text)) return true;
      } catch {}

      // Strategy C: beforeinput + textContent + input
      try {
        input.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true, cancelable: true, inputType: 'insertText', data: text
        }));
        input.textContent = text;
        input.dispatchEvent(new InputEvent('input', {
          bubbles: true, inputType: 'insertText', data: text
        }));
        if ((input.innerText || '').includes(text)) return true;
      } catch {}

      return false;
    };

    const tryType = () => {
      const input = findInput();
      if (!input) return false;
      if (input.tagName === 'TEXTAREA') return insertIntoTextarea(input, message);
      return insertIntoContentEditable(input, message);
    };

    const trySendButton = () => {
      const btn = findSend();
      if (!btn) return false;
      btn.click();
      return true;
    };

    const tryEnterFallback = () => {
      const input = findInput();
      if (!input) return false;
      try { input.focus(); } catch {}
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      input.dispatchEvent(new KeyboardEvent('keydown', opts));
      input.dispatchEvent(new KeyboardEvent('keypress', opts));
      input.dispatchEvent(new KeyboardEvent('keyup', opts));
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
      setTimeout(() => {
        if (trySendButton()) {
          resolve({ success: true });
        } else if (tryEnterFallback()) {
          resolve({ success: true, note: 'Enter fallback used.' });
        } else {
          resolve({ success: false, error: 'Send button not found and Enter fallback failed.' });
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
        resolve();
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

// ─── Messages ──────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'manual-warmup') {
        const settings = await getSettings();
        const ok = await performWarmup(settings, true);
        if (ok) await scheduleAlarm('post-warmup-eval', POST_WARMUP_EVAL_DELAY_MIN);
        sendResponse({ ok });
      } else if (msg?.type === 'manual-refresh-state') {
        await evaluateAndAct('manual-refresh', { force: true });
        sendResponse({ ok: true });
      } else if (msg?.type === 'evaluate-now') {
        await evaluateAndAct('evaluate-now', { force: true });
        sendResponse({ ok: true });
      } else if (msg?.type === 'state-from-content' && msg.state) {
        await persistState(msg.state);
        if (msg.state.kind === 'active' && typeof msg.state.nextResetTime === 'number') {
          if (msg.state.nextResetTime > Date.now()) {
            await scheduleResetAlarm(msg.state.nextResetTime);
          }
        }
        sendResponse({ ok: true });
      } else if (msg?.type === 'get-logs') {
        const { logBuffer = [] } = await chrome.storage.local.get('logBuffer');
        sendResponse({ ok: true, logs: logBuffer });
      } else if (msg?.type === 'clear-logs') {
        await chrome.storage.local.set({ logBuffer: [] });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false });
      }
    } catch (err) {
      log('onMessage handler error:', err && err.message ? err.message : String(err));
      try { sendResponse({ ok: false, error: String(err) }); } catch {}
    }
  })();
  return true;
});
