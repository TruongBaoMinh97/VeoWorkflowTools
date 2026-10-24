import { describe, expect, it } from 'vitest';
import {
    isVerificationRejected,
    verificationRequiredError,
    VERIFICATION_REQUIRED_CODE,
    VERIFICATION_REQUIRED_MESSAGE,
} from '../../src/services/veo3/verificationFailure.js';
import {
    parseVeo3Error,
    getFailedJobDisplayMessage,
    isNonRetryableError,
    isRetryableError,
} from '../../src/services/veo3/veo3ErrorHandler.js';

const body = (reason, code = 403, message = 'reCAPTCHA evaluation failed') => JSON.stringify({
    error: { code, message, details: [{ reason }] },
});

describe('Google Flow verification rejection', () => {
    it.each([
        body('PUBLIC_ERROR_UNUSUAL_ACTIVITY'),
        body('PUBLIC_ERROR_UNUSUAL_ACTIVITY', 403, 'Forbidden'),
        'reCAPTCHA evaluation failed',
        'PUBLIC_ERROR_UNUSUAL_ACTIVITY',
        Object.assign(new Error('localized message'), { errorText: body('PUBLIC_ERROR_UNUSUAL_ACTIVITY'), response: { status: 403 } }),
    ])('reports user verification instead of a content-policy error', error => {
        expect(isVerificationRejected(error)).toBe(true);
        const text = typeof error === 'string' ? error : error.errorText;
        expect(parseVeo3Error(text)).toBe(VERIFICATION_REQUIRED_MESSAGE);
        expect(getFailedJobDisplayMessage(text)).toBe(VERIFICATION_REQUIRED_MESSAGE);
        expect(isRetryableError(text)).toBe(false);
        expect(isNonRetryableError(text)).toBe(true);
    });

    it.each([
        body('PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC', 429),
        body('PUBLIC_ERROR_SOMETHING_WENT_WRONG', 429),
        body('PUBLIC_ERROR_USER_QUOTA_REACHED'),
        body('PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED'),
        body('PUBLIC_ERROR_MODEL_ACCESS_DENIED', 403, 'Access denied'),
        body('PUBLIC_ERROR_SEXUAL', 400, 'Unsafe content'),
        'reCAPTCHA token request timeout',
        'grecaptcha not available',
        'Browser destroyed before submit',
        '503 Service unavailable',
    ])('keeps traffic, quota, auth, content, and browser failures separate', error => {
        expect(isVerificationRejected(error)).toBe(false);
    });

    it('retains 429 retry and content-policy semantics', () => {
        expect(isRetryableError(body('PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC', 429))).toBe(true);
        expect(parseVeo3Error(body('PUBLIC_ERROR_SEXUAL', 400, 'Unsafe content'))).toContain('nhạy cảm');
    });

    it('preserves provider evidence and survives wrapping without allowing an automatic retry', () => {
        const original = Object.assign(new Error('original'), {
            response: { status: 403 }, errorText: body('PUBLIC_ERROR_UNUSUAL_ACTIVITY'),
        });
        const normalized = verificationRequiredError(original);
        expect(normalized).toMatchObject({ code: VERIFICATION_REQUIRED_CODE, nonRetryable: true, isNonRetryable: true });
        expect(normalized.response).toBe(original.response);
        expect(normalized.errorText).toBe(original.errorText);
        expect(isVerificationRejected(new Error(normalized.message))).toBe(true);
        expect(getFailedJobDisplayMessage(normalized.message)).toBe(VERIFICATION_REQUIRED_MESSAGE);
    });
});
