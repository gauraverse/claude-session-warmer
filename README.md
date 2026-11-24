# Claude Session Warmer

A browser extension that automatically starts a new Claude session the moment your previous 5-hour usage window ends, so the timer is already active by the time you sit down. You don't have to send the first "hi" yourself.

**Version 1.5.10** — see [Changelog](#changelog) for what's new.

---

## ⚠️ Important: terms of service

**This extension automates clicks and keystrokes inside `claude.ai`. Anthropic's consumer usage policies generally prohibit scripted or automated access to consumer products. Using this extension may put your account at risk of being flagged or terminated.**

The volume here is minimal (one short message every ~5 hours, on your own account, only when needed), but that does not make it permitted. Use it on your own account, at your own discretion. This project is not affiliated with or endorsed by Anthropic. The author accepts no liability for account actions taken against users of this extension.

If you are uncomfortable with that risk, do not install it.

---

## Why this exists

If you don't manually fire a message at the moment your old session ends, the next 5-hour window doesn't begin until you do. For people who want their first Claude session of the day to start automatically, or who want their session to be live the moment they open the laptop, this extension automates the chore while being careful never to spam duplicate messages.

## What v1.5 guarantees

- The moment the browser starts (or you install the extension), the extension reads your session state in the background. No clicks, no popup needed. If you have no active session and it's not quiet hours, a warmup fires within seconds.
- When you return to your machine after being idle/away, a warmup fires if needed.
- When the previous session's reset moment arrives, a warmup fires once. Targeted one-shot alarm. No polling.
- A logged-out state surfaces a clickable notification. Warmups pause until you sign in. When you do, the extension auto re-evaluates.
- Duplicate messages are structurally prevented: a 90-second hard rate-limit plus per-reset-window signature dedupe. The manual button bypasses both for retries.
- Quiet hours are respected, and a re-evaluation is scheduled the moment quiet hours end.
- Lifetime stats and diagnostic logs are stored locally only. Nothing leaves your browser.

## Features

- Reads session state from `claude.ai/settings/usage`
- Distinguishes four states: active, blank, logged out, unknown
- Fires warmup at the right moment, exactly once per window
- Event-driven (startup, idle-active, targeted alarm). All long delays are backed by `chrome.alarms` so they survive service-worker restarts.
- Per-window dedupe lock prevents duplicate auto-firing
- Manual "Warm up now" button bypasses dedupe (for retries)
- Quiet hours, configurable warmup message, editable DOM selectors
- Desktop notifications for warmups, failures, and login prompts
- Diagnostic log viewer in popup and options page

## Installation

1. Download or clone this repo
2. Open `chrome://extensions` (or `edge://extensions`)
3. Toggle Developer mode on
4. Click Load unpacked and pick the `claude-session-warmer-v15` folder
5. Pin the extension to your toolbar

## First-run setup

1. Click the extension icon
2. Hit Refresh — opens a brief background tab to `/settings/usage`, scrapes state, closes it. (You must be logged into claude.ai.)
3. The popup shows: Running, No session, Logged out, or Unknown
4. If "No session" and you're outside quiet hours, a warmup fires within seconds

## Architecture

State is read from a brief background tab opened on `claude.ai/settings/usage` (claude.ai is a SPA, so reading via `fetch()` doesn't work). The service worker uses event triggers (`onStartup`, `onIdle`, targeted alarms) instead of polling. Warmups are sent via `chrome.scripting.executeScript` against a `/new` tab.

```
TRIGGERS (event-driven)
  ├─ onStartup           → check, warmup if needed
  ├─ onIdle('active')    → check, warmup if needed
  ├─ alarm 'reset-fired' → check, warmup if needed
  ├─ alarm 'safety-check'→ hourly fallback
  ├─ alarm 'quiet-end-eval' → fires when quiet hours end
  └─ tabs.onUpdated      → re-eval after re-login or stale state
        │
        ▼
  refreshState (open bg tab → content.js scrapes → close tab)
        │
        ▼
  Decision → maybeWarmup(signature) → performWarmup
        │
        ▼
  On success: increment totalWarmups, lock signature
```

State extraction prefers `<time datetime="…">` ISO timestamps (timezone-safe) over free-text "Resets at HH:MM" parsing (which is timezone-fragile).

## Project structure

```
claude-session-warmer-v15/
├── manifest.json
├── background.js          Service worker, alarm logic, state read, warmup
├── content.js             Usage-page scraper + login-page detector
├── popup.{html,css,js}    Toolbar popup
├── options.{html,css,js}  Settings page (with diagnostic log viewer)
├── tests/                 Unit tests (run with `node tests/time-parser.test.js`)
├── icons/                 16/48/128 PNGs
├── README.md
├── LICENSE                MIT
└── .gitignore
```

## Settings reference

| Setting | Default | Notes |
|---|---|---|
| `enabled` | `true` | Master switch |
| `message` | `hi` | Sent to start a new window |
| `notifications` | `true` | Desktop notifications |
| `quietHoursEnabled` | `false` | If on, no warmups during the window |
| `quietStart` / `quietEnd` | `23:00` / `06:00` | Quiet hours range |
| `selectors.inputArea` | (multi) | CSS selector for chat input |
| `selectors.sendButton` | (multi) | CSS selector for send button |

## Troubleshooting

**Popup says "Logged out — click here"**
Click the row, log into claude.ai. The extension will detect the navigation and re-check state automatically.

**Popup says "Unknown" after Refresh**
Open the diagnostic log viewer in Settings. Most likely cause: claude.ai changed the wording of the reset phrase, or the usage page rendered before content script could observe it.

**Warmup runs but no message gets sent in the chat**
Update the chat-input/send-button selectors in the options page. Right-click the chat input on claude.ai → Inspect → copy a CSS selector. The extension already attempts multiple insert strategies (execCommand, paste event, textContent) for ProseMirror-based editors.

**It fired twice somehow**
That should be impossible for auto-warmup. Check whether you (or another popup click) hit "Warm up now" — that's the only path that bypasses dedupe.

**Multiple machines**
`chrome.storage.local` (where dedupe state and the lifetime counter live) does not sync across devices. Each device tracks its own dedupe and counter. The intent is to install on the device you actually use in the morning. If you install on multiple devices, expect each one to potentially fire its own warmup.

## Security & privacy

- No external network calls other than to `claude.ai`. No telemetry. No analytics.
- No data leaves your browser. Settings live in `chrome.storage.sync`. State, diagnostic logs, and the lifetime counter live in `chrome.storage.local`. Neither contains tokens or message content.
- Broad host permissions (`https://claude.ai/*`) are required because claude.ai uses several subpaths and the SPA hydrates client-side.
- No code is ever evaluated from page content. Selectors are passed to `querySelector`. Insertion uses `textContent`, native value setters, `execCommand`, and synthetic events. No `eval`, no `Function()`.
- `chrome.scripting.executeScript` is used only against tabs the extension itself opened or navigated.

## Development

No build step.
1. Edit any file
2. `chrome://extensions` → click the refresh icon on the extension card
3. Reload claude.ai if you changed `content.js`
4. Open the diagnostic log viewer in Settings, or the SW console

To run tests:
```
node tests/time-parser.test.js
```

## Changelog

### v1.5.10
- **Configurable post-reset delay**: new "Delay after reset" setting (minutes) controls how long after the 5-hour window resets the extension waits before checking the session and firing a warmup — the grace period that lets you start a session yourself first.
- **Random jitter**: new "Random jitter" setting (± seconds) offsets each warmup so it never lands at the exact same time twice. Set to 0 to disable. Note: Chrome alarms don't fire sooner than ~1 min, so keep the base delay at 2+ minutes for the jitter to visibly move the fire time.

### v1.5.9
- **New usage page (2026 redesign) support**: Claude replaced the session usage bar's `role="progressbar"` with a CDS Meter (`role="meter"`, with `aria-valuenow` / `aria-valuetext` / `aria-labelledby`). The parser now reads the meter, prefers the bar whose `aria-labelledby` points at the "Current session" label, and falls back to parsing `aria-valuetext` ("21% used"). The legacy `role="progressbar"` path is kept for backward compatibility. A real captured page dump is included as a test fixture.

### v1.5.8
- **Belt-and-suspenders guard** in `maybeWarmup`: auto-warmups are refused whenever stored state shows an active session with more than 2 minutes remaining. Manual warmups bypass the guard.
- **Positive active signal from the usage bar**: a non-zero meter proves a session is active even if reset text can't be parsed.
- **Blank-reading stability window**: transient blank reads during initial page render are held ~1.2s before being reported.

### v1.5.7
- **Manual warmup no longer resets the countdown to 5h**: the 5-hour window is anchored to the session's first message, so `performWarmup` preserves the existing future reset time instead of overwriting it.
- **Model selector returns**: choose Haiku (default, lowest) / Sonnet / Opus / don't-change in Settings. The model is switched on the page before the warmup message is sent, best-effort.
- Recent-activity panel removed from the popup (full diagnostic log remains on the Settings page).

### v1.5.6
- `performWarmup` closes the scrape tab it opens once the message is accepted; pre-existing `/new` tabs are reused without being closed.
- Optimistic active state on a confirmed warmup so the popup immediately shows "Running".
- Post-warmup grace period suppresses a re-warm loop while the usage page catches up.

### v1.5.0
- **All long delays moved from `setTimeout` to `chrome.alarms`** so they survive service-worker termination.
- **Alarm minimum delay clamped to ≥1 minute** for cross-Chrome compatibility.
- **Tab safety**: `performWarmup` no longer hijacks `/chat/*` tabs. Only `/new` and `/` are reused.
- **ProseMirror-aware text insertion**: tries `execCommand('insertText')` → paste event → textContent fallback. Send fallback now dispatches keydown+keypress+keyup.
- **Mutex persisted in storage with TTL** so concurrent triggers across SW restarts can't spawn duplicate scrape tabs.
- **Re-evaluates on claude.ai navigation** when state is logged-out, unknown, or stale (previously: only logged-out).
- **Quiet-hours**: extension now schedules an alarm at quiet-end so a warmup fires the moment the window opens.
- **Chat input readiness probe** instead of fixed 1.5s sleep.
- **Leaked-tab cleanup**: scrape tabs are tagged with `?csw=scrape`. On SW startup, any abandoned tabs from a prior crash are swept.
- **Re-auth notification cooldown cleared** automatically once login is detected.
- **Safety alarm** reduced from 4h to 1h.
- **Diagnostic log viewer** in popup (last 6 lines) and options page (last 200).
- **`runtime.lastError` checks** added on chrome API callbacks.
- **Time parsing**: `time[datetime]` ISO is now the primary path. Free-text "Resets at HH:MM" is fallback only. A clock time within the last 5 minutes is treated as just-reset (blank), not "tomorrow".
- **Removed decorative "Preferred model" field** from settings.
- **Strengthened ToS notice** in README and options page.
- **Material-change save**: changing notifications or message text no longer triggers an unnecessary state-refresh tab.
- **Unit tests** for time-parsing logic in `tests/`.
- **Version tag** in popup/options footers always reads from `manifest.json` (no hardcoded fallback).

### v1.4.0
- Reverted to the cream light theme.
- Restored Usage page quick link.
- Adjusted credit-link color for cream readability.

### v1.3.0
- Dark UI redesign, lifetime warmup counter, credit footer, "LOCAL & PRIVATE" tag, version pulled from manifest, clock-icon logo.

### v1.2.0
- Fixed broken state reading from v1.1. Conservative blank-state detection. Auto re-evaluation on post-login navigation. Reset alarm fires 30s past calculated reset (clock-drift buffer). More robust regex variants. In-memory mutex.

### v1.1.0 (broken — do not use)
- Attempted SW `fetch()` of `/settings/usage`. Did not work for SPA.

### v1.0.0
- Initial release.

## Credits

Made with ❤ by [Gaurav](https://tools.gauraverse.com/).

## License

MIT — see `LICENSE`.

"Claude" is a trademark of Anthropic, PBC.
