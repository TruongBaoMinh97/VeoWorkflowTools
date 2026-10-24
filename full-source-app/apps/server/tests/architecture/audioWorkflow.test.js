import {configureInlineStory,readInlineStoryResult} from '../../src/modules/workflow/lib/inlineStoryPrompts.js';
import {createStoryGenTransfer} from '../../src/modules/workflow/lib/storyGenNormal.js';
import {describe,it,expect,afterEach,vi} from 'vitest';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {audioToStory,sharedConfiguration,classifyScene} from '../../src/modules/workflow/lib/audioStory.js';
import {createAudioRuns,runSplitter,audioRuntime} from '../../src/modules/workflow/lib/audioRuns.js';
import {compileScene} from '../../src/modules/workflow/lib/storyScenes.js';
import {storyExecutors} from '../../src/modules/workflow/nodes/storyExecutors.js';
import {extractBatchSchema} from '../../src/modules/workflow/workflow.batch.schema.js';
const dirs=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true})});
async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),'âm thanh test '));dirs.push(root);
 const image=path.join(root,'nhân vật.png');await writeFile(image,'approved image');
 const txt=path.join(root,'câu chuyện.txt'),srt=path.join(root,'lời.srt'),audio=path.join(root,'gốc.wav');
 for(const file of [txt,srt,audio])await writeFile(file,'test');
 const def={id:'workflow',nodes:[
  {id:'audio',type:'audio-splitter',data:{txtPath:txt,srtPath:srt,audioPath:audio,outputDir:root,sceneLimit:4,profileIds:['p']}},
  {id:'refs',type:'story-references',data:{sharedCharacterId:'AN',sharedOutfitId:'DEFAULT',characters:[{character_id:'AN',display_name:'An',identity_description_en:'A flat black hat.',reference_key:'AN_REF',outfits:[{outfit_id:'DEFAULT',description_en:'Plain stick figure.'}]}],library:{AN_REF:{path:image,reviewStatus:'approved'}},sharedStyle:'Minimalist pencil drawing.'}},
  {id:'scene',type:'scene-template',data:{}},{id:'upload',type:'upload-image',data:{}},{id:'image',type:'generate-image',data:{model:'GEM_PIX_2'}},{id:'out',type:'result',data:{batchRole:'output'}}],edges:[['audio','scene','text-out','text-in-0'],['refs','scene','text-out','text-in-1'],['scene','upload','image-out','image-in'],['scene','image','text-out','text-in'],['upload','image','image-out','image-in'],['image','out','image-out','image-in']].map(([source,target,sourceHandle,targetHandle],i)=>({id:'e'+i,source,target,sourceHandle,targetHandle}))};
 const sentences=['Mai về quê.','Trời mưa trên phố.','Cô đi về nhà.','Cô mỉm cười.','Bầu trời sáng.'];
 const report={alignment:sentences.map((sentence,i)=>({id:i+1,sentence,start_ms:i*500+50,end_ms:i*500+450,confidence:1,match_type:'exact_contiguous',matched_srt_start_index:1,matched_srt_end_index:3})),summary:{audio_duration_ms:2500}};
 const split={segments:sentences.map((sentence,i)=>({id:i+1,sentence,audio_file:audio,segment_start_ms:i*500,segment_end_ms:(i+1)*500,duration_ms:500}))};
 return {root,image,def,report,split};
}
function dependencies(f){let batch;return {
 runtime:vi.fn(async()=>({})),profiles:vi.fn(async()=>({missing:[],deduped:['p']})),
 split:vi.fn(async(_runtime,file)=>{const config=JSON.parse(await readFile(file,'utf8'));await writeFile(path.join(config.output_root,'alignment_report.json'),JSON.stringify(f.report));await writeFile(path.join(config.output_root,'split_audio_report.json'),JSON.stringify(f.split));}),
 createBatch:vi.fn(async value=>(batch={...value,id:'batch',status:'PENDING',items:value.items.map(i=>({...i,status:'PENDING'}))})),
 startBatch:vi.fn(async()=>{batch.status='RUNNING'}),cancelBatch:vi.fn(async()=>{batch.status='CANCELLED'}),getBatch:vi.fn(async()=>batch),
 }}
