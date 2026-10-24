import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { templateMergeExecutor as executor } from '../../src/modules/workflow/nodes/templateMergeExecutor.js';
import { NonRetryableNodeError } from '../../src/modules/workflow/engine/WorkflowNodeError.js';
import { createDefaultNodeExecutorRegistry } from '../../src/modules/workflow/engine/NodeExecutorRegistry.js';
import { resolveInputs } from '../../src/modules/workflow/workflow.engine.js';
import { aiPromptExecutor } from '../../src/modules/workflow/nodes/aiPromptExecutor.js';
import { migrateWorkflowDefinition } from '../../src/modules/workflow/versioning/workflowVersioning.js';
const template = '{GARMENT_DESCRIPTION} / {BACKGROUND} / {SPECIFIC_NEGATIVES}';
const json = JSON.stringify({ garment_description: 'Ivory dress', background: 'Studio', specific_negatives: 'No added pockets' });
const merge = (texts, data = {}) => executor.execute({ data, resolved: { promptTexts: texts } });
describe('Template Merge', () => {
    it('merges all occurrences without interpreting replacement strings or recursively expanding values', () => {
        expect(merge([template, json]).textValue).toBe('Ivory dress / Studio / No added pockets');
        expect(merge(['{A} {A} {B}', '{"a":"$& {B}","b":"blue"}'], { placeholders: ['{A}', '{B}'], jsonKeys: ['a', 'b'] }).textValue).toBe('$& {B} $& {B} blue');
    });
    it('accepts fenced JSON', () => {
        expect(merge([template, '```json\n' + json + '\n```']).textValue).toBe(merge([template, json]).textValue);
    });
    it('normalizes specific_negatives string lists while preserving literal prompt text', () => {
        const payload = JSON.stringify({ specific_negatives: [' Không đổi màu ', '', '  ', 'Không thêm tay áo', '$& {BACKGROUND}'] });
        expect(merge(['{SPECIFIC_NEGATIVES}', payload]).textValue).toBe('Không đổi màu\nKhông thêm tay áo\n$& {BACKGROUND}');
        expect(merge(['{CUSTOM}', payload], { placeholders: ['{CUSTOM}'], jsonKeys: ['specific_negatives'] }).textValue).toBe('Không đổi màu\nKhông thêm tay áo\n$& {BACKGROUND}');
        expect(merge(['{SPECIFIC_NEGATIVES}', '{"specific_negatives":[]}']).textValue).toBe('');
    });
    it.each([[null], [1], [true], [{}], [['nested']], ['valid', 2]].map(value => ({ value })))('rejects malformed negative lists ($value)', ({ value }) => {
        expect(() => merge([template, JSON.stringify({ specific_negatives: value })])).toThrow(NonRetryableNodeError);
    });
    it('keeps strict validation for other fields and negative objects', () => {
        for (const payload of [{ background: ['studio'] }, { garment_description: ['dress'] }, { specific_negatives: { text: 'no pockets' } }])
            expect(() => merge([template, JSON.stringify(payload)])).toThrow(NonRetryableNodeError);
    });
    it('falls back to raw text and clears other placeholders', () => {
        expect(merge([template, 'not JSON']).textValue).toBe('not JSON /  / ');
    });
    it.each([[undefined, json], [template, ''], [template, '{"type":"size_chart"}'], [template, 'null']])('rejects missing or invalid input without retries (%j)', (first, second) => {
        expect(() => merge([first, second])).toThrow(NonRetryableNodeError);
    });
    it('rejects mismatched configuration', () => {
        expect(() => merge([template, json], { placeholders: ['{A}'], jsonKeys: [] })).toThrow(NonRetryableNodeError);
    });
    it('executes the supplied workflow through the registry, preserving model separation and port order after moving nodes', async () => {
        const workflow = migrateWorkflowDefinition(JSON.parse(await readFile(new URL('../../../../../docs/workflows/ETSY-FOLDER-CHATGPT.json', import.meta.url), 'utf8')));
        const registry = createDefaultNodeExecutorRegistry();
        expect(registry.has('template-merge')).toBe(true);
        const staticNode = workflow.nodes.find(node => node.id === 'static-prompt');
        staticNode.position.x = 9999;
        const states = { 'static-prompt': { textValue: staticNode.data.prompt }, ai: { textValue: json },
            product: { results: [{ url: 'product.png', referenceRole: 'garment' }] },
            'model-ref': { results: [{ url: 'model.png', referenceRole: 'model' }] } };
        const node = workflow.nodes.find(node => node.type === 'template-merge');
        const resolved = resolveInputs(node.id, workflow.edges, workflow.nodes, states);
        const merged = await registry.execute(node.type, { data: node.data, resolved });
        expect(merged.textValue).toContain('Ivory dress');
        expect(merged.textValue).not.toMatch(/\{(?:GARMENT_DESCRIPTION|BACKGROUND|SPECIFIC_NEGATIVES)\}/);
        states.merge = merged;
        const imageInput = resolveInputs('image', workflow.edges, workflow.nodes, states);
        expect(imageInput.promptTexts).toEqual([merged.textValue]);
        expect(imageInput.imageResults).toHaveLength(2);
        expect(resolveInputs('ai', workflow.edges, workflow.nodes, states).imageResults).toEqual(states.product.results);
        const missing = resolveInputs('merge', workflow.edges.filter(edge => edge.source !== 'static-prompt'), workflow.nodes, states);
        expect(() => merge(missing.promptTexts)).toThrow(/không có template/);
    });
    it('supports legacy handleless edges and uses canvas order', () => {
        const nodes = [{ id: 't', type: 'prompt', position: { x: 0 } }, { id: 'a', type: 'chatgpt', position: { x: 1 } }, { id: 'm', type: 'template-merge' }, { id: 'out', type: 'generate-image' }];
        const states = { t: { textValue: template }, a: { textValue: json }, m: { textValue: 'merged' } };
        expect(resolveInputs('m', [{ source: 'a', target: 'm' }, { source: 't', target: 'm' }], nodes, states).promptTexts).toEqual([template, json]);
        expect(resolveInputs('out', [{ source: 'm', target: 'out' }], nodes, states).promptTexts).toEqual(['merged']);
    });
    it.each(['', 'raw'])('returns raw JSON with images, without injecting full-prompt instructions (%j)', async outputFormat => {
        const output = await aiPromptExecutor.execute({ data: { model: 'test', prompt: 'Return three JSON fields.', outputFormat },
            resolved: { promptTexts: [], imageResults: [{ url: 'https://example.test/product.png', referenceRole: 'garment' }] },
            promptClient: { complete: async ({ messages }) => {
                const request = JSON.stringify(messages);
                expect(request).not.toContain('Return only the complete image-generation prompt');
                expect(request).not.toContain('ETSY FLOW v1 JSON');
                return json;
            } } });
        expect(output.textValue).toBe(json);
    });
});
