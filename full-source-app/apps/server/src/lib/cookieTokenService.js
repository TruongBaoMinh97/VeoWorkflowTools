import { logger } from './logger.js';
import { requestProfileRemint } from './sessionRemintRequest.js';
import { tlsFetch } from './tlsClient.js';
import { createHash } from 'node:crypto';

/**
 * Build a stable, non-reversible identity for the current cookie set.
 *
 * A profile can receive fresh cookies while its cached access token is still
 * inside the local TTL. Keying the cache by profile alone would then return the
 * old token and write it back to the database. Sorting makes Electron cookie
 * ordering irrelevant; only an actual cookie value/attribute change invalidates
 * the token cache.
 */
export function fingerprintProfileCookies(cookiesString) {
    const raw = cookiesString?.trim() ?? '';
    let canonical = raw;
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            canonical = parsed
                .filter((cookie) => cookie && typeof cookie.name === 'string')
                .map((cookie) => [
                cookie.name,
                cookie.value ?? '',
                cookie.domain ?? '',
                cookie.path ?? '/',
                cookie.expirationDate ?? cookie.expires ?? '',
            ].join('\u0000'))
                .sort()
                .join('\n');
        }
    }
    catch {
        canonical = raw
            .split(';')
            .map((part) => part.trim())
            .filter(Boolean)
            .sort()
            .join(';');
    }
    return createHash('sha256').update(canonical).digest('hex');
}
/**
 * The profile's Flow session still exists, but the OAuth grant inside it has
 * expired and cannot be refreshed — the profile must sign in again to mint a
 * new one. Distinct from "no cookies" and from a transient network failure so
 * callers can drive the re-mint instead of asking the user to fix cookies.
 */
export class FlowSessionRemintRequiredError extends Error {
    constructor(grantExpiredAt, upstreamError) {
        super('Phiên Flow của profile đã hết hiệu lực (Google cấp quyền theo phiên, không tự gia hạn). ' +
            'Cần đăng nhập lại profile để cấp phiên mới.' +
            (upstreamError ? ` [${upstreamError}]` : ''));
        this.code = 'FLOW_SESSION_REMINT_REQUIRED';
        this.name = 'FlowSessionRemintRequiredError';
        this.grantExpiredAt = grantExpiredAt;
    }
}

/**
 * Google retired the Labs NextAuth endpoint that used to return the ya29
 * bearer token. Re-login cannot repair HTTP 410; current Flow generation uses
 * the cookie-authenticated batchexecute transport instead.
 */
export class FlowAuthEndpointRetiredError extends Error {
    constructor() {
        super('Google đã tắt endpoint cấp access token cũ (labs.google auth/session, HTTP 410). Luồng Flow mới dùng cookie trực tiếp.');
        this.code = 'FLOW_AUTH_RETIRED';
        this.name = 'FlowAuthEndpointRetiredError';
    }
}

const AUTH_RETIRED_BACKOFF_MS = 10 * 60 * 1000;

