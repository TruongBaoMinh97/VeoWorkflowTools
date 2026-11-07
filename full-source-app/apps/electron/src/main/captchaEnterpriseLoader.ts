/** Load Google's own Enterprise SDK when the Flow landing page has not loaded it. */
export interface CaptchaPageEvaluator {
  evaluate<T>(pageFunction: (...args: any[]) => T | Promise<T>, ...args: any[]): Promise<T>;
}

export type EnterpriseLoadResult =
  | 'ready'
  | 'loading'
  | 'injected'
  | 'script-error'
  | 'wrong-origin';

export async function ensureFlowEnterpriseScript(
  page: CaptchaPageEvaluator,
  siteKey: string,
): Promise<EnterpriseLoadResult> {
  return page.evaluate((key: string): EnterpriseLoadResult => {
    if (location.origin !== 'https://flow.google.com')
      return 'wrong-origin';

    const root = window as typeof window & {
      grecaptcha?: { enterprise?: { execute?: unknown } };
      trustedTypes?: { createPolicy?: (name: string, rules: Record<string, (value: string) => string>) => { createScriptURL: (value: string) => string } };
      __veoRecaptchaNoncePatch?: boolean;
    };
    if (typeof root.grecaptcha?.enterprise?.execute === 'function')
      return 'ready';

    const existing = document.querySelector<HTMLScriptElement>('script[data-veo-recaptcha-loader]');
    if (existing)
      return existing.dataset.veoRecaptchaLoader === 'error' ? 'script-error' : 'loading';

    // Flow uses CSP nonces and Trusted Types. Reuse its nonce for Google's SDK
    // and the reCAPTCHA scripts the SDK adds. This stays within the Flow page.
    const donor = Array.from(document.querySelectorAll<HTMLScriptElement>('script')).find((script) => script.nonce);
    const nonce = donor?.nonce ?? '';
    const trustedTypes = root.trustedTypes;
    if (trustedTypes?.createPolicy) {
      try {
        trustedTypes.createPolicy('default', {
          createHTML: (value) => value,
          createScript: (value) => value,
          createScriptURL: (value) => value,
        });
      }
      catch {
        // The page may already own the default policy.
      }
      if (nonce && !root.__veoRecaptchaNoncePatch) {
        root.__veoRecaptchaNoncePatch = true;
        for (const method of ['appendChild', 'insertBefore'] as const) {
          const original = Node.prototype[method] as (...args: any[]) => any;
          (Node.prototype as any)[method] = function (node: Node, ...rest: unknown[]) {
            try {
              if (node instanceof HTMLScriptElement && !node.nonce &&
                  /\b(?:recaptcha|gstatic)\b/i.test(node.src))
                node.nonce = nonce;
            }
            catch { /* Let the browser handle the DOM operation. */ }
            return original.apply(this, [node, ...rest]);
          };
        }
      }
    }

    const url = `https://www.google.com/recaptcha/enterprise.js?render=${encodeURIComponent(key)}`;
    const script = document.createElement('script');
    script.dataset.veoRecaptchaLoader = 'loading';
    script.onerror = () => { script.dataset.veoRecaptchaLoader = 'error'; };
    script.onload = () => { script.dataset.veoRecaptchaLoader = 'loaded'; };
    if (nonce)
      script.nonce = nonce;
    let source: string = url;
    if (trustedTypes?.createPolicy) {
      try {
        source = trustedTypes.createPolicy('veo-workflow-recaptcha', {
          createScriptURL: (value) => value,
        }).createScriptURL(url);
      }
      catch {
        // The page's default policy, if present, will handle the URL.
      }
    }
    script.src = source;
    (document.head ?? document.documentElement).appendChild(script);
    return 'injected';
  }, siteKey);
}
