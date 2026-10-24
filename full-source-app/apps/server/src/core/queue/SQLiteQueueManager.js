/**
 * SQLite Queue Manager
 * Unified queue system replacing JobScheduler, JobQueueManager, and GenNormalQueueManager
 * All state persisted to SQLite for reliability
 */
import os from 'os';
import { prisma } from '../../lib/prisma.js';
import { EventEmitter } from 'events';
import { logger } from '../../lib/logger.js';
import { veoProfileManager } from '../veo/VeoProfileManager.js';
import { JobType } from '../jobs/JobTypes.js';
/**
 * Tính global concurrency cap từ RAM vật lý.
 *
 * Mỗi job hiện chỉ là 1 HTTP submit + captcha mint qua Chrome extension
 * (chi phí thực ~10-20MB peak/job), không còn BrowserWindow per-job như trước.
 * Vẫn dùng `perJobMB=300` như guard rail bảo thủ — máy 16GB vẫn ra ~40,
 * 32GB ra ~95. Floor 5, ceiling 10 × perProfileCap.
 * Override env: MAX_CONCURRENT_GLOBAL.
 */
function computeGlobalConcurrency(perProfileCap) {
    const override = Number(process.env.MAX_CONCURRENT_GLOBAL);
    if (Number.isFinite(override) && override > 0) {
        return Math.min(10 * perProfileCap, Math.max(1, Math.floor(override)));
    }
    const totalMemMB = os.totalmem() / 1024 / 1024;
    const reserveMB = 4 * 1024;
    const perJobMB = 300;
    const usableMB = Math.max(0, totalMemMB - reserveMB);
    const byRam = Math.floor(usableMB / perJobMB);
    const hardCeiling = 10 * perProfileCap;
    return Math.min(hardCeiling, Math.max(5, byRam));
}
export class SQLiteQueueManager extends EventEmitter {
    constructor() {
        super();
        this.isRunning = false;
        this.pollInterval = null;
        this.activeJobs = new Map();
        this.handlers = new Map();
        this._lastStuckLog = 0;
        // Configuration (can be adjusted)
        this.POLL_INTERVAL_MS = 1000;
        this.MAX_CONCURRENT_PER_PROFILE = 20; // Video max 20, Image max 10 (enforced by frontend)
        this.MAX_CONCURRENT_GLOBAL = computeGlobalConcurrency(20);
        const totalGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
        logger.info(`[SQLiteQueue] 🧠 Concurrency: global=${this.MAX_CONCURRENT_GLOBAL}, perProfile=${this.MAX_CONCURRENT_PER_PROFILE} (RAM=${totalGB}GB)`);
    }
    /**
     * Register a job handler for a specific job type
     */
    registerHandler(type, handler) {
        this.handlers.set(type, handler);
        logger.info(`[SQLiteQueue] Registered handler for ${type}`, {
            handlerType: handler.constructor.name
        });
    }
    /**
     * Get handler for a job type
     */
    getHandler(type) {
        return this.handlers.get(type);
    }
    /**
     * Start the queue processor
     */
    async start() {
        if (this.isRunning) {
            logger.info('[SQLiteQueue] Already running');
            return;
        }
        this.isRunning = true;
        logger.info('[SQLiteQueue] Starting queue manager');
        // Recover interrupted jobs on startup (with retry for database connection)
        try {
            await this.recoverInterruptedJobs();
        }
        catch (error) {
            // If database is not ready, log warning and continue
            // This can happen on first run when database is still being initialized
            logger.warn('[SQLiteQueue] Could not recover interrupted jobs (database may not be ready):', error.message);
            logger.info('[SQLiteQueue] Will retry recovery on next poll cycle');
        }
        // Start polling loop
        this.pollInterval = setInterval(() => {
            this.processQueue().catch(err => {
                logger.error('[SQLiteQueue] Process error:', err);
            });
        }, this.POLL_INTERVAL_MS);
        this.emit('started');
        logger.info('[SQLiteQueue] Queue manager started');
    }
    /**
     * Stop the queue processor
     */
    async stop() {
        logger.info('[SQLiteQueue] Stopping queue manager');
        this.isRunning = false;
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        // Wait for active jobs to complete (with timeout)
        const timeout = 30000; // 30 seconds
        const start = Date.now();
        while (this.activeJobs.size > 0 && Date.now() - start < timeout) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        logger.info('[SQLiteQueue] Stopped', { remainingJobs: this.activeJobs.size });
        this.emit('stopped');
    }
    /**
     * Add job to queue
     */
    async addJob(job) {
        const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await prisma.queueJob.create({
            data: {
                id: jobId,
                type: job.type,
                status: 'queued',
                priority: job.priority,
                profileId: job.profileId || null,
                data: JSON.stringify(job.data),
                attempts: 0,
                maxAttempts: job.maxAttempts,
                createdAt: new Date(),
            }
        });
        logger.info(`[SQLiteQueue] Job added: ${jobId}`, {
            type: job.type,
            profileId: job.profileId,
        });
        this.emit('job:added', jobId);
        return jobId;
    }
    /**
     * Main queue processing loop
     */
    async processQueue() {
        if (!this.isRunning)
            return;
        // Check global concurrency
        if (this.activeJobs.size >= this.MAX_CONCURRENT_GLOBAL) {
            // Log periodically when stuck (every 30 seconds)
            if (!this._lastStuckLog || Date.now() - this._lastStuckLog > 30000) {
                this._lastStuckLog = Date.now();
                logger.warn(`[SQLiteQueue] ⚠️ Queue blocked: activeJobs=${this.activeJobs.size}/${this.MAX_CONCURRENT_GLOBAL}`, {
                    activeJobIds: Array.from(this.activeJobs.keys()).slice(0, 5)
                });
            }
            return;
        }
        // Fetch queued jobs with priority sorting
        const slotsAvailable = this.MAX_CONCURRENT_GLOBAL - this.activeJobs.size;
        // Use raw query to compare attempts < maxAttempts (Prisma doesn't support field comparison)
        const availableJobs = await prisma.$queryRaw `
      SELECT * FROM QueueJob
      WHERE status = 'queued' AND attempts < maxAttempts
      ORDER BY priority ASC, createdAt ASC
      LIMIT ${slotsAvailable}
    `;
        for (const dbJob of availableJobs) {
            // Use VeoProfileManager to check if profile can acquire slot
            if (dbJob.profileId) {
                const canAcquire = await veoProfileManager.acquireSlot(dbJob.profileId, dbJob.type);
                if (!canAcquire) {
                    // Log periodically when jobs stuck due to slot
                    if (!this._lastStuckLog || Date.now() - this._lastStuckLog > 30000) {
                        this._lastStuckLog = Date.now();
                        logger.warn(`[SQLiteQueue] ⚠️ Job ${dbJob.id} skipped: acquireSlot returned false for profile ${dbJob.profileId?.substring(0, 8)}...`);
                    }
                    continue; // Profile at max capacity or rate limited
                }
            }
            // Handler-level pre-check: skip jobs that can't be processed yet (e.g. profile batch full)
            const handler = this.handlers.get(dbJob.type);
            if (handler?.canProcess) {
                try {
                    const canProcess = await handler.canProcess(dbJob);
                    if (!canProcess) {
                        // Release profile slot since we're skipping
                        if (dbJob.profileId) {
                            await veoProfileManager.releaseSlot(dbJob.profileId);
                        }
                        // Log periodically when jobs stuck due to canProcess
                        if (!this._lastStuckLog || Date.now() - this._lastStuckLog > 30000) {
                            this._lastStuckLog = Date.now();
                            logger.warn(`[SQLiteQueue] ⚠️ Job ${dbJob.id} skipped: canProcess returned false (type=${dbJob.type}, profile=${dbJob.profileId?.substring(0, 8)}...)`);
                        }
                        continue; // Leave as queued, don't increment attempts
                    }
                }
                catch (err) {
                    // On error, skip safely
                    if (dbJob.profileId) {
                        await veoProfileManager.releaseSlot(dbJob.profileId);
                    }
                    continue;
                }
            }
            // Mark as processing (atomic)
            const updated = await this.tryMarkProcessing(dbJob.id);
            if (!updated) {
                // Already taken - release profile slot
                if (dbJob.profileId) {
                    await veoProfileManager.releaseSlot(dbJob.profileId);
                }
                continue;
            }
            // Convert to QueueJob
            const job = this.dbJobToQueueJob(updated);
            // Add to active jobs
            this.activeJobs.set(job.id, job);
            // Process job asynchronously (don't await)
            this.processJob(job).catch(err => {
                logger.error(`[SQLiteQueue] Job ${job.id} unexpected error:`, err);
            });
        }
    }
    /**
     * Try to mark job as processing (atomic)
     */
    async tryMarkProcessing(jobId) {
        try {
            const result = await prisma.$transaction(async (tx) => {
                const current = await tx.queueJob.findUnique({ where: { id: jobId } });
                if (!current || current.status !== 'queued') {
                    return null;
                }
                return await tx.queueJob.update({
                    where: { id: jobId },
                    data: {
                        status: 'processing',
                        startedAt: new Date(),
                        attempts: { increment: 1 }
                    }
                });
            });
            return result;
        }
        catch (error) {
            logger.error(`[SQLiteQueue] Failed to mark job as processing: ${jobId}`, error);
            return null;
        }
    }
    /**
     * Process a single job
     */
    async processJob(job) {
        try {
            logger.info(`[SQLiteQueue] Processing job ${job.id}`, {
                type: job.type,
                attempt: job.attempts
            });
            // Emit event for monitoring
            this.emit('job:started', job.id, job);
            // Get handler for job type
            const handler = this.handlers.get(job.type);
            if (!handler) {
                throw new Error(`No handler registered for job type: ${job.type}`);
            }
            // Execute using handler
            const result = await handler.execute(job);
            // Mark as completed
            await prisma.queueJob.update({
                where: { id: job.id },
                data: {
                    status: 'completed',
                    completedAt: new Date(),
                    result: JSON.stringify(result)
                }
            });
            // Release profile slot
            if (job.profileId) {
                await veoProfileManager.releaseSlot(job.profileId);
            }
            this.activeJobs.delete(job.id);
            this.emit('job:completed', job.id, result);
            logger.info(`[SQLiteQueue] Job ${job.id} completed`);
        }
        catch (error) {
            // Check if should retry using handler
            const handler = this.handlers.get(job.type);
            const shouldRetry = handler?.canRetry(job, error) ?? (job.attempts < job.maxAttempts);
            // Check if this is a transient wait error (like BATCH_WAIT) that shouldn't count as a real attempt
            const isTransientWait = handler?.isTransientWait?.(error) ?? false;
            if (isTransientWait) {
                // Transient wait: don't count as an attempt, use longer delay, log as info not error
                const delayMs = handler?.getRetryDelay(job.attempts) ?? 10000;
                logger.info(`[SQLiteQueue] Job ${job.id} waiting (transient, attempt not counted): ${error.message}. Retry in ${delayMs}ms`);
                setTimeout(async () => {
                    try {
                        await prisma.queueJob.update({
                            where: { id: job.id },
                            data: {
                                status: 'queued',
                                // Reset attempts so it doesn't get filtered by attempts < maxAttempts query
                                attempts: { decrement: 1 },
                                error: error.message || String(error)
                            }
                        });
                    }
                    catch (requeueError) {
                        logger.error(`[SQLiteQueue] Failed to requeue transient job ${job.id}:`, requeueError);
                    }
                }, delayMs);
            }
            else if (shouldRetry) {
                const { briefVeo3Error } = await import('../../services/veo3/veo3ErrorHandler.js');
                const brief = briefVeo3Error(error);
                const brief_has_any = brief.code != null || brief.status != null || brief.reason != null;
                if (brief_has_any) {
                    logger.error(`[SQLiteQueue] Job ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}): ${error?.message ?? error}`, brief);
                }
                else {
                    logger.error(`[SQLiteQueue] Job ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}): ${error?.message ?? error}`);
                }
                // Get retry delay from handler (pass error for type-specific delays like 503)
                const delayMs = handler?.getRetryDelay(job.attempts, error) ?? Math.pow(2, job.attempts) * 1000;
                logger.info(`[SQLiteQueue] Requeuing job ${job.id} with ${delayMs}ms delay (attempt ${job.attempts + 1}/${job.maxAttempts})`);
                setTimeout(async () => {
                    try {
                        await prisma.queueJob.update({
                            where: { id: job.id },
                            data: {
                                status: 'queued',
                                error: error.message || String(error)
                            }
                        });
                        logger.info(`[SQLiteQueue] Job ${job.id} requeued`);
                    }
                    catch (requeueError) {
                        logger.error(`[SQLiteQueue] Failed to requeue job ${job.id}:`, requeueError);
                    }
                }, delayMs);
            }
            else {
                // Mark as failed permanently
                await prisma.queueJob.update({
                    where: { id: job.id },
                    data: {
                        status: 'failed',
                        completedAt: new Date(),
                        error: error.message || String(error)
                    }
                });
                this.emit('job:failed', job.id, error);
                logger.error(`[SQLiteQueue] Job ${job.id} failed permanently after ${job.attempts} attempts`);
            }
            // Release profile slot on failure
            if (job.profileId) {
                await veoProfileManager.releaseSlot(job.profileId);
            }
            this.activeJobs.delete(job.id);
        }
    }
    // Note: Job execution is now handled by registered handlers
    // See handlers/ directory for implementations
    // Note: Profile concurrency and rate limiting are now handled by VeoProfileManager
    /**
     * Recover jobs that were interrupted (e.g., app crash)
     */
    async recoverInterruptedJobs() {
        // Cancel orphaned upsampling queue jobs whose GenNormalJob no longer exists or is CANCELLED
        try {
            const pendingUpsamplingJobs = await prisma.queueJob.findMany({
                where: {
                    type: { in: ['video-upsampling', 'image-upsampling'] },
                    status: { in: ['queued', 'processing'] }
                }
            });
            let orphanedCount = 0;
            for (const qj of pendingUpsamplingJobs) {
                try {
                    const data = JSON.parse(qj.data);
                    if (data.genNormalJobId) {
                        const genJob = await prisma.genNormalJob.findUnique({
                            where: { id: data.genNormalJobId },
                            select: { status: true }
                        });
                        // Cancel if GenNormalJob is missing, cancelled, or already completed
                        if (!genJob || genJob.status === 'CANCELLED' || genJob.status === 'COMPLETED' || genJob.status === 'FAILED') {
                            await prisma.queueJob.update({
                                where: { id: qj.id },
                                data: { status: 'cancelled', completedAt: new Date() }
                            });
                            orphanedCount++;
                        }
                    }
                }
                catch { /* skip parse errors */ }
            }
            if (orphanedCount > 0) {
                logger.info(`[SQLiteQueue] Cancelled ${orphanedCount} orphaned upsampling queue jobs on startup`);
            }
        }
        catch (e) {
            logger.warn(`[SQLiteQueue] Failed to cleanup orphaned upsampling jobs: ${e.message}`);
        }
        // Reset processing → queued (crashed mid-execution).
        // Cancel any orphan job whose type lacks a registered handler — guards
        // against stale rows from deleted job types (farm-video, video-generation,
        // image-generation, frame-extraction, batch-generation, ai-generation).
        const registered = Array.from(this.handlers.keys());
        const orphans = await prisma.queueJob.updateMany({
            where: {
                status: { in: ['queued', 'processing'] },
                type: { notIn: registered },
            },
            data: { status: 'cancelled', error: 'Job type deprecated', completedAt: new Date() },
        });
        if (orphans.count > 0) {
            logger.info(`[SQLiteQueue] Cancelled ${orphans.count} orphan jobs with deprecated types`);
        }
        const interruptedJobs = await prisma.queueJob.updateMany({
            where: { status: 'processing', type: { in: registered } },
            data: { status: 'queued' }
        });
        if (interruptedJobs.count > 0) {
            logger.info(`[SQLiteQueue] Recovered ${interruptedJobs.count} interrupted jobs`);
        }
        // Reset attempts for queued jobs that exhausted retries — gives them a
        // fresh chance since the failure may have been transient (e.g. crash mid-poll).
        const stuckJobs = await prisma.$executeRaw `
      UPDATE QueueJob
      SET attempts = 0
      WHERE status = 'queued' AND attempts >= maxAttempts
    `;
        if (stuckJobs > 0) {
            logger.info(`[SQLiteQueue] Reset attempts for ${stuckJobs} stuck queued jobs`);
        }
    }
    dbJobToQueueJob(dbJob) {
        return {
            id: dbJob.id,
            type: dbJob.type,
            status: dbJob.status,
            priority: dbJob.priority,
            profileId: dbJob.profileId || undefined,
            data: JSON.parse(dbJob.data),
            attempts: dbJob.attempts,
            maxAttempts: dbJob.maxAttempts,
            result: dbJob.result ? JSON.parse(dbJob.result) : undefined,
            error: dbJob.error || undefined,
            createdAt: dbJob.createdAt,
            startedAt: dbJob.startedAt || undefined,
            completedAt: dbJob.completedAt || undefined,
        };
    }
}
// Singleton instance
export const queueManager = new SQLiteQueueManager();
