import path from 'node:path';
import { stat } from 'node:fs/promises';

// Preserve Super Image's ordered substring rules, including their broad matches.
export function classifyScene(sentence) {
    const s = String(sentence).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
    const rules = [
        ['emotion', ['khoc','so','hoang','dau','cam thay','buon','lo lang']],
        ['action', ['chay','di','giu','nem','tan cong','tim','cuu','nhay','leo']],
        ['environment', ['rung','dem','nui','song','bien','troi','mua','lua','hang','tuyet']],
        ['character', ['nguoi me','dua tre','co gai','chang trai','nhan vat','ong lao','ba gia']],
    ];
    return rules.find(([, words]) => words.some(w => s.includes(w)))?.[0] || 'general';
}
export function sceneTemplate(sentence, before, after, characterId) {
    return [
        'Create one illustrative still image for a narrated video.',
        `Current narration sentence: ${sentence}`,
        `Scene type: ${classifyScene(sentence)}.`,
        ...(before || after ? ['Adjacent narration context for disambiguation:', before && `Previous sentence: ${before}`, after && `Next sentence: ${after}`, 'Use the adjacent context only to clarify the target scene; the image must primarily illustrate the current narration sentence.'] : []),
        `Use @${characterId} as the recurring character in this scene. Keep the character design and illustration style consistent across all scenes.`,
    ].filter(Boolean).join('\n');
}
export function sharedConfiguration(def) {
    const nodes = type => def.nodes.filter(n => n.type === type);
    const allowed = ['audio-splitter','story-references','scene-template','upload-image','generate-image','result'];
    for (const type of allowed) {
        if (nodes(type).length !== 1) throw Error(`Workflow cần đúng một node ${type}.`);
    }
    if (def.nodes.some(n => !allowed.includes(n.type))) throw Error('Workflow audio chỉ hỗ trợ cắt audio, tham chiếu, ghép mẫu, upload và tạo ảnh.');
    const required = [['audio-splitter','scene-template','text-out','text-in-0'],['story-references','scene-template','text-out','text-in-1'],['scene-template','upload-image','image-out','image-in'],['scene-template','generate-image','text-out','text-in'],['upload-image','generate-image','image-out','image-in'],['generate-image','result','image-out','image-in']];
    if (def.edges?.length !== required.length || required.some(([source,target,sourceHandle,targetHandle]) => !def.edges.some(e=>e.source===nodes(source)[0].id&&e.target===nodes(target)[0].id&&e.sourceHandle===sourceHandle&&e.targetHandle===targetHandle))) throw Error('Kết nối workflow audio chưa đúng. Dùng sơ đồ trong workflow mẫu Audio → Ảnh.');
    const input = nodes('audio-splitter')[0], refs = nodes('story-references')[0], image = nodes('generate-image')[0];
    const characters = refs.data.characters || refs.data.document?.characters || [];
    const character = characters.find(c => c.character_id === refs.data.sharedCharacterId);
    const outfit = character?.outfits?.find(o => o.outfit_id === refs.data.sharedOutfitId);
    if (!character?.identity_description_en?.trim() || !outfit) throw Error('Chọn nhân vật chung và trang phục có mô tả.');
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(character.character_id)) throw Error('Mã nhân vật phải dùng chữ Latin, số và dấu gạch dưới.');
    const key = outfit.reference_key || character.reference_key;
    const library = refs.data.library || {};
    if (!library[key]?.path || library[key].reviewStatus !== 'approved') throw Error('Chọn và duyệt ảnh nhân vật trước khi chạy.');
    const style = String(refs.data.sharedStyle ?? refs.data.document?.style?.style_prompt_en ?? '').trim();
    if (!style) throw Error('Nhập style chung.');
    if (image.data.model === 'NARWHAL') image.data.model = 'BELUGA';
    if (!['GEM_PIX_2','BELUGA','HARBOR_SEAL'].includes(image.data.model)) throw Error('Chọn model tạo ảnh hỗ trợ tham chiếu.');
    const options = { model:image.data.model, maxReferences:refs.data.maxReferences || 8, referenceLimitVerified:refs.data.referenceLimitVerified === true && refs.data.verifiedModel === image.data.model };
    return {input, refs, image, character, outfit, key, style, library, options};
}
const time = ms => new Date(ms).toISOString().slice(11,23).replace('.', ',');
export function audioToStory(report, split, config) {
    const {character, outfit, key, style} = config;
    const entries = report.alignment;
    if (!entries?.length || entries.length > 500 || entries.length !== split.segments?.length) throw Error('Số câu/đoạn audio không hợp lệ (tối đa 500).');
    const segments = new Map(split.segments.map(s => [s.id, s]));
    if (segments.size !== entries.length) throw Error('ID đoạn audio trùng.');
    let end = 0;
    const scenes = entries.map((a, index) => {
        const s = segments.get(a.id);
        if (a.id !== index + 1 || !a.sentence?.trim() || !s || s.sentence !== a.sentence || !Number.isInteger(s.duration_ms) || s.duration_ms < 200 || s.segment_start_ms !== end || s.segment_end_ms - s.segment_start_ms !== s.duration_ms || !path.isAbsolute(s.audio_file)) throw Error(`Đoạn audio ${a.id} rỗng, sai ID hoặc timeline.`);
        if (!Number.isFinite(a.start_ms) || !Number.isFinite(a.end_ms) || a.start_ms < 0 || a.end_ms < a.start_ms) throw Error(`Alignment ${a.id} không hợp lệ.`);
        end = s.segment_end_ms;
        const id = character.character_id;
        return {
            scene_id:`SC${String(a.id).padStart(3,'0')}`, segment_id:a.id, audio_file:s.audio_file,
            source_text:a.sentence, start_ms:s.segment_start_ms, end_ms:end, duration_ms:s.duration_ms,
            start_time:time(s.segment_start_ms), end_time:time(end),
            alignment:{...a}, cut_start_ms:s.segment_start_ms, cut_end_ms:end,
            context_before:entries[index-1]?.sentence || '', context_after:entries[index+1]?.sentence || '',
            scene_type:classifyScene(a.sentence), visible_character_ids:[id], outfit_by_character:{[id]:outfit.outfit_id},
            style_id:'AUDIO_STYLE', reference_bindings:[{role:'character',character_id:id,outfit_id:outfit.outfit_id,reference_key:key},{role:'style',reference_key:config.refs.data.document?.style?.reference_key || 'STYLE_SHARED'}],
            prompt_en:sceneTemplate(a.sentence, entries[index-1]?.sentence, entries[index+1]?.sentence, id),
            negative_prompt_en:'No text, subtitles, logo, watermark, duplicate characters or altered identity.',
        };
    });
    if (end !== report.summary.audio_duration_ms) throw Error('Tổng thời lượng các đoạn không khớp audio.');
    return {schema_version:'story-prompts/v1',timing_mode:'audio-segments',title:'Audio Story',aspect_ratio:'16:9',characters:[structuredClone(character)],style:{style_id:'AUDIO_STYLE',reference_key:config.refs.data.document?.style?.reference_key || 'STYLE_SHARED',style_prompt_en:style},scenes};
}
export async function requireFile(file, label) {
    if (!path.isAbsolute(file || '') || !(await stat(file).catch(()=>null))?.isFile()) throw Error(`Thiếu file ${label}: ${file || '(chưa chọn)'}`);
}
