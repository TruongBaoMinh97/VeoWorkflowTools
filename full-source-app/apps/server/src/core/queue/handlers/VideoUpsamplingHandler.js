/**
 * Video Upsampling Handler
 * Processes video upsampling jobs (upsample to 1080p)
 * ✅ BATCH SUPPORT: Collects up to 3 upsampling jobs from same profile and sends in single batch request
 */
import { BaseJobHandler } from '../JobHandler.js';
import { JobType } from '../../jobs/JobTypes.js';
import { logger, runtimeVerboseLogsEnabled } from '../../../lib/logger.js';
import { prisma } from '../../../lib/prisma.js';
import { genNormalRepository } from '../../../modules/genNormal/genNormal.repository.js';
import { Veo3Service, extractUUIDFromMediaId } from '../../../services/veo3/veo3Service.js';
import { genNormalQueueManager } from '../../../modules/genNormal/genNormalQueueManager.js';
// Batch configuration
const UPSAMPLING_BATCH_SIZE = 4; // Default batch size (used for batching API calls)
// Dynamic limit: when gen idle, upscale uses full capacity
async function getUpscaleLimit(profileId) {
    const activeGenJobs = await prisma.genNormalJob.count({
        where: { profileId, status: 'PROCESSING', parentJobId: null }
    });
    return activeGenJobs > 0 ? 4 : 12;
}
const BATCH_COLLECTION_WAIT_MS = 2000; // Wait 2 seconds to collect more jobs before submitting
const MAX_BATCH_COLLECTION_RETRIES = 3; // Max retries to collect full batch
// 🧊 Hard gap giữa 2 batch video upsample per profile, tránh 429 TOO_MUCH_TRAFFIC
const POST_BATCH_COOLDOWN_MS = 8000;
// 🧊 Sau 429 → freeze video upsample 5 phút
const POST_429_COOLDOWN_MS = 5 * 60 * 1000;
const profile429Until = new Map();
// 🛑 Sau 403 PUBLIC_ERROR_UNUSUAL_ACTIVITY (reCAPTCHA bị Google reject):
// freeze upsample của profile đó để captcha score có thời gian hồi. Account mới
// + burst submit dễ rơi vào trạng thái này; cooldown profile-wide ngăn các job
// còn lại của profile fire-and-fail liên tục.
const POST_403_COOLDOWN_MS = Number(process.env.VIDEO_UPSAMPLE_403_COOLDOWN_MS) || 90000;
const profile403Until = new Map();
// ⏳ Min gap giữa 2 submit upsample liên tiếp của CÙNG profile. Tránh burst-403
// khi captcha score chưa kịp hồi giữa các submit. Env override để dễ tune live.
const MIN_GAP_BETWEEN_SUBMIT_MS = Number(process.env.VIDEO_UPSAMPLE_MIN_GAP_MS) || 8000;
const lastSubmitByProfile = new Map();
export class VideoUpsamplingHandler extends BaseJobHandler {
    static async acquireProfileLock(profileId) {
        const previous = VideoUpsamplingHandler.submissionLocks.get(profileId);
        let release;
        const myTail = new Promise((resolve) => { release = resolve; });
        const chained = previous ? previous.then(() => myTail, () => myTail) : myTail;
        VideoUpsamplingHandler.submissionLocks.set(profileId, chained);
        if (previous) {
            await Promise.race([
                previous,
                new Promise((_, reject) => setTimeout(() => reject(new Error('Lock timeout: previous submission took >2min')), 120000)),
            ]).catch((err) => {
                logger.warn(`[VideoUpsamplingHandler] Lock wait failed: ${err.message}, proceeding`);
            });
        }
        return () => {
            release();
            if (VideoUpsamplingHandler.submissionLocks.get(profileId) === chained) {
                VideoUpsamplingHandler.submissionLocks.delete(profileId);
            }
        };
    }
    getJobType() {
        return JobType.VIDEO_UPSAMPLING;
    }
    /**
     * Pre-check: only allow processing if profile has room for more upsampling jobs.
     * This prevents 500 jobs from all entering execute() and throwing BATCH_WAIT.
     * Jobs that fail this check stay queued and are retried on the next poll cycle.
     */
    async canProcess(job) {
        const profileId = job.profileId;
        if (!profileId)
            return true;
        // Only allow one submission handler per profile at a time
        if (VideoUpsamplingHandler.submissionLocks.has(profileId)) {
            return false;
        }
        // 🛑 Profile-wide 403 cooldown: nếu profile vừa bị reCAPTCHA reject, chặn
        // mọi upsample job khác của cùng profile cho đến khi cooldown hết — captcha
        // score cần thời gian hồi, fire submit ngay sẽ chỉ tích 403 tiếp.
        const cooldown403Until = profile403Until.get(profileId) || 0;
        if (cooldown403Until > Date.now()) {
            return false; // SQLiteQueue sẽ requeue tự nhiên
        }
        // Check if profile already has max PROCESSING upsampling jobs (dynamic limit)
        const processingCount = await prisma.genNormalJob.count({
            where: {
                profileId,
                parentJobId: { not: null },
                status: 'PROCESSING'
            }
        });
        const limit = await getUpscaleLimit(profileId);
        if (processingCount >= limit) {
            return false; // Profile at upscale limit
        }
        return true;
    }
    async execute(job) {
        const { genNormalJobId, parentJobId } = job.data;
        if (!genNormalJobId) {
            throw new Error('Missing required field: genNormalJobId');
        }
        logger.debug(`[VideoUpsamplingHandler] Processing upsampling job ${job.id} (gen=${genNormalJobId} parent=${parentJobId})`);
        // Get upsampling job (the clone) from database
        const upsamplingJob = await prisma.genNormalJob.findUnique({
            where: { id: genNormalJobId },
            include: {
                project: {
                    include: {
                        profiles: {
                            include: {
                                profile: true
                            }
                        }
                    }
                },
                profile: true
            }
        });
        if (!upsamplingJob) {
            throw new Error(`Upsampling job not found: ${genNormalJobId}`);
        }
        // 🚫 Check if project has been cancelled (user clicked "Cancel All")
        const projectId = upsamplingJob.projectId;
        if (projectId && genNormalQueueManager.isProjectCancelled(projectId)) {
            logger.info(`[VideoUpsamplingHandler] 🚫 Skipping upsampling - project has been cancelled`, {
                queueJobId: job.id,
                genNormalJobId,
                projectId
            });
            // Delete the upsampling job since project is cancelled
            try {
                await prisma.genNormalJob.delete({ where: { id: genNormalJobId } });
            }
            catch (e) {
                if (e.code !== 'P2025')
                    logger.warn(`Failed to delete cancelled upsampling job: ${e.message}`);
            }
            return {
                success: true,
                cancelled: true,
                message: 'Project cancelled'
            };
        }
        // Get profile for submission lock
        const profileId = upsamplingJob.profileId;
        if (!profileId) {
            throw new Error('Upsampling job has no profileId');
        }
        // ✅ BATCH CHECK: Only block if profile already has >= UPSAMPLING_BATCH_SIZE (4) PROCESSING upsampling jobs
        // This allows batching: collect up to 4 jobs, submit together, then wait for completion
        const processingUpsamplingCount = await prisma.genNormalJob.count({
            where: {
                profileId,
                parentJobId: { not: null }, // Upsampling jobs have parentJobId
                status: 'PROCESSING'
            }
        });
        const dynamicLimit = await getUpscaleLimit(profileId);
        if (processingUpsamplingCount >= dynamicLimit) {
            logger.debug(`[VideoUpsamplingHandler] ⏳ Profile ${profileId.substring(0, 8)}... has ${processingUpsamplingCount} PROCESSING upsampling jobs (max ${dynamicLimit}). Deferring.`);
            throw new Error(`BATCH_WAIT: Profile has ${processingUpsamplingCount} PROCESSING upsampling jobs (max ${dynamicLimit})`);
        }
        // Log current processing state for debugging
        if (processingUpsamplingCount > 0) {
            logger.debug(`[VideoUpsamplingHandler] Profile ${profileId.substring(0, 8)}… has ${processingUpsamplingCount}/${dynamicLimit} upsample jobs in flight (slots=${dynamicLimit - processingUpsamplingCount})`);
        }
        // Serialize per-profile via FIFO mutex (acquireProfileLock publishes our
        // tail before awaiting the previous one).
        logger.info(`[VideoUpsamplingHandler] Acquiring submission lock (profile: ${profileId})`);
        const releaseLock = await VideoUpsamplingHandler.acquireProfileLock(profileId);
        // After waking from the lock, check if THIS job was already processed in a batch
        const [refreshedQueueJob, refreshedGenNormalJob] = await Promise.all([
            prisma.queueJob.findUnique({ where: { id: job.id } }),
            prisma.genNormalJob.findUnique({ where: { id: genNormalJobId }, select: { status: true, sceneId: true, parentJobId: true } })
        ]);
        const parentSceneId = refreshedGenNormalJob?.parentJobId
            ? (await prisma.genNormalJob.findUnique({ where: { id: refreshedGenNormalJob.parentJobId }, select: { sceneId: true } }))?.sceneId
            : null;
        const hasOwnSceneId = refreshedGenNormalJob?.sceneId && refreshedGenNormalJob.sceneId !== parentSceneId;
        const alreadySubmitted = refreshedQueueJob?.status === 'completed' ||
            (refreshedGenNormalJob?.status === 'PROCESSING' && hasOwnSceneId);
        if (alreadySubmitted) {
            logger.info(`[VideoUpsamplingHandler] ✅ Job was already processed in another batch, skipping`, {
                queueJobId: job.id,
                genNormalJobId,
                queueJobStatus: refreshedQueueJob?.status,
                genNormalStatus: refreshedGenNormalJob?.status,
                hasOwnSceneId
            });
            releaseLock();
            return {
                success: true,
                alreadyProcessedInBatch: true,
                queueJobId: job.id
            };
        }
        // 🧊 If profile hit 429 recently, defer — don't burn captcha/API
        const cooldownUntil = profile429Until.get(profileId) || 0;
        if (cooldownUntil > Date.now()) {
            const remainingSec = Math.ceil((cooldownUntil - Date.now()) / 1000);
            logger.warn(`[VideoUpsamplingHandler] 🧊 Profile ${profileId.substring(0, 8)}... in 429 cool-down (${remainingSec}s remaining) — requeueing job ${job.id}`);
            releaseLock();
            throw Object.assign(new Error(`Profile in 429 cool-down, ${remainingSec}s remaining`), {
                isRetryable: true,
                isBackpressure: true,
                cooldownMs: cooldownUntil - Date.now(),
            });
        }
        // 🛑 403 reCAPTCHA cool-down (mirror 429 path) — same profile-wide block.
        const cooldown403 = profile403Until.get(profileId) || 0;
        if (cooldown403 > Date.now()) {
            const remainingSec = Math.ceil((cooldown403 - Date.now()) / 1000);
            logger.warn(`[VideoUpsamplingHandler] 🛑 Profile ${profileId.substring(0, 8)}... in 403 cool-down (${remainingSec}s remaining) — requeueing job ${job.id}`);
            releaseLock();
            throw Object.assign(new Error(`Profile in 403 cool-down, ${remainingSec}s remaining`), {
                isRetryable: true,
                isBackpressure: true,
                cooldownMs: cooldown403 - Date.now(),
            });
        }
        // ⏳ Enforce minimum gap between back-to-back submits for this profile.
        // Without this, an upsample batch fires another submit immediately after
        // the previous one resolves → captcha score never recovers → 403 cascade.
        const lastSubmit = lastSubmitByProfile.get(profileId) || 0;
        const sinceLast = Date.now() - lastSubmit;
        if (sinceLast < MIN_GAP_BETWEEN_SUBMIT_MS) {
            const wait = MIN_GAP_BETWEEN_SUBMIT_MS - sinceLast;
            logger.debug(`[VideoUpsamplingHandler] ⏳ Profile ${profileId.substring(0, 8)}... min-gap wait ${wait}ms before next submit`);
            await new Promise(r => setTimeout(r, wait));
        }
        try {
            // ✅ BATCH FIX: Add initial delay to allow SQLiteQueueManager to pick up all jobs first
            // Without this delay, collectBatchUpsamplingJobs runs before other jobs are in 'processing' status
            // The queue manager picks up jobs in batches based on concurrency, so a small delay ensures
            // all jobs from the same batch have been picked up
            const INITIAL_BATCH_DELAY_MS = 800; // 800ms should be enough for queue to pick up all jobs
            await new Promise(resolve => setTimeout(resolve, INITIAL_BATCH_DELAY_MS));
            // ✅ BATCH: Try to collect upsampling jobs from same profile
            // Wait and retry to collect full batch (4 jobs) before submitting
            let batchJobs = await this.collectBatchUpsamplingJobs(job, upsamplingJob, parentJobId, profileId);
            // If we don't have a full batch, wait a bit and try to collect more
            let collectionRetries = 0;
            while (batchJobs.length > 0 && batchJobs.length < UPSAMPLING_BATCH_SIZE && collectionRetries < MAX_BATCH_COLLECTION_RETRIES) {
                // Check total QUEUED upsampling jobs for this profile to see if more are coming
                const queuedCount = await prisma.queueJob.count({
                    where: {
                        type: 'VIDEO_UPSAMPLING',
                        status: { in: ['queued', 'processing'] },
                        profileId: profileId
                    }
                });
                // If total queued jobs (including current batch) is less than batch size, no point waiting
                if (queuedCount <= batchJobs.length) {
                    logger.debug(`[VideoUpsamplingHandler] No more jobs expected (queued=${queuedCount} collected=${batchJobs.length}), submit current batch`);
                    break;
                }
                collectionRetries++;
                logger.debug(`[VideoUpsamplingHandler] Waiting ${BATCH_COLLECTION_WAIT_MS}ms for more jobs (${batchJobs.length}/${UPSAMPLING_BATCH_SIZE} retry=${collectionRetries}/${MAX_BATCH_COLLECTION_RETRIES} queued=${queuedCount})`);
                await new Promise(resolve => setTimeout(resolve, BATCH_COLLECTION_WAIT_MS));
                // Re-collect batch
                batchJobs = await this.collectBatchUpsamplingJobs(job, upsamplingJob, parentJobId, profileId);
            }
            if (batchJobs.length > 1) {
                const kind = batchJobs.length >= UPSAMPLING_BATCH_SIZE ? 'FULL' : 'PARTIAL';
                logger.info(`[VideoUpsamplingHandler] 🎬 Processing ${kind} batch of ${batchJobs.length} upsample jobs for ${profileId.substring(0, 8)}…`);
            }
            // Stamp BEFORE the actual submit fires so the next caller picking up the
            // lock waits the full MIN_GAP from this moment (not from the response).
            lastSubmitByProfile.set(profileId, Date.now());
            if (batchJobs.length > 1) {
                return await this.executeBatchUpsampling(batchJobs, upsamplingJob);
            }
            else if (batchJobs.length === 1) {
                // Single job - use original logic
                return await this.executeUpsampling(job, upsamplingJob, parentJobId);
            }
            else {
                // No jobs collected (edge case)
                throw new Error('Failed to collect any jobs for batch');
            }
        }
        catch (err) {
            const errText = err?.errorText || err?.message || '';
            // 🧊 Detect 429 → freeze video upsample for POST_429_COOLDOWN_MS
            if (err?.response?.status === 429 || /TOO_MUCH_TRAFFIC|RESOURCE_EXHAUSTED|429/i.test(errText)) {
                const until = Date.now() + POST_429_COOLDOWN_MS;
                profile429Until.set(profileId, until);
                logger.warn(`[VideoUpsamplingHandler] 🧊 Profile ${profileId.substring(0, 8)}... hit 429 → cooling down video upsample for ${POST_429_COOLDOWN_MS / 1000}s`);
            }
            // 🛑 Detect 403 PUBLIC_ERROR_UNUSUAL_ACTIVITY → profile-wide cooldown.
            // Without this, the remaining upsamples of the same profile each fire
            // their own submit and stack up 403s while captcha score stays low.
            const isRecaptcha403 = err?.isRecaptchaFailure === true ||
                err?.response?.status === 403 ||
                /PUBLIC_ERROR_UNUSUAL_ACTIVITY(?!_TOO_MUCH_TRAFFIC)|reCAPTCHA evaluation failed/i.test(errText);
            if (isRecaptcha403) {
                const until = Date.now() + POST_403_COOLDOWN_MS;
                profile403Until.set(profileId, until);
                logger.warn(`[VideoUpsamplingHandler] 🛑 Profile ${profileId.substring(0, 8)}... hit 403 (reCAPTCHA) → cooling down video upsample for ${POST_403_COOLDOWN_MS / 1000}s`);
            }
            throw err;
        }
        finally {
            // 🧊 Mandatory gap giữa batch → tránh burst 429. Sit on the lock during
            // the cool-down so the next job in the chain inherits the gap.
            await new Promise((resolve) => setTimeout(resolve, POST_BATCH_COOLDOWN_MS));
            releaseLock();
        }
    }
    async executeUpsampling(job, upsamplingJob, parentJobId) {
        const genNormalJobId = upsamplingJob.id;
        // Get parent job (original job) - either from parentJobId in queue data or from upsamplingJob.parentJobId
        const originalJobId = parentJobId || upsamplingJob.parentJobId;
        if (!originalJobId) {
            throw new Error(`No parent job ID found for upsampling job ${genNormalJobId}`);
        }
        const originalJob = await prisma.genNormalJob.findUnique({
            where: { id: originalJobId },
            include: {
                profile: true
            }
        });
        // Parent job may have been deleted (e.g. user clicked "Delete all completed jobs").
        // The upsampling clone was created with providerJobId copied from parent, so it can still proceed.
        if (!originalJob) {
            logger.warn(`[VideoUpsamplingHandler] ⚠️ Parent job ${originalJobId} not found (may have been deleted). Using clone's own providerJobId as fallback.`, {
                upsamplingJobId: upsamplingJob.id,
                cloneProviderJobId: upsamplingJob.providerJobId?.substring(0, 30),
            });
            if (!upsamplingJob.providerJobId) {
                throw new Error(`Original job ${originalJobId} not found and clone has no providerJobId. Cannot upscale.`);
            }
        }
        // Use clone's own data if parent was deleted
        const effectiveOriginalJob = originalJob || upsamplingJob;
        // 🔥 FIX: Check if this upsampling job already has its own operation name (different from parent's providerJobId)
        // This happens when server restarts and job is recovered but already submitted to Google
        // providerJobId is initially copied from parent (mediaId), but after submit it becomes operation name
        // We detect "already submitted" if: status is PROCESSING AND providerJobId differs from parent's providerJobId
        const hasOwnOperationName = originalJob &&
            upsamplingJob.providerJobId &&
            upsamplingJob.providerJobId !== originalJob.providerJobId &&
            upsamplingJob.status === 'PROCESSING';
        if (hasOwnOperationName) {
            logger.info(`[VideoUpsamplingHandler] 🔄 Upsampling job already submitted (has own operation name), skipping re-submission`, {
                upsamplingJobId: upsamplingJob.id,
                operationName: upsamplingJob.providerJobId.substring(0, 30) + '...',
                parentProviderJobId: originalJob.providerJobId?.substring(0, 30) + '...',
                status: upsamplingJob.status
            });
            // Return success - polling will handle the rest
            return {
                success: true,
                operationName: upsamplingJob.providerJobId,
                sceneId: upsamplingJob.sceneId,
                alreadySubmitted: true
            };
        }
        // Validate effective job has providerJobId
        if (!effectiveOriginalJob.providerJobId) {
            throw new Error(`No providerJobId available for upsampling (originalJobId: ${originalJobId})`);
        }
        // Validate original job is video (not image)
        if (effectiveOriginalJob.mode === 'IMAGE_GENERATION') {
            throw new Error(`Original job ${originalJobId} is an image job, cannot upsample`);
        }
        // Get Veo3 project ID
        const refreshedProject = await genNormalRepository.getProject(upsamplingJob.projectId);
        const projectProfile = refreshedProject?.profiles.find((p) => p.profileId === upsamplingJob.profileId);
        if (!projectProfile?.veo3ProjectId) {
            throw new Error(`No Veo3 project ID found for profile ${upsamplingJob.profileId}`);
        }
        // Get cookies from Electron persistent partition instead of database
        const { getProfileCookiesCompat } = await import('../../../utils/profileCookies.js');
        const { cookies: profileCookiesJson } = await getProfileCookiesCompat(upsamplingJob.profile);
        // Convert cookies from JSON array to header string
        let cookiesString = undefined;
        if (profileCookiesJson) {
            try {
                const parsed = JSON.parse(profileCookiesJson);
                if (Array.isArray(parsed)) {
                    cookiesString = parsed
                        .map((cookie) => `${cookie.name}=${cookie.value}`)
                        .join('; ');
                }
                else {
                    cookiesString = profileCookiesJson;
                }
            }
            catch {
                cookiesString = profileCookiesJson;
            }
        }
        // Create service instance
        const veo3Service = new Veo3Service();
        veo3Service.updateConfig({
            accessToken: upsamplingJob.profile.accessToken || undefined,
            cookies: cookiesString,
            profileId: upsamplingJob.profile.id,
            onTokenRefreshed: async (newToken) => {
                await prisma.profile.update({
                    where: { id: upsamplingJob.profileId },
                    data: {
                        accessToken: newToken,
                        accessTokenExpires: new Date(Date.now() + 55 * 60 * 1000)
                    }
                });
            }
        });
        // Veo 3.1 upsample yêu cầu videoInput.mediaId = UUID PHẲNG của video nguồn
        // (verified từ request web: videoInput.mediaId = "70fbb201-…").
        // KHÔNG dùng id mã hoá CAUS… — id đó encode PROJECT id, gây 404 NOT_FOUND.
        // resolveSourceVideoUuid ưu tiên parse resultUrl (/video/<uuid>) rồi mới fallback.
        const mediaId = this.resolveSourceVideoUuid(effectiveOriginalJob);
        if (!mediaId) {
            logger.error(`[VideoUpsamplingHandler] Không resolve được UUID video nguồn để upscale`, {
                originalJobId: effectiveOriginalJob.id,
                providerJobId: effectiveOriginalJob.providerJobId?.substring(0, 30),
                hasResultUrl: !!effectiveOriginalJob.resultUrl,
            });
            throw new Error('Không lấy được UUID video nguồn để upscale. Video có thể chưa hoàn thành — vui lòng đợi video xong rồi thử lại.');
        }
        // Resolve aspect ratio from project
        // Note: aspectRatio is stored at project level, not job level
        const projectAspectRatio = upsamplingJob.project.aspectRatio || 'VIDEO_ASPECT_RATIO_LANDSCAPE';
        let aspectRatioEnum;
        if (projectAspectRatio.startsWith('VIDEO_ASPECT_RATIO_')) {
            aspectRatioEnum = projectAspectRatio;
        }
        else {
            const { convertAspectRatioToEnum } = await import('../../../utils/videoModelResolver.js');
            const aspectRatio = (projectAspectRatio === '9:16' || projectAspectRatio === '16:9')
                ? projectAspectRatio
                : '16:9';
            aspectRatioEnum = convertAspectRatioToEnum(aspectRatio);
        }
        // Generate sceneId for upsampling job
        const sceneId = this.generateUUID();
        // Resolve resolution and model key
        // Default to 1080p if not specified
        const resolution = job.data.resolution || '1080P';
        const is4K = resolution === '4K';
        // 4K chỉ có ở gói Ultra — giống hệt phía ảnh. Gói thấp hơn gọi vẫn "thành
        // công" nhưng không ra kết quả, nên phải chặn tại đây thay vì để job retry.
        if (is4K && upsamplingJob.profile?.paygateTier !== 'PAYGATE_TIER_TWO') {
            throw new Error('RESOLUTION_UNAVAILABLE: Gói hiện tại không nâng được 4K — chỉ tài khoản Ultra mới có. Hãy chọn 1080P.');
        }
        const targetResolution = is4K ? 'VIDEO_RESOLUTION_4K' : 'VIDEO_RESOLUTION_1080P';
        const videoModelKey = is4K ? 'veo_3_1_upsampler_4k' : 'veo_3_1_upsampler_1080p';
        // "Preparing upsampling request" log dropped — "Submitting upsampling request" below
        // already carries the same metadata.
        // Prepare upsampling request
        // NOTE: clientContext must be at ROOT level with the same fields as video gen:
        //   sessionId, projectId, tool, userPaygateTier — required for reCAPTCHA validation
        const isUltraUser = upsamplingJob.project?.paygateTier === 'PAYGATE_TIER_TWO';
        const userPaygateTier = isUltraUser ? 'PAYGATE_TIER_TWO' : 'PAYGATE_TIER_ONE';
        const { sessionIdManager } = await import('../../../lib/sessionIdManager.js');
        // Veo 3.1: web Flow gửi `metadata.workflowId` thay cho `metadata.sceneId`.
        // workflowId được lưu khi parse submit response của video gốc
        // (media[].workflowId → flowWorkflowId trong DB).
        // Fallback: dùng sceneId cũ nếu workflowId chưa có (job cũ trước migration).
        const upsampleWorkflowId = effectiveOriginalJob.flowWorkflowId || effectiveOriginalJob.sceneId || sceneId;
        const upsamplingRequest = {
            // mediaGenerationContext: Veo 3.1 yêu cầu `audioFailurePreference` —
            // verified từ curl thực tế của web Flow. batchId được veo3Service tự gắn.
            mediaGenerationContext: {
                audioFailurePreference: 'BLOCK_SILENCED_VIDEOS',
            },
            clientContext: {
                sessionId: sessionIdManager.get(upsamplingJob.profileId, projectProfile.veo3ProjectId),
                projectId: projectProfile.veo3ProjectId,
                tool: 'PINHOLE',
                userPaygateTier
            },
            requests: [{
                    aspectRatio: aspectRatioEnum,
                    resolution: targetResolution,
                    seed: Math.floor(Math.random() * 1000000), // Random seed
                    videoInput: {
                        mediaId: mediaId
                    },
                    videoModelKey: videoModelKey,
                    metadata: {
                        workflowId: upsampleWorkflowId,
                    }
                }],
            // useV2ModelConfig: Veo 3.1 web Flow gửi LUÔN luôn (kể cả Ultra) —
            // verified từ curl thực tế. Trước đây chỉ set cho PAYGATE_TIER_ONE.
            useV2ModelConfig: true,
        };
        logger.info(`[VideoUpsamplingHandler] 🚀 Submit upscale ${targetResolution} (job=${upsamplingJob.id.slice(0, 12)} orig=${effectiveOriginalJob.id.slice(0, 12)} media=${mediaId.substring(0, 16)}… wf=${(upsampleWorkflowId || '').substring(0, 8)})`);
        if (runtimeVerboseLogsEnabled()) {
            logger.debug(`[VideoUpsamplingHandler] Full request body: ${JSON.stringify(upsamplingRequest, null, 2)}`);
        }
        // Submit upsampling request with handling for ALREADY_IN_PROGRESS error
        let response;
        try {
            response = await veo3Service.batchAsyncGenerateVideoUpsampleVideo(upsamplingRequest);
        }
        catch (error) {
            // Check if this is ALREADY_IN_PROGRESS error (409)
            const { isAlreadyInProgressError } = await import('../../../services/veo3/veo3ErrorHandler.js');
            if (isAlreadyInProgressError(error.errorText || error.message)) {
                logger.info(`[VideoUpsamplingHandler] 🔄 Upsampling already in progress (409), marking job for polling`, {
                    upsamplingJobId: upsamplingJob.id,
                    originalJobId: originalJob.id,
                    mediaId: mediaId.substring(0, 50) + '...'
                });
                // Update job to PROCESSING state so polling will check it
                // We don't have the operation name, but we can use the mediaId as reference
                await prisma.genNormalJob.update({
                    where: { id: upsamplingJob.id },
                    data: {
                        status: 'PROCESSING',
                        sceneId: sceneId,
                        error: 'Waiting for previous upsampling to complete...'
                    }
                });
                // Return success - the previous generation should complete and polling will pick it up
                // Or this job will be retried after the current generation finishes
                return {
                    success: true,
                    alreadyInProgress: true,
                    sceneId: sceneId
                };
            }
            // Re-throw other errors
            throw error;
        }
        if (!response.operations || response.operations.length === 0) {
            throw new Error('No operations returned from upsampling API');
        }
        const operation = response.operations[0];
        if (!operation) {
            throw new Error('No operation in response');
        }
        const operationName = operation.operation?.name;
        if (!operationName) {
            throw new Error('No operation name returned from upsampling API');
        }
        const responseSceneId = operation.sceneId || sceneId;
        logger.info(`[VideoUpsamplingHandler] ✅ Upscale submitted (job=${upsamplingJob.id.slice(0, 12)} op=${(operationName || '').substring(0, 20)})`);
        // Veo 3.1 upsample submits return a media resource → operationName is a media
        // UUID that must be polled via the media-shape endpoint. Persist the original
        // job's flowWorkflowId onto this upsample child so pollUpsamplingBatch routes
        // it to the media poll; without it the media UUID 400s the legacy endpoint.
        // (The submit response operation has no __workflowId, so carry it forward.)
        const submitWorkflowId = effectiveOriginalJob.flowWorkflowId || null;
        // Update upsampling job with operation name for status polling
        await prisma.genNormalJob.update({
            where: { id: upsamplingJob.id },
            data: {
                providerJobId: operationName,
                sceneId: responseSceneId,
                ...(submitWorkflowId ? { flowWorkflowId: submitWorkflowId } : {}),
                status: 'PROCESSING' // Mark as processing so it appears in middle column
            }
        });
        // Update queue job with operation name (stored in providerJobId of queue job)
        // The operation name will be used for status polling
        return {
            success: true,
            operationName,
            sceneId: responseSceneId
        };
    }
    /**
     * ✅ BATCH: Collect upsampling jobs from same profile for batch processing
     * Similar to collectVideoBatchJobs in genNormalQueueManager
     */
    async collectBatchUpsamplingJobs(currentQueueJob, currentGenNormalJob, currentParentJobId, profileId) {
        const batchJobs = [];
        // First, check how many slots are available (considering already PROCESSING jobs)
        const processingCount = await prisma.genNormalJob.count({
            where: {
                profileId,
                parentJobId: { not: null }, // Upsampling jobs have parentJobId
                status: 'PROCESSING'
            }
        });
        const batchLimit = await getUpscaleLimit(profileId);
        const availableSlots = batchLimit - processingCount;
        logger.debug(`[VideoUpsamplingHandler] Collect batch for ${profileId.substring(0, 8)}… (processing=${processingCount}/${batchLimit} slots=${availableSlots} current=${currentQueueJob.id})`);
        if (availableSlots <= 0) {
            logger.warn(`[VideoUpsamplingHandler] No available slots for profile ${profileId.substring(0, 8)}…, skipping batch collection`);
            return batchJobs; // Return empty - caller will handle
        }
        // Get current job's mediaId first
        const currentParentJob = await this.getParentJobWithMediaId(currentGenNormalJob, currentParentJobId);
        if (!currentParentJob || !currentParentJob.mediaId) {
            logger.warn(`[VideoUpsamplingHandler] Cannot get mediaId for current job, falling back to single job`, {
                genNormalJobId: currentGenNormalJob.id
            });
            return batchJobs; // Return empty - will use single job logic
        }
        // Add current job to batch
        const currentSceneId = this.generateUUID();
        batchJobs.push({
            queueJob: currentQueueJob,
            genNormalJob: currentGenNormalJob,
            parentJob: currentParentJob,
            mediaId: currentParentJob.mediaId,
            sceneId: currentSceneId
        });
        // Find other upsampling jobs from same profile that haven't been submitted yet
        // ✅ FIX: Query both 'queued' AND 'processing' jobs
        // Jobs might be 'processing' (picked by SQLiteQueue) but waiting for lock - they haven't submitted yet
        const otherQueueJobs = await prisma.queueJob.findMany({
            where: {
                type: 'VIDEO_UPSAMPLING',
                status: { in: ['queued', 'processing'] }, // ✅ Include processing jobs (waiting for lock)
                profileId: profileId,
                id: { not: currentQueueJob.id } // Exclude current job
            },
            orderBy: { createdAt: 'asc' },
            take: availableSlots - 1 // Already have 1 job (current), limit to available slots
        });
        if (otherQueueJobs.length === 0) {
            logger.debug(`[VideoUpsamplingHandler] No additional jobs found for ${profileId.substring(0, 8)}…, processing single job`);
            return batchJobs; // Only current job
        }
        logger.info(`[VideoUpsamplingHandler] 📦 Collected ${otherQueueJobs.length} more upsample jobs for ${profileId.substring(0, 8)}… (batch=${batchJobs.length + otherQueueJobs.length})`);
        // Process each additional job
        for (const qj of otherQueueJobs) {
            if (batchJobs.length >= availableSlots)
                break; // Respect available slots
            try {
                const jobData = JSON.parse(qj.data);
                const genNormalJobId = jobData.genNormalJobId;
                const parentJobId = jobData.parentJobId;
                if (!genNormalJobId)
                    continue;
                // Get GenNormalJob
                const genNormalJob = await prisma.genNormalJob.findUnique({
                    where: { id: genNormalJobId },
                    include: {
                        project: {
                            include: {
                                profiles: {
                                    include: {
                                        profile: true
                                    }
                                }
                            }
                        },
                        profile: true
                    }
                });
                if (!genNormalJob)
                    continue;
                // ✅ Skip if already submitted for upsampling (status is PROCESSING and has its own sceneId)
                // Note: providerJobId is copied from parent job, so we can't use it to check
                // Instead, check if status is PROCESSING (meaning already submitted)
                if (genNormalJob.status === 'PROCESSING') {
                    // Get parent job's sceneId to compare
                    const parentJob = await prisma.genNormalJob.findUnique({
                        where: { id: genNormalJob.parentJobId },
                        select: { sceneId: true }
                    });
                    const hasOwnSceneId = genNormalJob.sceneId && genNormalJob.sceneId !== parentJob?.sceneId;
                    if (hasOwnSceneId) {
                        logger.debug(`[VideoUpsamplingHandler] Skipping job - already submitted (PROCESSING with own sceneId)`, {
                            queueJobId: qj.id,
                            genNormalJobId,
                            status: genNormalJob.status
                        });
                        continue;
                    }
                }
                // Get parent job with mediaId
                const parentJob = await this.getParentJobWithMediaId(genNormalJob, parentJobId);
                if (!parentJob || !parentJob.mediaId)
                    continue;
                // Generate sceneId for this job
                const sceneId = this.generateUUID();
                // Mark queue job as processing (atomic) so it won't be picked up again
                await prisma.queueJob.update({
                    where: { id: qj.id },
                    data: {
                        status: 'processing',
                        startedAt: new Date(),
                        attempts: { increment: 1 }
                    }
                });
                batchJobs.push({
                    queueJob: { ...qj, data: jobData },
                    genNormalJob,
                    parentJob,
                    mediaId: parentJob.mediaId,
                    sceneId
                });
                logger.debug(`[VideoUpsamplingHandler] Added job to batch`, {
                    queueJobId: qj.id,
                    genNormalJobId,
                    mediaId: parentJob.mediaId.substring(0, 30) + '...'
                });
            }
            catch (error) {
                logger.warn(`[VideoUpsamplingHandler] Error processing job for batch`, {
                    queueJobId: qj.id,
                    error: error.message
                });
            }
        }
        return batchJobs;
    }
    /**
     * Get parent job and resolve mediaId (handle operation name → mediaId conversion)
     */
    async getParentJobWithMediaId(upsamplingJob, parentJobIdOverride) {
        const originalJobId = parentJobIdOverride || upsamplingJob.parentJobId;
        if (!originalJobId)
            return null;
        const originalJob = await prisma.genNormalJob.findUnique({
            where: { id: originalJobId },
            include: { profile: true }
        });
        // If parent job was deleted (e.g. user clicked "Delete all completed"), fall back to clone's own providerJobId
        // The clone is created with providerJobId copied from parent (see genNormal.service.ts upsampleJob())
        const effectiveJob = originalJob || upsamplingJob;
        if (!effectiveJob.providerJobId) {
            return null;
        }
        // Resolve UUID PHẲNG của video nguồn (xem resolveSourceVideoUuid).
        // KHÔNG chuyển sang id mã hoá CAUS… — đó là nguyên nhân 404 NOT_FOUND.
        const mediaId = this.resolveSourceVideoUuid(effectiveJob);
        if (!mediaId) {
            logger.warn(`[VideoUpsamplingHandler] Bỏ qua job khỏi batch: không resolve được UUID video nguồn`, {
                originalJobId: effectiveJob.id,
                providerJobId: effectiveJob.providerJobId?.substring(0, 30),
            });
            return null;
        }
        return { job: effectiveJob, mediaId };
    }
    /**
     * Resolve UUID PHẲNG của video nguồn để dùng cho `videoInput.mediaId` khi upsample.
     *
     * Veo 3.1 upsample CHỈ chấp nhận UUID phẳng (verified từ request web:
     * `videoInput.mediaId = "70fbb201-81f8-4e07-b019-a16e82def46c"`). Gửi id mã hoá
     * `CAUS…` (encode PROJECT id) sẽ bị 404 NOT_FOUND.
     *
     * Thứ tự ưu tiên:
     *   1. resultUrl: `https://flow-content.google/video/<uuid>?…` — nguồn chuẩn, luôn UUID phẳng
     *   2. providerJobId là UUID phẳng (operation name của t2v) → dùng luôn
     *   3. providerJobId dạng `CAM…` → decode field 3 về UUID
     *   4. `CAUS…` / không decode được → null (không đủ dữ liệu, không submit id rác)
     */
    resolveSourceVideoUuid(job) {
        const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
        // 1) resultUrl: /video/<uuid>
        const resultUrl = job?.resultUrl || undefined;
        if (resultUrl) {
            const fromPath = resultUrl.match(/\/video\/([0-9a-f-]{36})/i);
            if (fromPath && UUID_RE.test(fromPath[1]))
                return fromPath[1];
            const anyUuid = resultUrl.match(UUID_RE);
            if (anyUuid)
                return anyUuid[0];
        }
        const providerJobId = job?.providerJobId || undefined;
        if (!providerJobId)
            return null;
        // 2) providerJobId đã là UUID phẳng (operation name t2v)
        if (!providerJobId.startsWith('CA')) {
            const m = providerJobId.match(UUID_RE);
            return m ? m[0] : providerJobId;
        }
        // 3) CAM… → decode về UUID
        if (providerJobId.startsWith('CAM')) {
            const decoded = extractUUIDFromMediaId(providerJobId);
            if (decoded && UUID_RE.test(decoded))
                return decoded;
        }
        // 4) CAUS… hoặc không decode được
        return null;
    }
    /**
     * ✅ BATCH: Execute batch upsampling for multiple jobs
     */
    async executeBatchUpsampling(batchJobs, firstUpsamplingJob // Use first job for credentials
    ) {
        // Get Veo3 project ID
        const refreshedProject = await genNormalRepository.getProject(firstUpsamplingJob.projectId);
        const projectProfile = refreshedProject?.profiles.find((p) => p.profileId === firstUpsamplingJob.profileId);
        if (!projectProfile?.veo3ProjectId) {
            throw new Error(`No Veo3 project ID found for profile ${firstUpsamplingJob.profileId}`);
        }
        // Get cookies from Electron persistent partition
        const { getProfileCookiesCompat } = await import('../../../utils/profileCookies.js');
        const { cookies: profileCookiesJson } = await getProfileCookiesCompat(firstUpsamplingJob.profile);
        let cookiesString = undefined;
        if (profileCookiesJson) {
            try {
                const parsed = JSON.parse(profileCookiesJson);
                if (Array.isArray(parsed)) {
                    cookiesString = parsed.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
                }
                else {
                    cookiesString = profileCookiesJson;
                }
            }
            catch {
                cookiesString = profileCookiesJson;
            }
        }
        // Create service instance
        const veo3Service = new Veo3Service();
        veo3Service.updateConfig({
            accessToken: firstUpsamplingJob.profile.accessToken || undefined,
            cookies: cookiesString,
            profileId: firstUpsamplingJob.profile.id,
            onTokenRefreshed: async (newToken) => {
                await prisma.profile.update({
                    where: { id: firstUpsamplingJob.profileId },
                    data: {
                        accessToken: newToken,
                        accessTokenExpires: new Date(Date.now() + 55 * 60 * 1000)
                    }
                });
            }
        });
        // Resolve aspect ratio from project
        const projectAspectRatio = firstUpsamplingJob.project.aspectRatio || 'VIDEO_ASPECT_RATIO_LANDSCAPE';
        let aspectRatioEnum;
        if (projectAspectRatio.startsWith('VIDEO_ASPECT_RATIO_')) {
            aspectRatioEnum = projectAspectRatio;
        }
        else {
            const { convertAspectRatioToEnum } = await import('../../../utils/videoModelResolver.js');
            const aspectRatio = (projectAspectRatio === '9:16' || projectAspectRatio === '16:9')
                ? projectAspectRatio
                : '16:9';
            aspectRatioEnum = convertAspectRatioToEnum(aspectRatio);
        }
        // Build sceneId to job mapping for response processing
        const sceneIdToJobMap = new Map();
        for (const batchJob of batchJobs) {
            sceneIdToJobMap.set(batchJob.sceneId, batchJob);
        }
        // Build batch request with multiple upsampling jobs.
        // Veo 3.1 yêu cầu: clientContext (sessionId, projectId, tier), mediaGenerationContext
        // (audioFailurePreference), useV2ModelConfig=true, metadata.workflowId (thay sceneId).
        const { sessionIdManager } = await import('../../../lib/sessionIdManager.js');
        const isUltraUserBatch = firstUpsamplingJob.project?.paygateTier === 'PAYGATE_TIER_TWO';
        const userPaygateTierBatch = isUltraUserBatch ? 'PAYGATE_TIER_TWO' : 'PAYGATE_TIER_ONE';
        const batchRequest = {
            mediaGenerationContext: {
                audioFailurePreference: 'BLOCK_SILENCED_VIDEOS',
            },
            clientContext: {
                sessionId: sessionIdManager.get(firstUpsamplingJob.profileId, projectProfile.veo3ProjectId),
                projectId: projectProfile.veo3ProjectId,
                tool: 'PINHOLE',
                userPaygateTier: userPaygateTierBatch,
            },
            requests: batchJobs.map(batchJob => {
                // Resolve resolution for each job in batch
                const jobData = typeof batchJob.queueJob.data === 'string'
                    ? JSON.parse(batchJob.queueJob.data)
                    : batchJob.queueJob.data;
                const resolution = jobData.resolution || '1080P';
                const is4K = resolution === '4K';
                const targetResolution = is4K ? 'VIDEO_RESOLUTION_4K' : 'VIDEO_RESOLUTION_1080P';
                const videoModelKey = is4K ? 'veo_3_1_upsampler_4k' : 'veo_3_1_upsampler_1080p';
                // Lấy workflowId của video gốc đã lưu trong DB (parser submit Veo 3.1).
                // Fallback: sceneId cũ nếu job cũ chưa có workflowId.
                const origJob = batchJob.originalJob || batchJob.upsamplingJob;
                const flowWorkflowId = origJob?.flowWorkflowId || batchJob.sceneId;
                return {
                    aspectRatio: aspectRatioEnum,
                    resolution: targetResolution,
                    seed: Math.floor(Math.random() * 1000000),
                    videoInput: {
                        mediaId: batchJob.mediaId,
                    },
                    videoModelKey: videoModelKey,
                    metadata: {
                        workflowId: flowWorkflowId,
                    },
                };
            }),
            useV2ModelConfig: true,
        };
        logger.info(`[VideoUpsamplingHandler] 🎬 Submitting BATCH upsampling request`, {
            batchSize: batchJobs.length,
            profileId: firstUpsamplingJob.profileId.substring(0, 8) + '...',
            sceneIds: batchJobs.map(j => j.sceneId),
            mediaIds: batchJobs.map(j => j.mediaId.substring(0, 30) + '...')
        });
        // Submit batch request
        let response;
        try {
            response = await veo3Service.batchAsyncGenerateVideoUpsampleVideo(batchRequest);
        }
        catch (error) {
            // Handle batch error - mark ALL jobs for retry or fail
            const errorMessage = error.message || 'Unknown batch error';
            const { isAlreadyInProgressError, isNonRetryableError } = await import('../../../services/veo3/veo3ErrorHandler.js');
            if (isAlreadyInProgressError(error.errorText || errorMessage)) {
                logger.info(`[VideoUpsamplingHandler] 🔄 Batch upsampling already in progress (409)`, {
                    batchSize: batchJobs.length
                });
                // Mark all jobs as PROCESSING for polling
                for (const batchJob of batchJobs) {
                    await prisma.genNormalJob.update({
                        where: { id: batchJob.genNormalJob.id },
                        data: {
                            status: 'PROCESSING',
                            sceneId: batchJob.sceneId,
                            error: 'Waiting for previous upsampling to complete...'
                        }
                    });
                }
                return {
                    success: true,
                    alreadyInProgress: true,
                    batchSize: batchJobs.length
                };
            }
            // 🔄 reCAPTCHA 403: xoay proxy + force-reset browser trước khi retry
            // Nếu không làm → retry cùng IP + cùng browser session = 403 cascade vô tận.
            const isRecaptcha403 = error?.isRecaptchaFailure === true
                || /PUBLIC_ERROR_UNUSUAL_ACTIVITY(?!_TOO_MUCH_TRAFFIC)/.test(errorMessage)
                || errorMessage.includes('reCAPTCHA evaluation failed');
            if (isRecaptcha403 && firstUpsamplingJob?.profileId) {
                const profileId = firstUpsamplingJob.profileId;
                logger.warn(`[VideoUpsamplingHandler] 403 reCAPTCHA for ${profileId.substring(0, 8)} → notify captcha + rotate proxy`);
                try {
                    const { globalProxyManager } = await import('../../../lib/GlobalProxyManager.js');
                    await globalProxyManager.reportForbidden();
                    const { captchaManager } = await import('../../../lib/captchaManager.js');
                    captchaManager.notifyFailure();
                }
                catch (resetErr) {
                    logger.warn(`[VideoUpsamplingHandler] Reset failed: ${resetErr?.message ?? resetErr}`);
                }
            }
            // For other errors, mark all queue jobs back to queued (retry)
            // But if non-retryable, mark as failed
            const isNonRetry = isNonRetryableError(errorMessage);
            for (const batchJob of batchJobs) {
                if (batchJob.queueJob.id !== batchJobs[0].queueJob.id) {
                    // Mark other queue jobs back to queued or failed
                    await prisma.queueJob.update({
                        where: { id: batchJob.queueJob.id },
                        data: {
                            status: isNonRetry ? 'failed' : 'queued',
                            error: errorMessage
                        }
                    });
                }
                // Update genNormalJob status
                await prisma.genNormalJob.update({
                    where: { id: batchJob.genNormalJob.id },
                    data: {
                        status: isNonRetry ? 'FAILED' : 'QUEUED',
                        error: errorMessage
                    }
                });
            }
            // Re-throw for current job to handle
            throw error;
        }
        if (!response.operations || response.operations.length === 0) {
            throw new Error('No operations returned from batch upsampling API');
        }
        logger.info(`[VideoUpsamplingHandler] ✅ Batch upsampling submitted successfully`, {
            batchSize: batchJobs.length,
            operationsReturned: response.operations.length
        });
        // Map response operations to jobs by sceneId
        for (const operation of response.operations) {
            const responseSceneId = operation.sceneId;
            const batchJob = sceneIdToJobMap.get(responseSceneId);
            if (!batchJob) {
                logger.warn(`[VideoUpsamplingHandler] ⚠️ Response sceneId ${responseSceneId} not matched to any job`);
                continue;
            }
            const operationName = operation.operation?.name;
            if (!operationName) {
                logger.warn(`[VideoUpsamplingHandler] ⚠️ No operation name for sceneId ${responseSceneId}`);
                continue;
            }
            // Update genNormalJob with operation details for polling
            await prisma.genNormalJob.update({
                where: { id: batchJob.genNormalJob.id },
                data: {
                    providerJobId: operationName,
                    sceneId: responseSceneId,
                    status: 'PROCESSING'
                }
            });
            // Mark queue job as completed (submission successful)
            await prisma.queueJob.update({
                where: { id: batchJob.queueJob.id },
                data: {
                    status: 'completed',
                    completedAt: new Date(),
                    result: JSON.stringify({ operationName, sceneId: responseSceneId })
                }
            });
            logger.info(`[VideoUpsamplingHandler] 🎬 Job ${batchJob.genNormalJob.jobIndex} submitted in batch`, {
                genNormalJobId: batchJob.genNormalJob.id,
                operationName,
                sceneId: responseSceneId
            });
        }
        return {
            success: true,
            batchSize: batchJobs.length,
            operationsReturned: response.operations.length
        };
    }
    /**
     * Override canRetry to handle BATCH_WAIT errors
     * BATCH_WAIT errors should always retry (waiting for current batch to complete)
     */
    canRetry(job, error) {
        // BATCH_WAIT: Always retry - waiting for current batch to complete
        if (error.message.includes('BATCH_WAIT')) {
            return true;
        }
        // Orphaned job (project deleted) — never retry
        if (error.message.includes('job not found') || error.message.includes('not found:')) {
            return false;
        }
        // Gói không có 4K là tình trạng cố định của tài khoản — retry chỉ tốn token
        // reCAPTCHA và lượt gọi API mà không bao giờ đổi kết quả.
        if (error.message.includes('RESOLUTION_UNAVAILABLE')) {
            return false;
        }
        // reCAPTCHA failures: retry with longer delay (handled in getRetryDelay)
        if (this.isRecaptchaError(error)) {
            return job.attempts < job.maxAttempts;
        }
        // Use parent logic for other errors
        return super.canRetry(job, error);
    }
    /**
     * Transient waits that should NOT count as a failed attempt:
     * - BATCH_WAIT: handler intentionally postponed (collecting more jobs)
     * - ECONNREFUSED / fetch failed: captcha extension endpoint unreachable
     *   (Chrome/extension not running) — retry when it comes back
     */
    isTransientWait(error) {
        // Cổng chặn (đang trong cool-down 429/403) nghĩa là CHƯA gọi Google lần nào —
        // tính vào attempt sẽ đốt ngân sách bằng chính sự chờ đợi nội bộ.
        if (error.isBackpressure)
            return true;
        if (error.message.includes('ECONNREFUSED') || error.message.includes('fetch failed')) {
            return true;
        }
        return error.message.includes('BATCH_WAIT') || error.message.includes('Failed to collect any jobs for batch');
    }
    isRecaptchaError(error) {
        const msg = error.message || '';
        return msg.includes('reCAPTCHA') || msg.includes('recaptcha') || msg.includes('PERMISSION_DENIED')
            || msg.includes('grecaptcha');
    }
    /**
     * Override getRetryDelay with exponential backoff for reCAPTCHA errors
     * reCAPTCHA: 30s → 60s → 120s (gives Google time to reset)
     * Other errors: 30s flat
     */
    getRetryDelay(attempt, error) {
        // cooldownMs được gán ở các cổng backpressure nhưng trước đây KHÔNG chỗ nào
        // đọc — job chờ theo nhánh mặc định (30s+) thay vì đúng thời gian cool-down
        // còn lại. Tôn trọng nó.
        const cooldownMs = error?.cooldownMs;
        if (typeof cooldownMs === 'number' && cooldownMs > 0) {
            return Math.min(cooldownMs, 120000);
        }
        // 503 (service unavailable): retry fast — 5s, 10s, 15s
        if (error && (error.message.includes('503') || error.message.includes('UNAVAILABLE'))) {
            return Math.min(5000 * (attempt + 1), 15000);
        }
        // reCAPTCHA / other: exponential backoff — 30s, 60s, 120s
        return Math.min(30000 * Math.pow(2, attempt), 120000);
    }
    generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
}
// Per-profile FIFO mutex tail. Each acquire publishes a new tail BEFORE
// awaiting the previous one, so concurrent execute() calls form a chain
// rather than all racing past one shared lock.
VideoUpsamplingHandler.submissionLocks = new Map();
// Track profiles that already have PROCESSING upsampling jobs
VideoUpsamplingHandler.processingProfiles = new Set();
