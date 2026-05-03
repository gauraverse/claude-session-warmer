# Claude Session Warmer

A browser extension that automatically starts a new Claude session the moment your previous 5-hour usage window ends — and ensures the timer is already active by the time you sit down. So you never have to send the first "hi" yourself.

**Version 1.4.0** — see [Changelog](#changelog) for what's new.

## Why this exists

If you don't manually fire a message at the moment your old session ends, the next 5-hour window doesn't begin until you do. For people who want their first Claude session of the day to start automatically — or who want their session to be live the moment they open the laptop — this extension automates the chore, while being careful never to spam duplicate messages.

## ⚠️ A note before you install

This extension automates clicks and keystrokes inside `claude.ai`. That sits in a grey area of Anthropic's consumer usage terms, which generally discourage scripted access to the consumer apps. The volume here is minimal — one short message every ~5 hours, on your own account, only when needed. Use it on your own account, at your own discretion. This project is not affiliated with or endorsed by Anthropic.

## What v1.3 guarantees

- **When the browser starts and you have no active session → warmup fires within seconds.**
- **When you return to your machine after being idle/away → warmup fires if needed.**
- **When the previous session's reset moment arrives → warmup fires once, exactly once.** Targeted one-shot alarm. No polling.
- **A logged-out state surfaces a clickable notification.** Warmups pause until you sign in. When you do, the extension auto re-evaluates.
- **Duplicate messages are structurally prevented.** Each session window has a unique signature; the extension records which signature it warmed and refuses to warm the same one twice. Only a freshly-observed *new* reset time unlocks the next auto-warmup. The manual "Warm up now" button bypasses this.
- **Lifetime stats are tracked locally.** Every successful warmup increments a counter shown in the popup footer. Nothing leaves your browser.

## Features

- Reads session state from `claude.ai/settings/usage`
- Distinguishes four states: **active**, **blank**, **logged out**, **unknown**
- Fires warmup at the right moment, exactly once per window
- Event-driven (startup, idle-active, targeted alarm) — no minute-by-minute polling
- Per-window dedupe physically prevents auto-firing twice for the same window
- Manual "Warm up now" button bypasses dedupe (for retries)
- Quiet hours, configurable warmup message, editable DOM selectors
- Desktop notifications for warmups, failures, and login prompts
- **Polished dark UI** with status indicators, lifetime warmup counter, and a credit footer

## Installation

1. Download or clone this repo
2. Open `chrome://extensions` (or `edge://extensions`, etc.)
3. Toggle **Developer mode** on
4. Click **Load unpacked** and pick the `claude-session-warmer` folder
5. Pin the extension to your toolbar

## First-run setup

1. Click the extension icon
2. Hit **Refresh** — this opens a brief background tab to `/settings/usage`, scrapes your current state, and closes it. (You must be logged into claude.ai.)
3. The popup shows: *Running*, *No session*, *Logged out*, or *Unknown*
4. If "No session" and you're outside quiet hours, a warmup fires within seconds

## Architecture

State is read from a brief background tab opened on `claude.ai/settings/usage` (claude.ai is a SPA, so reading via `fetch()` doesn't work — the data needs JS hydration). The service worker uses event triggers (`onStartup`, `onIdle`, targeted alarms) instead of polling. Warmups are sent via `chrome.scripting.executeScript` against a `/new` tab, with the message and selectors passed in. A signature-based dedupe lock prevents duplicate auto-warmups for the same window.

```
TRIGGERS (event-driven)
  ├─ onStartup           → check, warmup if needed
  ├─ onIdle('active')    → check, warmup if needed
  ├─ alarm 'reset-fired' → check, warmup if needed
  ├─ alarm 'safety-check'→ 4-hourly fallback
  └─ tabs.onUpdated      → re-eval after re-login
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

## Project structure

```
claude-session-warmer/
├── manifest.json
├── background.js          Service worker, alarm logic, state read, warmup
├── content.js             Usage-page scraper + login-page detector
├── popup.{html,css,js}    Toolbar popup (dark UI, status, footer stats)
├── options.{html,css,js}  Settings page (matched dark UI)
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
| `model` | `claude-haiku` | Best-effort label; for guarantee, set Haiku as your Claude default |
| `notifications` | `true` | Desktop notifications |
| `quietHoursEnabled` | `false` | If on, no warmups during the window |
| `quietStart` / `quietEnd` | `23:00` / `06:00` | Quiet hours range |
| `selectors.inputArea` | (multi) | CSS selector for chat input |
| `selectors.sendButton` | (multi) | CSS selector for send button |

## Troubleshooting

**Popup says "Logged out — click here"**
Click the row, log into claude.ai. The extension will detect the navigation and re-check state automatically.

**Popup says "Unknown" after Refresh**
Open `chrome://extensions` → click the extension's *service worker* link → check the console for `[CSW]` log lines. Most likely cause: claude.ai changed the wording of the reset phrase.

**Warmup runs but no message gets sent in the chat**
Update the chat-input/send-button selectors in the options page. Right-click the chat input on claude.ai → *Inspect* → copy a CSS selector.

**It fired twice somehow**
That should be impossible for auto-warmup. Check whether you (or another popup click) hit **Warm up now** — that's the only path that bypasses dedupe.

**Multiple machines firing**
`chrome.storage.local` (where dedupe state lives) doesn't sync across devices. Install on the device you actually use in the morning.

## Security & privacy

- **No external network calls** other than to `claude.ai`. No telemetry. No analytics.
- **No data leaves your browser.** Settings live in `chrome.storage.sync`. State and the lifetime counter live in `chrome.storage.local`. Neither contains tokens or message content.
- **Broad host permissions** (`https://claude.ai/*`) are required because claude.ai uses several subpaths and the SPA hydrates client-side. The extension only acts on `/settings/usage`, `/new`, and reads page state on `/login`.
- **No code is ever evaluated from page content.** Selectors are passed to `querySelector`; messages are written via `textContent` / native value setters. No `eval`, no `Function()`.
- **`chrome.scripting.executeScript`** is used only against tabs the extension itself opened/navigated.

## Development

No build step. To iterate:
1. Edit any file
2. `chrome://extensions` → click the refresh icon on the extension card
3. Reload claude.ai if you changed `content.js`
4. Open the SW console for `[CSW]` logs

## Changelog

### v1.4.0
- Reverted background to the original cream (`#fafaf7`) light theme — keeps the v1.3 polish (status dots, brand mark, footer credits, lifetime counter) while losing the dark surface.
- Restored the **Usage page** quick link beside Settings, so jumping to `/settings/usage` is one click away again.
- Adjusted credit-link color to a darker mint/teal that's readable on cream.

### v1.3.0
- **New dark UI** for popup and options page — refined typography, status indicator dots with subtle pulse for the danger state, animated heart in credit footer.
- **Lifetime warmup counter** — every successful warmup (manual or auto) increments a counter shown in the popup footer ("⚡ N TOTAL WARMUPS"). Stored locally only.
- **Credit footer** ("Made with ❤ by Gaurav") with link to https://tools.gauraverse.com/.
- **"LOCAL & PRIVATE" tag** in the footer reminds at a glance that nothing leaves your browser.
- **Toggle-style checkboxes** in options page.
- Version tag in footer is auto-pulled from `manifest.json` so future bumps update without code changes.
- Logo updated to a clock icon (sessions are about timing).

### v1.2.0
- **Fixed: state reading completely broken in v1.1.** SW `fetch()` of `/settings/usage` returned an empty SPA shell. Reverted to a tab-based scrape while keeping all of v1.1's good event-driven improvements.
- Conservative blank-state detection prevents false-positive warmups.
- Auto re-evaluation on post-login navigation.
- Reset alarm fires 30s after calculated reset time (clock-drift buffer).
- More robust regex variants for reset-time phrases.
- In-memory mutex prevents concurrent state-refresh tabs.
- 1.5s post-load settle delay before injecting send script.

### v1.1.0 (broken — do not use)
- Attempted to replace tab-based state reads with SW `fetch()`. Did not work for SPA. Use v1.2+ instead.

### v1.0.0
- Initial release.

## Credits

Made with ❤ by [Gaurav](https://tools.gauraverse.com/).

## License

MIT — see `LICENSE`.

"Claude" is a trademark of Anthropic, PBC.
