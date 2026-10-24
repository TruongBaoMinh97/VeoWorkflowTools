import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { sharedConfiguration, audioToStory, requireFile } from './audioStory.js';
import { snapshotStory, compileScene, previewStory } from './storyScenes.js';
import { extractBatchSchema } from '../workflow.batch.schema.js';

const execute = promisify(execFile);
export async function audioRuntime() {
    const server = process.resourcesPath ? path.join(process.resourcesPath,'server') : fileURLToPath(new URL('../../../../',import.meta.url));
    const runtime = {python:path.join(server,'binaries/python/win32-x64/python.exe'),script:path.join(server,'python/audio_splitter.py'),ffmpeg:path.join(server,'binaries/ffmpeg/win32-x64-ffmpeg.exe'),ffprobe:path.join(server,'binaries/ffmpeg/win32-x64-ffprobe.exe')};
    for (const [name, file] of Object.entries(runtime)) await requireFile(file, name);
    await Promise.all(['ffmpeg','ffprobe'].map(t => execute(runtime[t],['-version'],{windowsHide:true,timeout:10000,maxBuffer:64000})));
    await execute(runtime.python,['-c','import pydub'],{windowsHide:true,timeout:10000});
    return runtime;
}
export function runSplitter(runtime, configPath, signal, progress) {
    return new Promise((resolve,reject) => {
        const child = spawn(runtime.python,['-u',runtime.script,'--config',configPath],{windowsHide:true,env:{...process.env,PYTHONUTF8:'1'},stdio:['ignore','pipe','pipe']});
        let buffer='',error='',done=false;
        const stop=()=>{ if(process.platform==='win32' && child.pid) execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{}); else child.kill(); };
        signal.addEventListener('abort',stop,{once:true});
        if(signal.aborted)stop();
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const event=JSON.parse(line);if(event.type==='progress')progress(event);if(event.type==='error')error=event.message;if(event.type==='done')done=true;}catch{}}});
        child.stderr.on('data',chunk=>{error=(error+chunk).slice(-4000)});
        child.on('error',reject);
        child.on('close',code=>{signal.removeEventListener('abort',stop);if(signal.aborted)reject(Error('Đã hủy cắt audio.'));else if(code!==0||!done)reject(Error(error||`Audio Splitter thoát mã ${code}`));else resolve();});
    });
}
export function createAudioRuns(deps) {
    const active = new Map();
    const save = state => writeFile(path.join(state.root,'audio-run.json'),JSON.stringify(state,null,2));
    async function start(definition, {promptsOnly=false} = {}) {
        const def=structuredClone(definition),config=sharedConfiguration(def),data=config.input.data;
        for(const [key,label] of [['txtPath','TXT'],['audioPath','audio'],['srtPath','SRT']]) await requireFile(data[key],label);
        if(!path.isAbsolute(data.outputDir||''))throw Error('Chọn thư mục kết quả.');
        const schema=extractBatchSchema(def);
        if(schema.inputs.length!==1||!schema.outputs.length)throw Error('Workflow audio cần một đầu vào Audio Splitter và Result đầu ra batch.');
        const profiles=await deps.profiles(data.profileIds||[]);
        if(profiles.missing.length||!profiles.deduped.length)throw Error('Chọn ít nhất một profile hợp lệ.');
        const runtime=await (deps.runtime||audioRuntime)();
        // Validate/copy references before decoding the source; library edits cannot affect this run.
        const dummy=audioToStory({alignment:[{id:1,sentence:'Scene',start_ms:0,end_ms:200}],summary:{audio_duration_ms:200}},{segments:[{id:1,sentence:'Scene',segment_start_ms:0,segment_end_ms:200,duration_ms:200,audio_file:data.audioPath}]},config);
        const {snapshot}=await snapshotStory(dummy,config.library,config.options,data.outputDir,['SC001']);
        const runId=randomUUID(),state={runId,workflowId:def.id,root:snapshot.root,status:'PREPARING',progress:0,message:'Chuẩn bị nguồn audio',batchId:null,warnings:[]};
        const controller=new AbortController();active.set(runId,{state,controller});await save(state);
        const cancelled=()=>{if(controller.signal.aborted)throw Error('Đã hủy lượt chạy.');};
        const task=(async()=>{
            try{
                const inputDir=path.join(state.root,'inputs');await mkdir(inputDir);
                const paths={};
                for(const [key,target] of [['txtPath','txt_path'],['srtPath','srt_path'],['audioPath','audio_path']]){cancelled();paths[target]=path.join(inputDir,key+path.extname(data[key]));await copyFile(data[key],paths[target]);}
                const args={...paths,ffmpeg:runtime.ffmpeg,ffprobe:runtime.ffprobe,output_root:state.root,params:data.params||{}};
                const configPath=path.join(state.root,'splitter-config.json');await writeFile(configPath,JSON.stringify(args));cancelled();
                state.status='SPLITTING';await save(state);
                await (deps.split||runSplitter)(runtime,configPath,controller.signal,event=>{state.progress=event.progress*.7;state.message=event.message;});cancelled();
                const report=JSON.parse(await readFile(path.join(state.root,'alignment_report.json'),'utf8'));
                const split=JSON.parse(await readFile(path.join(state.root,'split_audio_report.json'),'utf8'));
                const document=audioToStory(report,split,config);
                for(const scene of document.scenes)await requireFile(scene.audio_file,scene.scene_id);
                const checked=await previewStory(document,snapshot.library,config.options);
                if(checked.rows.some(r=>!r.ready))throw Error(checked.rows.find(r=>!r.ready).error);
                for(const scene of document.scenes)scene.frozen_prompt=compileScene(document,scene,snapshot.library,config.options).prompt;
                const selected=document.scenes.slice(0,data.sceneLimit===4?4:500);
                const image=def.nodes.find(n=>n.type==='generate-image');Object.assign(image.data,{ratio:'16:9',count:1,imageMode:'image-to-image',quotaFallback:false,contentFallback:'none'});
                snapshot.document=document;snapshot.definition=def;snapshot.selectedSceneIds=selected.map(s=>s.scene_id);
                snapshot.audio={runId,summary:report.summary,sentences:path.join(state.root,'sentences.json'),alignment_report:path.join(state.root,'alignment_report.json'),split_audio_report:path.join(state.root,'split_audio_report.json'),prompts:path.join(state.root,'prompts.json'),resultsRoot:path.join(state.root,'scenes'),inputFiles:paths};
                const snapshotPath=path.join(state.root,'story-manifest.json');await writeFile(snapshotPath,JSON.stringify(snapshot,null,2));
                await writeFile(snapshot.audio.prompts,JSON.stringify(document.scenes.map(s=>({segment_id:s.segment_id,scene_id:s.scene_id,audio_file:s.audio_file,duration_ms:s.duration_ms,prompt:s.frozen_prompt})),null,2));
                state.totalScenes=document.scenes.length;state.selectedScenes=selected.length;
                state.warnings=report.alignment.filter(a=>a.confidence<.5||a.match_type.includes('repaired')).map(a=>`${a.id}: ${a.match_type}, confidence ${a.confidence}`);
                for(const fix of split.export_validation?.boundary_fixes||[])state.warnings.push(`Ranh giới ${fix.boundary_index}: ${fix.original_ms} → ${fix.fixed_ms} ms (${fix.reason})`);
                cancelled();state.status='QUEUING';state.progress=.8;await save(state);
                if(promptsOnly){state.status='COMPLETED';state.progress=1;state.message='Đã tạo prompt Story.';await save(state);return;}
                const column=schema.inputs[0];
                const batch=await deps.createBatch({workflowId:def.id,name:`Audio → Ảnh · ${selected.length} cảnh`,profileIds:profiles.deduped,outputDir:state.root,autoDownload:true,rowsPerProfile:1,items:selected.map((s,rowIndex)=>({rowIndex,inputValues:{[column.batchKey]:JSON.stringify({snapshotPath,sceneId:s.scene_id})}}))});
                state.batchId=batch.id;await save(state);
                if(controller.signal.aborted){await deps.cancelBatch(batch.id);cancelled();}
                state.status='PENDING';state.message='Đã chuẩn bị prompt. Mở Batch Flow và bấm Chạy tất cả để tạo ảnh.';state.progress=1;await save(state);
            }catch(error){state.status=controller.signal.aborted?'CANCELLED':'FAILED';state.error=error.message;await save(state);}
        })();
        active.get(runId).task=task;
        return {...state};
    }
    async function get(runId, root) {
        const state=active.get(runId)?.state || JSON.parse(await readFile(path.join(root,'audio-run.json'),'utf8'));
        if(state.runId!==runId)throw Error('Sai mã lượt chạy.');
        if(!active.has(runId)&&!state.batchId&& !['COMPLETED','FAILED','CANCELLED'].includes(state.status)){state.status='FAILED';state.error='Ứng dụng dừng trong lúc chuẩn bị. Các tệp đã hoàn thành được giữ lại.';}
        const result={...state};
        if(state.batchId){const batch=await deps.getBatch(state.batchId);result.batch=batch; if(batch){result.status=batch.status;const items=batch.items||[];result.progress=.8+.2*(items.filter(i=>['DONE','ERROR','CANCELLED'].includes(i.status)).length/Math.max(1,items.length));}}
        try{const snap=JSON.parse(await readFile(path.join(state.root,'story-manifest.json'),'utf8'));result.scenes=snap.audio?snap.document.scenes.map(s=>{const item=result.batch?.items?.find(i=>i.rowIndex===snap.selectedSceneIds.indexOf(s.scene_id));return {sceneId:s.scene_id,segmentId:s.segment_id,sentence:s.source_text,prompt:s.frozen_prompt,audioFile:s.audio_file,durationMs:s.duration_ms,status:item?.status||'NOT_QUEUED',error:item?.error,images:item?.outputPaths||[]}}):[];}catch{}
        return result;
    }
    async function cancel(runId,root){const current=active.get(runId);const state=current?.state||await get(runId,root);current?.controller.abort();if(state.batchId)await deps.cancelBatch(state.batchId);state.status='CANCELLED';await save(state);}
    return {start,get,cancel,settled:runId=>active.get(runId)?.task};
}
