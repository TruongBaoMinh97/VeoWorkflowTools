/**
 * TLS-impersonated HTTP client (Chrome 131 PSK profile).
 *
 * Wraps `node-tls-client` (bogdanfinn/tls-client Go binary). JA3 / JA4 / HTTP/2
 * frame ordering match real Chrome — required because Google reCAPTCHA
 * Enterprise scoring penalises Node `undici`'s default JA3 fingerprint with
 * 403 PUBLIC_ERROR_UNUSUAL_ACTIVITY even when the captcha token itself is high
 * score.
 *
 * Verified JA3 hash on this build (tls.peet.ws):
 *   a19ab9f02aacf42deddc1f2acb3d3f63
 *   JA4: t13d1516h2_8daaf6152771_02713d6af862
 *   HTTP/2 (ALPN h2)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { logger } from './logger.js';
import { ensureBundledTlsLibrary } from './tlsClientNativeSetup.js';
const sessionByProfile = new Map();
const requestCountByProfile = new Map();
let initTLSPromise = null;
let TlsLib = null;
function getPreventiveRecycleThreshold() {
    const raw = process.env.VEO3_PREVENTIVE_TLS_RECYCLE_THRESHOLD;
    if (raw == null || raw === '')
        return 15;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0)
        return 15;
    return Math.floor(n);
}
async function ensureTlsReady() {
    if (!TlsLib) {
        // Seed the bundled native lib into os.tmpdir() BEFORE node-tls-client loads,
        // so it never downloads from GitHub and a corrupt cache is replaced with the
        // known-good shipped copy. See tlsClientNativeSetup.ts.
        ensureBundledTlsLibrary();
        TlsLib = await import('node-tls-client');
    }
    if (!initTLSPromise) {
        initTLSPromise = (async () => {
            await TlsLib.initTLS();
            logger.info('[TlsClient] Initialised node-tls-client (chrome_131_PSK)');
        })().catch((err) => {
            initTLSPromise = null;
            throw err;
        });
    }
    await initTLSPromise;
    return TlsLib;
}
/**
 * Warm-up node-tls-client at app startup so the ~10MB shared library is
 * downloaded + `initTLS()` runs in the background BEFORE the first real TLS
 * request. Fire-and-forget: never blocks boot, never throws (lazy init still
 * covers it if this fails). Idempotent — reuses the same init promise.
 */
export function warmUpTlsClient() {
    ensureTlsReady().catch((err) => {
        logger.warn(`[TlsClient] Warm-up failed (will retry lazily): ${err?.message || err}`);
    });
}
/**
 * node-tls-client's internal `Cookies.syncCookies` crashes with
 * `Cannot read properties of undefined (reading 'key')` when Google returns
 * Set-Cookie values that tough-cookie's strict parser rejects (silently returns
 * `undefined`). Patch the jar so unparseable entries are skipped without
 * killing the whole request.
 */
function patchCookieJar(session) {
    const jar = session?.jar;
    if (!jar || typeof jar.syncCookies !== 'function' || jar.__veo3Patched)
        return;
    jar.__veo3Patched = true;
    const orig = jar.setCookie.bind(jar);
    jar.syncCookies = async (cookies, url) => {
        if (!cookies)
            return {};
        const result = {};
        await Promise.all(Object.entries(cookies).map(async ([key, value]) => {
            try {
                const cookie = await orig(`${key}=${value}`, url);
                if (cookie && typeof cookie === 'object' && 'key' in cookie) {
                    result[cookie.key] = cookie.value;
                }
            }
            catch {
                /* skip unparseable cookie — the request itself still completes */
            }
        }));
        return result;
    };
}
async function getSession(profileId, proxyUrl) {
    const lib = await ensureTlsReady();
    let s = sessionByProfile.get(profileId);
    if (!s) {
        s = new lib.Session({
            sessionId: `veo3-${profileId.slice(0, 12)}`,
            clientIdentifier: lib.ClientIdentifier.chrome_131_psk,
            timeout: 180000,
            randomTlsExtensionOrder: false,
            // proxy may change between calls (rotation); we set it on the session
            // but also accept per-request overrides via opts.proxyUrl.
            proxy: proxyUrl,
        });
        patchCookieJar(s);
        sessionByProfile.set(profileId, s);
    }
    else if (proxyUrl !== undefined) {
        // Update proxy on existing session — node-tls-client supports re-config.
        try {
            s.config = { ...(s.config ?? {}), proxy: proxyUrl };
        }
        catch {
            /* ignore */
        }
    }
    return s;
}
/**
 * Single-shot TLS-impersonated request. Cookies must be supplied by the caller
 * (we do not rely on the session's internal jar because Chrome owns the truth
 * — see `cookieJar.ts` for the sync layer).
 */
