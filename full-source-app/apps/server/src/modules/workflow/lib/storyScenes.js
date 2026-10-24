import path from 'node:path';
import { stat, readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
export function storyId(value) {
    if (!ID.test(value || '') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) throw new Error(`Mã không an toàn: ${value}`);
    return value;
}
export function timestamp(value) {
    const match = /^(\d{2}):([0-5]\d):([0-5]\d),(\d{3})$/.exec(value || '');
    if (!match) throw new Error(`Timestamp không hợp lệ: ${value}`);
    return ((+match[1] * 60 + +match[2]) * 60 + +match[3]) * 1000 + +match[4];
}
export function parseStory(value) {
    const doc = typeof value === 'string' ? JSON.parse(value) : structuredClone(value);
    if (doc?.schema_version !== 'story-prompts/v1' || !Array.isArray(doc.scenes) || !doc.scenes.length) throw new Error('Cần JSON story-prompts/v1 có scenes.');
    if (doc.scenes.length > 500) throw new Error('Tối đa 500 cảnh mỗi bộ.');
    if (!Array.isArray(doc.characters) || !doc.style?.style_prompt_en?.trim()) throw new Error('Thiếu characters hoặc mô tả style.');
    const ids = doc.characters.map(c => storyId(c.character_id));
    if (new Set(ids).size !== ids.length) throw new Error('Mã nhân vật trùng.');
    return doc;
}
export function validateStorySrt(doc, text) {
    if (!text?.trim()) return;
    const cues = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim().split(/\n\s*\n/).map(block => {
        const lines = block.split('\n');
        const times = lines[1]?.split(' --> ');
        if (!/^\d+$/.test(lines[0]) || times?.length !== 2) throw new Error('SRT không hợp lệ.');
        return { id: +lines[0], start: timestamp(times[0]), end: timestamp(times[1]) };
    });
    if (cues.length !== doc.scenes.length || new Set(cues.map(c => c.id)).size !== cues.length) throw new Error('Số cảnh không khớp hoặc SRT trùng cue.');
    for (const [i, cue] of cues.entries()) {
        const scene = doc.scenes[i];
        if (scene.source_cue_ids?.length !== 1 || scene.source_cue_ids[0] !== cue.id || scene.start_ms !== cue.start || scene.end_ms !== cue.end || cue.end <= cue.start || (i && cue.start < cues[i-1].end)) throw new Error(`Cảnh ${scene.scene_id} không khớp SRT hoặc chồng thời gian.`);
    }
}
export async function hydrateStoryPayload(value) {
    const payload = typeof value === 'string' ? JSON.parse(value) : value;
    if (payload.snapshot) return payload;
    if (!path.isAbsolute(payload.snapshotPath || '') || path.basename(payload.snapshotPath) !== 'story-manifest.json') throw new Error('Snapshot truyện không hợp lệ.');
    return { ...payload, snapshot: JSON.parse(await readFile(payload.snapshotPath, 'utf8')) };
}
const GENERIC_CHAR_TOKENS = new Set(['home', 'out', 'outdoor', 'indoor', 'bank', 'work', 'default', 'young', 'old', 'past', 'char', 'main', 'woman', 'man', 'lady', 'girl', 'boy', 'wife', 'husband']);
function extractCharacterNameTokens(character) {
    const raw = [
        String(character?.character_id || '').split('_')[0],
        ...String(character?.display_name || '').split(/[^A-Za-z]+/),
    ];
    return [...new Set(
        raw
            .map(t => t.trim())
            .filter(t => t.length >= 3 && /^[A-Za-z]+$/.test(t) && !GENERIC_CHAR_TOKENS.has(t.toLowerCase()) && !/^char\d*$/i.test(t))
    )];
}

export function detectGhostCharacterWarnings(doc, scene) {
    const visibleIds = new Set(scene?.visible_character_ids || []);
    const characters = Array.isArray(doc?.characters) ? doc.characters : [];
    const visibleTokens = new Set();
    for (const c of characters) {
        if (visibleIds.has(c.character_id)) {
            for (const token of extractCharacterNameTokens(c)) visibleTokens.add(token.toLowerCase());
        }
    }
    const cleanPrompt = String(scene?.prompt_en || '').replace(/@[A-Za-z][A-Za-z0-9_]*/g, ' ');
    const warnings = [];
    const seenTokens = new Set();
    for (const c of characters) {
        if (visibleIds.has(c.character_id)) continue;
        for (const token of extractCharacterNameTokens(c)) {
            const lower = token.toLowerCase();
            if (visibleTokens.has(lower) || seenTokens.has(lower)) continue;
            const regex = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (regex.test(cleanPrompt)) {
                seenTokens.add(lower);
                warnings.push(`Cảnh ${scene.scene_id} nhắc tới tên "${token}" trong prompt nhưng không gắn thẻ @${c.character_id} (dễ làm AI vẽ thừa người hoặc rò rỉ câu mẫu).`);
            }
        }
    }
    return warnings;
}

export function compileScene(doc, scene, library = {}, options = {}) {
    storyId(scene.scene_id);
    if (doc.scenes.filter(s => s.scene_id === scene.scene_id).length !== 1) throw new Error('Mã cảnh trùng.');
    if (doc.timing_mode !== 'none') {
    const start = timestamp(scene.start_time), end = timestamp(scene.end_time);
    if (end <= start || scene.start_ms !== start || scene.end_ms !== end) throw new Error('Thời gian cảnh không khớp.');
    }
    const ids = scene.visible_character_ids;
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw new Error('Danh sách nhân vật không hợp lệ.');
    const bindings = scene.reference_bindings || [];
    const charBindings = bindings.filter(b => b.role === 'character');
    if (charBindings.length !== ids.length || charBindings.some(b => !ids.includes(b.character_id))) throw new Error('Bindings không khớp nhân vật.');
    const mentioned = [...String(scene.prompt_en || '').matchAll(/@([A-Za-z][A-Za-z0-9_]*)/g)].map(m => m[1]);
    if (mentioned.some(id => !ids.includes(id)) || ids.some(id => !mentioned.includes(id))) throw new Error('Mã @ trong prompt không khớp nhân vật.');
    if (!scene.prompt_en?.trim()) throw new Error('Thiếu prompt cảnh.');
    const warnings = detectGhostCharacterWarnings(doc, scene);
    const images = [], instructions = [], missing = [];
    let prompt = scene.prompt_en;
    for (const id of ids) {
        const character = doc.characters.find(c => c.character_id === id);
        if (!character) throw new Error(`Không tìm thấy nhân vật ${id}`);
        const matching = charBindings.filter(b => b.character_id === id);
        const binding = matching[0];
        const outfit = character.outfits?.find(o => o.outfit_id === binding?.outfit_id);
        if (matching.length !== 1 || !outfit || scene.outfit_by_character?.[id] !== binding.outfit_id) throw new Error(`Trang phục/binding không hợp lệ: ${id}`);
        const key = outfit.reference_key || character.reference_key;
        if (!key || binding.reference_key !== key) throw new Error(`Sai reference_key của ${id}`);
        const entry = library[key];
        if (entry?.generated && entry.reviewStatus !== 'approved') throw new Error(`Ảnh nhân vật ${key} chưa được duyệt.`);
        if (!entry?.path) missing.push(key);
        else images.push({ key, path: entry.path, role: 'character', characterId: id });
        const description = `${character.display_name || id}: ${character.identity_description_en || ''}. ${outfit.description_en || ''}`;
        prompt = prompt.replace(new RegExp(`@${id}\\b`, 'g'), character.display_name || id);
        instructions.push(`${entry?.path ? `Reference image ${images.length}` : `Missing reference ${key}`}: ${description}. Preserve this character's identity; do not exchange face or outfit with another character.`);
    }
    const styleBindings = bindings.filter(b => b.role === 'style');
    if (styleBindings.length !== 1 || styleBindings[0].reference_key !== doc.style.reference_key || scene.style_id !== doc.style.style_id || bindings.length !== charBindings.length + 1) throw new Error('Style binding không hợp lệ.');
    const stylePath = library[doc.style.reference_key]?.path;
    if (stylePath) {
        images.push({ key: doc.style.reference_key, path: stylePath, role: 'style' });
        instructions.push(`Reference image ${images.length}: style only. Do not copy people or objects from this image into the scene.`);
    }
    const limit = Math.min(8, Math.max(0, Number(options.maxReferences ?? 8)));
    if (images.length > limit) throw new Error(`Cảnh cần ${images.length} ảnh; giới hạn cấu hình ${limit}. Không bỏ tham chiếu tự động.`);
    const style = doc.style.style_prompt_en.trim();
    if (!prompt.includes(style)) prompt = `${style}\n${prompt}`;
    prompt = `${instructions.join('\n')}\nAspect ratio: ${doc.aspect_ratio || '16:9'}.\n${prompt}\nAvoid: ${scene.negative_prompt_en || 'Text, watermark, duplicate or additional characters.'}`;
    return { scene, prompt, images, missing, warnings, ready: !missing.length, referenceLimitVerified: options.referenceLimitVerified === true };
}
export async function previewStory(document, library = {}, options = {}) {
    const doc = parseStory(document);
    validateStorySrt(doc, options.srtText);
    const rows = [];
    for (const scene of doc.scenes) {
        try {
            const prepared = compileScene(doc, scene, library, options);
            for (const image of prepared.images) {
                if (!path.isAbsolute(image.path) || !/\.(png|jpe?g|webp)$/i.test(image.path)) throw new Error(`Ảnh không hợp lệ: ${image.key}`);
                if (!(await stat(image.path)).isFile()) throw new Error(`Không đọc được ảnh: ${image.key}`);
            }
            rows.push({ ...prepared, error: prepared.missing.length ? `Thiếu ảnh: ${prepared.missing.join(', ')}` : null });
        } catch (error) { rows.push({ scene, ready: false, error: error.message, images: [] }); }
    }
    return { document: doc, rows };
}
export async function snapshotStory(document, library, options, outputDir, selectedIds) {
    if (!path.isAbsolute(outputDir || '')) throw new Error('Chọn thư mục đầu ra tuyệt đối.');
    const preview = await previewStory(document, library, options);
    const selected = preview.rows.filter(r => !selectedIds?.length || selectedIds.includes(r.scene.scene_id));
    if (selectedIds?.some(id => !preview.document.scenes.some(s => s.scene_id === id))) throw new Error('Danh sách chọn có mã cảnh không tồn tại.');
    if (!selected.length || selected.some(r => !r.ready)) throw new Error('Cảnh đã chọn còn lỗi hoặc chưa chọn cảnh hợp lệ.');
    if (!options.referenceLimitVerified && selected.length > 4) throw new Error('Hãy chạy thử tối đa 4 cảnh và xác nhận giới hạn/độ giống trước khi chạy cả truyện.');
    const root = path.join(outputDir, `story_${randomUUID()}`);
    await mkdir(path.join(root, 'references'), { recursive: true });
    const frozenLibrary = {};
    const images = new Map(selected.flatMap(r => r.images).map(i => [i.key, i]));
    for (const [key, image] of images) {
        const bytes = await readFile(image.path);
        const hash = createHash('sha256').update(bytes).digest('hex');
        const target = path.join(root, 'references', hash + path.extname(image.path).toLowerCase());
        await writeFile(target, bytes);
        frozenLibrary[key] = { path: target, sha256: hash };
    }
    const snapshot = { document: preview.document, library: frozenLibrary, options, root, revision: randomUUID() };
    await writeFile(path.join(root, 'story-manifest.json'), JSON.stringify({ ...snapshot, selectedSceneIds: selected.map(r => r.scene.scene_id) }, null, 2));
    if (options.srtText) await writeFile(path.join(root, 'subtitles.srt'), options.srtText, 'utf8');
    return { snapshot, selected };
}
