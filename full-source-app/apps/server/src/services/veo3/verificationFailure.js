/** Provider rejection requires user verification, not automated browser recovery. */
export const VERIFICATION_REQUIRED_CODE = 'FLOW_VERIFICATION_REQUIRED';
export const VERIFICATION_REQUIRED_MESSAGE = `${VERIFICATION_REQUIRED_CODE}:Google từ chối xác minh reCAPTCHA (403). Mở Google Flow, kiểm tra đăng nhập và hoàn tất xác minh nếu được yêu cầu, sau đó bấm Gen lại.`;

export function isVerificationRejected(error) {
    const text = typeof error === 'string'
        ? error
        : [error?.message, error?.errorText].filter(value => typeof value === 'string').join('\n');
    if (error?.code === VERIFICATION_REQUIRED_CODE || text.includes(`${VERIFICATION_REQUIRED_CODE}:`))
        return true;
    // Traffic/quota errors can contain the same reCAPTCHA wording.
    let status = error?.response?.status ?? error?.status;
    try {
        status ??= JSON.parse(typeof error?.errorText === 'string' ? error.errorText : text)?.error?.code;
    }
    catch { /* Plain-text errors are supported too. */ }
    if (status === 429 || error?.isTransientTrafficLimit || /PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC|RESOURCE_EXHAUSTED|PUBLIC_ERROR_(?:PER_MODEL_DAILY_QUOTA|USER_QUOTA)_REACHED/.test(text))
        return false;
    if (status != null && status !== 403)
        return false;
    return /PUBLIC_ERROR_UNUSUAL_ACTIVITY(?![A-Z_])/.test(text)
        || /reCAPTCHA evaluation failed/i.test(text);
}

export function verificationRequiredError(error) {
    return Object.assign(new Error(VERIFICATION_REQUIRED_MESSAGE), {
        code: VERIFICATION_REQUIRED_CODE,
        response: error?.response,
        errorText: error?.errorText,
        nonRetryable: true,
        isNonRetryable: true,
    });
}
