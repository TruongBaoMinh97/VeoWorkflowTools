/**
 * Device-level concurrent-profile semaphore (Phase C3).
 *
 * Limits how many DISTINCT profile IDs can be in the captcha-execute →
 * submit-XHR phase at the same time. Above ~3-4 concurrent profiles on one
 * public IP, Google's abuse detection treats the traffic as a click farm
 * even when each profile individually has a good session score.
 *
 * Cross-profile gate (orthogonal to per-profile mint serialisation handled
 * inside captchaManager).
 *
 * Re-entry rule: if the same profileId already holds a slot, the call returns
 * immediately without consuming an extra slot, so jobs for the same profile
 * never starve themselves.
 *
 * Configure via env: CONCURRENT_PROFILE_LIMIT (default 3).
 */
import { logger } from './logger.js';
const MAX_CONCURRENT = Number(process.env.CONCURRENT_PROFILE_LIMIT) || 3;
class ConcurrentProfileLimit {
    constructor() {
        this.active = new Set();
        // Pending: queued but not yet promoted to active. Tracked so that a second
        // acquire() call for the same profile while it's queued doesn't get its own
        // slot (which would corrupt the slot count when both releases fire).
        this.pending = new Set();
        this.queue = [];
    }
    /**
     * Acquire a device-level slot for `profileId`.
     * Returns an idempotent release function that MUST be called when the
     * captcha+submit section ends.
     */
    async acquire(profileId) {
        if (this.active.has(profileId)) {
            logger.debug(`[ConcurrentProfileLimit] ↩️  Re-entry ${profileId.slice(0, 8)} (active: ${this.active.size})`);
            return this.makeRelease(profileId, /* reentrant */ true);
        }
        if (this.pending.has(profileId)) {
            logger.debug(`[ConcurrentProfileLimit] ↩️  Re-queue ${profileId.slice(0, 8)} (already pending)`);
            return this.makeRelease(profileId, /* reentrant */ true);
        }
        if (this.active.size < MAX_CONCURRENT) {
            this.active.add(profileId);
            logger.debug(`[ConcurrentProfileLimit] 🔒 ${profileId.slice(0, 8)} (active: ${this.active.size}/${MAX_CONCURRENT})`);
            return this.makeRelease(profileId, false);
        }
        logger.warn(`[ConcurrentProfileLimit] ⏳ At capacity (${this.active.size}/${MAX_CONCURRENT}) — ` +
            `queuing ${profileId.slice(0, 8)} (depth: ${this.queue.length + 1})`);
        this.pending.add(profileId);
        return new Promise((resolve) => {
            this.queue.push({
                profileId,
                grantSlot: () => {
                    this.pending.delete(profileId);
                    this.active.add(profileId);
                    logger.debug(`[ConcurrentProfileLimit] 🔒 (from queue) ${profileId.slice(0, 8)} ` +
                        `(active: ${this.active.size}/${MAX_CONCURRENT})`);
                    resolve(this.makeRelease(profileId, false));
                },
            });
        });
    }
    makeRelease(profileId, reentrant) {
        let called = false;
        return () => {
            if (called)
                return;
            called = true;
            if (reentrant)
                return;
            this.releaseSlot(profileId);
        };
    }
    releaseSlot(profileId) {
        this.active.delete(profileId);
        if (this.queue.length > 0) {
            const next = this.queue.shift();
            next.grantSlot();
        }
        else {
            logger.debug(`[ConcurrentProfileLimit] 🔓 ${profileId.slice(0, 8)} (active: ${this.active.size}/${MAX_CONCURRENT})`);
        }
    }
    getActiveCount() {
        return this.active.size;
    }
    /** Diagnostic: number of profiles currently waiting for a slot. */
    getQueueDepth() {
        return this.queue.length;
    }
}
export const concurrentProfileLimit = new ConcurrentProfileLimit();
