import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlowRpcError } from '../../src/lib/flowBoq.js';
import { prisma } from '../../src/lib/prisma.js';
import { classifyFlowGenError } from '../../src/services/veo3/flowImageGen.js';
import { VERIFICATION_REQUIRED_CODE } from '../../src/services/veo3/verificationFailure.js';
import { GenNormalQueueManager } from '../../src/modules/genNormal/genNormalQueueManager.js';

describe('Flow video submission safeguards', () => {
    afterEach(() => vi.restoreAllMocks());

    it('keeps model access denial separate from reCAPTCHA recovery', () => {
        const denied = classifyFlowGenError(new FlowRpcError(
            'YhhmEf',
            'PUBLIC_ERROR_MODEL_ACCESS_DENIED',
            7,
        ));

        expect(denied).toMatchObject({
            code: 'MODEL_ACCESS_DENIED',
            isNonRetryable: true,
        });
        expect(denied.isRecaptchaFailure).toBeUndefined();
        expect(denied.message).toContain('PUBLIC_ERROR_MODEL_ACCESS_DENIED');
    });

    it('keeps explicit verification terminal and retries a bare permission denial', () => {
        const rejected = classifyFlowGenError(new FlowRpcError(
            'YhhmEf',
            'PUBLIC_ERROR_UNUSUAL_ACTIVITY: reCAPTCHA evaluation failed',
            7,
        ));
        const unknown = classifyFlowGenError(new FlowRpcError('YhhmEf', 'PERMISSION_DENIED', 7));

        expect(rejected).toMatchObject({ code: VERIFICATION_REQUIRED_CODE, isNonRetryable: true });
        expect(unknown.isRecaptchaFailure).toBe(true);
        expect(unknown.isNonRetryable).not.toBe(true);
    });

    it('claims every video batch member before asynchronous validation', async () => {
        const manager = new GenNormalQueueManager();
        const profileId = 'profile-1';
        const projectId = 'project-1';
        manager.profileQueues.set(profileId, {
            projectId,
            queuedJobs: [
                { jobId: 'job-2', profileId, projectId, mode: 'TEXT_TO_VIDEO' },
                { jobId: 'job-3', profileId, projectId, mode: 'TEXT_TO_VIDEO' },
            ],
            runningJobs: new Set(['job-1']),
        });
        manager.projectBatchSize.set(projectId, 3);
        manager.submittingJobs.set('job-1', { firstJobId: 'job-1', startedAt: Date.now() });
        vi.spyOn(prisma.genNormalJob, 'findUnique').mockImplementation(async ({ where }) => ({
            id: where.id,
            mode: 'TEXT_TO_VIDEO',
            projectId,
            status: 'QUEUED',
        }));

        const batch = await manager.collectVideoBatchJobs(profileId, 'job-1', 'TEXT_TO_VIDEO');

        expect(batch.map(job => job.jobId)).toEqual(['job-1', 'job-2', 'job-3']);
        expect(manager.profileQueues.get(profileId).queuedJobs).toEqual([]);
        expect([...manager.profileQueues.get(profileId).runningJobs].sort()).toEqual(['job-1', 'job-2', 'job-3']);
        expect(manager.isSubmitting('job-2')).toBe(true);
        expect(manager.isSubmitting('job-3')).toBe(true);

        manager.releaseSubmission('job-1');
        expect(manager.submittingJobs.size).toBe(0);
    });
});
