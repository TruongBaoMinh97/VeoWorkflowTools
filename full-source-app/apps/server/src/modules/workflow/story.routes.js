import { normalizePromptWorkflow } from './lib/promptStory.js';
import { z } from 'zod';
import path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { workflowRepository } from './workflow.repository.js';
import { extractBatchSchema } from './workflow.batch.schema.js';
import { previewStory, snapshotStory } from './lib/storyScenes.js';
import { listStoryResults, selectStoryResult } from './lib/storyResults.js';

export async function registerStoryRoutes(app) {
    app.post('/api/workflow/story/prompts-preview', async (req, reply) => {
        try {
            const def = normalizePromptWorkflow(req.body.definition);
            const input = def.nodes.find(n => n.type === 'story-input');
            const refs = def.nodes.find(n => n.type === 'story-references');
            return { success:true, data:await previewStory(input.data.document, refs.data.library || {}, refs.data) };
        } catch(error) { return reply.code(400).send({success:false,error:error.message}); }
    });
    app.post('/api/workflow/story/preview', async (req, reply) => {
        try {
            const { document, library, options } = req.body;
            return { success: true, data: await previewStory(document, library, options) };
        } catch (error) { return reply.code(400).send({ success: false, error: error.message }); }
    });
    app.post('/api/workflow/:id/prepare-story', async (req, reply) => {
        try {
            let def = await workflowRepository.getWorkflow(req.params.id);
            if (!def) throw new Error('Workflow không tồn tại.');
            if (def.nodes.some(n => n.type === 'character-generator')) throw new Error('Dùng mục Tạo và duyệt nhân vật trong Story References; bỏ node Character Generator khỏi luồng batch cảnh để tránh tạo lại nhân vật.');
            def = normalizePromptWorkflow(def);
            const inputs = def.nodes.filter(n => n.type === 'story-input');
            const refs = def.nodes.filter(n => n.type === 'story-references');
            if (inputs.length !== 1 || refs.length !== 1) throw new Error('Cần đúng một Story Input và một Story References.');
            const input = inputs[0], reference = refs[0];
            if (!input.data.selectedSceneIds?.length) throw new Error('Chọn ít nhất một cảnh để chạy.');
            if (input.data.rerunRoot) {
                if (!path.isAbsolute(input.data.rerunRoot)) throw new Error('Thư mục bộ truyện không hợp lệ.');
                const snapshotPath = path.join(input.data.rerunRoot, 'story-manifest.json');
                const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
                if (snapshot.definition?.id !== def.id) throw new Error('Bộ truyện thuộc workflow khác.');
                const preview = await previewStory(snapshot.document, snapshot.library, snapshot.options);
                const selected = input.data.selectedSceneIds.map(id => preview.rows.find(r => r.scene.scene_id === id));
                if (selected.some(r => !r?.ready)) throw new Error('Cảnh chạy lại không hợp lệ hoặc ảnh snapshot đã mất.');
                const column = extractBatchSchema(snapshot.definition).inputs.find(c => c.storyInput);
                return { success: true, data: { outputDir: snapshot.root, rowsPerProfile: 1, warnings: ['Đang tạo thêm ảnh bằng snapshot cũ; các chỉnh sửa thư viện/prompt mới không áp dụng.'], items: selected.map((row,rowIndex)=>({ rowIndex, inputValues: { [column.batchKey]: JSON.stringify({ snapshotPath, sceneId: row.scene.scene_id }) } })) } };
            }
            const model = def.nodes.find(n => n.type === 'generate-image')?.data?.model || 'GEM_PIX_2';
            const options = { model, maxReferences: reference.data.maxReferences || 8, referenceLimitVerified: reference.data.referenceLimitVerified === true && reference.data.verifiedModel === model, srtText: input.data.srtText || '' };
            const { snapshot, selected } = await snapshotStory(input.data.document, reference.data.library, options, input.data.outputDir, input.data.selectedSceneIds);
            snapshot.definition = structuredClone(def);
            const snapshotPath = path.join(snapshot.root, 'story-manifest.json');
            await writeFile(snapshotPath, JSON.stringify({ ...snapshot, selectedSceneIds: selected.map(r => r.scene.scene_id) }, null, 2));
            const schema = extractBatchSchema(def);
            const column = schema.inputs.find(c => c.storyInput);
            return { success: true, data: { outputDir: snapshot.root, rowsPerProfile: 1, warnings: [], items: selected.map((row, rowIndex) => ({ rowIndex, inputValues: { [column.batchKey]: JSON.stringify({ snapshotPath, sceneId: row.scene.scene_id }) } })) } };
        } catch (error) { return reply.code(400).send({ success: false, error: error.message }); }
    });
    app.post('/api/workflow/story/results', async (req, reply) => {
        try { const { root } = z.object({ root: z.string().min(1) }).parse(req.body); return { success: true, data: await listStoryResults(root) }; }
        catch (error) { return reply.code(400).send({ success: false, error: error.message }); }
    });
    app.post('/api/workflow/story/select', async (req, reply) => {
        try {
            const b = z.object({ root: z.string().min(1), sceneId: z.string(), attemptId: z.string(), index: z.number().int().min(0) }).parse(req.body);
            return { success: true, data: await selectStoryResult(b.root, b.sceneId, b.attemptId, b.index) };
        } catch (error) { return reply.code(400).send({ success: false, error: error.message }); }
    });
}
