/**
 * Phân loại lỗi captcha/quota của Google Flow.
 *
 * Tách khỏi `workflow.engine.ts` để test được mà không kéo theo prisma, ffmpeg,
 * python và cả đồ thị mạng — cùng lý do `extractUUIDFromMediaId` /
 * `normalizeReferenceImage` đã được tách khỏi `veo3Service`.
 */
/**
 * Quota ngày thật của tài khoản (không phải điểm captcha). Chỉ node vừa lỗi bị
 * dừng — KHÔNG khoá profile. Dùng đúng sentinel của gen-normal để renderer dịch
 * chung một câu cho cả hai luồng.
 */
export const DAILY_QUOTA_SENTINEL = 'DAILY_QUOTA_REACHED:Profile đã chạm quota ngày của Veo3 cho model này. ' +
    'Chỉ lượt gen này bị dừng — các dòng khác vẫn chạy tiếp.';
export const CAPTCHA_BURNED_SENTINEL = 'CAPTCHA_PROFILE_BURNED:Profile liên tục bị Google chặn reCAPTCHA. ' +
    'Đã dừng để không làm nặng thêm — hãy đổi profile hoặc đăng nhập lại rồi chạy tiếp.';
function haystackOf(err) {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    const errorText = err?.errorText;
    return `${msg}\n${typeof errorText === 'string' ? errorText : ''}`;
}
/** Quota ngày thật (reset theo ngày / cần nâng gói) — thử lại trong phiên là vô ích. */
export function isDailyQuotaError(err) {
    const haystack = haystackOf(err);
    return (haystack.includes('PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED') ||
        haystack.includes('PUBLIC_ERROR_USER_QUOTA_REACHED'));
}
/**
 * 429 trần tốc độ tạm thời (TOO_MUCH_TRAFFIC / RESOURCE_EXHAUSTED) — tự khỏi sau
 * vài phút nghỉ. KHÔNG phải quota ngày, KHÔNG phải 403 điểm số.
 *
 * ⚠️ PHẢI kiểm TRƯỚC `isRecaptcha403` cho chắc: `..._UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC`
 * chứa `..._UNUSUAL_ACTIVITY` làm chuỗi con (isRecaptcha403 đã tự loại trừ, nhưng
 * thứ tự đúng giữ log rõ nghĩa).
 */
export function isTrafficLimit429(err) {
    if (err?.isTransientTrafficLimit)
        return true;
    if (isDailyQuotaError(err))
        return false;
    const haystack = haystackOf(err);
    return (haystack.includes('PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC') ||
        haystack.includes('RESOURCE_EXHAUSTED'));
}
/**
 * Nhận diện 403 reCAPTCHA. Sao theo gen-normal (`genNormalQueueManager.ts:4032`),
 * kể cả việc LOẠI TRỪ lỗi đua trình duyệt — những lỗi đó trông giống hỏng captcha
 * nhưng reset điểm số không chữa được, chỉ tổ churn tab Chrome.
 */
export function isRecaptcha403(err) {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    if (msg.includes('Browser destroyed before') || msg.includes('ERR_FAILED (-2)')) {
        return false;
    }
    if (err?.isRecaptchaFailure)
        return true;
    const haystack = haystackOf(err);
    return (/PUBLIC_ERROR_UNUSUAL_ACTIVITY(?!_TOO_MUCH_TRAFFIC)/.test(haystack) ||
        haystack.includes('reCAPTCHA evaluation failed') ||
        haystack.includes('Xác thực reCAPTCHA thất bại') ||
        haystack.includes('Failed to obtain reCAPTCHA') ||
        haystack.includes('grecaptcha not available') ||
        haystack.includes('reCAPTCHA token request timeout') ||
        haystack.includes('reCAPTCHA token timeout'));
}
