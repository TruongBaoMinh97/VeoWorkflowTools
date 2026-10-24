import { isVerificationRejected, verificationRequiredError } from '../services/veo3/verificationFailure.js';

/** One admission gate for image RPCs from every caller in this server. */
export class ProfileImageScheduler {
    constructor({ gapMs = 5000, limit = 2, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
        this.states = new Map();
        this.gapMs = gapMs;
        this.limit = limit;
        this.now = now;
        this.sleep = sleep;
    }
    state(profileId) {
        if (!this.states.has(profileId)) this.states.set(profileId, { active: 0, nextAt: 0, blockedUntil: 0, verification: null, tail: Promise.resolve() });
        return this.states.get(profileId);
    }
    resume(profileId) {
        // Explicit user restart acknowledges verification; never erase traffic cooldown.
        this.state(profileId).verification = null;
    }
    async run(profileId, execute, cancelled = () => false) {
        const state = this.state(profileId);
        const previous = state.tail;
        let release;
        state.tail = new Promise(resolve => { release = resolve; });
        await previous;
        try {
            for (;;) {
                if (cancelled()) throw new Error('Run was cancelled');
                if (state.verification) throw state.verification;
                const wait = Math.max(state.nextAt, state.blockedUntil) - this.now();
                if (state.active < this.limit && wait <= 0) break;
                await this.sleep(Math.min(100, Math.max(1, wait)));
            }
            state.active++;
            state.nextAt = this.now() + this.gapMs;
        } finally { release(); }
        try {
            return await execute();
        } catch (error) {
            if (isVerificationRejected(error)) {
                state.verification = verificationRequiredError(error);
                throw state.verification;
            }
            const text = [error?.message, error?.errorText].join(' ');
            const status = error?.response?.status ?? error?.status;
            if ((status === 429 || /RESOURCE_EXHAUSTED|TOO_MUCH_TRAFFIC/.test(text)) && !/QUOTA_REACHED/.test(text)) {
                const raw = error?.response?.headers?.['retry-after'];
                const seconds = Number(raw);
                const retryMs = raw == null ? 0 : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - this.now();
                state.blockedUntil = Math.max(state.blockedUntil, this.now() + Math.max(120000, Number.isFinite(retryMs) ? retryMs : 0));
            }
            throw error;
        } finally { state.active--; }
    }
}

export const profileImageScheduler = new ProfileImageScheduler();
