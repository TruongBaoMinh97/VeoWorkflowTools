import { genNormalRepository } from './genNormal.repository.js';
import { genNormalQueueManager } from './genNormalQueueManager.js';
import { logger } from '../../lib/logger.js';
// @ts-nocheck
import { prisma } from '../../lib/prisma.js';
import { Veo3Service } from '../../services/veo3/veo3Service.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getProfileCookiesCompat } from '../../utils/profileCookies.js';
import { isOmniFlashKey } from '../../utils/videoModelResolver.js';
import { assertMangaDrafts } from './mangaStory.js';
/**
 * Extract proxy config from a Profile record in the shape expected by
 * Veo3Service.updateConfig (proxyHost/Port/Username/Password). Returns null
 * if profile has no proxy, so the service falls back to direct connection.
 * Ensures server-side tRPC API calls go through the SAME proxy as the
 * reCAPTCHA browser for fingerprint consistency.
 */
function extractProfileProxyConfig(profile) {
    if (!profile?.proxyHost || !profile?.proxyPort)
        return null;
    return {
        proxyHost: profile.proxyHost,
        proxyPort: profile.proxyPort,
        proxyUsername: profile.proxyUsername ?? null,
        proxyPassword: profile.proxyPassword ?? null,
    };
}
/**
 * Cancel orphaned SQLiteQueue upsampling jobs whose genNormalJobId references
 * genNormal jobs that are about to be deleted. Prevents "Upsampling job not found" errors.
 */
async function cancelOrphanedQueueJobsForProject(projectId) {
    const jobsToDelete = await prisma.genNormalJob.findMany({
        where: { projectId },
        select: { id: true }
    });
    if (jobsToDelete.length === 0)
        return;
    const genNormalJobIds = new Set(jobsToDelete.map(j => j.id));
    const pendingQueueJobs = await prisma.queueJob.findMany({
        where: {
            type: { in: ['video-upsampling', 'image-upsampling'] },
            status: { in: ['queued', 'processing'] }
        }
    });
    const orphanedIds = pendingQueueJobs
        .filter(qj => {
        try {
            const data = JSON.parse(qj.data);
            return data.genNormalJobId && genNormalJobIds.has(data.genNormalJobId);
        }
        catch {
            return false;
        }
    })
        .map(qj => qj.id);
    if (orphanedIds.length > 0) {
        await prisma.queueJob.updateMany({
            where: { id: { in: orphanedIds } },
            data: { status: 'cancelled', completedAt: new Date() }
        });
        logger.info(`[GenNormal] Cancelled ${orphanedIds.length} orphaned QueueJobs for project ${projectId}`);
    }
}
/**
 * Helper function to get and filter cookies for GenNormal API requests
 */
