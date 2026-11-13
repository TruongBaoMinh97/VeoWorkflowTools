import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLOW_PRODUCT_SLOT, FLOW_RPC, FlowRpcError } from '../../src/lib/flowBoq.js';
import {
  buildGenerateImageArgs,
  classifyImageGenError,
  resolveAspectCode,
} from '../../src/services/veo3/flowImageGen.js';
import {
  VIDEO_SUBMIT_RPC,
  flowVideoModelKeyCandidates,
  videoAspectCode,
} from '../../src/services/veo3/flowVideoGen.js';
import { FlowAuthEndpointRetiredError } from '../../src/lib/cookieTokenService.js';

describe('Veo3Studio 1.8.9 Flow cookie-auth migration', () => {
  it('builds image generation for the cookie-authenticated Flow RPC', () => {
    const aspect = resolveAspectCode('IMAGE_ASPECT_RATIO_LANDSCAPE');
    const args = buildGenerateImageArgs({
      projectId: 'project-1',
      prompt: 'a blue dress',
      seed: 123,
      aspectCode: aspect.code,
      imageModelName: 'GEM_PIX_2',
      recaptchaToken: 'captcha-1',
      referenceMediaIds: ['media-1'],
    });

    expect(FLOW_RPC.generateImage).toBe('ogiZ0b');
    expect(FLOW_PRODUCT_SLOT).toBe(22);
    expect(args[3][5]).toBe('project-1');
    expect(args[3][10]).toEqual(['captcha-1', 1]);
    expect(args[1][0][2][0][0]).toBe('media-1');
  });

  it('maps video modes to Flow RPCs without requiring a bearer token', () => {
    expect(VIDEO_SUBMIT_RPC.t2v).toBe(FLOW_RPC.generateVideoText);
    expect(VIDEO_SUBMIT_RPC.i2v).toBe(FLOW_RPC.generateVideoStartImage);
    expect(videoAspectCode('VIDEO_ASPECT_RATIO_LANDSCAPE')).toBe(2);
    expect(flowVideoModelKeyCandidates({
      legacyKey: 'veo_3_1_t2v_fast_landscape',
      mode: 't2v',
      seconds: 8,
    })[0].key).toBe('veo_3_1_t2v_fast');

    const source = fs.readFileSync(
      new URL('../../src/services/veo3/veo3Service.js', import.meta.url),
      'utf8',
    );
    expect(source).toContain('submitVideoViaFlow');
    expect(source).toContain('FLOW_RPC.generateImage');
    expect(source).not.toContain('Access token is required for video generation');
    expect(source).not.toContain('Access token is required for image upsampling');
  });

  it('reports the retired Labs access-token endpoint as non-recoverable by re-login', () => {
    const error = new FlowAuthEndpointRetiredError();
    expect(error.code).toBe('FLOW_AUTH_RETIRED');
    expect(error.message).toContain('HTTP 410');
  });

  it('retries a bare Flow 403 while keeping explicit permission and verification rejections terminal', () => {
    const transient = classifyImageGenError(new FlowRpcError('ogiZ0b', 'Google từ chối, mã 7', 7));
    expect(transient.isRecaptchaFailure).toBe(true);
    expect(transient.isNonRetryable).not.toBe(true);

    const accessDenied = classifyImageGenError(new FlowRpcError('ogiZ0b', 'PUBLIC_ERROR_MODEL_ACCESS_DENIED', 403));
    expect(accessDenied.code).toBe('MODEL_ACCESS_DENIED');
    expect(accessDenied.isNonRetryable).toBe(true);

    const verify = classifyImageGenError(new FlowRpcError('ogiZ0b', 'reCAPTCHA evaluation failed', 403));
    expect(verify.code).toBe('FLOW_VERIFICATION_REQUIRED');
    expect(verify.isNonRetryable).toBe(true);
  });

  it('keeps Flow 429 traffic and quota evidence for the Gen retry policy', () => {
    const traffic = classifyImageGenError(new FlowRpcError('ogiZ0b', 'RESOURCE_EXHAUSTED', 8));
    expect(traffic.status).toBe(429);
    expect(traffic.isTransientTrafficLimit).toBe(true);

    const quota = classifyImageGenError(new FlowRpcError('ogiZ0b', 'PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED', 8));
    expect(quota.message).toContain('PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED');
    expect(quota.isNonRetryable).toBe(true);
    expect(quota.isTransientTrafficLimit).not.toBe(true);
  });
});
