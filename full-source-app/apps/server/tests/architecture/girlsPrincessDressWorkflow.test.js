import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { extractBatchSchema } from '../../src/modules/workflow/workflow.batch.schema.js';
import { migrateWorkflowDefinition } from '../../src/modules/workflow/versioning/workflowVersioning.js';

const workflowUrl = new URL(
    '../../src/modules/workflow/presets/etsy-girls-princess-dresses.workflow.json',
    import.meta.url,
);

async function loadWorkflow() {
    return JSON.parse(await readFile(workflowUrl, 'utf8'));
}

describe('girls princess dress Etsy workflow preset', () => {
    it('is an importable four-node image-to-image workflow', async () => {
        const workflow = migrateWorkflowDefinition(await loadWorkflow());

        expect(workflow).toMatchObject({
            kind: 'flow-workflow',
            schemaVersion: 1,
            name: 'ETSY - Váy công chúa trẻ em - Nano Banana Pro',
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

    it('creates one independent square listing image for every source file', async () => {
        const workflow = await loadWorkflow();
        const input = workflow.nodes.find(node => node.id === 'girls-dress-product');
        const image = workflow.nodes.find(node => node.id === 'generate-girls-dress-listing');
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
            expect.objectContaining({ nodeId: 'girls-dress-product', batchInputType: 'image', folderInput: true }),
        ]);
        expect(schema.outputs).toEqual([
            expect.objectContaining({ nodeId: 'girls-dress-result' }),
        ]);
    });

    it('preserves product type, orientation and construction while removing advertising overlays', async () => {
        const workflow = await loadWorkflow();
        const prompt = workflow.nodes.find(node => node.id === 'girls-dress-master-prompt').data.prompt;

        expect(workflow.edges).toEqual(expect.arrayContaining([
            expect.objectContaining({
                source: 'girls-dress-product',
                target: 'generate-girls-dress-listing',
                sourceHandle: 'image-out',
                targetHandle: 'image-in',
            }),
            expect.objectContaining({
                source: 'girls-dress-master-prompt',
                target: 'generate-girls-dress-listing',
                sourceHandle: 'text-out',
                targetHandle: 'text-in',
            }),
        ]));
        expect(prompt).toContain('sole source of truth');
        expect(prompt).toContain('Do not introduce a child into a product-only image');
        expect(prompt).toContain('Never turn a back view into a front view');
        expect(prompt).toContain('REMOVE ADVERTISING, NOT PRODUCT DETAILS');
        expect(prompt).toContain('entire important garment visible');
        expect(prompt).toContain('exactly one clean 1:1 Etsy listing photograph');
    });
});
