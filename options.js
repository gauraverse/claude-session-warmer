// options.js v1.1
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

const $ = (id) => document.getElementById(id);

async function load() {
  const stored = await chrome.storage.sync.get('settings');
  const s = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  s.selectors = { ...DEFAULT_SETTINGS.selectors, ...(s.selectors || {}) };

  $('enabled').checked = s.enabled;
  $('notifications').checked = s.notifications;
  $('message').value = s.message;
  $('model').value = s.model;
  $('quietHoursEnabled').checked = s.quietHoursEnabled;
  $('quietStart').value = s.quietStart;
  $('quietEnd').value = s.quietEnd;
  $('sel-input').value = s.selectors.inputArea;
  $('sel-send').value = s.selectors.sendButton;
  $('sel-model').value = s.selectors.modelSelector;
}

async function save() {
  const settings = {
    enabled: $('enabled').checked,
    notifications: $('notifications').checked,
    message: $('message').value || 'hi',
    model: $('model').value || 'claude-haiku',
    quietHoursEnabled: $('quietHoursEnabled').checked,
    quietStart: $('quietStart').value || '23:00',
    quietEnd: $('quietEnd').value || '06:00',
    selectors: {
      inputArea: $('sel-input').value,
      sendButton: $('sel-send').value,
      modelSelector: $('sel-model').value
    }
  };
  await chrome.storage.sync.set({ settings });
  $('save-status').textContent = 'Saved ✓';
  // Re-evaluate immediately if settings changed materially
  chrome.runtime.sendMessage({ type: 'evaluate-now' });
  setTimeout(() => { $('save-status').textContent = ''; }, 1500);
}

async function resetDefaults() {
  await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  load();
  $('save-status').textContent = 'Defaults restored';
  setTimeout(() => { $('save-status').textContent = ''; }, 1500);
}

$('save').addEventListener('click', save);
$('reset').addEventListener('click', resetDefaults);

// Footer hydration: version from manifest, total warmups from storage
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
