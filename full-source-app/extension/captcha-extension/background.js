// MV3 service worker that long-polls the local UpProject backend for captcha
// mint / soft-reset / hard-reset commands. Configure via the Options page.
'use strict';

const DEFAULT_BRIDGE_BASE = 'http://127.0.0.1:4000';
const PROFILE_ID = 'upproject-main';
const POLL_TIMEOUT_MS = 25_000;
const FLOW_URL = 'https://flow.google.com/';
// Google is migrating Flow to flow.google.com — a tab on EITHER domain counts.
// Shared by findFlowTab() + probeFlowTab() so the two queries never drift.
const FLOW_TAB_URL_PATTERNS = [
  'https://labs.google/fx/tools/flow*',
  'https://labs.google/fx/*/tools/flow*',
  'https://flow.google.com/*',
];

const EXTENSION_VERSION = chrome.runtime.getManifest().version;

// reCAPTCHA Enterprise anchors its per-session score in the _GRECAPTCHA cookie
// (set by enterprise.js on google.com / recaptcha.net). Clearing _grecaptcha*
// localStorage does NOT reset that score — only deleting this cookie + a page
// reload gives a fresh anchor. Removal is guarded to these exact domains so we
// never touch Google auth cookies (NID/SID/SAPISID/__Secure-*).
// Match reCAPTCHA's anchor by NAME (regex) across ALL domains + partitions. Safe
// because grecaptcha names never collide with Google auth cookies (NID/SID/
// SAPISID/__Secure-*), so the old exact-domain allow-list — which caused the
// "cleared 0" misses — is no longer needed. Catches _GRECAPTCHA and GRECAPTCHA.
const ANCHOR_NAME_RE = /grecaptcha/i;
// Every top-level site the Flow anchor could be CHIPS-partitioned under.
const ANCHOR_TOP_LEVEL_SITES = [
  'https://labs.google',
  'https://flow.google.com',
  'https://www.google.com',
  'https://google.com',
];

let consecutivePollErrors = 0;
let bridgeBase = DEFAULT_BRIDGE_BASE;
let bridgeSecret = '';
let configMissing = true;
let isPolling = false;

// ── Config ────────────────────────────────────────────────────────────

async function loadBridgeConfig() {
  const stored = await chrome.storage.local.get(['bridgeBase', 'bridgeSecret']);
  // Accept empty string explicitly — falling back to default would mask a
  // user who intentionally cleared the URL (visible via the badge).
  if (typeof stored.bridgeBase === 'string') {
    bridgeBase = stored.bridgeBase || DEFAULT_BRIDGE_BASE;
  }
  if (typeof stored.bridgeSecret === 'string') {
    bridgeSecret = stored.bridgeSecret;
  }
  configMissing = !bridgeBase || !bridgeSecret;
  updateBadge();
  if (configMissing) {
    console.warn(
      '[UpProject] Bridge config missing — not polling. ' +
        'Open the extension Options page and set Bridge URL + Secret.',
    );
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let updated = false;
  if (changes.bridgeBase && typeof changes.bridgeBase.newValue === 'string') {
    // Use the new value as-is; an explicitly cleared URL must propagate to
    // configMissing so the badge / status reflects what the user actually saved.
    bridgeBase = changes.bridgeBase.newValue;
    updated = true;
  }
  if (changes.bridgeSecret && typeof changes.bridgeSecret.newValue === 'string') {
    bridgeSecret = changes.bridgeSecret.newValue;
    updated = true;
    console.log('[UpProject] bridgeSecret updated from storage');
  }
  if (!updated) return;

  const wasConfigMissing = configMissing;
  configMissing = !bridgeBase || !bridgeSecret;
  updateBadge();

  if (wasConfigMissing && !configMissing && !isPolling) {
    console.log('[UpProject] Config now complete — starting poll loop');
    void pollLoop();
  }
});

// ── Badge ─────────────────────────────────────────────────────────────

function updateBadge() {
  if (configMissing) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    chrome.action.setTitle({ title: 'UpProject: Config missing — open Options' });
  } else {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'UpProject Captcha Bridge' });
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────

function authHeaders() {
  return bridgeSecret ? { 'x-local-auth': bridgeSecret } : {};
}

