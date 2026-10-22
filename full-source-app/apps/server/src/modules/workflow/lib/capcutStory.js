import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import template from './capcutStoryTemplate.js';
import { resolveFfprobeBinary } from '../../../utils/ffmpegResolver.js';

const execute = promisify(execFile);
const slash = p => p.replace(/\\/g, '/');
const json = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const audioExtensions = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg']);

export function defaultCapcutRoot() {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft');
}
export function imageBatches(project) {
    const groups = new Map();
    for (const job of project.jobs || []) if (job.mode === 'IMAGE_GENERATION' && !job.parentJobId) {
        const key = job.batchIndex ?? 0;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(job);
    }
    return [...groups].sort((a, b) => b[0] - a[0]).map(([batchIndex, jobs]) => ({
        batchIndex,
        jobs: jobs.sort((a, b) => a.jobIndex - b.jobIndex),
    }));
}

export function jobSceneId(job) {
    const prompt = String(job?.prompt || '');
    return prompt.match(/^Manga run [^\r\n/]+\s*\/\s*([A-Za-z0-9_-]+)\./)?.[1]
        || prompt.match(/\bSCENE_ID\s*:\s*([A-Za-z0-9_-]+)/i)?.[1]
        || null;
}

export function collectLatestSceneJobs(project, upToBatchIndex = null) {
    const batches = [...imageBatches(project)].sort((a, b) => a.batchIndex - b.batchIndex);
    const maxBatch = upToBatchIndex !== '' && upToBatchIndex != null && upToBatchIndex !== 'merged' ? Number(upToBatchIndex) : null;
    const bySceneId = new Map();
    for (const batch of batches) {
        if (maxBatch != null && Number.isInteger(maxBatch) && batch.batchIndex > maxBatch) continue;
        for (const job of batch.jobs) {
            if (job.status !== 'COMPLETED' || !job.resultUrl) continue;
            const sceneId = jobSceneId(job);
            if (!sceneId || /^CHAR_/i.test(sceneId)) continue;
            bySceneId.set(sceneId, { job, batchIndex: batch.batchIndex });
        }
    }
    return bySceneId;
}

export function resolveCapcutBatchIndex(project, requestedBatchIndex) {
    if (requestedBatchIndex === 'merged') {
        if (!collectLatestSceneJobs(project).size) {
            throw Error('Chưa có ảnh gắn mã cảnh (UT/SC) hoàn tất để gộp tự động.');
        }
        return 'merged';
    }
    const batches = imageBatches(project);
    const hasExplicitSelection = requestedBatchIndex !== '' && requestedBatchIndex != null;
    if (hasExplicitSelection) {
        const parsed = Number(requestedBatchIndex);
        if (!Number.isInteger(parsed) || !batches.some(batch => batch.batchIndex === parsed)) {
            throw Error('Lượt tạo ảnh đã chọn không còn tồn tại. Bấm Làm mới và chọn lại.');
        }
        return parsed;
    }
    const newestCompleted = batches.find(batch => batch.jobs.length > 0 && batch.jobs.every(job => job.status === 'COMPLETED' && job.resultUrl));
    if (!newestCompleted) throw Error('Chưa có lượt tạo ảnh hoàn tất để đồng bộ.');
    return newestCompleted.batchIndex;
}

