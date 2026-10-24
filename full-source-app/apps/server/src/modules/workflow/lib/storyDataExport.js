import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { audioRuntime, runSplitter } from './audioRuns.js';
import { requireFile } from './audioStory.js';

const HEADER=/^\[(UT\d{3,})\]\[([A-Z][A-Z0-9_]*)\]\[(NARRATION|DIALOGUE|INNER_THOUGHT|MESSAGE|REACTION|AFTER_TALK)\](?:\[([^\]]+)\])?\s*$/;
const audibleTypes=new Set(['NARRATION','DIALOGUE','INNER_THOUGHT','MESSAGE','AFTER_TALK']);

export function parseControlScript(text){
    const normalized=String(text||'').replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim();
    if(!normalized)throw Error('TXT kịch bản có người nói đang rỗng.');
    const blocks=normalized.split(/\n\s*\n+/),utterances=[];
    for(const [index,block] of blocks.entries()){
        const lines=block.split('\n'),header=lines.shift()?.trim()||'',match=HEADER.exec(header),body=lines.join('\n').trim();
        if(!match)throw Error(`Khối TXT ${index+1} sai định dạng. Cần [UT001][NGUOI_NOI][LOAI][CAM_XUC].`);
        if(!body)throw Error(`Khối ${match[1]} không có nội dung.`);
        utterances.push({utterance_id:match[1],speaker_id:match[2],speech_type:match[3],emotion:(match[4]||'').trim(),text:body});
    }
    const ids=new Set();
    for(const [index,item] of utterances.entries()){
        if(ids.has(item.utterance_id))throw Error(`Trùng mã lượt thoại ${item.utterance_id}.`);ids.add(item.utterance_id);
        const expected=`UT${String(index+1).padStart(3,'0')}`;
        if(item.utterance_id!==expected)throw Error(`Thứ tự mã lượt thoại không liên tục: cần ${expected}, nhận ${item.utterance_id}.`);
    }
    if(!utterances.some(item=>audibleTypes.has(item.speech_type)))throw Error('TXT không có lời kể hoặc lời thoại để căn audio.');
    return utterances;
}

const oneLine=value=>String(value||'').replace(/\s+/g,' ').trim();
export function alignmentText(utterances){
    return utterances.filter(item=>audibleTypes.has(item.speech_type)).map(item=>oneLine(item.text)).join('\n\n')+'\n';
}

export function enrichSentences(utterances, rawSentences, alignment, segments){
    const audible=utterances.filter(item=>audibleTypes.has(item.speech_type));
    const byId=new Map(alignment.map(item=>[item.id,item]));
    const segById=new Map(segments.map(item=>[item.id,item]));
    let utteranceIndex=0,offset=0;
    const result=[];
    for(const raw of rawSentences){
        const needle=oneLine(raw.sentence);let found=-1;
        while(utteranceIndex<audible.length){
            const haystack=oneLine(audible[utteranceIndex].text);
            found=haystack.indexOf(needle,offset);
            if(found>=0){offset=found+needle.length;break;}
            utteranceIndex++;offset=0;
        }
        if(utteranceIndex>=audible.length||found<0)throw Error(`Không ánh xạ được câu ${raw.id} về lượt thoại: ${raw.sentence}`);
        const source=audible[utteranceIndex],a=byId.get(raw.id),segment=segById.get(raw.id);
        if(!a||!segment)throw Error(`Thiếu alignment hoặc audio cho câu ${raw.id}.`);
        result.push({
            id:raw.id,sentence_id:`ST${String(raw.id).padStart(3,'0')}`,utterance_id:source.utterance_id,
            speaker_id:source.speaker_id,speech_type:source.speech_type,emotion:source.emotion||null,
            audio_tags:source.emotion?[source.emotion]:[],sentence:raw.sentence,word_count:raw.word_count,
            start_ms:segment.segment_start_ms,end_ms:segment.segment_end_ms,duration_ms:segment.duration_ms,
            start_time:segment.segment_start,end_time:segment.segment_end,audio_file:segment.audio_file,
            alignment:{start_ms:a.start_ms,end_ms:a.end_ms,confidence:a.confidence,match_type:a.match_type,
                srt_start_index:a.matched_srt_start_index,srt_end_index:a.matched_srt_end_index},
        });
    }
    return result;
}

