import path from 'node:path';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { saveMediaBundle } from '../lib/saveMedia.js';
import { storyId } from '../lib/storyScenes.js';
import { NonRetryableNodeError } from '../engine/WorkflowNodeError.js';

export function characterEntries(data) {
    const entries = typeof data.entries === 'string' ? JSON.parse(data.entries) : data.entries;
    if (!Array.isArray(entries) || !entries.length || entries.length > 100) throw new Error('Nhập từ 1 đến 100 prompt nhân vật.');
    const keys = new Set();
    for (const entry of entries) {
        storyId(entry.reference_key);
        if (keys.has(entry.reference_key)) throw new Error(`Trùng reference_key: ${entry.reference_key}`);
        keys.add(entry.reference_key);
        if (typeof entry.prompt !== 'string' || !entry.prompt.trim()) throw new Error(`Thiếu prompt: ${entry.reference_key}`);
    }
    if (!path.isAbsolute(data.outputDir || '')) throw new Error('Chọn thư mục lưu ảnh nhân vật.');
    return entries;
}

export const characterGeneratorExecutor = {
    type: 'character-generator', version: 1,
    async execute({ data, engine, provider, isCancelled }) {
        let entries;
        try { entries = characterEntries(data); } catch (error) { throw new NonRetryableNodeError(error.message); }
        const root = path.join(data.outputDir, `characters_${randomUUID()}`);
        await mkdir(root, { recursive: true });
        const manifestPath = path.join(root, 'character-library.json');
        const manifest = { schema_version: 'character-library/v1', reviewStatus: 'pending', library: {}, completed: [], total: entries.length };
        const persist = async () => { await writeFile(manifestPath + '.tmp', JSON.stringify(manifest, null, 2)); await rename(manifestPath + '.tmp', manifestPath); };
        await persist();
        const results = [];
        try {
            for (const entry of entries) {
                if (isCancelled?.()) throw new Error('Run was cancelled');
                await engine.checkPauseOrCancel();
                const prompt = [entry.prompt.trim(), data.stylePrompt?.trim()].filter(Boolean).join('\n\n');
                const generated = await engine.dispatchNode({ type: 'generate-image' }, {
                    model: data.model || 'GEM_PIX_2', ratio: data.ratio || '1:1', count: 1,
                    imageMode: 'text-to-image', quotaFallback: false, contentFallback: 'none',
                }, { promptTexts: [prompt], imageResults: [], videoResults: [] }, provider);
                if (isCancelled?.()) throw new Error('Run was cancelled');
                const saved = await saveMediaBundle({ outputDir: root, productId: entry.reference_key, results: generated.results,
                    prompts: [prompt], metadata: { reference_key: entry.reference_key, reviewStatus: 'pending' } });
                manifest.library[entry.reference_key] = { path: saved[0].savedPath };
                manifest.completed.push(entry.reference_key);
                results.push(...saved.map(result => ({ ...result, referenceKey: entry.reference_key })));
                await persist();
            }
            return { results, textValue: manifestPath };
        } catch (error) {
            manifest.error = error.message;
            await persist();
            // Never automatically repeat successful paid generations after a partial failure.
            throw new NonRetryableNodeError(`${error.message}. Đã lưu ${manifest.completed.length}/${entries.length}: ${manifestPath}. Chạy lại chỉ các mã còn thiếu.`);
        }
    },
};
