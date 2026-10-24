/**
 * GenNormal Status Poller
 * Background service to poll status of PROCESSING GenNormal jobs
 * Replaces GenNormalQueueManager.pollJobsStatus
 */
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { Veo3Service } from '../../services/veo3/veo3Service.js';
import { EventEmitter } from 'events';
import { genNormalQueueManager } from '../../modules/genNormal/genNormalQueueManager.js';
import { getProfileCookies } from '../../utils/profileCookies.js';
import { isNonRetryableError, isRetryableError, getFailedJobDisplayMessage } from '../../services/veo3/veo3ErrorHandler.js';
/**
 * `genNormalJob.veo3ProjectId` có thể null (nó chỉ bắt buộc cho request upsample), nên fallback
 * sang bảng join project↔profile — poller đã include sẵn nên không tốn thêm query.
 */
function resolveVeo3ProjectId(job) {
    return (job.veo3ProjectId ||
        job.project?.profiles?.find((p) => p.profileId === job.profileId)?.veo3ProjectId ||
        null);
}
const VIDEO_MODES = new Set([
    'TEXT_TO_VIDEO',
    'REFERENCE_TO_VIDEO',
    'REFERENCE_TO_VIDEO_AUDIO',
    'IMAGE_TO_VIDEO',
    'FRAME_TO_FRAME',
    'VIDEO_GEN',
]);
/**
 * Classify an error message returned by a Veo3 poll into the buckets the
 * poller needs for retry decisions and per-profile cool-down delays.
 *
 * - `isRecaptchaFailure`: score-driven reject — caller must notify the captcha
 *   manager so it can request a reset and apply a longer cool-down (~2 min).
 * - `isRateLimitError`: 429 / 403 / quota / RESOURCE_EXHAUSTED — caller backs
 *   off the profile for ~60 s.
 * - `isRetryable`: union of the two — eligible for an auto-retry within max
 *   attempts.
 */
function classifyPollError(errorMessage) {
    const isRecaptchaFailure = errorMessage.includes('reCAPTCHA evaluation failed') ||
        errorMessage.includes('Xác thực reCAPTCHA thất bại');
    const isRateLimitError = errorMessage.includes('429') ||
        errorMessage.includes('403') ||
        errorMessage.includes('Too Many Requests') ||
        errorMessage.includes('PUBLIC_ERROR_HIGH_TRAFFIC') ||
        errorMessage.includes('PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED') ||
        errorMessage.includes('PUBLIC_ERROR_USER_REQUESTS_THROTTLED') ||
        errorMessage.includes('RESOURCE_EXHAUSTED');
    return {
        isRecaptchaFailure,
        isRateLimitError,
        isRetryable: isRecaptchaFailure || isRateLimitError,
    };
}
/**
 * Fire-and-forget: if project has autoUpscale enabled, check whether ALL gen jobs
 * in the project are done. If yes → batch-create upscale jobs for ALL completed jobs.
 * If gen still running → skip (defer upscale until gen phase finishes).
 *
 * Rationale: upscale during gen causes burst of captcha + API calls → Google rate-limits
 * with TOO_MUCH_TRAFFIC. Gen-first, upscale-last avoids this entirely.
 */
export async function triggerAutoUpscaleIfEnabled(jobId, projectId, jobMode) {
    // Skip upsampling jobs themselves (avoid recursion)
    if (jobMode === 'VIDEO_UPSAMPLING' || jobMode === 'IMAGE_UPSAMPLING')
        return;
    try {
        const project = await prisma.genNormalProject.findUnique({
            where: { id: projectId },
            select: { autoUpscaleVideo: true, autoUpscaleImage: true }
        });
        if (!project)
            return;
        const isVideo = VIDEO_MODES.has(jobMode);
        const isImage = jobMode === 'IMAGE_GENERATION';
        const shouldUpscale = (isVideo && project.autoUpscaleVideo) || (isImage && project.autoUpscaleImage);
        if (!shouldUpscale)
            return;
        // 🔒 DEFER: check if project still has QUEUED or PROCESSING gen jobs (exclude upscale jobs)
        const remainingGenJobs = await prisma.genNormalJob.count({
            where: {
                projectId,
                status: { in: ['QUEUED', 'PROCESSING'] },
                parentJobId: null, // exclude upscale child jobs
            }
        });
        if (remainingGenJobs > 0) {
            logger.debug(`[GenNormalPoller] ⏸️ Auto-upscale deferred for project ${projectId.substring(0, 8)}... (${remainingGenJobs} gen jobs still running)`);
            return;
        }
        // ✅ ALL gen done → batch-create upscale for ALL completed jobs that haven't been upscaled
        logger.info(`[GenNormalPoller] 🔼 All gen jobs done for project ${projectId.substring(0, 8)}... — triggering batch upscale`);
        await triggerDeferredUpscales(projectId);
    }
    catch (err) {
        logger.warn(`[GenNormalPoller] Auto-upscale trigger failed for job ${jobId}: ${err.message}`);
    }
}
/**
 * Batch-create upscale jobs for ALL completed gen jobs in a project.
 * Called once when the last gen job finishes.
 */
export async function triggerDeferredUpscales(projectId) {
    try {
        const project = await prisma.genNormalProject.findUnique({
            where: { id: projectId },
            select: {
                autoUpscaleVideo: true,
                autoUpscaleImage: true,
                imageUpscaleRes: true,
                videoUpscaleRes: true,
            },
        });
        if (!project)
            return;
        // Find all COMPLETED gen jobs that need upscale
        const completedJobs = await prisma.genNormalJob.findMany({
            where: {
                projectId,
                status: 'COMPLETED',
                parentJobId: null, // original gen jobs only (not upscale children)
                upsamplingJobId: null, // not already queued for upscale
                isUpsampled: false, // not already upscaled
                resultUrl: { not: null }, // has result
            },
            select: { id: true, mode: true }
        });
        if (completedJobs.length === 0) {
            logger.info(`[GenNormalPoller] No jobs to upscale in project ${projectId.substring(0, 8)}...`);
            return;
        }
        // Filter by mode + project settings
        const jobsToUpscale = completedJobs.filter(j => {
            const isVideo = VIDEO_MODES.has(j.mode || '');
            const isImage = j.mode === 'IMAGE_GENERATION';
            return (isVideo && project.autoUpscaleVideo) || (isImage && project.autoUpscaleImage);
        });
        if (jobsToUpscale.length === 0)
            return;
        // Honour the user's per-project UI choice from `imageUpscaleRes` /
        // `videoUpscaleRes`. NULL → safer default (image=2K, video=1080P).
        const imageRes = project.imageUpscaleRes === '4K' ? '4K' : '2K';
        const videoRes = project.videoUpscaleRes === '4K' ? '4K' : '1080P';
        logger.info(`[GenNormalPoller] 🔼 Batch upscale: creating ${jobsToUpscale.length} upscale jobs for project ${projectId.substring(0, 8)}... (image=${imageRes}, video=${videoRes})`);
        const { genNormalService } = await import('../../modules/genNormal/genNormal.service.js');
        let created = 0;
        for (const job of jobsToUpscale) {
            try {
                const isImage = job.mode === 'IMAGE_GENERATION';
                const resolution = isImage ? imageRes : videoRes;
                await genNormalService.upsampleJob(job.id, resolution);
                created++;
            }
            catch (err) {
                logger.warn(`[GenNormalPoller] Failed to create upscale for job ${job.id}: ${err.message}`);
            }
        }
        logger.info(`[GenNormalPoller] ✅ Batch upscale: ${created}/${jobsToUpscale.length} upscale jobs created`);
    }
    catch (err) {
        logger.error(`[GenNormalPoller] triggerDeferredUpscales failed: ${err.message}`);
    }
}
/**
 * Deferred upscale chỉ được kích hoạt bởi completion event — batch kết thúc
 * "bẩn" (job cuối FAILED, user bấm Dừng, rời trang cancel QUEUED) sẽ không còn
 * event nào và các video đã COMPLETED kẹt ở bản thường vĩnh viễn. Gọi hàm này
 * từ mọi điểm chốt terminal; an toàn gọi trùng vì triggerDeferredUpscales
 * idempotent (filter upsamplingJobId:null + isUpsampled:false).
 */
// Cooldown per-project: upscale FAIL → cleanupFailedUpsampling reset
// upsamplingJobId → updateProjectStats → hàm này tạo upscale MỚI → FAIL → …
// Không có cooldown, một account bị Google từ chối upscale sẽ spin theo tốc độ
// poll và đốt quota. 5 phút/lần vẫn đủ retry cho lỗi thoáng qua.
const deferredUpscaleCooldown = new Map();
const DEFERRED_UPSCALE_COOLDOWN_MS = 5 * 60000;
export async function maybeTriggerDeferredUpscales(projectId) {
    try {
        const now = Date.now();
        if (now - (deferredUpscaleCooldown.get(projectId) ?? 0) < DEFERRED_UPSCALE_COOLDOWN_MS) {
            return;
        }
        const project = await prisma.genNormalProject.findUnique({
            where: { id: projectId },
            select: { autoUpscaleVideo: true, autoUpscaleImage: true }
        });
        if (!project || (!project.autoUpscaleVideo && !project.autoUpscaleImage))
            return;
        const remainingGenJobs = await prisma.genNormalJob.count({
            where: {
                projectId,
                status: { in: ['QUEUED', 'PROCESSING'] },
                parentJobId: null,
            }
        });
        if (remainingGenJobs > 0)
            return;
        // Đếm ứng viên trước để những lần gọi no-op (vd sau mỗi upscale hoàn tất)
        // không spam log của triggerDeferredUpscales.
        const candidates = await prisma.genNormalJob.count({
            where: {
                projectId,
                status: 'COMPLETED',
                parentJobId: null,
                upsamplingJobId: null,
                isUpsampled: false,
                resultUrl: { not: null },
            }
        });
        if (candidates === 0)
            return;
        // Chỉ set cooldown khi THỰC SỰ tạo upscale — call no-op không được đốt
        // window, nếu không một lần gọi rỗng có thể chặn lần trigger thật ngay sau.
        deferredUpscaleCooldown.set(projectId, now);
        await triggerDeferredUpscales(projectId);
    }
    catch (err) {
        logger.warn(`[GenNormalPoller] maybeTriggerDeferredUpscales failed for ${projectId.substring(0, 8)}...: ${err.message}`);
    }
}
/** Status nghĩa là "đang chạy, poll tiếp". Bất cứ gì ngoài danh sách này mà
 *  không được xử lý tường minh đều là bug tiềm ẩn (job treo). */
