import { describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
    findUnique: vi.fn(),
    update: vi.fn(),
}));
vi.mock('../../src/lib/prisma.js', () => ({ prisma: { genNormalJob: db } }));

import { GenNormalQueueManager } from '../../src/modules/genNormal/genNormalQueueManager.js';

function setup() {
    db.findUnique.mockReset().mockResolvedValue({
        status: 'QUEUED', retryCount: 0, maxRetries: 10,
        mode: 'TEXT_TO_VIDEO', projectId: 'project', jobIndex: 2,
    });
    db.update.mockReset().mockResolvedValue({});
    const manager = new GenNormalQueueManager();
    manager.setProfileRateLimitDelay = vi.fn();
    const queue = { runningJobs: new Set(['accepted', 'pending', 'later']), queuedJobs: [] };
    manager.profileQueues.set('profile', queue);
    const rows = new Map(['accepted', 'pending', 'later'].map((id, index) => [id, {
        job: { id, jobId: id },
        queuedJob: { jobId: id, profileId: 'profile', projectId: 'project', veo3ProjectId: 'flow-project', index },
    }]));
    return { manager, queue, rows };
}

describe('partial Flow video batch recovery', () => {
    it('queues only rows that were not accepted, preserving the submitted operation', async () => {
        const { manager, queue, rows } = setup();
        await manager.requeueUnsubmittedVideoJobs(rows, [
            { sceneId: 'pending', error: Object.assign(new Error('429 rate limit'), { status: 429 }) },
            { sceneId: 'later' },
        ]);
        expect(db.update.mock.calls.map(([arg]) => arg.where.id).sort()).toEqual(['later', 'pending']);
        expect(queue.queuedJobs.map((item) => item.jobId)).toEqual(['pending', 'later']);
        expect(queue.runningJobs.has('accepted')).toBe(true);
        expect(manager.setProfileRateLimitDelay).toHaveBeenCalledWith('profile', expect.any(Number), '429');
    });

    it('keeps explicit verification rejection terminal for all unsubmitted rows', async () => {
        const { manager, queue, rows } = setup();
        await manager.requeueUnsubmittedVideoJobs(rows, [
            { sceneId: 'pending', error: Object.assign(new Error('verification required'), { code: 'FLOW_VERIFICATION_REQUIRED' }) },
            { sceneId: 'later' },
        ]);
        expect(db.update).toHaveBeenCalledTimes(2);
        expect(db.update.mock.calls.every(([arg]) => arg.data.status === 'FAILED')).toBe(true);
        expect(queue.queuedJobs).toEqual([]);
        expect(queue.runningJobs.has('accepted')).toBe(true);
    });
});
