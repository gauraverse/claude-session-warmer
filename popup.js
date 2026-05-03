// popup.js v1.3 — drives the redesigned popup UI

const $ = (id) => document.getElementById(id);

// Render the manifest version into the footer (so v1.3 → v1.4 → … updates auto)
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

  // ── Extension status ─────────────────────────────────────────────────
  $('status-enabled').textContent = enabled ? 'Active' : 'Paused';
  setDot('dot-extension', enabled ? 'is-active' : 'is-warning');

  // ── Session status ───────────────────────────────────────────────────
  const sessionMap = {
    active:       { label: 'Running',           dot: 'is-active'  },
    blank:        { label: 'No session',        dot: 'is-warning' },
    'logged-out': { label: 'Logged out',        dot: 'is-danger'  },
    unknown:      { label: 'Unknown',           dot: ''           }
  };
  const session = sessionMap[local.sessionState] || { label: '—', dot: '' };
  $('status-session').textContent = session.label;
  setDot('dot-session', session.dot);

  // Make the "Logged out" row clickable to /login
  const sessVal = $('status-session');
  sessVal.classList.toggle('clickable', local.sessionState === 'logged-out');

  // ── Next reset countdown ─────────────────────────────────────────────
  if (local.sessionState === 'active' && local.nextResetTime) {
    $('status-reset').textContent = formatRelative(local.nextResetTime);
  } else if (local.sessionState === 'blank') {
    $('status-reset').textContent = 'Pending warmup…';
  } else if (local.sessionState === 'logged-out') {
    $('status-reset').textContent = '—';
  } else {
    $('status-reset').textContent = '—';
  }

  // ── Last warmup ──────────────────────────────────────────────────────
  if (local.lastWarmupTime) {
    const tag = local.lastWarmupResult === 'fail' ? ' (failed)' : '';
    $('status-warmup').textContent = formatPast(local.lastWarmupTime) + tag;
    $('status-warmup').style.color = local.lastWarmupResult === 'fail' ? 'var(--danger)' : '';
  } else {
    $('status-warmup').textContent = 'Never';
    $('status-warmup').style.color = '';
  }

  // ── Toggle button label & state ──────────────────────────────────────
  const btn = $('toggle-btn');
  $('toggle-label').textContent = enabled ? 'Pause' : 'Resume';
  btn.classList.toggle('is-paused', !enabled);

  // ── Lifetime warmup count (footer) ───────────────────────────────────
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

// Locale-aware count formatting (1234 → 1,234)
function formatCount(n) {
  try { return n.toLocaleString(); } catch { return String(n); }
}

// ── Event handlers ─────────────────────────────────────────────────────

$('toggle-btn').addEventListener('click', async () => {
  const sync = await chrome.storage.sync.get('settings');
  const settings = sync.settings || {};
  settings.enabled = !(settings.enabled ?? true);
  await chrome.storage.sync.set({ settings });
  if (settings.enabled) {
    chrome.runtime.sendMessage({ type: 'evaluate-now' });
  }
  refresh();
});

$('warmup-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'manual-warmup' });
  // Optimistic UI feedback
  $('warmup-btn').setAttribute('disabled', 'true');
  setTimeout(() => $('warmup-btn').removeAttribute('disabled'), 3000);
  setTimeout(refresh, 1500);
});

$('refresh-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'manual-refresh-state' });
  setTimeout(refresh, 2000);
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

// Live-refresh the popup while it's open
refresh();
setInterval(refresh, 5000);
