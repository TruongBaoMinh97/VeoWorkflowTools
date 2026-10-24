'use strict';

const bridgeUrlInput = document.getElementById('bridge-url');
const bridgeSecretInput = document.getElementById('bridge-secret');
const toggleSecretBtn = document.getElementById('toggle-secret');
const eyeIcon = document.getElementById('eye-icon');
const saveBtn = document.getElementById('save-btn');
const testBtn = document.getElementById('test-btn');
const testResult = document.getElementById('test-result');
const lastPollEl = document.getElementById('last-poll');
const lastMintEl = document.getElementById('last-mint');
const lastMintDurEl = document.getElementById('last-mint-duration');
const openFlowBtn = document.getElementById('open-flow-btn');

chrome.storage.local.get(
  ['bridgeBase', 'bridgeSecret'],
  ({ bridgeBase, bridgeSecret }) => {
    if (bridgeBase) bridgeUrlInput.value = bridgeBase;
    if (bridgeSecret) bridgeSecretInput.value = bridgeSecret;
    updateSaveState();
  },
);

function updateSaveState() {
  const urlOk = bridgeUrlInput.value.trim().length > 0;
  const secretOk = bridgeSecretInput.value.trim().length > 0;
  saveBtn.disabled = !(urlOk && secretOk);
}

bridgeUrlInput.addEventListener('input', updateSaveState);
bridgeSecretInput.addEventListener('input', updateSaveState);

let secretVisible = false;
toggleSecretBtn.addEventListener('click', () => {
  secretVisible = !secretVisible;
  bridgeSecretInput.type = secretVisible ? 'text' : 'password';
  eyeIcon.textContent = secretVisible ? '🙈' : '👁';
  toggleSecretBtn.setAttribute('aria-label', secretVisible ? 'Ẩn secret' : 'Hiện secret');
});

document.getElementById('config-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const bridgeBase = bridgeUrlInput.value.trim().replace(/\/+$/, '');
  const bridgeSecret = bridgeSecretInput.value.trim();
  chrome.storage.local.set({ bridgeBase, bridgeSecret }, () => {
    const original = saveBtn.textContent;
    saveBtn.textContent = '✓ Đã lưu';
    saveBtn.disabled = true;
    setTimeout(() => {
      saveBtn.textContent = original;
      updateSaveState();
    }, 2000);
  });
});

testBtn.addEventListener('click', async () => {
  const bridgeBase = bridgeUrlInput.value.trim().replace(/\/+$/, '');
  const bridgeSecret = bridgeSecretInput.value.trim();
  if (!bridgeBase || !bridgeSecret) {
    showTestResult(false, 'Vui lòng nhập Bridge URL và Bridge Secret trước.');
    return;
  }
  const originalText = testBtn.textContent;
  testBtn.disabled = true;
  testBtn.textContent = 'Đang kiểm tra...';
  hideTestResult();

  try {
    const resp = await fetch(`${bridgeBase}/api/internal/captcha/stats`, {
      method: 'GET',
      headers: { 'x-local-auth': bridgeSecret },
    });
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      const pending = data.pendingCount ?? '?';
      const queued = data.queuedCount ?? '?';
      const pollers = data.pollerWaitingCount ?? '?';
      showTestResult(true, `OK — pending: ${pending}, queued: ${queued}, pollers: ${pollers}`);
    } else {
      showTestResult(false, `HTTP ${resp.status} ${resp.statusText}`);
    }
  } catch (e) {
    showTestResult(false, e?.message || 'Không thể kết nối tới backend');
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = originalText;
  }
});

function showTestResult(ok, msg) {
  testResult.hidden = false;
  testResult.textContent = ok ? `✓ ${msg}` : `✗ ${msg}`;
  testResult.className = `test-result ${ok ? 'test-ok' : 'test-fail'}`;
}

function hideTestResult() {
  testResult.hidden = true;
  testResult.textContent = '';
  testResult.className = 'test-result';
}

function formatAgo(ts) {
  if (!ts) return '—';
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 5) return 'Vừa xong';
  if (secs < 60) return `${secs}s trước`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem > 0 ? `${mins}m ${rem}s trước` : `${mins}m trước`;
}

function refreshStatus() {
  chrome.storage.session.get(
    ['lastPollOkAt', 'lastMintOkAt', 'lastMintDurationMs'],
    ({ lastPollOkAt, lastMintOkAt, lastMintDurationMs }) => {
      lastPollEl.textContent = formatAgo(lastPollOkAt);
      lastMintEl.textContent = formatAgo(lastMintOkAt);
      lastMintDurEl.textContent = lastMintDurationMs != null ? `${lastMintDurationMs}ms` : '—';
    },
  );
}

refreshStatus();
const statusTimer = setInterval(refreshStatus, 5_000);
window.addEventListener('unload', () => clearInterval(statusTimer));

openFlowBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://flow.google.com/' });
});
