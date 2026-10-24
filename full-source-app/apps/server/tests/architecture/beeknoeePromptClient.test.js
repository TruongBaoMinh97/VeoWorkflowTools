import { describe, expect, it, vi } from 'vitest';
import { BeeknoeePromptClient } from '../../src/integrations/ai/BeeknoeePromptClient.js';

describe('BeeknoeePromptClient', () => {
    it('builds a non-streaming OpenAI-compatible request', async () => {
        const fetchImpl = vi.fn(async (_url, init) => new Response(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'generated prompt' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const client = new BeeknoeePromptClient({
            fetchImpl,
            getApiKey: async () => 'secret-key',
        });

        await expect(client.complete({
            model: 'deepseek/deepseek-v3.2',
            messages: [{ role: 'user', content: 'write a prompt' }],
            maxTokens: 900,
            stream: false,
        })).resolves.toBe('generated prompt');

        const [, init] = fetchImpl.mock.calls[0];
        expect(init.headers.Authorization).toBe('Bearer secret-key');
        expect(JSON.parse(init.body)).toEqual({
            model: 'deepseek/deepseek-v3.2',
            messages: [{ role: 'user', content: 'write a prompt' }],
            max_tokens: 900,
            stream: false,
        });
    });

    it('combines content from an SSE stream', async () => {
        const stream = [
            'data: {"choices":[{"delta":{"content":"cinematic "}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"prompt"}}]}\n\n',
            'data: [DONE]\n\n',
        ].join('');
        const client = new BeeknoeePromptClient({
            fetchImpl: async () => new Response(stream, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' },
            }),
            getApiKey: async () => 'secret-key',
        });

        await expect(client.complete({
            model: 'claude-sonnet-4-6',
            messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }],
            stream: true,
        })).resolves.toBe('cinematic prompt');
    });

    it('reports a missing API key as non-retryable', async () => {
        const client = new BeeknoeePromptClient({
            fetchImpl: vi.fn(),
            getApiKey: async () => null,
        });
        await expect(client.complete({ model: 'model', messages: [] })).rejects.toMatchObject({
            code: 'BEEKNOEE_API_KEY_MISSING',
            retryable: false,
        });
    });
});