const KNOWN_ACTIVE_STATUSES = new Set([
    'MEDIA_GENERATION_STATUS_ACTIVE',
    'MEDIA_GENERATION_STATUS_PROCESSING',
    'MEDIA_GENERATION_STATUS_PENDING',
    'MEDIA_GENERATION_STATUS_SCHEDULED',
    'MEDIA_GENERATION_STATUS_UNSPECIFIED',
    'ACTIVE',
    'PROCESSING',
    'PENDING',
    'SCHEDULED',
]);
export class GenNormalStatusPoller extends EventEmitter {
    constructor() {
        super(...arguments);
        this.isRunning = false;
        this.pollInterval = null;
        this.POLL_INTERVAL_MS = 5000; // Poll every 5 seconds
        this.TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes timeout
        this.GRACE_PERIOD_MS = 180 * 1000; // 180 seconds (3 minutes) grace period for API submission
        // Track recently completed job IDs to skip redundant polls
        // Jobs are removed after 30s (6 poll cycles) to prevent memory leak
        this.recentlyCompletedJobIds = new Set();
        this.recentlyCompletedTimestamps = new Map();
        // Guard against overlapping poll cycles
        this.isPolling = false;
        // Job SUCCESSFUL nhưng resolve URL fail (getMediaUrlRedirect null — thường do
        // TLS recycle transient): KHÔNG complete với URL rỗng ngay; giữ PROCESSING để
        // tick 5s sau resolve lại, tối đa MAX_URL_RETRIES tick. providerIdSnapshot để
        // reset counter khi job bị resubmit (providerJobId đổi). In-memory là đủ —
        // restart server chỉ tốn thêm 1 cửa sổ retry, không cần migration.
        this.urlRetryCounters = new Map();
        this.MAX_URL_RETRIES = 3;
    }
    /**
     * true = còn lượt retry → caller return luôn (giữ PROCESSING, tick sau thử lại).
     * false = đã hết lượt (counter tự xoá) → caller complete với URL_PENDING.
     */
    shouldDeferUrlResolve(job) {
        const snapshot = job.providerJobId ?? '';
        const existing = this.urlRetryCounters.get(job.id);
        const now = Date.now();
        const sameSnapshot = existing?.providerIdSnapshot === snapshot;
        // Batch fail giữa chừng → fallback pollJobStatus có thể gọi lại trong CÙNG
        // tick — không được ăn 2 lượt retry cho 1 tick thật.
        const withinSameTick = sameSnapshot && now - existing.lastIncrementedAt < 3000;
        const count = sameSnapshot ? (withinSameTick ? existing.count : existing.count + 1) : 1;
        if (count <= this.MAX_URL_RETRIES) {
            this.urlRetryCounters.set(job.id, { count, providerIdSnapshot: snapshot, lastIncrementedAt: withinSameTick ? existing.lastIncrementedAt : now });
            logger.warn(`[GenNormalPoller] ⏳ Job #${job.jobIndex} SUCCESSFUL nhưng chưa lấy được URL (lần ${count}/${this.MAX_URL_RETRIES}) — giữ PROCESSING, thử lại tick sau`, { jobId: job.id });
            return true;
        }
        this.urlRetryCounters.delete(job.id);
        logger.error(`[GenNormalPoller] ❌ Job #${job.jobIndex} SUCCESSFUL nhưng URL không resolve được sau ${this.MAX_URL_RETRIES} lần — complete với URL_PENDING (user refresh link được)`, { jobId: job.id });
        return false;
    }
    /**
     * Start polling status
     */
    start() {
        if (this.isRunning) {
            logger.warn('[GenNormalPoller] Already running');
            return;
        }
        this.isRunning = true;
        this.pollInterval = setInterval(() => {
            this.pollJobsStatus().catch(err => {
                logger.error('[GenNormalPoller] Error in poll cycle:', err);
            });
        }, this.POLL_INTERVAL_MS);
        logger.info('[GenNormalPoller] Started status polling', {
            intervalMs: this.POLL_INTERVAL_MS
        });
    }
    /**
     * Stop polling
     */
    stop() {
        if (!this.isRunning) {
            return;
        }
        this.isRunning = false;
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        logger.info('[GenNormalPoller] Stopped status polling');
    }
    /**
     * Poll status for all PROCESSING jobs
     * Groups video jobs by profile for batch polling, images are polled individually
     */
    async pollJobsStatus() {
        if (!this.isRunning)
            return;
        if (this.isPolling)
            return; // Skip if previous cycle still running
        this.isPolling = true;
        try {
            // Get all PROCESSING jobs (exclude upsampling jobs which have parentJobId)
            // Limit to 100 jobs per poll cycle to prevent memory issues with 1000+ jobs
            const processingJobs = await prisma.genNormalJob.findMany({
                where: {
                    status: 'PROCESSING',
                    parentJobId: null // Exclude upsampling jobs (they are polled separately)
                },
                take: 100,
                orderBy: { startedAt: 'asc' }, // Oldest first
                include: {
                    profile: true,
                    project: {
                        include: {
                            profiles: {
                                include: {
                                    profile: true
                                }
                            }
                        }
                    }
                }
            });
            // Cleanup stale entries from recently completed set (older than 30s)
            const now = Date.now();
            for (const [jobId, timestamp] of this.recentlyCompletedTimestamps) {
                if (now - timestamp > 30000) {
                    this.recentlyCompletedJobIds.delete(jobId);
                    this.recentlyCompletedTimestamps.delete(jobId);
                }
            }
            // Filter out jobs we already completed (prevents redundant polls from DB timing)
            const filteredJobs = processingJobs.filter(j => !this.recentlyCompletedJobIds.has(j.id));
            if (filteredJobs.length > 0) {
                logger.debug(`[GenNormalPoller] Polling ${filteredJobs.length} PROCESSING jobs${processingJobs.length !== filteredJobs.length ? ` (${processingJobs.length - filteredJobs.length} skipped as recently completed)` : ''}`);
                // Separate video jobs from image jobs
                // Video modes that can be batch polled
                const videoBatchModes = ['TEXT_TO_VIDEO', 'REFERENCE_TO_VIDEO', 'REFERENCE_TO_VIDEO_AUDIO', 'IMAGE_TO_VIDEO', 'FRAME_TO_FRAME'];
                const videoJobs = filteredJobs.filter(j => videoBatchModes.includes(j.mode || '') &&
                    j.providerJobId &&
                    j.sceneId &&
                    !j.providerJobId.startsWith('CA') // Skip jobs with mediaId (already completed)
                );
                const otherJobs = filteredJobs.filter(j => !videoBatchModes.includes(j.mode || '') ||
                    !j.providerJobId ||
                    !j.sceneId ||
                    j.providerJobId.startsWith('CA') // Jobs with mediaId need individual handling
                );
                // Batch poll video jobs by profile (up to 4 jobs per batch)
                if (videoJobs.length > 0) {
                    await this.batchPollVideoJobs(videoJobs);
                }
                // Poll other jobs individually (images, jobs missing providerJobId, etc.)
                for (const job of otherJobs) {
                    if (!this.isRunning)
                        break;
                    await this.pollJobStatus(job);
                    // Wait 1s before next job (user requirement)
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
            // Also poll upsampling jobs
            await this.pollUpsamplingJobs();
        }
        catch (error) {
            logger.error('[GenNormalPoller] Error polling jobs status:', error);
        }
        finally {
            this.isPolling = false;
        }
    }
    /**
     * ✅ BATCH POLL: Poll video jobs in batches by profile
     * Groups up to 4 jobs per profile and uses batchCheckAsyncVideoGenerationStatus
     * Reduces API calls by 75% (4 status checks → 1 batch check)
     */
    async batchPollVideoJobs(videoJobs) {
        // Group jobs by profile
        const jobsByProfile = new Map();
        for (const job of videoJobs) {
            const profileId = job.profileId;
            if (!jobsByProfile.has(profileId)) {
                jobsByProfile.set(profileId, []);
            }
            jobsByProfile.get(profileId).push(job);
        }
        logger.debug(`[GenNormalPoller] 🎬 Batch polling ${videoJobs.length} video jobs across ${jobsByProfile.size} profiles`);
        // Process each profile's jobs in batches of up to 4
        for (const [profileId, jobs] of jobsByProfile) {
            if (!this.isRunning)
                break;
            // Split into batches of 4
            const batches = [];
            for (let i = 0; i < jobs.length; i += 4) {
                batches.push(jobs.slice(i, i + 4));
            }
            for (const batch of batches) {
                if (!this.isRunning)
                    break;
                try {
                    await this.pollVideoBatch(profileId, batch);
                }
                catch (error) {
                    const errorMessage = error?.message || String(error);
                    if (this.isTransientBrowserFetchPollError(errorMessage)) {
                        logger.warn(`[GenNormalPoller] Transient batch poll error for profile ${profileId} — keeping jobs in running queue`, { profileId, error: errorMessage.substring(0, 200) });
                        continue;
                    }
                    logger.error(`[GenNormalPoller] Error batch polling profile ${profileId}:`, errorMessage);
                    // Fall back to individual polling for this batch
                    for (const job of batch) {
                        if (!this.isRunning)
                            break;
                        await this.pollJobStatus(job);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
                // Wait 1s between batches
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }
    isTransientBrowserFetchPollError(errorMessage) {
        return (errorMessage.includes('XHRError') ||
            errorMessage.includes('browser-fetch error') ||
            errorMessage.includes('CORS / CSP / offline') ||
            errorMessage.includes('Network error (CORS / CSP / offline)') ||
            errorMessage.includes('status: 0'));
    }
    /**
     * Build `{name, projectId, sceneId}` items for the media-shape status poll
     * (`batchCheckMediaGenerationStatus`). Jobs whose veo3ProjectId cannot be
     * resolved are returned in `missing` — they cannot be polled by the media
     * endpoint (which requires projectId per item).
     */
    buildMediaPollItems(jobs) {
        const items = [];
        const missing = [];
        for (const job of jobs) {
            const projectId = resolveVeo3ProjectId(job);
            if (!projectId || !job.providerJobId) {
                missing.push(job);
                continue;
            }
            // Echo the SAME sceneId key the match maps use (`job.sceneId || providerJobId`)
            // so batch matching still works when a job has no sceneId of its own.
            items.push({ name: job.providerJobId, projectId, sceneId: job.sceneId || job.providerJobId });
        }
        return { items, missing };
    }
    /**
     * A media-shape job with no resolvable veo3ProjectId can never be polled —
     * mark it FAILED so it stops looping the poller instead of hanging PROCESSING.
     */
    async failJobMissingProjectId(job) {
        logger.error(`[GenNormalPoller] Job #${job.jobIndex} thiếu veo3ProjectId — không thể kiểm tra trạng thái (Veo 3.1 media poll), đánh FAILED`, { jobId: job.id, providerJobId: job.providerJobId?.substring(0, 20) });
        await prisma.genNormalJob.update({
            where: { id: job.id },
            data: {
                status: 'FAILED',
                error: 'Thiếu veo3ProjectId để kiểm tra trạng thái (Veo 3.1 media poll)',
            },
        });
        genNormalQueueManager.markJobCompleted(job.id, job.profileId);
        this.emit('job:failed', job.id, new Error('Missing veo3ProjectId for media poll'));
        await this.updateProjectStats(job.projectId);
    }
    /**
     * Normalize one `batchCheckMediaGenerationStatus` operation (already converted
     * to the legacy `{operation:{metadata:{video}}}` shape) into the same result
     * object `pollVideoStatusNormalized` returns. `null` when no operation came back.
     */
    normalizeMediaOperation(op) {
        if (!op)
            return null;
        const raw = op.status;
        let status = 'PENDING';
        if (raw === 'MEDIA_GENERATION_STATUS_ACTIVE' || raw === 'MEDIA_GENERATION_STATUS_PROCESSING') {
            status = 'PROCESSING';
        }
        else if (raw === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') {
            status = 'COMPLETED';
        }
        else if (raw === 'MEDIA_GENERATION_STATUS_FAILED') {
            status = 'FAILED';
        }
        const video = op.operation?.metadata?.video;
        const progress = status === 'COMPLETED' ? 100 : status === 'FAILED' ? 0 : 50;
        return {
            status,
            videoUrl: video?.fifeUrl || undefined,
            mediaId: video?.mediaGenerationId || undefined,
            error: status === 'FAILED' ? video?.error?.message || 'Video generation failed' : undefined,
            progress,
        };
    }
    /**
     * Poll a batch of video jobs for a single profile. Veo 3.1 (useV2ModelConfig)
     * jobs use the media-shape endpoint; legacy jobs use the operations endpoint.
     */
    async pollVideoBatch(profileId, jobs) {
        if (jobs.length === 0)
            return;
        const firstJob = jobs[0];
        // Get cookies from partition
        const cookiesString = await getProfileCookies(firstJob.profile.id);
        const veo3Service = new Veo3Service();
        veo3Service.updateConfig({
            accessToken: firstJob.profile.accessToken || undefined,
            cookies: cookiesString,
            profileId: firstJob.profile.id
        });
        // Veo 3.1 (useV2ModelConfig) submits return a media resource — its UUID is
        // stored in providerJobId and its workflowId in flowWorkflowId. Polling that
        // media UUID via the legacy `{operations:[{operation:{name}}]}` endpoint is
        // rejected 400 INVALID_ARGUMENT; it must go through the media-shape endpoint
        // `{media:[{name, projectId}]}`. `batchCheckMediaGenerationStatus` normalizes
        // its response back to the same `{operations:[...]}` shape, so the matching +
        // result processing below is identical for both. Legacy jobs (no
        // flowWorkflowId) keep the operations endpoint.
        const mediaJobs = jobs.filter(j => j.flowWorkflowId && j.providerJobId);
        const legacyJobs = jobs.filter(j => !j.flowWorkflowId && j.providerJobId);
        // sceneId → job map. Fallback: providerJobId (media.name) khi response không
        // echo sceneId (Google đôi khi không echo lại với UUID làm sceneId).
        const sceneIdToJob = new Map();
        for (const job of jobs) {
            const key = job.sceneId || job.providerJobId;
            if (key)
                sceneIdToJob.set(key, job);
        }
        const providerIdToJob = new Map();
        for (const job of jobs) {
            if (job.providerJobId)
                providerIdToJob.set(job.providerJobId, job);
        }
        logger.debug(`[GenNormalPoller] 🎬 Batch polling ${jobs.length} jobs (${mediaJobs.length} media, ${legacyJobs.length} legacy) for profile ${profileId.substring(0, 8)}...`, {
            sceneIds: jobs.map(j => j.sceneId),
            operationNames: jobs.map(j => j.providerJobId?.substring(0, 20)),
        });
        const allResultOperations = [];
        if (legacyJobs.length > 0) {
            const operations = legacyJobs.map(job => ({
                operation: { name: job.providerJobId },
                sceneId: (job.sceneId || job.providerJobId),
                status: 'MEDIA_GENERATION_STATUS_ACTIVE',
            }));
            const legacyResponse = await veo3Service.batchCheckAsyncVideoGenerationStatus({ operations });
            allResultOperations.push(...(legacyResponse.operations || []));
        }
        if (mediaJobs.length > 0) {
            const { items, missing } = this.buildMediaPollItems(mediaJobs);
            for (const job of missing)
                await this.failJobMissingProjectId(job);
            if (items.length > 0) {
                const mediaResponse = await veo3Service.batchCheckMediaGenerationStatus(items);
                allResultOperations.push(...(mediaResponse.operations || []));
            }
        }
        if (allResultOperations.length === 0) {
            logger.warn(`[GenNormalPoller] No status results returned for profile ${profileId.substring(0, 8)}...`);
            return;
        }
        for (const operation of allResultOperations) {
            // Match by operation NAME first (providerJobId) — it is guaranteed unique per
            // async operation, so batch-of-N videos each map to their own job reliably.
            // Google's status API is keyed by operation name (there is NO batchId lookup),
            // so this is the correct primary key. sceneId is only a fallback (it can collide
            // across reuse/retry paths, which would silently mismap one job in a batch).
            const opName = operation.operation?.name || operation.operation?.metadata?.name;
            let job = opName ? providerIdToJob.get(opName) : undefined;
            if (!job && operation.sceneId) {
                job = sceneIdToJob.get(operation.sceneId);
            }
            if (!job) {
                logger.warn(`[GenNormalPoller] ⚠️ Batch status result not matched to any job (sceneId=${operation.sceneId}, name=${operation.operation?.name?.substring(0, 20)})`);
                continue;
            }
            await this.processVideoStatusResult(job, operation, veo3Service);
        }
        logger.debug(`[GenNormalPoller] 🎬 Batch poll complete for profile ${profileId.substring(0, 8)}...`, {
            jobsProcessed: allResultOperations.length,
        });
    }
    /**
     * Process status result for a single video job from batch poll
     */
    async processVideoStatusResult(job, operation, veo3Service) {
        // 🔒 GUARD: chỉ xử lý khi job VẪN đang PROCESSING và kết quả đúng là của operation nó đang sở hữu.
        // `job` là snapshot chụp lúc đầu chu kỳ; poll interval (5s) ngắn hơn thời gian gọi API (~10s) nên
        // hai chu kỳ liên tiếp có thể cùng chụp một job trước khi lần requeue đầu kịp ghi DB. Nếu chỉ chặn
        // FAILED/COMPLETED, phán quyết của op cũ sẽ đổ lên job đã QUEUED → một lần hỏng bị tính 2-3 retry.
        const currentJob = await prisma.genNormalJob.findUnique({
            where: { id: job.id },
            select: { status: true, providerJobId: true }
        });
        if (currentJob?.status !== 'PROCESSING') {
            logger.debug(`[GenNormalPoller] Skipping job #${job.jobIndex} - status=${currentJob?.status ?? 'not found'}`, {
                jobId: job.id
            });
            return;
        }
        // So SNAPSHOT (op ta thực sự đã poll) với giá trị hiện tại trong DB — KHÔNG so với tên op
        // Google echo về. Lý do: khi response không echo tên, pollVideoBatch ghép job bằng fallback
        // sceneId; nếu guard dựa vào echo thì kết quả hợp lệ sẽ bị vứt và job treo vĩnh viễn
        // (nhánh batch không có timeout). Snapshot khác DB ⇒ job đã được submit lại ⇒ kết quả này
        // thuộc về op đã bị thay thế.
        if (job.providerJobId && currentJob.providerJobId !== job.providerJobId) {
            logger.warn(`[GenNormalPoller] Bỏ kết quả của op đã bị thay thế cho job #${job.jobIndex} (polled=${String(job.providerJobId).substring(0, 12)} current=${String(currentJob.providerJobId).substring(0, 12)})`, { jobId: job.id });
            return;
        }
        const status = operation.status;
        const videoMetadata = operation.operation?.metadata?.video;
        // Calculate progress incrementally for PROCESSING jobs
        // ACTIVE status means video is still being generated
        let newProgress = job.progress || 10;
        if (status === 'MEDIA_GENERATION_STATUS_ACTIVE' || status === 'ACTIVE' ||
            status === 'MEDIA_GENERATION_STATUS_PROCESSING' || status === 'PROCESSING' ||
            status === 'MEDIA_GENERATION_STATUS_PENDING' || status === 'PENDING') {
            const increment = Math.floor(Math.random() * 4) + 2; // 2-5% per poll
            newProgress = Math.min(99, Math.max(newProgress, job.progress || 10) + increment);
            // Update progress in DB for active jobs
            await prisma.genNormalJob.update({
                where: { id: job.id },
                data: { progress: newProgress }
            });
            logger.debug(`[GenNormalPoller] 🔄 Job #${job.jobIndex} still active, progress: ${newProgress}%`, {
                jobId: job.id,
                status
            });
            return; // Job still active, will be polled again next cycle
        }
        else if (status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL' || status === 'SUCCESSFUL' || status === 'COMPLETED') {
            newProgress = 100;
        }
        // Handle completion
        if (status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL' || status === 'SUCCESSFUL' || status === 'COMPLETED') {
            const videoUrl = videoMetadata?.fifeUrl || null;
            const mediaId = videoMetadata?.mediaGenerationId || operation.operation?.metadata?.name || '';
            if (!videoUrl) {
                // Gen xong nhưng resolve link fail (transient) — đừng chôn job với URL
                // rỗng. Giữ PROCESSING để tick sau resolve lại; hết lượt mới complete
                // kèm lastDownloadError để nút "Tải lại/Refresh link" cứu được.
                if (this.shouldDeferUrlResolve(job))
                    return;
                await prisma.genNormalJob.update({
                    where: { id: job.id },
                    data: {
                        status: 'COMPLETED',
                        completedAt: new Date(),
                        resultUrl: null,
                        lastDownloadError: 'URL_PENDING',
                        progress: 100,
                        providerJobId: mediaId.startsWith('CA') ? mediaId : job.providerJobId
                    }
                });
                genNormalQueueManager.markJobCompleted(job.id, job.profileId);
                this.recentlyCompletedJobIds.add(job.id);
                this.recentlyCompletedTimestamps.set(job.id, Date.now());
                this.emit('job:completed', job.id, { resultUrl: null });
                await this.updateProjectStats(job.projectId);
                // KHÔNG triggerAutoUpscale — job không có URL thì upscale vô nghĩa.
                return;
            }
            this.urlRetryCounters.delete(job.id);
            await prisma.genNormalJob.update({
                where: { id: job.id },
                data: {
                    status: 'COMPLETED',
                    completedAt: new Date(),
                    resultUrl: videoUrl,
                    progress: 100,
                    providerJobId: mediaId.startsWith('CA') ? mediaId : job.providerJobId
                }
            });
            genNormalQueueManager.markJobCompleted(job.id, job.profileId);
            // Track as recently completed to prevent redundant polls
            this.recentlyCompletedJobIds.add(job.id);
            this.recentlyCompletedTimestamps.set(job.id, Date.now());
            logger.info(`[GenNormalPoller] ✅ Batch job #${job.jobIndex} completed (${job.id.slice(0, 12)} url=${(videoUrl || '').substring(0, 80)})`);
            this.emit('job:completed', job.id, { resultUrl: videoUrl });
            await this.updateProjectStats(job.projectId);
            // Auto-upscale: fire-and-forget, runs in parallel with remaining gen jobs
            triggerAutoUpscaleIfEnabled(job.id, job.projectId, job.mode).catch(() => { });
        }
        // Handle failure
        else if (status === 'MEDIA_GENERATION_STATUS_FAILED' ||
            status === 'FAILED' ||
            // Google tự huỷ khi tạo quá lâu. Đây là kết quả CUỐI CÙNG, không phải
            // trạng thái tạm — bỏ sót nó là job nằm PROCESSING tới khi watchdog
            // force-fail với lý do sai.
            status === 'MEDIA_GENERATION_STATUS_TIMEOUT' ||
            status === 'TIMEOUT') {
            this.urlRetryCounters.delete(job.id); // dọn state defer-URL nếu có
            // Shape legacy `{operations:[...]}` cho ta fifeUrl nhưng KHÔNG kèm lý do hỏng. Thiếu lý do thì
            // mọi lỗi đều thành 'Video generation failed' → isNonRetryableError không nhận ra content-filter
            // (vd PUBLIC_ERROR_AUDIO_FILTERED) → retry 3 lần vô ích, mỗi lần là một generation thật.
            // Hỏi lại bằng shape `{media:[...]}` — chỉ khi FAILED nên không ảnh hưởng tải poll thường.
            let rawCode = videoMetadata?.error?.message || null;
            if (!rawCode) {
                const opName = operation.operation?.name ||
                    operation.operation?.metadata?.name ||
                    currentJob.providerJobId;
                const veo3ProjectId = resolveVeo3ProjectId(job);
                if (opName && veo3ProjectId) {
                    rawCode = await veo3Service.fetchMediaFailureReason(opName, veo3ProjectId);
                    if (rawCode) {
                        logger.info(`[GenNormalPoller] Lý do hỏng thật của job #${job.jobIndex}: ${rawCode}`, {
                            jobId: job.id
                        });
                    }
                }
            }
            const errorMessage = rawCode || 'Video generation failed';
            const humanError = getFailedJobDisplayMessage(errorMessage);
            // Nối mã gốc vào CUỐI (không bao giờ chèn lên đầu — renderer nhận diện marker
            // RATE_LIMIT_RETRY:/RETRY:/quota bằng startsWith). isNonRetryableError dùng .includes()
            // nên guard tuyến hai ở genNormalQueueManager vẫn khớp được mã gốc trong job.error.
            const displayError = rawCode && !humanError.includes(rawCode) ? `${humanError} (${rawCode})` : humanError;
            // Check retry count
            const jobRetryInfo = await prisma.genNormalJob.findUnique({
                where: { id: job.id },
                select: { retryCount: true, maxRetries: true, startedAt: true }
            });
            const retryCount = jobRetryInfo?.retryCount || 0;
            const MAX_GEN_RETRIES = 3;
            // P1 #6: Fast failure detection.
            // Nếu job chạy < 30s mà Google trả FAILED + error generic → rất có khả năng là
            // content policy / internal Google reject. Retry sẽ không giúp và còn trigger
            // 429 rate limit phụ cho profile. Mark non-retryable.
            const FAST_FAIL_THRESHOLD_MS = 30000;
            const runningTimeMs = jobRetryInfo?.startedAt
                ? Date.now() - new Date(jobRetryInfo.startedAt).getTime()
                : Number.MAX_SAFE_INTEGER;
            const isFastFailure = runningTimeMs < FAST_FAIL_THRESHOLD_MS;
            // Determine if we should retry:
            // 1. Explicitly retryable errors (429, 503, reCAPTCHA) → always retry up to maxRetries
            // 2. Explicitly non-retryable (content policy) → never retry
            // 3. Fast failure (< 30s + generic error) → mark non-retryable (P1 #6)
            // 4. Generic errors ("Video generation failed") → retry up to 3 times, then fail
            const explicitlyRetryable = isRetryableError(errorMessage);
            const explicitlyNonRetryable = (isNonRetryableError(errorMessage) && !explicitlyRetryable) ||
                (isFastFailure && !explicitlyRetryable);
            const maxRetries = explicitlyRetryable ? (jobRetryInfo?.maxRetries || 10) : MAX_GEN_RETRIES;
            const shouldRetry = !explicitlyNonRetryable && retryCount < maxRetries;
            if (isFastFailure && !explicitlyRetryable) {
                logger.warn(`[GenNormalPoller] 🚫 Fast failure detected (${Math.round(runningTimeMs / 1000)}s) → mark non-retryable`, {
                    jobId: job.id,
                    runningTimeMs,
                    error: errorMessage.substring(0, 100)
                });
            }
            if (shouldRetry) {
                // Only apply heavy rate-limit delay (60s) for actual rate-limit / reCAPTCHA errors.
                // Generic "Video generation failed" is a server-side generation failure — retry
                // quickly (5s) without blocking the entire profile queue.
                const isActualRateLimit = explicitlyRetryable; // 429, 503, reCAPTCHA, quota errors
                const retryDelay = isActualRateLimit ? 60 : 5;
                await genNormalQueueManager.requeueJobForRateLimitRetry(job.id, job.profileId, errorMessage, retryDelay, !isActualRateLimit);
                logger.warn(`[GenNormalPoller] 🔄 Batch job #${job.jobIndex} failed, retrying (${retryCount + 1}/${maxRetries}) delay=${retryDelay}s (${job.id.slice(0, 12)} err="${errorMessage.substring(0, 80)}")`);
            }
            else {
                // Max retries reached or non-retryable → mark FAILED
                const failReason = explicitlyNonRetryable ? 'not retryable' : `max retries (${maxRetries})`;
                await prisma.genNormalJob.update({
                    where: { id: job.id },
                    data: {
                        status: 'FAILED',
                        error: displayError,
                        completedAt: new Date()
                    }
                });
                genNormalQueueManager.markJobCompleted(job.id, job.profileId);
                // Track as recently completed to prevent redundant polls
                this.recentlyCompletedJobIds.add(job.id);
                this.recentlyCompletedTimestamps.set(job.id, Date.now());
                logger.error(`[GenNormalPoller] ❌ Batch job #${job.jobIndex} failed (${failReason}, retryCount=${retryCount}, ${job.id.slice(0, 12)}) err="${errorMessage.substring(0, 120)}"`);
                this.emit('job:failed', job.id, new Error(displayError));
                await this.updateProjectStats(job.projectId);
            }
        }
        // Still processing - update progress
        else {
            await prisma.genNormalJob.update({
                where: { id: job.id },
                data: { progress: newProgress }
            });
            // Mọi status đã biết đều được xử lý ở trên. Một status lạ rơi xuống đây
            // sẽ giữ job PROCESSING vô hạn (đúng thứ đã xảy ra với TIMEOUT), nên nó
            // phải hiện trong log thay vì im lặng ở mức debug.
            if (!KNOWN_ACTIVE_STATUSES.has(String(status))) {
                logger.warn(`[GenNormalPoller] ⚠️ Job #${job.jobIndex}: status lạ "${status}" — giữ PROCESSING, cần bổ sung xử lý`, { jobId: job.id });
            }
            else {
                logger.debug(`[GenNormalPoller] Batch job #${job.jobIndex} still processing`, {
                    jobId: job.id,
                    status,
                    progress: newProgress
                });
            }
        }
    }
    /**
     * ✅ BATCH POLL: Poll status for upsampling jobs in batches by profile
     * Jobs that have parentJobId are upsampling jobs (clones created for upsampling)
     * Groups up to 4 jobs per profile and uses batchCheckAsyncVideoGenerationStatus
     */
    async pollUpsamplingJobs() {
        if (!this.isRunning)
            return;
        try {
            // Get all upsampling jobs (jobs with parentJobId - these are clones created for upsampling)
            const upsamplingJobs = await prisma.genNormalJob.findMany({
                where: {
                    parentJobId: { not: null }, // Upsampling jobs have parentJobId
                    status: 'PROCESSING', // Only poll PROCESSING jobs (not QUEUED)
                    providerJobId: { not: null }, // Must have operation name
                    sceneId: { not: null } // Must have sceneId
                },
                include: {
                    profile: true,
                    project: {
                        include: {
                            profiles: {
                                include: {
                                    profile: true
                                }
                            }
                        }
                    }
                },
                orderBy: { startedAt: 'asc' }
            });
            if (upsamplingJobs.length === 0) {
                return;
            }
            // Filter out jobs where providerJobId is a mediaId (starts with 'CA')
            const validUpsamplingJobs = upsamplingJobs.filter(job => {
                if (!job.providerJobId || job.providerJobId.startsWith('CA')) {
                    logger.debug(`[GenNormalPoller] Upsampling job #${job.jobIndex} has mediaId as providerJobId, skipping batch poll`, {
                        jobId: job.id,
                        providerJobId: job.providerJobId?.substring(0, 30)
                    });
                    return false;
                }
                return true;
            });
            if (validUpsamplingJobs.length === 0) {
                return;
            }
            // 🚫 Filter out jobs from cancelled projects
            const activeUpsamplingJobs = validUpsamplingJobs.filter(job => {
                if (genNormalQueueManager.isProjectCancelled(job.projectId)) {
                    logger.info(`[GenNormalPoller] 🚫 Skipping upsampling poll for job #${job.jobIndex} - project cancelled`, {
                        jobId: job.id,
                        projectId: job.projectId
                    });
                    return false;
                }
                return true;
            });
            if (activeUpsamplingJobs.length === 0) {
                return;
            }
            logger.debug(`[GenNormalPoller] 🔄 Batch polling ${activeUpsamplingJobs.length} upsampling jobs`);
            // ✅ BATCH: Group jobs by profile and poll in batches of up to 4
            const jobsByProfile = new Map();
            for (const job of activeUpsamplingJobs) {
                const profileId = job.profileId;
                if (!profileId)
                    continue;
                if (!jobsByProfile.has(profileId)) {
                    jobsByProfile.set(profileId, []);
                }
                jobsByProfile.get(profileId).push(job);
            }
            // Process each profile's jobs in batches of up to 4
            for (const [profileId, jobs] of jobsByProfile) {
                if (!this.isRunning)
                    break;
                // Split into batches of 4
                const batches = [];
                for (let i = 0; i < jobs.length; i += 4) {
                    batches.push(jobs.slice(i, i + 4));
                }
                for (const batch of batches) {
                    if (!this.isRunning)
                        break;
                    try {
                        await this.pollUpsamplingBatch(profileId, batch);
                    }
                    catch (error) {
                        logger.error(`[GenNormalPoller] Error batch polling upsampling for profile ${profileId.substring(0, 8)}...`, {
                            error: error.message
                        });
                        // Fall back to individual polling for this batch
                        for (const job of batch) {
                            if (!this.isRunning)
                                break;
                            try {
                                await this.pollUpsamplingJobStatus(job, job.providerJobId, job.sceneId);
                            }
                            catch (individualError) {
                                logger.error(`[GenNormalPoller] Error polling individual upsampling job #${job.jobIndex}:`, {
                                    error: individualError.message
                                });
                            }
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                    }
                    // Wait 1s between batches
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }
        catch (error) {
            logger.error('[GenNormalPoller] Error polling upsampling jobs:', error);
        }
    }
    /**
     * ✅ BATCH: Poll a batch of upsampling jobs for a single profile using batchCheckAsyncVideoGenerationStatus
     */
    async pollUpsamplingBatch(profileId, jobs) {
        if (jobs.length === 0)
            return;
        const firstJob = jobs[0];
        // Get cookies from partition
        const cookiesString = await getProfileCookies(firstJob.profile.id);
        const veo3Service = new Veo3Service();
        veo3Service.updateConfig({
            accessToken: firstJob.profile.accessToken || undefined,
            cookies: cookiesString,
            profileId: firstJob.profile.id
        });
        // Same shape split as pollVideoBatch: Veo 3.1 upsample jobs (flowWorkflowId
        // set post-submit) poll via the media endpoint; legacy ones via operations.
        const mediaJobs = jobs.filter(j => j.flowWorkflowId && j.providerJobId);
        const legacyJobs = jobs.filter(j => !j.flowWorkflowId && j.providerJobId);
        // Create sceneId to job mapping for result processing
        const sceneIdToJob = new Map();
        for (const job of jobs) {
            sceneIdToJob.set(job.sceneId, job);
        }
        logger.debug(`[GenNormalPoller] 🔄 Batch polling ${jobs.length} upsampling jobs (${mediaJobs.length} media, ${legacyJobs.length} legacy) for profile ${profileId.substring(0, 8)}...`, {
            sceneIds: jobs.map(j => j.sceneId),
            operationNames: jobs.map(j => j.providerJobId?.substring(0, 20))
        });
        const allResultOperations = [];
        if (legacyJobs.length > 0) {
            const operations = legacyJobs.map(job => ({
                operation: { name: job.providerJobId },
                sceneId: job.sceneId,
                status: 'MEDIA_GENERATION_STATUS_ACTIVE',
            }));
            const legacyResponse = await veo3Service.batchCheckAsyncVideoGenerationStatus({ operations });
            allResultOperations.push(...(legacyResponse.operations || []));
        }
        if (mediaJobs.length > 0) {
            const { items, missing } = this.buildMediaPollItems(mediaJobs);
            // Upsampling has bespoke failure handling — don't force-FAIL here; skip and
            // retry next cycle (a missing veo3ProjectId is near-impossible for upsample).
            for (const job of missing) {
                logger.error(`[GenNormalPoller] Upsampling job #${job.jobIndex} thiếu veo3ProjectId — bỏ qua poll media lần này`, { jobId: job.id });
            }
            if (items.length > 0) {
                const mediaResponse = await veo3Service.batchCheckMediaGenerationStatus(items);
                allResultOperations.push(...(mediaResponse.operations || []));
            }
        }
        if (allResultOperations.length === 0) {
            logger.warn(`[GenNormalPoller] Batch upsampling status returned no operations for profile ${profileId.substring(0, 8)}...`);
            return;
        }
        // Process each operation result
        for (const operation of allResultOperations) {
            const job = sceneIdToJob.get(operation.sceneId);
            if (!job) {
                logger.warn(`[GenNormalPoller] ⚠️ Batch upsampling status result with sceneId ${operation.sceneId} not matched to any job`);
                continue;
            }
            // Process status for this upsampling job
            await this.processUpsamplingStatusResult(job, operation);
        }
        logger.debug(`[GenNormalPoller] 🔄 Batch upsampling poll complete for profile ${profileId.substring(0, 8)}...`, {
            jobsProcessed: allResultOperations.length
        });
    }
    /**
     * ✅ BATCH: Process status result for a single upsampling job from batch poll
     */
    async processUpsamplingStatusResult(job, operation) {
        const status = operation.status;
        const videoMetadata = operation.operation?.metadata?.video;
        // Check for completed status (API returns MEDIA_GENERATION_STATUS_SUCCESSFUL for upsampling)
        if (status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL' ||
            status === 'SUCCESSFUL' ||
            status === 'MEDIA_GENERATION_STATUS_COMPLETE' ||
            status === 'COMPLETE' ||
            status === 'COMPLETED') {
            const videoUrl = videoMetadata?.downloadUrl || videoMetadata?.fifeUrl;
            if (videoUrl) {
                // Upsampling completed - update original job (parentJob) with new result
                const parentJobId = job.parentJobId;
                if (parentJobId) {
                    // ✅ FIX: Atomic check - prevent duplicate processing when multiple pollers detect completion
                    // First, try to atomically mark this upsampling job as COMPLETED (only if still PROCESSING)
                    try {
                        const updateResult = await prisma.genNormalJob.updateMany({
                            where: {
                                id: job.id,
                                status: 'PROCESSING' // Only update if still PROCESSING
                            },
                            data: { status: 'COMPLETED' }
                        });
                        // If no rows updated, another poller already processed this job
                        if (updateResult.count === 0) {
                            logger.debug(`[GenNormalPoller] ⏭️ Upsampling job ${job.id} already processed by another poller, skipping`);
                            return;
                        }
                    }
                    catch (updateError) {
                        // Job might have been deleted already
                        logger.debug(`[GenNormalPoller] ⏭️ Upsampling job ${job.id} update failed (likely already processed): ${updateError.message}`);
                        return;
                    }
                    // Now we have exclusive ownership - proceed with parent job update
                    try {
                        await prisma.genNormalJob.update({
                            where: { id: parentJobId },
                            data: {
                                resultUrl: videoUrl,
                                isUpsampled: true,
                                upsamplingJobId: null,
                                // child.providerJobId = mediaId bản HD — parent giữ providerJobId
                                // gốc nên refresh-url cần field riêng này.
                                upscaledMediaId: job.providerJobId || null,
                                // Bản HD là FILE MỚI cần tải — reset tracking để auto-download
                                // và filter "Thiếu file" nhận diện lại.
                                downloadedAt: null,
                                downloadAttempts: 0,
                                lastDownloadError: null,
                                progress: 100,
                                status: 'COMPLETED'
                            }
                        });
                        logger.info(`[GenNormalPoller] ✅ Batch: Upsampling completed for job #${job.jobIndex}`, {
                            originalJobId: parentJobId,
                            upsamplingJobId: job.id,
                            videoUrl: videoUrl.substring(0, 100)
                        });
                        this.emit('job:upsampled', parentJobId, { videoUrl });
                        await this.updateProjectStats(job.projectId);
                    }
                    catch (parentUpdateError) {
                        if (parentUpdateError.code === 'P2025') {
                            logger.warn(`[GenNormalPoller] Parent job ${parentJobId} not found (deleted?), skipping upsampled result update`);
                        }
                        else {
                            throw parentUpdateError;
                        }
                    }
                }
                // Delete upsampling job after updating original job
                try {
                    await prisma.genNormalJob.delete({
                        where: { id: job.id }
                    });
                }
                catch (deleteError) {
                    // P2025 = record not found - this is expected if already deleted
                    if (deleteError.code !== 'P2025') {
                        logger.warn(`[GenNormalPoller] Failed to delete upsampling job: ${deleteError.message}`);
                    }
                }
            }
            return;
        }
        // Check for failed status
        if (status === 'MEDIA_GENERATION_STATUS_FAILED' ||
            status === 'FAILED' ||
            status === 'MEDIA_GENERATION_STATUS_CONTENT_FILTERED' ||
            status === 'CONTENT_FILTERED') {
            const errorMessage = operation.operation?.error?.message ||
                operation.error ||
                'Video upsampling failed';
            await this.handleUpsamplingFailure(job, errorMessage);
            return;
        }
        // Still processing - update progress
        if (status === 'MEDIA_GENERATION_STATUS_ACTIVE' ||
            status === 'ACTIVE' ||
            status === 'MEDIA_GENERATION_STATUS_PROCESSING' ||
            status === 'PROCESSING' ||
            status === 'MEDIA_GENERATION_STATUS_PENDING' ||
            status === 'PENDING') {
            // Increment progress gradually
            const currentProgress = job.progress || 10;
            const increment = Math.floor(Math.random() * 4) + 2; // 2-5% per poll
            const newProgress = Math.min(99, currentProgress + increment);
            await prisma.genNormalJob.update({
                where: { id: job.id },
                data: { progress: newProgress }
            });
            logger.debug(`[GenNormalPoller] 🔄 Upsampling job #${job.jobIndex} still active, progress: ${newProgress}%`, {
                jobId: job.id,
                status
            });
        }
    }
    /**
     * Handle upsampling job failure (extracted for reuse)
     */
    async handleUpsamplingFailure(job, errorMessage) {
        const parentJobId = job.parentJobId;
        const { isRecaptchaFailure, isRateLimitError, isRetryable: isRetryableError } = classifyPollError(errorMessage);
        logger.error(`[GenNormalPoller] ❌ Upsampling job #${job.jobIndex} failed${isRetryableError ? ' (will auto-retry)' : ''}`, {
            upsamplingJobId: job.id,
            originalJobId: parentJobId,
            error: errorMessage.substring(0, 200),
            retryable: isRetryableError
        });
        if (isRecaptchaFailure) {
            const { captchaManager } = await import('../../lib/captchaManager.js');
            captchaManager.notifyFailure();
            genNormalQueueManager.setProfileRateLimitDelay(job.profileId, 120);
            logger.warn(`[GenNormalPoller] reCAPTCHA failure for ${job.profileId.substring(0, 8)} — 2min cooldown`);
        }
        // Handle rate limit
        if (isRateLimitError && !isRecaptchaFailure) {
            genNormalQueueManager.setProfileRateLimitDelay(job.profileId, 60);
            logger.warn(`[GenNormalPoller] ⏱️ Rate limit - profile ${job.profileId} will wait 60 seconds`);
        }
        // For retryable errors: re-queue the upsampling job instead of failing permanently
        const MAX_UPSCALE_RETRIES = 3;
        if (isRetryableError && parentJobId) {
            // Check retry count on the clone job
            const cloneJob = await prisma.genNormalJob.findUnique({
                where: { id: job.id },
                select: { retryCount: true }
            });
            const retryCount = cloneJob?.retryCount || 0;
            if (retryCount >= MAX_UPSCALE_RETRIES) {
                logger.warn(`[GenNormalPoller] Upsampling max retries (${MAX_UPSCALE_RETRIES}) reached for job #${job.jobIndex}`, {
                    upsamplingJobId: job.id,
                    parentJobId
                });
                await this.cleanupFailedUpsampling(job, parentJobId);
                return;
            }
            logger.info(`[GenNormalPoller] 🔄 Auto-retrying upsampling for job #${job.jobIndex} (retry ${retryCount + 1}/${MAX_UPSCALE_RETRIES})`, {
                upsamplingJobId: job.id,
                parentJobId
            });
            // Reset upsampling clone job to QUEUED and increment retry count
            try {
                await prisma.genNormalJob.update({
                    where: { id: job.id },
                    data: { status: 'QUEUED', progress: 0, retryCount: retryCount + 1 }
                });
            }
            catch (e) {
                if (e.code === 'P2025') {
                    logger.warn(`[GenNormalPoller] Upsampling job already deleted, cannot retry`, { upsamplingJobId: job.id });
                    return;
                }
                throw e;
            }
            // Re-queue immediately (profile rate limit delay prevents premature execution)
            try {
                const { queueManager } = await import('./SQLiteQueueManager.js');
                const { JobType } = await import('../jobs/JobTypes.js');
                const isImageJob = job.mode === 'IMAGE_GENERATION';
                const jobType = isImageJob ? JobType.IMAGE_UPSAMPLING : JobType.VIDEO_UPSAMPLING;
                await queueManager.addJob({
                    type: jobType,
                    priority: 5,
                    profileId: job.profileId,
                    data: {
                        genNormalJobId: job.id,
                        parentJobId: parentJobId,
                        resolution: '1080P'
                    },
                    maxAttempts: 5
                });
                logger.info(`[GenNormalPoller] ✅ Re-queued upsampling job for retry`, {
                    upsamplingJobId: job.id,
                    parentJobId
                });
            }
            catch (retryError) {
                logger.error(`[GenNormalPoller] Failed to re-queue upsampling job: ${retryError.message}`);
                await this.cleanupFailedUpsampling(job, parentJobId);
            }
            return; // Don't cleanup - we're retrying
        }
        // Non-retryable error: cleanup permanently
        await this.cleanupFailedUpsampling(job, parentJobId);
    }
    /**
     * Cleanup a permanently failed upsampling job
     */
    async cleanupFailedUpsampling(job, parentJobId) {
        if (parentJobId) {
            try {
                await prisma.genNormalJob.update({
                    where: { id: parentJobId },
                    data: { upsamplingJobId: null }
                });
            }
            catch (err) {
                if (err.code === 'P2025') {
                    logger.warn(`[GenNormalPoller] Parent job ${parentJobId} not found during cleanup, skipping`);
                }
                else {
                    throw err;
                }
            }
        }
        try {
            await prisma.genNormalJob.delete({
                where: { id: job.id }
            });
        }
        catch (deleteError) {
            if (deleteError.code !== 'P2025') {
                logger.warn(`[GenNormalPoller] Failed to delete upsampling job: ${deleteError.message}`);
            }
        }
    }
    /**
     * Poll status for a single upsampling job from Veo3 API (fallback for batch failures)
     */
    async pollUpsamplingJobStatus(job, operationName, sceneId) {
        try {
            // Get cookies from partition
            const cookiesString = await getProfileCookies(job.profile.id);
            const veo3Service = new Veo3Service();
            veo3Service.updateConfig({
                accessToken: job.profile.accessToken || undefined,
                cookies: cookiesString,
                profileId: job.profile.id
            });
            // Veo 3.1 media-shape upsample jobs (flowWorkflowId set) must poll via the
            // media endpoint — their operationName is a media UUID that 400s the legacy
            // operations endpoint. Legacy jobs keep pollVideoStatusNormalized.
            let statusResult;
            if (job.flowWorkflowId) {
                const projectId = resolveVeo3ProjectId(job);
                if (!projectId) {
                    logger.error(`[GenNormalPoller] Upsampling job #${job.jobIndex} thiếu veo3ProjectId — bỏ qua poll media lần này`, { jobId: job.id });
                    return;
                }
                const mediaResponse = await veo3Service.batchCheckMediaGenerationStatus([
                    { name: operationName, projectId, sceneId: sceneId || undefined },
                ]);
                statusResult = this.normalizeMediaOperation(mediaResponse.operations?.[0]);
            }
            else {
                statusResult = await veo3Service.pollVideoStatusNormalized(operationName, sceneId);
            }
            if (!statusResult) {
                logger.debug(`[GenNormalPoller] Upsampling job #${job.jobIndex} status not found yet`, {
                    jobId: job.id,
                    operationName,
                    sceneId
                });
                return;
            }
            const status = statusResult.status;
            const videoUrl = statusResult.videoUrl;
            if (status === 'COMPLETED' && videoUrl) {
                // Upsampling completed - update original job (parentJob) with new result
                const parentJobId = job.parentJobId;
                if (parentJobId) {
                    // Update original job with upsampled result
                    try {
                        await prisma.genNormalJob.update({
                            where: { id: parentJobId },
                            data: {
                                resultUrl: videoUrl,
                                isUpsampled: true,
                                upsamplingJobId: null,
                                upscaledMediaId: job.providerJobId || null,
                                downloadedAt: null,
                                downloadAttempts: 0,
                                lastDownloadError: null,
                                progress: 100,
                                status: 'COMPLETED'
                            }
                        });
                        logger.info(`[GenNormalPoller] Original job upsampling completed`, {
                            originalJobId: parentJobId,
                            upsamplingJobId: job.id,
                            videoUrl: videoUrl.substring(0, 100)
                        });
                        this.emit('job:upsampled', parentJobId, { videoUrl });
                        await this.updateProjectStats(job.projectId);
                    }
                    catch (parentUpdateError) {
                        if (parentUpdateError.code === 'P2025') {
                            logger.warn(`[GenNormalPoller] Parent job ${parentJobId} not found (deleted?), skipping`);
                        }
                        else {
                            throw parentUpdateError;
                        }
                    }
                }
                else {
                    // Fallback: update upsampling job itself (for backward compatibility)
                    await prisma.genNormalJob.update({
                        where: { id: job.id },
                        data: {
                            resultUrl: videoUrl,
                            isUpsampled: true,
                            upsamplingJobId: null,
                            upscaledMediaId: job.providerJobId || null,
                            downloadedAt: null,
                            downloadAttempts: 0,
                            lastDownloadError: null,
                            progress: 100,
                            status: 'COMPLETED'
                        }
                    });
                    logger.info(`[GenNormalPoller] Job #${job.jobIndex} upsampling completed (no parent)`, {
                        jobId: job.id,
                        videoUrl: videoUrl.substring(0, 100)
                    });
                    this.emit('job:upsampled', job.id, { videoUrl });
                    await this.updateProjectStats(job.projectId);
                }
                // Delete upsampling job after updating original job
                try {
                    await prisma.genNormalJob.delete({
                        where: { id: job.id }
                    });
                    logger.info(`[GenNormalPoller] Upsampling job deleted`, {
                        upsamplingJobId: job.id
                    });
                }
                catch (deleteError) {
                    // Handle case where job was already deleted (race condition)
                    if (deleteError.code === 'P2025') {
                        logger.warn(`[GenNormalPoller] Upsampling job already deleted (race condition)`, {
                            upsamplingJobId: job.id
                        });
                    }
                    else {
                        throw deleteError;
                    }
                }
            }
            else if (status === 'FAILED') {
                const errorMessage = statusResult.error || 'Video upsampling failed';
                const parentJobId = job.parentJobId;
                const { isRecaptchaFailure, isRateLimitError } = classifyPollError(errorMessage);
                if (parentJobId) {
                    // Clear upsamplingJobId from original job
                    await prisma.genNormalJob.update({
                        where: { id: parentJobId },
                        data: {
                            upsamplingJobId: null
                        }
                    });
                }
                // Delete failed upsampling job
                try {
                    await prisma.genNormalJob.delete({
                        where: { id: job.id }
                    });
                }
                catch (deleteError) {
                    // Handle case where job was already deleted (race condition)
                    if (deleteError.code === 'P2025') {
                        logger.warn(`[GenNormalPoller] Failed upsampling job already deleted (race condition)`, {
                            upsamplingJobId: job.id
                        });
                    }
                    else {
                        throw deleteError;
                    }
                }
                logger.error(`[GenNormalPoller] Upsampling job failed`, {
                    upsamplingJobId: job.id,
                    originalJobId: parentJobId,
                    error: errorMessage
                });
                if (isRecaptchaFailure) {
                    const { captchaManager } = await import('../../lib/captchaManager.js');
                    captchaManager.notifyFailure();
                    genNormalQueueManager.setProfileRateLimitDelay(job.profileId, 120);
                    logger.warn(`[GenNormalPoller] reCAPTCHA failure on upsampling job ${job.id} for ${job.profileId.substring(0, 8)} — 2min cooldown`);
                }
                // If rate limit error, set 60s delay for this profile
                else if (isRateLimitError) {
                    genNormalQueueManager.setProfileRateLimitDelay(job.profileId);
                    logger.warn(`[GenNormalPoller] ⏰ Rate limit error detected for upsampling job. Profile ${job.profileId} will wait 180s before next job.`, {
                        upsamplingJobId: job.id,
                        profileId: job.profileId,
                        error: errorMessage.substring(0, 200)
                    });
                }
                if (parentJobId) {
                    this.emit('job:upsampling-failed', parentJobId, new Error(errorMessage));
                }
                else {
                    this.emit('job:upsampling-failed', job.id, new Error(errorMessage));
                }
            }
            else {
                // Still processing - update progress based on status
                let progress = 0;
                if (status === 'PROCESSING') {
                    progress = 50; // Mid-way progress
                }
                else if (status === 'PENDING') {
                    progress = 10; // Just started
                }
                // Update progress if it has changed
                if (progress > 0) {
                    await prisma.genNormalJob.update({
                        where: { id: job.id },
                        data: { progress }
                    });
                }
                logger.debug(`[GenNormalPoller] Upsampling job #${job.jobIndex} still processing`, {
                    jobId: job.id,
                    status,
                    progress
                });
            }
        }
        catch (error) {
            const errorMessage = error.message || String(error);
            logger.error(`[GenNormalPoller] Error polling upsampling job status:`, {
                jobId: job.id,
                error: errorMessage
            });
            const { isRecaptchaFailure, isRateLimitError } = classifyPollError(errorMessage);
            if (isRecaptchaFailure) {
                const { captchaManager } = await import('../../lib/captchaManager.js');
                captchaManager.notifyFailure();
                genNormalQueueManager.setProfileRateLimitDelay(job.profileId, 120);
                logger.warn(`[GenNormalPoller] reCAPTCHA failure during poll for ${job.profileId.substring(0, 8)} (upsamplingJob=${job.id}) — 2min cooldown`);
            }
            // If rate limit error, set 60s delay for this profile
            else if (isRateLimitError) {
                genNormalQueueManager.setProfileRateLimitDelay(job.profileId);
                logger.warn(`[GenNormalPoller] ⏰ Rate limit error detected while polling upsampling job. Profile ${job.profileId} will wait 60s before next job.`, {
                    upsamplingJobId: job.id,
                    profileId: job.profileId,
                    error: errorMessage.substring(0, 200)
                });
            }
            // Don't throw - will retry on next poll cycle
        }
    }
    /**
     * Poll status for a single job
     */
    async pollJobStatus(job) {
        try {
            // If providerJobId is a mediaId (starts with 'CA'), the job is already completed
            // MediaId format: CAUSJ... or CAMSJ... (starts with CA)
            // Operation name format: hex string (e.g., 9091998218015affcb525dfa7c7a8167)
            // We should not poll status for completed jobs using mediaId
            if (job.providerJobId && job.providerJobId.startsWith('CA')) {
                // Job is already completed (providerJobId was updated with mediaId)
                // Skip polling - this job should not be in PROCESSING status
                logger.debug(`[GenNormalPoller] Job #${job.jobIndex} has mediaId in providerJobId, skipping status check (job should be COMPLETED)`, {
                    jobId: job.id,
                    providerJobId: job.providerJobId.substring(0, 50)
                });
                return;
            }
            // Check timeout
            if (job.startedAt) {
                const processingTimeMs = Date.now() - new Date(job.startedAt).getTime();
                if (processingTimeMs > this.TIMEOUT_MS) {
                    logger.warn(`[GenNormalPoller] Job #${job.jobIndex} timeout after ${Math.floor(processingTimeMs / 60000)}min`, {
                        jobId: job.id
                    });
                    await prisma.genNormalJob.update({
                        where: { id: job.id },
                        data: {
                            status: 'FAILED',
                            error: 'Timeout: Processing for more than 30 minutes',
                            completedAt: new Date()
                        }
                    });
                    this.emit('job:failed', job.id, new Error('Timeout'));
                    await this.updateProjectStats(job.projectId);
                    return;
                }
            }
            // Check grace period for providerJobId
            if (!job.providerJobId) {
                const timeSinceStart = job.startedAt
                    ? Date.now() - new Date(job.startedAt).getTime()
                    : 0;
                if (timeSinceStart < this.GRACE_PERIOD_MS) {
                    // Still within grace period - job handler is processing reCAPTCHA/API submission
                    if (timeSinceStart > 60000) {
                        // Log warning if taking longer than 1 minute (but still within grace period)
                        logger.debug(`[GenNormalPoller] Job #${job.jobIndex} still waiting for API submission (${Math.floor(timeSinceStart / 1000)}s/${this.GRACE_PERIOD_MS / 1000}s) - reCAPTCHA or API may be slow`, {
                            jobId: job.id,
                            profileId: job.profileId
                        });
                    }
                    return; // Skip, will check again next cycle
                }
                // After grace period, mark as failed
                logger.error(`[GenNormalPoller] ❌ Job #${job.jobIndex} failed: API submission timeout after ${Math.floor(timeSinceStart / 1000)}s (grace period: ${this.GRACE_PERIOD_MS / 1000}s)`, {
                    jobId: job.id,
                    profileId: job.profileId,
                    projectId: job.projectId,
                    mode: job.mode,
                    prompt: job.prompt?.substring(0, 100)
                });
                await prisma.genNormalJob.update({
                    where: { id: job.id },
                    data: {
                        status: 'FAILED',
                        error: `API submission timeout: No providerJobId received after ${Math.floor(timeSinceStart / 1000)}s. Job handler may be stuck (reCAPTCHA/network issues).`,
                        completedAt: new Date()
                    }
                });
                this.emit('job:failed', job.id, new Error('API submission timeout'));
                await this.updateProjectStats(job.projectId);
                return;
            }
            // Check if sceneId exists (required for polling)
            if (!job.sceneId) {
                logger.error(`[GenNormalPoller] Job #${job.jobIndex} missing sceneId`, {
                    jobId: job.id,
                    providerJobId: job.providerJobId
                });
                await prisma.genNormalJob.update({
                    where: { id: job.id },
                    data: {
                        status: 'FAILED',
                        error: 'Missing sceneId - job was not properly submitted'
                    }
                });
                this.emit('job:failed', job.id, new Error('Missing sceneId'));
                await this.updateProjectStats(job.projectId);
                return;
            }
            const cookiesString = await getProfileCookies(job.profile.id);
            const veo3Service = new Veo3Service();
            veo3Service.updateConfig({
                accessToken: job.profile.accessToken || undefined,
                cookies: cookiesString,
                profileId: job.profile.id
            });
            // Poll status. Veo 3.1 media-shape jobs (flowWorkflowId set) must use the
            // media endpoint — their providerJobId is a media UUID that 400s the legacy
            // operations endpoint. Legacy jobs keep pollVideoStatusNormalized.
            let statusResult;
            if (job.flowWorkflowId) {
                const projectId = resolveVeo3ProjectId(job);
                if (!projectId) {
                    await this.failJobMissingProjectId(job);
                    return;
                }
                const mediaResponse = await veo3Service.batchCheckMediaGenerationStatus([
                    { name: job.providerJobId, projectId, sceneId: job.sceneId || undefined },
                ]);
                statusResult = this.normalizeMediaOperation(mediaResponse.operations?.[0]);
            }
            else {
                statusResult = await veo3Service.pollVideoStatusNormalized(job.providerJobId, job.sceneId);
            }
            if (!statusResult) {
                logger.warn(`[GenNormalPoller] Job #${job.jobIndex} status not found`, {
                    jobId: job.id,
                    operationId: job.providerJobId,
                    sceneId: job.sceneId
                });
                return;
            }
            const status = statusResult.status;
            const progress = statusResult.progress || job.progress || 0;
            const resultUrl = statusResult.videoUrl;
            // Calculate progress incrementally for PROCESSING jobs
            let newProgress = job.progress || 10;
            if (status === 'PROCESSING' || status === 'PENDING') {
                // Increment progress gradually from current value up to 99%
                const increment = Math.floor(Math.random() * 4) + 2; // 2-5% per poll
                newProgress = Math.min(99, Math.max(newProgress, job.progress || 10) + increment);
            }
            else if (status === 'COMPLETED') {
                newProgress = 100;
            }
            // Update job in database
            const updateData = {
                progress: newProgress
            };
            if (status === 'COMPLETED') {
                // Media-shape (Veo 3.1) cũng đi qua nhánh này — cùng guard URL rỗng như batch.
                if (!resultUrl) {
                    if (this.shouldDeferUrlResolve(job))
                        return;
                    updateData.lastDownloadError = 'URL_PENDING';
                }
                else {
                    this.urlRetryCounters.delete(job.id);
                }
                updateData.status = 'COMPLETED';
                updateData.completedAt = new Date();
                updateData.resultUrl = resultUrl || null;
                updateData.progress = 100;
                // Update providerJobId with mediaId (name) from response if available
                // This ensures we store the actual mediaId instead of operation name
                if (statusResult.mediaId && statusResult.mediaId.startsWith('CA')) {
                    updateData.providerJobId = statusResult.mediaId;
                    logger.info(`[GenNormalPoller] Job #${job.jobIndex} updating providerJobId with mediaId`, {
                        jobId: job.id,
                        oldProviderJobId: job.providerJobId?.substring(0, 30),
                        newMediaId: statusResult.mediaId.substring(0, 50)
                    });
                }
                logger.info(`[GenNormalPoller] Job #${job.jobIndex} completed`, {
                    jobId: job.id,
                    resultUrl: resultUrl?.substring(0, 100)
                });
                await prisma.genNormalJob.update({
                    where: { id: job.id },
                    data: updateData
                });
                // Notify queue manager to remove job from running queue and update lastSubmitTime
                genNormalQueueManager.markJobCompleted(job.id, job.profileId);
                this.emit('job:completed', job.id, { resultUrl: resultUrl ?? null });
                await this.updateProjectStats(job.projectId);
                // Auto-upscale: fire-and-forget, runs in parallel with remaining gen jobs.
                // Job không có URL (URL_PENDING) thì upscale vô nghĩa — bỏ qua.
                if (resultUrl) {
                    triggerAutoUpscaleIfEnabled(job.id, job.projectId, job.mode).catch(() => { });
                }
            }
            else if (status === 'FAILED') {
                this.urlRetryCounters.delete(job.id); // dọn state defer-URL nếu có
                const errorMessage = statusResult.error || 'Video generation failed';
                logger.error(`[GenNormalPoller] Job #${job.jobIndex} failed`, {
                    jobId: job.id,
                    error: errorMessage
                });
                // Check if error should NOT be retried (audio filtered, content policy, etc.)
                const isNonRetryable = isNonRetryableError(errorMessage);
                if (isNonRetryable) {
                    // Mark as FAILED immediately without retry
                    logger.error(`[GenNormalPoller] ❌ Job #${job.jobIndex} failed with non-retryable error (e.g., audio filtered, content policy). Marking as FAILED.`, {
                        jobId: job.id,
                        error: errorMessage.substring(0, 200)
                    });
                    await prisma.genNormalJob.update({
                        where: { id: job.id },
                        data: {
                            status: 'FAILED',
                            error: errorMessage,
                            completedAt: new Date()
                        }
                    });
                    genNormalQueueManager.markJobCompleted(job.id, job.profileId);
                    this.emit('job:failed', job.id, new Error(errorMessage));
                    await this.updateProjectStats(job.projectId);
                    return;
                }
                const { isRecaptchaFailure, isRateLimitError } = classifyPollError(errorMessage);
                // Get job retry info
                const jobRetryInfo = await prisma.genNormalJob.findUnique({
                    where: { id: job.id },
                    select: { retryCount: true, maxRetries: true }
                });
                // If reCAPTCHA failure, check retry count BEFORE requeuing (delay: 2 minutes)
                if (isRecaptchaFailure) {
                    if (jobRetryInfo && jobRetryInfo.retryCount < (jobRetryInfo.maxRetries || 10)) {
                        // Requeue with delay for reCAPTCHA failures
                        await genNormalQueueManager.requeueJobForRateLimitRetry(job.id, job.profileId, errorMessage, 120);
                        logger.warn(`[GenNormalPoller] 🔐 reCAPTCHA failure detected for job #${job.jobIndex}. Job will be retried automatically after 2 minutes.`, {
                            jobId: job.id,
                            profileId: job.profileId,
                            error: errorMessage.substring(0, 200)
                        });
                        // Set rate limit delay for this profile (120s = 2 minutes)
                        genNormalQueueManager.setProfileRateLimitDelay(job.profileId, 120);
                        return;
                    }
                    else {
                        logger.error(`[GenNormalPoller] ❌ reCAPTCHA failure for job #${job.jobIndex} and max retries reached. Marking as FAILED.`, {
                            jobId: job.id,
                            retryCount: jobRetryInfo?.retryCount,
                            maxRetries: jobRetryInfo?.maxRetries || 10
                        });
                    }
                }
                // If rate limit error, check retry count BEFORE requeuing
                else if (isRateLimitError) {
                    // Check if we can still retry
                    if (jobRetryInfo && jobRetryInfo.retryCount < (jobRetryInfo.maxRetries || 10)) {
                        // Requeue job for automatic retry
                        await genNormalQueueManager.requeueJobForRateLimitRetry(job.id, job.profileId, errorMessage);
                        logger.warn(`[GenNormalPoller] ⏰ Rate limit error detected for job #${job.jobIndex}. Job will be retried automatically after 180s.`, {
                            jobId: job.id,
                            profileId: job.profileId,
                            retryCount: jobRetryInfo.retryCount,
                            maxRetries: jobRetryInfo.maxRetries || 10,
                            error: errorMessage.substring(0, 200)
                        });
                        // Don't emit 'job:failed' event - job is being retried
                        await this.updateProjectStats(job.projectId);
                        return; // Exit early, job is requeued
                    }
                    else {
                        // Max retries reached for rate limit error - mark as FAILED immediately
                        logger.error(`[GenNormalPoller] ❌ Job #${job.jobIndex} exceeded max retries for rate limit error (${jobRetryInfo?.retryCount || 0}/${jobRetryInfo?.maxRetries || 10}). Marking as FAILED.`, {
                            jobId: job.id,
                            retryCount: jobRetryInfo?.retryCount || 0,
                            maxRetries: jobRetryInfo?.maxRetries || 10,
                            error: errorMessage.substring(0, 200)
                        });
                        // Mark as FAILED immediately (don't fall through, handle it here)
                        updateData.status = 'FAILED';
                        updateData.completedAt = new Date();
                        updateData.error = errorMessage.length > 500 ? errorMessage.substring(0, 500) + '...' : errorMessage;
                        await prisma.genNormalJob.update({
                            where: { id: job.id },
                            data: updateData
                        });
                        // Notify queue manager to remove job from running queue
                        genNormalQueueManager.markJobCompleted(job.id, job.profileId);
                        this.emit('job:failed', job.id, new Error(errorMessage));
                        await this.updateProjectStats(job.projectId);
                        return; // Exit early, job is marked as FAILED
                    }
                }
                // For non-rate-limit errors, also retry automatically (up to maxRetries)
                if (jobRetryInfo && jobRetryInfo.retryCount < (jobRetryInfo.maxRetries || 10)) {
                    // Calculate retry delay: exponential backoff (30s, 60s, 120s, ...)
                    const retryAttempt = (jobRetryInfo.retryCount || 0) + 1;
                    const baseDelaySeconds = 30; // Base delay: 30 seconds
                    const retryDelaySeconds = Math.min(baseDelaySeconds * Math.pow(2, retryAttempt - 1), 120); // Max 2 minutes
                    const retryDelayMs = retryDelaySeconds * 1000;
                    const retryAt = Date.now() + retryDelayMs;
                    const retryAtISO = new Date(retryAt).toISOString();
                    // Update job to QUEUED status for retry
                    await prisma.genNormalJob.update({
                        where: { id: job.id },
                        data: {
                            status: 'QUEUED',
                            error: `RETRY:${retryAtISO}:${errorMessage.substring(0, 200)}`,
                            progress: 0,
                            retryCount: retryAttempt
                        }
                    });
                    // Notify queue manager to remove job from running queue
                    genNormalQueueManager.markJobCompleted(job.id, job.profileId);
                    // Add job back to queue for retry
                    const addToFront = retryDelaySeconds < 120; // Add to front if short delay
                    genNormalQueueManager.requeueJob(job.id, job.profileId, job.projectId, job.jobIndex, job.mode, addToFront);
                    logger.warn(`[GenNormalPoller] 🔄 Job #${job.jobIndex} requeued for retry (attempt ${retryAttempt}/${jobRetryInfo.maxRetries || 10}). Will retry after ${retryDelaySeconds}s.`, {
                        jobId: job.id,
                        profileId: job.profileId,
                        retryAt: retryAtISO,
                        retryDelaySeconds,
                        retryCount: retryAttempt,
                        error: errorMessage.substring(0, 200),
                        note: `Job sẽ được retry tự động sau ${retryDelaySeconds} giây (exponential backoff).`
                    });
                    // Don't emit 'job:failed' event - job is being retried
                    await this.updateProjectStats(job.projectId);
                    return; // Exit early, job is requeued
                }
                // Max retries reached, mark as FAILED
                updateData.status = 'FAILED';
                updateData.completedAt = new Date();
                updateData.error = errorMessage.length > 500 ? errorMessage.substring(0, 500) + '...' : errorMessage;
                await prisma.genNormalJob.update({
                    where: { id: job.id },
                    data: updateData
                });
                // Notify queue manager to remove job from running queue and update lastSubmitTime
                genNormalQueueManager.markJobCompleted(job.id, job.profileId);
                logger.error(`[GenNormalPoller] ❌ Job #${job.jobIndex} exceeded max retries (${jobRetryInfo?.retryCount || 0}/${jobRetryInfo?.maxRetries || 10}). Marking as FAILED.`, {
                    jobId: job.id,
                    retryCount: jobRetryInfo?.retryCount || 0,
                    maxRetries: jobRetryInfo?.maxRetries || 10,
                    error: errorMessage.substring(0, 200)
                });
                this.emit('job:failed', job.id, new Error(errorMessage));
                await this.updateProjectStats(job.projectId);
            }
            else {
                // Still processing - just update progress
                logger.debug(`[GenNormalPoller] Job #${job.jobIndex} still processing (${newProgress}%)`, {
                    jobId: job.id,
                    status,
                    progress: newProgress
                });
                await prisma.genNormalJob.update({
                    where: { id: job.id },
                    data: updateData
                });
            }
        }
        catch (error) {
            const errorMessage = error.message || String(error);
            logger.error(`[GenNormalPoller] Error polling job #${job.jobIndex}:`, {
                jobId: job.id,
                error: errorMessage,
                stack: error.stack
            });
            const { isRecaptchaFailure, isRateLimitError } = classifyPollError(errorMessage);
            // Check if error is transient (network, timeout, etc.) - just skip this poll cycle
            const isTransientError = error.message?.includes('timeout') ||
                error.message?.includes('ECONNRESET') ||
                error.message?.includes('ENOTFOUND') ||
                error.message?.includes('fetch failed') ||
                error.message?.includes('ECONNREFUSED') ||
                error.code === 'ETIMEDOUT' ||
                error.code === 'ENOTFOUND' ||
                this.isTransientBrowserFetchPollError(errorMessage);
            if (isRecaptchaFailure) {
                // reCAPTCHA failure - requeue job with delay (120s = 2 minutes)
                await genNormalQueueManager.requeueJobForRateLimitRetry(job.id, job.profileId, errorMessage, 120);
                logger.warn(`[GenNormalPoller] 🔐 reCAPTCHA failure detected while polling job #${job.jobIndex}. Job will be retried automatically after 2 minutes.`, {
                    jobId: job.id,
                    profileId: job.profileId,
                    error: errorMessage.substring(0, 200)
                });
                // Set delay for this profile
                genNormalQueueManager.setProfileRateLimitDelay(job.profileId, 120);
                await this.updateProjectStats(job.projectId);
                return; // Exit early, job is requeued
            }
            else if (isRateLimitError) {
                // Rate limit error - requeue job for automatic retry after 60s
                await genNormalQueueManager.requeueJobForRateLimitRetry(job.id, job.profileId, errorMessage);
                logger.warn(`[GenNormalPoller] ⏰ Rate limit error detected while polling job #${job.jobIndex}. Job will be retried automatically after 60s.`, {
                    jobId: job.id,
                    profileId: job.profileId,
                    error: errorMessage.substring(0, 200)
                });
                // Don't emit 'job:failed' event - job is being retried
                await this.updateProjectStats(job.projectId);
                return; // Exit early, job is requeued
            }
            else if (!isTransientError) {
                // Non-transient error - mark as failed
                await prisma.genNormalJob.update({
                    where: { id: job.id },
                    data: {
                        status: 'FAILED',
                        error: errorMessage.length > 500 ? errorMessage.substring(0, 500) + '...' : errorMessage,
                        completedAt: new Date()
                    }
                });
                // Notify queue manager to remove job from running queue and update lastSubmitTime
                genNormalQueueManager.markJobCompleted(job.id, job.profileId);
                this.emit('job:failed', job.id, error);
                await this.updateProjectStats(job.projectId);
            }
            // Transient errors will be retried on next poll cycle
        }
    }
    /**
     * Update project statistics
     */
    async updateProjectStats(projectId) {
        try {
            const stats = await prisma.genNormalJob.groupBy({
                by: ['status'],
                where: {
                    projectId,
                    parentJobId: null,
                },
                _count: true
            });
            const completedCount = stats.find(s => s.status === 'COMPLETED')?._count || 0;
            const failedCount = stats.find(s => s.status === 'FAILED')?._count || 0;
            const processingCount = stats.find(s => s.status === 'PROCESSING')?._count || 0;
            const queuedCount = stats.find(s => s.status === 'QUEUED')?._count || 0;
            const draftCount = stats.find(s => s.status === 'DRAFT')?._count || 0;
            const totalCount = completedCount + failedCount + processingCount + queuedCount + draftCount;
            const progress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
            await prisma.genNormalProject.update({
                where: { id: projectId },
                data: {
                    completedJobs: completedCount,
                    failedJobs: failedCount,
                    processingJobs: processingCount,
                    totalJobs: totalCount
                    // Note: queuedJobs and progress fields don't exist in schema
                }
            });
            // updateProjectStats chạy ở MỌI terminal transition (kể cả FAILED) nên đây
            // là chốt chặn duy nhất bảo đảm deferred upscale vẫn chạy khi batch kết
            // thúc không bằng completion event (job cuối fail/timeout/cancel).
            if (processingCount + queuedCount === 0 && completedCount > 0) {
                maybeTriggerDeferredUpscales(projectId).catch(() => { });
            }
        }
        catch (error) {
            logger.error(`[GenNormalPoller] Error updating project stats:`, {
                projectId,
                error: error.message
            });
        }
    }
}
// Singleton instance
export const genNormalStatusPoller = new GenNormalStatusPoller();
