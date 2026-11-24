<!-- Replace the line below with a screenshot of the popup / settings in action -->
<!-- ![Claude Session Warmer](docs/screenshot.png) -->

<h1 align="center">Claude Session Warmer</h1>

<p align="center">
  A set-and-forget session keeper for <a href="https://claude.ai">claude.ai</a> —
  auto-starts a fresh 5-hour window the moment the last one resets, so your usage
  stays aligned with your day.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.5.10-c96442" alt="version" />
  <img src="https://img.shields.io/badge/manifest-v3-555" alt="manifest v3" />
  <img src="https://img.shields.io/badge/license-MIT-2b7" alt="MIT license" />
  <img src="https://img.shields.io/badge/data-local--first-3a8" alt="local-first" />
</p>

---

## What it does

Claude's usage runs on a rolling **5-hour window that starts with your first
message**. Send that first message at an awkward time and every reset after it
lands at an awkward time too — often right in the middle of something.

**Claude Session Warmer** sends that first message for you. It watches your live
session state, and the moment a window resets it quietly starts a new one with a
tiny throwaway message — so your sessions keep rolling on a schedule *you* set,
not whenever you happened to say "hi." If you've already started a session
yourself, it notices and stays out of the way.

## Features

| Feature | What you get |
|---|---|
| Auto warm-up | Starts a fresh 5-hour session the moment the previous window resets. |
| Live session detection | Reads your real session state and reset time straight from Claude's usage page — no guessing. |
| Model control | Choose which model the warm-up uses. Haiku by default, so it's fast and spends the least usage. |
| Post-reset delay | Set how long to wait after a reset before warming — a grace window to start a session yourself first. |
| Random jitter | Offsets each warm-up by a random ± seconds so it never fires at the exact same time twice. |
| Quiet hours | Pause warm-ups overnight (or any window); one is scheduled the moment quiet hours end. |
| Manual warm-up | One click in the popup to start a session right now. |
| Status at a glance | Popup shows whether a session is running, when it resets, and when the last warm-up fired. |
| Resilient | Survives service-worker shutdowns via `chrome.alarms`, rate-limits and dedupes triggers, and sweeps up leaked tabs. |
| Native feel | Popup and settings follow Claude's light/dark theme so it looks built-in. |

## Why I built it

> Claude's 5-hour window begins the instant I send my first message, so if I
> opened Claude at 11am my reset fell at 4pm — right in the middle of the
> afternoon. I wanted my windows to line up with how I actually work, not with
> whenever I first typed something. So I built a thing to send that first message
> for me, on a schedule I control, and then got out of my own way.

## Installation

### Option 1 - Download the latest release
Grab the ZIP from [Releases](../../releases/latest) and extract it.

### Option 2 - Clone the repo
```bash
git clone https://github.com/gauraverse/claude-session-warmer.git
```

### Then load it into your browser
1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** and select the extension folder (the one containing `manifest.json`)
4. Open [claude.ai](https://claude.ai), then click the extension icon to check its status

## Usage

| Action | How |
|---|---|
| Pause / resume warm-ups | Click the toggle in the popup |
| Warm up right now | Click **Warm up** in the popup |
| Re-check session state | Click the refresh icon in the popup |
| Change the message, model, or timing | Open **Settings** (the extension's options page) |
| Set a delay + jitter after reset | Settings → **Reset timing** |
| Pause overnight | Settings → **Quiet hours** |
| See exactly what it's doing | Settings → **Diagnostic logs** |

## How it works

A Manifest V3 service worker plus a small content script, organized into focused
pieces:

- **`content.js`** — runs on claude.ai and reads your session state (active +
  reset time, or blank) from the usage page. All page selectors live here with
  ordered fallbacks, so a future UI change is patched in one place.
- **`evaluateAndAct`** — the brain. Reads the current state and decides whether
  to warm up now, reschedule, or wait.
- **`scheduleResetAlarm`** — computes when the next warm-up should fire (base
  delay **+ random jitter**) and sets a `chrome.alarms` timer that survives the
  service worker being shut down.
- **`performWarmup`** — opens a background tab, switches to your chosen model,
  sends the message, waits for Claude to accept it, then closes the tab.
- **`maybeWarmup`** — the safety layer. Rate-limits, dedupes repeat triggers, and
  refuses to fire while a session is already active, so it can never spam
  messages into a running window.
- **Popup & Options** — status, manual controls, and every setting; theme-aware.

Runs are covered by a Node test suite (`node tests/*.test.js`) — the time parser,
the reset-time logic, the jitter math, and the usage-page reader all have fixtures.

## Privacy

**Local-first. No servers, no analytics, no third parties.** Everything runs in
your own browser. The only thing it ever sends is the warm-up message you
configured — to claude.ai, inside your own session, exactly as if you had typed
it yourself. Your settings and counters are stored in Chrome's own `storage`, and
the extension only runs on `https://claude.ai/*`.

It requests the permissions it needs to do that job and nothing more:

| Permission | Why |
|---|---|
| `storage` | Save your settings and warm-up counters |
| `alarms` | Fire warm-ups on schedule even when the worker is asleep |
| `tabs` + `scripting` | Open a claude.ai tab and send the message in it |
| `notifications` | Tell you when a warm-up fires, fails, or you've been logged out |
| `idle` | Avoid acting at pointless moments |

## Compatibility

Chromium browsers (Chrome, Edge, Brave, Arc) on Manifest V3. Because claude.ai is
not a public API, layout updates from Anthropic can occasionally shift the markup.
Selectors are centralized in `content.js` and can also be overridden in
Settings → Advanced without touching the code.

## Changelog

### v1.5.10
- **Configurable post-reset delay** — choose how long after a reset to wait
  before warming, so you get a grace window to start a session yourself first.
- **Random jitter** — a random ± seconds offset so the warm-up never lands at the
  exact same time twice. Set it to 0 to disable. (Chrome won't fire an alarm
  sooner than ~1 min, so keep the base at 2+ minutes for jitter to show.)

### v1.5.9
- Support for Claude's redesigned usage page, which swapped the session bar from
  `role="progressbar"` to a `role="meter"` component. The reader now prefers the
  meter tied to the "Current session" label and falls back to its `aria-valuetext`.

### v1.5.8
- Added a guard that refuses to auto-warm while a session is already active with
  time left — the last line of defense against repeat "hi" messages.
- Positive active-session signal from the usage bar, plus a short stability
  window so a transient blank read during page load can't trigger a warm-up.

### v1.5.7
- Manual warm-ups no longer reset the countdown to a full 5 hours — the existing
  reset time is preserved, since the window is anchored to the session's first message.
- Model selector returned (Haiku / Sonnet / Opus / don't-change), defaulting to Haiku.

### v1.5.6
- Scrape tabs close themselves once the message is accepted; pre-existing `/new`
  tabs are reused without being closed.
- Grace period after a successful warm-up prevents a re-warm loop while the usage
  page catches up.

### v1.5.0
- Long delays moved from `setTimeout` to `chrome.alarms` so they survive
  service-worker termination; persisted mutex prevents duplicate scrape tabs;
  quiet-hours scheduling; leaked-tab cleanup; diagnostic log viewer.

## License

[MIT](LICENSE) (c) 2026 Gaurav

---

<p align="center">
  Made with &#9829; by <a href="https://tools.gauraverse.com">Gaurav</a> -
  part of <a href="https://tools.gauraverse.com">tools.gauraverse.com</a>
</p>