describe('Audio → Story workflow',()=>{
 it('uses segment IDs and exported durations, supports many SRT cues per sentence, appends style/identity once',async()=>{
  const f=await fixture(),config=sharedConfiguration(f.def),doc=audioToStory(f.report,f.split,config);
  expect(doc.scenes[0]).toMatchObject({scene_id:'SC001',segment_id:1,start_ms:0,end_ms:500,duration_ms:500,alignment:{start_ms:50,end_ms:450}});
  const prompt=compileScene(doc,doc.scenes[0],config.library).prompt;
  expect(prompt).toContain('Next sentence: Trời mưa trên phố.');expect(prompt).not.toContain('Previous sentence:');
  expect(prompt.split(config.style)).toHaveLength(2);expect(prompt.split('A flat black hat.')).toHaveLength(2);expect(prompt).not.toContain('cinematic');
  expect(classifyScene('Trời mưa trên phố.')).toBe('environment');
 });
 it('rejects absent/unapproved references, missing style, invalid timelines and IDs',async()=>{
  const f=await fixture();for(const mutate of [d=>d.nodes[1].data.sharedStyle='',d=>d.nodes[1].data.library.AN_REF.reviewStatus='pending']){const d=structuredClone(f.def);mutate(d);expect(()=>sharedConfiguration(d)).toThrow()}
  for(const mutate of [s=>s.segments[0].duration_ms=100,s=>s.segments[1].id=1,s=>s.segments[1].segment_start_ms=0]){const s=structuredClone(f.split);mutate(s);expect(()=>audioToStory(f.report,s,sharedConfiguration(f.def))).toThrow()}
 });
 it('splits once, freezes before async work, creates four batch jobs and hydrates retries without splitting',async()=>{
  const f=await fixture(),deps=dependencies(f),runs=createAudioRuns(deps);const run=await runs.start(f.def);
  f.def.nodes[1].data.sharedStyle='changed';await writeFile(f.image,'changed');
  await runs.settled(run.runId);let state=await runs.get(run.runId);expect(state.error).toBeUndefined();expect(deps.split).toHaveBeenCalledTimes(1);expect(deps.startBatch).not.toHaveBeenCalled();expect(state.status).toBe('PENDING');
  expect(state.batch.items).toHaveLength(4);expect(state.batch.rowsPerProfile).toBe(1);
  const payload=JSON.parse(Object.values(state.batch.items[0].inputValues)[0]);
  const snapshot=JSON.parse(await readFile(payload.snapshotPath,'utf8'));expect(await readFile(snapshot.library.AN_REF.path,'utf8')).toBe('approved image');
  const input=storyExecutors.find(e=>e.type==='audio-splitter');const template=storyExecutors.find(e=>e.type==='scene-template');
  for(let retry=0;retry<2;retry++){const result=await input.execute({data:{storyPayload:payload}});const prepared=template.execute({resolved:result});expect(prepared.textValue).toContain('Minimalist pencil drawing.');expect(prepared.story.scene.segment_id).toBe(1)}
  expect(deps.split).toHaveBeenCalledTimes(1);expect(extractBatchSchema(snapshot.definition).inputs[0].audioSplitter).toBe(true);
  state.batch.items[0].status='DONE';state.batch.items[1].status='ERROR';state=await runs.get(run.runId);expect(state.scenes[0].status).toBe('DONE');expect(state.scenes[4].status).toBe('NOT_QUEUED');
  const resumed=createAudioRuns(deps);expect((await resumed.get(run.runId,run.root)).batchId).toBe('batch');
 });
 it('prepares all scenes without model approval and waits for manual batch start',async()=>{
  const f=await fixture();f.def.nodes[0].data.sceneLimit=null;f.def.nodes[1].data.referenceLimitVerified=false;delete f.def.nodes[1].data.verifiedModel;
  const deps=dependencies(f),runs=createAudioRuns(deps),run=await runs.start(f.def);await runs.settled(run.runId);
  const result=await runs.get(run.runId);expect(result.error).toBeUndefined();expect(result.batch.items).toHaveLength(5);expect(result.status).toBe('PENDING');expect(deps.startBatch).not.toHaveBeenCalled();
 });
 it('stops before queue on invalid splitter output',async()=>{
  const f=await fixture();f.split.segments[0].duration_ms=0;const deps=dependencies(f),runs=createAudioRuns(deps);const run=await runs.start(f.def);await runs.settled(run.runId);expect((await runs.get(run.runId)).status).toBe('FAILED');expect(deps.createBatch).not.toHaveBeenCalled();
 });
 it('cancels audio preparation and does not submit image jobs',async()=>{
  const f=await fixture(),deps=dependencies(f);let entered;const ready=new Promise(r=>entered=r);
  deps.split=vi.fn((_r,_f,signal)=>new Promise((_resolve,reject)=>{entered();signal.addEventListener('abort',()=>reject(Error('cancelled')))}));
  const runs=createAudioRuns(deps),run=await runs.start(f.def);await ready;await runs.cancel(run.runId);await runs.settled(run.runId);expect((await runs.get(run.runId)).status).toBe('CANCELLED');expect(deps.createBatch).not.toHaveBeenCalled();
 });
 it('terminates the real bundled Python process when cancellation is requested',async()=>{
  const f=await fixture(),runtime=await audioRuntime(),controller=new AbortController();
  const script=path.join(f.root,'cancel-test.py');await writeFile(script,'import json,time\nprint(json.dumps(dict(type="progress", progress=0, message="started")),flush=True)\ntime.sleep(60)\n');
  await expect(runSplitter({...runtime,script},f.def.nodes[0].data.txtPath,controller.signal,()=>controller.abort())).rejects.toThrow(/hủy/);
 },15000);
});

