/**
 * Per-profile, URL-scoped cookie cache for tlsFetch.
 *
 * Chrome owns cookie truth (user logs in there, Chrome rotates session tokens
 * frequently). We pull via CDP `Network.getAllCookies` (IPC endpoint
 * `/profile/:id/chrome-cookies`) once per `SYNC_INTERVAL_MS` and cache the
 * full cookie list. Each `getCookieHeader(profileId, url)` call rebuilds a
 * minimal `Cookie:` header containing ONLY:
 *
 *   1. Cookies in the strict allow-list below (auth essentials)
 *   2. Whose `domain` attribute matches the request URL host
 *
 * Why so strict: Google's tRPC + aisandbox-pa endpoints reject requests with
 * a Cookie header > ~4KB (HTTP 431 "Request Header Fields Too Large"). The
 * profile's Chrome may have 50-100+ cookies across google.com / accounts /
 * youtube / labs / etc. — sending all of them blows past the limit and is
 * also useless (most are analytics / preference cookies that the API server
 * ignores).
 *
 * If anything else turns out to be required, add it explicitly to
 * `ESSENTIAL_COOKIE_NAMES` — no wildcard `__Secure-` matching to avoid
 * accidentally pulling in YouTube / Maps / Calendar session cookies.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { getProfileCookies } from '../utils/profileCookies.js';
import { fetchIpcBridge } from './ipcBridgeFetch.js';
import { logger } from './logger.js';
const SYNC_INTERVAL_MS = 30000;
/**
 * Minimal cookie set required by Flow + aisandbox-pa.
 *
 * Two account types must be supported:
 *
 *   1. Consumer (@gmail.com) — full 1P + 3P SID cookie tree, advanced
 *      session trust cookies (`__Secure-1PSIDTS`, `__Secure-3PSIDTS`).
 *
 *   2. Workspace (user@company.com) — issued through the Workspace SSO flow
 *      (`accounts.google.com/o/oauth2/...`). Workspace sessions ship a
 *      different cookie set:
 *        - `LSID`, `LSOSID`, `OSID`, `__Secure-OSID` — Workspace SSO state
 *        - `S` — session continuation token
 *        - `SIDCC` — SID continuation cookie (Workspace variant)
 *        - `OGPC`, `OGP` — One Google Pass (Workspace cross-app session)
 *        - `ACCOUNT_CHOOSER` — multi-account selector state
 *      Without these in the allow-list, Workspace requests to labs.google
 *      TRPC + auth/session endpoints lack the canonical session state and
 *      Google's NextAuth returns `{}` (logged-out shape).
 *
 *   3. Tracking / continuity (sent by both):
 *        - `NID`, `1P_JAR`, `3P_JAR`, `AEC`, `__Secure-ENID`, `CONSENT`
 *        - `SOCS` (privacy choices), `__Secure-OSID`
 *
 *   4. next-auth session (labs.google only):
 *        - `__Secure-next-auth.session-token`
 *        - `__Secure-next-auth.callback-url`
 *        - `__Host-next-auth.csrf-token`
 *
 * If anything else turns out to be required, add it explicitly here — no
 * wildcard `__Secure-*` matching (that would accidentally pull in
 * YouTube / Maps / Calendar session cookies and overflow the 4KB header).
 */
export const ESSENTIAL_COOKIE_NAMES = new Set([
    // Core Google auth (consumer + workspace)
    'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
    // First-party SID family (consumer accounts)
    '__Secure-1PSID', '__Secure-1PAPISID', '__Secure-1PSIDTS', '__Secure-1PSIDCC',
    // Third-party SID family (consumer + workspace cross-app)
    '__Secure-3PSID', '__Secure-3PAPISID', '__Secure-3PSIDTS', '__Secure-3PSIDCC',
    // Workspace SSO essentials
    'LSID', 'LSOSID', 'OSID', 'S',
    '__Secure-OSID',
    'SIDCC',
    'OGPC', 'OGP',
    'ACCOUNT_CHOOSER',
    // Tracking / continuity (used by both flows for session score)
    'NID', '1P_JAR', '3P_JAR', 'AEC',
    '__Secure-ENID',
    'CONSENT', 'SOCS',
    // next-auth (labs.google only)
    '__Secure-next-auth.session-token',
    '__Secure-next-auth.callback-url',
    '__Host-next-auth.csrf-token',
]);
const jarByProfile = new Map();
const inFlight = new Map();
function normalizeDomain(domain) {
    if (!domain)
        return '';
    return domain.startsWith('.') ? domain.slice(1).toLowerCase() : domain.toLowerCase();
}
/**
 * Returns true if `cookieDomain` should match a request to `requestHost`.
 * Mirrors RFC 6265 §5.1.3 in the strict subset Google uses (suffix match).
 */
