export interface CaptchaFrameLike {
  url(): string;
  evaluate<T>(pageFunction: (...args: any[]) => T | Promise<T>, ...args: any[]): Promise<T>;
}

export interface CaptchaFrameMintResult {
  token: string;
  frameUrl: string;
}

type RecaptchaGlobal = typeof globalThis & {
  __realExecute?: (siteKey: string, options: { action: string }) => Promise<string>;
  grecaptcha?: {
    enterprise?: {
      execute?: (siteKey: string, options: { action: string }) => Promise<string>;
    };
  };
};

/**
 * Use only the reCAPTCHA Enterprise API already installed by the Flow page.
 *
 * This intentionally does not inject enterprise.js, patch browser globals, or
 * suppress Google's integrity/anti-abuse checks. It simply locates the frame
 * that owns the page-provided execute function and asks that frame to run it.
 */
export async function tryMintCaptchaFromFrames(
  frames: CaptchaFrameLike[],
  siteKey: string,
  action: string,
): Promise<CaptchaFrameMintResult | null> {
  for (const frame of frames) {
    try {
      const hasExecute = await frame
        .evaluate(() => {
          const root = globalThis as RecaptchaGlobal;
          return (
            typeof root.__realExecute === 'function' ||
            typeof root.grecaptcha?.enterprise?.execute === 'function'
          );
        })
        .catch(() => false);

      if (!hasExecute) {
        continue;
      }

      await frame
        .evaluate(() => {
          try {
            Object.keys(localStorage)
              .filter((key) => key.startsWith('_grecaptcha'))
              .forEach((key) => localStorage.removeItem(key));
          }
          catch {
            // A sandboxed/cross-origin frame may deny localStorage. Minting can
            // still proceed through the page-owned execute function.
          }
        })
        .catch(() => undefined);

      const token = await frame
        .evaluate(async (resolvedSiteKey: string, resolvedAction: string) => {
          const root = globalThis as RecaptchaGlobal;
          if (typeof root.__realExecute === 'function') {
            return await root.__realExecute(resolvedSiteKey, { action: resolvedAction });
          }
          const execute = root.grecaptcha?.enterprise?.execute;
          if (typeof execute !== 'function') {
            return null;
          }
          return execute.call(root.grecaptcha?.enterprise, resolvedSiteKey, {
            action: resolvedAction,
          });
        }, siteKey, action)
        .catch(() => null);

      if (typeof token === 'string' && token.length > 20) {
        return { token, frameUrl: frame.url() };
      }
    }
    catch {
      // Bỏ qua nếu frame bị unmount/detach giữa chừng
    }
  }

  return null;
}
