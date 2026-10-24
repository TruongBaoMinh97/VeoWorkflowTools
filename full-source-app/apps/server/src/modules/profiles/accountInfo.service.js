/**
 * accountInfo.service.ts
 * Fetches per-profile Veo3 account info (paygate tier, credits, real session
 * expiry) from Google's GET /v1/credits endpoint and caches it on the Profile
 * row so the Profiles tab can render instantly from the DB.
 */
import { prisma } from '../../lib/prisma.js';
import { Veo3Service } from '../../services/veo3/veo3Service.js';
import { getProfileCookiesCompat } from '../../utils/profileCookies.js';
import { readSessionExpiry } from './sessionCookie.js';
import { logger } from '../../lib/logger.js';
const SEMAPHORE_WIDTH = 3;
const STAGGER_MS = 400;
const CACHE_TTL_MS = 5 * 60 * 1000;
/**
 * Error text that genuinely means "this session is no longer accepted".
 * Matched case-insensitively. Deliberately narrow: the previous `hết hạn`
 * substring also matched quota copy like "hết hạn mức", turning a rate-limit
 * into a red "session expired" badge.
 */
const AUTH_FAILURE_PATTERNS = [
    'unauthenticated',
    'session cookie missing or expired',
    'phiên đăng nhập google đã hết hạn',
    'access token đã hết hạn',
    'cookies đã hết hạn',
    'cookies/token đã hết hạn',
];
const QUOTA_FAILURE_PATTERNS = ['resource_exhausted', 'quota', 'hết hạn mức'];
export function resolveDisplayTier(r) {
    if (r.userPaygateTier === 'PAYGATE_TIER_TWO')
        return 'ultra';
    if (r.userPaygateTier === 'PAYGATE_TIER_ONE')
        return 'pro';
    if ((r.sku || '').includes('TIER2'))
        return 'ultra';
    if ((r.sku || '').includes('TIER1'))
        return 'pro';
    if (r.serviceTier === 'SERVICE_TIER_ADVANCED')
        return 'ultra';
    if (r.serviceTier === 'SERVICE_TIER_STANDARD')
        return 'pro';
    return 'free';
}
function rawTierToDisplay(raw, fetched) {
    if (raw === 'PAYGATE_TIER_TWO')
        return 'ultra';
    if (raw === 'PAYGATE_TIER_ONE')
        return 'pro';
    // A completed fetch with no recognizable tier means a free account; no fetch
    // yet means we simply don't know.
    return fetched ? 'free' : null;
}
function extractProxyConfig(profile) {
    if (!profile?.proxyHost || !profile?.proxyPort)
        return undefined;
    return {
        proxyHost: profile.proxyHost,
        proxyPort: profile.proxyPort,
        proxyUsername: profile.proxyUsername ?? null,
        proxyPassword: profile.proxyPassword ?? null,
    };
}
function createSemaphore(width) {
    let running = 0;
    const queue = [];
    return async function run(fn) {
        if (running >= width) {
            await new Promise((resolve) => queue.push(resolve));
        }
        running++;
        try {
            await fn();
        }
        finally {
            running--;
            queue.shift()?.();
        }
    };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Last-known values from the DB row, used for TTL hits and error fallbacks. */
function cachedInfo(profile, errorCode, error, overrides) {
    const fetched = profile.creditsUpdatedAt != null;
    // `undefined` = no override (keep the DB value); an explicit `null` clears it.
    const session = overrides?.sessionExpiresAt !== undefined ? overrides.sessionExpiresAt : profile.sessionExpiresAt;
    const jwt = overrides?.accessTokenExpires ?? profile.accessTokenExpires;
    return {
        profileId: profile.id,
        tier: rawTierToDisplay(profile.paygateTier, fetched),
        credits: profile.credits ?? null,
        subscriptionCredits: profile.subscriptionCredits ?? null,
        sessionExpiresAt: session ? new Date(session).toISOString() : null,
        accessTokenExpires: jwt ? new Date(jwt).toISOString() : null,
        creditsUpdatedAt: profile.creditsUpdatedAt ? new Date(profile.creditsUpdatedAt).toISOString() : null,
        errorCode,
        error,
        sessionScopedOnly: overrides?.sessionScopedOnly ?? false,
    };
}
/**
 * Refresh tier / credits / session expiry for one profile.
 * Never throws — every failure surfaces via errorCode while keeping the
 * last-known cached values so the UI can degrade gracefully.
 */
export async function refreshProfileAccountInfo(profileId, opts = {}) {
    try {
        const profile = await prisma.profile.findUnique({ where: { id: profileId } });
        if (!profile) {
            return {
                profileId,
                tier: null,
                credits: null,
                subscriptionCredits: null,
                sessionExpiresAt: null,
                accessTokenExpires: null,
                creditsUpdatedAt: null,
                errorCode: 'NETWORK',
                error: 'Profile not found',
                sessionScopedOnly: false,
            };
        }
        if (!opts.force && profile.creditsUpdatedAt) {
            const ageMs = Date.now() - new Date(profile.creditsUpdatedAt).getTime();
            if (ageMs < CACHE_TTL_MS) {
                logger.debug(`[AccountInfo] cache hit ${profileId.substring(0, 8)}: age=${Math.round(ageMs / 1000)}s ` +
                    `session=${profile.sessionExpiresAt ? new Date(profile.sessionExpiresAt).toISOString() : 'n/a'}`);
                // No stored expiry may mean "session-scoped cookie", which the card
                // renders as healthy — that fact lives only in the cookie, so re-read it
                // (local IPC, no Google call) instead of degrading to "no data".
                const scopedOnly = profile.sessionExpiresAt == null
                    ? readSessionExpiry((await getProfileCookiesCompat(profile)).parsed).sessionScopedOnly
                    : false;
                return cachedInfo(profile, null, null, { sessionScopedOnly: scopedOnly });
            }
        }
        const { cookies, hasCookies, parsed } = await getProfileCookiesCompat(profile);
        if (!hasCookies || !cookies) {
            return cachedInfo(profile, 'NO_COOKIES', 'No cookies in partition');
        }
        // Real session expiry, read before any network call. `parsed === null`
        // means the cookie payload was unreadable (bridge down / corrupt snapshot)
        // — in that case we must NOT let the read touch the stored expiry.
        const sessionCookie = readSessionExpiry(parsed);
        const cookiesReadable = parsed !== null;
        if (sessionCookie.candidates > 1) {
            logger.warn(`[AccountInfo] ${profileId.substring(0, 8)}: ${sessionCookie.candidates} session-token cookies in partition ` +
                `— using latest expiry ${sessionCookie.expiry?.toISOString() ?? 'n/a'}`);
        }
        // Flow 1.8.9 authenticates this request with Google cookies. The retired
        // labs.google auth/session endpoint no longer supplies a ya29 token.
        const accessTokenExpires = null;
        const provider = new Veo3Service({
            cookies,
            profileId,
            proxyConfig: extractProxyConfig(profile),
        });
        let creditsResp;
        try {
            creditsResp = await provider.getCredits();
        }
        catch (err) {
            const msg = err?.errorText || err?.message || String(err);
            const status = err?.response?.status ?? err?.statusCode ?? err?.status ?? 0;
            // NOTE: no fallback to cookieTokenService.getCachedToken().expiresAt for
            // the SESSION expiry — that value is the JWT TTL, not the NextAuth session
            // expiry, and would show a scary short countdown on a multi-day session.
            // Persist what the cookies actually say — including null, which clears a
            // stale past value. Skipped entirely when the cookies were unreadable.
            if (cookiesReadable) {
                await prisma.profile
                    .update({ where: { id: profileId }, data: { sessionExpiresAt: sessionCookie.expiry } })
                    .catch((dbErr) => {
                    logger.warn(`[AccountInfo] Failed to persist sessionExpiresAt for ${profileId.substring(0, 8)}: ${dbErr?.message ?? dbErr}`);
                });
            }
            // An HTTP status is unambiguous, so it outranks any message matching.
            const lower = msg.toLowerCase();
            let errorCode = 'NETWORK';
            if (err?.code === 'FLOW_SIGNED_OUT' || status === 401) {
                errorCode = 'UNAUTHORIZED';
            }
            else if (status === 429) {
                errorCode = 'QUOTA_EXCEEDED';
            }
            else if (QUOTA_FAILURE_PATTERNS.some((p) => lower.includes(p))) {
                errorCode = 'QUOTA_EXCEEDED';
            }
            else if (AUTH_FAILURE_PATTERNS.some((p) => lower.includes(p))) {
                errorCode = 'UNAUTHORIZED';
            }
            return cachedInfo(profile, errorCode, msg.slice(0, 500), {
                sessionExpiresAt: cookiesReadable ? sessionCookie.expiry : undefined,
                accessTokenExpires,
                sessionScopedOnly: sessionCookie.sessionScopedOnly,
            });
        }
        const tier = resolveDisplayTier(creditsResp);
        const now = new Date();
        await prisma.profile.update({
            where: { id: profileId },
            data: {
                paygateTier: creditsResp.userPaygateTier || null,
                credits: creditsResp.credits ?? null,
                subscriptionCredits: creditsResp.subscriptionCredits ?? null,
                creditsUpdatedAt: now,
                accessTokenExpires: null,
                // Write what the cookies say, null included — a stale past value has to
                // be cleared or the 5-minute cache keeps replaying it as "expired".
                ...(cookiesReadable ? { sessionExpiresAt: sessionCookie.expiry } : {}),
            },
        });
        // Only fall back to the stored value when the cookies were unreadable.
        const reportedSession = cookiesReadable ? sessionCookie.expiry : (profile.sessionExpiresAt ?? null);
        logger.info(`[AccountInfo] ${profileId.substring(0, 8)} tier=${tier} credits=${creditsResp.credits} session=${reportedSession ? new Date(reportedSession).toISOString() : 'n/a'} jwt=${accessTokenExpires ? new Date(accessTokenExpires).toISOString() : 'n/a'}`);
        return {
            profileId,
            tier,
            credits: creditsResp.credits ?? null,
            subscriptionCredits: creditsResp.subscriptionCredits ?? null,
            sessionExpiresAt: reportedSession ? new Date(reportedSession).toISOString() : null,
            accessTokenExpires: accessTokenExpires ? new Date(accessTokenExpires).toISOString() : null,
            creditsUpdatedAt: now.toISOString(),
            errorCode: null,
            error: null,
            sessionScopedOnly: sessionCookie.sessionScopedOnly,
        };
    }
    catch (err) {
        const msg = err?.message ?? String(err);
        logger.warn(`[AccountInfo] Unexpected error for ${profileId.substring(0, 8)}: ${msg}`);
        return {
            profileId,
            tier: null,
            credits: null,
            subscriptionCredits: null,
            sessionExpiresAt: null,
            accessTokenExpires: null,
            creditsUpdatedAt: null,
            errorCode: 'NETWORK',
            error: msg,
            sessionScopedOnly: false,
        };
    }
}
/**
 * Refresh many profiles (all active ones when profileIds is omitted) with a
 * 3-wide semaphore and an initial stagger so Google never sees a burst.
 */
export async function refreshManyProfileAccountInfo(profileIds, force = false) {
    // Explicit [] means "refresh nothing" — only an omitted list means "all active".
    const profiles = profileIds !== undefined
        ? await prisma.profile.findMany({ where: { id: { in: profileIds } } })
        : await prisma.profile.findMany({ where: { active: true } });
    if (profiles.length === 0)
        return [];
    const sem = createSemaphore(SEMAPHORE_WIDTH);
    const results = new Array(profiles.length);
    await Promise.allSettled(profiles.map((p, idx) => (async () => {
        // Cap the stagger at (width-1)*STAGGER so high-index profiles also wait
        // before competing for slots; otherwise idx>=width grab slots at t=0
        // and the burst the stagger exists to prevent still happens.
        const delay = Math.min(idx, SEMAPHORE_WIDTH - 1) * STAGGER_MS;
        if (delay > 0)
            await sleep(delay);
        await sem(async () => {
            results[idx] = await refreshProfileAccountInfo(p.id, { force });
        });
    })()));
    return results;
}
