import { hydrateStoryPayload } from './lib/storyScenes.js';
import { saveStoryResults } from './lib/storyResults.js';
/**
 * Batch orchestrator (singleton, server-side).
 *
 * Runs one workflow template across N rows. Each selected profile becomes a
 * worker running up to rowsPerProfile (1-3) concurrent lanes, each pulling rows
 * off a SHARED queue (atomic DB claim). A row = one WorkflowRun (its own veo3
 * project). When a run
 * completes, the marked output node's media is downloaded into the batch's
 * output folder. The whole run is NEVER retried here — per-node auto-retry lives
 * in the engine; the orchestrator only schedules, polls and downloads.
 */
import path from 'node:path';
import { profileImageScheduler } from '../../lib/profileImageScheduler.js';
import { batchProfileSlots, flowProfileUnavailable } from './lib/profileJobSlots.js';
import { createHash } from 'node:crypto';
import { imagePaths } from './lib/imageInputs.js';
import { loadBatchParallel, saveBatchParallel } from './workflow.batch.repository.js';
import { singleImageWorkflow, normalizeParallel, batchProductLanes, defaultImagesPerProduct } from './lib/imageGenerationQueue.js';
import { assertContentReviewRetry, needsContentReview, contentReviewMessage } from './lib/contentReview.js';
import { saveMediaBundle } from './lib/saveMedia.js';
import { stat } from 'node:fs/promises';
import { logger } from '../../lib/logger.js';
import { workflowRepository } from './workflow.repository.js';
import { workflowService } from './workflow.service.js';
import { workflowBatchRepository } from './workflow.batch.repository.js';
import { extractBatchSchema } from './workflow.batch.schema.js';
const POLL_INTERVAL_MS = 1000;
const RUN_DEADLINE_MS = 40 * 60 * 1000; // safety cap per row
const CANCEL_GRACE_MS = 5 * 60 * 1000; // max wait after a cancel before abandoning
const TERMINAL_RUN = ['COMPLETED', 'FAILED', 'CANCELLED'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ── Filename + media helpers ─────────────────────────────────────────────────
function padRow(rowIndex) {
    return String(rowIndex + 1).padStart(3, '0');
}
/** Derive a file extension from a media url, falling back by kind. */
function extFromUrl(url, kind) {
    const clean = url.split('?')[0]?.split('#')[0] ?? '';
    const m = clean.match(/\.([a-z0-9]{2,4})$/i);
    if (m)
        return `.${m[1].toLowerCase()}`;
    return kind === 'image' ? '.png' : '.mp4';
}
function safeKey(key) {
    return key.replace(/[^\w-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'out';
}
// ── Orchestrator ─────────────────────────────────────────────────────────────
async function definitionForBatch(batch) {
    const items = await workflowBatchRepository.listItems(batch.id);
    for (const value of Object.values(items[0]?.inputValues || {})) {
        try {
            const payload = JSON.parse(value);
            if (payload?.snapshotPath && payload?.sceneId) return (await hydrateStoryPayload(payload)).snapshot.definition;
        } catch (error) {
            if (String(value).includes('snapshotPath')) throw error;
        }
    }
    return workflowRepository.getWorkflow(batch.workflowId);
}
const activeBatches = new Map();
export const workflowBatchOrchestrator = {
    profileIssues(batchId) {
        return Object.fromEntries(activeBatches.get(batchId)?.blockedProfiles ?? []);
    },
    isRunning(batchId) {
        return activeBatches.has(batchId);
    },
    /**
     * Validate + start a batch. Resolves once workers are dispatched (fire and
     * forget); throws synchronously on invalid input so the route can 400.
     */
    async startBatch(batchId, aiCreds, parallelSettings) {
        if (activeBatches.has(batchId)) {
            throw new Error('Batch đang chạy rồi');
        }
        const batch = await workflowBatchRepository.getBatch(batchId);
        if (!batch)
            throw new Error(`Batch not found: ${batchId}`);
        if (!['PENDING','PAUSED'].includes(batch.status)) {
            throw new Error(`Batch không ở trạng thái PENDING (hiện tại: ${batch.status})`);
        }
        const def = await definitionForBatch(batch);
        if (!def)
            throw new Error(`Workflow not found: ${batch.workflowId}`);
        if(parallelSettings){
            if(!singleImageWorkflow(def))throw Error('Cấu hình đa luồng chỉ dùng cho workflow một ảnh/job.');
            batch.parallelSettings=normalizeParallel({...parallelSettings,imagesPerProduct:parallelSettings.imagesPerProduct??defaultImagesPerProduct(def)});
            await saveBatchParallel(batchId,batch.parallelSettings);
            batch.rowsPerProfile=batch.parallelSettings.concurrency;
        }
        const schema = extractBatchSchema(def);
        if (schema.inputs.length === 0) {
            throw new Error('Workflow chưa đánh dấu node input nào (Prompt / Upload ảnh)');
        }
        if (schema.outputs.length === 0) {
            throw new Error('Workflow chưa đánh dấu node output nào (Video / Merge / Result)');
        }
        if (batch.profileIds.length === 0) {
            throw new Error('Chưa chọn profile nào để chạy');
        }
        const { missing } = await workflowBatchRepository.validateProfileIds(batch.profileIds);
        if (missing.length > 0) {
            throw new Error(`Không tìm thấy ${missing.length} profile đã chọn. Hãy cập nhật lại batch trước khi chạy.`);
        }
        for (const profileId of batch.profileIds) profileImageScheduler.resume(profileId);
        if(batch.status==='PAUSED')await workflowBatchRepository.resetRunningItems(batchId);
        // Reserve the batch (state owns the cancel flag + in-flight run ids) BEFORE
        // going RUNNING so isRunning() is true the instant the pool is dispatched.
        const state = { cancelled: false, runIds: new Set() };
        activeBatches.set(batchId, state);
        await workflowBatchRepository.updateBatchStatus(batchId, 'RUNNING', null);
        // Fire-and-forget the worker pool; the route returns immediately.
        void this.runBatch(batch, def, schema, aiCreds, state).catch((err) => {
            logger.error(`[BatchOrchestrator] batch ${batchId} crashed:`, err);
        });
    },
    /**
     * Internal: spin up one worker per profile over a shared queue, then finalize.
     * `state` is created + registered in `activeBatches` by the caller (startBatch /
     * retryItem / rehydrate) so isRunning() is true before dispatch.
     */
    async runBatch(batch, def, schema, aiCreds, state) {
        // Keep the live objects on state so settings saved while PAUSED can be
        // applied to future rows without touching rows already in progress.
        state.batch = batch;
        state.definition = def;
        if(singleImageWorkflow(def)){
            const stored=await loadBatchParallel(batch.id);
            batch.parallelSettings=stored?normalizeParallel({...stored,imagesPerProduct:stored.imagesPerProduct??defaultImagesPerProduct(def)}):null;
        }
        logger.info(`[BatchOrchestrator] batch ${batch.id} start — ${batch.profileIds.length} profile(s), ` +
            `${batchProductLanes(batch, def)} lane(s)/profile`);
        state.blockedProfiles ??= new Map();
        try {
            // Drain the shared queue, then re-check for new PENDING items and dispatch
            // again if any appeared — a row reset by retryItem while the pool was still
            // alive (its lanes already drained) would otherwise never run and finalize
            // would miscount. Normal runs execute the body once (pending → 0) and exit.
            let guard = 0;
            do {
                await Promise.all(batch.profileIds.map((profileId) => this.runProfileWorker(batch, def, schema, profileId, state, aiCreds)));
                if (batch.profileIds.every(id => state.blockedProfiles.has(id))) {
                    if (state.verificationRequired) break;
                    await workflowBatchRepository.failPendingItems(batch.id,
                        '[PROFILE_UNAVAILABLE] Tất cả profile đã dừng nhận job. Kiểm tra tài khoản rồi thử lại.');
                    break;
                }
                if (++guard > 50) {
                    logger.warn(`[BatchOrchestrator] batch ${batch.id} drain loop cap reached`);
                    break;
                }
            } while (!state.cancelled &&
                (await workflowBatchRepository.countItemsByStatus(batch.id)).pending > 0);
        }
        finally {
            // A throw here must NOT skip the activeBatches cleanup, or the batch becomes
            // a zombie (isRunning forever, /start permanently rejected). Force FAILED if
            // finalize itself fails, then always deregister.
            try {
                await this.finalizeBatch(batch.id, state);
            }
            catch (err) {
                logger.error(`[BatchOrchestrator] finalize ${batch.id} failed — forcing FAILED:`, err);
                await workflowBatchRepository
                    .updateBatchStatus(batch.id, 'FAILED', 'Lỗi nội bộ khi tổng kết batch')
                    .catch(() => { });
            }
            finally {
                activeBatches.delete(batch.id);
            }
        }
    },
    /**
     * One profile runs `rowsPerProfile` (1-3) concurrent lanes over the shared
     * queue. claimNextItem is atomic, so lanes never claim the same row.
     */
    async runProfileWorker(batch, def, schema, profileId, state, aiCreds) {
        const lanes = singleImageWorkflow(def) ? 8 : batchProductLanes(batch, def);
        const control = { drained: false };
        await Promise.all(Array.from({ length: lanes }, (_, laneIndex) => this.runProfileLane(batch, def, schema, profileId, state, aiCreds, laneIndex, control)));
    },
    /** One lane pulls rows off the shared queue until it drains (or cancel). */
    async runProfileLane(batch, def, schema, profileId, state, aiCreds, laneIndex = 0, control = { drained: false }) {
        while (!state.cancelled && !control.drained && !state.blockedProfiles?.has(profileId)) {
            while((state.paused || laneIndex >= batchProductLanes(batch, def)) && !state.cancelled && !control.drained && !state.blockedProfiles?.has(profileId))await sleep(100);
            if(state.cancelled || control.drained || state.blockedProfiles?.has(profileId))return;
            const release = await batchProfileSlots.acquire(profileId,
                () => state.cancelled || state.paused || state.blockedProfiles?.has(profileId), batchProductLanes(batch,def));
            if (!release) { if(state.paused&&!state.cancelled)continue; return; }
            try {
                if (state.cancelled || state.blockedProfiles?.has(profileId)) return;
                if(state.paused)continue;
                let item;
                try {
                    item = await workflowBatchRepository.claimNextItem(batch.id, profileId);
                } catch (error) {
                    logger.error(`[BatchOrchestrator] claim failed (${profileId}):`, error);
                    return;
                }
                if (!item) { control.drained = true; return; }
                try {
                    await this.processItem(batch, def, schema, item, profileId, state, aiCreds);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    await workflowBatchRepository.failItem(item.id, 'ERROR', message).catch(dbError => {
                        logger.error(`[BatchOrchestrator] failItem ${item.id}:`, dbError);
                    });
                }
            } finally {
                release();
            }
        }
    },

    /** Run one row end-to-end: start run → poll → download outputs → persist. */
    async processItem(batch, def, schema, item, profileId, state, aiCreds) {
        if (state.cancelled) {
            await workflowBatchRepository.failItem(item.id, 'CANCELLED', 'Batch đã huỷ');
            return;
        }
        const inputOverrides = this.buildInputOverrides(schema, item);
        const storyColumn = schema.inputs.find(c => c.storyInput);
        if (storyColumn) {
            const payload = await hydrateStoryPayload(item.inputValues[storyColumn.batchKey]);
            def = payload.snapshot.definition || def;
        }
        if(batch.parallelSettings && singleImageWorkflow(def)){
            inputOverrides.__batchParallel=batch.parallelSettings;
            for(const node of def.nodes.filter(n=>n.type==='generate-image'))inputOverrides[node.id]={...inputOverrides[node.id],model:batch.parallelSettings.imageModelKey,count:batch.parallelSettings.imagesPerProduct,batchParallel:batch.parallelSettings};
        }
        const imageFiles = [];
        for (const node of def.nodes.filter(n => n.type === 'upload-image' || n.type === 'folder-input')) {
            const data = { ...node.data, ...inputOverrides[node.id] };
            if (data.localPaths?.length || data.localPath) {
                for (const file of imagePaths(data.localPaths?.length ? data.localPaths : data.localPath)) {
                    const info = await stat(file);
                    imageFiles.push({ file, size: info.size, modified: info.mtimeMs });
                }
            }
        }
        inputOverrides.__batchTemplate = { fingerprint: createHash('sha256').update(JSON.stringify({ nodes: def.nodes, edges: def.edges, ...(imageFiles.length ? { imageFiles } : {}) })).digest('hex') };
        if(batch.id)inputOverrides.__batchMedia={batchId:batch.id};
        const previous = item.runId ? await workflowRepository.getRun(item.runId) : null;
        const reusable = previous && previous.profileId === profileId &&
            JSON.stringify(Object.fromEntries(Object.entries(previous.inputOverrides||{}).filter(([key])=>key!=='__batchMedia'))) === JSON.stringify(Object.fromEntries(Object.entries(inputOverrides).filter(([key])=>key!=='__batchMedia'))) &&
            ['COMPLETED', 'FAILED', 'CANCELLED'].includes(previous.status);
        // A failed download retries saving only; completed generation is not charged again.
        if (reusable && previous.status === 'COMPLETED') {
            const paths = batch.autoDownload ? await this.downloadOutputs(batch, def, schema, previous, item) : [];
            await workflowBatchRepository.completeItem(item.id, paths, sumRetries(previous));
            return;
        }
        const run = await workflowService.startRun({
            workflowId: batch.workflowId,
            profileId,
            inputOverrides,
            aiCreds,
            ...(reusable ? { sourceRunId: previous.id, resumeCompleted: true } : {}),
        });
        state.runIds.add(run.id);
        await workflowBatchRepository.setItemRun(item.id, run.id);
        try {
            const finished = await this.waitForRun(run.id, state);
            const retryCount = sumRetries(finished);
            if (finished.status === 'CANCELLED') {
                await workflowBatchRepository.failItem(item.id, 'CANCELLED', 'Run bị huỷ', retryCount);
                return;
            }
            if (finished.status === 'FAILED') {
                let error = finished.error ?? 'Run thất bại';
                if (String(error).includes('FLOW_VERIFICATION_REQUIRED')) {
                    state.verificationRequired = true;
                    state.blockedProfiles.set(profileId, error);
                }
                if (flowProfileUnavailable(finished, def)) {
                    state.blockedProfiles ??= new Map();
                    state.blockedProfiles.set(profileId, error);
                    error = '[PROFILE_UNAVAILABLE] ' + error;
                }
                await workflowBatchRepository.failItem(item.id, 'ERROR', needsContentReview(error) ? contentReviewMessage(error) : error, retryCount);
                return;
            }
            // COMPLETED → download marked output media.
            const outputPaths = batch.autoDownload
                ? await this.downloadOutputs(batch, def, schema, finished, item)
                : [];
            await workflowBatchRepository.completeItem(item.id, outputPaths, retryCount);
        }
        finally {
            state.runIds.delete(run.id);
        }
    },
    /** Map row values onto node input overrides keyed by node id. */
    buildInputOverrides(schema, item) {
        const overrides = {};
        for (const input of schema.inputs) {
            const value = item.inputValues[input.batchKey];
            if (value === undefined || value === '')
                continue; // keep the template default
            overrides[input.nodeId] =
                input.storyInput ? { storyPayload: value } : input.batchInputType === 'text' ? { prompt: value } : { localPath: imagePaths(value)[0], localPaths: imagePaths(value) };
        }
        return overrides;
    },
    /** Poll a run to a terminal state, honouring cancel + a safety deadline. */
    async waitForRun(runId, state) {
        const deadline = Date.now() + RUN_DEADLINE_MS;
        let cancelGrace = 0; // set when a cancel is requested; hard bail-out after this
        for (;;) {
            if ((state.cancelled || Date.now() > deadline) && cancelGrace === 0) {
                cancelGrace = Date.now() + CANCEL_GRACE_MS;
                await workflowService.cancelRun(runId).catch(() => { });
            }
            // If the engine never honours the cancel (e.g. a wedged dispatch), don't
            // hang this worker forever — abandon the row so the pool can drain.
            if (cancelGrace > 0 && Date.now() > cancelGrace) {
                throw new Error(`Run ${runId} không kết thúc sau khi huỷ — bỏ qua dòng này`);
            }
            const run = await workflowRepository.getRun(runId);
            if (!run)
                throw new Error(`Run disappeared: ${runId}`);
            if (TERMINAL_RUN.includes(run.status))
                return run;
            await sleep(POLL_INTERVAL_MS);
        }
    },
    /** Download every result of each marked output node into the batch folder. */
    async downloadOutputs(batch, def, schema, run, item) {
        const results = schema.outputs.flatMap(output => run.nodeStates[output.nodeId]?.results ?? []);
        const story = [...schema.outputs.map(output => run.nodeStates[output.nodeId]), ...Object.values(run.nodeStates)].find(s => s?.story?.sceneId && s.story.root && typeof s.story.prompt === 'string')?.story;
        if (story) return (await saveStoryResults(story, results, run.id)).map(r => r.savedPath);
        const prompts = Object.values(run.nodeStates).flatMap(state => state.textValues ?? (state.textValue ? [state.textValue] : []));
        const imageInput = schema.inputs.find(input => input.folderInput) ?? schema.inputs.find(input => input.batchInputType === 'image');
        const source = imageInput && item.inputValues[imageInput.batchKey];
        let product = `row_${padRow(item.rowIndex)}`;
        let productGroup;
        if (source) {
            const files = imagePaths(source);
            const inputNode = def.nodes.find(node => node.id === imageInput.nodeId);
            const nestedImages = inputNode?.data.groupMode === 'product-images';
            if (files.length && (nestedImages || inputNode?.data.groupMode === 'subfolders')) {
                const sourceFolder = path.resolve(path.dirname(files[0]));
                productGroup = { name: path.basename(sourceFolder), key: sourceFolder };
            }
            product += '_' + (String(source).trim().startsWith('[') ? path.basename(path.dirname(files[0]))
                : `${nestedImages ? path.basename(path.dirname(files[0])) + '_' : ''}${path.parse(files[0]).name}`);
        }
        const saved = await saveMediaBundle({ outputDir: batch.outputDir, batchId: batch.id, productId: product, productGroup, results, prompts,
            metadata: { batchId: batch.id, runId: run.id, rowIndex: item.rowIndex, inputValues: item.inputValues,
                promptSettings: def.nodes.filter(n => ['ai-prompt','chatgpt'].includes(n.type)).map(n => ({
                    nodeId: n.id, systemMessage: n.data.systemMessage, prompt: n.data.prompt, model: n.data.model,
                })) } });
        return saved.map(result => result.savedPath);
    },
    /** Compute + persist the batch's terminal status from item counts. */
    async finalizeBatch(batchId, state) {
        const counts = await workflowBatchRepository.countItemsByStatus(batchId);
        let status;
        if (state.cancelled)
            status = 'CANCELLED';
        else if (state.verificationRequired && counts.pending > 0)
            status = 'PAUSED';
        else if (counts.pending > 0 || counts.running > 0 || (counts.total > 0 && counts.error + counts.cancelled === counts.total))
            status = 'FAILED';
        else
            status = 'COMPLETED';
        await workflowBatchRepository.updateBatchStatus(batchId, status, null);
        logger.info(`[BatchOrchestrator] batch ${batchId} ${status} — done ${counts.done}/${counts.total}, error ${counts.error}`);
    },
    async pauseBatch(batchId) {
        const state=activeBatches.get(batchId);
        if(!state||state.cancelled)throw Error('Batch không đang chạy.');
        state.paused=true;
        try{await workflowBatchRepository.updateBatchStatus(batchId,'PAUSED',null);}catch(error){state.paused=false;throw error;}
    },
    async resumeBatch(batchId,aiCreds,parallelSettings) {
        const state=activeBatches.get(batchId);
        if(state){
            if(state.cancelled)throw Error('Batch đã hủy.');
            if(parallelSettings){
                const batch=state.batch;
                const def=state.definition;
                if(!batch||!def)throw Error('Batch chưa sẵn sàng để cập nhật cấu hình.');
                if(!singleImageWorkflow(def))throw Error('Cấu hình đa luồng chỉ dùng cho workflow một ảnh/job.');
                batch.parallelSettings=normalizeParallel({...parallelSettings,imagesPerProduct:parallelSettings.imagesPerProduct??defaultImagesPerProduct(def)});
                batch.rowsPerProfile=batch.parallelSettings.concurrency;
                await saveBatchParallel(batchId,batch.parallelSettings);
            }
            await workflowBatchRepository.updateBatchStatus(batchId,'RUNNING',null);state.paused=false;return;
        }
        const batch=await workflowBatchRepository.getBatch(batchId);
        if(batch?.status!=='PAUSED')throw Error('Batch không đang tạm dừng.');
        return this.startBatch(batchId,aiCreds,parallelSettings);
    },
    /** Signal cancel, tear down in-flight runs, and mark open items cancelled. */
    async cancelBatch(batchId) {
        const state = activeBatches.get(batchId);
        if (state) {
            state.cancelled = true;
            for (const runId of state.runIds) {
                await workflowService.cancelRun(runId).catch(() => { });
            }
        }
        await workflowBatchRepository.cancelOpenItems(batchId);
        if (!state) {
            // Not actively running in this process — just mark it cancelled.
            await workflowBatchRepository.updateBatchStatus(batchId, 'CANCELLED', null);
        }
    },
    /**
     * Re-queue one failed/cancelled row. If the pool is still alive the reset item
     * is claimed by a lane (or the drain re-check loop); if the batch already
     * finished, a fresh pool is dispatched to process just this row.
     */
    async retryItem(batchId, rowIndex, aiCreds, newInputValues, reviewConfirmed = false) {
        const batch = await workflowBatchRepository.getBatchWithItems(batchId);
        if (!batch)
            throw new Error(`Batch not found: ${batchId}`);
        const item = batch.items.find((it) => it.rowIndex === rowIndex);
        if (!item)
            throw new Error(`Không tìm thấy dòng ${rowIndex + 1} trong batch`);
        if (item.status !== 'ERROR' && item.status !== 'CANCELLED') {
            throw new Error(`Dòng ${rowIndex + 1} không ở trạng thái lỗi (${item.status})`);
        }
        assertContentReviewRetry(item.error, reviewConfirmed, this.isRunning(batchId));
        for (const profileId of batch.profileIds) profileImageScheduler.resume(profileId);
        const reset = await workflowBatchRepository.resetItemForRetry(item.id, newInputValues);
        if (!reset) {
            throw new Error(`Dòng ${rowIndex + 1} vừa được gen lại bởi một yêu cầu khác`);
        }
        // A live pool's lanes (or its drain re-check loop) will claim the PENDING item.
        if (this.isRunning(batchId) || batch.status === 'PAUSED')
            return;
        // Pool already finished → dispatch a fresh one for the single reset row.
        // Reserve state synchronously (no await between isRunning check and set) so a
        // second concurrent retry sees isRunning=true and doesn't double-dispatch.
        const state = { cancelled: false, runIds: new Set() };
        activeBatches.set(batchId, state);
        try {
            const def = await definitionForBatch(batch);
            if (!def)
                throw new Error('Workflow đã bị xoá');
            const schema = extractBatchSchema(def);
            await workflowBatchRepository.updateBatchStatus(batchId, 'RUNNING', null);
            void this.runBatch(batch, def, schema, aiCreds, state).catch((err) => {
                logger.error(`[BatchOrchestrator] retry batch ${batchId} crashed:`, err);
            });
        }
        catch (err) {
            activeBatches.delete(batchId); // dispatch failed — release the reservation
            throw err;
        }
    },
    /** Resume RUNNING batches after a restart (reset stuck items, re-dispatch). */
    async rehydrate() {
        const running = await workflowBatchRepository.findBatchesByStatus(['RUNNING']);
        if (running.length === 0)
            return;
        logger.info(`[BatchOrchestrator] resuming ${running.length} interrupted batch(es)`);
        for (const batch of running) {
            try {
                // No profiles → no workers → items would stay PENDING forever. Fail fast.
                if (batch.profileIds.length === 0) {
                    await workflowBatchRepository.cancelOpenItems(batch.id);
                    await workflowBatchRepository.updateBatchStatus(batch.id, 'FAILED', 'Không có profile');
                    continue;
                }
                // A profile deleted while the app was down would crash its lane on resume.
                const { missing } = await workflowBatchRepository.validateProfileIds(batch.profileIds);
                if (missing.length > 0) {
                    await workflowBatchRepository.cancelOpenItems(batch.id);
                    await workflowBatchRepository.updateBatchStatus(batch.id, 'FAILED', `${missing.length} profile đã bị xoá — batch không thể tiếp tục`);
                    continue;
                }
                await workflowBatchRepository.resetRunningItems(batch.id);
                const def = await definitionForBatch(batch);
                if (!def) {
                    await workflowBatchRepository.cancelOpenItems(batch.id);
                    await workflowBatchRepository.updateBatchStatus(batch.id, 'FAILED', 'Workflow đã bị xoá');
                    continue;
                }
                const schema = extractBatchSchema(def);
                const state = { cancelled: false, runIds: new Set() };
                activeBatches.set(batch.id, state);
                void this.runBatch(batch, def, schema, undefined, state).catch((err) => {
                    logger.error(`[BatchOrchestrator] resumed batch ${batch.id} crashed:`, err);
                });
            }
            catch (err) {
                logger.error(`[BatchOrchestrator] failed to resume batch ${batch.id}:`, err);
            }
        }
    },
};
/** Sum per-node auto-retries across a finished run for the row's retry badge. */
function sumRetries(run) {
    return Object.values(run.nodeStates).reduce((sum, st) => sum + (st.retryCount ?? 0), 0);
}
