import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
export const genNormalRepository = {
    // Projects
    async listProjects(source) {
        return prisma.genNormalProject.findMany({
            where: source ? { source } : undefined, // Filter by source if provided
            orderBy: { createdAt: 'desc' },
            include: {
                profiles: {
                    include: {
                        profile: {
                            select: { id: true, name: true }
                        }
                    }
                },
                _count: {
                    select: { jobs: true }
                }
            }
        });
    },
    async getProject(projectId) {
        return prisma.genNormalProject.findUnique({
            where: { id: projectId },
            include: {
                profiles: {
                    include: {
                        profile: true
                    }
                },
                jobs: {
                    orderBy: { jobIndex: 'asc' },
                    select: {
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
                        upscaledMediaId: true,
                        downloadedAt: true,
                        downloadAttempts: true,
                        lastDownloadError: true,
                        createdAt: true,
                        updatedAt: true,
                        startedAt: true,
                        completedAt: true,
                        profile: {
                            select: { id: true, name: true }
                        }
                    },
                }
            }
        });
    },
    async createProject(data) {
        return prisma.genNormalProject.create({
            data: {
                name: data.name,
                inputMethod: data.inputMethod,
                aspectRatio: data.aspectRatio,
                outputDir: data.outputDir,
                source: data.source || 'normal', // Default to 'normal' if not specified
                concurrency: 8,
                batchSize: 1,
                delaySeconds: 10,
                profiles: {
                    create: data.profileIds.map(profileId => ({
                        profileId
                    }))
                }
            },
            include: {
                profiles: {
                    include: {
                        profile: true
                    }
                }
            }
        });
    },
    async updateProject(projectId, data) {
        return prisma.genNormalProject.update({
            where: { id: projectId },
            data
        });
    },
    async deleteProject(projectId) {
        try {
            return await prisma.genNormalProject.delete({
                where: { id: projectId }
            });
        }
        catch (error) {
            // P2025: Record not found - project was already deleted
            if (error.code === 'P2025') {
                logger.info(`[GenNormalRepo] Project ${projectId} already deleted, ignoring`);
                return null;
            }
            throw error;
        }
    },
    // Jobs
    async createJobs(projectId, prompts, profileIds, mode = 'TEXT_TO_VIDEO', referenceImageMediaIdsByProfile, // Array<Record<profileId, mediaId>> for each reference image
    referenceImagePreviewUrlsByProfile, // Array<Record<profileId, previewUrl>> for each reference image
    veo3ProjectIdsByProfile, // Map of profileId -> veo3ProjectId for each profile
    startJobIndex = 0, // Offset for jobIndex when appending jobs (default 0 for fresh batches)
    batchIndex = 0, // Groups jobs created in the same "Tạo job" submission for per-batch merge export
    // Storyboard mode: per-job ordered ref slots. Outer index aligns with
    // `prompts[i]`; inner array is ordered slot 0..N-1 (chars first, location
    // last by convention); each slot is `Record<profileId, mediaId>`. Capped
    // to 10 slots/job server-side. When provided, this REPLACES the global
    // `referenceImageMediaIdsByProfile` for IMAGE_GENERATION mode.
    perJobReferenceImageMediaIdsByProfile,
    // Round-robin granularity. Default 4 (gen-normal classic). Storyboard
    // mode passes 1 so each consecutive shot rotates to the next profile,
    // approximating "shot 1 then shot 2 then shot 3" globally even when
    // multiple profiles run in parallel.
    jobsPerProfileBatch = 4,
    // REFERENCE_TO_VIDEO_AUDIO mode: voice preset id (e.g. "achernar") shared by every job in the batch.
    audioMediaId,
    // Omni Flash family: per-job duration snapshot (4/6/8/10s). Undefined for Veo 3.1.
    videoDurationSeconds,
    // Named COMPONENTS: per-job handle metadata, index-aligned slot-for-slot with
    // `perJobReferenceImageMediaIdsByProfile[i]`. Carries its own previewUrl because
    // the global `referenceImagePreviewUrlsByProfile` is indexed by library position,
    // not by per-job slot — reading it with a slot index would attach another
    // prompt's thumbnail.
    perJobReferenceImageHandles) {
        if (profileIds.length === 0) {
            throw new Error('No profiles provided');
        }
        const jobs = [];
        // BATCH SIZE: chia job theo batch N liên tiếp cho mỗi profile.
        // Default = 4 (gen-normal classic). Storyboard mode passes 1 so consecutive
        // shots rotate profiles → globally approximate "shot 1 → 2 → 3" order.
        const batchSize = jobsPerProfileBatch > 0 ? jobsPerProfileBatch : 4;
        for (let i = 0; i < prompts.length; i++) {
            const profileBatchIndex = Math.floor(i / batchSize);
            const profileId = profileIds[profileBatchIndex % profileIds.length];
            const prompt = prompts[i];
            if (!prompt || !profileId)
                continue; // Skip empty prompts or missing profileId
            // Get veo3ProjectId for this profile (if provided)
            const veo3ProjectId = veo3ProjectIdsByProfile?.[profileId];
            const jobData = {
                projectId,
                profileId,
                prompt,
                jobIndex: startJobIndex + i,
                batchIndex,
                mode,
                status: 'DRAFT', // Jobs start as DRAFT, need to be validated before QUEUED
                ...(veo3ProjectId && { veo3ProjectId }), // Include veo3ProjectId if available
                ...(mode === 'REFERENCE_TO_VIDEO_AUDIO' && audioMediaId ? { audioMediaId } : {}),
                ...(videoDurationSeconds != null ? { videoDurationSeconds } : {}),
            };
            // Per-job ordered ref slots. Storyboard (IMAGE_GENERATION) pairs each shot
            // with its own chars+location; named COMPONENTS (r2v) pairs each prompt with
            // the images its @handles named. Either way: order preserved, deduped, capped.
            const isPerJobRefMode = mode === 'IMAGE_GENERATION' ||
                mode === 'REFERENCE_TO_VIDEO' ||
                mode === 'REFERENCE_TO_VIDEO_AUDIO';
            const perJobSlotCap = mode === 'IMAGE_GENERATION' ? 10 : 7;
            if (isPerJobRefMode && perJobReferenceImageMediaIdsByProfile?.[i]) {
                const isReferenceMode = mode !== 'IMAGE_GENERATION';
                const handleSlots = perJobReferenceImageHandles?.[i];
                const ordered = [];
                const previews = [];
                const handles = [];
                const seen = new Set();
                const slots = perJobReferenceImageMediaIdsByProfile[i];
                for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
                    const mediaId = slots[slotIndex]?.[profileId];
                    if (mediaId && !seen.has(mediaId)) {
                        ordered.push(mediaId);
                        seen.add(mediaId);
                        const slotHandle = handleSlots?.[slotIndex];
                        if (isReferenceMode) {
                            previews.push({ mediaId, previewUrl: slotHandle?.previewUrl ?? null });
                        }
                        if (slotHandle?.handle) {
                            handles.push({ handle: slotHandle.handle, mediaId });
                        }
                    }
                    if (ordered.length >= perJobSlotCap)
                        break; // server cap
                }
                if (ordered.length > 0) {
                    jobData.referenceImageMediaIds = JSON.stringify(ordered);
                    if (isReferenceMode) {
                        jobData.referenceImagePreviewUrls = JSON.stringify(previews);
                    }
                    if (handles.length > 0) {
                        jobData.referenceImageHandles = JSON.stringify(handles);
                    }
                }
            }
            else if (mode === 'IMAGE_GENERATION' && referenceImageMediaIdsByProfile && referenceImageMediaIdsByProfile.length > 0) {
                // Legacy gen-normal mode: ALL jobs share the SAME reference image(s).
                // Each profile gets its own uploaded mediaId. Kept unchanged for BC.
                const mediaIdsForThisProfile = [];
                for (let imgIndex = 0; imgIndex < referenceImageMediaIdsByProfile.length; imgIndex++) {
                    const mediaIdsByProfile = referenceImageMediaIdsByProfile[imgIndex];
                    if (mediaIdsByProfile) {
                        const mediaId = mediaIdsByProfile[profileId];
                        if (mediaId) {
                            mediaIdsForThisProfile.push(mediaId);
                        }
                    }
                }
                if (mediaIdsForThisProfile.length > 0) {
                    jobData.referenceImageMediaIds = JSON.stringify(mediaIdsForThisProfile);
                }
            }
            else if ((mode === 'REFERENCE_TO_VIDEO' || mode === 'REFERENCE_TO_VIDEO_AUDIO') && referenceImageMediaIdsByProfile && referenceImageMediaIdsByProfile.length > 0) {
                // Shared-reference r2v: every job uses the same images. Chained off the
                // per-job branch above — as a standalone `if` it would overwrite the
                // per-prompt selection whenever a caller sent both.
                // Extract mediaIds and previewUrls for this job's profileId (use all available, not limited to 3)
                const mediaIdsForThisProfile = [];
                const previewUrlsForThisProfile = [];
                for (let imgIndex = 0; imgIndex < referenceImageMediaIdsByProfile.length; imgIndex++) {
                    const mediaIdsByProfile = referenceImageMediaIdsByProfile[imgIndex];
                    if (mediaIdsByProfile) {
                        const mediaId = mediaIdsByProfile[profileId];
                        if (mediaId) {
                            mediaIdsForThisProfile.push(mediaId);
                            // Get corresponding previewUrl if available
                            const previewUrlsByProfile = referenceImagePreviewUrlsByProfile?.[imgIndex];
                            const previewUrl = previewUrlsByProfile?.[profileId] || null;
                            previewUrlsForThisProfile.push({ mediaId, previewUrl });
                        }
                    }
                }
                if (mediaIdsForThisProfile.length > 0) {
                    jobData.referenceImageMediaIds = JSON.stringify(mediaIdsForThisProfile);
                    jobData.referenceImagePreviewUrls = JSON.stringify(previewUrlsForThisProfile);
                }
            }
            jobs.push(jobData);
            // profileIndex++ không cần nữa vì đã dùng batchIndex
        }
        const result = await prisma.genNormalJob.createMany({
            data: jobs
        });
        // Return result with count
        return result;
    },
    async getJobs(projectId) {
        return prisma.genNormalJob.findMany({
            where: { projectId },
            orderBy: { jobIndex: 'asc' },
            // Explicit select to avoid fetching heavyweight columns (e.g. videoBlob).
            select: {
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
                videoDurationSeconds: true,
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
                upscaledMediaId: true,
                downloadedAt: true,
                downloadAttempts: true,
                lastDownloadError: true,
                createdAt: true,
                updatedAt: true,
                startedAt: true,
                completedAt: true,
                profile: {
                    select: { id: true, name: true }
                }
            },
        });
    },
    async updateJob(jobId, data) {
        return prisma.genNormalJob.update({
            where: { id: jobId },
            data
        });
    },
    async deleteJob(jobId) {
        return prisma.genNormalJob.delete({
            where: { id: jobId }
        });
    },
    async deleteAllJobs(projectId) {
        return prisma.genNormalJob.deleteMany({
            where: { projectId }
        });
    },
    async getProjectProfile(projectId, profileId) {
        return prisma.genNormalProjectProfile.findUnique({
            where: {
                projectId_profileId: {
                    projectId,
                    profileId
                }
            }
        });
    }
};
