// MAIN world. Strips `_grecaptcha*` localStorage pre+post mint so background
// markers don't accumulate (degrades score).
'use strict';

(function () {
  if (window.__upprojectInstalled) return;
  window.__upprojectInstalled = true;

  const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
  const ENTERPRISE_URL = `https://www.google.com/recaptcha/enterprise.js?render=${SITE_KEY}`;

  let injectAttempted = false;

  function hasExecute() {
    return !!window.grecaptcha?.enterprise?.execute;
  }

  // flow.google.com KHÔNG tự load grecaptcha (labs.google thì có) — phải tự
  // tiêm enterprise.js. Trang này bật CSP nonce + Trusted Types nên cần đủ 3:
  //  1) TT policy 'default' passthrough — loader nội bộ của recaptcha gán src
  //     bằng string thô, thiếu default policy là bị chặn;
  //  2) đóng nonce của trang lên các <script> recaptcha tự chèn (gstatic);
  //  3) chèn enterprise.js với nonce + TrustedScriptURL.
  // Đã verify mint ra token thật trên flow.google.com (Chrome 152). Trang
  // không có TT/nonce (labs.google) đi qua nhánh string thường.
  function injectEnterpriseScript() {
    if (injectAttempted || hasExecute()) return;
    injectAttempted = true;
    try {
      const donor = [...document.querySelectorAll('script')].find((el) => el.nonce);
      const nonce = donor?.nonce || '';
      const tt = window.trustedTypes;
      if (tt?.createPolicy) {
        try {
          tt.createPolicy('default', {
            createHTML: (s) => s,
            createScript: (s) => s,
            createScriptURL: (s) => s,
          });
        } catch (_) {
          /* trang đã có default policy — dùng của họ */
        }
        if (nonce) {
          for (const fn of ['appendChild', 'insertBefore']) {
            const orig = Node.prototype[fn];
            Node.prototype[fn] = function (node, ...rest) {
              try {
                if (
                  node?.tagName === 'SCRIPT' &&
                  !node.nonce &&
                  /recaptcha|gstatic/.test(String(node.src || ''))
                ) {
                  node.nonce = nonce;
                }
              } catch (_) {
                /* không được phá DOM ops của trang */
              }
              return orig.call(this, node, ...rest);
            };
          }
        }
      }
      const s = document.createElement('script');
      if (nonce) s.nonce = nonce;
      let src = ENTERPRISE_URL;
      if (tt?.createPolicy) {
        try {
          src = tt
            .createPolicy('upproject-recaptcha', { createScriptURL: (u) => u })
            .createScriptURL(ENTERPRISE_URL);
        } catch (_) {
          /* trùng tên policy — string thô sẽ đi qua default policy ở trên */
        }
      }
      s.src = src;
      (document.head || document.documentElement).appendChild(s);
    } catch (_) {
      /* CSP chặn hẳn → waitForGrecaptcha sẽ timeout như hành vi cũ */
    }
  }

  function waitForGrecaptcha(timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (hasExecute()) return resolve();
        if (Date.now() - start > timeoutMs) {
          return reject(new Error('grecaptcha not available'));
        }
        setTimeout(check, 200);
      };
      check();
    });
  }

  function clearGrecaptchaCache() {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('_grecaptcha'))
        .forEach((k) => localStorage.removeItem(k));
    } catch (_) {
      /* cross-origin storage access denied — ignore */
    }
  }

  window.addEventListener('UPPROJECT_GET_CAPTCHA', async (ev) => {
    const { requestId, pageAction } = ev.detail || {};
    if (!pageAction || typeof pageAction !== 'string') {
      window.dispatchEvent(
        new CustomEvent('UPPROJECT_CAPTCHA_RESULT', {
          detail: { requestId, error: 'INVALID_ACTION: pageAction missing or non-string' },
        }),
      );
      return;
    }
    try {
      injectEnterpriseScript();
      await waitForGrecaptcha();
      clearGrecaptchaCache();
      const token = await window.grecaptcha.enterprise.execute(SITE_KEY, {
        action: pageAction,
      });
      clearGrecaptchaCache();
      window.dispatchEvent(
        new CustomEvent('UPPROJECT_CAPTCHA_RESULT', { detail: { requestId, token } }),
      );
    } catch (e) {
      window.dispatchEvent(
        new CustomEvent('UPPROJECT_CAPTCHA_RESULT', {
          detail: { requestId, error: e?.message || String(e) },
        }),
      );
    }
  });
})();
