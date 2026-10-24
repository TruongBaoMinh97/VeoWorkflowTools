import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { extractBatchSchema } from '../../src/modules/workflow/workflow.batch.schema.js';
import { migrateWorkflowDefinition } from '../../src/modules/workflow/versioning/workflowVersioning.js';

const workflowUrl = new URL(
    '../../src/modules/workflow/presets/etsy-alternative-knit-beanies.workflow.json',
    import.meta.url,
);

async function loadWorkflow() {
    return JSON.parse(await readFile(workflowUrl, 'utf8'));
}

describe('alternative knit beanie Etsy workflow preset', () => {
    it('is an importable four-node image-to-image workflow', async () => {
        const workflow = migrateWorkflowDefinition(await loadWorkflow());

        expect(workflow).toMatchObject({
            kind: 'flow-workflow',
            schemaVersion: 1,
            name: 'ETSY - Mũ len Alternative - Nano Banana Pro',
        });
        expect(workflow.nodes.map(node => node.type)).toEqual([
            'folder-input',
            'prompt',
            'generate-image',
            'result',
        ]);
        expect(new Set(workflow.nodes.map(node => node.id)).size).toBe(workflow.nodes.length);
        expect(workflow.edges).toHaveLength(3);
    });

    it('creates one independent portrait listing image for each source file', async () => {
        const workflow = await loadWorkflow();
        const input = workflow.nodes.find(node => node.id === 'beanie-product');
        const image = workflow.nodes.find(node => node.id === 'generate-beanie-listing');
        const schema = extractBatchSchema(workflow);

        expect(input.data).toMatchObject({
            referenceRole: 'garment',
            batchRole: 'input',
            groupMode: 'files',
            folderPath: '',
            outputDir: '',
        });
        expect(image.data).toEqual({
            imageMode: 'image-to-image',
            model: 'GEM_PIX_2',
            ratio: '1:1',
            count: 1,
            contentFallback: 'none',
        });
        expect(schema.inputs).toEqual([
            expect.objectContaining({ nodeId: 'beanie-product', batchInputType: 'image', folderInput: true }),
        ]);
        expect(schema.outputs).toEqual([
            expect.objectContaining({ nodeId: 'beanie-result' }),
        ]);
    });

    it('feeds both the product reference and the static master prompt directly to Nano Banana Pro', async () => {
        const workflow = await loadWorkflow();
        const prompt = workflow.nodes.find(node => node.id === 'beanie-master-prompt').data.prompt;

        expect(workflow.edges).toEqual(expect.arrayContaining([
            expect.objectContaining({
                source: 'beanie-product',
                target: 'generate-beanie-listing',
                sourceHandle: 'image-out',
                targetHandle: 'image-in',
            }),
            expect.objectContaining({
                source: 'beanie-master-prompt',
                target: 'generate-beanie-listing',
                sourceHandle: 'text-out',
                targetHandle: 'text-in',
            }),
        ]));
        expect(prompt).toContain('sole source of truth');
        expect(prompt).toContain('Do not transfer a cross, symbol, stripe');
        expect(prompt).toContain('Remove advertising, not product details'.toUpperCase());
        expect(prompt).toContain('exactly one clean square 1:1 photograph');
        expect(prompt).toContain('Never sacrifice product accuracy for aesthetics');
    });
});