export function buildUtterances(utterances,sentences){
    return utterances.map(item=>{
        const parts=sentences.filter(s=>s.utterance_id===item.utterance_id);
        return {...item,audio_tags:item.emotion?[item.emotion]:[],sentence_ids:parts.map(s=>s.sentence_id),audio_files:parts.map(s=>s.audio_file),
            start_ms:parts[0]?.start_ms??null,end_ms:parts.at(-1)?.end_ms??null,duration_ms:parts.length?parts.at(-1).end_ms-parts[0].start_ms:null,
            alignment_confidence:parts.length?Math.min(...parts.map(s=>s.alignment.confidence)):null};
    });
}

const srtTime=ms=>{
    const value=Math.max(0,Math.round(ms));
    const hours=Math.floor(value/3600000),minutes=Math.floor(value%3600000/60000),seconds=Math.floor(value%60000/1000),millis=value%1000;
    return `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')},${String(millis).padStart(3,'0')}`;
};

const visualDefaults={minDurationMs:2500,maxDurationMs:9000,maxUtterances:3};
const visualOptions=value=>{
    const minDurationMs=Number.isInteger(value?.minDurationMs)?value.minDurationMs:visualDefaults.minDurationMs;
    const maxDurationMs=Number.isInteger(value?.maxDurationMs)?value.maxDurationMs:visualDefaults.maxDurationMs;
    const maxUtterances=Number.isInteger(value?.maxUtterances)?value.maxUtterances:visualDefaults.maxUtterances;
    if(minDurationMs<1000||minDurationMs>6000)throw Error('Thời lượng cảnh hình tối thiểu phải từ 1000 đến 6000 ms.');
    if(maxDurationMs<4000||maxDurationMs>20000||maxDurationMs<minDurationMs)throw Error('Thời lượng cảnh hình tối đa phải từ 4000 đến 20000 ms và không nhỏ hơn mức tối thiểu.');
    if(maxUtterances<1||maxUtterances>5)throw Error('Số UT tối đa trong một cảnh phải từ 1 đến 5.');
    return {minDurationMs,maxDurationMs,maxUtterances};
};

export function parseSrtCueStarts(content){
    const timing=/(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})\s*-->/;
    return String(content||'').replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').split('\n').map(line=>line.match(timing)).filter(Boolean).map(match=>(((Number(match[1])*60+Number(match[2]))*60+Number(match[3]))*1000+Number(match[4])));
}

function splitSourceText(text,count){
    const source=oneLine(text);if(count<=1)return [source];
    const boundaries=[];for(const match of source.matchAll(/[,;:!?。！？、，；：.]\s*/g))if(match.index+match[0].length<source.length)boundaries.push(match.index+match[0].length);
    const parts=[];let start=0;
    for(let part=1;part<count;part++){
        const target=start+(source.length-start)/(count-part+1),minimum=start+1;
        let cut=boundaries.filter(index=>index>=minimum&&index<source.length).sort((a,b)=>Math.abs(a-target)-Math.abs(b-target))[0];
        if(!cut){const spaces=[...source.matchAll(/\s+/g)].map(match=>match.index+match[0].length).filter(index=>index>=minimum&&index<source.length);cut=spaces.sort((a,b)=>Math.abs(a-target)-Math.abs(b-target))[0];}
        if(!cut)break;parts.push(source.slice(start,cut).trim());start=cut;
    }
    parts.push(source.slice(start).trim());
    while(parts.length<count)parts.push('');
    return parts;
}

function clauseCandidateStarts(utteranceSentences){
    const out=[];
    for(const s of utteranceSentences){
        const text=oneLine(s.sentence),dur=(s.end_ms??0)-(s.start_ms??0);
        if(!text||dur<=0)continue;
        for(const match of text.matchAll(/[,;:!?。！？、，；：.]\s*/g)){
            const idx=match.index+match[0].length;
            if(idx>0&&idx<text.length)out.push(Math.round(s.start_ms+dur*(idx/text.length)));
        }
    }
    return out;
}

