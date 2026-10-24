import { registerStoryCharacterRoutes } from './storyCharacters.routes.js';
import { registerStoryRoutes } from './story.routes.js';
import { registerAudioRoutes } from './audio.routes.js';
/**
 * Workflow Routes
 * REST + SSE endpoints for workflow CRUD and run management.
 */
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import { workflowRepository } from './workflow.repository.js';
import { workflowService } from './workflow.service.js';
import { WorkflowEngine } from './workflow.engine.js';
import { getDefaultNodeExecutorCatalog } from './engine/NodeExecutorRegistry.js';
// Restrict the public media route to image/video types — large local result
// files (upscale PNGs, merged MP4s) render unreliably over file:// in Electron,
// so they are streamed over HTTP instead.
const MEDIA_CONTENT_TYPES = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
};
// ── Shared schemas ─────────────────────────────────────────────────────────────
const nodeDefSchema = z.object({
    id: z.string(),
    type: z.string(),
    data: z.record(z.string(), z.unknown()).default({}),
    label: z.string().optional(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
});
const edgeDefSchema = z.object({
    id: z.string(),
    source: z.string(),
    target: z.string(),
    sourceHandle: z.string().optional(),
    targetHandle: z.string().optional(),
});
// ── Route registration ─────────────────────────────────────────────────────────
export async function registerWorkflowRoutes(app) {
    await registerStoryRoutes(app);
    await registerAudioRoutes(app);
    await registerStoryCharacterRoutes(app);
    // ── Local media passthrough (public — see PUBLIC_PATHS) ──────────────────────
    // GET /api/workflow/media?path=<absolute path> — streams a local image/video
    // result over HTTP so <img>/<video> can load it without a Bearer header.
    app.get('/api/workflow/media', async (req, reply) => {
        const { path: filePath } = req.query;
        if (!filePath)
            return reply.code(400).send({ error: 'path required' });
        const normalized = path.normalize(filePath);
        if (normalized.includes('..'))
            return reply.code(403).send({ error: 'traversal' });
        const ext = path.extname(normalized).toLowerCase();
        const contentType = MEDIA_CONTENT_TYPES[ext];
        if (!contentType)
            return reply.code(403).send({ error: 'unsupported media type' });
        if (!fs.existsSync(normalized))
            return reply.code(404).send({ error: 'not found' });
        const total = fs.statSync(normalized).size;
        const range = req.headers.range;
        // HTTP Range → 206 partial content so <video> can seek/stream large files
        // (4K merges can be hundreds of MB) in chunks instead of one giant response.
        if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (match) {
                let start = match[1] ? parseInt(match[1], 10) : 0;
                let end = match[2] ? parseInt(match[2], 10) : total - 1;
                if (Number.isNaN(start))
                    start = 0;
                if (Number.isNaN(end) || end >= total)
                    end = total - 1;
                if (start > end || start >= total) {
                    return reply.code(416).header('Content-Range', `bytes */${total}`).send();
                }
                return reply
                    .code(206)
                    .header('Content-Range', `bytes ${start}-${end}/${total}`)
                    .header('Accept-Ranges', 'bytes')
                    .header('Content-Length', end - start + 1)
                    .header('Cache-Control', 'no-store')
                    .type(contentType)
                    .send(fs.createReadStream(normalized, { start, end }));
            }
        }
        return reply
            .header('Content-Length', total)
            .header('Accept-Ranges', 'bytes')
            .header('Cache-Control', 'no-store')
            .type(contentType)
            .send(fs.createReadStream(normalized));
    });
    // ── Workflow CRUD ────────────────────────────────────────────────────────────
    /** GET /api/workflow — list all workflows */
    app.get('/api/workflow', async () => {
        const workflows = await workflowRepository.listWorkflows();
        return { success: true, data: workflows };
    });
    /** GET /api/workflow/node-types — backend-owned node catalog for the editor. */
    app.get('/api/workflow/node-types', async () => ({
        success: true,
        data: getDefaultNodeExecutorCatalog(),
    }));
    /** POST /api/workflow — create a new workflow */
    app.post('/api/workflow', async (req, reply) => {
        const body = z
            .object({
            name: z.string().min(1),
            description: z.string().optional(),
            nodes: z.array(nodeDefSchema).default([]),
            edges: z.array(edgeDefSchema).default([]),
        })
            .parse(req.body);
        const workflow = await workflowRepository.createWorkflow(body);
        reply.status(201);
        return { success: true, data: workflow };
    });
    /** GET /api/workflow/:id — get a workflow by id */
    app.get('/api/workflow/:id', async (req, reply) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        const workflow = await workflowRepository.getWorkflow(id);
        if (!workflow) {
            reply.status(404);
            return { success: false, error: 'Workflow not found' };
        }
        return { success: true, data: workflow };
    });
    /** PUT /api/workflow/:id — update a workflow */
    app.put('/api/workflow/:id', async (req, reply) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        const body = z
            .object({
            name: z.string().min(1).optional(),
            description: z.string().optional(),
            nodes: z.array(nodeDefSchema).optional(),
            edges: z.array(edgeDefSchema).optional(),
        })
            .parse(req.body);
        const existing = await workflowRepository.getWorkflow(id);
        if (!existing) {
            reply.status(404);
            return { success: false, error: 'Workflow not found' };
        }
        const updated = await workflowRepository.updateWorkflow(id, body);
        return { success: true, data: updated };
    });
    /** DELETE /api/workflow/:id — delete a workflow and all its runs */
    app.delete('/api/workflow/:id', async (req, reply) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        const existing = await workflowRepository.getWorkflow(id);
        if (!existing) {
            reply.status(404);
            return { success: false, error: 'Workflow not found' };
        }
        await workflowRepository.deleteWorkflow(id);
        return { success: true };
    });
    // ── Run management ───────────────────────────────────────────────────────────
    /**
     * POST /api/workflow/:id/run
     * Start a new run. Returns 202 + { runId } immediately; execution is async.
     */
    app.post('/api/workflow/:id/run', async (req, reply) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        const body = z
            .object({
            profileId: z.string(),
            veo3ProjectId: z.string().optional(),
            inputOverrides: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
            retryFromNodeId: z.string().optional(),
            sourceRunId: z.string().optional(),
            aiCreds: z.object({ key: z.string(), deviceId: z.string() }).optional(),
        })
            .parse(req.body);
        const run = await workflowService.startRun({
            workflowId: id,
            profileId: body.profileId,
            veo3ProjectId: body.veo3ProjectId,
            inputOverrides: body.inputOverrides,
            retryFromNodeId: body.retryFromNodeId,
            sourceRunId: body.sourceRunId,
            aiCreds: body.aiCreds,
        });
        reply.status(202);
        return { success: true, data: { runId: run.id } };
    });
    /** GET /api/workflow/:id/runs — list runs for a workflow */
    app.get('/api/workflow/:id/runs', async (req, reply) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        const existing = await workflowRepository.getWorkflow(id);
        if (!existing) {
            reply.status(404);
            return { success: false, error: 'Workflow not found' };
        }
        const runs = await workflowRepository.listRunsByWorkflow(id);
        return { success: true, data: runs };
    });
    /**
     * GET /api/workflow/runs/:runId
     * Poll current run state (nodeStates, status, error).
     * NOTE: register before /:id routes so 'runs' is not captured as :id.
     */
    app.get('/api/workflow/runs/:runId', async (req, reply) => {
        const { runId } = z.object({ runId: z.string() }).parse(req.params);
        const run = await workflowRepository.getRun(runId);
        if (!run) {
            reply.status(404);
            return { success: false, error: 'Run not found' };
        }
        return { success: true, data: run };
    });
    /** POST /api/workflow/runs/:runId/cancel — cancel an in-progress run */
    app.post('/api/workflow/runs/:runId/cancel', async (req, reply) => {
        const { runId } = z.object({ runId: z.string() }).parse(req.params);
        try {
            await workflowService.cancelRun(runId);
            return { success: true };
        }
        catch (err) {
            reply.status(404);
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    });
    /**
     * GET /api/workflow/runs/:runId/events
     * SSE stream of engine events. Sends an immediate run:state snapshot, then
     * forwards node:start / node:complete / node:error / run:complete / run:error
     * events until the run terminates or the client disconnects.
     */
    app.get('/api/workflow/runs/:runId/events', async (req, reply) => {
        const { runId } = z.object({ runId: z.string() }).parse(req.params);
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        // Immediate snapshot so the client can render current state without waiting.
        const run = await workflowRepository.getRun(runId);
        if (run) {
            reply.raw.write(`data: ${JSON.stringify({ type: 'run:state', run })}\n\n`);
        }
        // If no active engine, run already ended — send terminal event and close.
        if (!WorkflowEngine.hasInstance(runId)) {
            reply.raw.write(`data: ${JSON.stringify({ type: 'run:ended', status: run?.status ?? 'UNKNOWN' })}\n\n`);
            reply.raw.end();
            return reply;
        }
        const engine = WorkflowEngine.getInstance(runId);
        let closed = false;
        const onEvent = (event) => {
            if (closed)
                return;
            try {
                reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
            }
            catch {
                /* client already disconnected */
            }
            if (event.type === 'run:status' &&
                (event.status === 'COMPLETED' || event.status === 'FAILED' || event.status === 'CANCELLED')) {
                cleanup();
                reply.raw.end();
            }
        };
        const heartbeat = setInterval(() => {
            if (!closed) {
                try {
                    reply.raw.write(': heartbeat\n\n');
                }
                catch {
                    cleanup();
                }
            }
        }, 15000);
        const cleanup = () => {
            if (closed)
                return;
            closed = true;
            clearInterval(heartbeat);
            engine.off('engine:event', onEvent);
        };
        engine.on('engine:event', onEvent);
        req.raw.on('close', cleanup);
        // Keep the Fastify handler alive until the client closes the connection.
        await new Promise((resolve) => req.raw.on('close', resolve));
        return reply;
    });
}
