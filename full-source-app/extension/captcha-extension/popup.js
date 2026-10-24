'use strict';

const banner = document.getElementById('status-banner');
const dot = document.getElementById('status-dot');
const labelEl = document.getElementById('status-label');
const subEl = document.getElementById('status-sub');
const footer = document.getElementById('footer');
const btnOptions = document.getElementById('btn-options');
const btnFlow = document.getElementById('btn-flow');

const STATE_LABELS = {
  noconfig: 'Chưa cấu hình',
  connected: 'Kết nối ổn định',
  stale: 'Kết nối chậm',
  offline: 'Mất kết nối',
};

function formatAgoShort(ts) {
  if (!ts) return null;
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 5) return 'vừa xong';
  if (secs < 60) return `${secs}s trước`;
  return `${Math.round(secs / 60)}m trước`;
}

function applyState(state, mintAgo) {
  banner.dataset.state = state;
  dot.dataset.state = state;
  labelEl.textContent = STATE_LABELS[state] ?? state;

  if (state === 'noconfig') {
    subEl.textContent = 'Mở Cài đặt để nhập URL + Secret';
  } else if (mintAgo) {
    subEl.textContent = `Mint cuối: ${mintAgo}`;
  } else {
    subEl.textContent = 'Chưa có mint nào trong phiên này';
  }
}

function resolveStatus() {
  chrome.storage.local.get(['bridgeBase', 'bridgeSecret'], ({ bridgeBase, bridgeSecret }) => {
    const hasConfig = !!(bridgeBase && bridgeSecret);
    if (!hasConfig) {
      applyState('noconfig', null);
      return;
    }
    chrome.storage.session.get(
      ['lastPollOkAt', 'lastMintOkAt'],
      ({ lastPollOkAt, lastMintOkAt }) => {
        const now = Date.now();
        const pollAge = lastPollOkAt ? now - lastPollOkAt : Infinity;
        const mintAgo = formatAgoShort(lastMintOkAt);

        let state;
        if (pollAge < 35_000) state = 'connected';
        else if (pollAge < 120_000) state = 'stale';
        else state = 'offline';

        applyState(state, mintAgo);
      },
    );
  });
}

try {
  const { version } = chrome.runtime.getManifest();
  footer.textContent = `UpProject Captcha Bridge v${version}`;
} catch (_) {
  /* manifest unavailable in edge cases — leave default */
}

resolveStatus();
const timer = setInterval(resolveStatus, 5_000);
window.addEventListener('unload', () => clearInterval(timer));

btnOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

btnFlow.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://flow.google.com/' });
  window.close();
});