function splitLongUtterance(item,sentences,cueStarts,config){
    const duration=item.end_ms-item.start_ms;
    if(duration<=config.maxDurationMs)return [{item,start_ms:item.start_ms,end_ms:item.end_ms,source_text:oneLine(item.text),scene_id:item.utterance_id,split:false}];
    const uttSentences=sentences.filter(sentence=>sentence.utterance_id===item.utterance_id);
    const sentenceStarts=uttSentences.map(sentence=>sentence.start_ms);
    const baseCandidates=[...new Set([...sentenceStarts,...cueStarts])].filter(value=>Number.isInteger(value)&&value>item.start_ms&&value<item.end_ms).sort((a,b)=>a-b);
    const allCandidates=[...new Set([...baseCandidates,...clauseCandidateStarts(uttSentences)])].filter(value=>Number.isInteger(value)&&value>item.start_ms&&value<item.end_ms).sort((a,b)=>a-b);
    const cuts=[];let start=item.start_ms;
    while(item.end_ms-start>config.maxDurationMs){
        const remaining=item.end_ms-start,parts=Math.ceil(remaining/config.maxDurationMs),target=start+remaining/parts;
        const minCut=start+config.minDurationMs,maxCut=Math.min(start+config.maxDurationMs,item.end_ms-config.minDurationMs);
        let valid=baseCandidates.filter(value=>value>=minCut&&value<=maxCut);
        if(!valid.length)valid=allCandidates.filter(value=>value>=minCut&&value<=maxCut);
        if(!valid.length)valid=allCandidates.filter(value=>value>=minCut&&value<=item.end_ms-config.minDurationMs);
        if(!valid.length)break;
        const cut=valid.sort((a,b)=>Math.abs(a-target)-Math.abs(b-target))[0];cuts.push(cut);start=cut;
    }
    if(!cuts.length)return [{item,start_ms:item.start_ms,end_ms:item.end_ms,source_text:oneLine(item.text),scene_id:item.utterance_id,split:false,unsplittable:true}];
    const ranges=[],points=[item.start_ms,...cuts,item.end_ms];for(let i=0;i<points.length-1;i++)ranges.push([points[i],points[i+1]]);
    const texts=splitSourceText(item.text,ranges.length);
    return ranges.map(([start_ms,end_ms],index)=>({item,start_ms,end_ms,source_text:texts[index]||oneLine(item.text),scene_id:`${item.utterance_id}_${String.fromCharCode(65+index)}`,split:true}));
}

function compatibleVisualNeighbors(left,right){
    if(!left||!right)return false;
    const leftTypes=new Set(left.items.map(item=>item.speech_type)),rightTypes=new Set(right.items.map(item=>item.speech_type));
    if(leftTypes.has('AFTER_TALK')!==rightTypes.has('AFTER_TALK'))return false;
    if(left.parts.some(part=>part.split)||right.parts.some(part=>part.split))return false;
    return true;
}

function mergeVisualGroups(left,right){
    const items=[...left.items,...right.items],parts=[...left.parts,...right.parts];
    return {items,parts,start_ms:left.start_ms,end_ms:right.end_ms,source_text:parts.map(part=>part.source_text).filter(Boolean).join(' ')};
}

function groupVisualBeats(parts,config){
    const groups=parts.map(part=>({items:[part.item],parts:[part],start_ms:part.start_ms,end_ms:part.end_ms,source_text:part.source_text}));
    for(let index=0;index<groups.length;index++){
        const current=groups[index],duration=current.end_ms-current.start_ms;
        if(duration>=config.minDurationMs)continue;
        const uniqueCount=group=>new Set(group.items.map(item=>item.utterance_id)).size;
        const next=groups[index+1];
        if(next&&compatibleVisualNeighbors(current,next)&&next.end_ms-current.start_ms<=config.maxDurationMs&&uniqueCount(mergeVisualGroups(current,next))<=config.maxUtterances){
            groups.splice(index,2,mergeVisualGroups(current,next));index--;continue;
        }
        const previous=groups[index-1];
        if(previous&&compatibleVisualNeighbors(previous,current)&&current.end_ms-previous.start_ms<=config.maxDurationMs&&uniqueCount(mergeVisualGroups(previous,current))<=config.maxUtterances){
            groups.splice(index-1,2,mergeVisualGroups(previous,current));index-=2;
        }
    }
    return groups;
}

