import { workflowRepository } from './workflow.repository.js';
import { workflowService } from './workflow.service.js';
import { characterRunSummary } from './lib/storyCharacters.js';

const starting = new Set();
export async function registerStoryCharacterRoutes(app) {
    app.get('/api/workflow/:id/characters', async (req, reply) => {
        try {
            const runs = await workflowRepository.listRunsByWorkflow(req.params.id);
            return { success: true, data: runs.map(characterRunSummary).filter(Boolean) };
        } catch (error) { return reply.code(400).send({ success: false, error: error.message }); }
    });
    app.post('/api/workflow/:id/characters', async (req, reply) => {
        const workflowId = req.params.id;
        if (starting.has(workflowId)) return reply.code(409).send({ success: false, error: 'Đang khởi tạo ảnh nhân vật.' });
        starting.add(workflowId);
        try {
            const active = (await workflowRepository.listRunsByWorkflow(workflowId)).find(r => r.inputOverrides?.__storyCharacters && ['PENDING','RUNNING','PAUSED'].includes(r.status));
            if (active) throw new Error('Đang tạo nhân vật. Chờ hoàn thành hoặc hủy trước khi tạo tiếp.');
            const { referenceNodeId, profileId, keys } = req.body || {};
            if (typeof referenceNodeId !== 'string' || typeof profileId !== 'string') throw new Error('Chọn node và profile Flow.');
            const run = await workflowService.startCharacters({ workflowId, referenceNodeId, profileId, keys });
            return { success: true, data: { runId: run.id } };
        } catch (error) { return reply.code(400).send({ success: false, error: error.message }); }
        finally { starting.delete(workflowId); }
    });
}
