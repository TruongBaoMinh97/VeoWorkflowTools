// ISOLATED-world bridge. Injects MAIN-world `injected.js` so
// grecaptcha.enterprise.execute runs in Flow's React context (real userActivation).
// Guard prevents duplicate onMessage listeners across retry injections.
'use strict';

(function installContentBridge() {
  if (window.__upprojectContentInstalled) return;
  window.__upprojectContentInstalled = true;

  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('injected.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'GET_CAPTCHA') return undefined;
    const { requestId, pageAction } = msg;

    const handler = (ev) => {
      if (ev.detail?.requestId !== requestId) return;
      window.removeEventListener('UPPROJECT_CAPTCHA_RESULT', handler);
      clearTimeout(timer);
      sendResponse({ token: ev.detail?.token, error: ev.detail?.error });
    };

    const timer = setTimeout(() => {
      window.removeEventListener('UPPROJECT_CAPTCHA_RESULT', handler);
      sendResponse({ error: 'CONTENT_TIMEOUT' });
    }, 22_000);

    window.addEventListener('UPPROJECT_CAPTCHA_RESULT', handler);
    window.dispatchEvent(
      new CustomEvent('UPPROJECT_GET_CAPTCHA', { detail: { requestId, pageAction } }),
    );

    return true; // keep message channel open for async sendResponse
  });
})();
