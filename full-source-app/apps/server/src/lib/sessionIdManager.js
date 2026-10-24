/**
 * Per-(profile, veo3Project) sessionId manager.
 *
 * Google Flow API (`flowMedia:batchGenerateImages`, `video:batchAsyncGenerateVideoText`,
 * `flow/upsampleImage`...) nh\u1eadn field `clientContext.sessionId` format
 * `";{timestamp}"`. Real browser **gi\u1eef nguy\u00ean** sessionId xuy\u00ean su\u1ed1t browser session
 * tr\u00ean c\u00f9ng 1 tab/project. M\u1ed7i tab/project tr\u00ean labs.google c\u00f3 sessionId
 * ri\u00eang, nh\u01b0ng trong c\u00f9ng 1 tab/project th\u00ec sessionId \u1ed5n \u0111\u1ecbnh.
 *
 * Tr\u01b0\u1edbc \u0111\u00e2y code d\u00f9ng `;${Date.now()}` m\u1ed7i call \u2192 sessionId \u0111\u1ed5i m\u1ed7i request \u2192
 * Google coi m\u1ed7i job = 1 session m\u1edbi \u2192 suspicious \u2192 flag bot.
 *
 * Manager n\u00e0y key theo (profileId, veo3ProjectId):
 *  - Sinh sessionId 1 l\u1ea7n per c\u1eb7p, l\u01b0u in-memory
 *  - Reset khi browser force-recreate ho\u1eb7c TTL h\u1ebft (default 1 gi\u1edd \u2014 kh\u1edbp v\u1edbi
 *    recaptcha browser MAX_BATCHES_PER_BROWSER)
 *  - Reset c\u00f3 th\u1ec3 theo profile (tất c\u1ea3 project của profile) ho\u1eb7c theo c\u1eb7p
 */
import { logger } from './logger.js';
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour matches browser recreate cadence
/**
 * sessionId rotation mode (DEFAULT: rotate). When rotating, `get()` returns a
 * FRESH `;${Date.now()}` on every call instead of the cached stable value —
 * i.e. a new sessionId per batch (get() is called once per batch, so the 4 POSTs
 * of a batch still share one sessionId + one batchId; only successive batches
 * differ).
 *
 * Empirically this ELIMINATES the reCAPTCHA 403 cliff (PUBLIC_ERROR_UNUSUAL_ACTIVITY):
 * validated across 220 jobs (72 + 148) with 0 × 403 at K=3/concurrency=8, the exact
 * config that tripped a 403 at batch idx=20 under the old stable-per-hour mode. The
 * remaining 429 (RESOURCE_EXHAUSTED) is a per-account/project quota, not per-session,
 * so rotation cannot help it — but it is transient/self-healing via the existing 30s
 * backoff (148/148 jobs completed, 0 permanent failures).
 *
 * Note: this rotates ONLY the clientContext.sessionId field. The _GRECAPTCHA anchor,
 * device fingerprint, IP, and the minted token's grecaptcha session stay shared
 * (single-browser) — that is fine because 403 is driven by per-sessionId velocity,
 * which a fresh id per batch keeps low.
 *
 * Set `VEO3_SESSION_ID_MODE=stable` (or `fixed`/`off`) to revert to the old
 * stable-per-hour behavior for comparison.
 */
function rotatePerCall() {
    const mode = (process.env.VEO3_SESSION_ID_MODE ?? '').toLowerCase();
    if (mode === 'stable' || mode === 'fixed' || mode === 'off')
        return false;
    return true; // default: rotate per batch
}
class SessionIdManager {
    constructor(ttlMs = DEFAULT_TTL_MS) {
        this.sessions = new Map();
        this.ttlMs = ttlMs;
    }
    makeKey(profileId, veo3ProjectId) {
        return veo3ProjectId ? `${profileId}::${veo3ProjectId}` : `${profileId}::_default`;
    }
    /**
     * Get or create a sessionId for the given (profile, veo3Project).
     * C\u00f9ng c\u1eb7p tr\u1ea3 c\u00f9ng sessionId t\u1edbi khi TTL h\u1ebft ho\u1eb7c reset().
     * N\u1ebfu kh\u00f4ng truy\u1ec1n veo3ProjectId, fallback v\u1ec1 key "_default" per profile.
     */
    get(profileId, veo3ProjectId) {
        const now = Date.now();
        // EXPERIMENT: fresh sessionId every call (\u2248 per batch), never cached.
        if (rotatePerCall()) {
            const sessionId = `;${now}`;
            logger.info(`[SessionIdManager] \ud83d\udd01 ROTATE mode: fresh sessionId for profile ${profileId.substring(0, 8)}... veo3Project=${veo3ProjectId ? veo3ProjectId.substring(0, 8) : '(none)'}: ${sessionId}`);
            return sessionId;
        }
        const key = this.makeKey(profileId, veo3ProjectId);
        const existing = this.sessions.get(key);
        if (existing && now - existing.createdAt < this.ttlMs) {
            return existing.sessionId;
        }
        const sessionId = `;${now}`;
        this.sessions.set(key, { sessionId, createdAt: now });
        logger.info(`[SessionIdManager] \ud83c\udd95 New sessionId for profile ${profileId.substring(0, 8)}... veo3Project=${veo3ProjectId ? veo3ProjectId.substring(0, 8) : '(none)'}: ${sessionId}`);
        return sessionId;
    }
    /**
     * Reset sessionId cho 1 c\u1eb7p (profile, project) c\u1ee5 th\u1ec3.
     */
    resetPair(profileId, veo3ProjectId) {
        const key = this.makeKey(profileId, veo3ProjectId);
        if (this.sessions.delete(key)) {
            logger.info(`[SessionIdManager] \ud83d\udd04 Reset sessionId pair ${profileId.substring(0, 8)}... / ${veo3ProjectId ? veo3ProjectId.substring(0, 8) : '(none)'}`);
        }
    }
    /**
     * Reset t\u1ea5t c\u1ea3 sessionId thu\u1ed9c 1 profile (d\u00f9ng khi browser force-recreate \u2014
     * session entropy reset to\u00e0n b\u1ed9 profile bao g\u1ed3m m\u1ecdi project).
     */
    reset(profileId) {
        const prefix = `${profileId}::`;
        let removed = 0;
        for (const k of Array.from(this.sessions.keys())) {
            if (k.startsWith(prefix)) {
                this.sessions.delete(k);
                removed++;
            }
        }
        if (removed > 0) {
            logger.info(`[SessionIdManager] \ud83d\udd04 Reset ${removed} sessionId(s) for profile ${profileId.substring(0, 8)}...`);
        }
    }
    /**
     * Clear all sessions (on app shutdown).
     */
    clear() {
        this.sessions.clear();
    }
}
export const sessionIdManager = new SessionIdManager();