describe('Story transfer to native Gen Normal',()=>{
 it.each([false,true])('keeps frozen prompts, uploads references once and reopens without duplicate jobs (promptsOnly=%s)',async(promptsOnly)=>{
  const f=await fixture(),deps=dependencies(f),runs=createAudioRuns(deps);
  const run=await runs.start(f.def,{promptsOnly});await runs.settled(run.runId);
  let project={id:'native',profiles:[{profileId:'p',veo3ProjectId:'remote'}],jobs:[]};
  const service={createProject:vi.fn(async()=>project),updateProject:vi.fn(),uploadImageAndGetMediaId:vi.fn(async()=>({mediaId:'ref'})),submitStoryboardImageBatch:vi.fn(async(_id,prompts)=>{project.jobs=prompts.map(prompt=>({prompt}))}),startGeneration:vi.fn()};
  const transfer=createStoryGenTransfer({service,repository:{getProject:async()=>project},profiles:deps.profiles});
  const result=await transfer(run.root,run.runId,['p']);
  expect(result).toEqual({projectId:'native',count:4});
  expect(service.uploadImageAndGetMediaId).toHaveBeenCalledTimes(1);
  const snapshot=JSON.parse(await readFile(path.join(run.root,'story-manifest.json'),'utf8'));
  expect(service.submitStoryboardImageBatch.mock.calls[0][1]).toEqual(snapshot.document.scenes.slice(0,4).map(s=>s.frozen_prompt));
  expect(service.submitStoryboardImageBatch.mock.calls[0][3]).toEqual(Array.from({length:4},()=>[{p:'ref'}]));
  await transfer(run.root,run.runId,['p']);
  expect(service.createProject).toHaveBeenCalledTimes(1);
  expect(service.submitStoryboardImageBatch).toHaveBeenCalledTimes(1);
  expect(service.startGeneration).not.toHaveBeenCalled();
  await expect(transfer(run.root,'wrong',['p'])).rejects.toThrow('chưa chuẩn bị');
 });
});

describe('inline Story prompt preparation',()=>{
 it('prepares prompts without creating jobs or mutating saved workflow',async()=>{
  const f=await fixture(),deps=dependencies(f),runs=createAudioRuns(deps);
  const before=JSON.stringify(f.def),input=f.def.nodes[0].data;
  const def=configureInlineStory(f.def,{profiles:[{profileId:'p'}],imageModelKey:'GEM_PIX_2'},{...input,style:'Watercolor.',characterDescription:'Round face.',referencePath:f.image});
  expect(JSON.stringify(f.def)).toBe(before);
  const run=await runs.start(def,{promptsOnly:true});await runs.settled(run.runId);
  expect((await runs.get(run.runId)).status).toBe('COMPLETED');
  expect(deps.createBatch).not.toHaveBeenCalled();expect(deps.startBatch).not.toHaveBeenCalled();
  const result=await readInlineStoryResult(run.root,run.runId);
  expect(result.prompts).toHaveLength(5);expect(result.prompts[0]).toContain('Watercolor.');expect(result.references).toHaveLength(1);
  await expect(readInlineStoryResult(run.root,'wrong')).rejects.toThrow();
 });
});
