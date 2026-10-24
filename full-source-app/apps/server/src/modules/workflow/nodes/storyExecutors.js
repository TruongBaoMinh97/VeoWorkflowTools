import { compileScene, parseStory, hydrateStoryPayload } from '../lib/storyScenes.js';
import { NonRetryableNodeError } from '../engine/WorkflowNodeError.js';

export const storyExecutors = [
    { type: 'story-input', version: 1, async execute({ data }) {
        if (!data.storyPayload) throw new NonRetryableNodeError('Mở Chuẩn bị Batch truyện để chọn cảnh và tạo snapshot.');
        const payload = await hydrateStoryPayload(data.storyPayload);
        return { results: [], story: payload };
    } },
    { type: 'story-references', version: 1, execute({ data }) {
        return { results: [], storyLibrary: data.library || {} };
    } },
    { type: 'scene-prepare', version: 1, execute({ resolved }) {
        try {
            const payload = resolved.story;
            if (!payload?.snapshot) throw new Error('Chưa có snapshot truyện.');
            const { snapshot, sceneId } = payload;
            const doc = parseStory(snapshot.document);
            const scene = doc.scenes.find(s => s.scene_id === sceneId);
            if (!scene) throw new Error('Không tìm thấy cảnh.');
            const prepared = compileScene(doc, scene, snapshot.library, snapshot.options);
            if (doc.timing_mode === 'audio-segments') {
                if (!scene.frozen_prompt) throw new Error('Snapshot audio thiếu prompt đã chốt.');
                prepared.prompt = scene.frozen_prompt;
            }
            if (!prepared.ready) throw new Error(`Thiếu ảnh: ${prepared.missing.join(', ')}`);
            const story = { sceneId, scene, root: snapshot.root, revision: snapshot.revision, prompt: prepared.prompt, images: prepared.images };
            return { textValue: prepared.prompt, story, results: prepared.images.map(image => ({ url: `file://${image.path}`, kind: 'image', referenceRole: image.role, referenceKey: image.key })) };
        } catch (error) { throw new NonRetryableNodeError(error.message); }
    } },
];
// Audio work happens once in audioRuns, never in a per-scene batch executor.
storyExecutors.push({...storyExecutors[0],type:'audio-splitter'}, {...storyExecutors[2],type:'scene-template'});
