import { afterEach, describe, expect, it, vi } from 'vitest';
import { beeknoeePromptClient } from '../../src/integrations/ai/BeeknoeePromptClient.js';
import { aiPromptExecutor } from '../../src/modules/workflow/nodes/aiPromptExecutor.js';

describe('AI prompt node executor', () => {
    afterEach(() => vi.restoreAllMocks());

    it('combines upstream text, node instruction and system message', async () => {
        const complete = vi.spyOn(beeknoeePromptClient, 'complete').mockResolvedValue('final visual prompt');
        const result = await aiPromptExecutor.execute({
            data: {
                model: 'gpt-5.5',
                systemMessage: 'You write visual prompts.',
                prompt: 'Make it cinematic.',
                maxTokens: 1200,
                stream: true,
                temperature: '',
            },
            resolved: { promptTexts: ['A cat by a window.'] },
            isCancelled: () => false,
        });

        expect(result).toEqual({
            results: [],
            textValue: 'final visual prompt',
            textValues: ['final visual prompt'],
        });
        expect(complete).toHaveBeenCalledWith(expect.objectContaining({
            model: 'gpt-5.5',
            maxTokens: 1200,
            temperature: undefined,
            messages: [
                { role: 'system', content: 'You write visual prompts.' },
                { role: 'user', content: 'A cat by a window.\n\nMake it cinematic.' },
            ],
        }));
    });

    it('rejects an empty input without calling the provider', async () => {
        const complete = vi.spyOn(beeknoeePromptClient, 'complete');
        await expect(aiPromptExecutor.execute({
            data: {},
            resolved: { promptTexts: [] },
            isCancelled: () => false,
        })).rejects.toMatchObject({ code: 'AI_PROMPT_INPUT_MISSING' });
        expect(complete).not.toHaveBeenCalled();
    });
});