async function getCookiesForGenNormal(profile) {
    const { cookies: profileCookiesJson, hasCookies, parsed } = await getProfileCookiesCompat(profile);
    if (!hasCookies || !parsed) {
        return undefined;
    }
    // Essential cookies for Google Labs auth (to avoid HTTP 431 error)
    const ESSENTIAL_COOKIE_PATTERNS = [
        '__Secure-1PSID', '__Secure-1PAPISID', '__Secure-1PSIDTS', '__Secure-1PSIDCC',
        '__Secure-3PSID', '__Secure-3PAPISID', '__Secure-3PSIDTS', '__Secure-3PSIDCC',
        'SAPISID', 'APISID', 'SSID', 'SID', 'HSID',
        '__Secure-next-auth.session-token',
        '__Secure-next-auth.callback-url',
        '__Host-next-auth.csrf-token',
        'email', 'EMAIL',
    ];
    // Filter essential cookies
    const essentialCookies = parsed.filter((cookie) => {
        const name = cookie.name;
        return ESSENTIAL_COOKIE_PATTERNS.includes(name) ||
            name.startsWith('__Secure-') ||
            name.startsWith('__Host-');
    });
    const cookiesString = essentialCookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join('; ');
    logger.debug(`[GenNormal] Filtered ${essentialCookies.length}/${parsed.length} essential cookies (length: ${cookiesString.length})`);
    return cookiesString;
}
// Poll-path select: exactly the columns toClientJob() reads (plus the profile
// relation). MUST stay in sync with toClientJob below — this file is @ts-nocheck
// so there is no compiler guard. Avoids fetching heavyweight legacy columns
// (e.g. videoBlob) that toClientJob never emits; mirrors repository.getJobs.
export const POLL_JOB_SELECT = {
    id: true,
    projectId: true,
    profileId: true,
    prompt: true,
    jobIndex: true,
    batchIndex: true,
    mode: true,
    startImageMediaId: true,
    endImageMediaId: true,
    audioMediaId: true,
    referenceImageMediaIds: true,
    startImagePreviewUrl: true,
    endImagePreviewUrl: true,
    referenceImagePreviewUrls: true,
    veo3ProjectId: true,
    status: true,
    progress: true,
    providerJobId: true,
    resultUrl: true,
    error: true,
    retryCount: true,
    maxRetries: true,
    upsamplingJobId: true,
    isUpsampled: true,
    parentJobId: true,
    createdAt: true,
    updatedAt: true,
    startedAt: true,
    completedAt: true,
    // Thiếu 4 cột này thì renderer thay cả mảng jobs sau mỗi lượt poll và chúng
    // thành undefined: huy hiệu "đã lưu" biến mất, trần retry 3 lần không bao giờ
    // chạm (`?? 0`), và {dur} trong tên file tải về thành rỗng.
    // ⚠️ File này có @ts-nocheck — tsc KHÔNG bắt được cột sai ở đây. Test
    // `only selects columns that actually exist` neo vào Prisma DMMF mới bắt được.
    downloadedAt: true,
    downloadAttempts: true,
    lastDownloadError: true,
    videoDurationSeconds: true,
    profile: {
        select: { id: true, name: true },
    },
};
// Hoisted from pollJobs — process.env is constant after startup.
export const POLL_TERMINAL_LIMIT = (() => {
    const raw = Number(process.env.GENNORMAL_POLL_TERMINAL_LIMIT || 800);
    return Number.isFinite(raw) ? Math.max(100, Math.min(5000, Math.floor(raw))) : 800;
})();
export function toClientJob(job) {
    return {
        id: job.id,
        projectId: job.projectId,
        profileId: job.profileId,
        prompt: job.prompt,
        jobIndex: job.jobIndex,
        batchIndex: job.batchIndex,
        mode: job.mode,
        startImageMediaId: job.startImageMediaId,
        endImageMediaId: job.endImageMediaId,
        audioMediaId: job.audioMediaId,
        referenceImageMediaIds: job.referenceImageMediaIds,
        startImagePreviewUrl: job.startImagePreviewUrl,
        endImagePreviewUrl: job.endImagePreviewUrl,
        referenceImagePreviewUrls: job.referenceImagePreviewUrls,
        veo3ProjectId: job.veo3ProjectId,
        status: job.status,
        progress: job.progress,
        providerJobId: job.providerJobId,
        resultUrl: job.resultUrl,
        error: job.error,
        retryCount: job.retryCount,
        maxRetries: job.maxRetries,
        upsamplingJobId: job.upsamplingJobId,
        isUpsampled: job.isUpsampled,
        parentJobId: job.parentJobId,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        downloadedAt: job.downloadedAt,
        downloadAttempts: job.downloadAttempts,
        lastDownloadError: job.lastDownloadError,
        videoDurationSeconds: job.videoDurationSeconds,
        profile: job.profile
            ? {
                id: job.profile.id,
                name: job.profile.name,
            }
            : undefined,
    };
}
function toClientProject(project, jobs) {
    return {
        ...project,
        profiles: (project.profiles || []).map((pp) => ({
            id: pp.id,
            profileId: pp.profileId,
            veo3ProjectId: pp.veo3ProjectId ?? null,
            profile: pp.profile
                ? {
                    id: pp.profile.id,
                    name: pp.profile.name,
                    // Renderer cần tier để biết dự án có trộn Pro/Ultra hay không.
                    // Chỉ thêm đúng trường này — accessToken/cookies vẫn không lọt ra.
                    paygateTier: pp.profile.paygateTier ?? null,
                }
                : null,
        })),
        ...(jobs ? { jobs: jobs.map(toClientJob) } : {}),
    };
}
export const genNormalService = {
    /**
     * List GenNormal projects
     * @param source - Filter by source: 'normal' (default) or 'pro_editor'. If not provided, returns only 'normal' projects.
     */
    async listProjects(source) {
        // Default to 'normal' if not specified to avoid showing Pro Editor projects in normal list
        const filterSource = source || 'normal';
        return genNormalRepository.listProjects(filterSource);
    },
    /**
     * Get project detail with jobs
     * Includes preview URLs for reference images
     */
    async getProject(projectId) {
        const project = await genNormalRepository.getProject(projectId);
        if (!project) {
            return null;
        }
        // Check if there are QUEUED or PROCESSING jobs - if so, ensure queue manager is running
        const hasActiveJobs = project.jobs?.some((j) => j.status === 'QUEUED' || j.status === 'PROCESSING');
        if (hasActiveJobs) {
            // Initialize queue manager if not already running (idempotent - safe to call multiple times)
            try {
                await genNormalQueueManager.initializeProject(projectId);
                logger.info(`[GenNormal] Queue manager reinitialized for project ${projectId} (has active jobs)`);
            }
            catch (error) {
                logger.warn(`[GenNormal] Failed to reinitialize queue manager:`, error);
                // Continue anyway - queue might already be running
            }
        }
        // Renderer parses referenceImagePreviewUrls itself — no server-side enhance needed.
        if (project.jobs && project.jobs.length > 0) {
            return toClientProject(project, project.jobs);
        }
        return toClientProject(project);
    },
    /**
     * Get jobs for a project (without full project details)
     */
    async getProjectJobs(projectId) {
        const jobs = await genNormalRepository.getJobs(projectId);
        return jobs.map(toClientJob);
    },
    /**
     * Create new GenNormal project
     * Creates Veo3 projects for each selected profile
     */
    async createProject(data) {
        logger.info('[GenNormal] Creating new project', {
            name: data.name,
            profileCount: data.profileIds.length,
            source: data.source || 'normal'
        });
        // Step 1: Create GenNormal project in database
        const project = await genNormalRepository.createProject({
            name: data.name,
            profileIds: data.profileIds,
            inputMethod: data.inputMethod || 'TEXT',
            aspectRatio: data.aspectRatio || '16:9',
            outputDir: data.outputDir || 'D:/NOI CHUA VIDEO/1',
            source: data.source || 'normal' // Default to 'normal' if not specified
        });
        logger.info('[GenNormal] Project created', { projectId: project.id });
        // Track per-profile Veo3 creation errors so we can rollback on total failure.
        // If ALL profiles fail to create a Veo3 project, the local project is
        // unusable (detail page hangs on null veo3ProjectId) → delete it and
        // surface the first error to the caller.
        const veo3Errors = [];
        // Step 2: Create Veo3 projects for each profile
        const provider = new Veo3Service();
        for (const pp of project.profiles) {
            try {
                logger.info(`[GenNormal] Creating Veo3 project for profile ${pp.profile.name}`, {
                    projectId: project.id,
                    profileId: pp.profileId
                });
                // Google retired the Labs access-token endpoint. Current Flow image/video
                // generation authenticates with this profile's stored cookies instead.
                const accessToken = pp.profile.accessToken;
                // Get cookies from partition for auto-refresh capability on 401
                const cookiesString = await getCookiesForGenNormal(pp.profile);
                // Update provider config with profile credentials + proxy (so tRPC
                // API calls use the same IP as the reCAPTCHA browser)
                provider.updateConfig({
                    accessToken: accessToken || undefined,
                    cookies: cookiesString, // Pass cookies for auto-refresh on 401
                    profileId: pp.profile.id,
                    proxyConfig: extractProfileProxyConfig(pp.profile),
                    onTokenRefreshed: async (newToken) => {
                        await prisma.profile.update({
                            where: { id: pp.profileId },
                            data: { accessToken: newToken, accessTokenExpires: new Date(Date.now() + 55 * 60 * 1000) }
                        });
                    }
                });
                logger.info(`[GenNormal] Provider config updated for profile ${pp.profile.name}`, {
                    profileId: pp.profileId,
                    hasAccessToken: !!accessToken,
                    hasProxy: !!pp.profile.proxyHost
                });
                // Check if veo3ProjectId already exists for this profile
                if (pp.veo3ProjectId) {
                    logger.info(`[GenNormal] Veo3 project already exists for profile ${pp.profile.name}`, {
                        veo3ProjectId: pp.veo3ProjectId,
                        profileId: pp.profileId
                    });
                    continue; // Skip creating new project
                }
                // Create Veo3 project for this profile
                logger.info(`[GenNormal] Creating Veo3 project for profile ${pp.profile.name}`, {
                    profileId: pp.profileId,
                    projectName: project.name,
                    providerConfig: {
                        hasAccessToken: !!accessToken
                    }
                });
                const veo3ProjectId = await provider.createProjectAndGetId(`${project.name} - ${pp.profile.name}`, 'PINHOLE');
                logger.info(`[GenNormal] Veo3 project created for profile ${pp.profile.name}`, {
                    veo3ProjectId,
                    profileId: pp.profileId,
                    projectTitle: `${project.name} - ${pp.profile.name}`
                });
                // Save Veo3 project ID to database
                await prisma.genNormalProjectProfile.update({
                    where: { id: pp.id },
                    data: { veo3ProjectId }
                });
                logger.info(`[GenNormal] Veo3 project ID saved to database`, {
                    genNormalProjectProfileId: pp.id,
                    veo3ProjectId
                });
            }
            catch (error) {
                const errMsg = error?.message || String(error);
                logger.error(`[GenNormal] Failed to create Veo3 project for profile ${pp.profileId}:`, error);
                veo3Errors.push({
                    profileId: pp.profileId,
                    profileName: pp.profile?.name || pp.profileId,
                    error: errMsg,
                    code: error?.code,
                });
                // Continue with other profiles — we rollback only if ALL fail
            }
        }
        // Reload project with updated Veo3 project IDs
        const updatedProject = await genNormalRepository.getProject(project.id);
        // If NO profile got a veo3ProjectId, the local project is unusable.
        // Rollback: delete the orphan project and surface the error so UI can
        // show it instead of silently creating a broken project that hangs on detail.
        const successCount = updatedProject?.profiles.filter(p => p.veo3ProjectId).length ?? 0;
        if (successCount === 0 && veo3Errors.length > 0) {
            logger.warn('[GenNormal] All Veo3 project creations failed — rolling back local project', {
                projectId: project.id,
                errors: veo3Errors,
            });
            try {
                await genNormalRepository.deleteProject(project.id);
            }
            catch (deleteErr) {
                logger.error('[GenNormal] Failed to rollback orphan project', deleteErr);
            }
            const firstErr = veo3Errors[0];
            // A signed-out profile already carries its own instruction; appending the
            // generic proxy/cookie advice would send the user chasing the wrong fix.
            const needsRelogin = veo3Errors.every((e) => e.code === 'FLOW_SIGNED_OUT');
            const err = new Error(`Không thể tạo project trên Veo3 cho profile "${firstErr.profileName}": ${firstErr.error}` +
                (needsRelogin ? '' : '. Vui lòng kiểm tra proxy / cookies / access token rồi thử lại.'));
            err.code = 'VEO3_PROJECT_CREATE_FAILED';
            err.veo3Errors = veo3Errors;
            throw err;
        }
        logger.info('[GenNormal] All Veo3 projects created', {
            projectId: project.id,
            successCount,
            failedCount: veo3Errors.length,
            veo3Projects: updatedProject?.profiles.map(p => ({
                profile: p.profile.name,
                veo3ProjectId: p.veo3ProjectId,
            })),
        });
        return updatedProject;
    },
    /**
     * Ensure Veo3 projects are created for all profiles in the project
     * This is useful when loading an existing project that might not have veo3ProjectIds yet
     */
    async ensureVeo3Projects(projectId) {
        logger.debug('[GenNormal] Ensuring Veo3 projects exist for project', { projectId });
        const project = await genNormalRepository.getProject(projectId);
        if (!project) {
            throw new Error('Project not found');
        }
        const provider = new Veo3Service();
        let createdCount = 0;
        for (const pp of project.profiles) {
            // Skip if veo3ProjectId already exists
            if (pp.veo3ProjectId) {
                // "Veo3 project already exists" log dropped — verbose and per-profile.
                continue;
            }
            try {
                logger.info(`[GenNormal] Creating missing Veo3 project for profile ${pp.profile.name}`, {
                    projectId,
                    profileId: pp.profileId
                });
                // Get cookies from partition and filter for API requests
                const cookiesString = await getCookiesForGenNormal(pp.profile);
                // Update provider config with profile credentials + proxy
                provider.updateConfig({
                    accessToken: pp.profile.accessToken || undefined,
                    cookies: cookiesString,
                    profileId: pp.profile.id,
                    proxyConfig: extractProfileProxyConfig(pp.profile),
                    onTokenRefreshed: async (newToken) => {
                        await prisma.profile.update({
                            where: { id: pp.profileId },
                            data: { accessToken: newToken, accessTokenExpires: new Date(Date.now() + 55 * 60 * 1000) }
                        });
                    }
                });
                // Create Veo3 project
                const veo3ProjectId = await provider.createProjectAndGetId(`${project.name} - ${pp.profile.name}`, 'PINHOLE');
                // Save to database
                await prisma.genNormalProjectProfile.update({
                    where: { id: pp.id },
                    data: { veo3ProjectId }
                });
                createdCount++;
                logger.info(`[GenNormal] Veo3 project created and saved for profile ${pp.profile.name}`, {
                    veo3ProjectId,
                    profileId: pp.profileId
                });
            }
            catch (error) {
                logger.error(`[GenNormal] Failed to create Veo3 project for profile ${pp.profileId}:`, error);
                // Continue with other profiles even if one fails
            }
        }
        // Reload project with updated Veo3 project IDs
        const updatedProject = await genNormalRepository.getProject(projectId);
        if (createdCount > 0) {
            logger.info(`[GenNormal] Veo3 projects ensured: created=${createdCount}/${project.profiles.length} (${projectId})`);
        }
        else {
            logger.debug(`[GenNormal] Veo3 projects ensured: all exist (${projectId}, profiles=${project.profiles.length})`);
        }
        return updatedProject;
    },
    /**
     * Update project configuration
     */
    async updateProject(projectId, data) {
        logger.info('[GenNormal] Updating project config', {
            projectId,
            updates: Object.keys(data)
        });
        const project = await genNormalRepository.updateProject(projectId, data);
        return project;
    },
    /**
     * Delete project and all its jobs
     * Also deletes Veo3 projects for each profile
     */
    /**
     * Delete every gen-normal project that has zero profiles attached. Such
     * projects become orphaned when the user removes the last profile they
     * were bound to; the detail page can't poll credits and the UI shows a
     * persistent error. Returns the IDs that were cleaned up.
     */
    async deleteOrphanProjects() {
        logger.info('[GenNormal] Cleanup orphan projects requested');
        const projects = await genNormalRepository.listProjects('normal');
        const orphanIds = projects
            .filter((p) => !p.profiles || p.profiles.length === 0)
            .map((p) => p.id);
        let deletedCount = 0;
        const failed = [];
        for (const id of orphanIds) {
            try {
                await this.deleteProject(id);
                deletedCount++;
            }
            catch (e) {
                logger.warn(`[GenNormal] Could not delete orphan project ${id}:`, e?.message || e);
                failed.push(id);
            }
        }
        logger.info(`[GenNormal] Orphan cleanup: ${deletedCount} deleted, ${failed.length} failed`);
        return {
            success: true,
            deletedCount,
            failedIds: failed,
            orphanIds,
        };
    },
    async deleteAllProjects() {
        logger.info('[GenNormal] Deleting all projects');
        const projects = await genNormalRepository.listProjects('normal');
        // Run project deletions in parallel with a concurrency cap so we don't
        // overwhelm the proxy pool (each project may hit multiple profile proxies).
        const CONCURRENCY = 5;
        let deletedCount = 0;
        let index = 0;
        const results = await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, projects.length) }, async () => {
            while (true) {
                const i = index++;
                if (i >= projects.length)
                    return;
                const project = projects[i];
                try {
                    await this.deleteProject(project.id);
                    deletedCount++;
                }
                catch (error) {
                    logger.error(`[GenNormal] Failed to delete project ${project.id}:`, error);
                }
            }
        }));
        const failed = results.filter(r => r.status === 'rejected').length;
        return { success: true, deletedCount, failed };
    },
    async deleteProject(projectId) {
        logger.info('[GenNormal] Deleting project', { projectId });
        // Get project with profiles to get veo3ProjectIds
        const project = await genNormalRepository.getProject(projectId);
        if (!project) {
            throw new Error('Project not found');
        }
        // Cancel all jobs first
        await genNormalQueueManager.cancelProject(projectId);
        // Delete Veo3 projects IN PARALLEL across profiles. We use a FRESH
        // Veo3Service instance per profile to avoid singleton-config races
        // (updateConfig() on a shared instance is not thread-safe w.r.t. in-flight requests).
        // Each request is bounded by a 15s timeout so dead proxies don't block
        // the whole delete.
        const VEO3_DELETE_TIMEOUT_MS = 15000;
        await Promise.allSettled(project.profiles
            .filter(pp => pp.veo3ProjectId)
            .map(async (pp) => {
            try {
                logger.info(`[GenNormal] Deleting Veo3 project for profile ${pp.profile.name}`, {
                    projectId: project.id,
                    profileId: pp.profileId,
                    veo3ProjectId: pp.veo3ProjectId,
                });
                const cookiesString = await getCookiesForGenNormal(pp.profile);
                const perProfileProvider = new Veo3Service();
                perProfileProvider.updateConfig({
                    accessToken: pp.profile.accessToken || undefined,
                    cookies: cookiesString,
                    profileId: pp.profile.id,
                    proxyConfig: extractProfileProxyConfig(pp.profile),
                    onTokenRefreshed: async (newToken) => {
                        await prisma.profile.update({
                            where: { id: pp.profileId },
                            data: { accessToken: newToken, accessTokenExpires: new Date(Date.now() + 55 * 60 * 1000) },
                        });
                    },
                });
                // Race the Veo3 delete against a timeout so a stuck proxy doesn't
                // hang the whole project cleanup.
                const deletePromise = perProfileProvider.deleteProject(pp.veo3ProjectId);
                await Promise.race([
                    deletePromise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error(`Veo3 delete timeout ${VEO3_DELETE_TIMEOUT_MS}ms`)), VEO3_DELETE_TIMEOUT_MS)),
                ]);
                logger.info(`[GenNormal] Veo3 project deleted for profile ${pp.profile.name}`, {
                    veo3ProjectId: pp.veo3ProjectId,
                });
            }
            catch (error) {
                logger.error(`[GenNormal] Failed to delete Veo3 project for profile ${pp.profileId}:`, error?.message || error);
                // Don't rethrow — continue so local DB cleanup still happens
            }
        }));
        // Cancel orphaned upsampling queue jobs BEFORE deleting DB records
        await cancelOrphanedQueueJobsForProject(projectId);
        // Delete project from database (this will cascade delete jobs and project profiles)
        const deleted = await genNormalRepository.deleteProject(projectId);
        genNormalQueueManager.removeProjectState(projectId);
        return deleted;
    },
    /**
     * Submit batch - parse prompts and create jobs (as DRAFT)
     */
    async submitBatch(projectId, promptText, aspectRatio, mode, concurrency, delaySeconds, videoModelKey, referenceImageMediaIdsByProfile, referenceImagePreviewUrlsByProfile, appendJobs = false, audioMediaId, videoDurationSeconds, perJobReferenceImageMediaIdsByProfile, perJobReferenceImageHandles) {
        logger.info('[GenNormal] Submitting batch', {
            projectId,
            textLength: typeof promptText === 'string' ? promptText.length : promptText.length + ' prompts',
            aspectRatio,
            mode: mode || 'TEXT_TO_VIDEO',
            videoModelKey,
            videoDurationSeconds: videoDurationSeconds ?? null,
            referenceImageMediaIdsByProfile: referenceImageMediaIdsByProfile?.length || 0,
            referenceImagePreviewUrlsByProfile: referenceImagePreviewUrlsByProfile?.length || 0,
            audioMediaId: audioMediaId || null,
            appendJobs
        });
        // Split prompts:
        // 1. If contains \n=====\n or ===== delimiter → split by delimiter (Pro Editor format)
        // 2. Otherwise → split by newline (each line is a prompt) - GenNormal format
        let prompts;
        if (Array.isArray(promptText)) {
            prompts = promptText;
        }
        else if (promptText.includes('\n=====\n') || promptText.includes('=====')) {
            // Pro Editor format: split by delimiter
            prompts = promptText
                .split(/\n=====\n|=====/)
                .map(p => p.trim())
                .filter(p => p.length > 0);
        }
        else {
            // GenNormal format: split by newline (each line is a prompt)
            prompts = promptText
                .split('\n')
                .map(p => p.trim())
                .filter(p => p.length > 0);
        }
        // Clean prompts: Remove leading numbers (e.g., "1. ", "2. ", "15. ")
        // that may cause API to return INVALID_ARGUMENT
        prompts = prompts.map(p => {
            // Remove leading number followed by dot and optional space: "1. Text" -> "Text"
            return p.replace(/^\d+\.\s*/, '');
        });
        if (prompts.length === 0) {
            throw new Error('No prompts found in input text');
        }
        logger.info(`[GenNormal] Parsed ${prompts.length} prompts from input`);
        // Named COMPONENTS sends one reference slot list per prompt. The renderer
        // pre-splits and both sides index by position, so a length mismatch means the
        // two disagree about how many prompts exist — bind the wrong images and every
        // job silently generates the wrong characters, so refuse the whole batch.
        const assertPerJobLength = (label, list) => {
            if (list !== undefined && list.length !== prompts.length) {
                throw new Error(`${label} length (${list.length}) must match prompt count (${prompts.length})`);
            }
        };
        assertPerJobLength('perJobReferenceImageMediaIdsByProfile', perJobReferenceImageMediaIdsByProfile);
        assertPerJobLength('perJobReferenceImageHandles', perJobReferenceImageHandles);
        // Handles are paired to images by slot position. A short handle list would
        // leave the trailing images bound but unnamed, so the prompt's `@handle` for
        // them resolves to nothing and the text loses its anchor.
        if (perJobReferenceImageMediaIdsByProfile && perJobReferenceImageHandles) {
            for (let i = 0; i < perJobReferenceImageMediaIdsByProfile.length; i++) {
                const slots = perJobReferenceImageMediaIdsByProfile[i]?.length ?? 0;
                const handles = perJobReferenceImageHandles[i]?.length ?? 0;
                if (slots !== handles) {
                    throw new Error(`Prompt #${i + 1}: ${handles} handle(s) for ${slots} reference image slot(s)`);
                }
            }
        }
        // Get project profiles
        const project = await genNormalRepository.getProject(projectId);
        if (!project) {
            throw new Error('Project not found');
        }
        const profileIds = project.profiles.map(p => p.profileId);
        if (profileIds.length === 0) {
            throw new Error('No profiles configured for this project');
        }
        // Fail before creating anything: createJobs assigns profiles round-robin, so a
        // slot that never uploaded to the profile its prompt lands on would drop that
        // image and produce a job missing a character rather than an error.
        if (perJobReferenceImageMediaIdsByProfile) {
            for (let i = 0; i < perJobReferenceImageMediaIdsByProfile.length; i++) {
                const slots = perJobReferenceImageMediaIdsByProfile[i];
                if (!slots?.length) {
                    throw new Error(`Prompt #${i + 1} has no reference image slots`);
                }
                for (const profileId of profileIds) {
                    const resolved = slots.filter(slot => slot?.[profileId]).length;
                    if (resolved !== slots.length) {
                        throw new Error(`Prompt #${i + 1}: ${slots.length - resolved}/${slots.length} reference image(s) were never uploaded to profile ${profileId}`);
                    }
                }
            }
        }
        // Clear all jobs for this project from queues (only if not appending)
        let startJobIndex = 0;
        if (!appendJobs) {
            try {
                genNormalQueueManager.clearProjectJobs(projectId);
                logger.info(`[GenNormal] Cleared project ${projectId} jobs from queues`);
            }
            catch (error) {
                logger.warn(`[GenNormal] Failed to clear project jobs from queues: ${error}`);
            }
            // Cancel orphaned SQLiteQueue upsampling jobs before deleting genNormalJobs
            await cancelOrphanedQueueJobsForProject(projectId);
            // Delete all existing jobs and reset project
            logger.info(`[GenNormal] Deleting all existing jobs for project ${projectId}`);
            const deleteResult = await genNormalRepository.deleteAllJobs(projectId);
            logger.info(`[GenNormal] Deleted ${deleteResult.count} existing jobs`);
            // Reset project status and stats (only for fresh batches)
            await genNormalRepository.updateProject(projectId, {
                status: 'PENDING',
                totalJobs: 0,
                completedJobs: 0,
                failedJobs: 0,
                processingJobs: 0,
                startedAt: null,
                completedAt: null
            });
        }
        else {
            // Appending: compute offset jobIndex so new jobs don't collide with existing ones
            const existingJobs = await genNormalRepository.getJobs(projectId);
            const maxIndex = existingJobs.reduce((max, j) => Math.max(max, j.jobIndex ?? -1), -1);
            startJobIndex = maxIndex + 1;
            logger.info(`[GenNormal] Appending ${prompts.length} jobs starting at jobIndex ${startJobIndex} (existing: ${existingJobs.length})`);
        }
        // Compute batchIndex: each "Tạo job" submission gets a new batchIndex so we
        // can group completed jobs back by submission when merging videos per batch
        const batchIndex = appendJobs
            ? (await genNormalRepository.getJobs(projectId))
                .reduce((max, j) => Math.max(max, j.batchIndex ?? 0), -1) + 1
            : 0;
        // Apply project config updates only on fresh batches — when appending we
        // must keep the config locked to what the first batch chose
        if (!appendJobs) {
            const updates = {};
            if (aspectRatio && aspectRatio !== project.aspectRatio)
                updates.aspectRatio = aspectRatio;
            if (concurrency !== undefined && concurrency >= 1 && concurrency <= 12)
                updates.concurrency = concurrency;
            if (videoModelKey)
                updates.videoModelKey = videoModelKey;
            if (delaySeconds !== undefined && delaySeconds >= 1 && delaySeconds <= 180)
                updates.delaySeconds = delaySeconds;
            if (videoDurationSeconds !== undefined)
                updates.videoDurationSeconds = videoDurationSeconds;
            if (Object.keys(updates).length > 0) {
                logger.debug(`[GenNormal] Updating project ${projectId} ${JSON.stringify(updates)}`);
                await genNormalRepository.updateProject(projectId, updates);
            }
        }
        // Create jobs in database with DRAFT status
        const jobMode = mode || 'TEXT_TO_VIDEO';
        // Log reference images for debugging
        if (referenceImageMediaIdsByProfile && referenceImageMediaIdsByProfile.length > 0) {
            logger.info(`[GenNormal] Reference images received:`, {
                mode: jobMode,
                totalRefImages: referenceImageMediaIdsByProfile.length,
                refImagesWithData: referenceImageMediaIdsByProfile.filter(r => Object.keys(r || {}).length > 0).length,
                sampleRefImages: referenceImageMediaIdsByProfile.slice(0, 3)
            });
        }
        else {
            logger.info(`[GenNormal] No reference images provided for mode ${jobMode}`);
        }
        // For REFERENCE_TO_VIDEO and REFERENCE_TO_VIDEO_AUDIO modes, referenceImageMediaIdsByProfile is already in correct format
        // Array<Record<profileId, mediaId>> - each element is a reference image with mediaIds for each profile
        if ((jobMode === 'REFERENCE_TO_VIDEO' || jobMode === 'REFERENCE_TO_VIDEO_AUDIO') && referenceImageMediaIdsByProfile && referenceImageMediaIdsByProfile.length > 0) {
            logger.info(`[GenNormal] Using ${referenceImageMediaIdsByProfile.length} reference images for ${jobMode} mode`);
        }
        // audioMediaId null/empty is intentional when the channel has
        // voiceEnabled=false — downstream submit drops referenceAudio so Veo3
        // picks its own default voice. Log instead of throwing.
        if (jobMode === 'REFERENCE_TO_VIDEO_AUDIO' && !audioMediaId) {
            logger.info('[GenNormal] R2V_AUDIO without voice preset — Veo3 will pick default voice');
        }
        // Build veo3ProjectIdsByProfile map for job creation
        const veo3ProjectIdsByProfile = {};
        for (const pp of project.profiles) {
            if (pp.veo3ProjectId) {
                veo3ProjectIdsByProfile[pp.profileId] = pp.veo3ProjectId;
            }
        }
        // Effective duration for this batch: explicit param wins, otherwise fall
        // back to project's stored default (set in earlier batch or via PATCH).
        const effectiveDuration = videoDurationSeconds ?? project.videoDurationSeconds ?? undefined;
        const createResult = await genNormalRepository.createJobs(projectId, prompts, profileIds, jobMode, referenceImageMediaIdsByProfile, referenceImagePreviewUrlsByProfile, veo3ProjectIdsByProfile, // Pass veo3ProjectId for each profile
        startJobIndex, // Offset when appending so new jobIndexes continue after existing ones
        batchIndex, // Group this submission's jobs together for per-batch merge export
        perJobReferenceImageMediaIdsByProfile, // named COMPONENTS: one ref set per prompt
        4, // jobsPerProfileBatch default
        audioMediaId, // REFERENCE_TO_VIDEO_AUDIO: voice preset id shared by every job
        effectiveDuration, // Omni Flash duration snapshot per job
        perJobReferenceImageHandles // named COMPONENTS: @handle + preview per ref slot
        );
        logger.info(`[GenNormal] Created ${createResult.count} jobs in database with mode ${jobMode} (startJobIndex=${startJobIndex}, batchIndex=${batchIndex})`);
        logger.info(`[GenNormal] Jobs created with veo3ProjectIds:`, veo3ProjectIdsByProfile);
        // Update project stats (but don't change status to GENERATING yet - wait for validation)
        await genNormalRepository.updateProject(projectId, {
            totalJobs: { increment: prompts.length }
        });
        // Small delay to ensure jobs are committed to database
        await new Promise(resolve => setTimeout(resolve, 100));
        // Don't initialize queue - jobs are DRAFT and need validation first
        logger.info(`[GenNormal] Batch submitted, ${prompts.length} jobs created (DRAFT status)`);
        return {
            success: true,
            jobsCreated: prompts.length,
            prompts: prompts.slice(0, 10) // Return first 10 for preview
        };
    },
    /**
     * Submit image generation batch - parse prompts and create jobs (as DRAFT)
     * referenceImageMediaIdsByProfile: Array<Record<profileId, mediaId>> - mediaIds cho mỗi ảnh tham chiếu
     */
    async submitImageGenerationBatch(projectId, promptText, aspectRatio, referenceImageMediaIdsByProfile, appendJobs = false) {
        logger.info('[GenNormal] Submitting image generation batch', {
            projectId,
            textLength: typeof promptText === 'string' ? promptText.length : promptText.length + ' prompts',
            aspectRatio,
            referenceImageCount: referenceImageMediaIdsByProfile.length,
            appendJobs
        });
        // DEBUG: Log exact mapping of profileId -> mediaId received from frontend
        if (referenceImageMediaIdsByProfile.length > 0) {
            logger.info('[GenNormal] DEBUG: referenceImageMediaIdsByProfile received:');
            referenceImageMediaIdsByProfile.forEach((mapping, idx) => {
                logger.info(`  Image ${idx}:`, JSON.stringify(mapping, null, 2));
                Object.entries(mapping).forEach(([profileId, mediaId]) => {
                    logger.info(`    Profile ${profileId} → mediaId: ${mediaId.substring(0, 40)}...`);
                });
            });
        }
        // Split prompts:
        // 1. If contains \n=====\n or ===== delimiter → split by delimiter (Pro Editor format)
        // 2. Otherwise → split by newline (each line is a prompt) - GenNormal format
        let prompts;
        if (Array.isArray(promptText)) {
            prompts = promptText;
        }
        else if (promptText.includes('\n=====\n') || promptText.includes('=====')) {
            // Pro Editor format: split by delimiter
            prompts = promptText
                .split(/\n=====\n|=====/)
                .map(p => p.trim())
                .filter(p => p.length > 0);
        }
        else {
            // GenNormal format: split by newline (each line is a prompt)
            prompts = promptText
                .split('\n')
                .map(p => p.trim())
                .filter(p => p.length > 0);
        }
        // Clean prompts: Remove leading numbers (e.g., "1. ", "2. ", "15. ")
        // that may cause API to return INVALID_ARGUMENT
        prompts = prompts.map(p => {
            // Remove leading number followed by dot and optional space: "1. Text" -> "Text"
            return p.replace(/^\d+\.\s*/, '');
        });
        if (prompts.length === 0) {
            throw new Error('No prompts found in input text');
        }
        logger.info(`[GenNormal] Parsed ${prompts.length} prompts from input (after cleaning number prefixes)`);
        // Get project profiles
        const project = await genNormalRepository.getProject(projectId);
        if (!project) {
            throw new Error('Project not found');
        }
        const profileIds = project.profiles.map(p => p.profileId);
        if (profileIds.length === 0) {
            throw new Error('No profiles configured for this project');
        }
        // Clear all jobs for this project from queues (only when not appending)
        let startJobIndex = 0;
        if (!appendJobs) {
            try {
                genNormalQueueManager.clearProjectJobs(projectId);
                logger.info(`[GenNormal] Cleared project ${projectId} jobs from queues`);
            }
            catch (error) {
                logger.warn(`[GenNormal] Failed to clear project jobs from queues: ${error}`);
            }
            // Cancel orphaned SQLiteQueue upsampling jobs before deleting genNormalJobs
            await cancelOrphanedQueueJobsForProject(projectId);
            // Delete all existing jobs and reset project
            logger.info(`[GenNormal] Deleting all existing jobs for project ${projectId}`);
            const deleteResult = await genNormalRepository.deleteAllJobs(projectId);
            logger.info(`[GenNormal] Deleted ${deleteResult.count} existing jobs`);
            // Reset project status and stats (only for fresh batches)
            await genNormalRepository.updateProject(projectId, {
                status: 'PENDING',
                totalJobs: 0,
                completedJobs: 0,
                failedJobs: 0,
                processingJobs: 0,
                startedAt: null,
                completedAt: null
            });
        }
        else {
            // Appending: compute offset jobIndex so new jobs don't collide with existing ones
            const existingJobs = await genNormalRepository.getJobs(projectId);
            const maxIndex = existingJobs.reduce((max, j) => Math.max(max, j.jobIndex ?? -1), -1);
            startJobIndex = maxIndex + 1;
            logger.info(`[GenNormal] Appending ${prompts.length} image-generation jobs starting at jobIndex ${startJobIndex} (existing: ${existingJobs.length})`);
        }
        // Compute batchIndex (see submitBatch for rationale)
        const batchIndex = appendJobs
            ? (await genNormalRepository.getJobs(projectId))
                .reduce((max, j) => Math.max(max, j.batchIndex ?? 0), -1) + 1
            : 0;
        // Update project aspect ratio if provided (only for fresh batches)
        if (!appendJobs && aspectRatio && aspectRatio !== project.aspectRatio) {
            logger.info(`[GenNormal] Updating project aspect ratio from ${project.aspectRatio} to ${aspectRatio}`);
            await genNormalRepository.updateProject(projectId, {
                aspectRatio
            });
        }
        // Create jobs in database with DRAFT status and IMAGE_GENERATION mode
        // Pass referenceImageMediaIdsByProfile so each job can get the correct mediaIds for its profileId
        // Build veo3ProjectIdsByProfile map for job creation
        const veo3ProjectIdsByProfile = {};
        for (const pp of project.profiles) {
            if (pp.veo3ProjectId) {
                veo3ProjectIdsByProfile[pp.profileId] = pp.veo3ProjectId;
            }
        }
        const createResult = await genNormalRepository.createJobs(projectId, prompts, profileIds, 'IMAGE_GENERATION', referenceImageMediaIdsByProfile.length > 0 ? referenceImageMediaIdsByProfile : undefined, undefined, // referenceImagePreviewUrlsByProfile - not needed for IMAGE_GENERATION
        veo3ProjectIdsByProfile, // Pass veo3ProjectId for each profile
        startJobIndex, // Offset when appending so new jobIndexes continue after existing ones
        batchIndex // Group this submission's jobs together for per-batch merge export
        );
        logger.info(`[GenNormal] Created ${createResult.count} image generation jobs (startJobIndex=${startJobIndex}, batchIndex=${batchIndex})`, veo3ProjectIdsByProfile);
        // Update project stats
        await genNormalRepository.updateProject(projectId, {
            totalJobs: { increment: prompts.length }
        });
        // Small delay to ensure jobs are committed to database
        await new Promise(resolve => setTimeout(resolve, 100));
        logger.info(`[GenNormal] Image generation batch submitted, ${prompts.length} jobs created (DRAFT status)`);
        return {
            success: true,
            jobsCreated: prompts.length,
            prompts: prompts.slice(0, 10) // Return first 10 for preview
        };
    },
    /**
     * Submit a storyboard image-generation batch where each shot gets its OWN
     * ordered list of reference mediaIds (chars first, location last). Differs
     * from `submitImageGenerationBatch` (where all shots share one ref set).
     *
     * `perJobReferenceImageMediaIdsByProfile[i]` = ordered slots for job i.
     * Each slot is a `Record<profileId, mediaId>` describing which mediaId to
     * use on each profile. Cap = 10 slots/shot (enforced again in repository).
     */
    async submitStoryboardImageBatch(projectId, promptText, aspectRatio, perJobReferenceImageMediaIdsByProfile, appendJobs = false, jobsPerProfileBatch = 1) {
        // Defense in depth: log any oversized slot list before passing down.
        for (let i = 0; i < perJobReferenceImageMediaIdsByProfile.length; i++) {
            const len = perJobReferenceImageMediaIdsByProfile[i]?.length ?? 0;
            if (len > 10) {
                logger.warn('[Storyboard] truncating refs to 10', { jobIndex: i, received: len });
            }
        }
        logger.info('[GenNormal] Submitting storyboard image batch', {
            projectId,
            shots: perJobReferenceImageMediaIdsByProfile.length,
            appendJobs,
        });
        // Parse prompts (same logic as submitImageGenerationBatch).
        let prompts;
        if (Array.isArray(promptText)) {
            prompts = promptText;
        }
        else if (promptText.includes('\n=====\n') || promptText.includes('=====')) {
            prompts = promptText.split(/\n=====\n|=====/).map(p => p.trim()).filter(p => p.length > 0);
        }
        else {
            prompts = promptText.split('\n').map(p => p.trim()).filter(p => p.length > 0);
        }
        prompts = prompts.map(p => p.replace(/^\d+\.\s*/, ''));
        if (prompts.length === 0)
            throw new Error('No prompts found in input text');
        const project = await genNormalRepository.getProject(projectId);
        if (!project)
            throw new Error('Project not found');
        const profileIds = project.profiles.map(p => p.profileId);
        if (profileIds.length === 0)
            throw new Error('No profiles configured for this project');
        // Clear or append (mirror submitImageGenerationBatch behavior).
        let startJobIndex = 0;
        if (!appendJobs) {
            try {
                genNormalQueueManager.clearProjectJobs(projectId);
            }
            catch (error) {
                logger.warn(`[GenNormal] Failed to clear project jobs: ${error}`);
            }
            await cancelOrphanedQueueJobsForProject(projectId);
            const deleteResult = await genNormalRepository.deleteAllJobs(projectId);
            logger.info(`[GenNormal] Storyboard batch — deleted ${deleteResult.count} existing jobs`);
            await genNormalRepository.updateProject(projectId, {
                status: 'PENDING', totalJobs: 0, completedJobs: 0, failedJobs: 0,
                processingJobs: 0, startedAt: null, completedAt: null,
            });
        }
        else {
            const existingJobs = await genNormalRepository.getJobs(projectId);
            const maxIndex = existingJobs.reduce((max, j) => Math.max(max, j.jobIndex ?? -1), -1);
            startJobIndex = maxIndex + 1;
        }
        const batchIndex = appendJobs
            ? (await genNormalRepository.getJobs(projectId))
                .reduce((max, j) => Math.max(max, j.batchIndex ?? 0), -1) + 1
            : 0;
        if (!appendJobs && aspectRatio && aspectRatio !== project.aspectRatio) {
            await genNormalRepository.updateProject(projectId, { aspectRatio });
        }
        const veo3ProjectIdsByProfile = {};
        for (const pp of project.profiles) {
            if (pp.veo3ProjectId)
                veo3ProjectIdsByProfile[pp.profileId] = pp.veo3ProjectId;
        }
        const createResult = await genNormalRepository.createJobs(projectId, prompts, profileIds, 'IMAGE_GENERATION', undefined, // no shared refs
        undefined, veo3ProjectIdsByProfile, startJobIndex, batchIndex, perJobReferenceImageMediaIdsByProfile, // per-shot ordered slots
        jobsPerProfileBatch);
        logger.info(`[GenNormal] Storyboard batch — created ${createResult.count} jobs (startJobIndex=${startJobIndex}, batchIndex=${batchIndex})`);
        await genNormalRepository.updateProject(projectId, {
            totalJobs: { increment: prompts.length },
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        return {
            success: true,
            jobsCreated: prompts.length,
            prompts: prompts.slice(0, 10),
        };
    },
    /**
     * Fetch the preset voice list (used by REFERENCE_TO_VIDEO_AUDIO mode).
     *
     * Voices are returned by Flow's `flow.projectInitialData` TRPC endpoint
     * keyed off a Veo3 project. We use the FIRST profile that already has a
     * `veo3ProjectId` so we get the same identity authenticating against Flow
     * as the rest of the GenNormal pipeline. The voice list itself is the
     * same across an account, so any profile works.
     */
    async listFlowVoicePresets(projectId) {
        const project = await genNormalRepository.getProject(projectId);
        if (!project) {
            throw new Error('Project not found');
        }
        const veo3Service = new Veo3Service();
        const profileWithVeo3 = project.profiles.find(pp => pp.veo3ProjectId && pp.profile);
        if (!profileWithVeo3 || !profileWithVeo3.veo3ProjectId) {
            throw new Error('No profile with Veo3 project found — call /ensure-veo3-projects first');
        }
        const cookiesString = await getCookiesForGenNormal(profileWithVeo3.profile);
        let accessToken = profileWithVeo3.profile.accessToken;
        if (!accessToken) {
            // Best-effort refresh: if accessToken is stale we fall through and let
            // listFlowVoicePresets surface UNAUTHORIZED so the UI can prompt the
            // user to re-login the profile.
            logger.warn('[GenNormal] No accessToken on profile when fetching voices', {
                profileId: profileWithVeo3.profileId,
            });
        }
        veo3Service.updateConfig({
            accessToken: accessToken || undefined,
            cookies: cookiesString,
            profileId: profileWithVeo3.profileId,
            veo3ProjectId: profileWithVeo3.veo3ProjectId,
            proxyConfig: extractProfileProxyConfig(profileWithVeo3.profile),
        });
        try {
            const voices = await veo3Service.listFlowVoicePresets(profileWithVeo3.veo3ProjectId);
            logger.info(`[GenNormal] Fetched ${voices.length} voice presets`, {
                projectId,
                profileId: profileWithVeo3.profileId,
            });
            return { voices };
        }
        catch (err) {
            if (err?.message === 'UNAUTHORIZED') {
                logger.warn('[GenNormal] Voice list fetch unauthorized — profile cookies likely expired', {
                    projectId,
                    profileId: profileWithVeo3.profileId,
                });
                throw err;
            }
            throw err;
        }
    },
    /**
     * Poll job status
     */
    async pollJobs(projectId) {
        const ACTIVE_STATUSES = ['DRAFT', 'QUEUED', 'PROCESSING'];
        const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'];
        const TERMINAL_LIMIT = POLL_TERMINAL_LIMIT;
        // For large projects (e.g. 10k jobs), never load all rows on each poll.
        // Return:
        // - all ACTIVE jobs (DRAFT/QUEUED/PROCESSING)
        // - latest N TERMINAL jobs (COMPLETED/FAILED/CANCELLED)
        const [activeJobs, recentTerminalJobs, statsRows] = await Promise.all([
            prisma.genNormalJob.findMany({
                where: {
                    projectId,
                    status: { in: ACTIVE_STATUSES },
                },
                orderBy: { jobIndex: 'asc' },
                select: POLL_JOB_SELECT,
            }),
            prisma.genNormalJob.findMany({
                where: {
                    projectId,
                    status: { in: TERMINAL_STATUSES },
                },
                orderBy: { updatedAt: 'desc' },
                take: TERMINAL_LIMIT,
                select: POLL_JOB_SELECT,
            }),
            prisma.genNormalJob.groupBy({
                by: ['status'],
                where: { projectId },
                _count: true,
            }),
        ]);
        // Merge + dedupe (active + recent terminal window)
        const mergedJobMap = new Map();
        for (const job of activeJobs)
            mergedJobMap.set(job.id, job);
        for (const job of recentTerminalJobs) {
            if (!mergedJobMap.has(job.id))
                mergedJobMap.set(job.id, job);
        }
        const jobs = Array.from(mergedJobMap.values()).sort((a, b) => (a.jobIndex ?? 0) - (b.jobIndex ?? 0));
        // Renderer parses referenceImagePreviewUrls itself — no server-side enhance needed.
        const clientJobs = jobs.map(toClientJob);
        // Calculate stats
        const countByStatus = new Map();
        for (const row of statsRows) {
            countByStatus.set(row.status, Number(row._count || 0));
        }
        const stats = {
            total: Array.from(countByStatus.values()).reduce((sum, n) => sum + n, 0),
            draft: countByStatus.get('DRAFT') || 0,
            queued: countByStatus.get('QUEUED') || 0,
            processing: countByStatus.get('PROCESSING') || 0,
            completed: countByStatus.get('COMPLETED') || 0,
            failed: countByStatus.get('FAILED') || 0,
            cancelled: countByStatus.get('CANCELLED') || 0,
        };
        // Get rate limit info from queue manager
        const rateLimitInfo = genNormalQueueManager.getProjectRateLimitInfo(projectId);
        return {
            jobs: clientJobs,
            stats,
            pollWindow: {
                activeJobs: activeJobs.length,
                recentTerminalJobs: recentTerminalJobs.length,
                terminalLimit: TERMINAL_LIMIT,
                truncated: stats.total > clientJobs.length,
            },
            rateLimitInfo, // Include rate limit info for frontend display
            timestamp: new Date().toISOString()
        };
    },
    /**
     * Retry a failed job
     */
    async retryJob(projectId, jobId) {
        logger.info('[GenNormal] Retrying job', { projectId, jobId });
        const job = await prisma.genNormalJob.findUnique({
            where: { id: jobId }
        });
        if (!job) {
            throw new Error('Job not found');
        }
        // For manual retry, we reset retryCount to 0 to allow fresh attempts
        // even if maxRetries was reached previously (user intervention)
        // Reset job to QUEUED
        await genNormalRepository.updateJob(jobId, {
            status: 'QUEUED',
            error: null,
            progress: 0,
            providerJobId: null,
            startedAt: null,
            completedAt: null,
            retryCount: 0, // Reset retry count for manual retry
            // Gen lại một job ĐÃ upscale mà giữ isUpsampled=true thì: auto-upscale bỏ
            // qua nó (filter isUpsampled:false), nút upscale thủ công bị chặn, còn
            // auto-download tưởng resultUrl SD mới là bản HD → tải SD gắn tên upscaled.
            resultUrl: null,
            isUpsampled: false,
            upsamplingJobId: null,
            upscaledMediaId: null,
            downloadedAt: null,
            downloadAttempts: 0,
            lastDownloadError: null
        });
        // Re-initialize queue
        await genNormalQueueManager.initializeProject(projectId);
        return { success: true };
    },
    /**
     * resultUrl (fifeUrl Google ký) có hạn — khi 403/404, lấy link ký MỚI từ
     * mediaId qua getMediaUrlRedirect rồi ghi đè resultUrl trong DB.
     * Job đã upscale ưu tiên upscaledMediaId (bản HD); job upscale cũ trước
     * migration không có field này → fallback mediaId gốc và trả
     * resolution='original' để UI cảnh báo link là bản CHƯA upscale.
     */
    async refreshJobResultUrl(jobId) {
        const job = await prisma.genNormalJob.findUnique({
            where: { id: jobId },
            include: { profile: true }
        });
        if (!job)
            return { success: false, error: 'NOT_FOUND' };
        if (job.status !== 'COMPLETED')
            return { success: false, error: 'NOT_COMPLETED' };
        const primaryMediaId = job.isUpsampled
            ? (job.upscaledMediaId || job.providerJobId)
            : job.providerJobId;
        if (!primaryMediaId)
            return { success: false, error: 'NO_MEDIA_ID' };
        const cookiesString = await getCookiesForGenNormal(job.profile);
        if (!cookiesString)
            return { success: false, error: 'EXPIRED_COOKIES' };
        const provider = new Veo3Service();
        provider.updateConfig({
            accessToken: job.profile.accessToken || undefined,
            cookies: cookiesString,
            profileId: job.profileId,
            veo3ProjectId: job.veo3ProjectId || undefined,
            proxyConfig: extractProfileProxyConfig(job.profile),
        });
        // Thứ tự thử: bản HD trước; nếu mediaId HD không resolve được (upscale
        // legacy lưu operation-name thay vì media-name) thì mediaId gốc vẫn cứu
        // được video — chỉ là bản thường.
        const attempts = [
            {
                mediaId: primaryMediaId,
                resolution: job.isUpsampled && !job.upscaledMediaId ? 'original' : 'current',
            },
        ];
        if (job.isUpsampled &&
            job.upscaledMediaId &&
            job.providerJobId &&
            job.providerJobId !== job.upscaledMediaId) {
            attempts.push({ mediaId: job.providerJobId, resolution: 'original' });
        }
        try {
            for (const attempt of attempts) {
                const freshUrl = await provider.getMediaUrlRedirect(attempt.mediaId, job.veo3ProjectId || undefined);
                if (!freshUrl)
                    continue;
                await prisma.genNormalJob.update({
                    where: { id: jobId },
                    data: { resultUrl: freshUrl }
                });
                logger.info('[GenNormal] Refreshed result URL', {
                    jobId,
                    resolution: attempt.resolution,
                });
                return { success: true, freshUrl, resolution: attempt.resolution };
            }
            // Có cookies nhưng Google không trả Location cho mediaId nào → media đã
            // bị xóa phía thượng nguồn (heuristic — xem plan Risks).
            return { success: false, error: 'MEDIA_DELETED' };
        }
        catch (err) {
            logger.warn('[GenNormal] refreshJobResultUrl failed', {
                jobId,
                error: err?.message || String(err),
            });
            return { success: false, error: 'REFRESH_FAILED' };
        }
    },
    /**
     * Tìm các job bị lỗi "ảnh đen sau upscale".
     *
     * Bản cũ nhận nhầm prompt vọng lại trong phản hồi BOQ thành base64 ảnh, ghi
     * vài trăm byte rác ra đĩa rồi ĐÈ lên `resultUrl` của ảnh gốc. Dấu vết còn
     * lại: job `isUpsampled=true`, `resultUrl` trỏ vào file local không phải ảnh.
     *
     * Dùng chung `isCorruptImageFile` với chốt chặn lúc ghi, để định nghĩa "ảnh
     * hợp lệ" không bao giờ lệch giữa hai chỗ.
     */
    async scanCorruptUpscale(projectId) {
        const candidates = await prisma.genNormalJob.findMany({
            where: { projectId, isUpsampled: true },
            select: { id: true, resultUrl: true },
        });
        const { isCorruptImageFile } = await import('../../utils/imagePayload.js');
        const jobIds = [];
        for (const job of candidates) {
            const url = job.resultUrl;
            // Chỉ xét đường dẫn local — link CDN còn sống thì không phải ca này.
            if (!url || /^https?:\/\//i.test(url))
                continue;
            if (await isCorruptImageFile(url))
                jobIds.push(job.id);
        }
        logger.info('[GenNormal] Quét ảnh hỏng sau upscale', {
            projectId,
            scanned: candidates.length,
            corrupt: jobIds.length,
        });
        return { jobIds };
    },
    /**
     * Khôi phục các job tìm được ở `scanCorruptUpscale` bằng cách lấy lại link
     * ảnh GỐC từ Google qua `providerJobId`.
     *
     * Không tái tạo ảnh (không tốn credit): `refreshJobResultUrl` đã xử lý đúng
     * trạng thái `isUpsampled=true, upscaledMediaId=null` → trả về bản gốc.
     */
    async rescueCorruptUpscale(projectId) {
        const { jobIds } = await this.scanCorruptUpscale(projectId);
        let rescued = 0;
        let unrecoverable = 0;
        let failed = 0;
        for (const jobId of jobIds) {
            const before = await prisma.genNormalJob.findUnique({
                where: { id: jobId },
                select: { resultUrl: true },
            });
            const result = await this.refreshJobResultUrl(jobId);
            if (!result.success) {
                // Media đã bị Google xoá là kết cục không cứu được — tách khỏi lỗi tạm
                // thời (mạng, cookie) để UI báo đúng bản chất cho người dùng.
                if (result.error === 'MEDIA_DELETED')
                    unrecoverable++;
                else
                    failed++;
                continue;
            }
            await prisma.genNormalJob.update({
                where: { id: jobId },
                data: { isUpsampled: false, downloadedAt: null },
            });
            // Chỉ xoá file rác SAU khi đã có link thay thế trong DB.
            const garbagePath = before?.resultUrl;
            if (garbagePath && !/^https?:\/\//i.test(garbagePath)) {
                try {
                    const fsp = await import('fs/promises');
                    await fsp.unlink(garbagePath);
                }
                catch {
                    // File có thể đã bị xoá tay — không phải lỗi.
                }
            }
            rescued++;
        }
        logger.info('[GenNormal] Khôi phục ảnh hỏng sau upscale', {
            projectId,
            rescued,
            unrecoverable,
            failed,
        });
        return { rescued, unrecoverable, failed };
    },
    /**
     * Cancel a job
     */
    async cancelJob(jobId) {
        logger.info('[GenNormal] Cancelling job', { jobId });
        const job = await prisma.genNormalJob.findUnique({
            where: { id: jobId },
            select: { projectId: true }
        });
        await genNormalRepository.updateJob(jobId, {
            status: 'CANCELLED',
            completedAt: new Date()
        });
        // Update project stats
        if (job) {
            await genNormalQueueManager['updateProjectStats'](job.projectId);
        }
        return { success: true };
    },
    /**
     * Update job (images, mode, etc.)
     */
    async updateJob(jobId, data) {
        logger.info('[GenNormal] Updating job', { jobId, data });
        const updateData = {};
        if (data.mode !== undefined)
            updateData.mode = data.mode;
        if (data.startImageMediaId !== undefined)
            updateData.startImageMediaId = data.startImageMediaId;
        if (data.endImageMediaId !== undefined)
            updateData.endImageMediaId = data.endImageMediaId;
        if (data.referenceImageMediaIds !== undefined) {
            updateData.referenceImageMediaIds = data.referenceImageMediaIds ? JSON.stringify(data.referenceImageMediaIds) : null;
        }
        if (data.prompt !== undefined)
            updateData.prompt = data.prompt;
        if (data.startImagePreviewUrl !== undefined)
            updateData.startImagePreviewUrl = data.startImagePreviewUrl;
        if (data.endImagePreviewUrl !== undefined)
            updateData.endImagePreviewUrl = data.endImagePreviewUrl;
        if (data.referenceImagePreviewUrls !== undefined) {
            updateData.referenceImagePreviewUrls = data.referenceImagePreviewUrls ? JSON.stringify(data.referenceImagePreviewUrls) : null;
        }
        await genNormalRepository.updateJob(jobId, updateData);
        return { success: true };
    },
    /**
     * Upsample single job (video to 1080p, image to 2K/4K)
     */
    async upsampleJob(jobId, resolution) {
        logger.info('[GenNormal] Upsampling job', { jobId, resolution });
        const job = await prisma.genNormalJob.findUnique({
            where: { id: jobId },
            include: {
                project: true,
                profile: true
            }
        });
        if (!job) {
            throw new Error('Job not found');
        }
        // Validate job is completed video
        if (job.status !== 'COMPLETED') {
            throw new Error('Only completed jobs can be upsampled');
        }
        if (!job.resultUrl) {
            throw new Error('Job has no result URL');
        }
        if (job.isUpsampled) {
            throw new Error('Job is already upsampled');
        }
        if (job.upsamplingJobId) {
            throw new Error('Job is already being upsampled');
        }
        if (!job.providerJobId) {
            throw new Error('Job has no providerJobId (mediaId)');
        }
        // Get project with profiles to get veo3ProjectId
        const project = await genNormalRepository.getProject(job.projectId);
        const projectProfile = project?.profiles.find((p) => p.profileId === job.profileId);
        const veo3ProjectId = projectProfile?.veo3ProjectId || job.veo3ProjectId;
        // Get max jobIndex in project to assign to new upsampling job
        const maxJobIndexResult = await prisma.genNormalJob.aggregate({
            where: { projectId: job.projectId },
            _max: { jobIndex: true }
        });
        const newJobIndex = (maxJobIndexResult._max.jobIndex ?? -1) + 1;
        // Create a new GenNormalJob (clone) for upsampling
        // This job will appear in the middle column (processing) to show user it's being upsampled
        const upsamplingJob = await prisma.genNormalJob.create({
            data: {
                projectId: job.projectId,
                profileId: job.profileId,
                prompt: job.prompt,
                jobIndex: newJobIndex,
                batchIndex: job.batchIndex ?? 0, // Inherit from parent so merge-by-batch stays consistent
                mode: job.mode, // Keep original mode
                // Clone image data
                startImageMediaId: job.startImageMediaId,
                endImageMediaId: job.endImageMediaId,
                referenceImageMediaIds: job.referenceImageMediaIds,
                startImagePreviewUrl: job.startImagePreviewUrl,
                endImagePreviewUrl: job.endImagePreviewUrl,
                referenceImagePreviewUrls: job.referenceImagePreviewUrls,
                // Status for upsampling job
                status: 'QUEUED', // Will be processed by GenNormalQueueManager
                progress: 0,
                // Link to original job
                parentJobId: jobId, // Link to original job
                // Use original job's mediaId as the source for upsampling
                providerJobId: job.providerJobId, // This will be used as mediaId for upsampling
                veo3ProjectId: veo3ProjectId || undefined, // Use same Veo3 project
                sceneId: job.sceneId,
                // Queue job will be created by VideoUpsamplingHandler
                upsamplingJobId: null // Will be set when queue job is created
            }
        });
        // Create queue job for upsampling
        const { queueManager } = await import('../../core/queue/SQLiteQueueManager.js');
        const { JobType } = await import('../../core/jobs/JobTypes.js');
        const { veoProfileManager } = await import('../../core/veo/VeoProfileManager.js');
        // Select profile for upsampling (use same profile as original job)
        const profileId = job.profileId;
        const profile = await veoProfileManager.getProfile(profileId);
        if (!profile || !profile.active) {
            throw new Error('Profile is not available');
        }
        // Determine job type based on mode (image vs video)
        const isImageJob = job.mode === 'IMAGE_GENERATION';
        const jobType = isImageJob ? JobType.IMAGE_UPSAMPLING : JobType.VIDEO_UPSAMPLING;
        const defaultResolution = isImageJob ? '4K' : '1080P';
        const queueJobId = await queueManager.addJob({
            type: jobType,
            priority: 5, // Normal priority
            profileId: profileId,
            data: {
                genNormalJobId: upsamplingJob.id, // Use upsampling job ID, not original job ID
                parentJobId: jobId, // Store original job ID for later update
                resolution: resolution || defaultResolution
            },
            maxAttempts: 5
        });
        // Update upsampling job with queue job ID
        await prisma.genNormalJob.update({
            where: { id: upsamplingJob.id },
            data: {
                upsamplingJobId: queueJobId,
                status: 'QUEUED' // Will be picked up by GenNormalQueueManager
            }
        });
        // Mark original job as being upsampled
        await prisma.genNormalJob.update({
            where: { id: jobId },
            data: {
                upsamplingJobId: upsamplingJob.id // Store upsampling job ID for reference
            }
        });
        logger.info('[GenNormal] Created upsampling job (clone)', {
            originalJobId: jobId,
            upsamplingJobId: upsamplingJob.id,
            queueJobId,
            jobIndex: newJobIndex
        });
        return { success: true, upsamplingJobId: upsamplingJob.id, queueJobId };
    },
    /**
     * Upsample all completed video jobs in project
     */
    async upsampleAllJobs(projectId, resolution) {
        logger.info('[GenNormal] Upsampling all jobs in project', { projectId, resolution });
        try {
            // Find all completed jobs (video and image) that haven't been upsampled
            // Filter manually to avoid Prisma issues with new fields
            const allCompletedJobs = await prisma.genNormalJob.findMany({
                where: {
                    projectId,
                    status: 'COMPLETED',
                    parentJobId: null,
                    // ✅ Allow both video and image jobs (removed: mode: { not: 'IMAGE_GENERATION' })
                    resultUrl: { not: null }
                }
            });
            // Filter jobs that haven't been upsampled
            const jobs = allCompletedJobs.filter(job => {
                // Check if already upsampled
                if (job.isUpsampled === true) {
                    return false;
                }
                // Check if currently being upsampled
                if (job.upsamplingJobId) {
                    return false;
                }
                return true;
            });
            if (jobs.length === 0) {
                return { success: true, count: 0, message: 'No jobs to upsample' };
            }
            const { queueManager } = await import('../../core/queue/SQLiteQueueManager.js');
            const { JobType } = await import('../../core/jobs/JobTypes.js');
            const { veoProfileManager } = await import('../../core/veo/VeoProfileManager.js');
            const createdJobs = [];
            const errors = [];
            for (const job of jobs) {
                try {
                    // Check if profile is active
                    const profile = await veoProfileManager.getProfile(job.profileId);
                    if (!profile || !profile.active) {
                        errors.push({
                            jobId: job.id,
                            error: 'Profile is not available'
                        });
                        continue;
                    }
                    if (!job.providerJobId) {
                        errors.push({
                            jobId: job.id,
                            error: 'Job has no providerJobId'
                        });
                        continue;
                    }
                    // Get project with profiles to get veo3ProjectId
                    const project = await genNormalRepository.getProject(job.projectId);
                    const projectProfile = project?.profiles.find((p) => p.profileId === job.profileId);
                    const veo3ProjectId = projectProfile?.veo3ProjectId || job.veo3ProjectId;
                    // Get max jobIndex in project to assign to new upsampling job
                    const maxJobIndexResult = await prisma.genNormalJob.aggregate({
                        where: { projectId: job.projectId },
                        _max: { jobIndex: true }
                    });
                    const newJobIndex = (maxJobIndexResult._max.jobIndex ?? -1) + 1;
                    // Create a new GenNormalJob (clone) for upsampling
                    const upsamplingJob = await prisma.genNormalJob.create({
                        data: {
                            projectId: job.projectId,
                            profileId: job.profileId,
                            prompt: job.prompt,
                            jobIndex: newJobIndex,
                            batchIndex: job.batchIndex ?? 0, // Inherit from parent so merge-by-batch stays consistent
                            mode: job.mode,
                            startImageMediaId: job.startImageMediaId,
                            endImageMediaId: job.endImageMediaId,
                            referenceImageMediaIds: job.referenceImageMediaIds,
                            startImagePreviewUrl: job.startImagePreviewUrl,
                            endImagePreviewUrl: job.endImagePreviewUrl,
                            referenceImagePreviewUrls: job.referenceImagePreviewUrls,
                            status: 'QUEUED',
                            progress: 0,
                            parentJobId: job.id, // Link to original job
                            providerJobId: job.providerJobId, // Use original job's mediaId
                            veo3ProjectId: veo3ProjectId || undefined,
                            sceneId: job.sceneId,
                            upsamplingJobId: null
                        }
                    });
                    // Determine job type based on mode
                    const isImageJob = job.mode === 'IMAGE_GENERATION';
                    const jobType = isImageJob ? JobType.IMAGE_UPSAMPLING : JobType.VIDEO_UPSAMPLING;
                    // Caller's `resolution` takes precedence over the hard-coded default
                    // (so a UI request with `?resolution=2K` is honoured).
                    const effectiveResolution = resolution || (isImageJob ? '4K' : '1080P');
                    // Create queue job with correct type
                    const queueJobId = await queueManager.addJob({
                        type: jobType, // Use detected job type
                        priority: 5,
                        profileId: job.profileId,
                        data: {
                            genNormalJobId: upsamplingJob.id, // Use upsampling job ID
                            parentJobId: job.id, // Store original job ID
                            resolution: effectiveResolution,
                        },
                        maxAttempts: 5
                    });
                    // Update upsampling job with queue job ID
                    await prisma.genNormalJob.update({
                        where: { id: upsamplingJob.id },
                        data: {
                            upsamplingJobId: queueJobId,
                            status: 'QUEUED'
                        }
                    });
                    // Mark original job as being upsampled
                    await prisma.genNormalJob.update({
                        where: { id: job.id },
                        data: {
                            upsamplingJobId: upsamplingJob.id
                        }
                    });
                    createdJobs.push(upsamplingJob.id);
                }
                catch (error) {
                    logger.error(`[GenNormal] Failed to create upsampling job for ${job.id}:`, error);
                    errors.push({
                        jobId: job.id,
                        error: error.message || 'Unknown error'
                    });
                }
            }
            logger.info('[GenNormal] Created upsampling jobs', {
                projectId,
                created: createdJobs.length,
                errors: errors.length
            });
            return {
                success: true,
                count: createdJobs.length,
                created: createdJobs.length,
                errors: errors.length,
                errorDetails: errors
            };
        }
        catch (error) {
            logger.error('[GenNormal] Error in upsampleAllJobs:', error);
            throw error;
        }
    },
    /**
     * Start generation - validate all DRAFT jobs and convert to QUEUED
     */
    async startGeneration(projectId, concurrency, delaySeconds, videoModelKey, batchSize, imageModelKey, videoDurationSeconds) {
        logger.info('[GenNormal] Starting generation', { projectId, concurrency, batchSize, videoModelKey, imageModelKey, videoDurationSeconds });
        // Step 0: Ensure Veo3 projects exist for all profiles (auto-create if missing).
        // ensureVeo3Projects logs its own summary line — no need to bracket with 2 extra info logs.
        try {
            await this.ensureVeo3Projects(projectId);
        }
        catch (error) {
            logger.error('[GenNormal] Failed to ensure Veo3 projects', { projectId, error: error.message });
            throw new Error(`Cannot start generation: Failed to create Veo3 projects. ${error.message}`);
        }
        // Get all DRAFT jobs
        const draftJobs = await prisma.genNormalJob.findMany({
            where: {
                projectId,
                status: 'DRAFT'
            }
        });
        if (draftJobs.length === 0) {
            // Check if there are any jobs at all (for debugging)
            const allJobs = await prisma.genNormalJob.findMany({
                where: { projectId },
                select: { id: true, status: true, mode: true, jobIndex: true, error: true }
            });
            logger.warn(`[GenNormal] No draft jobs to start for project ${projectId}`, {
                totalJobs: allJobs.length,
                jobsByStatus: allJobs.reduce((acc, j) => {
                    acc[j.status] = (acc[j.status] || 0) + 1;
                    return acc;
                }, {}),
                failedJobs: allJobs.filter(j => j.status === 'FAILED').map(j => ({
                    id: j.id,
                    jobIndex: j.jobIndex,
                    mode: j.mode,
                    error: j.error?.substring(0, 200)
                }))
            });
            throw new Error('No draft jobs to start');
        }
        // The ordinary Gen start button must also respect frozen Manga settings.
        if (draftJobs.some(j => j.prompt.startsWith('Manga run '))) {
            await assertMangaDrafts(await genNormalRepository.getProject(projectId), draftJobs, imageModelKey);
        }
        // Validate each job based on mode (skip IMAGE_GENERATION - no validation needed)
        const jobsToValidate = draftJobs.filter(j => j.mode !== 'IMAGE_GENERATION');
        const imageGenJobs = draftJobs.filter(j => j.mode === 'IMAGE_GENERATION');
        // IMAGE_GENERATION jobs can be queued directly (no validation needed)
        if (imageGenJobs.length > 0) {
            await prisma.genNormalJob.updateMany({
                where: {
                    id: { in: imageGenJobs.map(j => j.id) },
                    status: 'DRAFT'
                },
                data: {
                    status: 'QUEUED'
                }
            });
            logger.info(`[GenNormal] Queued ${imageGenJobs.length} IMAGE_GENERATION jobs without validation`);
        }
        // Validate each job based on mode (only non-IMAGE_GENERATION jobs)
        const validationErrors = [];
        for (const job of jobsToValidate) {
            if (job.mode === 'FRAME_TO_FRAME') {
                // FRAME_TO_FRAME requires at least start image (end image is optional)
                if (!job.startImageMediaId) {
                    validationErrors.push(`Job #${job.jobIndex + 1}: FRAME_TO_FRAME requires at least a start image`);
                }
            }
            else if (job.mode === 'REFERENCE_TO_VIDEO') {
                // REFERENCE_TO_VIDEO requires 1-3 reference images
                let refImages = [];
                try {
                    if (job.referenceImageMediaIds) {
                        refImages = typeof job.referenceImageMediaIds === 'string'
                            ? JSON.parse(job.referenceImageMediaIds)
                            : job.referenceImageMediaIds;
                    }
                }
                catch (e) {
                    // Invalid JSON, treat as empty
                }
                // Omni Flash (abra_r2v_*) hỗ trợ tối đa 7 ảnh tham chiếu; Veo r2v tối đa 3.
                const isOmni = isOmniFlashKey(videoModelKey) || isOmniFlashKey(job.videoModelKey);
                const maxRefs = isOmni ? 7 : 3;
                if (!Array.isArray(refImages) || refImages.length < 1 || refImages.length > maxRefs) {
                    validationErrors.push(`Job #${job.jobIndex + 1}: REFERENCE_TO_VIDEO requires 1-${maxRefs} reference images (found ${refImages.length})`);
                }
            }
            // TEXT_TO_VIDEO and IMAGE_TO_VIDEO don't need validation
        }
        if (validationErrors.length > 0) {
            throw new Error(`Validation failed:\n${validationErrors.join('\n')}`);
        }
        // Convert all DRAFT jobs to QUEUED
        await prisma.genNormalJob.updateMany({
            where: {
                projectId,
                status: 'DRAFT'
            },
            data: {
                status: 'QUEUED'
            }
        });
        // Update project status and concurrency if provided
        const project = await genNormalRepository.getProject(projectId);
        const updateData = {
            status: 'GENERATING',
            startedAt: new Date()
        };
        if (concurrency !== undefined && concurrency >= 1 && concurrency <= 12) {
            updateData.concurrency = concurrency;
        }
        else {
            // Use existing concurrency or default to the project baseline.
            updateData.concurrency = project?.concurrency || 8;
        }
        if (videoModelKey)
            updateData.videoModelKey = videoModelKey;
        if (imageModelKey)
            updateData.imageModelKey = imageModelKey;
        if (delaySeconds !== undefined && delaySeconds >= 1 && delaySeconds <= 180)
            updateData.delaySeconds = delaySeconds;
        if (batchSize !== undefined && batchSize >= 1 && batchSize <= 10)
            updateData.batchSize = batchSize;
        if (videoDurationSeconds !== undefined)
            updateData.videoDurationSeconds = videoDurationSeconds;
        logger.debug(`[GenNormal] start-generation update ${projectId} ${JSON.stringify({ concurrency: updateData.concurrency, videoModelKey: updateData.videoModelKey, delaySeconds: updateData.delaySeconds, batchSize: updateData.batchSize, videoDurationSeconds: updateData.videoDurationSeconds })}`);
        await genNormalRepository.updateProject(projectId, updateData);
        // Small delay to ensure jobs are committed
        await new Promise(resolve => setTimeout(resolve, 100));
        // Initialize queue to start processing (will use concurrency from project)
        await genNormalQueueManager.initializeProject(projectId);
        logger.info(`[GenNormal] Started generation for ${draftJobs.length} jobs`);
        return {
            success: true,
            jobsQueued: draftJobs.length
        };
    },
    /**
     * Delete a job
     */
    async deleteJob(jobId) {
        logger.info('[GenNormal] Deleting job', { jobId });
        const job = await prisma.genNormalJob.findUnique({
            where: { id: jobId },
            select: { projectId: true }
        });
        await genNormalRepository.deleteJob(jobId);
        // Update project stats
        if (job) {
            await genNormalQueueManager['updateProjectStats'](job.projectId);
        }
        return { success: true };
    },
    /**
     * Retry all failed jobs in a project
     */
    async retryAllFailedJobs(projectId) {
        logger.info('[GenNormal] Retrying all failed jobs', { projectId });
        const failedJobs = await prisma.genNormalJob.findMany({
            where: {
                projectId,
                status: 'FAILED'
            }
        });
        if (failedJobs.length === 0) {
            return { success: true, retriedCount: 0 };
        }
        // For manual "Retry All", reset retryCount to 0 for all failed jobs
        // This allows user intervention even for jobs that reached maxRetries
        for (const job of failedJobs) {
            await prisma.genNormalJob.update({
                where: { id: job.id },
                data: {
                    status: 'QUEUED',
                    error: null,
                    progress: 0,
                    providerJobId: null,
                    startedAt: null,
                    completedAt: null,
                    retryCount: 0 // Reset retry count for manual retry
                }
            });
        }
        // Re-initialize queue
        await genNormalQueueManager.initializeProject(projectId);
        return { success: true, retriedCount: failedJobs.length };
    },
    /**
     * Reset captcha/403 throttle state for every profile in the project and
     * requeue jobs stuck behind repeated reCAPTCHA failures (and any FAILED
     * jobs). Used by the "Reset & tiếp tục" button so a user hammered by 403s
     * can resume immediately instead of waiting out the escalating delay.
     */
    async resetCaptchaAndRetry(projectId) {
        logger.info('[GenNormal] Reset captcha + retry stuck jobs', { projectId });
        const project = await genNormalRepository.getProject(projectId);
        if (!project)
            throw new Error('Project not found');
        // 1. Clear per-profile 403/captcha throttle (failure count, delays, breaker).
        for (const pp of project.profiles) {
            genNormalQueueManager.clearProfileThrottle(pp.profileId);
        }
        // 2. Requeue jobs stuck behind a captcha 403. A retrying job sits in QUEUED
        //    with `RATE_LIMIT_RETRY:<iso>:403 - reCAPTCHA evaluation failed`; an
        //    exhausted one is FAILED with the same kind of error. NEVER touch
        //    PROCESSING (in-flight — would double-submit) or COMPLETED. Scope FAILED
        //    to captcha/rate-limit errors only — generic FAILED is handled by
        //    retryAllFailedJobs.
        const stuckJobs = await prisma.genNormalJob.findMany({
            where: {
                projectId,
                status: { in: ['QUEUED', 'FAILED'] },
                OR: [
                    { error: { contains: 'RATE_LIMIT' } },
                    { error: { contains: '403' } },
                    { error: { contains: 'reCAPTCHA' } },
                ],
            },
            select: { id: true },
        });
        if (stuckJobs.length > 0) {
            await prisma.genNormalJob.updateMany({
                where: { id: { in: stuckJobs.map((j) => j.id) } },
                data: {
                    status: 'QUEUED',
                    error: null,
                    progress: 0,
                    providerJobId: null,
                    startedAt: null,
                    completedAt: null,
                    retryCount: 0,
                },
            });
        }
        // 3. Re-initialize the queue so the requeued jobs start processing now.
        await genNormalQueueManager.initializeProject(projectId);
        logger.info(`[GenNormal] Reset captcha done: ${project.profiles.length} profile(s), ${stuckJobs.length} job(s) requeued`);
        return { success: true, requeuedCount: stuckJobs.length };
    },
    /**
     * Delete all video jobs (including COMPLETED) but keep image jobs
     * This is used when resetting video generation to ensure old videos don't show up
     */
    async deleteAllVideoJobs(projectId) {
        const deletedCount = await prisma.genNormalJob.deleteMany({
            where: {
                projectId,
                mode: {
                    in: ['IMAGE_TO_VIDEO', 'REFERENCE_TO_VIDEO', 'TEXT_TO_VIDEO', 'FRAME_TO_FRAME']
                },
                // Delete ALL statuses including COMPLETED to prevent old videos from showing
                status: {
                    in: ['QUEUED', 'PROCESSING', 'FAILED', 'DRAFT', 'COMPLETED', 'CANCELLED']
                }
            }
        });
        logger.info(`[GenNormal] Deleted ${deletedCount.count} video jobs (including COMPLETED) from project ${projectId}`);
        return { success: true, deletedCount: deletedCount.count };
    },
    async deleteAllCompletedJobs(projectId) {
        logger.info('[GenNormal] Deleting all completed jobs', { projectId });
        const result = await prisma.genNormalJob.deleteMany({
            where: {
                projectId,
                status: 'COMPLETED'
            }
        });
        // Update project stats
        await genNormalQueueManager['updateProjectStats'](projectId);
        return { success: true, deletedCount: result.count };
    },
    /**
     * Pause project (stop submitting new jobs)
     */
    async pauseProject(projectId) {
        logger.info('[GenNormal] Pausing project', { projectId });
        await genNormalQueueManager.pauseProject(projectId);
        return { success: true };
    },
    /**
     * Resume project
     */
    async resumeProject(projectId) {
        logger.info('[GenNormal] Resuming project', { projectId });
        await genNormalQueueManager.resumeProject(projectId);
        return { success: true };
    },
    /**
     * Stop/cancel entire project
     */
    async stopProject(projectId) {
        logger.info('[GenNormal] Stopping project', { projectId });
        await genNormalQueueManager.cancelProject(projectId);
        genNormalQueueManager.removeProjectState(projectId);
        // Dừng giữa chừng = không còn completion event → deferred upscale cho các
        // video ĐÃ hoàn thành sẽ kẹt vĩnh viễn nếu không tự kích hoạt lại ở đây.
        import('../../core/queue/GenNormalStatusPoller.js')
            .then(({ maybeTriggerDeferredUpscales }) => maybeTriggerDeferredUpscales(projectId))
            .catch(() => { });
        return { success: true };
    },
    /**
     * Cleanup project queue when user navigates away
     * Cancels QUEUED jobs in DB to prevent them from auto-restoring on next startup
     * Also cancels orphaned upsampling queue jobs
     */
    async cleanupProject(projectId) {
        logger.info('[GenNormal] Cleaning up project queue (user navigated away)', { projectId });
        // Cancel QUEUED jobs in DB so they don't auto-restore on restart
        const cancelledJobs = await prisma.genNormalJob.updateMany({
            where: {
                projectId,
                status: 'QUEUED'
            },
            data: {
                status: 'CANCELLED',
                completedAt: new Date()
            }
        });
        if (cancelledJobs.count > 0) {
            logger.info(`[GenNormal] Cancelled ${cancelledJobs.count} QUEUED jobs in DB on cleanup`, { projectId });
        }
        // Cancel orphaned upsampling queue jobs
        await cancelOrphanedQueueJobsForProject(projectId);
        // Clear in-memory queues
        const result = await genNormalQueueManager.cleanupProjectQueue(projectId);
        // Rời trang khi còn QUEUED = batch kết thúc không có completion event; các
        // video đã COMPLETED vẫn phải được upscale (server chạy nền, đúng tooltip
        // "tự upscale ngay cả khi tắt giao diện").
        import('../../core/queue/GenNormalStatusPoller.js')
            .then(({ maybeTriggerDeferredUpscales }) => maybeTriggerDeferredUpscales(projectId))
            .catch(() => { });
        return result;
    },
    /**
     * Cancel ALL active jobs across all projects (called on app shutdown)
     * Prevents orphaned jobs from auto-restoring on next startup
     */
    async cancelAllActiveJobs() {
        logger.info('[GenNormal] 🛑 Cancelling all active jobs (app shutdown)');
        // Cancel all QUEUED and PROCESSING genNormalJobs
        const cancelledJobs = await prisma.genNormalJob.updateMany({
            where: {
                status: { in: ['QUEUED', 'PROCESSING'] }
            },
            data: {
                status: 'CANCELLED',
                completedAt: new Date()
            }
        });
        // Cancel all queued/processing upsampling queue jobs
        const cancelledQueueJobs = await prisma.queueJob.updateMany({
            where: {
                type: { in: ['video-upsampling', 'image-upsampling'] },
                status: { in: ['queued', 'processing'] }
            },
            data: {
                status: 'cancelled',
                completedAt: new Date()
            }
        });
        // Update all GENERATING projects to STOPPED
        const stoppedProjects = await prisma.genNormalProject.updateMany({
            where: {
                status: { in: ['GENERATING', 'PAUSED'] }
            },
            data: {
                status: 'STOPPED'
            }
        });
        logger.info(`[GenNormal] ✅ Shutdown cleanup: cancelled ${cancelledJobs.count} jobs, ${cancelledQueueJobs.count} queue jobs, stopped ${stoppedProjects.count} projects`);
        return {
            success: true,
            cancelledJobs: cancelledJobs.count,
            cancelledQueueJobs: cancelledQueueJobs.count,
            stoppedProjects: stoppedProjects.count
        };
    },
    /**
     * Merge all completed videos using ffmpeg.
     * customFileName (optional) lets callers (e.g. batch export) set the output
     * file name; otherwise we fall back to `merged_{projectId}_{timestamp}.mp4`.
     */
    async mergeVideos(projectId, outputDir, jobIds, customFileName) {
        logger.info('[GenNormal] Merging videos', { projectId, outputDir, jobIdsCount: jobIds?.length, customFileName });
        // Validate output directory
        if (!outputDir || outputDir.trim() === '' || outputDir === 'D:/NOI CHUA VIDEO/1') {
            throw new Error('Vui lòng chọn thư mục lưu video trước khi ghép');
        }
        // Import required modules
        const os = await import('os');
        const path = await import('path');
        const fs = await import('fs');
        const { spawn } = await import('child_process');
        const { resolveFfmpegBinary } = await import('../../utils/ffmpegResolver.js');
        // Use the path user selected directly (no conversion)
        const finalOutputDir = path.isAbsolute(outputDir)
            ? outputDir
            : path.resolve(outputDir);
        const whereClause = {
            projectId,
            status: 'COMPLETED',
            resultUrl: { not: null }
        };
        if (jobIds && jobIds.length > 0) {
            whereClause.id = { in: jobIds };
        }
        const completedJobs = await prisma.genNormalJob.findMany({
            where: whereClause,
            orderBy: {
                jobIndex: 'asc'
            }
        });
        if (completedJobs.length < 2) {
            throw new Error('Cần ít nhất 2 video để ghép');
        }
        const videoUrls = completedJobs
            .map((job) => job.resultUrl)
            .filter((url) => url !== null && url.trim().length > 0);
        if (videoUrls.length === 0) {
            throw new Error('Không có video hoàn thành để ghép.');
        }
        // Check ffmpeg availability
        const ffmpegBin = resolveFfmpegBinary();
        if (!ffmpegBin) {
            throw new Error('Không tìm thấy FFmpeg. Vui lòng cài đặt FFmpeg và đảm bảo nó có trong PATH.');
        }
        // Prepare temp working directory
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gennormal-merge-'));
        const cleanupFiles = [];
        try {
            // Download http(s) sources to temp files
            const resolvedPaths = [];
            for (let i = 0; i < videoUrls.length; i++) {
                const src = videoUrls[i];
                if (!src)
                    continue;
                try {
                    if (src.startsWith('file://')) {
                        // file URL → local path
                        const local = decodeURIComponent(src.replace('file://', ''));
                        resolvedPaths.push(local);
                    }
                    else if (src.startsWith('http://') || src.startsWith('https://')) {
                        // download to tmp using utility function
                        const filePath = path.join(tmpDir, `part_${String(i).padStart(3, '0')}.mp4`);
                        const { downloadFile } = await import('../../utils/fileDownloader.js');
                        await downloadFile(src, filePath);
                        resolvedPaths.push(filePath);
                        cleanupFiles.push(filePath);
                    }
                    else {
                        // assume local path
                        resolvedPaths.push(src);
                    }
                }
                catch (err) {
                    logger.warn(`[GenNormal] Skip source ${src}: ${err.message}`);
                }
            }
            if (resolvedPaths.length === 0) {
                throw new Error('Không thể chuẩn bị nguồn video để ghép.');
            }
            // Create concat list file
            // FFmpeg on Windows requires forward slashes or properly escaped backslashes
            // Convert Windows paths to use forward slashes for FFmpeg compatibility
            const listPath = path.join(tmpDir, 'concat.txt');
            const listContent = resolvedPaths.map(p => {
                // Normalize path: convert backslashes to forward slashes for FFmpeg
                // FFmpeg on Windows accepts forward slashes, which avoids escaping issues
                const normalizedPath = p.replace(/\\/g, '/');
                // Escape single quotes in path (FFmpeg concat format requires this)
                const escapedPath = normalizedPath.replace(/'/g, "'\\''");
                return `file '${escapedPath}'`;
            }).join('\n');
            fs.writeFileSync(listPath, listContent, 'utf8');
            cleanupFiles.push(listPath);
            logger.debug(`[GenNormal] Created concat list file:`, {
                listPath,
                fileCount: resolvedPaths.length,
                sampleContent: listContent.split('\n').slice(0, 2).join('\n')
            });
            // Ensure output directory exists
            if (!fs.existsSync(finalOutputDir)) {
                fs.mkdirSync(finalOutputDir, { recursive: true });
            }
            // Generate output filename. Prefer the caller-supplied name for batch
            // export workflows; fall back to the legacy timestamped default.
            let outName;
            if (customFileName && customFileName.trim()) {
                const cleaned = customFileName.trim().replace(/[\\/:*?"<>|]+/g, '_');
                outName = cleaned.toLowerCase().endsWith('.mp4') ? cleaned : `${cleaned}.mp4`;
            }
            else {
                outName = `merged_${projectId}_${Date.now()}.mp4`;
            }
            const outputPath = path.join(finalOutputDir, outName);
            // Normalize paths for FFmpeg (convert backslashes to forward slashes on Windows)
            // FFmpeg on Windows accepts forward slashes, which avoids path escaping issues
            const normalizedOutputPath = process.platform === 'win32'
                ? outputPath.replace(/\\/g, '/')
                : outputPath;
            const normalizedListPath = process.platform === 'win32'
                ? listPath.replace(/\\/g, '/')
                : listPath;
            // Run ffmpeg concat demuxer and re-encode
            const ffmpegArgs = [
                '-y',
                '-f', 'concat',
                '-safe', '0',
                '-i', normalizedListPath,
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '23', // medium quality
                '-c:a', 'aac',
                '-b:a', '192k',
                '-movflags', '+faststart',
                normalizedOutputPath,
            ];
            logger.info(`[GenNormal] Running ffmpeg merge`, {
                ffmpegBin,
                inputCount: resolvedPaths.length,
                outputPath
            });
            await new Promise((resolve, reject) => {
                if (!ffmpegBin) {
                    reject(new Error('FFmpeg binary not found'));
                    return;
                }
                const proc = spawn(ffmpegBin, ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
                let stderrBuf = '';
                proc.stderr.on('data', (c) => { stderrBuf += c.toString(); });
                proc.on('close', (code) => {
                    if (code === 0) {
                        logger.info(`[GenNormal] Video merge completed: ${outputPath}`);
                        return resolve();
                    }
                    reject(new Error(stderrBuf || `ffmpeg exited with code ${code}`));
                });
                proc.on('error', (err) => {
                    reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
                });
            });
            // Cleanup temp files
            try {
                cleanupFiles.forEach(p => {
                    if (fs.existsSync(p))
                        fs.unlinkSync(p);
                });
            }
            catch { }
            try {
                if (fs.existsSync(tmpDir)) {
                    fs.rmSync(tmpDir, { recursive: true, force: true });
                }
            }
            catch { }
            return {
                success: true,
                outputPath,
                videoCount: resolvedPaths.length,
                fileName: outName
            };
        }
        catch (error) {
            // Cleanup on error
            try {
                cleanupFiles.forEach(p => {
                    if (fs.existsSync(p))
                        fs.unlinkSync(p);
                });
            }
            catch { }
            try {
                if (fs.existsSync(tmpDir)) {
                    fs.rmSync(tmpDir, { recursive: true, force: true });
                }
            }
            catch { }
            logger.error(`[GenNormal] Failed to merge videos:`, error);
            throw new Error(`Không thể ghép video: ${error.message}`);
        }
    },
    /**
     * Merge completed videos grouped by their original "Tạo job" batch (batchIndex).
     * Produces one output file per batch. Single-video batches are copied through
     * without re-encoding (ffmpeg concat demuxer needs 2+ inputs in the existing
     * mergeVideos helper).
     */
    async mergeVideosByBatch(projectId, outputDir, fileNamePrefix) {
        logger.info('[GenNormal] Merging videos grouped by batch', { projectId, outputDir, fileNamePrefix });
        if (!outputDir || outputDir.trim() === '' || outputDir === 'D:/NOI CHUA VIDEO/1') {
            throw new Error('Vui lòng chọn thư mục lưu video trước khi ghép');
        }
        // Fetch completed jobs once, grouped by batchIndex preserving jobIndex order
        const completedJobs = await prisma.genNormalJob.findMany({
            where: {
                projectId,
                status: 'COMPLETED',
                resultUrl: { not: null }
            },
            orderBy: [{ batchIndex: 'asc' }, { jobIndex: 'asc' }]
        });
        if (completedJobs.length === 0) {
            throw new Error('Không có video hoàn thành để ghép.');
        }
        // Group jobs by batchIndex (Map keeps insertion order)
        const byBatch = new Map();
        for (const job of completedJobs) {
            const key = job.batchIndex ?? 0;
            const list = byBatch.get(key);
            if (list) {
                list.push(job);
            }
            else {
                byBatch.set(key, [job]);
            }
        }
        const prefix = (fileNamePrefix && fileNamePrefix.trim())
            ? fileNamePrefix.trim().replace(/[\\/:*?"<>|]+/g, '_')
            : 'merged';
        const path = await import('path');
        const fs = await import('fs');
        // Ensure output dir exists once
        const finalOutputDir = path.isAbsolute(outputDir) ? outputDir : path.resolve(outputDir);
        if (!fs.existsSync(finalOutputDir)) {
            fs.mkdirSync(finalOutputDir, { recursive: true });
        }
        const results = [];
        for (const [batchIndex, batchJobs] of byBatch.entries()) {
            // 1-based for display
            const humanIndex = batchIndex + 1;
            const fileName = `${prefix}_batch_${humanIndex}.mp4`;
            if (batchJobs.length === 1) {
                // Single-video batch: copy the source directly. mergeVideos requires 2+
                // inputs, so we handle this degenerate case inline by downloading /
                // copying the file to the target dir under the batch filename.
                const src = batchJobs[0].resultUrl;
                const destPath = path.join(finalOutputDir, fileName);
                try {
                    if (src.startsWith('file://')) {
                        const local = decodeURIComponent(src.replace('file://', ''));
                        fs.copyFileSync(local, destPath);
                    }
                    else if (src.startsWith('http://') || src.startsWith('https://')) {
                        const { downloadFile } = await import('../../utils/fileDownloader.js');
                        await downloadFile(src, destPath);
                    }
                    else {
                        fs.copyFileSync(src, destPath);
                    }
                    results.push({ batchIndex, fileName, videoCount: 1 });
                }
                catch (err) {
                    logger.warn(`[GenNormal] Skip batch ${humanIndex} (copy failed)`, { error: err?.message });
                    results.push({ batchIndex, fileName, videoCount: 1, skipped: true, reason: err?.message || 'copy failed' });
                }
                continue;
            }
            // Multi-video batch: reuse mergeVideos with explicit jobIds + customFileName
            try {
                const jobIds = batchJobs.map(j => j.id);
                const res = await this.mergeVideos(projectId, outputDir, jobIds, fileName);
                results.push({ batchIndex, fileName: res.fileName, videoCount: res.videoCount });
            }
            catch (err) {
                logger.warn(`[GenNormal] Skip batch ${humanIndex} (merge failed)`, { error: err?.message });
                results.push({ batchIndex, fileName, videoCount: batchJobs.length, skipped: true, reason: err?.message || 'merge failed' });
            }
        }
        return {
            success: true,
            batchCount: byBatch.size,
            results
        };
    },
    /**
     * Upload image and get mediaId
     * Uses provider API to ensure same profile config for upload and video generation
     * Returns veo3ProjectId to ensure correct project is used for subsequent video generation
     */
    async uploadImageAndGetMediaId(imagePath, profileId, aspectRatio, projectId, retryCount = 0) {
        logger.info('[GenNormal] Uploading image', { profileId, retryCount });
        // Get profile
        const profile = await prisma.profile.findUnique({
            where: { id: profileId }
        });
        if (!profile) {
            throw new Error('Profile not found');
        }
        // Get cookies from partition
        const cookiesString = await getCookiesForGenNormal(profile);
        // Get provider (same one used for video generation)
        // IMPORTANT: Create a NEW instance to avoid race conditions with shared singleton state
        // when multiple uploads happen in parallel for different profiles.
        const provider = new Veo3Service();
        // Update provider config with profile credentials (same as in queueManager)
        // Reset config first to ensure clean state for this profile
        provider.updateConfig({
            accessToken: profile.accessToken || undefined,
            cookies: cookiesString,
            profileId: profile.id,
            proxyConfig: extractProfileProxyConfig(profile),
            onTokenRefreshed: async (newToken) => {
                await prisma.profile.update({
                    where: { id: profile.id },
                    data: {
                        accessToken: newToken,
                        accessTokenExpires: new Date(Date.now() + 55 * 60 * 1000)
                    },
                });
            },
        });
        // Get Veo3 project ID for this profile in the project
        let veo3ProjectId = undefined;
        if (projectId) {
            const project = await genNormalRepository.getProject(projectId);
            let projectProfile = project?.profiles.find(p => p.profileId === profileId);
            if (!projectProfile) {
                throw new Error(`Profile ${profileId} not found in project ${projectId}`);
            }
            if (!projectProfile.veo3ProjectId) {
                logger.error(`[GenNormal] ERROR: No Veo3 project ID found for profile ${profileId} in project ${projectId}!`, {
                    projectId,
                    profileId,
                    profileName: projectProfile.profile.name,
                    error: 'Veo3 project must be created when creating the GenNormal project. Please recreate the project.'
                });
                throw new Error(`No Veo3 project ID found for profile ${profileId}. Please recreate the GenNormal project.`);
            }
            veo3ProjectId = projectProfile.veo3ProjectId;
            logger.info(`[GenNormal] Using Veo3 project ${veo3ProjectId} for profile ${profileId}`, {
                projectId,
                profileName: projectProfile.profile.name
            });
        }
        else {
            logger.warn(`[GenNormal] No projectId provided for upload, using empty project ID`, {
                profileId
            });
        }
        // Use provider.uploadImage (common API)
        // Convert aspectRatio from string format ("16:9", "9:16") to enum format
        let imageAspectRatio = undefined;
        if (aspectRatio) {
            imageAspectRatio = aspectRatio === '9:16'
                ? 'IMAGE_ASPECT_RATIO_PORTRAIT'
                : 'IMAGE_ASPECT_RATIO_LANDSCAPE';
        }
        const uploadOptions = imageAspectRatio ? { aspectRatio: imageAspectRatio } : undefined;
        let mediaId;
        try {
            mediaId = await provider.uploadImageAndExtractMediaId(imagePath, veo3ProjectId || '', // Use veo3ProjectId, empty string if not available
            uploadOptions);
        }
        catch (error) {
            const errorMessage = error?.message || String(error);
            // Check if error is 403/reCAPTCHA related
            const isRecaptchaError = errorMessage.includes('403') ||
                errorMessage.includes('reCAPTCHA') ||
                errorMessage.includes('Xác thực reCAPTCHA thất bại');
            // Check if error is rate limit (429)
            const isRateLimitError = errorMessage.includes('429') ||
                errorMessage.includes('Too Many Requests') ||
                errorMessage.includes('RESOURCE_EXHAUSTED');
            if ((isRecaptchaError || isRateLimitError) && retryCount < 2) {
                logger.warn(`[GenNormal] Upload image failed with ${isRecaptchaError ? '403/reCAPTCHA' : '429/rate limit'} error, retrying...`, {
                    profileId,
                    retryCount,
                    error: errorMessage.substring(0, 200)
                });
                if (isRecaptchaError) {
                    const { captchaManager } = await import('../../lib/captchaManager.js');
                    captchaManager.notifyFailure();
                }
                // Wait before retry (5s for 403, 3s for 429)
                const delayMs = isRecaptchaError ? 5000 : 3000;
                await new Promise(resolve => setTimeout(resolve, delayMs));
                // Retry with incremented count
                return this.uploadImageAndGetMediaId(imagePath, profileId, aspectRatio, projectId, retryCount + 1);
            }
            // Re-throw if not retryable or max retries reached
            throw error;
        }
        logger.info(`[GenNormal] Image uploaded successfully, mediaId: ${mediaId.substring(0, 30)}...`);
        // DEBUG: Log mapping of profileId -> mediaId -> veo3ProjectId
        logger.info(`[GenNormal] DEBUG UPLOAD: profileId=${profileId}, veo3ProjectId=${veo3ProjectId}, mediaId=${mediaId.substring(0, 40)}...`);
        // Save uploaded image to local storage for preview
        const userDataPath = process.env.USERDATA_PATH || path.join(os.homedir(), '.veo3studio');
        const uploadsDir = path.join(userDataPath, 'uploads', 'gen-normal');
        // Create uploads directory if not exists
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }
        // Copy uploaded image to local storage with mediaId as filename
        const ext = path.extname(imagePath) || '.jpg';
        const localImagePath = path.join(uploadsDir, `${mediaId.substring(0, 50)}${ext}`);
        fs.copyFileSync(imagePath, localImagePath);
        logger.info(`[GenNormal] Saved image to local storage: ${localImagePath}`);
        // Return mediaId, local file path for preview, and veo3ProjectId
        return { mediaId, previewUrl: localImagePath, veo3ProjectId: veo3ProjectId || null };
    },
    /**
     * Delete media from Veo3 cloud
     * Uses provider API to ensure same profile config
     */
    async deleteMedia(mediaIds, profileId) {
        logger.info('[GenNormal] Deleting media using provider', { mediaIds, profileId });
        // Get profile
        const profile = await prisma.profile.findUnique({
            where: { id: profileId }
        });
        if (!profile) {
            throw new Error('Profile not found');
        }
        // Get cookies from partition
        const cookiesString = await getCookiesForGenNormal(profile);
        // Get provider (same one used for upload and video generation)
        const provider = new Veo3Service();
        // Update provider config with profile credentials (same as in queueManager)
        provider.updateConfig({
            accessToken: profile.accessToken || undefined,
            cookies: cookiesString,
            profileId: profile.id,
            proxyConfig: extractProfileProxyConfig(profile),
            onTokenRefreshed: async (newToken) => {
                await prisma.profile.update({
                    where: { id: profile.id },
                    data: {
                        accessToken: newToken,
                        accessTokenExpires: new Date(Date.now() + 55 * 60 * 1000)
                    },
                });
            },
        });
        // mediaIds are the same as mediaNames in Veo3 API
        const success = await provider.deleteMedia(mediaIds);
        logger.info(`[GenNormal] Media deleted successfully using provider`);
        return success;
    },
    /**
     * Create jobs with already-uploaded mediaIds for start/end frames
     * Images are already uploaded to their assigned profiles
     * veo3ProjectId is required to ensure the job uses the same Veo3 project where the image was uploaded
     */
    async createJobsWithMediaIds(projectId, data) {
        // Guard: one batch-with-mediaids call must share a single mode — the queue
        // batches by mode, so a mixed call could apply the wrong model key to part
        // of the batch.
        const batchModes = new Set(data.jobs.map(j => j.mode));
        if (batchModes.size > 1) {
            throw new Error('All jobs in a batch-with-mediaids call must share the same mode');
        }
        const batchMode = data.jobs[0]?.mode;
        // Guard: REFERENCE_TO_VIDEO must use an r2v-family model key (reject i2v/t2v keys).
        if (batchMode === 'REFERENCE_TO_VIDEO') {
            const isR2vKey = data.videoModelKey.startsWith('veo_3_1_r2v') || data.videoModelKey.startsWith('abra_r2v');
            if (!isR2vKey) {
                throw new Error(`videoModelKey "${data.videoModelKey}" is not valid for REFERENCE_TO_VIDEO (expected veo_3_1_r2v_* or abra_r2v_*)`);
            }
        }
        // Resolve fallback batchIndex: explicit value wins, otherwise derive from
        // existing jobs (max + 1 when any exist, else 0). Per-job batchIndex below
        // overrides this fallback — needed for the "reuse all images" flow so that
        // generated videos inherit the original per-image batches.
        let resolvedBatchIndex = data.batchIndex;
        if (resolvedBatchIndex === undefined) {
            const existingJobs = await genNormalRepository.getJobs(projectId);
            resolvedBatchIndex = existingJobs.length === 0
                ? 0
                : existingJobs.reduce((max, j) => Math.max(max, j.batchIndex ?? 0), -1) + 1;
        }
        logger.info('[GenNormal] Creating jobs with pre-uploaded mediaIds', {
            projectId,
            jobsCount: data.jobs.length,
            aspectRatio: data.aspectRatio,
            videoModelKey: data.videoModelKey,
            batchIndex: resolvedBatchIndex
        });
        // Get project to validate
        const project = await genNormalRepository.getProject(projectId);
        if (!project) {
            throw new Error('Project not found');
        }
        // Create all jobs in database
        const createdJobs = [];
        for (const jobData of data.jobs) {
            logger.info(`[GenNormal] Creating job #${jobData.jobIndex} for profile ${jobData.profileId}`, {
                jobIndex: jobData.jobIndex,
                profileId: jobData.profileId,
                mode: jobData.mode,
                hasStartFrame: !!jobData.startImageMediaId,
                hasEndFrame: !!jobData.endImageMediaId,
                veo3ProjectId: jobData.veo3ProjectId
            });
            // Validate: Profile must still exist in project
            const projectProfile = project.profiles.find(p => p.profileId === jobData.profileId);
            if (!projectProfile) {
                const errorMsg = `Job #${jobData.jobIndex}: Profile ${jobData.profileId} no longer exists in this project`;
                logger.error(`[GenNormal] ${errorMsg}`, {
                    jobIndex: jobData.jobIndex,
                    profileId: jobData.profileId,
                    availableProfiles: project.profiles.map(p => p.profileId)
                });
                throw new Error(errorMsg);
            }
            // Resolve veo3ProjectId: use provided value OR get from project profile
            const veo3ProjectId = jobData.veo3ProjectId || projectProfile.veo3ProjectId;
            if (!veo3ProjectId) {
                const errorMsg = `Job #${jobData.jobIndex}: No veo3ProjectId available for profile ${jobData.profileId}`;
                logger.error(`[GenNormal] ${errorMsg}`);
                throw new Error(errorMsg);
            }
            // Validate: IMAGE_TO_VIDEO and FRAME_TO_FRAME modes require startImageMediaId
            if ((jobData.mode === 'IMAGE_TO_VIDEO' || jobData.mode === 'FRAME_TO_FRAME') && !jobData.startImageMediaId) {
                const errorMsg = `Job #${jobData.jobIndex} (${jobData.mode}) requires startImageMediaId but upload failed or was not provided`;
                logger.error(`[GenNormal] ${errorMsg}`, {
                    jobIndex: jobData.jobIndex,
                    profileId: jobData.profileId,
                    mode: jobData.mode
                });
                throw new Error(errorMsg);
            }
            // Validate: REFERENCE_TO_VIDEO requires 1..maxRefs reference image ids
            if (jobData.mode === 'REFERENCE_TO_VIDEO') {
                const refs = jobData.referenceImageMediaIds;
                const maxRefs = isOmniFlashKey(data.videoModelKey) ? 7 : 3;
                if (!Array.isArray(refs) || refs.length < 1) {
                    const errorMsg = `Job #${jobData.jobIndex} (REFERENCE_TO_VIDEO) requires at least 1 referenceImageMediaIds`;
                    logger.error(`[GenNormal] ${errorMsg}`, { jobIndex: jobData.jobIndex, profileId: jobData.profileId });
                    throw new Error(errorMsg);
                }
                if (refs.length > maxRefs) {
                    throw new Error(`Job #${jobData.jobIndex} (REFERENCE_TO_VIDEO) accepts max ${maxRefs} reference images for "${data.videoModelKey}" (got ${refs.length})`);
                }
            }
            try {
                // Create job in database with DRAFT status (will be converted to QUEUED by start-generation)
                // Include veo3ProjectId to ensure job uses the same Veo3 project where images were uploaded
                const isReferenceMode = jobData.mode === 'REFERENCE_TO_VIDEO';
                const job = await prisma.genNormalJob.create({
                    data: {
                        projectId,
                        profileId: jobData.profileId,
                        prompt: jobData.prompt,
                        mode: jobData.mode,
                        // Frame columns only for IMAGE_TO_VIDEO / FRAME_TO_FRAME
                        startImageMediaId: isReferenceMode ? null : (jobData.startImageMediaId ?? null),
                        endImageMediaId: isReferenceMode ? null : (jobData.endImageMediaId ?? null),
                        startImagePreviewUrl: isReferenceMode ? null : (jobData.startImagePreviewUrl ?? null),
                        endImagePreviewUrl: isReferenceMode ? null : (jobData.endImagePreviewUrl ?? null),
                        // Per-shot references (JSON) only for REFERENCE_TO_VIDEO — consumed by
                        // the queue manager which builds referenceImages[] with IMAGE_USAGE_TYPE_ASSET
                        referenceImageMediaIds: isReferenceMode
                            ? JSON.stringify(jobData.referenceImageMediaIds)
                            : null,
                        referenceImagePreviewUrls: isReferenceMode && jobData.referenceImagePreviewUrls
                            ? JSON.stringify(jobData.referenceImagePreviewUrls)
                            : null,
                        veo3ProjectId: veo3ProjectId, // Store veo3ProjectId to ensure correct project is used
                        jobIndex: jobData.jobIndex,
                        batchIndex: jobData.batchIndex ?? resolvedBatchIndex, // Per-job override wins (see "reuse all images")
                        videoDurationSeconds: data.videoDurationSeconds ?? null, // Snapshot độ dài Omni Flash để queue manager build đúng abra_i2v_<n>s
                        status: 'DRAFT', // Will be converted to QUEUED by start-generation
                        progress: 0,
                        retryCount: 0,
                        maxRetries: 10 // Tăng từ 3 lên 10 để tool tự động retry nhiều hơn
                    }
                });
                logger.info(`[GenNormal] ✅ Job #${jobData.jobIndex} created`, {
                    jobId: job.id,
                    mode: jobData.mode,
                    profileId: jobData.profileId
                });
                createdJobs.push(job);
            }
            catch (error) {
                logger.error(`[GenNormal] Failed to create job #${jobData.jobIndex}:`, {
                    error: error.message,
                    profileId: jobData.profileId
                });
                throw error;
            }
        }
        logger.info('[GenNormal] All jobs created successfully', {
            totalCreated: createdJobs.length
        });
        // Update project with new videoModelKey, aspectRatio và (nếu có) videoDurationSeconds
        await genNormalRepository.updateProject(projectId, {
            videoModelKey: data.videoModelKey,
            aspectRatio: data.aspectRatio,
            ...(data.videoDurationSeconds !== undefined && { videoDurationSeconds: data.videoDurationSeconds }),
        });
        // Don't initialize queue - jobs are DRAFT and need validation first (via start-generation)
        return {
            success: true,
            jobsCreated: createdJobs.length,
            jobs: createdJobs
        };
    },
    /**
     * Edit image - create new job to edit an existing image
     */
    async editImage(jobId, editPrompt) {
        logger.info('[GenNormal] Editing image', { jobId, editPromptLength: editPrompt.length });
        // Get the original job
        const originalJob = await prisma.genNormalJob.findUnique({
            where: { id: jobId },
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
        if (!originalJob) {
            throw new Error('Job not found');
        }
        if (originalJob.mode !== 'IMAGE_GENERATION') {
            throw new Error('Only IMAGE_GENERATION jobs can be edited');
        }
        if (originalJob.status !== 'COMPLETED') {
            throw new Error('Only completed jobs can be edited');
        }
        if (!originalJob.providerJobId || originalJob.providerJobId === 'N/A') {
            throw new Error('Original job does not have a valid mediaId');
        }
        // Get project profile for this job
        const projectProfile = originalJob.project.profiles.find(p => p.profileId === originalJob.profileId);
        if (!projectProfile) {
            throw new Error('Project profile not found');
        }
        const baseImageMediaId = originalJob.providerJobId;
        // Create new job with same jobIndex, status DRAFT, new prompt
        const newJob = await prisma.genNormalJob.create({
            data: {
                projectId: originalJob.projectId,
                profileId: originalJob.profileId,
                prompt: editPrompt,
                jobIndex: originalJob.jobIndex, // Keep same jobIndex to maintain order
                batchIndex: originalJob.batchIndex, // Keep same batchIndex so per-batch merge stays consistent
                mode: 'IMAGE_GENERATION',
                status: 'DRAFT',
                // Store baseImageMediaId in referenceImageMediaIds (will be used as base image)
                referenceImageMediaIds: JSON.stringify([baseImageMediaId]),
                progress: 0,
                retryCount: 0,
                maxRetries: originalJob.maxRetries
            }
        });
        logger.info(`[GenNormal] Created edit job ${newJob.id} for original job ${jobId}`, {
            newJobId: newJob.id,
            originalJobId: jobId,
            jobIndex: newJob.jobIndex,
            baseImageMediaId: baseImageMediaId.substring(0, 50) + '...'
        });
        // Start generation (this will validate and queue the job)
        await this.startGeneration(originalJob.projectId);
        return {
            success: true,
            jobId: newJob.id
        };
    },
    /**
     * Reuse video - create new job with same configuration but new prompt
     */
    async reuseVideo(jobId, newPrompt) {
        logger.info('[GenNormal] Reusing job configuration', { jobId, newPromptLength: newPrompt.length });
        // Get the original job
        const originalJob = await prisma.genNormalJob.findUnique({
            where: { id: jobId },
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
        if (!originalJob) {
            throw new Error('Job not found');
        }
        if (originalJob.status !== 'COMPLETED') {
            throw new Error('Only completed jobs can be reused');
        }
        // Create new job with same configuration, new prompt
        const newJob = await prisma.genNormalJob.create({
            data: {
                projectId: originalJob.projectId,
                profileId: originalJob.profileId,
                prompt: newPrompt,
                jobIndex: originalJob.jobIndex, // Keep same jobIndex to maintain order
                batchIndex: originalJob.batchIndex, // Keep same batchIndex so per-batch merge stays consistent
                mode: originalJob.mode,
                status: 'DRAFT',
                // Reuse all image/reference configurations (with proper type casting for JsonValue)
                startImageMediaId: originalJob.startImageMediaId,
                endImageMediaId: originalJob.endImageMediaId,
                referenceImageMediaIds: originalJob.referenceImageMediaIds,
                startImagePreviewUrl: originalJob.startImagePreviewUrl,
                endImagePreviewUrl: originalJob.endImagePreviewUrl,
                referenceImagePreviewUrls: originalJob.referenceImagePreviewUrls,
                // Must travel with referenceImageMediaIds — the structured-prompt branch
                // reads both, so copying only the ids would silently demote a regenerated
                // job to the flat-prompt path.
                referenceImageHandles: originalJob.referenceImageHandles ?? null,
                progress: 0,
                retryCount: 0,
                maxRetries: originalJob.maxRetries
            }
        });
        logger.info(`[GenNormal] Created reuse job ${newJob.id} for original job ${jobId}`, {
            newJobId: newJob.id,
            originalJobId: jobId,
            jobIndex: newJob.jobIndex,
            mode: newJob.mode,
            hasStartImage: !!newJob.startImageMediaId,
            hasEndImage: !!newJob.endImageMediaId,
            hasReferenceImages: !!newJob.referenceImageMediaIds
        });
        // Check if there are any jobs currently running
        const runningJobs = await prisma.genNormalJob.count({
            where: {
                projectId: originalJob.projectId,
                status: { in: ['PROCESSING', 'QUEUED'] }
            }
        });
        // If no jobs running, start generation immediately
        // If jobs are running, the new job will be queued and picked up automatically
        if (runningJobs === 0) {
            logger.info(`[GenNormal] No running jobs, starting generation immediately for job ${newJob.id}`);
            await this.startGeneration(originalJob.projectId);
        }
        else {
            logger.info(`[GenNormal] ${runningJobs} job(s) running, new job ${newJob.id} will be queued`);
            // Just validate and queue the job
            await this.startGeneration(originalJob.projectId);
        }
        return {
            success: true,
            jobId: newJob.id
        };
    },
    /**
     * Cleanup stuck PROCESSING jobs (admin/debug tool)
     * Marks jobs that have been processing for > 30 minutes as FAILED
     */
    async cleanupStuckJobs() {
        logger.info('[GenNormal] Cleaning up stuck PROCESSING jobs...');
        const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
        const stuckJobs = await prisma.genNormalJob.findMany({
            where: {
                status: 'PROCESSING',
                startedAt: {
                    lt: thirtyMinutesAgo
                }
            }
        });
        if (stuckJobs.length === 0) {
            logger.info('[GenNormal] No stuck jobs found');
            return {
                success: true,
                cleanedCount: 0,
                message: 'No stuck jobs found'
            };
        }
        logger.warn(`[GenNormal] Found ${stuckJobs.length} stuck jobs, marking as FAILED`, {
            jobIds: stuckJobs.map(j => j.id),
            jobIndexes: stuckJobs.map(j => j.jobIndex)
        });
        // Update all stuck jobs to FAILED
        await prisma.genNormalJob.updateMany({
            where: {
                id: {
                    in: stuckJobs.map(j => j.id)
                }
            },
            data: {
                status: 'FAILED',
                error: 'Timeout: Processing for more than 30 minutes (cleaned up by admin)',
                completedAt: new Date()
            }
        });
        // Update project stats for each affected project
        const projectIds = [...new Set(stuckJobs.map(j => j.projectId))];
        for (const projectId of projectIds) {
            await genNormalQueueManager['updateProjectStats'](projectId);
        }
        return {
            success: true,
            cleanedCount: stuckJobs.length,
            message: `Marked ${stuckJobs.length} stuck job(s) as FAILED`,
            jobIds: stuckJobs.map(j => j.id)
        };
    },
    /**
     * Get credits and paygate tier for a project
     */
    async getCredits(projectId) {
        const project = await genNormalRepository.getProject(projectId);
        if (!project) {
            // Project deleted entirely — surface as 404 so UI can route away.
            const err = new Error('Project not found');
            err.statusCode = 404;
            throw err;
        }
        if (project.profiles.length === 0) {
            // Orphaned project: every attached profile has been removed. Don't 500 —
            // the UI polls this endpoint every 10s and a hard error makes the detail
            // screen look broken. Return a zero-credits payload matching the shape
            // `CreditsResponse` the renderer expects, with a sentinel `orphaned`
            // flag the UI can use to surface a friendlier message.
            return {
                credits: 0,
                userPaygateTier: '',
                sku: '',
                serviceTier: '',
                orphaned: true,
            };
        }
        const firstProfile = project.profiles[0];
        const provider = new Veo3Service();
        const cookiesString = await getCookiesForGenNormal(firstProfile.profile);
        provider.updateConfig({
            accessToken: firstProfile.profile.accessToken || undefined,
            cookies: cookiesString,
            profileId: firstProfile.profile.id,
            proxyConfig: extractProfileProxyConfig(firstProfile.profile),
            onTokenRefreshed: async (newToken) => {
                await prisma.profile.update({
                    where: { id: firstProfile.profile.id },
                    data: { accessToken: newToken, accessTokenExpires: new Date(Date.now() + 55 * 60 * 1000) }
                });
            }
        });
        return provider.getCredits();
    }
};
