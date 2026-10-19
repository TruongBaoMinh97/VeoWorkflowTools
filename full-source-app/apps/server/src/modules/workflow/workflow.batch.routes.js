/**
 * Batch Flow routes — run one workflow template across N input rows.
 *
 * Mounted under /api/workflow/*. Static segments ("batch") take priority over
 * the parametric "/api/workflow/:id" route in find-my-way, so there is no
 * collision with the workflow CRUD routes.
 */
import { z } from 'zod';
import * as XLSX from 'xlsx';
import { workflowRepository } from './workflow.repository.js';
import { loadBatchParallel, workflowBatchRepository } from './workflow.batch.repository.js';
import { workflowBatchOrchestrator } from './workflow.batch.orchestrator.js';
import { extractBatchSchema } from './workflow.batch.schema.js';
import { deriveProgress } from './workflow.batch.progress.js';
import { scanImageFolder } from './lib/folderInputs.js';
import { prepareFolderBatch } from './lib/prepareFolderBatch.js';
import { singleImageWorkflow, batchProductLanes, defaultImagesPerProduct } from './lib/imageGenerationQueue.js';
const createBatchSchema = z.object({
    workflowId: z.string().min(1),
    name: z.string().min(1).default('Batch'),
    profileIds: z.array(z.string().min(1)).min(1),
    outputDir: z
        .string()
        .min(1)
        .refine((v) => !v.includes('..'), { message: 'outputDir không hợp lệ' }),
    autoDownload: z.boolean().optional(),
    rowsPerProfile: z.number().int().min(1).max(8).optional(),
    items: z
        .array(z.object({
        rowIndex: z.number().int().min(0),
        inputValues: z.record(z.string(), z.string()).default({}),
    }))
        .min(1),
});
const batchParallelSchema = z.object({
    imageModelKey: z.enum(['GEM_PIX_2', 'BELUGA', 'HARBOR_SEAL', 'NARWHAL']).optional(),
    concurrency: z.number().int().min(1).max(8),
    restSeconds: z.number().min(1).max(180),
    burst: z.number().int().min(1).max(4),
    imagesPerProduct: z.number().int().min(1).max(4).optional(),
});
export async function registerWorkflowBatchRoutes(app) {
    app.post('/api/workflow/:id/prepare-folder', async (req, reply) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        const definition = await workflowRepository.getWorkflow(id);
        if (!definition) return reply.code(404).send({ success: false, error: 'Workflow not found' });
        try { return { success: true, data: await prepareFolderBatch(definition) }; }
        catch (error) { return reply.code(400).send({ success: false, error: error.message }); }
    });
    app.post('/api/workflow/batch/scan-folder', async (req, reply) => {
        const body = z.object({ folder: z.string().min(1), mode: z.enum(['files', 'subfolders', 'product-images']).default('files') }).parse(req.body);
        try { return { success: true, data: await scanImageFolder(body.folder, body.mode) }; }
        catch (error) { return reply.code(400).send({ success: false, error: error.message }); }
    });
    /** GET /api/workflow/:id/batch-schema — input/output columns for a template. */
    app.get('/api/workflow/:id/batch-schema', async (req, reply) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        const def = await workflowRepository.getWorkflow(id);
        if (!def) {
            reply.status(404);
            return { success: false, error: 'Workflow not found' };
        }
        return { success: true, data: {...extractBatchSchema(def),singleImageJob:singleImageWorkflow(def),imageModelKey:def.nodes.find(n=>n.type==='generate-image')?.data?.model||'GEM_PIX_2',imagesPerProductDefault:defaultImagesPerProduct(def)} };
    });
    /** POST /api/workflow/batch — create a batch (PENDING) with its rows. */
    app.post('/api/workflow/batch', async (req, reply) => {
        const body = createBatchSchema.parse(req.body);
        const def = await workflowRepository.getWorkflow(body.workflowId);
        if (!def) {
            reply.status(404);
            return { success: false, error: 'Workflow not found' };
        }
        const schema = extractBatchSchema(def);
        if (schema.inputs.length === 0) {
            reply.status(400);
            return { success: false, error: 'Workflow chưa đánh dấu node input nào' };
        }
        if (schema.outputs.length === 0) {
            reply.status(400);
            return { success: false, error: 'Workflow chưa đánh dấu node output nào' };
        }
        const { missing, deduped } = await workflowBatchRepository.validateProfileIds(body.profileIds);
        if (missing.length > 0) {
            reply.status(400);
            return {
                success: false,
                error: `Không tìm thấy ${missing.length} profile đã chọn. Hãy chọn lại rồi thử lại.`,
            };
        }
        const batch = await workflowBatchRepository.createBatch({
            workflowId: body.workflowId,
            name: body.name,
            profileIds: deduped,
            outputDir: body.outputDir,
            autoDownload: schema.inputs.some(i => i.storyInput) ? true : body.autoDownload,
            rowsPerProfile: batchProductLanes(body, def),
            items: body.items,
        });
        reply.status(201);
        return { success: true, data: batch };
    });
    /**
     * POST /api/workflow/batch/parse-excel — parse an uploaded sheet into a header
     * row + raw string rows. Column→batchKey mapping is done client-side (it knows
     * the schema). Static "parse-excel" beats the "/batch/:batchId" param route.
     */
    app.post('/api/workflow/batch/parse-excel', async (req) => {
        // Bound the payload (~6 MB decoded) and row count so a huge sheet can't
        // stall the event loop / OOM the process.
        const { fileBase64 } = z
            .object({ fileBase64: z.string().min(1).max(8 * 1024 * 1024) })
            .parse(req.body);
        try {
            const wb = XLSX.read(Buffer.from(fileBase64, 'base64'), { type: 'buffer' });
            const sheet = wb.Sheets[wb.SheetNames[0] ?? ''];
            if (!sheet)
                return { success: false, error: 'File Excel rỗng', data: { headers: [], rows: [] } };
            const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
            const headers = (matrix[0] ?? []).map((c) => String(c ?? '').trim());
            const rows = matrix
                .slice(1, 5001) // cap at 5 000 data rows
                .map((r) => r.map((c) => String(c ?? '').trim()))
                .filter((cells) => cells.some((c) => c.length > 0));
            return { success: true, data: { headers, rows } };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Không đọc được file Excel';
            return { success: false, error: msg, data: { headers: [], rows: [] } };
        }
    });
    /** GET /api/workflow/batch?workflowId= — list batches. */
    app.get('/api/workflow/batch', async (req) => {
        const { workflowId } = z
            .object({ workflowId: z.string().optional() })
            .parse(req.query);
        const batches = await workflowBatchRepository.listBatches(workflowId);
        return { success: true, data: batches };
    });
    /** GET /api/workflow/batch/:batchId — batch + items. */
    app.get('/api/workflow/batch/:batchId', async (req, reply) => {
        const { batchId } = z.object({ batchId: z.string() }).parse(req.params);
        const batch = await workflowBatchRepository.getBatchWithItems(batchId);
        if (!batch) {
            reply.status(404);
            return { success: false, error: 'Batch not found' };
        }
        return { success: true, data: { ...batch, running: workflowBatchOrchestrator.isRunning(batchId) } };
    });
    /** GET /api/workflow/batch/:batchId/poll — lightweight status snapshot. */
    app.get('/api/workflow/batch/:batchId/poll', async (req, reply) => {
        const { batchId } = z.object({ batchId: z.string() }).parse(req.params);
        const batch = await workflowBatchRepository.getBatch(batchId);
        if (!batch) {
            reply.status(404);
            return { success: false, error: 'Batch not found' };
        }
        const items = await workflowBatchRepository.listItems(batchId);
        // Batch-fetch nodeStates for RUNNING items only (one query, no N+1).
        const runningRunIds = items
            .filter((it) => it.status === 'RUNNING' && it.runId !== null)
            .map((it) => it.runId);
        const nodeStatesMap = await workflowRepository.findRunsByIds(runningRunIds);
        // Load the workflow def once (only when something is running) for node labels.
        let nodeIndex = new Map();
        if (runningRunIds.length > 0) {
            const def = await workflowRepository.getWorkflow(batch.workflowId);
            if (def)
                nodeIndex = new Map(def.nodes.map((n) => [n.id, n]));
        }
        return {
            success: true,
            data: {
                profileIds: batch.profileIds,
                profileIssues: workflowBatchOrchestrator.profileIssues(batchId),
                parallelSettings:await loadBatchParallel(batchId),
                status: batch.status,
                running: workflowBatchOrchestrator.isRunning(batchId),
                error: batch.error,
                items: items.map((it) => {
                    const nodeStates = it.runId ? nodeStatesMap.get(it.runId) : undefined;
                    return {
                        profileId: it.profileId,
                        rowIndex: it.rowIndex,
                        status: it.status,
                        retryCount: it.retryCount,
                        runId: it.runId,
                        outputPaths: it.outputPaths,
                        error: it.error,
                        startedAt: it.startedAt ? it.startedAt.toISOString() : null,
                        progress: it.status === 'RUNNING' && nodeStates ? deriveProgress(nodeStates, nodeIndex) : null,
                    };
                }),
            },
        };
    });
    /** POST /api/workflow/batch/:batchId/start — dispatch the worker pool. */
    app.post('/api/workflow/batch/:batchId/start', async (req, reply) => {
        const { batchId } = z.object({ batchId: z.string() }).parse(req.params);
        const body = z
            .object({ aiCreds: z.object({ key: z.string(), deviceId: z.string() }).optional(), parallelSettings:batchParallelSchema.optional() })
            .parse(req.body ?? {});
        try {
            await workflowBatchOrchestrator.startBatch(batchId, body.aiCreds, body.parallelSettings);
            reply.status(202);
            return { success: true };
        }
        catch (err) {
            reply.status(400);
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    });
    for(const action of ['pause','resume'])app.post(`/api/workflow/batch/:batchId/${action}`,async(req,reply)=>{
        const {batchId}=z.object({batchId:z.string()}).parse(req.params);
        const body=z.object({aiCreds:z.object({key:z.string(),deviceId:z.string()}).optional(),parallelSettings:batchParallelSchema.optional()}).parse(req.body??{});
        try{if(action==='pause')await workflowBatchOrchestrator.pauseBatch(batchId);else await workflowBatchOrchestrator.resumeBatch(batchId,body.aiCreds,body.parallelSettings);return {success:true};}
        catch(error){return reply.code(400).send({success:false,error:error.message});}
    });
    /** POST /api/workflow/batch/:batchId/cancel — cancel a running batch. */
    app.post('/api/workflow/batch/:batchId/cancel', async (req, reply) => {
        const { batchId } = z.object({ batchId: z.string() }).parse(req.params);
        const batch = await workflowBatchRepository.getBatch(batchId);
        if (!batch) {
            reply.status(404);
            return { success: false, error: 'Batch not found' };
        }
        // Don't let a stray cancel overwrite a COMPLETED/FAILED record.
        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(batch.status)) {
            reply.status(409);
            return { success: false, error: `Batch đã kết thúc (${batch.status})` };
        }
        await workflowBatchOrchestrator.cancelBatch(batchId);
        return { success: true };
    });
    /**
     * POST /api/workflow/batch/:batchId/items/:rowIndex/retry — re-queue one failed
     * row. Body có thể kèm `inputValues` (prompt/ảnh user vừa sửa): key được
     * whitelist theo schema hiện tại của workflow (key lạ drop im lặng —
     * forward-compat), rồi ghi đè atomic cùng lúc reset item về PENDING.
     */
    app.post('/api/workflow/batch/:batchId/items/:rowIndex/retry', async (req, reply) => {
        const { batchId, rowIndex } = z
            .object({ batchId: z.string(), rowIndex: z.coerce.number().int().min(0) })
            .parse(req.params);
        const body = z
            .object({
            reviewConfirmed: z.boolean().optional(),
            aiCreds: z.object({ key: z.string(), deviceId: z.string() }).optional(),
            inputValues: z
                .record(z.string(), z.string().max(20000))
                .refine((obj) => Object.keys(obj).length <= 50, {
                message: 'inputValues quá nhiều key',
            })
                .optional(),
        })
            .parse(req.body ?? {});
        let sanitizedInputValues;
        if (body.inputValues !== undefined) {
            const batch = await workflowBatchRepository.getBatch(batchId);
            if (!batch) {
                reply.status(404);
                return { success: false, error: 'Batch not found' };
            }
            const def = await workflowRepository.getWorkflow(batch.workflowId);
            if (!def) {
                reply.status(404);
                return { success: false, error: 'Workflow not found' };
            }
            if (def.nodes.some(n=>n.type==='audio-splitter')) return reply.code(400).send({success:false,error:'Retry audio phải giữ nguyên snapshot; không sửa inputValues của cảnh.'});
            const validKeys = new Set(extractBatchSchema(def).inputs.map((i) => i.batchKey));
            sanitizedInputValues = {};
            for (const [key, value] of Object.entries(body.inputValues)) {
                if (validKeys.has(key))
                    sanitizedInputValues[key] = value;
            }
            // Toàn bộ key bị drop (schema đổi giữa chừng) → coi như không gửi gì,
            // giữ nguyên inputValues trong DB. Ghi {} vào đây sẽ XOÁ SẠCH giá trị
            // gốc của dòng — muốn xoá một ô, client gửi chuỗi rỗng theo key.
            if (Object.keys(sanitizedInputValues).length === 0) {
                sanitizedInputValues = undefined;
            }
        }
        try {
            await workflowBatchOrchestrator.retryItem(batchId, rowIndex, body.aiCreds, sanitizedInputValues, body.reviewConfirmed === true);
            reply.status(202);
            return { success: true };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reply.status(msg.includes('not found') || msg.includes('Không tìm thấy') ? 404 : msg.includes('gen lại') ? 409 : 400);
            return { success: false, error: msg };
        }
    });
}