export class CookieTokenService {
    constructor() {
        this.authRetiredUntil = 0;
        this.tokenCache = new Map();
        this.TOKEN_TTL_MS = 5 * 60 * 60 * 1000; // 5 hours (conservative TTL for Google access tokens)
    }
    /**
     * Get access token from cookies by calling Google's /api/auth/session
     * @param cookiesString - Cookie header string (e.g., "name1=value1; name2=value2")
     * @param profileId - Optional profile ID for caching
     * @returns Access token string
     */
    generateSecChUaHeaders(userAgent) {
        // Default fallback aligned with chrome_131_PSK profile in tlsClient.ts.
        const defaultMajor = '131';
        const defaultPlatform = '"macOS"';
        // Extract Chrome version
        const chromeMatch = userAgent.match(/Chrome\/(\d+)\./);
        const major = chromeMatch ? chromeMatch[1] : defaultMajor;
        const majorNum = parseInt(major, 10);
        // Extract Platform
        let platform = defaultPlatform;
        if (userAgent.includes('Windows'))
            platform = '"Windows"';
        else if (userAgent.includes('Linux'))
            platform = '"Linux"';
        else if (userAgent.includes('Macintosh'))
            platform = '"macOS"';
        // CRITICAL: Brand string format must match Chrome version for consistency
        // Chrome ≤ 128: "Not_A Brand";v="8"
        // Chrome ≥ 129: "Not(A:Brand";v="99"
        const notABrand = majorNum >= 129
            ? '"Not(A:Brand";v="99"'
            : '"Not_A Brand";v="8"';
        return {
            'sec-ch-ua': `"Chromium";v="${major}", "Google Chrome";v="${major}", ${notABrand}`,
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': platform,
        };
    }
    async getAccessTokenFromCookies(cookiesString, profileId, userAgent) {
        try {
            if (!cookiesString || cookiesString.trim().length === 0) {
                throw new Error('Cookies are required to get access token');
            }
            const cookiesFingerprint = fingerprintProfileCookies(cookiesString);
            // Check cache first if profileId is provided
            if (profileId) {
                const cached = this.tokenCache.get(profileId);
                if (cached && cached.expiresAt > Date.now() && cached.cookiesFingerprint === cookiesFingerprint) {
                    logger.info(`✅ [CookieTokenService] Using cached token for profile ${profileId}`);
                    return {
                        accessToken: cached.token,
                        expiresAt: new Date(cached.expiresAt),
                    };
                }
                if (cached && cached.cookiesFingerprint !== cookiesFingerprint) {
                    logger.info(`[CookieTokenService] Cookie set changed for profile ${profileId.substring(0, 8)} — fetching a fresh access token`);
                }
            }
            if (Date.now() < this.authRetiredUntil)
                throw new FlowAuthEndpointRetiredError();
            // Parse cookies - handle both JSON array format and header string format
            let cookiesHeaderString;
            // Essential cookies for Google Labs auth (to avoid 431 error from too many cookies).
            //
            // Supports BOTH account types:
            //   - Consumer (@gmail.com): 1P SID family + advanced trust (1PSIDTS)
            //   - Workspace (@company.com): SSO cookies (LSID, LSOSID, OSID, S, SIDCC)
            //     + One Google Pass (OGPC). Without these, NextAuth session endpoint
            //     returns `{}` for Workspace accounts.
            const ESSENTIAL_COOKIE_PATTERNS = [
                // Google.com auth cookies (consumer)
                '__Secure-1PSID', '__Secure-1PAPISID', '__Secure-1PSIDTS', '__Secure-1PSIDCC',
                '__Secure-3PSID', '__Secure-3PAPISID', '__Secure-3PSIDTS', '__Secure-3PSIDCC',
                'SAPISID', 'APISID', 'SSID', 'SID', 'HSID',
                // Workspace SSO essentials — needed for @company.com accounts
                'LSID', 'LSOSID', 'OSID', 'S', 'SIDCC',
                '__Secure-OSID',
                'OGPC', 'OGP',
                'ACCOUNT_CHOOSER',
                // Tracking / continuity (used by both flows for session score)
                'NID', '1P_JAR', '3P_JAR', 'AEC',
                '__Secure-ENID',
                'CONSENT', 'SOCS',
                // Labs.google auth cookies (NextAuth)
                '__Secure-next-auth.session-token',
                '__Secure-next-auth.callback-url',
                '__Host-next-auth.csrf-token',
                'email', 'EMAIL',
            ];
            const isEssentialCookie = (cookie) => {
                const name = typeof cookie === 'string' ? cookie.split('=')[0] : cookie.name;
                // Check if matches essential patterns
                if (ESSENTIAL_COOKIE_PATTERNS.includes(name))
                    return true;
                // Keep all __Secure- and __Host- prefixed cookies for labs.google
                if (name.startsWith('__Secure-') || name.startsWith('__Host-'))
                    return true;
                return false;
            };
            // Dedup cookies by name + score by domain relevance for labs.google.
            // 2FA accounts have the SAME cookie name stored under multiple Google
            // subdomains (.google.com, accounts.google.com, myaccount.google.com),
            // so the naive map-then-join produces a 8-12KB Cookie header with 4+
            // duplicates of HSID/SID/etc → Google's edge rejects with HTTP 431
            // "Request Header Fields Too Large".
            //
            // Domain priority (higher = better) when picking which copy to keep:
            //   3 = labs.google or .labs.google (the actual target host)
            //   2 = .google.com (parent — useful for SSO continuity)
            //   1 = anything else under google (accounts, myaccount, …)
            //   0 = unrelated
            const domainScore = (domain) => {
                const d = (domain || '').toLowerCase();
                if (!d)
                    return 0;
                if (d === 'labs.google' || d === '.labs.google')
                    return 3;
                if (d === 'google.com' || d === '.google.com')
                    return 2;
                if (d.endsWith('.google.com') || d.endsWith('.google'))
                    return 1;
                return 0;
            };
            const dedupByName = (cookies) => {
                const best = new Map();
                for (const c of cookies) {
                    if (!c?.name)
                        continue;
                    const incoming = domainScore(c.domain);
                    if (incoming === 0)
                        continue; // sibling/unrelated — would not be sent by browser
                    const existing = best.get(c.name);
                    if (!existing || domainScore(existing.domain) < incoming) {
                        best.set(c.name, c);
                    }
                }
                return Array.from(best.values());
            };
            try {
                // Try to parse as JSON first (in case user pasted array from browser extension)
                const parsed = JSON.parse(cookiesString.trim());
                if (Array.isArray(parsed)) {
                    logger.info('🔄 [CookieTokenService] Detected JSON array format, filtering essential cookies...');
                    // 1) Essential names → 2) dedup by name with domain priority
                    const essentialCookies = parsed.filter(isEssentialCookie);
                    const deduped = dedupByName(essentialCookies);
                    cookiesHeaderString = deduped
                        .map((cookie) => `${cookie.name}=${cookie.value}`)
                        .join('; ');
                    logger.info(`   ✅ ${parsed.length} input → ${essentialCookies.length} essential → ${deduped.length} after dedup (header ${cookiesHeaderString.length}B)`);
                    logger.info(`   📋 Cookie names: ${deduped.map((c) => c.name).join(', ')}`);
                }
                else {
                    // Parsed but not array - use as is
                    logger.info('⚠️  [CookieTokenService] Parsed as JSON but not array, using as-is');
                    cookiesHeaderString = cookiesString.trim();
                }
            }
            catch {
                // Not JSON - assume it's already a cookie header string, filter by name
                logger.info('📋 [CookieTokenService] Using cookie header string format, filtering...');
                const cookiePairs = cookiesString.trim().split(';').map(c => c.trim());
                const essentialPairs = cookiePairs.filter(isEssentialCookie);
                cookiesHeaderString = essentialPairs.join('; ');
                logger.info(`   ✅ Filtered ${essentialPairs.length}/${cookiePairs.length} essential cookies (length: ${cookiesHeaderString.length})`);
            }
            // Single-shared-browser refactor removed the per-profile Electron Chrome
            // that previously fronted /browser/refresh-token, so all refreshes go
            // through the TLS-impersonated Node lane below.
            const url = 'https://labs.google/fx/api/auth/session';
            const headers = {
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'accept-language': 'en-US,en;q=0.9',
                'cache-control': 'max-age=0',
                'Cookie': cookiesHeaderString,
                'priority': 'u=0, i',
                'referer': 'https://labs.google/fx/en/tools/flow',
                'upgrade-insecure-requests': '1',
            };
            logger.info('🔑 [CookieTokenService] Fetching access token from Google API (TLS-impersonated Node fetch fallback)', {
                url,
                cookiesLength: cookiesString.length,
                profileId: profileId ? profileId.substring(0, 8) : undefined,
            });
            // Use TLS-impersonated client so the JA3 fingerprint matches Chrome.
            // Plain Node `fetch` was previously rejected by Google with 401 for
            // accounts that have been flagged via JA3 mismatch.
            const response = await tlsFetch({
                profileId: profileId || 'cookie-token-bootstrap',
                url,
                method: 'GET',
                headers,
            });
            logger.info('[CookieTokenService] Node fallback response', {
                status: response.status,
                statusText: response.statusText,
                bodyLength: response.body?.length ?? 0,
            });
            if (response.status === 410) {
                this.authRetiredUntil = Date.now() + AUTH_RETIRED_BACKOFF_MS;
                logger.warn('[CookieTokenService] labs auth/session retired (410) — Flow generation will use cookie-authenticated RPC');
                throw new FlowAuthEndpointRetiredError();
            }
            if (!response.ok) {
                logger.error('❌ [CookieTokenService] HTTP Error', {
                    status: response.status,
                    statusText: response.statusText,
                    error: response.body.substring(0, 500),
                });
                throw new Error(`Failed to get access token: ${response.status} - ${response.body.substring(0, 200)}`);
            }
            let sessionData;
            try {
                sessionData = JSON.parse(response.body);
            }
            catch (parseErr) {
                throw new Error(`Failed to parse session response: ${parseErr?.message || parseErr}`);
            }
            const sessionKeys = Object.keys(sessionData);
            logger.info('[CookieTokenService] Session data parsed', {
                keys: sessionKeys,
                hasAccessToken: !!sessionData.access_token,
            });
            if (!sessionData.access_token) {
                // Response might be an array of cookies - need to call again
                if (Array.isArray(sessionData)) {
                    logger.info('[CookieTokenService] Response is array, extracting cookies...');
                    const newCookies = sessionData
                        .map((cookie) => `${cookie.name}=${cookie.value}`)
                        .join('; ');
                    // Recursive call with new cookies
                    return this.getAccessTokenFromCookies(newCookies, profileId, userAgent);
                }
                // Last-resort: return cached token if still valid. Empty `{}` body
                // typically means the labs.google NextAuth session cookie is missing
                // or expired in the supplied cookie string. A previously cached
                // token is more useful than an error.
                if (profileId) {
                    const cached = this.tokenCache.get(profileId);
                    if (cached && cached.expiresAt > Date.now() && cached.cookiesFingerprint === cookiesFingerprint) {
                        logger.warn(`[CookieTokenService] Node fallback returned empty session for ${profileId.substring(0, 8)} — keeping cached token (expires ${new Date(cached.expiresAt).toISOString()})`);
                        return { accessToken: cached.token, expiresAt: new Date(cached.expiresAt) };
                    }
                }
                const preview = JSON.stringify(sessionData).substring(0, 200);
                logger.error('❌ [CookieTokenService] No access_token in session response', {
                    keys: sessionKeys,
                    bodyPreview: preview,
                    hint: sessionKeys.length === 0
                        ? 'labs.google returned {} — session cookie missing or expired; re-login the profile.'
                        : 'session response present but access_token absent — cookies likely expired',
                });
                throw new Error(sessionKeys.length === 0
                    ? 'Google returned empty session ({}). labs.google session cookie missing or expired. Please re-login the profile.'
                    : 'No access_token in session response. Please check if cookies are valid.');
            }
            // Flow's NextAuth session embeds ONE OAuth grant, minted at login, with no
            // refresh_token behind it — the 30-day session cookie stays valid long
            // after the grant inside it dies (~16-24h). When that happens Google keeps
            // returning the same dead access_token, with `expires` in the past and
            // eventually error=ACCESS_TOKEN_REFRESH_NEEDED. Nothing over HTTP can renew
            // it; only a new sign-in mints a new grant.
            //
            // Treat a past `expires` as fatal on its own: the error field only shows up
            // some minutes later, and the old code papered over the gap with a
            // synthetic now+5h expiry, which made a dead profile look healthy to
            // /auth-status and left the warm-up with nothing to fix.
            const apiExpiresMs = sessionData.expires ? new Date(sessionData.expires).getTime() : NaN;
            if (Number.isFinite(apiExpiresMs) && apiExpiresMs < Date.now()) {
                if (profileId) {
                    this.tokenCache.delete(profileId);
                    requestProfileRemint(profileId, sessionData.error ?? 'grant-expired');
                }
                logger.error('❌ [CookieTokenService] Flow session grant expired — re-mint required', {
                    profileId: profileId?.substring(0, 8),
                    error: sessionData.error ?? null,
                    expires: sessionData.expires,
                });
                throw new FlowSessionRemintRequiredError(sessionData.expires, sessionData.error);
            }
            // Calculate expiry
            let expiresAt;
            if (sessionData.expires) {
                const apiExpires = new Date(sessionData.expires).getTime();
                // A past expiry already threw above. Beyond 24h is implausible for a
                // ya29 grant, so fall back to the conservative TTL there.
                if (apiExpires > Date.now() + 24 * 60 * 60 * 1000) {
                    logger.info(`⚠️  [CookieTokenService] API expires implausibly far out (${new Date(apiExpires).toISOString()}), using TTL instead`);
                    expiresAt = Date.now() + this.TOKEN_TTL_MS;
                }
                else {
                    logger.info(`✅ [CookieTokenService] Using API expires date: ${new Date(apiExpires).toISOString()}`);
                    expiresAt = apiExpires;
                }
            }
            else {
                expiresAt = Date.now() + this.TOKEN_TTL_MS;
                logger.info(`ℹ️  [CookieTokenService] No expires in response, using default TTL (${this.TOKEN_TTL_MS / (60 * 60 * 1000)} hours)`);
            }
            // Cache token if profileId is provided
            if (profileId) {
                this.tokenCache.set(profileId, {
                    token: sessionData.access_token,
                    expiresAt,
                    profileId,
                    cookiesFingerprint,
                });
                logger.info(`✅ [CookieTokenService] Cached access token for profile ${profileId}, expires at ${new Date(expiresAt).toISOString()}`);
            }
            logger.info('✅ [CookieTokenService] Successfully retrieved access token');
            return {
                accessToken: sessionData.access_token,
                expiresAt: new Date(expiresAt),
            };
        }
        catch (error) {
            if (error instanceof FlowAuthEndpointRetiredError)
                throw error;
            logger.error('❌ [CookieTokenService] Fatal error in getAccessTokenFromCookies:', {
                message: error.message,
                stack: error.stack?.substring(0, 500),
                name: error.name,
                cause: error.cause,
            });
            throw error;
        }
    }
    /**
     * Get cached token for a profile
     * @param profileId - Profile ID
     * @returns Cached token or null if not found/expired
     */
    getCachedToken(profileId) {
        const cached = this.tokenCache.get(profileId);
        if (cached && cached.expiresAt > Date.now()) {
            return {
                accessToken: cached.token,
                expiresAt: new Date(cached.expiresAt),
            };
        }
        return null;
    }
    /**
     * Check if token is expired or will expire soon (within 5 minutes)
     * @param expiresAt - Expiry date
     * @returns True if token needs refresh
     */
    needsRefresh(expiresAt) {
        const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;
        return expiresAt.getTime() <= fiveMinutesFromNow;
    }
    /**
     * Clear token cache for a profile
     * @param profileId - Profile ID (optional, clears all if not provided)
     */
    clearCache(profileId) {
        if (profileId) {
            this.tokenCache.delete(profileId);
            logger.info(`🗑️  [Cookie Token] Cleared cache for profile ${profileId}`);
        }
        else {
            this.tokenCache.clear();
            logger.info('🗑️  [Cookie Token] Cleared all token caches');
        }
    }
    /**
     * Validate cookies by attempting to get access token
     * @param cookiesString - Cookie header string
     * @returns True if cookies are valid and can get access token
     */
    async validateCookies(cookiesString) {
        try {
            await this.getAccessTokenFromCookies(cookiesString);
            return true;
        }
        catch (error) {
            logger.error('❌ [Cookie Token] Cookie validation failed:', error);
            return false;
        }
    }
}
export const cookieTokenService = new CookieTokenService();
