import { isVerificationRejected, VERIFICATION_REQUIRED_MESSAGE } from './verificationFailure.js';
/**
 * Veo3 Error Handler
 * Parses Veo3 API error responses and returns user-friendly error messages
 */
/**
 * Extract a compact log shape from a thrown Veo3 error: `{ code, status, reason }`.
 * Designed to keep noisy reCAPTCHA 403 dumps short — callers should prefer
 * this over passing the raw error object to `logger.error(...)`, which would
 * serialize the full response headers, body, and stack trace.
 */
export function briefVeo3Error(error) {
    const e = error;
    const httpCode = typeof e?.response?.status === 'number' ? e.response.status : undefined;
    const errorText = typeof e?.errorText === 'string' ? e.errorText : undefined;
    let status;
    let reason;
    let bodyCode;
    if (errorText) {
        try {
            const parsed = JSON.parse(errorText);
            bodyCode = parsed.error?.code;
            status = parsed.error?.status;
            reason = parsed.error?.details?.find((d) => d?.reason)?.reason;
        }
        catch {
            /* errorText not JSON — leave fields undefined */
        }
    }
    return {
        code: bodyCode ?? httpCode,
        status,
        reason,
    };
}
/**
 * Parse error response from Veo3 API and return user-friendly message
 */
export function parseVeo3Error(errorText, defaultMessage) {
    if (!errorText) {
        return defaultMessage || 'Đã xảy ra lỗi không xác định';
    }
    if (isVerificationRejected(errorText))
        return VERIFICATION_REQUIRED_MESSAGE;
    let jsonStr = errorText;
    const jsonMatch = errorText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        jsonStr = jsonMatch[0];
    }
    try {
        const errorJson = JSON.parse(jsonStr);
        const error = errorJson.error;
        if (!error) {
            return defaultMessage || errorText;
        }
        // Check for specific error reasons in details
        if (error.details && Array.isArray(error.details)) {
            for (const detail of error.details) {
                const reason = detail.reason;
                // Handle content policy violations - Xử lý các lỗi vi phạm chính sách nội dung
                if (reason === 'PUBLIC_ERROR_MINOR_UPLOAD') {
                    return 'Ảnh/video của bạn chứa nội dung không phù hợp với chính sách của Veo3 (ví dụ: hình ảnh trẻ em hoặc nội dung không được phép). Vui lòng sử dụng ảnh/video khác.';
                }
                // Handle audio filtering error (prompt contains sensitive audio content)
                if (reason === 'PUBLIC_ERROR_AUDIO_FILTERED') {
                    return 'Prompt của bạn chứa nội dung audio nhạy cảm hoặc không được phép. Vui lòng cập nhật lại prompt và thử lại.';
                }
                // Handle unsafe generation error (content policy violation during generation)
                if (reason === 'PUBLIC_ERROR_UNSAFE_GENERATION') {
                    return 'Video được tạo chứa nội dung vi phạm chính sách an toàn (nội dung bạo lực, nhạy cảm, hoặc không phù hợp). Vui lòng chỉnh sửa lại prompt và ảnh tham chiếu.';
                }
                // Handle sexual/adult content error
                if (reason === 'PUBLIC_ERROR_SEXUAL') {
                    return 'Nội dung bị từ chối: Chứa yếu tố nhạy cảm/khiêu dâm. Vui lòng chỉnh sửa prompt và ảnh tham chiếu.';
                }
                // Handle violence content error
                if (reason === 'PUBLIC_ERROR_VIOLENCE') {
                    return 'Nội dung bị từ chối: Chứa yếu tố bạo lực. Vui lòng chỉnh sửa prompt và ảnh tham chiếu.';
                }
                // Handle hate speech content error
                if (reason === 'PUBLIC_ERROR_HATE') {
                    return 'Nội dung bị từ chối: Chứa ngôn ngữ thù địch hoặc phân biệt. Vui lòng chỉnh sửa prompt.';
                }
                // Handle harassment content error
                if (reason === 'PUBLIC_ERROR_HARASSMENT') {
                    return 'Nội dung bị từ chối: Chứa yếu tố quấy rối. Vui lòng chỉnh sửa prompt.';
                }
                // Handle dangerous content error
                if (reason === 'PUBLIC_ERROR_DANGEROUS') {
                    return 'Nội dung bị từ chối: Chứa nội dung nguy hiểm. Vui lòng chỉnh sửa prompt.';
                }
                // Handle copyright/IP related errors
                if (reason === 'PUBLIC_ERROR_IP_VIOLATION' || reason === 'PUBLIC_ERROR_COPYRIGHT') {
                    return 'Nội dung bị từ chối: Vi phạm bản quyền hoặc sở hữu trí tuệ. Vui lòng sử dụng nội dung gốc.';
                }
                // Handle celebrity/public figure errors
                if (reason === 'PUBLIC_ERROR_CELEBRITY' || reason === 'PUBLIC_ERROR_PUBLIC_FIGURE') {
                    return 'Nội dung bị từ chối: Không được phép tạo video với người nổi tiếng/nhân vật công chúng.';
                }
                // Handle generation already in progress (409 error)
                // This is NOT a policy violation - it means the generation is still running from a previous request
                if (reason === 'PUBLIC_ERROR_GENERATION_ALREADY_IN_PROGRESS') {
                    return 'Video đang được xử lý. Vui lòng chờ hệ thống kiểm tra trạng thái.';
                }
                // Handle model access denied - account doesn't have permission for this model
                if (reason === 'PUBLIC_ERROR_MODEL_ACCESS_DENIED') {
                    return 'Tài khoản không có quyền truy cập model này. Vui lòng kiểm tra gói subscription hoặc đổi tài khoản khác.';
                }
                // Handle quota/traffic errors (MUST be before generic PUBLIC_ERROR_ handler)
                if (reason === 'PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED_UPGRADEABLE') {
                    return 'Tài khoản Ultra đã hết hạn hoặc hết quota. Vui lòng thay tài khoản mới.';
                }
                if (reason === 'PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED') {
                    return 'Đã đạt giới hạn quota hàng ngày cho model này. Vui lòng thử lại sau 24 giờ.';
                }
                // 429 TOO_MUCH_TRAFFIC là trần tốc độ TẠM THỜI của tài khoản (tự khỏi sau vài
                // phút backoff) — KHÔNG phải quota ngày. Không gắn prefix DAILY_QUOTA_REACHED:
                // để queue manager đi nhánh rate-limit (delay + retry) thay vì huỷ cả profile.
                // MUST be before generic PUBLIC_ERROR_ handler.
                if (reason === 'PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC') {
                    return 'Google đang giới hạn tốc độ tài khoản (429 PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC). Hệ thống sẽ tự thử lại sau vài phút.';
                }
                if (reason === 'PUBLIC_ERROR_HIGH_TRAFFIC') {
                    return 'Hệ thống đang quá tải. Vui lòng thử lại sau vài phút.';
                }
                if (reason === 'PUBLIC_ERROR_USER_REQUESTS_THROTTLED') {
                    return 'Bạn đang gửi quá nhiều yêu cầu. Vui lòng chờ một chút trước khi thử lại.';
                }
                // Handle reCAPTCHA evaluation failed (usually temporary, can retry)
                // MUST be before generic PUBLIC_ERROR_ handler
                if (reason === 'PUBLIC_ERROR_SOMETHING_WENT_WRONG') {
                    // Check if error message mentions reCAPTCHA
                    if (error.message && error.message.includes('reCAPTCHA')) {
                        return 'Xác thực reCAPTCHA thất bại. Hệ thống sẽ tự động thử lại sau vài phút.';
                    }
                    return 'Đã xảy ra lỗi không xác định. Hệ thống sẽ tự động thử lại.';
                }
                // Account-level quota / credit exhaustion. Google returns this SINGLE reason
                // for both "out of quota" AND "out of credit when using a credit-gated model".
                // MUST be before the generic catch-all (else mislabeled as a policy violation).
                if (reason === 'PUBLIC_ERROR_USER_QUOTA_REACHED') {
                    return 'Tài khoản đã hết quota/credit (hết credit khi dùng model cần credit, hoặc vượt quota). Đổi tài khoản khác hoặc nạp thêm credit (PUBLIC_ERROR_USER_QUOTA_REACHED).';
                }
                // Prominent-people filter: the reference/generated media contains a famous
                // person / public figure and Google's automated "prominent people" scan
                // blocked it. Distinct from CELEBRITY/PUBLIC_FIGURE (persona restriction).
                if (reason === 'PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED') {
                    return 'Nội dung bị từ chối: ảnh/video tham chiếu hoặc video tạo ra chứa người nổi tiếng/nhân vật công chúng — Google chặn qua bộ lọc người nổi bật. Hãy đổi ảnh tham chiếu hoặc thay đổi nhân vật trong prompt.';
                }
                // Handle generic PUBLIC_ERROR that we haven't specifically handled (MUST be last)
                if (reason && reason.startsWith('PUBLIC_ERROR_')) {
                    return `Nội dung bị từ chối do vi phạm chính sách (${reason}). Vui lòng chỉnh sửa prompt và ảnh tham chiếu.`;
                }
            }
        }
        // Status-level quota fallback: RESOURCE_EXHAUSTED without a known reason
        // (e.g. an unmapped credit/quota variant, or an empty details array).
        if (error.status === 'RESOURCE_EXHAUSTED') {
            return 'Tài khoản đã hết quota/credit hoặc vượt giới hạn rate limit (RESOURCE_EXHAUSTED). Vui lòng thử lại sau hoặc đổi tài khoản.';
        }
        // Return the error message from API if available
        if (error.message) {
            // If it's a generic "Request contains an invalid argument" and we have details,
            // we've already handled specific reasons above, so return a generic message
            if (error.message.includes('Request contains an invalid argument')) {
                return 'Yêu cầu không hợp lệ. Vui lòng kiểm tra lại dữ liệu đầu vào.';
            }
            return error.message;
        }
        // Fallback to status or default message
        if (error.status) {
            return `Lỗi: ${error.status}`;
        }
        return defaultMessage || errorText;
    }
    catch (parseError) {
        // If errorText is not JSON, return it as-is or use default message
        return defaultMessage || errorText;
    }
}
/**
 * Extract error reason from Veo3 error response
 */