export function buildVisualTimeline(utterances,masterAudio,audioDurationMs,options={}){
    if(!path.isAbsolute(masterAudio||''))throw Error('Audio gốc của visual timeline không hợp lệ.');
    if(!Number.isInteger(audioDurationMs)||audioDurationMs<=0)throw Error('Thời lượng audio của visual timeline không hợp lệ.');
    const config=visualOptions(options),sentences=Array.isArray(options.sentences)?options.sentences:[],cueStarts=Array.isArray(options.srtCueStarts)?options.srtCueStarts:[];
    const timed=utterances.filter(item=>Number.isInteger(item.start_ms)&&Number.isInteger(item.end_ms));
    if(!timed.length)throw Error('Không có lượt thoại nào đã được căn thời gian.');
    const seen=new Set(),parts=[];let cursor=0;
    for(const item of timed){
        if(seen.has(item.utterance_id))throw Error(`Trùng mã cảnh ${item.utterance_id}.`);seen.add(item.utterance_id);
        if(item.start_ms!==cursor||item.end_ms<=item.start_ms)throw Error(`Timeline ${item.utterance_id} bị hở, chồng lấn hoặc có thời lượng bằng 0.`);
        parts.push(...splitLongUtterance(item,sentences,cueStarts,config));cursor=item.end_ms;
    }
    if(cursor!==audioDurationMs)throw Error(`Visual timeline kết thúc ở ${cursor} ms nhưng audio dài ${audioDurationMs} ms.`);
    const groups=groupVisualBeats(parts,config),scenes=[];
    for(const group of groups){
        const ids=[...new Set(group.items.map(item=>item.utterance_id))],speakers=[...new Set(group.items.map(item=>item.speaker_id))],types=[...new Set(group.items.map(item=>item.speech_type))],emotions=[...new Set(group.items.map(item=>item.emotion).filter(Boolean))];
        const firstPart=group.parts[0],lastPart=group.parts.at(-1),sceneId=group.parts.length===1?firstPart.scene_id:`${ids[0]}_${ids.at(-1)}`;
        const duration=group.end_ms-group.start_ms,confidence=Math.min(...group.items.map(item=>Number.isFinite(item.alignment_confidence)?item.alignment_confidence:0));
        const reasons=[];
        if(confidence<.72)reasons.push('alignment_confidence_low');
        if(duration<config.minDurationMs)reasons.push('visual_beat_too_short');
        if(duration>config.maxDurationMs)reasons.push(firstPart.unsplittable?'visual_beat_too_long_no_safe_boundary':'visual_beat_too_long');
        const visible=[...new Set(speakers.filter(speaker=>speaker!=='NARRATOR'))];
        scenes.push({
            scene_id:sceneId,utterance_ids:ids,speaker_id:speakers.length===1?speakers[0]:'MULTIPLE',speaker_ids:speakers,
            speech_type:types.length===1?types[0]:'MULTIPLE',emotion:emotions.length===1?emotions[0]:null,audio_tags:[...new Set(group.items.flatMap(item=>item.audio_tags||[]))],
            source_text:group.source_text,start_ms:group.start_ms,end_ms:group.end_ms,duration_ms:duration,
            alignment_confidence:confidence,review_required:reasons.length>0,review_reasons:reasons,
            focus_character_id:visible.length===1?visible[0]:null,visible_character_ids:visible,
            prompt_key:sceneId,image_file:`${sceneId}.png`,
        });
    }
    const untimed=utterances.filter(item=>item.start_ms==null).map(item=>({utterance_id:item.utterance_id,speaker_id:item.speaker_id,speech_type:item.speech_type,emotion:item.emotion||null,text:oneLine(item.text)}));
    for(const event of untimed){
        const sourceIndex=utterances.findIndex(item=>item.utterance_id===event.utterance_id);
        const previous=[...utterances.slice(0,sourceIndex)].reverse().find(item=>item.start_ms!=null);
        const next=utterances.slice(sourceIndex+1).find(item=>item.start_ms!=null);
        const target=scenes.find(scene=>scene.utterance_ids.includes((previous||next)?.utterance_id));
        if(target)(target.merged_non_audible_utterances??=[]).push(event);
    }
    return {
        schema_version:'visual-timeline/v1',timing_source:'srt-aligned-master-audio',created_at:new Date().toISOString(),
        master_audio:masterAudio,audio_duration_ms:audioDurationMs,frame_rate:30,
        visual_config:{min_duration_ms:config.minDurationMs,max_duration_ms:config.maxDurationMs,max_utterances_per_scene:config.maxUtterances},
        scenes,non_audible_utterances:untimed,
        validation:{scene_count:scenes.length,gap_count:0,overlap_count:0,starts_at_zero:true,ends_at_audio_duration:true,review_required_count:scenes.filter(scene=>scene.review_required).length},
    };
}