export async function readAudioScenes(folder) {
    if (!path.isAbsolute(folder || '')) throw Error('Chọn thư mục audio đã cắt hoặc thư mục lượt Story.');
    const root = path.basename(folder) === 'audio_segments' ? path.dirname(folder) : folder;
    let manifest;
    try {
        manifest = await json(path.join(root, 'story-manifest.json'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw Error('Không đọc được story-manifest.json: ' + error.message);
    }
    if (manifest) {
        const scenes = (manifest.selectedSceneIds || []).map(id => manifest.document?.scenes?.find(s => s.scene_id === id));
        if (!scenes.length || scenes.some(s => !s?.audio_file) || new Set(scenes.map(s => s.scene_id)).size !== scenes.length) throw Error('Danh sách cảnh/audio trong Story không hợp lệ.');
        return scenes.map(s => ({ sceneId: s.scene_id, audioFile: s.audio_file }));
    }
    const files = (await fs.readdir(folder, { withFileTypes: true }))
        .filter(f => f.isFile() && audioExtensions.has(path.extname(f.name).toLowerCase()))
        .map(f => f.name);
    if (!files.length) throw Error('Thư mục không có đoạn audio.');
    const rows = files.map(name => {
        const match = path.parse(name).name.match(/^(?:SC|segment[_ -]?|audio[_ -]?)?(\d+)(?:[_ -].*)?$/i);
        if (!match) throw Error('Tên audio cần bắt đầu bằng số thứ tự hoặc SC001: ' + name);
        return { order: Number(match[1]), audioFile: path.join(folder, name), sceneId: 'SC' + String(Number(match[1])).padStart(3, '0') };
    }).sort((a, b) => a.order - b.order);
    if (new Set(rows.map(r => r.order)).size !== rows.length) throw Error('Audio bị trùng số thứ tự cảnh.');
    if (rows.some((r, i) => r.order !== i + 1)) throw Error('Audio phải liên tục từ 1; có cảnh bị thiếu.');
    return rows;
}

function srtTimeUs(parts, offset = 0) {
    return (((Number(parts[offset]) * 60 + Number(parts[offset + 1])) * 60 + Number(parts[offset + 2])) * 1000 + Number(parts[offset + 3])) * 1000;
}

export function parseSrtTimeline(content) {
    const normalized = String(content || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    if (!normalized) throw Error('File SRT trống.');
    const blocks = normalized.split(/\n\s*\n/).filter(Boolean);
    const cues = [];
    const timing = /(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})/;
    for (const block of blocks) {
        const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
        const at = lines.findIndex(line => timing.test(line));
        if (at < 0) continue;
        const match = lines[at].match(timing);
        const startUs = srtTimeUs(match, 1);
        const endUs = srtTimeUs(match, 5);
        const text = lines.slice(at + 1).join(' ').trim();
        if (endUs <= startUs) throw Error(`Mốc SRT không hợp lệ ở cue ${cues.length + 1}.`);
        const tagged = text.match(/\bUT\s*0*(\d+)\b/i);
        const utteranceId = tagged ? 'UT' + String(Number(tagged[1])).padStart(3, '0') : 'UT' + String(cues.length + 1).padStart(3, '0');
        cues.push({ cueIndex: cues.length, utteranceId, startUs, endUs, text });
    }
    if (!cues.length) throw Error('Không đọc được cue thời gian nào trong SRT.');
    if (cues.some((cue, i) => i && cue.startUs <= cues[i - 1].startUs)) throw Error('Các cue SRT phải tăng dần và không trùng thời điểm bắt đầu.');
    if (new Set(cues.map(c => c.utteranceId)).size !== cues.length) throw Error('SRT có mã UT bị trùng.');
    // Smart Sync reference behavior: extend each visual cue to the next cue start.
    for (let i = 0; i < cues.length - 1; i++) cues[i].endUs = cues[i + 1].startUs;
    for (const cue of cues) cue.durationUs = cue.endUs - cue.startUs;
    if (cues.some(c => c.durationUs <= 0)) throw Error('SRT tạo ra cảnh có thời lượng bằng 0.');
    return cues;
}

export async function readSrtTimeline(file) {
    if (!path.isAbsolute(file || '') || path.extname(file).toLowerCase() !== '.srt') throw Error('Chọn đúng file SRT timeline ảnh.');
    let content;
    try {
        content = await fs.readFile(file, 'utf8');
    } catch (error) {
        throw Error('Không đọc được file SRT: ' + error.message);
    }
    return parseSrtTimeline(content);
}

function getImageJobs(project, batchIndex, count, label = 'audio') {
    const selected = batchIndex === '' || batchIndex == null ? Number.NaN : Number(batchIndex);
    const batch = imageBatches(project).find(b => b.batchIndex === selected);
    if (!batch) throw Error('Chưa có lượt tạo ảnh trong project này.');
    if (batch.jobs.length !== count) {
        if (label === 'SRT') throw Error(`Có ${batch.jobs.length} ảnh và ${count} mốc SRT. Cần đúng một ảnh cho mỗi UT/cue SRT.`);
        if (label === 'timeline') throw Error(`Có ${batch.jobs.length} ảnh và ${count} cảnh trong visual timeline. Cần đúng một ảnh đã hoàn tất cho mỗi scene ID.`);
        throw Error(`Có ${batch.jobs.length} ảnh và ${count} audio. Cần đủ một ảnh cho mỗi đoạn audio.`);
    }
    const first = batch.jobs[0]?.jobIndex;
    if (batch.jobs.some((j, i) => j.jobIndex !== first + i)) throw Error('Lượt ảnh thiếu job ở giữa; không thể ghép an toàn.');
    const missing = batch.jobs.filter(j => j.status !== 'COMPLETED' || !j.resultUrl);
    if (missing.length) throw Error(`Còn ${missing.length} ảnh chưa hoàn tất. Hãy tạo lại ảnh lỗi rồi đồng bộ.`);
    return batch.jobs;
}

export function pairScenes(project, batchIndex, scenes) {
    const jobs = getImageJobs(project, batchIndex, scenes.length);
    return scenes.map((s, i) => ({ ...s, job: jobs[i] }));
}

export function pairImagesToSrt(project, batchIndex, cues) {
    if (batchIndex === 'merged') {
        const byId = collectLatestSceneJobs(project);
        const missing = cues.filter(cue => !byId.has(cue.utteranceId));
        if (missing.length) throw Error(`Scene ID ảnh gộp chưa đủ cho SRT. Thiếu: ${missing.map(x => x.utteranceId).join(', ')}.`);
        return cues.map(cue => ({ ...cue, sceneId: cue.utteranceId, job: byId.get(cue.utteranceId).job }));
    }
    const jobs = getImageJobs(project, batchIndex, cues.length, 'SRT');
    return cues.map((cue, i) => ({ ...cue, sceneId: cue.utteranceId, job: jobs[i] }));
}

export function pairImagesToTimeline(project,batchIndex,scenes){
    if (batchIndex === 'merged') {
        const byId = collectLatestSceneJobs(project);
        if (!byId.size) throw Error('Chưa có ảnh gắn mã cảnh (UT/SC) hoàn tất để gộp tự động.');
        const missing = scenes.filter(scene => !byId.has(scene.sceneId));
        if (missing.length) throw Error(`Scene ID ảnh gộp chưa đủ cho timeline. Thiếu: ${missing.map(x => x.sceneId).join(', ')}.`);
        return scenes.map(scene => ({ ...scene, job: byId.get(scene.sceneId).job }));
    }
    const selected = batchIndex === '' || batchIndex == null ? Number.NaN : Number(batchIndex);
    const batch = imageBatches(project).find(b => b.batchIndex === selected);
    if (batch && batch.jobs.length > 0 && batch.jobs.length < scenes.length) {
        const allCompleted = batch.jobs.every(j => j.status === 'COMPLETED' && j.resultUrl);
        const batchTags = batch.jobs.map(job => jobSceneId(job));
        if (allCompleted && batchTags.every(Boolean)) {
            const mergedById = collectLatestSceneJobs(project, selected);
            if (scenes.every(scene => mergedById.has(scene.sceneId))) {
                return scenes.map(scene => ({ ...scene, job: mergedById.get(scene.sceneId).job }));
            }
        }
    }
    const jobs=getImageJobs(project,batchIndex,scenes.length,'timeline');
    const tagged=jobs.map(job=>jobSceneId(job));
    if(tagged.some(Boolean)&&tagged.some(id=>!id))throw Error('Lượt ảnh chỉ có một phần job mang scene ID; không thể ghép an toàn.');
    if(tagged.every(Boolean)){
        if(new Set(tagged).size!==tagged.length)throw Error('Lượt ảnh có scene ID bị trùng.');
        const byId=new Map(jobs.map((job,index)=>[tagged[index],job]));
        const missing=scenes.filter(scene=>!byId.has(scene.sceneId));
        const extra=tagged.filter(id=>!scenes.some(scene=>scene.sceneId===id));
        if(missing.length||extra.length)throw Error(`Scene ID ảnh không khớp timeline. Thiếu: ${missing.map(x=>x.sceneId).join(', ')||'không'}; thừa: ${extra.join(', ')||'không'}.`);
        return scenes.map(scene=>({...scene,job:byId.get(scene.sceneId)}));
    }
    return scenes.map((scene,index)=>({...scene,job:jobs[index]}));
}

export async function readVisualTimeline(input){
    if(!path.isAbsolute(input||''))throw Error('Chọn thư mục Story có visual_timeline.json.');
    const info=await fs.stat(input).catch(()=>null);
    const file=info?.isDirectory()?path.join(input,'visual_timeline.json'):input;
    if(path.extname(file).toLowerCase()!=='.json')throw Error('Visual timeline phải là file JSON hoặc thư mục Story.');
    let data;
    try{data=await json(file);}catch(error){throw Error('Không đọc được visual_timeline.json: '+error.message);}
    if(data.schema_version!=='visual-timeline/v1'||!Array.isArray(data.scenes)||!data.scenes.length)throw Error('Visual timeline không đúng schema visual-timeline/v1.');
    const root=path.dirname(file),seen=new Set();let cursor=0;
    const scenes=data.scenes.map((scene,index)=>{
        const sceneId=String(scene.scene_id||'');
        if(!/^(?:SC|UT)\d+(?:[-_][A-Za-z0-9]+)?$/i.test(sceneId)||seen.has(sceneId))throw Error(`Scene ID timeline không hợp lệ hoặc bị trùng ở cảnh ${index+1}.`);
        seen.add(sceneId);
        const startUs=Number(scene.start_ms)*1000,endUs=Number(scene.end_ms)*1000;
        if(!Number.isSafeInteger(startUs)||!Number.isSafeInteger(endUs)||startUs!==cursor||endUs<=startUs)throw Error(`Timeline ${sceneId} bị hở, chồng lấn hoặc có thời lượng bằng 0.`);
        cursor=endUs;
        return {sceneId,startUs,endUs,durationUs:endUs-startUs,text:String(scene.source_text||''),utteranceIds:scene.utterance_ids||[sceneId],speakerId:scene.speaker_id||null};
    });
    const declared=Number(data.audio_duration_ms)*1000;
    if(!Number.isSafeInteger(declared)||declared<=0||cursor!==declared)throw Error('Mốc cuối visual timeline không khớp audio_duration_ms.');
    const masterAudio=path.isAbsolute(data.master_audio||'')?data.master_audio:path.resolve(root,String(data.master_audio||''));
    if(!(await fs.stat(masterAudio).catch(()=>null))?.isFile())throw Error('Không tìm thấy audio gốc của visual timeline: '+masterAudio);
    return {file,root,masterAudio,audioDurationUs:declared,scenes,validation:data.validation||{}};
}

function addTrackMaterial(draft, track, item, kind) {
    const image = kind === 'video';
    const arr = image ? 'videos' : 'audios';
    const material = structuredClone(template[kind + 'Material']);
    Object.assign(material, {
        id: randomUUID(),
        type: image ? 'photo' : 'music',
        path: slash(image ? item.imageFile : item.audioFile),
        duration: item.durationUs,
        local_material_id: '',
    });
    if (image) Object.assign(material, { material_name: path.basename(item.imageFile), has_audio: false, width: item.width, height: item.height, category_name: 'local' });
    else Object.assign(material, { name: path.basename(item.audioFile), category_name: 'local', check_flag: 1 });
    draft.materials[arr].push(material);
    const refs = template[kind + 'Extras'].map(ex => {
        const extra = structuredClone(ex.mat);
        extra.id = randomUUID();
        if (ex.arr === 'speeds') Object.assign(extra, { speed: 1, mode: 0, curve_speed: null });
        (draft.materials[ex.arr] ??= []).push(extra);
        return extra.id;
    });
    const segment = structuredClone(template[kind + 'Segment']);
    Object.assign(segment, {
        id: randomUUID(),
        material_id: material.id,
        extra_material_refs: refs,
        source_timerange: { start: 0, duration: item.durationUs },
        target_timerange: { start: item.startUs, duration: item.durationUs },
        speed: 1,
        volume: 1,
        last_nonzero_volume: 1,
        common_keyframes: [],
        keyframe_refs: [],
    });
    track.segments.push(segment);
}

export function buildCapcutDraftTracks(images, audios, ratio = '16:9', name = 'Story') {
    const draft = structuredClone(template.draft);
    draft.id = randomUUID();
    draft.name = name;
    const dims = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:3': [1440, 1080], '3:4': [1080, 1440] };
    const [width, height] = dims[ratio] || dims['16:9'];
    draft.canvas_config = { width, height, ratio, background: null };
    const tracks = ['video', 'audio'].map((type, i) => ({ id: randomUUID(), type, attribute: 0, flag: 0, name: i ? 'Story Audio' : 'Story Images', is_default_name: false, segments: [] }));
    for (const item of images) {
        if (!Number.isSafeInteger(item.startUs) || item.startUs < 0 || !Number.isSafeInteger(item.durationUs) || item.durationUs <= 0) throw Error('Thời gian ảnh không hợp lệ: ' + item.sceneId);
        addTrackMaterial(draft, tracks[0], item, 'video');
    }
    for (const item of audios) {
        if (!Number.isSafeInteger(item.startUs) || item.startUs < 0 || !Number.isSafeInteger(item.durationUs) || item.durationUs <= 0) throw Error('Thời lượng audio không hợp lệ: ' + item.sceneId);
        addTrackMaterial(draft, tracks[1], item, 'audio');
    }
    draft.tracks = tracks;
    draft.duration = Math.max(0, ...images.map(p => p.startUs + p.durationUs), ...audios.map(p => p.startUs + p.durationUs));
    draft.create_time = draft.update_time = Math.floor(Date.now() / 1000);
    return draft;
}

export function buildCapcutDraft(pairs, ratio = '16:9', name = 'Story') {
    let cursor = 0;
    const images = [], audios = [];
    for (const pair of pairs) {
        images.push({ ...pair, startUs: cursor });
        audios.push({ ...pair, startUs: cursor });
        cursor += pair.durationUs;
    }
    return buildCapcutDraftTracks(images, audios, ratio, name);
}

async function probe(file, kind, binary) {
    const { stdout } = await execute(binary, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    const info = JSON.parse(stdout), stream = info.streams?.find(s => s.codec_type === kind);
    if (!stream) throw Error('File không có ' + kind + ': ' + path.basename(file));
    if (kind === 'audio') {
        const durationUs = Math.round(Number(info.format?.duration || stream.duration) * 1e6);
        if (!Number.isSafeInteger(durationUs) || durationUs <= 0) throw Error('Audio rỗng hoặc hỏng: ' + path.basename(file));
        return { durationUs };
    }
    if (!stream.width || !stream.height || !['png', 'mjpeg', 'webp', 'bmp', 'gif', 'tiff', 'av1'].includes(stream.codec_name)) throw Error('Kết quả không phải ảnh hợp lệ: ' + path.basename(file));
    return { width: stream.width, height: stream.height, extension: ({ png: '.png', mjpeg: '.jpg', webp: '.webp', bmp: '.bmp', gif: '.gif', tiff: '.tiff', av1: '.avif' })[stream.codec_name] };
}

export async function createCapcutProject({ project, batchIndex, audioFolder, draftsRoot, name, alignmentMode = 'audio', srtPath }, deps = {}) {
    const mode = alignmentMode === 'srt' ? 'srt' : alignmentMode === 'audio' ? 'audio' : 'timeline';
    const timeline=mode==='timeline'?await readVisualTimeline(audioFolder):null;
    const scenes = mode==='timeline'?[]:await readAudioScenes(audioFolder);
    const imagePairs = mode === 'timeline'
        ? pairImagesToTimeline(project,batchIndex,timeline.scenes)
        : mode === 'srt'
            ? pairImagesToSrt(project, batchIndex, await readSrtTimeline(srtPath))
            : pairScenes(project, batchIndex, scenes);
    const srtEndUs = mode === 'srt' ? imagePairs.at(-1).endUs : null;
    const root = draftsRoot || defaultCapcutRoot();
    if (!path.isAbsolute(root) || !(await fs.stat(root)).isDirectory()) throw Error('Chọn đúng thư mục dự án CapCut (com.lveditor.draft).');
    const binary = deps.ffprobe || resolveFfprobeBinary();
    if (!binary) throw Error('Không tìm thấy FFprobe để đọc thời lượng audio.');
    const label = (name || project.name || 'Story').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 90) || 'Story';
    const folder = label + ' - ' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 6);
    const destination = path.join(root, folder), stage = path.join(root, '.story-sync-' + randomUUID());
    await fs.mkdir(stage);
    await fs.mkdir(path.join(stage, 'media'));
    let published = false;
    try {
        const total = imagePairs.length + (timeline?1:scenes.length), readyImages = [], readyAudios = [];
        let done = 0, audioCursor = 0;
        if(timeline){
            deps.progress?.('Đang sao chép audio gốc liên tục',done/total);
            const extension=path.extname(timeline.masterAudio).toLowerCase()||'.mp3',audioName='story-audio'+extension,audio=path.join(stage,'media',audioName);
            await fs.copyFile(timeline.masterAudio,audio);
            const info=await probe(audio,'audio',binary);
            if(Math.abs(info.durationUs-timeline.audioDurationUs)>100000)throw Error(`Audio gốc dài ${(info.durationUs/1e6).toFixed(3)} giây nhưng visual timeline dài ${(timeline.audioDurationUs/1e6).toFixed(3)} giây.`);
            readyAudios.push({sceneId:'MASTER_AUDIO',audioFile:path.join(destination,'media',audioName),startUs:0,durationUs:info.durationUs});
            audioCursor=info.durationUs;done++;
        }
        for (const scene of scenes) {
            // WAV/SRT rounding can differ by a few microseconds. Once the selected
            // SRT range is reached, do not append later chapters such as After-talk.
            if (srtEndUs != null && srtEndUs - audioCursor <= 10000) {
                audioCursor = srtEndUs;
                break;
            }
            deps.progress?.(`Đang đồng bộ audio ${readyAudios.length + 1}/${scenes.length} · ${scene.sceneId}`, done / total);
            const audioName = scene.sceneId + path.extname(scene.audioFile);
            const audio = path.join(stage, 'media', audioName);
            await fs.copyFile(scene.audioFile, audio);
            const probed = await probe(audio, 'audio', binary);
            const info = srtEndUs == null ? probed : { durationUs: Math.min(probed.durationUs, srtEndUs - audioCursor) };
            readyAudios.push({ ...scene, ...info, startUs: audioCursor, audioFile: path.join(destination, 'media', audioName) });
            audioCursor += info.durationUs;
            done++;
            if (srtEndUs != null && audioCursor >= srtEndUs) break;
        }
        for (const [index, pair] of imagePairs.entries()) {
            if (!/^(?:SC|UT)\d+(?:[-_][A-Za-z0-9]+)?$/i.test(pair.sceneId)) throw Error('Mã cảnh/UT không hợp lệ.');
            deps.progress?.(`Đang đồng bộ ảnh ${index + 1}/${imagePairs.length} · ${pair.sceneId}`, done / total);
            let imageName = pair.sceneId + '.png';
            const image = path.join(stage, 'media', imageName), source = pair.job.resultUrl;
            if (/^https?:\/\//i.test(source)) {
                const download = deps.download || ((url, file) => import('../../../utils/fileDownloader.js').then(m => m.downloadFile(url, file)));
                await download(source, image);
            } else await fs.copyFile(source.startsWith('file:') ? fileURLToPath(source) : source, image);
            const info = await probe(image, 'video', binary);
            if (info.extension !== '.png') {
                imageName = pair.sceneId + info.extension;
                await fs.rename(image, path.join(stage, 'media', imageName));
            }
            let timing = mode === 'timeline'||mode === 'srt'
                ? { startUs: pair.startUs, durationUs: pair.durationUs }
                : { startUs: readyAudios[index].startUs, durationUs: readyAudios[index].durationUs };
            if(mode==='timeline'&&index===imagePairs.length-1)timing={startUs:pair.startUs,durationUs:readyAudios[0].durationUs-pair.startUs};
            if(timing.durationUs<=0)throw Error('Cảnh cuối timeline vượt quá thời lượng audio gốc.');
            readyImages.push({ ...pair, ...timing, ...info, imageFile: path.join(destination, 'media', imageName) });
            done++;
        }
        const draft = buildCapcutDraftTracks(readyImages, readyAudios, project.aspectRatio, folder), now = Date.now() * 1000;
        const meta = { draft_id: draft.id, draft_name: folder, draft_fold_path: slash(destination), draft_root_path: slash(root), draft_cover: '', draft_is_invisible: false, draft_materials: [], draft_removable_storage_device: '', draft_type: '', tm_draft_create: now, tm_draft_modified: now, tm_draft_removed: 0, tm_duration: draft.duration };
        await fs.writeFile(path.join(stage, 'draft_content.json'), JSON.stringify(draft));
        await fs.writeFile(path.join(stage, 'draft_meta_info.json'), JSON.stringify(meta));
        await fs.writeFile(path.join(stage, 'story-sync.json'), JSON.stringify({
            projectId: project.id,
            batchIndex,
            alignmentMode: mode,
            srtPath: mode === 'srt' ? srtPath : null,
            visualTimeline: mode === 'timeline' ? timeline.file : null,
            createdAt: new Date().toISOString(),
            images: readyImages.map(p => ({ sceneId: p.sceneId, utteranceIds:p.utteranceIds||[p.sceneId], jobId: p.job.id, text: p.text || '', startUs: p.startUs, durationUs: p.durationUs, imageFile: p.imageFile })),
            audios: readyAudios.map(p => ({ sceneId: p.sceneId, startUs: p.startUs, durationUs: p.durationUs, audioFile: p.audioFile })),
        }, null, 2));
        await fs.rename(stage, destination);
        published = true;
        // Never change an open CapCut's shared index. A new draft remains complete on disk.
        let warning = '';
        try {
            const running = deps.isCapcutRunning ? await deps.isCapcutRunning() : process.platform === 'win32' && (await execute('tasklist.exe', ['/FI', 'IMAGENAME eq CapCut.exe', '/FO', 'CSV', '/NH'], { windowsHide: true })).stdout.toLowerCase().includes('capcut.exe');
            if (running) warning = 'CapCut đang mở. Nếu chưa thấy project mới, hãy lưu công việc rồi đóng/mở lại CapCut.';
            else {
                const indexPath = path.join(root, 'root_meta_info.json');
                let raw;
                try { raw = await fs.readFile(indexPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
                const index = raw ? JSON.parse(raw) : { all_draft_store: [], draft_ids: 0, root_path: slash(root) };
                if (!Array.isArray(index.all_draft_store)) throw Error('Danh mục CapCut không đúng định dạng');
                index.all_draft_store.unshift({ ...meta, draft_json_file: slash(path.join(destination, 'draft_content.json')) });
                if (typeof index.draft_ids === 'number') index.draft_ids = index.all_draft_store.length;
                if (raw) await fs.writeFile(path.join(destination, 'root_meta_info.before-sync.json'), raw, { flag: 'wx' });
                const temp = path.join(root, '.story-index-' + randomUUID() + '.tmp');
                await fs.writeFile(temp, JSON.stringify(index));
                await fs.rename(temp, indexPath);
            }
        } catch (error) {
            warning = 'Project đã tạo nhưng chưa cập nhật danh sách CapCut: ' + error.message;
        }
        return { path: destination, name: folder, count: readyImages.length, audioCount: readyAudios.length, alignmentMode: mode, durationSeconds: draft.duration / 1e6, warning };
    } catch (error) {
        if (!published && path.dirname(path.resolve(stage)) === path.resolve(root) && path.basename(stage).startsWith('.story-sync-')) await fs.rm(stage, { recursive: true, force: true });
        throw error;
    }
}

export async function patchCapcutProject({ project, draftPath, batchIndex = 'merged', sceneIds = null }, deps = {}) {
    if (!path.isAbsolute(draftPath || '')) throw Error('Chọn đường dẫn tuyệt đối tới thư mục project CapCut cần cập nhật.');
    const statInfo = await fs.stat(draftPath).catch(() => null);
    if (!statInfo?.isDirectory()) throw Error('Thư mục project CapCut không tồn tại.');
    const syncPath = path.join(draftPath, 'story-sync.json');
    const draftJsonPath = path.join(draftPath, 'draft_content.json');
    const metaJsonPath = path.join(draftPath, 'draft_meta_info.json');
    let sync, draft;
    try {
        sync = await json(syncPath);
        draft = await json(draftJsonPath);
    } catch (error) {
        throw Error('Thư mục đã chọn không chứa story-sync.json hoặc draft_content.json hợp lệ: ' + error.message);
    }
    if (!Array.isArray(sync.images) || !sync.images.length) throw Error('story-sync.json không có danh sách ảnh.');
    const binary = deps.ffprobe || resolveFfprobeBinary();
    if (!binary) throw Error('Không tìm thấy FFprobe để kiểm tra ảnh cập nhật.');

    const isExplicitBatch = batchIndex !== 'merged' && batchIndex !== '' && batchIndex != null && Number.isInteger(Number(batchIndex));
    const latestMap = collectLatestSceneJobs(project, isExplicitBatch ? Number(batchIndex) : null);
    if (!latestMap.size) throw Error('Chưa có ảnh gắn mã cảnh (UT/SC) hoàn tất để cập nhật.');

    const batchSceneSet = isExplicitBatch
        ? new Set(
            (imageBatches(project).find(b => b.batchIndex === Number(batchIndex))?.jobs || [])
                .filter(j => j.status === 'COMPLETED' && j.resultUrl)
                .map(j => jobSceneId(j))
                .filter(Boolean)
        )
        : null;
    const filterSet = Array.isArray(sceneIds) && sceneIds.length ? new Set(sceneIds) : null;

    const targets = sync.images.filter(item => {
        const entry = latestMap.get(item.sceneId);
        if (!entry) return false;
        if (filterSet) return filterSet.has(item.sceneId);
        if (batchSceneSet && batchSceneSet.size > 0) return batchSceneSet.has(item.sceneId);
        return entry.job.id !== item.jobId;
    });

    if (!targets.length) {
        throw Error('Không tìm thấy cảnh nào có ảnh mới hơn bản nháp CapCut hiện tại.');
    }

    const mediaDir = path.join(draftPath, 'media');
    await fs.mkdir(mediaDir, { recursive: true });
    const patchedSceneIds = [];

    for (const [idx, item] of targets.entries()) {
        const { job } = latestMap.get(item.sceneId);
        deps.progress?.(`Đang cập nhật ảnh ${idx + 1}/${targets.length} · ${item.sceneId}`, idx / targets.length);
        const tmpFile = path.join(mediaDir, `.patch-${item.sceneId}-${randomUUID()}.tmp`);
        try {
            const source = job.resultUrl;
            if (/^https?:\/\//i.test(source)) {
                const download = deps.download || ((url, file) => import('../../../utils/fileDownloader.js').then(m => m.downloadFile(url, file)));
                await download(source, tmpFile);
            } else {
                await fs.copyFile(source.startsWith('file:') ? fileURLToPath(source) : source, tmpFile);
            }
            const info = await probe(tmpFile, 'video', binary);
            const oldFileName = path.basename(item.imageFile || `${item.sceneId}${info.extension}`);
            const newFileName = `${item.sceneId}${info.extension}`;
            const finalFile = path.join(mediaDir, newFileName);
            await fs.rename(tmpFile, finalFile);
            if (oldFileName !== newFileName) {
                await fs.rm(path.join(mediaDir, oldFileName), { force: true }).catch(() => {});
            }
            const videoMats = draft.materials?.videos || [];
            const mat = videoMats.find(m => m.material_name === oldFileName || path.basename(String(m.path || '')) === oldFileName || path.basename(String(m.path || ''), path.extname(String(m.path || ''))) === item.sceneId);
            if (mat) {
                mat.path = slash(finalFile);
                mat.material_name = newFileName;
                mat.width = info.width;
                mat.height = info.height;
            }
            item.jobId = job.id;
            item.imageFile = finalFile;
            item.patchedAt = new Date().toISOString();
            patchedSceneIds.push(item.sceneId);
        } finally {
            await fs.rm(tmpFile, { force: true }).catch(() => {});
        }
    }

    draft.update_time = Math.floor(Date.now() / 1000);
    await fs.writeFile(draftJsonPath, JSON.stringify(draft));
    try {
        const meta = await json(metaJsonPath);
        meta.tm_draft_modified = Date.now() * 1000;
        await fs.writeFile(metaJsonPath, JSON.stringify(meta));
    } catch {}
    sync.updatedAt = new Date().toISOString();
    sync.lastPatchedScenes = patchedSceneIds;
    await fs.writeFile(syncPath, JSON.stringify(sync, null, 2));

    return {
        path: draftPath,
        name: path.basename(draftPath),
        patchedCount: patchedSceneIds.length,
        patchedSceneIds,
        patchedScenes: patchedSceneIds,
        count: sync.images.length,
        durationSeconds: (draft.duration || 0) / 1e6,
    };
}