async function postJson(path, payload) {
  try {
    await fetch(`${bridgeBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ profileId: PROFILE_ID, ...payload }),
    });
  } catch (e) {
    console.warn('[UpProject] post failed:', path, e?.message || e);
  }
}

// ── Tab helpers ───────────────────────────────────────────────────────

async function findFlowTab() {
  const tabs = await chrome.tabs.query({ url: FLOW_TAB_URL_PATTERNS });
  // Ưu tiên tab labs.google: trang đó tự load grecaptcha sẵn, mint không cần
  // self-inject như flow.google.com.
  tabs.sort((a, b) => {
    const aLabs = a.url?.startsWith('https://labs.google/') ? 0 : 1;
    const bLabs = b.url?.startsWith('https://labs.google/') ? 0 : 1;
    return aLabs - bLabs;
  });
  if (tabs.length > 1) {
    console.warn(
      `[UpProject] ${tabs.length} Flow tabs found — using tab ${tabs[0].id}. ` +
        'Close extras for reliable minting (multiple tabs can confuse grecaptcha).',
    );
  }
  return tabs.length > 0 ? tabs[0] : null;
}

function ensureContentScript(tabId) {
  return chrome.scripting
    .executeScript({ target: { tabId }, files: ['content.js'] })
    .catch(() => undefined);
}

function waitForTabLoad(tabId, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      reject(new Error('waitForTabLoad: timeout'));
    }, timeoutMs);

    function onUpdated(id, info) {
      if (id !== tabId) return;
      if (info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        resolve();
      }
    }

    function onRemoved(id) {
      if (id !== tabId) return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      reject(new Error('waitForTabLoad: tab removed'));
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

// ── reCAPTCHA anchor cookie ───────────────────────────────────────────

// Delete the _GRECAPTCHA anchor cookie so the NEXT Flow-tab load boots with a
// fresh reCAPTCHA session. MUST be paired with a reload to reset the live score
// (enterprise.js keeps the anchor in memory until the page reloads). Returns the
// number of cookies removed — 0 usually means the cookie is CHIPS-partitioned,
// which `chrome.cookies.getAll` cannot see without a partitionKey.
// Enumerate every grecaptcha-ish cookie the extension can see (name/domain/
// partition) so we can SEE what exists at reset time instead of guessing.
async function dumpAnchorCookies() {
  try {
    const all = await chrome.cookies.getAll({});
    const hits = all.filter((c) => ANCHOR_NAME_RE.test(c.name));
    return hits.map(
      (c) =>
        `${c.name}@${c.domain}${c.partitionKey ? ` [part:${JSON.stringify(c.partitionKey)}]` : ''}`,
    );
  } catch (e) {
    console.warn('[UpProject] anchor dump failed:', e?.message || e);
    return [];
  }
}

// Remove every cookie whose name matches ANCHOR_NAME_RE within the given query.
// `query` omits `name` so getAll returns all cookies for permitted hosts; the
// regex filter then matches _GRECAPTCHA / GRECAPTCHA on any domain.
async function removeAnchorCookies(query, extra) {
  let removed = 0;
  const cookies = await chrome.cookies.getAll(query);
  for (const cookie of cookies) {
    if (!ANCHOR_NAME_RE.test(cookie.name)) continue;
    const host = cookie.domain.startsWith('.') ? `www${cookie.domain}` : cookie.domain;
    const url = `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path}`;
    try {
      const detail = await chrome.cookies.remove({
        url,
        name: cookie.name,
        storeId: cookie.storeId,
        ...extra,
      });
      if (detail !== null) removed++;
    } catch (_) {
      /* ignore individual removal errors */
    }
  }
  return removed;
}

async function clearRecaptchaCookieAnchor() {
  const before = await dumpAnchorCookies();
  console.log(`[UpProject] anchor before-clear: ${before.length} grecaptcha cookie(s):`, before);

  let removed = 0;
  let partitionedRemoved = 0;

  // Pass 1 — unpartitioned grecaptcha cookies on ANY reachable domain.
  try {
    removed = await removeAnchorCookies({});
  } catch (e) {
    console.error('[UpProject] anchor clear (unpartitioned) failed:', e?.message || e);
  }

  // Pass 2 — CHIPS: try every plausible top-level site the anchor may be keyed
  // under (labs.google + www/bare google.com). partitionKey needs Chrome 118+
  // (getAll) / 121+ (remove); older Chrome throws per-site → skipped.
  for (const topLevelSite of ANCHOR_TOP_LEVEL_SITES) {
    try {
      const partitionKey = { topLevelSite };
      partitionedRemoved += await removeAnchorCookies({ partitionKey }, { partitionKey });
    } catch (_e) {
      /* partitionKey unsupported on this Chrome */
    }
  }

  // Pass 3 — browsingData net for the reCAPTCHA origins (cookies only). These
  // hosts carry NO Google auth cookies, so this cannot log the user out.
  if (chrome.browsingData?.remove) {
    try {
      await chrome.browsingData.remove(
        { origins: ['https://www.google.com', 'https://www.recaptcha.net'] },
        { cookies: true },
      );
    } catch (e) {
      console.warn('[UpProject] browsingData net failed:', e?.message || e);
    }
  }

  const after = await dumpAnchorCookies();
  const total = removed + partitionedRemoved;
  console.log(
    `[UpProject] clearRecaptchaCookieAnchor: unpartitioned=${removed} partitioned=${partitionedRemoved} before=${before.length} after=${after.length}`,
  );
  if (before.length > 0 && after.length === 0) {
    console.log('[UpProject] anchor cleared — reCAPTCHA score should reset after tab reload.');
  } else if (before.length === 0) {
    console.warn(
      '[UpProject] no grecaptcha cookie visible to the extension — the anchor may be on a host outside host_permissions, or the score is not cookie-anchored.',
    );
  } else if (after.length > 0) {
    console.warn('[UpProject] anchor PARTIALLY cleared — still visible:', after);
  }
  // Report to the backend so the result is visible in the server log the user
  // watches, not only this service-worker console.
  void postJson('/api/internal/captcha/event', {
    type: 'anchor_clear',
    version: EXTENSION_VERSION,
    removed,
    partitionedRemoved,
    before: before.length,
    after: after.length,
    sample: before.slice(0, 8),
  });
  return total;
}

// ── Captcha mint ──────────────────────────────────────────────────────

async function handleCaptcha(command) {
  const { commandId, action } = command;
  const startedAt = Date.now();

  const tab = await findFlowTab();
  if (!tab?.id) {
    await postJson('/api/internal/captcha/result', { commandId, error: 'NO_FLOW_TAB' });
    return;
  }

  const ask = (timeoutMs) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ error: 'CAPTCHA_TIMEOUT' }), timeoutMs);
      chrome.tabs.sendMessage(
        tab.id,
        { type: 'GET_CAPTCHA', requestId: commandId, pageAction: action },
        (resp) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            resolve({ error: chrome.runtime.lastError.message || 'TAB_NO_LISTENER' });
            return;
          }
          resolve(resp || { error: 'EMPTY_REPLY' });
        },
      );
    });

  let reply = await ask(25_000);
  if (!reply?.token) {
    await ensureContentScript(tab.id);
    await new Promise((r) => setTimeout(r, 200));
    reply = await ask(20_000);
  }

  if (reply?.token) {
    const durationMs = Date.now() - startedAt;
    void chrome.storage.session.set({
      lastMintOkAt: Date.now(),
      lastMintDurationMs: durationMs,
    });
    await postJson('/api/internal/captcha/result', { commandId, token: reply.token });
  } else {
    await postJson('/api/internal/captcha/result', {
      commandId,
      error: reply?.error || 'CAPTCHA_FAILED',
    });
  }
}

// Strip _grecaptcha* localStorage in the Flow tab's MAIN world, then signal ready.

async function handleSoftReset(command) {
  const { commandId } = command;
  const tab = await findFlowTab();
  if (!tab?.id) {
    await postJson('/api/internal/captcha/result', { commandId, error: 'NO_FLOW_TAB' });
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        const keys = Object.keys(localStorage).filter((k) => k.startsWith('_grecaptcha'));
        keys.forEach((k) => localStorage.removeItem(k));
        return keys.length;
      },
    });
    // Prep only: deletes the persistent anchor so a following hard_reset reload
    // starts clean. Does NOT reset the live score without a reload.
    await clearRecaptchaCookieAnchor();
    await postJson('/api/internal/captcha/event', {
      type: 'extension_ready',
      version: EXTENSION_VERSION,
    });
    await postJson('/api/internal/captcha/result', { commandId, token: 'soft_reset_ok' });
  } catch (e) {
    await postJson('/api/internal/captcha/result', {
      commandId,
      error: e?.message || 'SOFT_RESET_FAILED',
    });
  }
}

// Navigate Flow tab away and back to force full grecaptcha re-init.

async function handleHardReset(command) {
  const { commandId } = command;
  const tab = await findFlowTab();
  if (!tab?.id) {
    await postJson('/api/internal/captcha/result', { commandId, error: 'NO_FLOW_TAB' });
    return;
  }
  // labs.google/fx/**/tools/* 308→flow.google.com (vĩnh viễn, 2026-09-11) — luôn
  // đưa tab về flow.google.com, không còn phân biệt domain.
  const returnUrl = FLOW_URL;
  try {
    // Root-cause fix: drop the _GRECAPTCHA anchor BEFORE the reload so the fresh
    // enterprise.js instance boots with a clean, high-score session.
    await clearRecaptchaCookieAnchor();
    await chrome.tabs.update(tab.id, { url: 'about:blank' });
    await new Promise((r) => setTimeout(r, 1500));
    await chrome.tabs.update(tab.id, { url: returnUrl });
    await waitForTabLoad(tab.id, 30_000);
    // Longer dwell so enterprise.js finishes initialising its fresh anchor
    // before the next mint (was 500ms).
    await new Promise((r) => setTimeout(r, 2500));
    await postJson('/api/internal/captcha/event', {
      type: 'extension_ready',
      version: EXTENSION_VERSION,
    });
    await postJson('/api/internal/captcha/result', { commandId, token: 'hard_reset_ok' });
  } catch (e) {
    await postJson('/api/internal/captcha/result', {
      commandId,
      error: e?.message || 'HARD_RESET_FAILED',
    });
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────

async function pollLoop() {
  isPolling = true;
  while (true) {
    if (configMissing) {
      console.warn('[UpProject] Poll loop stopping — config missing');
      isPolling = false;
      return;
    }

    let commands = [];
    try {
      const resp = await fetch(
        `${bridgeBase}/api/internal/captcha/poll` +
          `?profileId=${encodeURIComponent(PROFILE_ID)}&timeout=${POLL_TIMEOUT_MS}`,
        { method: 'GET', headers: authHeaders() },
      );
      if (resp.ok) {
        const data = await resp.json();
        commands = Array.isArray(data?.commands) ? data.commands : [];
        consecutivePollErrors = 0;
        void chrome.storage.session.set({ lastPollOkAt: Date.now() });
      } else if (resp.status === 204) {
        consecutivePollErrors = 0;
        void chrome.storage.session.set({ lastPollOkAt: Date.now() });
      } else {
        console.warn('[UpProject] poll HTTP', resp.status);
        consecutivePollErrors += 1;
      }
    } catch {
      consecutivePollErrors += 1;
    }

    for (const cmd of commands) {
      if (cmd.method === 'get_captcha') void handleCaptcha(cmd);
      else if (cmd.method === 'soft_reset') void handleSoftReset(cmd);
      else if (cmd.method === 'hard_reset') void handleHardReset(cmd);
      else console.warn('[UpProject] unknown command method:', cmd.method);
    }

    if (consecutivePollErrors > 0) {
      const backoff = Math.min(10_000, 500 * Math.pow(2, Math.min(consecutivePollErrors, 5)));
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

// Cheap probe — chrome.tabs.query takes <1ms. Report null on error so the
// backend treats it as "unknown" rather than asserting false.
async function probeFlowTab() {
  try {
    const tabs = await chrome.tabs.query({ url: FLOW_TAB_URL_PATTERNS });
    return tabs.length > 0;
  } catch (_e) {
    return null;
  }
}

// 24s keepalive — MV3 SW terminates after ~30s idle; this doubles as backend heartbeat.

chrome.alarms.create('upproject-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'upproject-keepalive' && !configMissing) {
    const hasFlowTab = await probeFlowTab();
    const payload = { type: 'heartbeat', version: EXTENSION_VERSION };
    if (typeof hasFlowTab === 'boolean') payload.hasFlowTab = hasFlowTab;
    void postJson('/api/internal/captcha/event', payload);
  }
});

// ── Bootstrap ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  void loadBridgeConfig().then(() => {
    if (!configMissing) {
      void postJson('/api/internal/captcha/event', {
        type: 'extension_installed',
        version: EXTENSION_VERSION,
      });
    }
  });
});

void loadBridgeConfig().then(() => {
  if (!configMissing) {
    void postJson('/api/internal/captcha/event', {
      type: 'extension_ready',
      version: EXTENSION_VERSION,
    });
    void pollLoop();
  }
});
