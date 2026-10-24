import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMaseQArgs,
  detectImageKind,
  extractUploadedMediaId,
  toUploadError,
} from '../../src/services/veo3/flowUpload.js';
import { FlowRpcError } from '../../src/lib/flowBoq.js';
import {
  profileCaptchaGuard,
  MIN_RECAPTCHA_GAP_MS,
  MAX_RECAPTCHA_GAP_MS,
  nextRecaptchaGapMs,
  BATCH_RECAPTCHA_GAP_MS,
} from '../../src/lib/profileCaptchaGuard.js';
import {
  isDailyQuotaError,
  isRecaptcha403,
  isTrafficLimit429,
} from '../../src/modules/workflow/lib/captchaErrors.js';
import { verifyBase64AsImage } from '../../src/utils/imagePayload.js';

afterEach(() => {
  profileCaptchaGuard.reset();
  vi.useRealTimers();
});

describe('Veo3Studio 1.8.5 media-core sync', () => {
  it('builds the current maseQ upload contract and extracts the UUID', () => {
    const args = buildMaseQArgs({
      projectId: 'project-1',
      recaptchaToken: 'token-1',
      base64: 'AA==',
      mime: 'image/png',
      fileName: 'image.png',
    });

    expect(args[0][1]).toBe(22);
    expect(args[0][5]).toBe('project-1');
    expect(args[0][10]).toEqual(['token-1', 1]);
    expect(args[1]).toBe('AA==');
    expect(args[2]).toBe('image/png');
    expect(args[8]).toBe('image.png');
    expect(extractUploadedMediaId([['8f7ddcbc-d937-40f6-a8e2-372fd7865974']]))
      .toBe('8f7ddcbc-d937-40f6-a8e2-372fd7865974');
  });

  it('detects image bytes and preserves retry classification for upload errors', () => {
    expect(detectImageKind(Buffer.from('474946383961', 'hex'))).toEqual({
      mime: 'image/gif',
      ext: 'gif',
    });
    const denied = toUploadError(new FlowRpcError('maseQ', 'denied', 403));
    const limited = toUploadError(new FlowRpcError('maseQ', 'limited', 429));
    expect(denied.isRecaptchaFailure).toBe(true);
    expect(limited.isTransientTrafficLimit).toBe(true);
  });

  it('keeps daily quota, traffic limiting, and captcha rejection separate', () => {
    expect(isDailyQuotaError(new Error('PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED'))).toBe(true);
    expect(isTrafficLimit429(new Error('PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC'))).toBe(true);
    expect(isRecaptcha403(new Error('PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC'))).toBe(false);
    expect(isRecaptcha403(new Error('reCAPTCHA evaluation failed'))).toBe(true);
  });

  it('paces each profile and applies a cooldown after captcha rejection', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T00:00:00Z'));
    expect(profileCaptchaGuard.reserveSlot('p1')).toBe(0);
    expect(profileCaptchaGuard.reserveSlot('p1')).toBe(MIN_RECAPTCHA_GAP_MS);
    const outcome = profileCaptchaGuard.onRecaptcha403('p1');
    expect(outcome.waitMs).toBeGreaterThanOrEqual(15000);
    expect(profileCaptchaGuard.snapshot('p1').blockedForMs).toBeGreaterThanOrEqual(15000);
  });

  it('keeps future profile slots after a parallel job succeeds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T00:00:00Z'));
    expect(profileCaptchaGuard.reserveSlot('p1', 7000)).toBe(0);
    expect(profileCaptchaGuard.reserveSlot('p1', 7000)).toBe(7000);
    profileCaptchaGuard.onSuccess('p1');
    expect(profileCaptchaGuard.reserveSlot('p1', 7000)).toBe(14000);
  });

  it('uses a 7–10 second randomized image gap by default', () => {
    for (let i = 0; i < 20; i += 1) {
      const gap = nextRecaptchaGapMs('image');
      expect(gap).toBeGreaterThanOrEqual(MIN_RECAPTCHA_GAP_MS);
      expect(gap).toBeLessThanOrEqual(MAX_RECAPTCHA_GAP_MS);
    }
  });

  it('keeps the same lightweight auxiliary-operation gap as Veo3 Gen batches', () => {
    expect(BATCH_RECAPTCHA_GAP_MS).toBe(1000);
  });

  it('rejects echoed text as an image and accepts valid magic bytes', () => {
    expect(verifyBase64AsImage(Buffer.from('not an image').toString('base64'), { minBytes: 0 }))
      .toBeNull();
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)]);
    expect(verifyBase64AsImage(jpeg.toString('base64'), { minBytes: 0 })?.ext).toBe('jpg');
  });
});
