import { describe, expect, it, vi, afterEach } from 'vitest';
import { compileEtsyFlowPrompt } from '../../src/modules/workflow/lib/etsyFlowPrompt.js';
import { aiPromptExecutor } from '../../src/modules/workflow/nodes/aiPromptExecutor.js';
import { beeknoeePromptClient } from '../../src/integrations/ai/BeeknoeePromptClient.js';
const images = [{ url: 'https://example.com/dress.png', referenceRole: 'garment' }];
const fixture = () => ({ version: 1, status: 'ready', issues: [], kind: 'garment', references: [{ index: 1, role: 'garment', description: 'Silver dress with visible waist tie.' }], sections: { model: 'Preserve the existing subject.', garment: 'Keep the silver fabric and waist tie exactly.', pose: 'Keep the original orientation.', composition: 'One image, preserve framing.', background: 'Neutral interior.', lighting: 'Soft neutral light without recoloring.', branding: 'No logo or text.', negative: 'No added accessories.', finalCheck: 'Compare neckline and waist tie with reference.' }, chart: null });
afterEach(() => vi.restoreAllMocks());
describe('Etsy master to Flow contract', () => {
    it('renders one clean English prompt with ordered master headings and mandatory garment protection', () => {
        const result = compileEtsyFlowPrompt('```json\n' + JSON.stringify(fixture()) + '\n```', images);
        expect(result.startsWith('REFERENCE\n')).toBe(true);
        expect(result).toContain('GARMENT – HIGHEST PRIORITY\nKeep the silver');
        expect(result).toContain('Do not add shorts, pants');
        expect(result).not.toContain('```'); expect(result).not.toContain('"status"');
    });
    it('rejects malformed/truncated output and missing headings instead of sending it to Flow', () => {
        expect(() => compileEtsyFlowPrompt('Here is your prompt', images)).toThrow();
        const value = fixture(); delete value.sections.pose;
        expect(() => compileEtsyFlowPrompt(JSON.stringify(value), images)).toThrow();
    });
    it('blocks unresolved evidence and changed or invented reference roles', () => {
        const value = fixture(); value.status = 'needs_review'; value.issues = ['Please provide the actual back view.'];
        expect(() => compileEtsyFlowPrompt(JSON.stringify(value), images)).toThrow(/actual back view/);
        value.status = 'ready'; value.issues = []; value.references[0].role = 'pose';
        expect(() => compileEtsyFlowPrompt(JSON.stringify(value), images)).toThrow(/vai trò/);
        value.references[0].role = 'garment'; value.references.push({ ...value.references[0] });
        expect(() => compileEtsyFlowPrompt(JSON.stringify(value), images)).toThrow(/vai trò/);
    });
    it('preserves chart strings including decimals, ranges, blank cells and units without arithmetic', () => {
        const value = fixture(); value.kind = 'size_chart';
        value.chart = { headers: ['Size', 'Bust (cm)', 'Length (cm)'], rows: [['S', '67.0–69.5', ''], ['XL', '83', '120.00']], notes: ['Tolerance 1–2 cm.'] };
        const result = compileEtsyFlowPrompt(JSON.stringify(value), images);
        expect(result).toContain('FINAL DATA CHECK');
        expect(result).toContain('67.0–69.5'); expect(result).toContain('120.00'); expect(result).not.toContain('XS');
        value.chart.rows[0].pop();
        expect(() => compileEtsyFlowPrompt(JSON.stringify(value), images)).toThrow(/lệch cột/);
    });
    it('requires actual references and compiles model JSON before exposing downstream text', async () => {
        const complete = vi.spyOn(beeknoeePromptClient, 'complete').mockResolvedValue(JSON.stringify(fixture()));
        await expect(aiPromptExecutor.execute({ data: { outputFormat: 'etsy-flow-v1' }, resolved: { promptTexts: [] } })).rejects.toMatchObject({ code: 'ETSY_REFERENCE_REQUIRED' });
        expect(complete).not.toHaveBeenCalled();
        const result = await aiPromptExecutor.execute({ data: { outputFormat: 'etsy-flow-v1', model: 'vision-model', systemMessage: 'Master product rules', prompt: 'Change only the background.' }, resolved: { promptTexts: [], imageResults: images } });
        expect(result.textValue).toMatch(/^REFERENCE\n/); expect(result.textValues).toEqual([result.textValue]);
        const request = complete.mock.calls[0][0];
        expect(request.messages[0].content).toContain('Master product rules');
        expect(request.messages[0].content).toContain('WORKFLOW OUTPUT CONTRACT');
    });
});