function domainMatches(cookieDomain, requestHost) {
    if (!cookieDomain)
        return false;
    const host = requestHost.toLowerCase();
    const cd = cookieDomain.toLowerCase();
    if (host === cd)
        return true;
    return host.endsWith(`.${cd}`);
}
function parseRawCookiesToList(raw) {
    if (!raw)
        return [];
    // JSON array shape (Chrome extension export / CDP getAllCookies).
    try {
        const parsed = JSON.parse(raw.trim());
        if (Array.isArray(parsed)) {
            return parsed
                .filter((c) => c?.name && c?.value !== undefined)
                .map((c) => ({
                name: String(c.name),
                value: String(c.value),
                domain: normalizeDomain(c.domain),
                path: String(c.path || '/'),
            }));
        }
    }
    catch {
        /* not JSON — treat as a header string with no domain info */
    }
    // Fall back: cookie header string. No domain info → mark as wildcard domain
    // (will pass domainMatches against any host). This is the legacy path used
    // when Chrome is offline and we read from the Electron partition.
    const pairs = raw.split(';').map((p) => p.trim()).filter(Boolean);
    return pairs
        .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq < 0)
            return null;
        return {
            name: pair.slice(0, eq),
            value: pair.slice(eq + 1),
            domain: '', // unknown → matches any host
            path: '/',
        };
    })
        .filter((c) => c !== null);
}
async function fetchChromeCookieList(profileId) {
    // Try LIVE Chrome via the dedicated endpoint first.
    try {
        const res = await fetchIpcBridge(`/profile/${profileId}/chrome-cookies`, {
            method: 'GET',
            signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
            const data = (await res.json());
            if (data.success && data.cookies) {
                return parseRawCookiesToList(data.cookies);
            }
        }
    }
    catch {
        /* Chrome not running yet — fall back to Electron partition */
    }
    // Fallback: legacy Electron persist partition (will likely be missing
    // labs.google's next-auth.session-token, but useful during cold-start
    // before Chrome spawns).
    try {
        const raw = await getProfileCookies(profileId);
        return parseRawCookiesToList(raw);
    }
    catch {
        return [];
    }
}
function buildCookieHeader(cookies, url) {
    let host;
    try {
        host = new URL(url).host.toLowerCase();
    }
    catch {
        return '';
    }
    const matches = cookies.filter((c) => {
        if (!ESSENTIAL_COOKIE_NAMES.has(c.name))
            return false;
        // Empty domain → unknown (legacy header-string fallback) → accept
        if (!c.domain)
            return true;
        return domainMatches(c.domain, host);
    });
    // Deduplicate by name (multiple domains may register the same cookie name —
    // e.g. SID on both .google.com and .accounts.google.com). Prefer the most
    // specific domain match (longest cookieDomain).
    const byName = new Map();
    for (const c of matches) {
        const existing = byName.get(c.name);
        if (!existing || c.domain.length > existing.domain.length) {
            byName.set(c.name, c);
        }
    }
    return Array.from(byName.values())
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
}
/**
 * Returns a `Cookie:` header string for the given profile + request URL.
 * The header is built fresh per call but the underlying cookie list is
 * cached per profile for `SYNC_INTERVAL_MS`.
 */
export async function getCookieHeader(profileId, url) {
    const cached = jarByProfile.get(profileId);
    const fresh = cached && Date.now() - cached.fetchedAt < SYNC_INTERVAL_MS;
    if (fresh) {
        return buildCookieHeader(cached.cookies, url);
    }
    const existing = inFlight.get(profileId);
    const promise = existing ??
        (async () => {
            try {
                const cookies = await fetchChromeCookieList(profileId);
                jarByProfile.set(profileId, { cookies, fetchedAt: Date.now() });
                if (cookies.length === 0) {
                    logger.warn(`[CookieJar] ${profileId.slice(0, 8)} no cookies returned — login required?`);
                }
                return cookies;
            }
            catch (e) {
                logger.warn(`[CookieJar] ${profileId.slice(0, 8)} pull failed: ${e?.message || e}`);
                return cached?.cookies ?? [];
            }
            finally {
                inFlight.delete(profileId);
            }
        })();
    inFlight.set(profileId, promise);
    const cookies = await promise;
    return buildCookieHeader(cookies, url);
}
/** Force a refresh on next call. */
export function invalidateCookieJar(profileId) {
    jarByProfile.delete(profileId);
}
