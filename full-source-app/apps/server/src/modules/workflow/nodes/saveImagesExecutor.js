import { saveStoryResults } from '../lib/storyResults.js';
import { saveMediaBundle } from '../lib/saveMedia.js';
import { NonRetryableNodeError } from '../engine/WorkflowNodeError.js';

export const saveImagesExecutor = {
    type: 'save-images', version: 1,
    async execute({ data, resolved, engine, isCancelled }) {
        if (resolved.story?.sceneId) return { results: await saveStoryResults(resolved.story, resolved.imageResults, engine?.runId), story: resolved.story };
        if (!data.outputDir?.trim()) throw new NonRetryableNodeError('Save Images: chưa chọn folder lưu.', { code: 'SAVE_FOLDER_MISSING' });
        if (!resolved.imageResults.length) throw new NonRetryableNodeError('Save Images: cần kết nối ảnh đầu vào.', { code: 'SAVE_IMAGE_MISSING' });
        if (isCancelled?.()) throw new Error('Run was cancelled');
        const results = await saveMediaBundle({ outputDir: data.outputDir, productId: data.productName || 'product',
            results: resolved.imageResults, prompts: resolved.promptTexts, metadata: { runId: engine?.runId } });
        return { results };
    },
};
