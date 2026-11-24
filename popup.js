// popup.js v1.5.7
//   v1.5.7: Recent activity section removed from popup.
//           Diagnostic logs are still available on the Settings page.

const $ = (id) => document.getElementById(id);

try {
  const v = chrome.runtime.getManifest().version;
  $('version-tag').textContent = 'v' + v;
} catch {}

async function refresh() {
  const sync = await chrome.storage.sync.get('settings');
  const local = await chrome.storage.local.get([
    'nextResetTime', 'lastWarmupTime', 'sessionState',
    'lastWarmupResult', 'lastUsageFetch', 'totalWarmups'
  ]);
  const enabled = sync.settings?.enabled ?? true;

  $('status-enabled').textContent = enabled ? 'Active' : 'Paused';
  setDot('dot-extension', enabled ? 'is-active' : 'is-warning');

  const sessionMap = {
    active:       { label: 'Running',           dot: 'is-active'  },
    blank:        { label: 'No session',        dot: 'is-warning' },
    'logged-out': { label: 'Logged out',        dot: 'is-danger'  },
    unknown:      { label: 'Unknown',           dot: ''           }
  };
  const session = sessionMap[local.sessionState] || { label: '—', dot: '' };
  $('status-session').textContent = session.label;
  setDot('dot-session', session.dot);

  $('status-session').classList.toggle('clickable', local.sessionState === 'logged-out');

  if (local.sessionState === 'active' && local.nextResetTime) {
    $('status-reset').textContent = formatRelative(local.nextResetTime);
  } else if (local.sessionState === 'blank') {
    $('status-reset').textContent = 'Pending warmup…';
  } else {
    $('status-reset').textContent = '—';
  }

  if (local.lastWarmupTime) {
    const tag = local.lastWarmupResult === 'fail' ? ' (failed)' : '';
    $('status-warmup').textContent = formatPast(local.lastWarmupTime) + tag;
    $('status-warmup').style.color = local.lastWarmupResult === 'fail' ? 'var(--danger)' : '';
  } else {
    $('status-warmup').textContent = 'Never';
    $('status-warmup').style.color = '';
  }

  $('toggle-label').textContent = enabled ? 'Pause' : 'Resume';
  $('toggle-btn').classList.toggle('is-paused', !enabled);

  $('total-warmups').textContent = formatCount(local.totalWarmups || 0);
}

function setDot(id, cls) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('is-active', 'is-warning', 'is-danger');
  if (cls) el.classList.add(cls);
}

function formatRelative(ts) {
  const diff = ts - Date.now();
  if (diff < 0) return 'Now (overdue)';
  const mins = Math.round(diff / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  return `in ${h}h ${mins % 60}m`;
}

function formatPast(ts) {
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatCount(n) {
  try { return n.toLocaleString(); } catch { return String(n); }
}

$('toggle-btn').addEventListener('click', async () => {
  const sync = await chrome.storage.sync.get('settings');
  const settings = sync.settings || {};
  const wasEnabled = settings.enabled ?? true;
  settings.enabled = !wasEnabled;
  await chrome.storage.sync.set({ settings });
  if (settings.enabled) {
    chrome.runtime.sendMessage({ type: 'evaluate-now' }, () => { void chrome.runtime.lastError; });
  }
  refresh();
});

$('warmup-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'manual-warmup' }, () => { void chrome.runtime.lastError; });
  $('warmup-btn').setAttribute('disabled', 'true');
  setTimeout(() => $('warmup-btn').removeAttribute('disabled'), 3000);
  // Re-poll a few times after a manual warmup so the popup reflects the
  // updated session state and reset time without needing to close and reopen.
  setTimeout(refresh, 1500);
  setTimeout(refresh, 4000);
  setTimeout(refresh, 8000);
});

$('refresh-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'manual-refresh-state' }, () => { void chrome.runtime.lastError; });
  setTimeout(refresh, 2000);
  setTimeout(refresh, 5000);
});

$('status-session').addEventListener('click', async () => {
  const local = await chrome.storage.local.get('sessionState');
  if (local.sessionState === 'logged-out') {
    chrome.tabs.create({ url: 'https://claude.ai/login' });
  }
});

$('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

refresh();
setInterval(refresh, 5000);
