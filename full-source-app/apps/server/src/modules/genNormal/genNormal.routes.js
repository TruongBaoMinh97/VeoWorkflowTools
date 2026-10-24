import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as XLSX from 'xlsx';
import { genNormalService } from './genNormal.service.js';
import { getAvailableVideoModels, getAvailableImageModels, OMNI_FLASH_DURATIONS } from '../../utils/videoModelResolver.js';
import { logger } from '../../lib/logger.js';
// Shared schema: only valid Omni Flash durations (4/6/8/10). NULL/undefined = Veo 3.1 default.
const videoDurationSecondsSchema = z
    .number()
    .int()
    .refine((d) => OMNI_FLASH_DURATIONS.includes(d), {
    message: 'videoDurationSeconds must be one of 4, 6, 8, 10',
})
    .optional();
export async function registerGenNormalRoutes(app) {
    // Parse an imported Excel for REFERENCE_BATCH: col A = prompt, cols B/C/D = up to
    // 3 image paths. Row 1 is treated as a header and skipped. Rows without a prompt
    // are dropped; rows with a prompt but no image path are kept (paths: []) so the
    // frontend can report which rows are missing images.
    app.post('/api/gen-normal/parse-excel', async (req) => {
        const { fileBase64 } = z.object({ fileBase64: z.string().min(1) }).parse(req.body);
        try {
            const wb = XLSX.read(Buffer.from(fileBase64, 'base64'), { type: 'buffer' });
            const sheet = wb.Sheets[wb.SheetNames[0]];
            if (!sheet)
                return { success: false, error: 'File Excel rỗng', rows: [] };
            const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
            const rows = matrix
                .slice(1) // drop header row
                .map((r) => {
                const cells = r;
                return {
                    prompt: String(cells?.[0] ?? '').trim(),
                    // Cols B, C, D (indices 1,2,3): trim, drop empty, cap at 3
                    paths: [cells?.[1], cells?.[2], cells?.[3]]
                        .map((v) => String(v ?? '').trim())
                        .filter((v) => v.length > 0)
                        .slice(0, 3),
                };
            })
                .filter((r) => r.prompt.length > 0);
            return { success: true, rows };
        }
        catch (err) {
            logger.error('[GenNormal] parse-excel failed', { error: err?.message });
            return { success: false, error: err?.message || 'Không đọc được file Excel', rows: [] };
        }
    });
    // Read a local image file by absolute path → base64 (Excel import column B).
    app.post('/api/gen-normal/read-local-image', async (req) => {
        const rawPath = z.object({ path: z.string().min(1) }).parse(req.body).path;
        // Normalize a user-supplied path: trim, strip surrounding quotes, and (only as
        // a fallback) shell-unescape "\ " → " " etc. — handles paths copied from a
        // terminal like /Users/x/hoat\ hinh/a.jpg. Windows paths (D:\...) are tried
        // raw first, so they are unaffected.
        const cleaned = rawPath.trim().replace(/^["']|["']$/g, '');
        const candidates = [cleaned];
        const unescaped = cleaned.replace(/\\(.)/g, '$1');
        if (unescaped !== cleaned)
            candidates.push(unescaped);
        let filePath = null;
        for (const c of candidates) {
            try {
                await fs.promises.access(c, fs.constants.R_OK);
                filePath = c;
                break;
            }
            catch {
                /* try next candidate */
            }
        }
        if (!filePath) {
            return { success: false, error: 'Không tìm thấy file' };
        }
        const ext = path.extname(filePath).toLowerCase();
        const MIME = {
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
            '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
        };
        if (!MIME[ext]) {
            return { success: false, error: `Không phải file ảnh hợp lệ (${ext || 'không có đuôi'})` };
        }
        try {
            const stat = await fs.promises.stat(filePath);
            if (stat.size > 30 * 1024 * 1024) {
                return { success: false, error: 'Ảnh vượt quá 30MB' };
            }
            const buf = await fs.promises.readFile(filePath);
            return { success: true, base64: buf.toString('base64'), mimeType: MIME[ext], fileName: path.basename(filePath) };
        }
        catch (err) {
            return { success: false, error: err?.message || 'Lỗi đọc file' };
        }
    });
    // Get available video models based on generation type, aspect ratio, and (optional) user tier
    app.get('/api/gen-normal/models', async (req) => {
        const { generationType, aspectRatio, userTier } = z.object({
            generationType: z.enum(['TEXT_TO_VIDEO', 'REFERENCE_TO_VIDEO', 'REFERENCE_TO_VIDEO_AUDIO', 'IMAGE_TO_VIDEO', 'FRAME_TO_FRAME']),
            aspectRatio: z.enum(['16:9', '9:16']),
            userTier: z.enum(['ADVANCED', 'INTERMEDIATE', 'ENTRY']).optional()
        }).parse(req.query);
        const models = getAvailableVideoModels(generationType, aspectRatio, userTier);
        return { models };
    });
    // System resource stats for frontend warnings
    app.get('/api/gen-normal/system-stats', async () => {
        const os = await import('os');
        const { queueManager } = await import('../../core/queue/SQLiteQueueManager.js');
        const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
        const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
        const heapUsedMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        return {
            freeMemMB,
            totalMemMB,
            heapUsedMB,
            memoryPressure: freeMemMB < 1024 ? 'high' : freeMemMB < 2048 ? 'medium' : 'low',
            maxConcurrentGlobal: queueManager.MAX_CONCURRENT_GLOBAL,
            maxConcurrentPerProfile: queueManager.MAX_CONCURRENT_PER_PROFILE,
        };
    });
    // Get available image generation models
    app.get('/api/gen-normal/image-models', async () => {
        const models = getAvailableImageModels();
        return { models };
    });
    // List projects (filtered by source: 'normal' by default, or 'pro_editor')
    app.get('/api/gen-normal/projects', async (req) => {
        const { source } = z.object({ source: z.enum(['normal', 'pro_editor']).optional() }).parse(req.query);
        return genNormalService.listProjects(source);
    });
    // Get project detail
    app.get('/api/gen-normal/projects/:id', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        const project = await genNormalService.getProject(id);
        if (!project) {
            return { error: 'Project not found' };
        }
        return project;
    });
    // Create new project
    app.post('/api/gen-normal/projects', async (req, reply) => {
        const body = z.object({
            name: z.string().min(1),
            profileIds: z.array(z.string()).min(1),
            inputMethod: z.string().optional(),
            aspectRatio: z.string().optional(),
            outputDir: z.string().optional(),
            source: z.enum(['normal', 'pro_editor']).optional() // Source: 'normal' (default) or 'pro_editor'
        }).parse(req.body);
        try {
            const project = await genNormalService.createProject(body);
            reply.code(201).send(project);
        }
        catch (err) {
            if (err?.code === 'VEO3_PROJECT_CREATE_FAILED') {
                reply.code(502).send({
                    error: 'VEO3_PROJECT_CREATE_FAILED',
                    message: err.message,
                    veo3Errors: err.veo3Errors ?? [],
                });
                return;
            }
            throw err;
        }
    });
    // Update project configuration
    app.patch('/api/gen-normal/projects/:id', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        const body = z.object({
            inputMethod: z.string().optional(),
            aspectRatio: z.string().optional(),
            outputDir: z.string().optional(),
            concurrency: z.number().int().min(1).max(12).optional(),
            batchSize: z.number().int().min(1).max(4).optional(),
            delaySeconds: z.number().int().min(1).max(180).optional(),
            videoModelKey: z.string().optional(),
            imageModelKey: z.string().optional(),
            paygateTier: z.string().optional(),
            autoDownload: z.boolean().optional(),
            autoUpscaleVideo: z.boolean().optional(),
            autoUpscaleImage: z.boolean().optional(),
            imageUpscaleRes: z.enum(['2K', '4K']).nullable().optional(),
            videoUpscaleRes: z.enum(['1080P', '4K']).nullable().optional(),
            imageUpscaleConcurrency: z.number().int().min(1).max(4).nullable().optional(),
            videoDurationSeconds: videoDurationSecondsSchema,
            audioEnabled: z.boolean().optional(),
            fileNamingTemplate: z.string().min(1).max(200).nullable().optional()
        }).parse(req.body);
        const project = await genNormalService.updateProject(id, body);
        return project;
    });
    // Ensure Veo3 projects are created for all profiles
    app.post('/api/gen-normal/projects/:id/ensure-veo3-projects', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        const project = await genNormalService.ensureVeo3Projects(id);
        return project;
    });
    // Delete all projects
    app.delete('/api/gen-normal/projects', async () => {
        return genNormalService.deleteAllProjects();
    });
    // Cleanup orphan projects (no profiles attached — e.g. after the only
    // attached profile was deleted). Must come BEFORE the `:id` route below
    // so Fastify doesn't treat "cleanup-orphans" as an id.
    app.delete('/api/gen-normal/projects/cleanup-orphans', async () => {
        const result = await genNormalService.deleteOrphanProjects();
        return result;
    });
    // Delete project
    app.delete('/api/gen-normal/projects/:id', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        await genNormalService.deleteProject(id);
        return { success: true };
    });
    // Submit batch (create jobs from prompts)
    app.post('/api/gen-normal/projects/:id/submit', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        const { promptText, aspectRatio, mode, concurrency, delaySeconds, videoModelKey, referenceImageMediaIdsByProfile, referenceImagePreviewUrlsByProfile, appendJobs, audioMediaId, videoDurationSeconds, perJobReferenceImageMediaIdsByProfile, perJobReferenceImageHandles } = z.object({
            promptText: z.union([z.string(), z.array(z.string())]),
            aspectRatio: z.string().optional(),
            mode: z.string().optional(),
            concurrency: z.number().int().min(1).max(12).optional(),
            delaySeconds: z.number().int().min(1).max(180).optional(), // Delay between job submissions (5-180 seconds)
            videoModelKey: z.string().optional(),
            referenceImageMediaIdsByProfile: z.array(z.record(z.string(), z.string())).optional(), // For COMPONENTS mode: Array<Record<profileId, mediaId>>
            referenceImagePreviewUrlsByProfile: z.array(z.record(z.string(), z.string().nullable())).optional(), // For COMPONENTS mode: Array<Record<profileId, previewUrl>>
            appendJobs: z.boolean().optional(), // If true, don't clear existing jobs
            audioMediaId: z.string().optional(), // For REFERENCE_TO_VIDEO_AUDIO mode: voice preset id (e.g. "achernar")
            videoDurationSeconds: videoDurationSecondsSchema,
            // Named COMPONENTS: one ordered ref-slot list per prompt (index-aligned with
            // promptText). Optional — omitting both keeps the shared-reference behaviour.
            // min(1) on the mediaId: an empty string is falsy downstream, so it would
            // read as "this profile never uploaded" instead of as a malformed payload.
            perJobReferenceImageMediaIdsByProfile: z.array(z.array(z.record(z.string(), z.string().min(1))).max(7)).optional(),
            // @handle + preview per ref slot, index-aligned slot-for-slot with the above.
            perJobReferenceImageHandles: z.array(z.array(z.object({
                handle: z.string().regex(/^[A-Za-z0-9\-_]+$/),
                previewUrl: z.string().nullable().optional(),
            })).max(7)).optional(),
        }).parse(req.body);
        const result = await genNormalService.submitBatch(id, promptText, aspectRatio, mode, concurrency, delaySeconds, videoModelKey, referenceImageMediaIdsByProfile, referenceImagePreviewUrlsByProfile, appendJobs, audioMediaId, videoDurationSeconds, perJobReferenceImageMediaIdsByProfile, perJobReferenceImageHandles);
        return result;
    });
    // Fetch the preset voice list for REFERENCE_TO_VIDEO_AUDIO mode (via Flow's projectInitialData TRPC).
    // Uses the first profile in this project that has a veo3ProjectId.
    app.get('/api/gen-normal/projects/:id/voices', async (req, reply) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        try {
            const result = await genNormalService.listFlowVoicePresets(id);
            return result;
        }
        catch (err) {
            if (err?.message === 'UNAUTHORIZED') {
                reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Profile cookies expired — re-login required' });
                return;
            }
            throw err;
        }
    });
    // Submit image generation batch
    app.post('/api/gen-normal/projects/:id/submit-image-generation-batch', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        const { promptText, aspectRatio, referenceImageMediaIdsByProfile, appendJobs } = z.object({
            promptText: z.union([z.string(), z.array(z.string())]),
            aspectRatio: z.enum(['16:9', '9:16', '1:1', '3:4', '4:3']),
            referenceImageMediaIdsByProfile: z.array(z.record(z.string(), z.string())).optional(),
            appendJobs: z.boolean().optional() // If true, don't clear existing jobs
        }).parse(req.body);
        const result = await genNormalService.submitImageGenerationBatch(id, promptText, aspectRatio, referenceImageMediaIdsByProfile || [], appendJobs);
        return result;
    });
    // Submit storyboard image batch — each shot has its OWN ordered ref slots
    // (chars first, location last). Cap 10 slots/shot enforced by Zod + repo.
    app.post('/api/gen-normal/projects/:id/submit-storyboard-image-batch', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        const body = z.object({
            promptText: z.union([z.string(), z.array(z.string())]),
            aspectRatio: z.enum(['16:9', '9:16', '1:1', '3:4', '4:3']),
            perJobReferenceImageMediaIdsByProfile: z.array(z.array(z.record(z.string(), z.string())).max(10)),
            appendJobs: z.boolean().optional(),
            jobsPerProfileBatch: z.number().int().min(1).max(20).optional(),
        }).parse(req.body);
        const result = await genNormalService.submitStoryboardImageBatch(id, body.promptText, body.aspectRatio, body.perJobReferenceImageMediaIdsByProfile, body.appendJobs, body.jobsPerProfileBatch);
        return result;
    });
    // Get jobs for a project (with optional status filter)
    app.get('/api/gen-normal/projects/:id/jobs', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        const { status } = z.object({ status: z.string().optional() }).parse(req.query);
        const allJobs = await genNormalService.getProjectJobs(id);
        // Filter by status if provided
        const filteredJobs = status
            ? allJobs.filter((job) => job.status === status)
            : allJobs;
        return { jobs: filteredJobs };
    });
    // Poll jobs status
    app.get('/api/gen-normal/projects/:id/poll', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        return genNormalService.pollJobs(id);
    });
    // Retry failed job
    app.post('/api/gen-normal/projects/:projectId/jobs/:jobId/retry', async (req) => {
        const { projectId, jobId } = z.object({
            projectId: z.string(),
            jobId: z.string()
        }).parse(req.params);
        return genNormalService.retryJob(projectId, jobId);
    });
    // Cancel job
    app.post('/api/gen-normal/jobs/:jobId/cancel', async (req) => {
        const { jobId } = z.object({ jobId: z.string() }).parse(req.params);
        return genNormalService.cancelJob(jobId);
    });
    // Upsample job (video to 1080p, image to 2K/4K)
    app.post('/api/gen-normal/jobs/:jobId/upsample', async (req) => {
        try {
            const { jobId } = z.object({ jobId: z.string() }).parse(req.params);
            const body = req.body;
            const resolution = body?.resolution;
            return await genNormalService.upsampleJob(jobId, resolution);
        }
        catch (error) {
            const { logger } = await import('../../lib/logger.js');
            logger.error('[GenNormal] Error in upsample endpoint:', error);
            return {
                success: false,
                error: error.message || 'Internal server error'
            };
        }
    });
    // Upsample all completed videos in project
    app.post('/api/gen-normal/projects/:projectId/upsample-all', async (req) => {
        try {
            const { projectId } = z.object({ projectId: z.string() }).parse(req.params);
            const { resolution } = z
                .object({ resolution: z.enum(['2K', '4K', '1080P']).optional() })
                .parse(req.query);
            const result = await genNormalService.upsampleAllJobs(projectId, resolution);
            return result;
        }
        catch (error) {
            const { logger } = await import('../../lib/logger.js');
            logger.error('[GenNormal] Error in upsample-all endpoint:', error);
            return {
                success: false,
                error: error.message || 'Internal server error',
                count: 0
            };
        }
    });
    // Update job (images, mode, etc.)
    app.put('/api/gen-normal/jobs/:jobId', async (req) => {
        const { jobId } = z.object({ jobId: z.string() }).parse(req.params);
        const { mode, startImageMediaId, endImageMediaId, referenceImageMediaIds, prompt, startImagePreviewUrl, endImagePreviewUrl, referenceImagePreviewUrls } = z.object({
            mode: z.string().optional(),
            startImageMediaId: z.string().nullable().optional(),
            endImageMediaId: z.string().nullable().optional(),
            referenceImageMediaIds: z.array(z.string()).nullable().optional(),
            prompt: z.string().optional(),
            startImagePreviewUrl: z.string().nullable().optional(),
            endImagePreviewUrl: z.string().nullable().optional(),
            referenceImagePreviewUrls: z.array(z.object({
                mediaId: z.string(),
                previewUrl: z.string()
            })).nullable().optional()
        }).parse(req.body);
        return genNormalService.updateJob(jobId, {
            mode,
            startImageMediaId,
            endImageMediaId,
            referenceImageMediaIds,
            prompt,
            startImagePreviewUrl,
            endImagePreviewUrl,
            referenceImagePreviewUrls
        });
    });
    // Create jobs batch with already-uploaded mediaIds
    app.post('/api/gen-normal/projects/:id/jobs/batch-with-mediaids', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        const body = z.object({
            jobs: z.array(z.object({
                prompt: z.string(),
                mode: z.enum(['IMAGE_TO_VIDEO', 'FRAME_TO_FRAME', 'REFERENCE_TO_VIDEO']),
                profileId: z.string(),
                jobIndex: z.number().int().min(0),
                batchIndex: z.number().int().min(0).optional(), // Per-job batch override (reuse-all-images preserves source image batches)
                // IMAGE_TO_VIDEO / FRAME_TO_FRAME frames — optional so REFERENCE_TO_VIDEO jobs can omit them
                startImageMediaId: z.string().nullable().optional(), // Allow null for failed uploads
                endImageMediaId: z.string().nullable().optional(),
                startImagePreviewUrl: z.string().nullable().optional(),
                endImagePreviewUrl: z.string().nullable().optional(),
                // REFERENCE_TO_VIDEO per-shot references (1 image/shot for bulk r2v; up to 7 for Omni Flash).
                // .optional() (not .nullable()): absent for non-r2v callers, a real array for r2v — so .min(1) holds.
                referenceImageMediaIds: z.array(z.string()).min(1).max(7).optional(),
                referenceImagePreviewUrls: z.array(z.object({
                    mediaId: z.string(),
                    previewUrl: z.string().nullable(),
                })).nullable().optional(),
            })).min(1), // an empty jobs array is always a client bug — fail fast
            aspectRatio: z.string(),
            videoModelKey: z.string(),
            outputDir: z.string(),
            batchIndex: z.number().int().min(0).optional(), // Fallback batchIndex for jobs that don't specify one
            videoDurationSeconds: videoDurationSecondsSchema,
        }).parse(req.body);
        return genNormalService.createJobsWithMediaIds(id, body);
    });
    // Start generation (validate and queue DRAFT jobs)
    app.post('/api/gen-normal/projects/:id/start-generation', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        const { concurrency, delaySeconds, videoModelKey, imageModelKey, batchSize, videoDurationSeconds } = z.object({
            concurrency: z.number().int().min(1).max(12).optional(),
            batchSize: z.number().int().min(1).max(4).optional(),
            delaySeconds: z.number().int().min(1).max(180).optional(),
            videoModelKey: z.string().optional(),
            imageModelKey: z.string().optional(),
            videoDurationSeconds: videoDurationSecondsSchema,
        }).parse(req.body);
        return genNormalService.startGeneration(id, concurrency, delaySeconds, videoModelKey, batchSize, imageModelKey, videoDurationSeconds);
    });
    // Delete job
    app.delete('/api/gen-normal/jobs/:jobId', async (req) => {
        const { jobId } = z.object({ jobId: z.string() }).parse(req.params);
        return genNormalService.deleteJob(jobId);
    });
    // Pause project
    app.post('/api/gen-normal/projects/:id/pause', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        return genNormalService.pauseProject(id);
    });
    // Resume project
    app.post('/api/gen-normal/projects/:id/resume', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        return genNormalService.resumeProject(id);
    });
    // Stop/cancel project
    app.post('/api/gen-normal/projects/:id/stop', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        return genNormalService.stopProject(id);
    });
    // Cleanup project queue (when user navigates away - cancels QUEUED jobs)
    app.post('/api/gen-normal/projects/:id/cleanup', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        return genNormalService.cleanupProject(id);
    });
    // Cancel ALL active jobs across all projects (called on app shutdown)
    app.post('/api/gen-normal/cancel-all-active', async () => {
        return genNormalService.cancelAllActiveJobs();
    });
    // Retry all failed jobs
    app.post('/api/gen-normal/projects/:id/jobs/retry-all-failed', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        return genNormalService.retryAllFailedJobs(id);
    });
    // Reset captcha/403 throttle for all profiles + requeue jobs stuck behind
    // repeated reCAPTCHA failures. Triggered by the "Reset & tiếp tục" button.
    app.post('/api/gen-normal/projects/:id/reset-captcha', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        return genNormalService.resetCaptchaAndRetry(id);
    });
    // Delete all video jobs (QUEUED, PROCESSING, FAILED) but keep image jobs
    app.delete('/api/gen-normal/projects/:id/jobs/delete-all-video', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        return genNormalService.deleteAllVideoJobs(id);
    });
    // Delete all completed jobs
    app.delete('/api/gen-normal/projects/:id/jobs/delete-all-completed', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        return genNormalService.deleteAllCompletedJobs(id);
    });
    // Merge videos (all or selected). `fileName` (optional) lets batch-export
    // name each output deterministically; omit to keep legacy timestamped name.
    app.post('/api/gen-normal/projects/:id/merge-videos', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        const { outputDir, jobIds, fileName } = z.object({
            outputDir: z.string(),
            jobIds: z.array(z.string()).optional(),
            fileName: z.string().optional()
        }).parse(req.body);
        return genNormalService.mergeVideos(id, outputDir, jobIds, fileName);
    });
    // Merge videos grouped by original "Tạo job" batch (batchIndex). Produces
    // one output file per batch with deterministic naming.
    app.post('/api/gen-normal/projects/:id/merge-videos-by-batch', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        const { outputDir, fileNamePrefix } = z.object({
            outputDir: z.string(),
            fileNamePrefix: z.string().optional()
        }).parse(req.body);
        return genNormalService.mergeVideosByBatch(id, outputDir, fileNamePrefix);
    });
    // Upload image and get mediaId
    app.post('/api/gen-normal/upload-image', async (req) => {
        const body = req.body;
        // Support both imageBase64 and imageData fields for compatibility
        const imageBase64 = body.imageBase64 || body.imageData;
        const { profileId, aspectRatio, projectId } = z.object({
            profileId: z.string().min(1, 'Profile ID is required'),
            aspectRatio: z.string().optional(),
            projectId: z.string().optional() // Optional: to get veo3ProjectId for same profile
        }).parse(req.body);
        if (!imageBase64 || typeof imageBase64 !== 'string' || imageBase64.length === 0) {
            throw new Error('Image data is required (imageBase64 or imageData field)');
        }
        // Extract base64 data if it contains data URL prefix (data:image/...,base64,)
        let cleanBase64 = imageBase64;
        if (imageBase64.includes(',')) {
            const parts = imageBase64.split(',');
            if (parts.length === 2 && parts[0] && parts[0].startsWith('data:image/')) {
                cleanBase64 = parts[1] || imageBase64; // Take only the base64 part after comma, fallback to original if undefined
            }
        }
        const fs = await import('fs/promises');
        const path = await import('path');
        const os = await import('os');
        const { genNormalService } = await import('./genNormal.service.js');
        // Save base64 to temp file
        const tempDir = os.tmpdir();
        const tempFilePath = path.join(tempDir, `upload_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`);
        try {
            const approxBytes = Math.floor((cleanBase64.length * 3) / 4);
            const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
            if (approxBytes > MAX_UPLOAD_BYTES) {
                throw new Error(`Image too large (${Math.round(approxBytes / (1024 * 1024))}MB). Max allowed is 30MB.`);
            }
            // Decode base64 and save to temp file
            const imageBuffer = Buffer.from(cleanBase64, 'base64');
            await fs.writeFile(tempFilePath, imageBuffer);
            // Upload to Veo3 using provider (same profile config as video generation)
            const { mediaId, previewUrl, veo3ProjectId } = await genNormalService.uploadImageAndGetMediaId(tempFilePath, profileId, aspectRatio, projectId // Pass projectId to get veo3ProjectId for same profile
            );
            // Clean up temp file
            await fs.unlink(tempFilePath).catch(() => { });
            // previewUrl is now local file path, convert to file:// URL for Electron
            const localFileUrl = previewUrl ? `file://${previewUrl}` : null;
            return { success: true, mediaId, previewUrl: localFileUrl, veo3ProjectId };
        }
        catch (error) {
            // Clean up temp file on error
            await fs.unlink(tempFilePath).catch(() => { });
            // Log error for debugging
            logger.error('[GenNormal] Upload image error:', error);
            // Parse error message to get user-friendly message
            const { parseVeo3Error } = await import('../../services/veo3/veo3ErrorHandler.js');
            const errorMessage = error?.errorText
                ? parseVeo3Error(error.errorText, error?.message || 'Failed to upload image')
                : (error?.message || 'Failed to upload image');
            // Return error response instead of throwing
            return {
                success: false,
                error: errorMessage,
                mediaId: null,
                previewUrl: null
            };
        }
    });
    // Delete media from Veo3 cloud
    app.post('/api/gen-normal/delete-media', async (req) => {
        const { mediaIds, profileId } = z.object({
            mediaIds: z.array(z.string()).min(1, 'At least one media ID is required'),
            profileId: z.string().min(1, 'Profile ID is required')
        }).parse(req.body);
        const { genNormalService } = await import('./genNormal.service.js');
        const success = await genNormalService.deleteMedia(mediaIds, profileId);
        return { success, deletedCount: mediaIds.length };
    });
    // Refresh expired signed result URL from mediaId. Errors: EXPIRED_COOKIES
    // (profile cần login lại), MEDIA_DELETED (Google đã xóa media), REFRESH_FAILED.
    app.post('/api/gen-normal/jobs/:jobId/refresh-url', async (req) => {
        const { jobId } = z.object({ jobId: z.string().min(1) }).parse(req.params);
        return genNormalService.refreshJobResultUrl(jobId);
    });
    // Ảnh "đen" sau upscale: quét job có resultUrl trỏ vào file local không phải
    // ảnh (di chứng của lỗi nhận nhầm prompt thành base64 ảnh).
    app.post('/api/gen-normal/projects/:projectId/scan-corrupt-upscale', async (req) => {
        const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);
        return genNormalService.scanCorruptUpscale(projectId);
    });
    // Lấy lại link ảnh gốc từ Google cho các job nói trên. Không gen lại, không
    // tốn credit.
    app.post('/api/gen-normal/projects/:projectId/rescue-corrupt-upscale', async (req) => {
        const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);
        return genNormalService.rescueCorruptUpscale(projectId);
    });
    // Download file to folder
    app.post('/api/gen-normal/download-file', async (req) => {
        const { url, folderPath, filename, jobId } = z.object({
            url: z.string().min(1), // Accept both HTTP URL and file path
            folderPath: z.string().min(1, 'Thư mục lưu video là bắt buộc'),
            // Reject path separators / traversal so a crafted filename can't escape
            // the chosen output directory.
            filename: z.string().min(1, 'Tên file là bắt buộc').regex(/^[^/\\]+$/, 'Tên file không hợp lệ'),
            // Khi có jobId: server tự ghi downloadedAt/lastDownloadError vào job —
            // nguồn sự thật cho auto-download dedup và filter "Thiếu file".
            jobId: z.string().optional()
        }).parse(req.body);
        // Validate output directory (not default value)
        if (!folderPath || folderPath.trim() === '' || folderPath === 'D:/NOI CHUA VIDEO/1') {
            throw new Error('Vui lòng chọn thư mục lưu video trước khi tải');
        }
        const { downloadFile } = await import('../../utils/fileDownloader.js');
        const path = await import('path');
        const fs = await import('fs/promises');
        // Use the path user selected directly (no conversion)
        const finalFolderPath = path.isAbsolute(folderPath)
            ? folderPath
            : path.resolve(folderPath);
        // Collision-safe path: custom naming rules can produce duplicate names
        // (two jobs sharing the same prompt token). Append _2, _3… so a second
        // file never silently overwrites the first.
        //
        // NOTE: TOCTOU race — two simultaneous requests for the same name can both
        // reach fs.access → ENOENT and proceed to write. The window is < 1ms and
        // this is a single-user desktop tool, so we accept it. To eliminate it
        // entirely, use a per-directory async mutex or rename-to-temp-then-rename.
        const resolveUniqueOutputPath = async (dir, name) => {
            const parsed = path.parse(name);
            let candidate = path.join(dir, name);
            let counter = 2;
            while (counter <= 999) {
                try {
                    await fs.access(candidate);
                    candidate = path.join(dir, `${parsed.name}_${counter}${parsed.ext}`);
                    counter++;
                }
                catch (err) {
                    if (err?.code === 'ENOENT')
                        break; // does not exist → use it
                    throw err; // permission/network error → surface
                }
            }
            if (counter > 999) {
                throw new Error(`Quá nhiều file cùng tên "${name}" trong thư mục`);
            }
            return candidate;
        };
        const outputPath = await resolveUniqueOutputPath(finalFolderPath, filename);
        const { prisma } = await import('../../lib/prisma.js');
        // Tracking best-effort: job có thể đã bị xóa — không được chặn việc tải file.
        const trackJob = async (data) => {
            if (!jobId)
                return;
            try {
                await prisma.genNormalJob.update({ where: { id: jobId }, data });
            }
            catch {
                /* job deleted — ignore */
            }
        };
        try {
            // Check if url is a local file path or HTTP URL
            if (url.startsWith('http://') || url.startsWith('https://')) {
                // Download from HTTP URL
                await downloadFile(url, outputPath);
            }
            else {
                // Copy from local file path (for upsampled images)
                await fs.copyFile(url, outputPath);
            }
        }
        catch (err) {
            // Chỉ đếm attempt khi FAIL: cùng một lượt tải mà refresh-link rồi thử lại
            // sẽ không bị tính 2 lần, và trần downloadAttempts>=3 = đúng 3 lần hỏng.
            await trackJob({
                downloadAttempts: { increment: 1 },
                lastDownloadError: String(err?.message || err).slice(0, 300),
            });
            throw err;
        }
        await trackJob({ downloadedAt: new Date(), lastDownloadError: null });
        return { success: true, filePath: outputPath };
    });
    // Edit image - create new job to edit an existing image
    app.post('/api/gen-normal/jobs/:jobId/edit-image', async (req) => {
        const { jobId } = z.object({ jobId: z.string() }).parse(req.params);
        const { editPrompt } = z.object({
            editPrompt: z.string().min(1, 'Edit prompt is required')
        }).parse(req.body);
        return genNormalService.editImage(jobId, editPrompt);
    });
    // Reuse video - create new job with same configuration but new prompt
    app.post('/api/gen-normal/jobs/:jobId/reuse-video', async (req) => {
        const { jobId } = z.object({ jobId: z.string() }).parse(req.params);
        const { newPrompt } = z.object({
            newPrompt: z.string().min(1, 'New prompt is required')
        }).parse(req.body);
        return genNormalService.reuseVideo(jobId, newPrompt);
    });
    // Cleanup stuck PROCESSING jobs (admin/debug tool)
    app.post('/api/gen-normal/cleanup-stuck-jobs', async () => {
        return genNormalService.cleanupStuckJobs();
    });
    // Get credits and paygate tier for a project
    app.get('/api/gen-normal/projects/:id/credits', async (req, reply) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        try {
            return await genNormalService.getCredits(id);
        }
        catch (err) {
            const status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
            return reply.code(status).send({
                error: err?.message ?? 'Failed to load credits',
            });
        }
    });
}
