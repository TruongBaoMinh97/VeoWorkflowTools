/**
 * Read/write gate between "units that must keep one egress IP" and a proxy rotation.
 *
 * Google scores a reCAPTCHA token against the IP that minted it, so a token minted on IP A and
 * sent from IP B can be refused. Code that mints and then sends wraps the pair in `hold()`; a
 * rotation wraps the actual switch in `exclusive()`, which stops new units, waits for the running
 * ones and only then switches. Units are not re-entrant: do not call `hold()` inside `hold()`.
 */
export class ProxyGate {
    constructor() {
        this.active = 0;
        /** Exclusive sections queued or running; counted at call time so a unit started right after cannot slip in. */
        this.pendingExclusives = 0;
        this.releaseWaiters = [];
        this.drainWaiters = [];
        this.exclusiveTail = Promise.resolve();
    }
    /** Number of units currently running, for status display. */
    get activeUnits() {
        return this.active;
    }
    /** True while a rotation is waiting for units to finish or switching. */
    get isRotating() {
        return this.pendingExclusives > 0;
    }
    async hold(work) {
        while (this.pendingExclusives > 0) {
            await new Promise((resolve) => this.releaseWaiters.push(resolve));
        }
        this.active += 1;
        try {
            return await work();
        }
        finally {
            this.active -= 1;
            if (this.active === 0)
                this.drainWaiters.splice(0).forEach((wake) => wake());
        }
    }
    /**
     * Run `fn` with no unit in flight. Waits up to `drainTimeoutMs` for running units; after that it
     * runs anyway (`drained: false`) so one hung request cannot block rotation forever.
     */
    exclusive(fn, drainTimeoutMs) {
        this.pendingExclusives += 1;
        const run = this.exclusiveTail.then(async () => {
            try {
                const drained = await this.waitForDrain(drainTimeoutMs);
                return { result: await fn(), drained };
            }
            finally {
                this.pendingExclusives -= 1;
                if (this.pendingExclusives === 0)
                    this.releaseWaiters.splice(0).forEach((wake) => wake());
            }
        });
        this.exclusiveTail = run.catch(() => undefined);
        return run;
    }
    waitForDrain(timeoutMs) {
        if (this.active === 0)
            return Promise.resolve(true);
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const idx = this.drainWaiters.indexOf(onDrained);
                if (idx >= 0)
                    this.drainWaiters.splice(idx, 1);
                resolve(false);
            }, timeoutMs);
            const onDrained = () => {
                clearTimeout(timer);
                resolve(true);
            };
            this.drainWaiters.push(onDrained);
        });
    }
}
export const proxyGate = new ProxyGate();
