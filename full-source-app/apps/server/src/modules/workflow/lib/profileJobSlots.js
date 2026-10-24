/** Shared by all Batch runs in this server. Reserve before claiming a row. */
export class ProfileJobSlots {
    constructor(limit = 2) {
        this.limit = limit;
        this.active = new Map();
        this.waiting = new Map();
        this.limits = new Map();
    }
    acquire(profileId, cancelled = () => false, limit = this.limit) {
        return new Promise(resolve => {
            const queue = this.waiting.get(profileId) ?? [];
            this.waiting.set(profileId, queue);
            const ticket = { resolve, cancelled, limit, timer: null };
            queue.push(ticket);
            ticket.timer = setInterval(() => this.pump(profileId), 100);
            this.pump(profileId);
        });
    }
    pump(profileId) {
        const queue = this.waiting.get(profileId);
        if (!queue) return;
        for (let index = queue.length - 1; index >= 0; index--) {
            if (queue[index].cancelled()) {
                const [ticket] = queue.splice(index, 1);
                clearInterval(ticket.timer);
                ticket.resolve(null);
            }
        }
        while (queue.length && (this.active.get(profileId) ?? 0) < Math.min(queue[0].limit, ...(this.limits.get(profileId) || []))) {
            const ticket = queue.shift();
            clearInterval(ticket.timer);
            this.active.set(profileId, (this.active.get(profileId) ?? 0) + 1);
            const limits=this.limits.get(profileId)||[]; limits.push(ticket.limit); this.limits.set(profileId,limits);
            let released = false;
            ticket.resolve(() => {
                if (released) return;
                released = true;
                limits.splice(limits.indexOf(ticket.limit),1); if(!limits.length)this.limits.delete(profileId);
                const remaining = (this.active.get(profileId) ?? 1) - 1;
                if (remaining) this.active.set(profileId, remaining);
                else this.active.delete(profileId);
                this.pump(profileId);
            });
        }
        if (!queue.length) this.waiting.delete(profileId);
    }
}
export const batchProfileSlots = new ProfileJobSlots();

// Match explicit provider reasons only, never generic 429/content/OpenAI errors.
export function flowProfileUnavailable(run, definition) {
    const flowTypes = new Set(['generate-image', 'generate-video', 'upload-image', 'folder-input']);
    return definition.nodes.some(node => flowTypes.has(node.type) &&
        run.nodeStates?.[node.id]?.status === 'error' &&
        /PUBLIC_ERROR_(?:USER_QUOTA_REACHED|PER_MODEL_DAILY_QUOTA_REACHED)|UNAUTHENTICATED|invalid_grant|Đã đạt giới hạn quota hàng ngày cho model này|Tài khoản Ultra đã hết hạn hoặc hết quota/i.test(
            String(run.nodeStates[node.id].reason ?? '') + ' ' + String(run.nodeStates[node.id].error ?? run.error ?? '')));
}