export async function tlsFetch(opts) {
    const t0 = Date.now();
    const session = await getSession(opts.profileId, opts.proxyUrl);
    const method = (opts.method ?? 'POST').toUpperCase();
    const headers = { ...(opts.headers ?? {}) };
    if (opts.cookies && opts.cookies.length > 0) {
        headers['Cookie'] = opts.cookies;
    }
    const reqOpts = {
        headers,
        followRedirects: opts.followRedirects ?? true,
    };
    if (opts.proxyUrl)
        reqOpts.proxy = opts.proxyUrl;
    if (opts.body !== undefined && method !== 'GET' && method !== 'HEAD') {
        reqOpts.body = opts.body;
    }
    let resp;
    switch (method) {
        case 'GET':
            resp = await session.get(opts.url, reqOpts);
            break;
        case 'POST':
            resp = await session.post(opts.url, reqOpts);
            break;
        case 'PUT':
            resp = await session.put(opts.url, reqOpts);
            break;
        case 'PATCH':
            resp = await session.patch(opts.url, reqOpts);
            break;
        case 'DELETE':
            resp = await session.delete(opts.url, reqOpts);
            break;
        case 'HEAD':
            resp = await session.head(opts.url, reqOpts);
            break;
        case 'OPTIONS':
            resp = await session.options(opts.url, reqOpts);
            break;
        default:
            throw new Error(`tlsFetch: unsupported method ${method}`);
    }
    // node-tls-client Response has fetch-like .text() / .json() and .status / .headers
    const status = Number(resp?.status ?? 0);
    const body = typeof resp?.text === 'function' ? await resp.text() : String(resp?.body ?? '');
    const rawHeaders = (resp?.headers ?? {});
    const flatHeaders = {};
    const setCookies = [];
    for (const [k, v] of Object.entries(rawHeaders)) {
        const key = k.toLowerCase();
        if (key === 'set-cookie') {
            if (Array.isArray(v))
                setCookies.push(...v);
            else if (typeof v === 'string')
                setCookies.push(v);
            flatHeaders[key] = Array.isArray(v) ? v.join('; ') : String(v);
        }
        else {
            flatHeaders[key] = Array.isArray(v) ? v.join(', ') : String(v);
        }
    }
    // Preventive session recycle — break the HTTP/2 connection every N
    // successful requests so Google's edge never accumulates a long-lived
    // "this connection has been making suspicious requests" tally. Cheap:
    // a single TLS handshake on the next request. Disable via env
    // VEO3_PREVENTIVE_TLS_RECYCLE_THRESHOLD=0.
    if (status >= 200 && status < 400) {
        const threshold = getPreventiveRecycleThreshold();
        if (threshold > 0) {
            const n = (requestCountByProfile.get(opts.profileId) ?? 0) + 1;
            if (n >= threshold) {
                requestCountByProfile.set(opts.profileId, 0);
                setImmediate(() => recycleTlsSession(opts.profileId, 'preventive-cycle'));
            }
            else {
                requestCountByProfile.set(opts.profileId, n);
            }
        }
    }
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: '',
        body,
        headers: flatHeaders,
        setCookies,
        durationMs: Date.now() - t0,
    };
}
/**
 * Dispose the TLS session for a profile. Call when the profile is removed,
 * Chrome is torn down, OR after a 403/timeout cascade so the next request
 * opens a fresh HTTP/2 connection (Google may RST_STREAM the existing one
 * after a streak of PUBLIC_ERROR_UNUSUAL_ACTIVITY, leaving subsequent
 * requests on the same connection wedged for the full timeout).
 */
export async function disposeTlsSession(profileId) {
    requestCountByProfile.delete(profileId);
    const s = sessionByProfile.get(profileId);
    if (!s)
        return;
    sessionByProfile.delete(profileId);
    try {
        await s.close?.();
    }
    catch (e) {
        logger.warn(`[TlsClient] session.close failed for ${profileId.slice(0, 8)}: ${e?.message || e}`);
    }
}
/**
 * Fire-and-forget session recycle — used by `googleFetch` when it sees a 403
 * or a connection-error timeout. Returns immediately; the actual close is
 * scheduled on the next tick so it does not block the current response path.
 */
export function recycleTlsSession(profileId, reason) {
    requestCountByProfile.delete(profileId);
    const s = sessionByProfile.get(profileId);
    if (!s)
        return;
    sessionByProfile.delete(profileId);
    logger.warn(`[TlsClient] recycling session for ${profileId.slice(0, 8)} (${reason})`);
    setImmediate(() => {
        s.close?.().catch(() => { });
    });
}
/**
 * Tear down everything — called at process exit so the Go shared library frees
 * its goroutines / native handles.
 */
export async function shutdownTlsClient() {
    const ids = Array.from(sessionByProfile.keys());
    await Promise.allSettled(ids.map((id) => disposeTlsSession(id)));
    try {
        if (TlsLib?.destroyTLS)
            await TlsLib.destroyTLS();
    }
    catch {
        /* best-effort */
    }
}
