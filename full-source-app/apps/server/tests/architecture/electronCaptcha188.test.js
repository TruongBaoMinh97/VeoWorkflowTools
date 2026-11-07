import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tryMintCaptchaFromFrames } from '../../../electron/src/main/captchaFrameMint.ts';
import { ensureFlowEnterpriseScript } from '../../../electron/src/main/captchaEnterpriseLoader.ts';

function createFrame(url, results) {
  return {
    url: () => url,
    evaluate: vi.fn(async () => {
      const next = results.shift();
      if (next instanceof Error)
        throw next;
      return next;
    }),
  };
}

describe('Veo3Studio 1.8.8 Electron CAPTCHA frame integration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the frame scanner on the page-provided execute function', () => {
    const managerPath = fileURLToPath(new URL(
      '../../../electron/src/main/captchaBrowserManager.ts',
      import.meta.url,
    ));
    const framePath = fileURLToPath(new URL(
      '../../../electron/src/main/captchaFrameMint.ts',
      import.meta.url,
    ));
    const source = `${fs.readFileSync(managerPath, 'utf8')}\n${fs.readFileSync(framePath, 'utf8')}`;

    expect(source).not.toContain("createElement('script')");
    expect(source).not.toContain('enterprise.js?render=');
  });

  it('loads the configured Google Enterprise SDK once when Flow has no execute function', async () => {
    const scripts = [];
    class FakeNode {
      appendChild(node) { scripts.push(node); return node; }
      insertBefore(node) { scripts.push(node); return node; }
    }
    class FakeScript extends FakeNode {
      constructor() {
        super();
        this.nonce = '';
        this.dataset = {};
        this.src = '';
      }
    }
    const donor = new FakeScript();
    donor.nonce = 'flow-nonce';
    scripts.push(donor);
    vi.stubGlobal('Node', FakeNode);
    vi.stubGlobal('HTMLScriptElement', FakeScript);
    vi.stubGlobal('location', { origin: 'https://flow.google.com' });
    vi.stubGlobal('window', {
      trustedTypes: { createPolicy: (_name, rules) => ({ createScriptURL: rules.createScriptURL ?? ((value) => value) }) },
    });
    vi.stubGlobal('document', {
      querySelector: () => scripts.find((script) => script.dataset.veoRecaptchaLoader),
      querySelectorAll: () => scripts,
      createElement: () => new FakeScript(),
      head: new FakeNode(),
    });
    const page = { evaluate: async (callback, ...args) => callback(...args) };

    expect(await ensureFlowEnterpriseScript(page, 'fixed-key')).toBe('injected');
    expect(scripts).toHaveLength(2);
    expect(scripts[1].src).toBe('https://www.google.com/recaptcha/enterprise.js?render=fixed-key');
    expect(scripts[1].nonce).toBe('flow-nonce');
    expect(await ensureFlowEnterpriseScript(page, 'fixed-key')).toBe('loading');
    expect(scripts).toHaveLength(2);
  });

  it('does not load the SDK after Flow redirects to another origin', async () => {
    vi.stubGlobal('location', { origin: 'https://accounts.google.com' });
    const page = { evaluate: async (callback, ...args) => callback(...args) };
    await expect(ensureFlowEnterpriseScript(page, 'fixed-key')).resolves.toBe('wrong-origin');
  });

  it('uses the Flow-provided execute function from the first viable frame', async () => {
    const missing = createFrame('https://flow.google.com/', [false]);
    const token = `token-${'x'.repeat(32)}`;
    const viable = createFrame('https://www.google.com/recaptcha/enterprise/anchor', [
      true,
      undefined,
      token,
    ]);

    await expect(tryMintCaptchaFromFrames(
      [missing, viable],
      'site-key',
      'IMAGE_GENERATION',
    )).resolves.toEqual({
      token,
      frameUrl: 'https://www.google.com/recaptcha/enterprise/anchor',
    });

    expect(missing.evaluate).toHaveBeenCalledTimes(1);
    expect(viable.evaluate).toHaveBeenCalledTimes(3);
    expect(viable.evaluate.mock.calls[2].slice(1)).toEqual([
      'site-key',
      'IMAGE_GENERATION',
    ]);
  });

  it('continues scanning when one frame returns no usable token', async () => {
    const empty = createFrame('https://flow.google.com/empty', [true, undefined, null]);
    const token = `token-${'y'.repeat(32)}`;
    const next = createFrame('https://flow.google.com/ready', [true, undefined, token]);

    await expect(tryMintCaptchaFromFrames(
      [empty, next],
      'site-key',
      'VIDEO_GENERATION',
    )).resolves.toMatchObject({ token });
  });
});
