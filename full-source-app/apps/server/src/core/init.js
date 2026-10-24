/**
 * Core System Initialization
 * Initialize queue manager and register Veo3 job handlers.
 */
import { queueManager } from './queue/SQLiteQueueManager.js';
import { logger } from '../lib/logger.js';
import { JobType } from './jobs/JobTypes.js';
import { GenNormalJobHandler, VideoUpsamplingHandler, ImageUpsamplingHandler, } from './queue/handlers/index.js';
import { genNormalStatusPoller } from './queue/GenNormalStatusPoller.js';
import { genNormalQueueManager } from '../modules/genNormal/genNormalQueueManager.js';
import { warmUpTlsClient } from '../lib/tlsClient.js';
import { workflowService } from '../modules/workflow/workflow.service.js';
import { workflowBatchOrchestrator } from '../modules/workflow/workflow.batch.orchestrator.js';
export async function initializeCoreSystem() {
    logger.info('[Core] Initializing core system');
    try {
        // Warm-up node-tls-client ngay từ đầu (background) — tải shared library + initTLS
        // trước khi user submit, tránh độ trễ lần đầu. Fire-and-forget, không chặn boot.
        warmUpTlsClient();
        queueManager.registerHandler(JobType.GEN_NORMAL, new GenNormalJobHandler());
        queueManager.registerHandler(JobType.VIDEO_UPSAMPLING, new VideoUpsamplingHandler());
        queueManager.registerHandler(JobType.IMAGE_UPSAMPLING, new ImageUpsamplingHandler());
        logger.info('[Core] Job handlers registered');
        await queueManager.start();
        genNormalStatusPoller.start();
        await genNormalQueueManager.restoreState();
        // Resume interrupted workflow/batch runs. This is best-effort: a missing or
        // out-of-sync workflow schema (e.g. dev.db that never had `prisma db push`)
        // must NOT take down the whole server — degrade to a warning and continue.
        await workflowService
            .rehydrateRunningRuns()
            .catch((err) => logger.warn('[Core] Workflow rehydrate skipped:', err));
        await workflowBatchOrchestrator
            .rehydrate()
            .catch((err) => logger.warn('[Core] Batch rehydrate skipped:', err));
        logger.info('[Core] Core system initialized successfully');
    }
    catch (error) {
        logger.error('[Core] Failed to initialize core system:', error);
        throw error;
    }
}
export async function shutdownCoreSystem() {
    logger.info('[Core] Shutting down core system');
    try {
        genNormalStatusPoller.stop();
        await queueManager.stop();
        logger.info('[Core] Core system shutdown complete');
    }
    catch (error) {
        logger.error('[Core] Error during shutdown:', error);
        throw error;
    }
}
