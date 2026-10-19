import { normalizePromptWorkflow } from './promptStory.js';
import { characterEntries } from '../nodes/characterGeneratorExecutor.js';

export function prepareCharacterDefinition(def, referenceNodeId, keys) {
    // Character preparation does not require a completed scene list.
    const originalInput = def.nodes.find(n => n.type === 'story-input');
    const working = structuredClone(def);
    const workingInput = working.nodes.find(n => ['story-input','audio-splitter'].includes(n.type));
    if (workingInput?.type === 'audio-splitter') workingInput.type = 'story-input';
    if (workingInput) workingInput.data.promptText = 'Empty landscape';
    def = normalizePromptWorkflow(working);
    const input = def.nodes.find(n => n.type === 'story-input');
    const refs = def.nodes.find(n => n.id === referenceNodeId && n.type === 'story-references');
    if (!input?.data.document || !refs) throw new Error('Import truyện và thêm Story References trước.');
    if (!Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length) throw new Error('Chọn mã nhân vật hợp lệ.');
    const doc = input.data.document;
    const catalog = (doc.characters || []).flatMap(c => (c.outfits?.length ? c.outfits : [{}]).map(o => ({
        reference_key: o.reference_key || c.reference_key,
        prompt: refs.data.characterPrompts?.[o.reference_key || c.reference_key] ?? [c.identity_description_en, o.description_en, 'Single character, full body, neutral pose, simple background, no text.'].filter(Boolean).join(' '),
    })));
    const entries = keys.map(key => {
        const matches = catalog.filter(e => e.reference_key === key);
        if (matches.length !== 1) throw new Error(`Mã thiếu hoặc trùng trong hồ sơ: ${key}`);
        return matches[0];
    });
    const data = { entries, outputDir: refs.data.characterOutputDir || input.data.outputDir,
        stylePrompt: refs.data.characterStyle ?? doc.style?.style_prompt_en ?? '',
        model: refs.data.characterModel || 'GEM_PIX_2', ratio: refs.data.characterRatio || '1:1' };
    characterEntries(data);
    if (data.model === 'NARWHAL') data.model = 'BELUGA';
    if (!['GEM_PIX_2','BELUGA','HARBOR_SEAL'].includes(data.model)) throw new Error('Model nhân vật không hợp lệ.');
    const nodes = entries.map((entry, index) => ({ id: `character_${index}`, type: 'character-generator', data: { ...data, entries: [entry] } }));
    const edges = nodes.slice(1).map((node, i) => ({ id: `sequence_${i}`, source: nodes[i].id, target: node.id, sourceHandle: 'image-out', targetHandle: 'image-in' }));
    return { definition: { ...def, nodes, edges }, entries };
}

export function characterRunSummary(run) {
    const preparation = run.inputOverrides?.__storyCharacters;
    if (!preparation) return null;
    return { id: run.id, status: run.status, error: run.error, referenceNodeId: preparation.referenceNodeId,
        createdAt: run.createdAt, entries: preparation.entries.map((entry, index) => {
            const state = run.nodeStates?.[`character_${index}`];
            return { ...entry, status: state?.status || 'pending', error: state?.error,
                results: (state?.results || []).filter(r => r.savedPath).map(r => ({ path: r.savedPath, url: r.url })) };
        }) };
}
