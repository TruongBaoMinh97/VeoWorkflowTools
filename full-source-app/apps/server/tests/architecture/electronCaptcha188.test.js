import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { tryMintCaptchaFromFrames } from '../../../electron/src/main/captchaFrameMint.ts';

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
  it('does not patch or suppress the page anti-abuse runtime', () => {
    const managerPath = fileURLToPath(new URL(
      '../../../electron/src/main/captchaBrowserManager.ts',
      import.meta.url,
    ));
    const framePath = fileURLToPath(new URL(
      '../../../electron/src/main/captchaFrameMint.ts',
      import.meta.url,
    ));
    const source = `${fs.readFileSync(managerPath, 'utf8')}\n${fs.readFileSync(framePath, 'utf8')}`;

    expect(source).not.toContain('evaluateOnNewDocument');
    expect(source).not.toContain('extension_hijack_detected');
    expect(source).not.toContain("createElement('script')");
    expect(source).not.toContain('enterprise.js?render=');
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
