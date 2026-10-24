import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { it, expect, vi } from 'vitest';
import { generateWithImageQuotaFallback, imageQuotaCooldowns } from '../../src/modules/workflow/lib/imageQuotaFallback.js';
import { generateWithMannequinFallback } from '../../src/modules/workflow/lib/mannequinFallback.js';
import { NonRetryableNodeError } from '../../src/modules/workflow/engine/WorkflowNodeError.js';

it('engine dispatch preserves all image inputs, routes progress and stores actual model on each result', async () => {
    imageQuotaCooldowns.clear();
    const source = readFileSync(new URL('../../src/modules/workflow/workflow.engine.js', import.meta.url), 'utf8');
    const dispatch = source.slice(source.indexOf('    async dispatchNode('), source.indexOf('    async dispatchLegacyNode('));
    const imageCase = source.slice(source.indexOf("            case 'generate-image': {"), source.indexOf('            // ── generate-video'));
    const context = vm.createContext({ generateWithImageQuotaFallback, generateWithMannequinFallback,
        NonRetryableError: NonRetryableNodeError, normalizeImageModelKey: key => key,
        convertAspectRatioToImageEnum: ratio => ratio,
        workflowImageQueue: { run: (_profile, _count, _cancel, execute) => execute(() => {}) } });
    const engine = vm.runInContext(`({ ${dispatch}, async dispatchLegacyNode(node, data, resolved, provider, onImageModel = async () => {}) {
        const projectId = this.veo3ProjectId; switch(node.type) { ${imageCase} } } })`, context);
    engine.nodeExecutorRegistry = { execute: (_type, ctx) => ctx.executeLegacy() };
    engine.profileId = 'integration'; engine.veo3ProjectId = 'project'; engine.checkPauseOrCancel = async () => {};
    const provider = { generateBatchImages: vi.fn().mockRejectedValueOnce(new Error('PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED'))
        .mockResolvedValue([{ name: 'media', fifeUrl: 'https://example.test/image' }]) };
    const onModel = vi.fn();
    const result = await engine.dispatchNode({ type: 'generate-image' }, { model: 'GEM_PIX_2', count: 4, seed: 12, ratio: '3:4', imageMode: 'image-to-image' },
        { promptTexts: ['original prompt'], imageResults: [{ mediaId: 'reference' }] }, provider, onModel);
    const [first, second] = provider.generateBatchImages.mock.calls.map(call => call[0]);
    expect(first.prompts).toEqual(second.prompts);
    expect(second.prompts).toHaveLength(4);
    expect(second.prompts[0]).toEqual({ prompt: 'original prompt', seed: 12, referenceImageMediaIds: ['reference'] });
    expect(second.imageAspectRatio).toBe('3:4'); expect(second.projectId).toBe('project');
    expect(second.imageModelName).toBe('BELUGA');
    expect(onModel).toHaveBeenCalledTimes(2);
    expect(result.results[0].imageModel).toBe('BELUGA');
    expect(result.imageModelMetadata.quotaFallbackHistory).toHaveLength(1);
});
