/**
 * Single dispatch point for every outbound request to labs.google /
 * aisandbox-pa.googleapis.com from Veo3Service.
 *
 * All requests go through `tlsFetch` (chrome_131_PSK JA3 + HTTP/2) so the
 * JA3/JA4 fingerprint matches real Chrome — required because Google
 * reCAPTCHA Enterprise scoring penalises Node `undici`'s default
 * fingerprint.
 */
import { tlsFetch, recycleTlsSession } from '../../lib/tlsClient.js';
import { getCookieHeader, invalidateCookieJar } from '../../lib/cookieJar.js';
import { globalProxyManager } from '../../lib/GlobalProxyManager.js';
import { logger } from '../../lib/logger.js';
import { getHostUa, buildSecChUaForMajor } from '../../lib/hostChromeUa.js';
function deriveChromeMajor(userAgent) {
    const match = /Chrome\/(\d+)/.exec(userAgent);
    if (!match)
        return 148;
    const major = Number.parseInt(match[1], 10);
    return Number.isFinite(major) && major > 0 ? major : 148;
}
/** Rewrite only the Chrome/<major> token, preserving the OS/platform token + suffix. */
function rewriteUaChromeMajor(userAgent, major) {
    return userAgent.replace(/Chrome\/\d+(?:\.\d+)*/, `Chrome/${major}.0.0.0`);
}
/**
 * Host's REAL Chrome major (VEO3_CHROME_MAJOR, exported by Electron main / rundev.sh).
 * The reCAPTCHA token is minted INSIDE that real Chrome (via the extension); forcing the
 * submit sec-ch-ua + UA to the same major keeps mint-vs-submit consistent — a mismatch
 * scores the submit as bot → 403 PUBLIC_ERROR_UNUSUAL_ACTIVITY. Null when unset (standalone).
 */
