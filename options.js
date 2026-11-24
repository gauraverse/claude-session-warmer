// options.js v1.5.10
//   v1.5.10: Post-reset delay + jitter settings (postResetDelayMin,
//            postResetJitterSec).
//   v1.5.7:  `model` field is back. Default = 'haiku' (lowest tier).
//            Added optional model-picker selector for the advanced section.
//   v1.5:    #14 version-tag from manifest only.
//            #17 evaluate-now is only sent when material settings change.
//            #23 Diagnostic log viewer.

const DEFAULT_SETTINGS = {
  enabled: true,
  message: 'hi',
  model: 'haiku',
  notifications: true,
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

// Clamp helpers mirror the background's limits so what you save is what runs.
const POST_RESET_DELAY_MIN_MAX = 120;
const POST_RESET_JITTER_SEC_MAX = 600;
function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const $ = (id) => document.getElementById(id);

let lastLoadedSettings = null;

async function load() {
  const stored = await chrome.storage.sync.get('settings');
  const s = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  s.selectors = { ...DEFAULT_SETTINGS.selectors, ...(s.selectors || {}) };
  lastLoadedSettings = JSON.parse(JSON.stringify(s));

  $('enabled').checked = s.enabled;
  $('notifications').checked = s.notifications;
  $('message').value = s.message;
  $('model').value = s.model || 'haiku';
  $('postResetDelayMin').value = s.postResetDelayMin ?? DEFAULT_SETTINGS.postResetDelayMin;
  $('postResetJitterSec').value = s.postResetJitterSec ?? DEFAULT_SETTINGS.postResetJitterSec;
  $('quietHoursEnabled').checked = s.quietHoursEnabled;
  $('quietStart').value = s.quietStart;
  $('quietEnd').value = s.quietEnd;
  $('sel-input').value = s.selectors.inputArea;
  $('sel-send').value = s.selectors.sendButton;
  $('sel-model').value = s.selectors.modelPicker;
}

function readForm() {
  return {
    enabled: $('enabled').checked,
    notifications: $('notifications').checked,
    message: $('message').value || 'hi',
    model: $('model').value || 'haiku',
    postResetDelayMin: clampNum($('postResetDelayMin').value, 0, POST_RESET_DELAY_MIN_MAX, DEFAULT_SETTINGS.postResetDelayMin),
    postResetJitterSec: clampNum($('postResetJitterSec').value, 0, POST_RESET_JITTER_SEC_MAX, DEFAULT_SETTINGS.postResetJitterSec),
    quietHoursEnabled: $('quietHoursEnabled').checked,
    quietStart: $('quietStart').value || '23:00',
    quietEnd: $('quietEnd').value || '06:00',
    selectors: {
      inputArea: $('sel-input').value,
      sendButton: $('sel-send').value,
      modelPicker: $('sel-model').value
    }
  };
}

function isMaterialChange(prev, next) {
  if (!prev) return true;
  const wasEnabled = !!prev.enabled, isEnabled = !!next.enabled;
  if (!wasEnabled && isEnabled) return true;
  if (prev.quietHoursEnabled !== next.quietHoursEnabled) return true;
  if (prev.quietStart !== next.quietStart) return true;
  if (prev.quietEnd !== next.quietEnd) return true;
  if (prev.selectors?.inputArea !== next.selectors.inputArea) return true;
  if (prev.selectors?.sendButton !== next.selectors.sendButton) return true;
  // v1.5.10: changing the post-reset delay/jitter should reschedule the reset
  // alarm, so treat these as material (triggers an evaluate-now on save).
  if (prev.postResetDelayMin !== next.postResetDelayMin) return true;
  if (prev.postResetJitterSec !== next.postResetJitterSec) return true;
  // Note: model + modelPicker selector are NOT material — they only affect
  // the next warmup, not whether to schedule one.
  return false;
}

async function save() {
  const settings = readForm();
  await chrome.storage.sync.set({ settings });
  $('save-status').textContent = 'Saved';

  if (isMaterialChange(lastLoadedSettings, settings)) {
    chrome.runtime.sendMessage({ type: 'evaluate-now' }, () => { void chrome.runtime.lastError; });
  }
  lastLoadedSettings = JSON.parse(JSON.stringify(settings));
  setTimeout(() => { $('save-status').textContent = ''; }, 1500);
}

async function resetDefaults() {
  await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  await load();
  $('save-status').textContent = 'Defaults restored';
  chrome.runtime.sendMessage({ type: 'evaluate-now' }, () => { void chrome.runtime.lastError; });
  setTimeout(() => { $('save-status').textContent = ''; }, 1500);
}

$('save').addEventListener('click', save);
$('reset').addEventListener('click', resetDefaults);

async function loadLogs() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'get-logs' }, (resp) => {
      void chrome.runtime.lastError;
      const logs = (resp && resp.logs) || [];
      if (!logs.length) {
        $('log-view').textContent = '(empty)';
      } else {
        $('log-view').textContent = logs.map(l => {
          const t = new Date(l.t).toLocaleTimeString();
          return `[${t}] ${l.m}`;
        }).join('\n');
      }
      const view = $('log-view');
      view.scrollTop = view.scrollHeight;
      resolve();
    });
  });
}
$('log-refresh').addEventListener('click', loadLogs);
$('log-clear').addEventListener('click', async () => {
  await new Promise((r) => chrome.runtime.sendMessage({ type: 'clear-logs' }, () => { void chrome.runtime.lastError; r(); }));
  await loadLogs();
});

async function hydrateFooter() {
  try {
    const v = chrome.runtime.getManifest().version;
    const tag = $('version-tag');
    if (tag) tag.textContent = 'v' + v;
  } catch {}
  try {
    const { totalWarmups = 0 } = await chrome.storage.local.get('totalWarmups');
    const el = $('total-warmups');
    if (el) el.textContent = (totalWarmups || 0).toLocaleString();
  } catch {}
}

load();
hydrateFooter();
loadLogs();
