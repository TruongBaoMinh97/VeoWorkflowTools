import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { compileScene } from './storyScenes.js';

export function configureInlineStory(definition, project, fields) {
    const def = structuredClone(definition);
    const input = def.nodes.find(n => n.type === 'audio-splitter');
    const refs = def.nodes.find(n => n.type === 'story-references');
    const image = def.nodes.find(n => n.type === 'generate-image');
    if (!input || !refs || !image) throw Error('Chọn mẫu Story có TXT / Audio / SRT.');
    for (const key of ['txtPath','audioPath','srtPath','outputDir']) {
        if (typeof fields[key] !== 'string' || !path.isAbsolute(fields[key])) throw Error(`Chọn đường dẫn ${key}.`);
        input.data[key] = fields[key];
    }
    input.data.profileIds = project.profiles.map(p => p.profileId);
    input.data.sceneLimit = null;
    refs.data.sharedStyle = fields.style;
    const character = refs.data.characters?.find(c => c.character_id === refs.data.sharedCharacterId) || refs.data.characters?.[0];
    if (!character) throw Error('Mẫu Story chưa có nhân vật.');
    const outfit = character.outfits?.find(o => o.outfit_id === refs.data.sharedOutfitId) || character.outfits?.[0];
    const key = outfit?.reference_key || character.reference_key;
    if (!key || !fields.referencePath) throw Error('Chọn ảnh nhân vật.');
    character.identity_description_en = fields.characterDescription;
    refs.data.library = { ...refs.data.library, [key]: { path: fields.referencePath, reviewStatus: 'approved' } };
    image.data.model = project.imageModelKey || 'GEM_PIX_2';
    return def;
}

export async function readInlineStoryResult(root, runId) {
    if (!path.isAbsolute(root || '')) throw Error('Thư mục lượt chạy không hợp lệ.');
    const state = JSON.parse(await readFile(path.join(root,'audio-run.json'),'utf8'));
    if (state.runId !== runId || state.status !== 'COMPLETED') throw Error('Prompt chưa hoàn thành.');
    const snap = JSON.parse(await readFile(path.join(root,'story-manifest.json'),'utf8'));
    const scenes = snap.selectedSceneIds.map(id => snap.document.scenes.find(s => s.scene_id === id));
    const rows = scenes.map(scene => compileScene(snap.document,scene,snap.library,snap.options));
    const references = rows[0]?.images || [];
    if (!rows.length || rows.some(r => !r.ready || JSON.stringify(r.images.map(i=>i.path)) !== JSON.stringify(references.map(i=>i.path)))) throw Error('Bộ tham chiếu không đồng nhất.');
    return { prompts: scenes.map(s=>s.frozen_prompt), references };
}
