import { storyId } from './storyScenes.js';

// One nonempty line is one scene (lines starting with # are treated as QA comments). Optional prefix: SC001 | prompt with @AN.
export function parsePromptLines(text) {
    if (typeof text !== 'string' || text.length > 1000000) throw new Error('Danh sách prompt không hợp lệ hoặc quá dài.');
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
    if (!lines.length || lines.length > 500) throw new Error('Nhập từ 1 đến 500 prompt, mỗi dòng một cảnh.');
    const seen = new Set();
    return lines.map((line, index) => {
        const match = line.match(/^([A-Za-z0-9_-]+)\s*\|\s*(.+)$/);
        const scene_id = match ? match[1] : `SC${String(index + 1).padStart(3, '0')}`;
        storyId(scene_id);
        if (seen.has(scene_id)) throw new Error(`Trùng mã cảnh ${scene_id}`);
        seen.add(scene_id);
        const prompt_en = match ? match[2] : line;
        const visible_character_ids = [...new Set([...prompt_en.matchAll(/@([A-Za-z][A-Za-z0-9_]*)/g)].map(m => m[1]))];
        return { scene_id, prompt_en, visible_character_ids };
    });
}

export function parsePromptPatch(patchInput) {
    if (patchInput && typeof patchInput === 'object') {
        const list = Array.isArray(patchInput) ? patchInput : patchInput.patches || patchInput.scenes;
        if (!Array.isArray(list) || !list.length) throw new Error('Bản vá JSON không có danh sách patches/scenes.');
        const seen = new Set();
        return list.map((item, idx) => {
            const scene_id = String(item?.sceneId ?? item?.scene_id ?? item?.id ?? '').trim();
            const prompt_en = String(item?.prompt ?? item?.prompt_en ?? '').trim();
            const reason = String(item?.reason ?? item?.note ?? item?.error ?? '').trim();
            if (!scene_id || !prompt_en) throw new Error(`Bản vá dòng ${idx + 1} thiếu mã cảnh hoặc prompt.`);
            storyId(scene_id);
            if (/\r|\n|\|/.test(prompt_en)) throw new Error(`Prompt vá của cảnh ${scene_id} phải nằm trên một dòng và không chứa ký tự |.`);
            if (seen.has(scene_id)) throw new Error(`Trùng mã cảnh ${scene_id} trong bản vá.`);
            seen.add(scene_id);
            return { scene_id, prompt_en, reason };
        });
    }
    if (typeof patchInput !== 'string' || !patchInput.trim()) throw new Error('Nội dung bản vá cảnh lỗi trống.');
    const trimmed = patchInput.replace(/^\uFEFF/, '').trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        let parsed;
        try { parsed = JSON.parse(trimmed); } catch { throw new Error('JSON bản vá cảnh lỗi không hợp lệ.'); }
        return parsePromptPatch(parsed);
    }
    const rawLines = trimmed.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const entries = [];
    const seen = new Set();
    let pendingComments = [];
    for (const line of rawLines) {
        if (line.startsWith('#')) {
            const cleanComment = line.replace(/^#+\s*/, '').trim();
            if (cleanComment) pendingComments.push(cleanComment);
            continue;
        }
        const match = line.match(/^([A-Za-z0-9_-]+)\s*\|\s*(.+)$/);
        if (!match) throw new Error(`Dòng bản vá phải có định dạng "MÃ_CẢNH | prompt": ${line.slice(0, 60)}`);
        const scene_id = match[1].trim();
        const prompt_en = match[2].trim();
        storyId(scene_id);
        if (seen.has(scene_id)) throw new Error(`Trùng mã cảnh ${scene_id} trong bản vá.`);
        seen.add(scene_id);
        entries.push({ scene_id, prompt_en, reason: pendingComments.join(' · ') });
        pendingComments = [];
    }
    if (!entries.length) throw new Error('Không tìm thấy dòng cảnh hợp lệ (MÃ_CẢNH | prompt) trong bản vá.');
    return entries;
}

