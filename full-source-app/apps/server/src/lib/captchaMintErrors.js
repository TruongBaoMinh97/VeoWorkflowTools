/** Distinguish a browser that produced no token from a token rejected by Flow. */
export function isCaptchaMintError(message, error) {
    return (/Failed to obtain \d+ reCAPTCHA tokens|Captcha browser lỗi|Captcha browser trả về token rỗng|Mint quá thời gian|Không gọi được Electron để (?:mint|xử lý) captcha/.test(message) ||
        error?.code === 'CAPTCHA_FAILED' ||
        error?.code === 'CAPTCHA_EMPTY' ||
        error?.code === 'CAPTCHA_TIMEOUT' ||
        error?.code === 'CAPTCHA_SDK_UNAVAILABLE' ||
        error?.code === 'CAPTCHA_MINT_FAILED' ||
        error?.code === 'CAPTCHA_BRIDGE_UNREACHABLE');
}
