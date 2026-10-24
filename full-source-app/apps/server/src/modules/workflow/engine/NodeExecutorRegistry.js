import { createBuiltinNodeExecutors } from '../nodes/builtinExecutors.js';

export class NodeExecutorRegistry {
    constructor() {
        this.executors = new Map();
    }

    register(executor) {
        if (!executor?.type || typeof executor.execute !== 'function') {
            throw new TypeError('Node executor requires a type and execute(context) function');
        }
        if (this.executors.has(executor.type)) {
            throw new Error(`Node executor already registered: ${executor.type}`);
        }
        this.executors.set(executor.type, Object.freeze({ version: 1, ...executor }));
        return this;
    }

    has(type) {
        return this.executors.has(type);
    }

    list() {
        return [...this.executors.values()].map(({ type, version, legacy = false }) => ({
            type,
            version,
            implementation: legacy ? 'legacy-adapter' : 'standalone',
        }));
    }

    async execute(type, context) {
        const executor = this.executors.get(type);
        if (!executor) {
            throw new Error(`Unknown node type: '${String(type)}'`);
        }
        return executor.execute(context);
    }
}

export const BUILTIN_NODE_VERSIONS = Object.freeze({
    'audio-splitter': 1, 'scene-template': 1,
    'character-generator': 1, 'story-input': 1, 'story-references': 1, 'scene-prepare': 1,
    prompt: 1,
    'ai-prompt': 1,
    chatgpt: 1,
    'template-merge': 1,
    'save-images': 1,
    'image-review': 1,
    'gemini-script': 1,
    'upload-image': 1,
    'folder-input': 1,
    'generate-image': 1,
    'generate-video': 1,
    'upscale-image': 1,
    'upscale-video': 1,
    'merge-video': 1,
    'extract-endframe': 1,
    'remove-image-logo': 1,
    'remove-video-logo': 1,
    result: 1,
});

export function createDefaultNodeExecutorRegistry() {
    const registry = new NodeExecutorRegistry();

    for (const executor of createBuiltinNodeExecutors())
        registry.register(executor);

    // Complex executors are registered independently now and can be moved out
    // one by one without changing graph scheduling or run persistence.
    for (const [type, version] of Object.entries(BUILTIN_NODE_VERSIONS)) {
        if (registry.has(type))
            continue;
        registry.register({
            type,
            version,
            legacy: true,
            execute: ({ executeLegacy }) => executeLegacy(),
        });
    }
    return registry;
}

export function getDefaultNodeExecutorCatalog() {
    return createDefaultNodeExecutorRegistry().list();
}
