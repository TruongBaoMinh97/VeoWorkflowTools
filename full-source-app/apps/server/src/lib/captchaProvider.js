/**
 * Where reCAPTCHA tokens come from.
 *
 *   'extension' — FALLBACK. The user-installed Chrome
 *                 extension long-polls /api/internal/captcha/poll and posts
 *                 tokens back. Proven in production.
 *   'cdp'       — DEFAULT. Electron opens its own real Chrome, parks a Flow
 *                 tab and mints through CDP (`captchaBrowserManager.ts`). No
 *                 extension install for the user.
 *
 * Only the transport differs. The mint mutex, the 3/7 failure ladder and the
 * reset escalation all stay in captchaManager, so both providers are scored and
 * throttled identically.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import { CaptchaError } from './errors.js';
import { getElectronUserDataPath } from './electronPaths.js';
import { electronBrowserBridge } from '../integrations/browser/ElectronBrowserBridge.js';
/**
 * 'cdp' is the default since 2026-09-19: field-tested with zero 403s and it
 * spares the user the manual extension install. `CAPTCHA_PROVIDER=extension`
 * falls back to the old path, which is kept working for exactly that reason.
 */
const PROVIDER_FILE = 'captcha-provider.json';
function providerFilePath() {
    return path.join(getElectronUserDataPath(), PROVIDER_FILE);
}
/** Explicit environment override → persisted user choice → CDP default. */
function readInitialProvider() {
    if (process.env.CAPTCHA_PROVIDER === 'extension')
        return 'extension';
    if (process.env.CAPTCHA_PROVIDER === 'cdp')
        return 'cdp';
    if (process.env.CAPTCHA_PROVIDER !== undefined)
        return 'cdp';
    try {
        const saved = JSON.parse(fs.readFileSync(providerFilePath(), 'utf8'));
        if (saved.provider === 'extension' || saved.provider === 'cdp')
            return saved.provider;
    }
    catch {
        /* first run or unreadable file */
    }
    return 'cdp';
}
function persistProvider(provider) {
    const filePath = providerFilePath();
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify({ provider }), { mode: 0o600 });
        fs.chmodSync(filePath, 0o600);
    }
    catch (err) {
        logger.warn(`[captcha] could not persist provider: ${err instanceof Error ? err.message : String(err)}`);
    }
}
let activeProvider = readInitialProvider();
export function getCaptchaProvider() {
    return activeProvider;
}
/**
 * Switching is allowed at runtime so the two paths can be A/B-tested on the same
 * build. In-flight mints keep running on the provider that started them; the
 * mutex in captchaManager means at most one is ever in flight.
 */
export function setCaptchaProvider(next) {
    if (next !== activeProvider) {
        logger.info(`[captcha] provider: ${activeProvider} → ${next}`);
        activeProvider = next;
        persistProvider(next);
    }
    return activeProvider;
}
async function callBridge(path, init) {
    try {
        return await electronBrowserBridge.requestJson(path, init);
    }
    catch (err) {
        throw new CaptchaError(
            `Không gọi được Electron để xử lý captcha: ${err instanceof Error ? err.message : String(err)}`,
            { code: 'CAPTCHA_BRIDGE_UNREACHABLE', retryable: true },
        );
    }
}
export async function cdpMint(action) {
    const { token } = await callBridge('/captcha/mint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
    });
    if (!token || token.trim().length === 0) {
        throw new CaptchaError('Captcha browser trả về token rỗng', {
            code: 'CAPTCHA_EMPTY',
            retryable: true,
        });
    }
    return token;
}
export async function cdpReset(kind) {
    await callBridge('/captcha/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
    });
}
export async function cdpEnsure() {
    const { status } = await callBridge('/captcha/ensure', {
        method: 'POST',
    });
    return status;
}
/** Best-effort close used when switching away from the CDP provider. */
export async function cdpClose() {
    try {
        await callBridge('/captcha/close', { method: 'POST' });
    }
    catch {
        /* Browser already closed or Electron absent. */
    }
}
/** Never throws — the status panel must render even when Electron is absent. */
export async function cdpStatus() {
    try {
        const { status } = await callBridge('/captcha/status');
        return status;
    }
    catch {
        return null;
    }
}
