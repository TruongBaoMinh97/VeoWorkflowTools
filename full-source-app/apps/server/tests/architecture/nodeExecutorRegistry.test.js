import { describe, expect, it, vi } from 'vitest';
import {
    NodeExecutorRegistry,
    createDefaultNodeExecutorRegistry,
} from '../../src/modules/workflow/engine/NodeExecutorRegistry.js';

describe('NodeExecutorRegistry', () => {
    it('runs a registered executor', async () => {
        const execute = vi.fn(() => ({ results: [], textValue: 'ok' }));
        const registry = new NodeExecutorRegistry().register({ type: 'custom', execute });

        await expect(registry.execute('custom', { value: 1 })).resolves.toEqual({
            results: [],
            textValue: 'ok',
        });
        expect(execute).toHaveBeenCalledWith({ value: 1 });
    });

    it('rejects duplicate and unknown node types', async () => {
        const registry = new NodeExecutorRegistry().register({ type: 'custom', execute: () => ({}) });
        expect(() => registry.register({ type: 'custom', execute: () => ({}) })).toThrow(/already registered/);
        await expect(registry.execute('missing', {})).rejects.toThrow(/Unknown node type/);
    });

    it('executes migrated built-in nodes without the legacy dispatcher', async () => {
        const registry = createDefaultNodeExecutorRegistry();
        const executeLegacy = vi.fn();

        await expect(registry.execute('prompt', {
            data: { prompt: 'hello' },
            resolved: { imageResults: [], videoResults: [] },
            executeLegacy,
        })).resolves.toEqual({ results: [], textValue: 'hello' });
        await expect(registry.execute('result', {
            data: {},
            resolved: {
                imageResults: [{ kind: 'image' }],
                videoResults: [{ kind: 'video' }],
            },
            executeLegacy,
        })).resolves.toEqual({ results: [{ kind: 'image' }, { kind: 'video' }] });
        expect(executeLegacy).not.toHaveBeenCalled();
    });

    it('exposes which built-ins are standalone and which are compatibility adapters', () => {
        const catalog = createDefaultNodeExecutorRegistry().list();
        expect(catalog.find((item) => item.type === 'upload-image')?.implementation).toBe('standalone');
        expect(catalog.find((item) => item.type === 'ai-prompt')?.implementation).toBe('standalone');
        expect(catalog.find((item) => item.type === 'generate-video')?.implementation).toBe('legacy-adapter');
    });
});