export function chatGptTimelineInput(timeline){
    return timeline.scenes.map(scene=>[
        `[${scene.scene_id}]`,`SCENE_ID: ${scene.scene_id}`,`UTTERANCE_IDS: ${scene.utterance_ids.join(', ')}`,`SPEAKER: ${(scene.speaker_ids||[scene.speaker_id]).join(', ')}`,
        `TYPE: ${scene.speech_type}`,scene.emotion?`EMOTION: ${scene.emotion}`:'',
        `TIME_MS: ${scene.start_ms} --> ${scene.end_ms}`,
        scene.merged_non_audible_utterances?.length?`REACTION_CONTEXT: ${scene.merged_non_audible_utterances.map(item=>`${item.utterance_id} ${item.emotion||item.text}`).join(' | ')}`:'',
        'TEXT:',scene.source_text,
    ].filter(Boolean).join('\n')).join('\n\n')+'\n';
}

export function visualTimelineSrt(timeline){
    return timeline.scenes.map((scene,index)=>[
        String(index+1),`${srtTime(scene.start_ms)} --> ${srtTime(scene.end_ms)}`,
        `${scene.scene_id} | ${(scene.speaker_ids||[scene.speaker_id]).join(',')}`,
        scene.source_text,
    ].join('\n')).join('\n\n')+'\n';
}

export function chatGptInput(utterances){
    return utterances.map(item=>[
        `[${item.utterance_id}]`,
        `SCENE_ID: ${item.utterance_id}`,
        `SPEAKER: ${item.speaker_id}`,
        `TYPE: ${item.speech_type}`,
        item.emotion?`EMOTION: ${item.emotion}`:'',
        item.start_ms==null?'':`TIME_MS: ${item.start_ms} --> ${item.end_ms}`,
        item.audio_files?.length?`AUDIO: ${item.audio_files.join(' | ')}`:'',
        'TEXT:',item.text,
    ].filter(Boolean).join('\n')).join('\n\n')+'\n';
}

