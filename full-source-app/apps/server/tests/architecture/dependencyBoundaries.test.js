import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('workflow dependency boundaries', () => {
    it('keeps external implementation details out of the workflow engine', async () => {
        const source = await readFile(
            new URL('../../src/modules/workflow/workflow.engine.js', import.meta.url),
            'utf8',
        );

        expect(source).not.toMatch(/import\s+\{\s*prisma\s*\}/);
        expect(source).not.toMatch(/captchaManager/);
        expect(source).not.toMatch(/new\s+Veo3Service\s*\(/);
        expect(source).not.toMatch(/accountLocaleService/);
        expect(source).toMatch(/flowGatewayFactory\.create/);
        expect(source).toMatch(/nodeExecutorRegistry\.execute/);
    });
});
