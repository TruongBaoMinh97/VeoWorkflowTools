import { prepareCharacterDefinition } from './lib/storyCharacters.js';
import { hydrateStoryPayload } from './lib/storyScenes.js';
/**
 * Workflow Service
 * Use-case layer: loads profile from DB, coordinates repository + engine.
 */
import { prisma } from '../../lib/prisma.js';
import { captchaGateway } from '../../integrations/captcha/CaptchaGateway.js';
import { workflowRepository } from './workflow.repository.js';
import { WorkflowEngine, workflowEngine } from './workflow.engine.js';
/** A node plus everything reachable downstream of it (BFS over edges). */
function collectNodeAndDescendants(fromNodeId, edges) {
    const set = new Set([fromNodeId]);
    const queue = [fromNodeId];
    while (queue.length > 0) {
        const current = queue.shift();
        for (const e of edges) {
            if (e.source === current && !set.has(e.target)) {
                set.add(e.target);
                queue.push(e.target);
            }
        }
    }
    return set;
}
/**
 * Preflight: verify the browser/captcha extension can mint reCAPTCHA before a run
 * starts, so the user gets a clear, actionable error up front instead of a mid-run
 * NO_FLOW_TAB failure. Mirrors the readiness gate gen-normal shows before generating.
 */
async function assertGenerationReady() {
    await captchaGateway.ensureReady();
}
export const workflowService = {
    async startRun(opts) {
        let def = await workflowRepository.getWorkflow(opts.workflowId);
        const payload = Object.values(opts.inputOverrides || {}).find(v => v?.storyPayload)?.storyPayload;
        if (payload) def = (await hydrateStoryPayload(payload)).snapshot.definition || def;
        if (!def)
            throw new Error(`Workflow not found: ${opts.workflowId}`);
        for (const node of def.nodes.filter(item => item.type === 'folder-input')) {
            const input = opts.inputOverrides?.[node.id];
            if (!input?.localPaths?.length && !input?.localPath)
                throw new Error('Workflow có Folder Input. Dùng Chuẩn bị chạy folder để tạo từng sản phẩm riêng.');
        }
        for (const node of def.nodes.filter(n => ['story-input','audio-splitter'].includes(n.type))) {
            if (!opts.inputOverrides?.[node.id]?.storyPayload) throw new Error('Dùng Chuẩn bị Batch truyện để chạy các cảnh.');
        }
        const profile = await prisma.profile.findUnique({
            where: { id: opts.profileId },
            select: { id: true, accessToken: true },
        });
        if (!profile)
            throw new Error(`Profile not found: ${opts.profileId}`);
        // Block doomed runs (no browser/Flow tab → captcha can't mint).
        await assertGenerationReady();
        // Retry: seed the new run with the source run's completed upstream results
        // and reuse its veo3 project, so only the chosen node + its descendants
        // re-execute (the engine preserves seeded 'done' nodes and skips them).
        let seededNodeStates;
        let veo3ProjectId = opts.veo3ProjectId;
        if (opts.resumeCompleted && opts.sourceRunId) {
            const source = await workflowRepository.getRun(opts.sourceRunId);
            if (source && source.workflowId === opts.workflowId && source.profileId === opts.profileId) {
                seededNodeStates = Object.fromEntries(Object.entries(source.nodeStates).filter(([, state]) => state.status === 'done'));
                veo3ProjectId = source.veo3ProjectId ?? veo3ProjectId;
            }
        }
        if (opts.retryFromNodeId && opts.sourceRunId) {
            const source = await workflowRepository.getRun(opts.sourceRunId);
            if (source) {
                veo3ProjectId = source.veo3ProjectId ?? veo3ProjectId;
                const resetSet = collectNodeAndDescendants(opts.retryFromNodeId, def.edges);
                seededNodeStates = {};
                for (const [nodeId, state] of Object.entries(source.nodeStates)) {
                    if (!resetSet.has(nodeId) && state.status === 'done') {
                        seededNodeStates[nodeId] = state;
                    }
                }
            }
        }
        const run = await workflowRepository.createRun({ ...opts, veo3ProjectId }, seededNodeStates);
        // Fire-and-forget — route returns { runId } immediately.
        workflowEngine.startRun(run, def, profile, run.veo3ProjectId ?? undefined, opts.aiCreds ?? null);
        return run;
    },
    async startCharacters(opts) {
        const def = await workflowRepository.getWorkflow(opts.workflowId);
        if (!def) throw new Error('Workflow không tồn tại.');
        const { definition, entries } = prepareCharacterDefinition(def, opts.referenceNodeId, opts.keys);
        const profile = await prisma.profile.findUnique({ where: { id: opts.profileId }, select: { id: true, accessToken: true } });
        if (!profile) throw new Error('Chọn profile Flow hợp lệ.');
        await assertGenerationReady();
        const run = await workflowRepository.createRun({ workflowId: def.id, profileId: profile.id,
            inputOverrides: { __storyCharacters: { referenceNodeId: opts.referenceNodeId, entries, definition } } });
        workflowEngine.startRun(run, definition, profile, undefined, null);
        return run;
    },
    async cancelRun(runId) {
        const run = await workflowRepository.getRun(runId);
        if (!run)
            throw new Error(`Run not found: ${runId}`);
        if (WorkflowEngine.hasInstance(runId)) {
            workflowEngine.cancelRun(runId);
            // Engine will persist CANCELLED status when it acknowledges the flag.
        }
        else {
            // Run already terminated or never started in this process.
            await workflowRepository.updateRunStatus(runId, 'CANCELLED');
        }
    },
    async rehydrateRunningRuns() {
        await workflowEngine.rehydrateRunningRuns();
    },
};
