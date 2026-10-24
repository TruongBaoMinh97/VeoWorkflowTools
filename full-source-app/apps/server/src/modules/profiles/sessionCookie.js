/**
 * Single source of truth for reading the Flow NextAuth session cookie out of a
 * profile partition.
 *
 * A partition can hold SEVERAL copies of `__Secure-next-auth.session-token`:
 * older app builds imported the cookie host-only (`labs.google`), newer ones
 * domain-scoped (`.labs.google`), and `cookies.set()` only overwrites when
 * name+domain+path all match — so both survive with different expiries.
 * `session.cookies.get({})` gives no ordering guarantee, so returning the first
 * match could report a long-dead copy while a live one sat right next to it:
 * that is what made the Profiles tab flash a red "Hết hạn" pill straight after
 * a successful login. The only safe read is "the copy that expires last".
 */
export const SESSION_COOKIE = '__Secure-next-auth.session-token';
/** Hosts that carry the NextAuth session cookie (Google moved Flow in 2026-09). */
export const SESSION_DOMAINS = ['labs.google', 'flow.google.com'];
const EMPTY = {
    expiry: null,
    found: false,
    sessionScopedOnly: false,
    candidates: 0,
};
function isSessionCookieName(name) {
    // NextAuth splits oversized JWTs into `.0` / `.1` chunks.
    return name === SESSION_COOKIE || name.startsWith(`${SESSION_COOKIE}.`);
}
/** Host-only (`labs.google`) or domain-scoped (`.labs.google`) — nothing else. */
export function isSessionCookieDomain(domain) {
    return SESSION_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}
export function readSessionCookie(parsed) {
    if (!parsed)
        return EMPTY;
    let expiry = null;
    let candidates = 0;
    let sawSessionScoped = false;
    for (const entry of parsed) {
        if (!entry || typeof entry !== 'object')
            continue;
        const cookie = entry;
        const name = typeof cookie.name === 'string' ? cookie.name : '';
        const domain = typeof cookie.domain === 'string' ? cookie.domain : '';
        if (!isSessionCookieName(name))
            continue;
        if (!isSessionCookieDomain(domain))
            continue;
        candidates++;
        if (cookie.expirationDate == null) {
            sawSessionScoped = true;
            continue;
        }
        const ms = Math.floor(Number(cookie.expirationDate)) * 1000;
        if (!Number.isFinite(ms) || ms <= 0)
            continue;
        const candidate = new Date(ms);
        if (!expiry || candidate > expiry)
            expiry = candidate;
    }
    return {
        expiry,
        found: candidates > 0,
        sessionScopedOnly: candidates > 0 && expiry === null && sawSessionScoped,
        candidates,
    };
}
/** True when the partition carries a usable labs/flow NextAuth session cookie. */
export function hasSessionCookie(parsed) {
    return readSessionCookie(parsed).found;
}

const GOOGLE_SIGNIN_COOKIES = ['SID', '__Secure-1PSID', '__Secure-3PSID'];

/** True when the partition carries the Google account cookies used by Flow. */
export function hasGoogleSignIn(parsed) {
    if (!parsed)
        return false;
    return parsed.some((entry) => {
        if (!entry || typeof entry !== 'object')
            return false;
        return typeof entry.name === 'string' && GOOGLE_SIGNIN_COOKIES.includes(entry.name);
    });
}

const GOOGLE_LOGIN_EXPIRY_COOKIES = ['__Secure-1PSID', '__Secure-3PSID', 'SID'];

export function readGoogleLoginExpiry(parsed) {
    if (!parsed)
        return EMPTY;
    let expiry = null;
    let candidates = 0;
    let sawSessionScoped = false;
    for (const entry of parsed) {
        if (!entry || typeof entry !== 'object')
            continue;
        if (typeof entry.name !== 'string' || !GOOGLE_LOGIN_EXPIRY_COOKIES.includes(entry.name))
            continue;
        candidates++;
        if (entry.expirationDate == null) {
            sawSessionScoped = true;
            continue;
        }
        const ms = Math.floor(Number(entry.expirationDate)) * 1000;
        if (!Number.isFinite(ms) || ms <= 0)
            continue;
        const candidate = new Date(ms);
        if (!expiry || candidate > expiry)
            expiry = candidate;
    }
    return {
        expiry,
        found: candidates > 0,
        sessionScopedOnly: candidates > 0 && expiry === null && sawSessionScoped,
        candidates,
    };
}

/** Prefer the legacy Labs expiry when present, otherwise use the Google login expiry. */
export function readSessionExpiry(parsed) {
    const legacy = readSessionCookie(parsed);
    return legacy.found ? legacy : readGoogleLoginExpiry(parsed);
}
