import { describe, expect, it } from 'vitest';
import { needsContentReview, contentReviewMessage, assertContentReviewRetry } from '../../src/modules/workflow/lib/contentReview.js';
describe('content review routing', () => {
    it('recognizes structured moderation errors and legacy localized messages', () => {
        expect(needsContentReview({ errorText: '{"error":{"details":[{"reason":"PUBLIC_ERROR_SEXUAL"}]}}' })).toBe(true);
        expect(needsContentReview(new Error('Nội dung bị từ chối: Chứa yếu tố nhạy cảm/khiêu dâm.'))).toBe(true);
        expect(needsContentReview('Video được tạo chứa nội dung vi phạm chính sách an toàn')).toBe(true);
    });
    it('keeps network, rate limit and captcha failures separate', () => {
        for (const message of ['HTTP 429', 'fetch failed', 'PUBLIC_ERROR_HIGH_TRAFFIC', 'PUBLIC_ERROR_UNUSUAL_ACTIVITY', 'reCAPTCHA evaluation failed'])
            expect(needsContentReview(new Error(message))).toBe(false);
    });
    it('preserves original reason, adds review instructions only once and requires manual confirmation', () => {
        const error = contentReviewMessage('PUBLIC_ERROR_SEXUAL');
        expect(error).toContain('Không tự gửi lại');
        expect(contentReviewMessage(error)).toBe(error);
        expect(() => assertContentReviewRetry(error, false, false)).toThrow(/xác nhận/);
        expect(() => assertContentReviewRetry(error, true, true)).toThrow(/batch/);
        expect(() => assertContentReviewRetry(error, true, false)).not.toThrow();
        expect(() => assertContentReviewRetry('fetch failed', false, true)).not.toThrow();
    });
});