export function mergePromptPatch(existingText, patchInput, options = {}) {
    const patches = parsePromptPatch(patchInput);
    const patchMap = new Map(patches.map(p => [p.scene_id, p]));
    const notes = Object.fromEntries(patches.filter(p => p.reason).map(p => [p.scene_id, p.reason]));
    const currentRaw = typeof existingText === 'string' ? existingText.replace(/^\uFEFF/, '').trim() : '';
    if (!currentRaw) {
        return {
            text: patches.map(p => `${p.scene_id} | ${p.prompt_en}`).join('\n'),
            patchedSceneIds: patches.map(p => p.scene_id),
            notes,
            count: patches.length,
        };
    }
    const currentScenes = parsePromptLines(currentRaw);
    const existingIds = new Set(currentScenes.map(s => s.scene_id));
    const unknownIds = patches.map(p => p.scene_id).filter(id => !existingIds.has(id));
    if (unknownIds.length && !options.allowAppend) {
        throw new Error(`Mã cảnh trong bản vá không tồn tại trong danh sách hiện tại: ${unknownIds.join(', ')}.`);
    }
    const mergedLines = currentScenes.map(scene => {
        const patched = patchMap.get(scene.scene_id);
        return `${scene.scene_id} | ${patched ? patched.prompt_en : scene.prompt_en}`;
    });
    if (options.allowAppend) {
        for (const id of unknownIds) {
            const p = patchMap.get(id);
            mergedLines.push(`${p.scene_id} | ${p.prompt_en}`);
        }
    }
    return {
        text: mergedLines.join('\n'),
        patchedSceneIds: patches.map(p => p.scene_id),
        notes,
        count: patches.length,
    };
}

export function normalizePromptWorkflow(definition) {
    const def = structuredClone(definition);
    const input = def.nodes.find(n => n.type === 'story-input');
    const refs = def.nodes.find(n => n.type === 'story-references');
    if (!input || !refs) throw new Error('Cần node prompt và node nhân vật.');
    const legacy = input.data.document || refs.data.document;
    const characters = refs.data.characters ?? legacy?.characters ?? [];
    const commonStyle = refs.data.sharedStyle ?? refs.data.characterStyle ?? legacy?.style?.style_prompt_en ?? '';
    if (!commonStyle.trim()) throw new Error('Nhập style chung ở node nhân vật.');
    const style = { ...(legacy?.style || {}), style_id: legacy?.style?.style_id || 'SHARED_STYLE', reference_key: legacy?.style?.reference_key || 'STYLE_SHARED', style_prompt_en: commonStyle };
    if (input.data.promptText === undefined) {
        if (!legacy) throw new Error('Chưa nhập prompt.');
        input.data.document = { ...legacy, characters, style };
    } else {
        const scenes = parsePromptLines(input.data.promptText).map(scene => {
            const outfit_by_character = {}, reference_bindings = [];
            for (const id of scene.visible_character_ids) {
                const matches = characters.filter(c => c.character_id === id);
                if (matches.length !== 1) throw new Error(`Cảnh ${scene.scene_id}: mã @${id} chưa có hoặc bị trùng trong node nhân vật.`);
                const c = matches[0], outfit = c.outfits?.[0];
                if (!outfit) throw new Error(`Nhân vật ${id} thiếu cấu hình trang phục.`);
                outfit_by_character[id] = outfit.outfit_id;
                reference_bindings.push({ role:'character', character_id:id, outfit_id:outfit.outfit_id, reference_key:outfit.reference_key || c.reference_key });
            }
            reference_bindings.push({ role:'style', reference_key:style.reference_key });
            return { ...scene, outfit_by_character, reference_bindings, style_id:style.style_id };
        });
        input.data.document = { schema_version:'story-prompts/v1', timing_mode:'none', title:legacy?.title || 'Bộ ảnh từ prompt', characters, style,
            aspect_ratio: input.data.aspectRatio || legacy?.aspect_ratio || '16:9', scenes };
        input.data.srtText = '';
    }
    refs.data.characterStyle = commonStyle;
    refs.data.document = input.data.document;
    return def;
}