export function getVeo3ErrorReason(errorText) {
    if (!errorText) {
        return null;
    }
    try {
        const errorJson = JSON.parse(errorText);
        const error = errorJson.error;
        if (error?.details && Array.isArray(error.details)) {
            for (const detail of error.details) {
                if (detail.reason) {
                    return detail.reason;
                }
            }
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * Check if error is a content policy violation
 */
export function isContentPolicyError(errorText) {
    const reason = getVeo3ErrorReason(errorText);
    return reason === 'PUBLIC_ERROR_MINOR_UPLOAD';
}
/**
 * Check if error is "generation already in progress" (409 ALREADY_EXISTS)
 * This happens when server restarts and tries to re-submit a job that's still running
 * Should NOT retry - just wait for status polling to pick up the result
 */
export function isAlreadyInProgressError(errorText) {
    if (!errorText)
        return false;
    const reason = getVeo3ErrorReason(errorText);
    if (reason === 'PUBLIC_ERROR_GENERATION_ALREADY_IN_PROGRESS') {
        return true;
    }
    // Also check for raw text pattern
    if (errorText.includes('PUBLIC_ERROR_GENERATION_ALREADY_IN_PROGRESS') ||
        errorText.includes('ALREADY_EXISTS')) {
        return true;
    }
    return false;
}
/**
 * Check if error is reCAPTCHA evaluation failure
 * These are different from auth errors - they mean reCAPTCHA token was rejected by Google
 * Usually retryable with longer delay
 */
export function isRecaptchaEvaluationFailure(errorText) {
    if (!errorText)
        return false;
    if (isVerificationRejected(errorText))
        return true;
    try {
        const errorJson = JSON.parse(errorText);
        const error = errorJson.error;
        if (!error)
            return false;
        // Google trả 429 TOO_MUCH_TRAFFIC cũng kèm message "reCAPTCHA evaluation failed"
        // — đó là trần tốc độ, không phải token bị từ chối; để nhánh rate-limit xử lý.
        if (isTransientTrafficLimit(errorText))
            return false;
        // Check for reCAPTCHA evaluation failed in message
        if (error.message && error.message.includes('reCAPTCHA evaluation failed')) {
            return true;
        }
        // Check details for PUBLIC_ERROR_SOMETHING_WENT_WRONG with reCAPTCHA context
        if (error.details && Array.isArray(error.details)) {
            for (const detail of error.details) {
                if (detail.reason === 'PUBLIC_ERROR_SOMETHING_WENT_WRONG' &&
                    error.message && error.message.includes('reCAPTCHA')) {
                    return true;
                }
            }
        }
        return false;
    }
    catch {
        return false;
    }
}
/**
 * Check if error is retryable (rate limit, reCAPTCHA, 429, 403)
 * Default: NOT retryable - only retry if clear rate limit/reCAPTCHA signals
 * This prevents infinite retry loops for generic generation failures
 */
export function isRetryableError(errorText) {
    if (!errorText) {
        return false; // Unknown error = not retryable
    }
    if (isVerificationRejected(errorText))
        return false;
    const lowerError = errorText.toLowerCase();
    // HTTP status codes that indicate rate limiting
    if (lowerError.includes('429') ||
        lowerError.includes('rate limit') ||
        lowerError.includes('too many requests') ||
        lowerError.includes('quota exceeded')) {
        return true;
    }
    // 403 with reCAPTCHA context
    if (lowerError.includes('403') &&
        (lowerError.includes('recaptcha') || lowerError.includes('forbidden'))) {
        return true;
    }
    // reCAPTCHA evaluation failures (temporary, can retry)
    // Both English and Vietnamese messages
    if (lowerError.includes('recaptcha evaluation failed') ||
        lowerError.includes('recaptcha') && lowerError.includes('failed') ||
        lowerError.includes('xác thực recaptcha thất bại') ||
        lowerError.includes('recaptcha thất bại') ||
        errorText.includes('Xác thực reCAPTCHA thất bại')) {
        return true;
    }
    // 503 Service Unavailable - Google server temporarily down, MUST retry
    if (lowerError.includes('503') ||
        lowerError.includes('service unavailable') ||
        lowerError.includes('unavailable') ||
        errorText.includes('UNAVAILABLE')) {
        return true;
    }
    // 500 Internal Server Error - Google server error, MUST retry
    if (lowerError.includes('500') ||
        lowerError.includes('internal server error') ||
        lowerError.includes('internal error')) {
        return true;
    }
    // PUBLIC_ERROR_* that are explicitly retryable
    // NOTE: PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED is NOT retryable - account needs to be changed
    const retryablePublicErrors = [
        'PUBLIC_ERROR_HIGH_TRAFFIC',
        'PUBLIC_ERROR_USER_REQUESTS_THROTTLED',
        'PUBLIC_ERROR_SOMETHING_WENT_WRONG' // Often temporary issues
    ];
    for (const pattern of retryablePublicErrors) {
        if (errorText.includes(pattern)) {
            return true;
        }
    }
    // Proxy/network errors are retryable
    if (lowerError.includes('proxy') ||
        lowerError.includes('econnrefused') ||
        lowerError.includes('network') && lowerError.includes('error') ||
        lowerError.includes('timeout') ||
        lowerError.includes('etimedout')) {
        return true;
    }
    // Default: NOT retryable
    // This prevents infinite retry for generic "Video generation failed" errors
    return false;
}
/**
 * Check if error should DEFINITELY NOT be retried (content policy violations, etc.)
 */
export function isNonRetryableError(errorText) {
    if (!errorText)
        return true;
    if (isVerificationRejected(errorText))
        return true;
    const lowerError = errorText.toLowerCase();
    // Content policy and safety errors - NEVER RETRY
    // ⚠️ CRITICAL: Patterns phải SPECIFIC, không quá rộng.
    // "vi phạm chính sách" bị bỏ vì match cả 403 reCAPTCHA (retryable) → false positive.
    // Dùng error codes cụ thể (PUBLIC_ERROR_*) + Vietnamese patterns chỉ match 400 errors.
    const nonRetryablePatterns = [
        // English error codes (từ Google API response.details.reason)
        'PUBLIC_ERROR_MINOR_UPLOAD',
        'PUBLIC_ERROR_AUDIO_FILTERED',
        'PUBLIC_ERROR_UNSAFE_GENERATION',
        'PUBLIC_ERROR_SEXUAL',
        'PUBLIC_ERROR_VIOLENCE',
        'PUBLIC_ERROR_HATE',
        'PUBLIC_ERROR_HARASSMENT',
        'PUBLIC_ERROR_DANGEROUS',
        'PUBLIC_ERROR_IP_VIOLATION',
        'PUBLIC_ERROR_COPYRIGHT',
        'PUBLIC_ERROR_CELEBRITY',
        'PUBLIC_ERROR_PUBLIC_FIGURE',
        'PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED',
        // Account-tier model access — profile chưa upgrade gói → retry vô ích.
        // 403 with this specific reason is permanent until billing change.
        // Plain `PERMISSION_DENIED` is too broad (also matches transient
        // 403 reCAPTCHA which IS retryable), stick to the specific reason.
        'PUBLIC_ERROR_MODEL_ACCESS_DENIED',
        'INVALID_ARGUMENT',
        'Request contains an invalid argument',
        'content policy',
        'policy violation',
        // Vietnamese — CHỈ patterns đặc thù cho 400 (content reject), KHÔNG match 403 reCAPTCHA
        'Mã 400', // chỉ 400, không match 403
        'Prompt bị từ chối (Mã 400)', // full prefix bao gồm mã lỗi
        'Vui lòng sửa prompt', // chỉ xuất hiện trong 400 content message
        // Cookie/auth errors
        'không thể refresh từ cookies',
        'cookies đã hết hạn',
        'Vui lòng cập nhật cookies',
        // Daily quota — terminal, never retry. (429 TOO_MUCH_TRAFFIC / RESOURCE_EXHAUSTED
        // cố ý KHÔNG nằm đây: đó là trần tốc độ tạm thời, xử lý bằng delay + retry.)
        'PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED',
        // Account quota/credit exhausted — retrying in-run is pointless (won't clear in seconds).
        'PUBLIC_ERROR_USER_QUOTA_REACHED',
    ];
    for (const pattern of nonRetryablePatterns) {
        if (errorText.includes(pattern) || lowerError.includes(pattern.toLowerCase())) {
            return true;
        }
    }
    // If it's explicitly retryable, then it's NOT non-retryable
    if (isRetryableError(errorText)) {
        return false;
    }
    // Default: unknown/generic errors are NOT non-retryable (allow retry up to MAX_GEN_RETRIES)
    // Only explicitly matched patterns above are truly non-retryable
    return false;
}
function errorHaystack(errorText, errorObj) {
    const parts = [errorText, errorObj?.message, errorObj?.errorText];
    return parts.filter((p) => typeof p === 'string' && p.length > 0).join('\n');
}
/**
 * Quota THẬT của tài khoản — không tự khỏi trong phiên chạy (reset theo ngày
 * hoặc cần nâng gói). Chỉ nhóm này mới được phép dừng gen của cả profile.
 *
 * ⚠️ KHÔNG gộp 429 TOO_MUCH_TRAFFIC / RESOURCE_EXHAUSTED vào đây — đó là trần
 * tốc độ tạm thời (xem `isTransientTrafficLimit`). Gộp nhầm từng khiến profile bị
 * báo "hết quota ngày" và huỷ cả job đang chạy/upscale/tải về.
 */
export function isHardQuotaExhausted(errorText, errorObj) {
    const text = errorHaystack(errorText, errorObj);
    if (!text)
        return false;
    return (text.includes('PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED') || // gồm cả _UPGRADEABLE
        text.includes('PUBLIC_ERROR_USER_QUOTA_REACHED') ||
        text.includes('DAILY_QUOTA_REACHED:') ||
        text.includes('QUOTA_UPGRADEABLE:'));
}
/**
 * Trần tốc độ tạm thời phía Google (HTTP 429) — tự khỏi sau vài phút nghỉ.
 * Xử lý bằng delay per-profile + retry có giới hạn, KHÔNG dừng profile.
 */
export function isTransientTrafficLimit(errorText, errorObj) {
    if (errorObj?.isTransientTrafficLimit === true)
        return true;
    const text = errorHaystack(errorText, errorObj);
    if (!text || isHardQuotaExhausted(text))
        return false;
    const lower = text.toLowerCase();
    return (text.includes('PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC') ||
        text.includes('RESOURCE_EXHAUSTED')) || (lower.includes('429') && lower.includes('unusual_activity'));
}
/**
 * Get user-friendly error message for failed job
 * Returns Vietnamese message that explains the error and suggests action
 */
export function getFailedJobDisplayMessage(errorText) {
    if (!errorText) {
        return 'Video generation thất bại. Vui lòng kiểm tra prompt và ảnh, sau đó thử gen lại.';
    }
    if (isVerificationRejected(errorText))
        return VERIFICATION_REQUIRED_MESSAGE;
    // Try to parse and get a proper message
    const parsedMessage = parseVeo3Error(errorText);
    // If we got a meaningful message, return it
    if (parsedMessage && parsedMessage !== errorText && !parsedMessage.includes('Đã xảy ra lỗi không xác định')) {
        return parsedMessage;
    }
    // Check for specific patterns and return user-friendly messages
    const lowerError = errorText.toLowerCase();
    // Google tự huỷ khi render quá lâu — không phải lỗi prompt/ảnh, gen lại
    // thường được ngay.
    if (lowerError.includes('video_generation_timed_out') ||
        lowerError.includes('generation_timed_out')) {
        return 'Google tạo video quá lâu nên đã tự huỷ (timeout). Đây là lỗi phía Google, không phải do prompt hay ảnh — bấm gen lại là được.';
    }
    if (lowerError.includes('content policy') || lowerError.includes('policy violation')) {
        return 'Video bị từ chối do vi phạm chính sách nội dung. Vui lòng chỉnh sửa prompt và ảnh tham chiếu.';
    }
    if (lowerError.includes('public_error_model_access_denied')) {
        return 'Profile chưa có quyền dùng model video đã chọn. Vui lòng đổi sang model "Lite" hoặc "Relaxed" (rẻ hơn) trong panel Cài đặt gen, hoặc nâng cấp gói cho profile.';
    }
    if (lowerError.includes('unsafe') || lowerError.includes('harmful')) {
        return 'Video bị từ chối do chứa nội dung không an toàn. Vui lòng chỉnh sửa prompt và ảnh tham chiếu.';
    }
    if (lowerError.includes('generation failed') || lowerError.includes('failed')) {
        return 'Video generation thất bại. Vui lòng thử prompt khác hoặc ảnh tham chiếu khác.';
    }
    // Default message with original error info
    return `Video generation thất bại: ${errorText.substring(0, 150)}. Vui lòng thử gen lại với prompt/ảnh khác.`;
}