export function createStoryDataRuns(deps={}){
    const active=new Map();
    const save=state=>writeFile(path.join(state.root,'story-data-run.json'),JSON.stringify(state,null,2));
    async function start(fields){
        for(const [key,label] of [['txtPath','TXT có người nói'],['audioPath','audio'],['srtPath','SRT']])await requireFile(fields?.[key],label);
        if(!path.isAbsolute(fields?.outputDir||''))throw Error('Chọn thư mục kết quả.');
        const sourceText=await readFile(fields.txtPath,'utf8'),utterances=parseControlScript(sourceText);
        const runId=randomUUID(),root=path.join(fields.outputDir,`story_data_${runId}`);
        await mkdir(root,{recursive:false});
        const state={runId,root,status:'PREPARING',progress:0,message:'Đang chuẩn hóa kịch bản có người nói',createdAt:new Date().toISOString()};
        const controller=new AbortController();active.set(runId,{state,controller});await save(state);
        const task=(async()=>{try{
            const runtime=await (deps.runtime||audioRuntime)(),inputs=path.join(root,'inputs');await mkdir(inputs);
            const paths={txt_path:path.join(inputs,'alignment-text.txt'),audio_path:path.join(inputs,'audio'+path.extname(fields.audioPath)),srt_path:path.join(inputs,'subtitles.srt')};
            await Promise.all([writeFile(paths.txt_path,alignmentText(utterances),'utf8'),copyFile(fields.audioPath,paths.audio_path),copyFile(fields.srtPath,paths.srt_path),copyFile(fields.txtPath,path.join(inputs,'control-script.txt'))]);
            const configPath=path.join(root,'splitter-config.json');
            await writeFile(configPath,JSON.stringify({...paths,ffmpeg:runtime.ffmpeg,ffprobe:runtime.ffprobe,output_root:root,params:{max_words:500,...fields.params}},null,2));
            state.status='SPLITTING';state.message='Đang căn SRT và cắt audio';await save(state);
            await (deps.split||runSplitter)(runtime,configPath,controller.signal,event=>{state.progress=Math.min(.9,event.progress*.9);state.message=event.message;});
            const [raw,report,split,srtContent]=await Promise.all([
                ...['sentences.json','alignment_report.json','split_audio_report.json'].map(name=>readFile(path.join(root,name),'utf8').then(JSON.parse)),
                readFile(paths.srt_path,'utf8'),
            ]);
            const sentences=enrichSentences(utterances,raw,report.alignment,split.segments),grouped=buildUtterances(utterances,sentences);
            const timeline=buildVisualTimeline(grouped,paths.audio_path,report.summary.audio_duration_ms,{
                minDurationMs:fields.visualMinDurationMs,maxDurationMs:fields.visualMaxDurationMs,maxUtterances:fields.visualMaxUtterances,
                sentences,srtCueStarts:parseSrtCueStarts(srtContent),
            });
            await writeFile(path.join(root,'sentences.json'),JSON.stringify(sentences,null,2),'utf8');
            await writeFile(path.join(root,'utterances.json'),JSON.stringify(grouped,null,2),'utf8');
            await writeFile(path.join(root,'CHATGPT_STORY_INPUT.txt'),chatGptTimelineInput(timeline),'utf8');
            await writeFile(path.join(root,'visual_timeline.json'),JSON.stringify(timeline,null,2),'utf8');
            await writeFile(path.join(root,'visual_timeline.srt'),visualTimelineSrt(timeline),'utf8');
            const speakers=[...new Set(utterances.map(x=>x.speaker_id))];
            const packageData={schema_version:'story-data/v2',created_at:new Date().toISOString(),inputs:{control_script:fields.txtPath,audio:fields.audioPath,srt:fields.srtPath},summary:{utterances:utterances.length,sentences:sentences.length,visual_scenes:timeline.scenes.length,speakers,review_required:report.summary.review_required||timeline.validation.review_required_count>0,low_confidence_sentences:report.summary.low_confidence_sentences,visual_scenes_review_required:timeline.validation.review_required_count},files:{sentences:path.join(root,'sentences.json'),utterances:path.join(root,'utterances.json'),chatgpt_input:path.join(root,'CHATGPT_STORY_INPUT.txt'),visual_timeline:path.join(root,'visual_timeline.json'),visual_timeline_srt:path.join(root,'visual_timeline.srt'),master_audio:paths.audio_path,audio_segments:path.join(root,'audio_segments'),alignment_report:path.join(root,'alignment_report.json')}};
            await writeFile(path.join(root,'story-package.json'),JSON.stringify(packageData,null,2),'utf8');
            Object.assign(state,{status:'COMPLETED',progress:1,message:`Đã xuất ${timeline.scenes.length} cảnh theo ${utterances.length} lượt thoại; audio gốc được giữ nguyên.`,result:packageData});await save(state);
        }catch(error){Object.assign(state,{status:controller.signal.aborted?'CANCELLED':'FAILED',error:error.message,message:error.message});await save(state);}})();
        active.get(runId).task=task;return {...state};
    }
    async function get(runId,root){
        const state=active.get(runId)?.state||JSON.parse(await readFile(path.join(root,'story-data-run.json'),'utf8'));
        if(state.runId!==runId)throw Error('Sai mã lượt xuất dữ liệu Story.');return {...state};
    }
    async function cancel(runId,root){const current=active.get(runId);const state=current?.state||await get(runId,root);current?.controller.abort();state.status='CANCELLED';await save(state);}
    return {start,get,cancel,settled:runId=>active.get(runId)?.task};
}
