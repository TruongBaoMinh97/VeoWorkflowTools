/**
 * GenNormal Job Handler
 * Processes GenNormal jobs (image/video generation for Pro Editor)
 */
import { BaseJobHandler } from '../JobHandler.js';
import { sanitizeResultUrl } from '../../../utils/resultUrl.js';
import { JobType } from '../../jobs/JobTypes.js';
import { logger } from '../../../lib/logger.js';
import { prisma } from '../../../lib/prisma.js';
import { genNormalRepository } from '../../../modules/genNormal/genNormal.repository.js';
import { Veo3Service } from '../../../services/veo3/veo3Service.js';
import { veoProfileManager } from '../../veo/VeoProfileManager.js';
import { accountLocaleService } from '../../../lib/accountLocaleService.js';
import { captchaManager } from '../../../lib/captchaManager.js';
import { sessionIdManager } from '../../../lib/sessionIdManager.js';
import { normalizeImageModelKey } from '../../../utils/videoModelResolver.js';
import { isVerificationRejected, verificationRequiredError } from '../../../services/veo3/verificationFailure.js';
export class GenNormalJobHandler extends BaseJobHandler {
    getJobType() {
        return JobType.GEN_NORMAL;
    }
    async execute(job) {
        const { genNormalJobId } = job.data;
        if (!genNormalJobId) {
            throw new Error('Missing required field: genNormalJobId');
        }
        logger.info(`[GenNormalHandler] Processing GenNormal job`, {
            queueJobId: job.id,
            genNormalJobId
        });
        // Get job from database with project profile info
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
        if (!genNormalJob) {
            throw new Error(`GenNormal job not found: ${genNormalJobId}`);
        }
        // Update status to PROCESSING
        await prisma.genNormalJob.update({
            where: { id: genNormalJob.id },
            data: {
                status: 'PROCESSING',
                startedAt: new Date(),
                progress: 5
            }
        });
        logger.info(`[GenNormalHandler] Job ${genNormalJob.id} (index ${genNormalJob.jobIndex}) started processing`);
        // Get Veo3 project ID for this profile
        const refreshedProject = await genNormalRepository.getProject(genNormalJob.projectId);
        const projectProfile = refreshedProject?.profiles.find((p) => p.profileId === genNormalJob.profileId);
        if (!projectProfile?.veo3ProjectId) {
            logger.error(`[GenNormalHandler] No Veo3 project ID found for profile`, {
                jobId: genNormalJob.id,
                projectId: genNormalJob.projectId,
                profileId: genNormalJob.profileId
            });
            throw new Error(`No Veo3 project ID found for profile ${genNormalJob.profileId}`);
        }
        // Get cookies from Electron persistent partition instead of database
        const { getProfileCookiesCompat } = await import('../../../utils/profileCookies.js');
        const { cookies: profileCookiesJson } = await getProfileCookiesCompat(genNormalJob.profile);
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
        // ⚠️ Detect locale THẬT của account qua redirect 302 của labs.google/fx/tools/flow.
        // Google redirect sang `/fx/{locale}/tools/flow` theo account language preference,
        // KHÔNG phải theo geo IP. Dùng locale sai → URL/Referer mismatch với cookies gốc
        // → reCAPTCHA score thấp → 403. Detect + cache 1h per profile.
        // Fallback 'vi' nếu detect fail (đa số profile hiện tại là VN).
        let accountLocale = 'vi';
        if (cookiesString) {
            try {
                accountLocale = await accountLocaleService.getAccountLocale(genNormalJob.profile.id, cookiesString, undefined, 'vi');
                logger.info(`[GenNormalHandler] Account locale for profile ${genNormalJob.profile.id}: ${accountLocale}`);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn(`[GenNormalHandler] Locale detect failed, using fallback 'vi': ${message}`);
            }
        }
        // Create new provider instance for this job to avoid race conditions
        const provider = new Veo3Service();
        // Update provider config with profile credentials.
        // ⚠️ veo3ProjectId BẮT BUỘC để veo3Service build đúng projectUrl khi gọi reCAPTCHA →
        // browser load đúng project page → action↔location khớp → tránh 403.
        // locale được detect từ redirect thay vì hardcode 'vi' (xem comment trên).
        provider.updateConfig({
            accessToken: genNormalJob.profile.accessToken || undefined,
            cookies: cookiesString,
            profileId: genNormalJob.profile.id,
            veo3ProjectId: projectProfile.veo3ProjectId,
            locale: accountLocale,
            onTokenRefreshed: async (newToken) => {
                await prisma.profile.update({
                    where: { id: genNormalJob.profileId },
                    data: {
                        accessToken: newToken,
                        accessTokenExpires: new Date(Date.now() + 55 * 60 * 1000)
                    }
                });
            }
        });
        const jobMode = genNormalJob.mode || 'TEXT_TO_VIDEO';
        try {
            if (jobMode !== 'IMAGE_GENERATION') {
                // Video gen jobs are submitted in batches by GenNormalQueueManager and
                // should never reach this handler. Fail fast so the queue worker
                // marks them as failed (1 attempt) instead of cycling the retry budget.
                const err = new Error(`Video gen jobs are managed by genNormalQueueManager directly, not the queue worker (mode=${jobMode})`);
                err.nonRetryable = true;
                throw err;
            }
            const result = await this.processImageGeneration(genNormalJob, provider, projectProfile);
            // Successful submit clears any pending soft/hard reset because the
            // shared mint session is proven healthy.
            captchaManager.notifySuccess();
            return result;
        }
        catch (error) {
            if (isVerificationRejected(error))
                throw verificationRequiredError(error);
            // reCAPTCHA 403: escalate failure to the global captcha manager which
            // schedules a soft_reset (strip _grecaptcha storage) → hard_reset
            // (navigate Flow tab → back) on the next extension poll. Proxy rotation
            // still happens at the global proxy level.
            const errMsg = error?.message || '';
            const isRecaptcha403 = error?.isRecaptchaFailure === true
                || /PUBLIC_ERROR_UNUSUAL_ACTIVITY(?!_TOO_MUCH_TRAFFIC)/.test(errMsg)
                || errMsg.includes('reCAPTCHA evaluation failed');
            if (isRecaptcha403) {
                const pid = genNormalJob.profileId;
                logger.warn(`[GenNormalHandler] 🔄 reCAPTCHA 403 for ${pid.substring(0, 8)} → immediate hard_reset + rotate session/proxy`);
                // Confirmed score-death: force an immediate anchor reset (extension clears
                // the _GRECAPTCHA cookie + reloads) instead of waiting for the 3/7 ladder.
                captchaManager.notifyRecaptchaScoreDead();
                // Drop the reused sessionId so the post-reset submits present a fresh one.
                sessionIdManager.reset(pid);
                try {
                    const { globalProxyManager } = await import('../../../lib/GlobalProxyManager.js');
                    await globalProxyManager.reportForbidden();
                }
                catch (resetErr) {
                    logger.warn(`[GenNormalHandler] Proxy rotate failed: ${resetErr?.message || resetErr}`);
                }
            }
            throw error;
        }
    }
    async processImageGeneration(job, provider, projectProfile) {
        logger.info(`[GenNormalHandler] Processing IMAGE_GENERATION job`, {
            jobId: job.id,
            jobIndex: job.jobIndex
        });
        // Get reference image media IDs
        let refImageMediaIds = [];
        if (job.referenceImageMediaIds) {
            try {
                refImageMediaIds = typeof job.referenceImageMediaIds === 'string'
                    ? JSON.parse(job.referenceImageMediaIds)
                    : job.referenceImageMediaIds;
            }
            catch (e) {
                logger.error(`[GenNormalHandler] Failed to parse referenceImageMediaIds`, {
                    error: e.message
                });
            }
        }
        // Convert aspect ratio. project.aspectRatio is stored as a friendly format
        // ('16:9', '9:16', '1:1', '3:4', '4:3') — map it to the IMAGE enum the Flow API expects.
        const projectAspectRatio = job.project.aspectRatio || '16:9';
        const imageAspectRatioMap = {
            '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
            '3:4': 'IMAGE_ASPECT_RATIO_PORTRAIT_3_4',
            '4:3': 'IMAGE_ASPECT_RATIO_LANDSCAPE_4_3',
            '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT',
            '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
            // Backward compat for legacy enum values stored in old projects
            'VIDEO_ASPECT_RATIO_PORTRAIT': 'IMAGE_ASPECT_RATIO_PORTRAIT',
            'VIDEO_ASPECT_RATIO_LANDSCAPE': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
        };
        const imageAspectRatio = imageAspectRatioMap[projectAspectRatio] ?? 'IMAGE_ASPECT_RATIO_LANDSCAPE';
        const veo3Service = provider;
        // Generate image using batchGenerateImages.
        // Dedupe (Set preserves first-occurrence order) + hard cap 10 — defense in
        // depth in case a stale job in DB was created before the cap landed.
        const uniqueRefImageMediaIds = [...new Set(refImageMediaIds)].slice(0, 10);
        // Check if this is an edit job (has referenceImageMediaIds and there's a completed job with same jobIndex)
        let isEditJob = false;
        if (uniqueRefImageMediaIds.length > 0) {
            const existingCompletedJob = await prisma.genNormalJob.findFirst({
                where: {
                    projectId: job.projectId,
                    jobIndex: job.jobIndex,
                    status: 'COMPLETED',
                    mode: 'IMAGE_GENERATION',
                    id: { not: job.id } // Exclude current job
                }
            });
            isEditJob = !!existingCompletedJob;
        }
        // Use BASE_IMAGE input type for edit jobs, REFERENCE for normal jobs
        const imageInputType = isEditJob ? 'IMAGE_INPUT_TYPE_BASE_IMAGE' : 'IMAGE_INPUT_TYPE_REFERENCE';
        // Pick image model: prefer the dedicated imageModelKey, fall back to videoModelKey
        // (legacy GenNormal projects store the user's image choice in videoModelKey).
        // Normalize: removed/unknown keys (e.g. legacy 'R2I', 'IMAGEN_3_5') → 'GEM_PIX_2'.
        const imageModelName = normalizeImageModelKey(job.project.imageModelKey ||
            job.project.videoModelKey);
        const result = await veo3Service.generateCharacterImages({
            projectId: projectProfile.veo3ProjectId,
            prompt: job.prompt,
            imageAspectRatio: imageAspectRatio,
            referenceImageMediaIds: uniqueRefImageMediaIds.length > 0 ? uniqueRefImageMediaIds : undefined,
            imageInputType: uniqueRefImageMediaIds.length > 0 ? imageInputType : undefined,
            imageModelName
        });
        if (result.length === 0) {
            throw new Error('No images generated');
        }
        const imageResult = result[0];
        // Use name (mediaId) as providerJobId for base image reference in edit jobs
        // name is the CAMaJ... format mediaId that can be used in imageInputs
        const mediaId = imageResult.name || imageResult.mediaGenerationId || 'N/A';
        const imageUrl = sanitizeResultUrl(imageResult.fifeUrl || imageResult.encodedImage || '', job.id);
        // Update job with result
        await prisma.genNormalJob.update({
            where: { id: job.id },
            data: {
                status: 'COMPLETED',
                completedAt: new Date(),
                progress: 100,
                resultUrl: imageUrl,
                providerJobId: mediaId // Store mediaId for edit jobs
            }
        });
        return {
            success: true,
            mediaGenerationId: imageResult.mediaGenerationId,
            previewUrl: imageResult.fifeUrl
        };
    }
    canRetry(job, error) {
        if (isVerificationRejected(error))
            return false;
        // Fail fast for jobs intentionally rejected by execute() (e.g. recovered
        // video-mode rows that shouldn't reach this handler).
        if (error?.nonRetryable === true)
            return false;
        // Real daily quota — DO NOT RETRY (429 TOO_MUCH_TRAFFIC falls through to the 429 retry below)
        const { isHardQuotaExhausted } = require('../../../services/veo3/veo3ErrorHandler.js');
        if (isHardQuotaExhausted(error?.message, error)) {
            return false;
        }
        // Don't retry on 401 (auth error) - handled by token refresh
        if (error.message.includes('401') || error.message.includes('Unauthorized')) {
            return false;
        }
        // Don't retry on 400 (bad request) - invalid input
        if (error.message.includes('400') || error.message.includes('Bad Request')) {
            return false;
        }
        // Retry on rate limit (429) with longer delay
        if (error.message.includes('429') || error.message.includes('Too Many Requests')) {
            return job.attempts < job.maxAttempts;
        }
        return job.attempts < job.maxAttempts;
    }
    getRetryDelay(attempt) {
        // Exponential backoff: 2s, 4s, 8s, 16s...
        return Math.pow(2, attempt) * 1000;
    }
}
