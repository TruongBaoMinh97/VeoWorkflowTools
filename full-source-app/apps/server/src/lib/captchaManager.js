// Mints serialised through a global mutex so the one Chrome tab never runs two
// grecaptcha.enterprise.execute calls in parallel (Google scores parallel mints
// from the same page as bot). Submit/poll above this layer is concurrent.
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { CaptchaError } from './errors.js';
import { cdpMint, cdpReset, getCaptchaProvider } from './captchaProvider.js';
const MAX_PENDING_WAITERS = 16;
const SOFT_RESET_THRESHOLD = 3;
const HARD_RESET_THRESHOLD = 7;
const EXTENSION_FRESH_MS = 30000;
const EXTENSION_STALE_MS = 120000;
class Mutex {
    constructor() {
        this.chain = Promise.resolve();
    }
    acquire(fn) {
        const run = this.chain.then(fn);
        this.chain = run.then(() => undefined, () => undefined);
        return run;
    }
}
function parsePositiveInt(value, fallback) {
    if (!value)
        return fallback;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
class CaptchaManager {
    constructor() {
        this.mintLock = new Mutex();
        this.pending = new Map();
        this.queue = [];
        this.waiters = [];
        this.consecutiveFailures = 0;
        this.pendingReset = null;
        this.lastExtensionSeenAt = null;
        // Whether the extension reported a Flow AI tab open in its last heartbeat.
        // Field added in extension v1.5+ — older heartbeats leave it null (unknown).
        // Stale (>2 min) heartbeats also collapse to null so the renderer doesn't
        // trust a tab status from a dead extension.
        this.lastHasFlowTab = null;
        this.lastHasFlowTabAt = null;
        this.extensionVersion = null;
        this.lastMintAt = null;
        this.lastMintDurationMs = null;
        this.mintTimeoutMs = parsePositiveInt(process.env.CAPTCHA_TIMEOUT_MS, 60000);
    }
    async requestToken(action) {
        return this.mintLock.acquire(() => getCaptchaProvider() === 'cdp' ? this.mintViaCdp(action) : this.mintOnce(action));
    }
    async drainCommands(maxWaitMs) {
        const reset = this.consumePendingReset();
        if (reset)
            return [reset];
        if (this.queue.length > 0)
            return this.queue.splice(0);
        if (this.waiters.length >= MAX_PENDING_WAITERS) {
            logger.warn(`[captcha] poller waiters cap reached (${this.waiters.length}), returning empty`);
            return [];
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const idx = this.waiters.findIndex((w) => w.timer === timer);
                if (idx >= 0)
                    this.waiters.splice(idx, 1);
                resolve([]);
            }, maxWaitMs);
            this.waiters.push({ resolve, timer });
        });
    }
    resolveCommand(payload) {
        const entry = this.pending.get(payload.commandId);
        if (!entry)
            return false;
        clearTimeout(entry.timer);
        this.pending.delete(payload.commandId);
        if (payload.error) {
            entry.reject(new CaptchaError(`Captcha mint failed: ${payload.error}`, {
                code: 'CAPTCHA_FAILED',
                retryable: true,
            }));
            return true;
        }
        if (!payload.token) {
            entry.reject(new CaptchaError('Captcha mint returned empty token', {
                code: 'CAPTCHA_EMPTY',
                retryable: true,
            }));
            return true;
        }
        entry.resolve(payload.token);
        return true;
    }
    notifySuccess() {
        this.consecutiveFailures = 0;
        this.pendingReset = null;
    }
    notifyFailure() {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= HARD_RESET_THRESHOLD) {
            if (this.pendingReset !== 'hard_reset') {
                logger.warn(`[captcha] escalating to hard_reset (failures=${this.consecutiveFailures})`);
                this.pendingReset = 'hard_reset';
                this.signalWaiters();
            }
            return;
        }
        if (this.consecutiveFailures >= SOFT_RESET_THRESHOLD &&
            this.pendingReset === null) {
            logger.warn(`[captcha] scheduling soft_reset (failures=${this.consecutiveFailures})`);
            this.pendingReset = 'soft_reset';
            this.signalWaiters();
        }
    }
    /**
     * Called when the API CONFIRMS the reCAPTCHA score is dead
     * (PUBLIC_ERROR_UNUSUAL_ACTIVITY / "evaluation failed"). Unlike notifyFailure(),
     * this skips the 3/7 consecutive-failure ladder and schedules a hard_reset
     * immediately, so the extension clears the _GRECAPTCHA anchor + reloads the
     * Flow tab on the very first 403 instead of after 3–7 failed jobs.
     */
    notifyRecaptchaScoreDead() {
        this.consecutiveFailures = Math.max(this.consecutiveFailures, HARD_RESET_THRESHOLD);
        if (this.pendingReset !== 'hard_reset') {
            logger.warn('[captcha] reCAPTCHA score dead → immediate hard_reset (bypassing 3/7 ladder)');
            this.pendingReset = 'hard_reset';
            this.signalWaiters();
        }
    }
    // pendingReset is intentionally NOT cleared on `extension_ready` — only by
    // consumePendingReset() (real delivery) or notifySuccess() (real recovery).
    // An extension restart mid-degradation would otherwise drop the queued reset.
    recordExtensionHeartbeat(payload) {
        this.lastExtensionSeenAt = Date.now();
        if (typeof payload.version === 'string' && payload.version.length > 0) {
            this.extensionVersion = payload.version;
        }
        if (typeof payload.hasFlowTab === 'boolean') {
            this.lastHasFlowTab = payload.hasFlowTab;
            this.lastHasFlowTabAt = Date.now();
        }
    }
    stats() {
        return {
            provider: getCaptchaProvider(),
            pendingCount: this.pending.size,
            queuedCount: this.queue.length,
            pollerWaitingCount: this.waiters.length,
            consecutiveFailures: this.consecutiveFailures,
            pendingReset: this.pendingReset,
            lastExtensionSeenAt: this.lastExtensionSeenAt,
            extensionVersion: this.extensionVersion,
            lastMintAt: this.lastMintAt,
            lastMintDurationMs: this.lastMintDurationMs,
            mintTimeoutMs: this.mintTimeoutMs,
            hasFlowTab: this.flowTabPresent(),
        };
    }
    extensionLiveness() {
        if (this.lastExtensionSeenAt === null)
            return 'offline';
        const age = Date.now() - this.lastExtensionSeenAt;
        if (age < EXTENSION_FRESH_MS)
            return 'connected';
        if (age < EXTENSION_STALE_MS)
            return 'stale';
        return 'offline';
    }
    // Returns the last reported Flow AI tab presence, or null if:
    //   - extension never reported (older build pre-v1.5 or just bootstrapped)
    //   - last report is stale (>2 min) — extension may have died
    flowTabPresent() {
        if (this.lastHasFlowTab === null || this.lastHasFlowTabAt === null)
            return null;
        if (Date.now() - this.lastHasFlowTabAt > EXTENSION_STALE_MS)
            return null;
        return this.lastHasFlowTab;
    }
    /**
     * Provider 'cdp': Electron mints directly, so there is no poll queue and no
     * command id. Resets cannot wait for a poller to pick them up either — they
     * are applied inline, before the mint they were scheduled for.
     */
    async mintViaCdp(action) {
        const startedAt = Date.now();
        const reset = this.consumePendingReset();
        if (reset) {
            const kind = reset.method;
            try {
                await cdpReset(kind);
                logger.info(`[captcha] cdp ${kind} applied before mint`);
            }
            catch (err) {
                // A failed reset must not eat the mint: reschedule so the ladder keeps
                // escalating instead of silently forgetting the reset.
                this.pendingReset = kind;
                logger.warn(`[captcha] cdp ${kind} failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        try {
            const token = await cdpMint(action);
            const durationMs = Date.now() - startedAt;
            this.lastMintAt = Date.now();
            this.lastMintDurationMs = durationMs;
            logger.debug(`[captcha] cdp minted action=${action} duration=${durationMs}ms`);
            return { token, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`[captcha] cdp mint failed action=${action} err=${msg}`);
            throw err;
        }
    }
    async mintOnce(action) {
        const commandId = randomUUID();
        const startedAt = Date.now();
        try {
            const token = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.pending.delete(commandId);
                    // Strip the not-yet-drained command so a future poll can't dequeue a ghost mint.
                    const queueIdx = this.queue.findIndex((c) => c.commandId === commandId);
                    if (queueIdx >= 0)
                        this.queue.splice(queueIdx, 1);
                    reject(new CaptchaError('Captcha bridge timeout — is the Chrome extension running and Flow tab open?', { code: 'CAPTCHA_TIMEOUT', retryable: true }));
                }, this.mintTimeoutMs);
                this.pending.set(commandId, { resolve, reject, timer, startedAt, action });
                this.queue.push({ commandId, method: 'get_captcha', action });
                this.signalWaiters();
            });
            const durationMs = Date.now() - startedAt;
            this.lastMintAt = Date.now();
            this.lastMintDurationMs = durationMs;
            logger.debug(`[captcha] minted action=${action} duration=${durationMs}ms commandId=${commandId}`);
            return { token, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`[captcha] mint failed action=${action} commandId=${commandId} err=${msg}`);
            throw err;
        }
    }
    consumePendingReset() {
        if (!this.pendingReset)
            return null;
        const kind = this.pendingReset;
        this.pendingReset = null;
        return { commandId: `reset-${randomUUID()}`, method: kind };
    }
    signalWaiters() {
        if (this.waiters.length === 0)
            return;
        const reset = this.consumePendingReset();
        if (reset) {
            const waiter = this.waiters.shift();
            clearTimeout(waiter.timer);
            waiter.resolve([reset]);
            return;
        }
        if (this.queue.length === 0)
            return;
        const commands = this.queue.splice(0);
        const waiter = this.waiters.shift();
        clearTimeout(waiter.timer);
        waiter.resolve(commands);
    }
}
export const captchaManager = new CaptchaManager();