function envChromeMajor() {
    const n = Number.parseInt(process.env.VEO3_CHROME_MAJOR ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}
const deriveSecChUa = buildSecChUaForMajor;
function deriveSecChUaPlatform(userAgent) {
    if (/Windows/i.test(userAgent))
        return '"Windows"';
    if (/Linux/i.test(userAgent) && !/Android/i.test(userAgent))
        return '"Linux"';
    if (/Android/i.test(userAgent))
        return '"Android"';
    return '"macOS"';
}
function isVerboseSubmitLog() {
    return (process.env.VEO3_XHR_CAPTURE_SUBMITS === '1' ||
        /^true$/i.test(String(process.env.VEO3_XHR_CAPTURE_SUBMITS ?? '')));
}
/**
 * Drop-in for `fetch()` that routes ALL Google requests through the
 * TLS-impersonated Node lane. Returns a shape compatible with the legacy
 * browserFetch callers so veo3Service can stay agnostic of the transport.
 *
 * Auth model: `Authorization: Bearer ya29...` on cross-origin
 * `aisandbox-pa.googleapis.com` (cookies stripped to match real Chrome's
 * SameSite=Lax behaviour). labs.google calls send the profile's cookie jar.
 *
 * reCAPTCHA mint context match: sec-ch-ua + sec-ch-ua-platform are derived
 * from the caller's User-Agent (which mirrors the profile UA used to mint
 * the captcha token in the user's Chrome extension). A mismatch between
 * mint context and submit context scores the submit as bot → 403
 * PUBLIC_ERROR_UNUSUAL_ACTIVITY.
 */
export async function googleFetch(opts) {
    if (!opts.profileId)
        throw new Error('googleFetch requires profileId');
    if (!opts.url)
        throw new Error('googleFetch requires url');
    const isCrossOriginApi = /^https:\/\/[^/]*googleapis\.com\b/i.test(opts.url);
    const cookies = isCrossOriginApi ? '' : await getCookieHeader(opts.profileId, opts.url);
    const proxyUrl = globalProxyManager.getCurrentHttpProxyUrl() ?? undefined;
    const isLabsGoogle = /^https:\/\/labs\.google\b/.test(opts.url);
    const callerUA = opts.headers?.['User-Agent'] ?? opts.headers?.['user-agent'];
    const derivedUA = callerUA || getHostUa();
    // Force the submit fingerprint to the host's REAL Chrome major so sec-ch-ua + UA
    // match the reCAPTCHA token minted inside that real Chrome. Env unset (standalone
    // dev) → keep the caller/derived UA. Only the Chrome/<n> token is rewritten, so
    // platform (macOS) + mobile (?0) stay intact.
    const forcedMajor = envChromeMajor();
    const effectiveUA = forcedMajor ? rewriteUaChromeMajor(derivedUA, forcedMajor) : derivedUA;
    const chromeMajor = forcedMajor ?? deriveChromeMajor(effectiveUA);
    const baseHeaders = {
        'User-Agent': effectiveUA,
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        Origin: 'https://labs.google',
        Referer: 'https://labs.google/',
        'sec-ch-ua': deriveSecChUa(chromeMajor),
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': deriveSecChUaPlatform(effectiveUA),
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': isLabsGoogle ? 'same-origin' : 'cross-site',
        Priority: 'u=1, i',
    };
    // Case-insensitive merge so caller `accept-language` overrides `Accept-Language`.
    const finalHeaders = { ...baseHeaders };
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
        const kl = k.toLowerCase();
        for (const bk of Object.keys(finalHeaders)) {
            if (bk.toLowerCase() === kl)
                delete finalHeaders[bk];
        }
        finalHeaders[k] = v;
    }
    // Re-assert the forced-Chrome fingerprint AFTER the merge: getSandboxHeaders
    // passes the profile UA (e.g. Chrome/131) which would otherwise clobber the
    // rewritten baseHeaders UA, leaving UA and sec-ch-ua disagreeing on the major.
    // Both must declare the REAL mint-Chrome major to avoid 403 UNUSUAL_ACTIVITY.
    if (forcedMajor) {
        for (const k of Object.keys(finalHeaders)) {
            const kl = k.toLowerCase();
            if (kl === 'user-agent') {
                finalHeaders[k] = rewriteUaChromeMajor(finalHeaders[k], forcedMajor);
            }
            else if (kl === 'sec-ch-ua') {
                finalHeaders[k] = deriveSecChUa(forcedMajor);
            }
        }
    }
    // Gen-submits typically complete in 12-30s. Cap at 60s so a connection
    // wedged by Google's edge after a 403 cascade fails FAST instead of holding
    // a slot for 3 minutes. Caller can still override via opts.timeoutMs.
    const isGenSubmit = /flowMedia:batchGenerate|video:batch|video:upsample|flow\/upsampleImage/.test(opts.url);
    const defaultTimeoutMs = isGenSubmit ? 60000 : 30000;
    // 🔎 [HdrDiag] Submit-fingerprint diagnostic. SILENT on the healthy path (mint
    // Chrome major aligned to submit) to avoid 4-lines-per-batch spam. Logs a WARN
    // only when the version is NOT aligned — i.e. VEO3_CHROME_MAJOR is unset so we
    // can't force it (403 UNUSUAL_ACTIVITY regression risk) — or when explicitly
    // re-enabled via VEO3_HDR_DIAG=1.
    if (isGenSubmit) {
        const aligned = forcedMajor !== null && forcedMajor === chromeMajor;
        if (!aligned || process.env.VEO3_HDR_DIAG === '1') {
            const note = forcedMajor === null
                ? '⚠️ realChrome UNSET (VEO3_CHROME_MAJOR missing) → using profile UA, mismatch risk'
                : aligned
                    ? '✅aligned'
                    : '⚠️ NOT aligned';
            logger.warn(`[HdrDiag] submit fp: chromeMajor=${chromeMajor} ${note} ` +
                `sec-ch-ua=${finalHeaders['sec-ch-ua']} platform=${finalHeaders['sec-ch-ua-platform']} ` +
                `cross=${isCrossOriginApi} UA="${finalHeaders['User-Agent'] ?? finalHeaders['user-agent'] ?? effectiveUA}"`);
        }
    }
    const resp = await tlsFetch({
        profileId: opts.profileId,
        url: opts.url,
        method: opts.method ?? 'POST',
        headers: finalHeaders,
        body: opts.body,
        cookies,
        proxyUrl,
        timeoutMs: opts.timeoutMs ?? defaultTimeoutMs,
        followRedirects: opts.followRedirects,
    });
    // Recycle TLS session on 403 PUBLIC_ERROR_UNUSUAL_ACTIVITY or status=0
    // (connection timeout). Google's edge sends HTTP/2 RST_STREAM/GOAWAY after
    // a few 403s — remaining streams on the same TCP connection get wedged.
    const isRecaptcha403 = resp.status === 403 &&
        /PUBLIC_ERROR_UNUSUAL_ACTIVITY|reCAPTCHA evaluation failed/i.test(resp.body);
    const isConnectionTimeout = resp.status === 0;
    if (isRecaptcha403 || isConnectionTimeout) {
        recycleTlsSession(opts.profileId, isRecaptcha403 ? '403-unusual-activity' : 'connection-timeout');
        invalidateCookieJar(opts.profileId);
    }
    if (resp.ok && isVerboseSubmitLog() && isGenSubmit) {
        const requestBytes = opts.body ? Buffer.byteLength(opts.body, 'utf8') : 0;
        const responseBytes = Buffer.byteLength(resp.body, 'utf8');
        logger.info(`[TLS Submit] ${opts.method ?? 'POST'} ${opts.url.replace(/^https:\/\/[^/]+/, '')} → ${resp.status} ok requestBytes=${requestBytes} responseBytes=${responseBytes} durationMs=${resp.durationMs}`);
    }
    else if (!resp.ok) {
        // A 3xx when the caller asked NOT to follow redirects is the success path
        // (getMediaUrlRedirect reads the Location header), not a failure — warning
        // on it printed one false alarm per finished video.
        const isExpectedRedirect = opts.followRedirects === false && resp.status >= 300 && resp.status < 400;
        const line = `[Veo3Service] tlsFetch ${opts.method ?? 'POST'} ${opts.url.replace(/^https:\/\/[^/]+/, '')} → ${resp.status} (${resp.durationMs}ms)`;
        if (isExpectedRedirect)
            logger.debug(line);
        else
            logger.warn(line);
    }
    return {
        ok: resp.ok,
        status: resp.status,
        statusText: resp.statusText,
        body: resp.body,
        headers: resp.headers,
        durationMs: resp.durationMs,
        text: async () => resp.body,
        json: async () => {
            try {
                return JSON.parse(resp.body);
            }
            catch (error) {
                throw new Error(`googleFetch.json() failed for ${opts.method ?? 'POST'} ${opts.url}: ${error?.message || error}`);
            }
        },
    };
}
