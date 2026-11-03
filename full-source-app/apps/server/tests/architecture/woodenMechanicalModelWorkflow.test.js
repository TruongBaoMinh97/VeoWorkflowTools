import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { extractBatchSchema } from '../../src/modules/workflow/workflow.batch.schema.js';
import { migrateWorkflowDefinition } from '../../src/modules/workflow/versioning/workflowVersioning.js';

const workflowUrl = new URL(
    '../../src/modules/workflow/presets/etsy-wooden-mechanical-models.workflow.json',
    import.meta.url,
);

async function loadWorkflow() {
    return JSON.parse(await readFile(workflowUrl, 'utf8'));
}

describe('wooden mechanical model Etsy workflow preset', () => {
    it('imports as a four-node image-to-image workflow', async () => {
        const workflow = migrateWorkflowDefinition(await loadWorkflow());
        expect(workflow).toMatchObject({ kind: 'flow-workflow', schemaVersion: 1 });
        expect(workflow.nodes.map(node => node.type)).toEqual([
            'folder-input', 'prompt', 'generate-image', 'result',
        ]);
        expect(new Set(workflow.nodes.map(node => node.id)).size).toBe(4);
        expect(workflow.edges).toEqual([
            expect.objectContaining({ sourceHandle: 'image-out', targetHandle: 'image-in' }),
            expect.objectContaining({ sourceHandle: 'text-out', targetHandle: 'text-in' }),
            expect.objectContaining({ sourceHandle: 'image-out', targetHandle: 'image-in' }),
        ]);
    });

    it('treats each reference image as one job while preserving product folders', async () => {
        const workflow = await loadWorkflow();
        const [input, , image] = workflow.nodes;
        expect(input.data).toMatchObject({
            batchRole: 'input',
            groupMode: 'product-images',
            folderPath: expect.any(String),
        });
        expect(image.data).toMatchObject({
            imageMode: 'image-to-image', model: 'GEM_PIX_2', ratio: '1:1', count: 1,
        });
        const schema = extractBatchSchema(workflow);
        expect(schema.inputs).toEqual([
            expect.objectContaining({ nodeId: input.id, folderInput: true, batchInputType: 'image' }),
        ]);
        expect(schema.outputs).toEqual([
            expect.objectContaining({ nodeId: 'wooden-model-result' }),
        ]);
    });

    it('keeps the supplied detail, construction, material and fact-preservation rules', async () => {
        const prompt = (await loadWorkflow()).nodes[1].data.prompt;
        expect(prompt).toContain('UNIVERSAL MASTER PROMPT V1.1');
        expect(prompt).toContain('TYPE A — DETAIL / MACRO / PARTIAL PRODUCT IMAGE');
        expect(prompt).toContain('MANDATORY EDITING MODE: BACKGROUND REPLACEMENT ONLY.');
        expect(prompt).toContain('Never complete a partially hidden or incomplete section by guessing.');
        expect(prompt).toContain('Do not turn loose parts into a completed model.');
        expect(prompt).toContain('Preserve every factual value exactly:');
        expect(prompt).toContain('Do not add a fictional brand name.');
        expect(prompt).toContain('never transfer components, colors, engravings');
    });
});
