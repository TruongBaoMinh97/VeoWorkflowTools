import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/prisma.js', () => ({ prisma: { genNormalJob: { findUnique: vi.fn(), update: vi.fn() } } }));
vi.mock('../../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, runtimeVerboseLogsEnabled: () => false }));
vi.mock('../../src/services/veo3/veo3Service.js', () => ({ Veo3Service: vi.fn() }));
vi.mock('../../src/modules/genNormal/genNormal.repository.js', () => ({ genNormalRepository: {} }));
vi.mock('../../src/utils/profileCookies.js', () => ({ getProfileCookies: vi.fn() }));
vi.mock('../../src/modules/profiles/accountInfo.service.js', () => ({ refreshProfileAccountInfo: vi.fn() }));
vi.mock('../../src/lib/concurrentProfileLimit.js', () => ({ concurrentProfileLimit: {} }));
vi.mock('../../src/lib/captchaManager.js', () => ({ captchaManager: { notifyRecaptchaScoreDead: vi.fn() } }));
vi.mock('../../src/lib/sessionIdManager.js', () => ({ sessionIdManager: { reset: vi.fn() } }));

import { prisma } from '../../src/lib/prisma.js';
import { genNormalQueueManager as manager } from '../../src/modules/genNormal/genNormalQueueManager.js';
import { VERIFICATION_REQUIRED_MESSAGE } from '../../src/services/veo3/verificationFailure.js';

beforeEach(() => {
    vi.clearAllMocks();
    manager.profileQueues.clear();
    manager.currentBatchJobs.clear();
    vi.spyOn(manager, 'updateProjectStats').mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

describe('verification rejection queue handling', () => {
    it('stops a single rejected submission without reset, retry or prompt rewriting', async () => {
        const queued = { jobId: 'job-a', profileId: 'profile-a', projectId: 'project-a' };
        const rejection = Object.assign(new Error('provider rejected'), {
            response: { status: 403 },
            errorText: JSON.stringify({ error: { code: 403, message: 'reCAPTCHA evaluation failed', details: [{ reason: 'PUBLIC_ERROR_UNUSUAL_ACTIVITY' }] } }),
        });
        prisma.genNormalJob.findUnique.mockRejectedValueOnce(rejection);
        manager.profileQueues.set('profile-a', { runningJobs: new Set(['job-a']), queuedJobs: [] });
        const retry = vi.spyOn(manager, 'requeueJobForRateLimitRetry');
        const reset = vi.spyOn(manager, 'triggerExtensionAnchorReset');
        await manager.submitJob(queued);
        expect(prisma.genNormalJob.update).toHaveBeenCalledOnce();
        expect(prisma.genNormalJob.update).toHaveBeenCalledWith({
            where: { id: 'job-a' },
            data: { status: 'FAILED', error: VERIFICATION_REQUIRED_MESSAGE, completedAt: expect.any(Date), progress: 0 },
        });
        expect(manager.profileQueues.get('profile-a').runningJobs.size).toBe(0);
        expect(retry).not.toHaveBeenCalled();
        expect(reset).not.toHaveBeenCalled();
    });

    it('cleans up the affected batch and preserves unrelated jobs and profiles', async () => {
        const first = { jobId: 'a', profileId: 'p', projectId: 'project' };
        const second = { ...first, jobId: 'b' };
        const queue = { runningJobs: new Set(['a', 'b', 'unrelated']), queuedJobs: [first, second, { jobId: 'later' }] };
        const other = { runningJobs: new Set(['other']), queuedJobs: [] };
        manager.profileQueues.set('p', queue);
        manager.profileQueues.set('other-profile', other);
        manager.currentBatchJobs.set('a', [first, second]);
        await manager.failJobsForVerification(first, [first, second]);
        expect(prisma.genNormalJob.update.mock.calls.map(([args]) => args.where.id)).toEqual(['a', 'b']);
        expect(queue.runningJobs).toEqual(new Set(['unrelated']));
        expect(queue.queuedJobs).toEqual([{ jobId: 'later' }]);
        expect(manager.profileQueues.get('other-profile')).toBe(other);
        expect(manager.currentBatchJobs.has('a')).toBe(false);
        expect(manager.updateProjectStats).toHaveBeenCalledWith('project');
    });
});
