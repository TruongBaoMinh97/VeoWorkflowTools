import {describe,it,expect,vi,afterEach} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {scanStorySets,MultiStoryQueue} from '../../src/modules/workflow/lib/multiStory.js';
const roots=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),'multi-story-'));roots.push(root);
 for(const name of ['Bộ 2','Bộ 10']){const dir=path.join(root,name);await mkdir(dir);for(const file of ['story.txt','voice.srt','audio.wav'])await writeFile(path.join(dir,file),'test');}
 const referencePath=path.join(root,'ref.png');await writeFile(referencePath,'reference snapshot');
 const def={id:'w',nodes:[{id:'a',type:'audio-splitter',data:{}},{id:'r',type:'story-references',data:{sharedCharacterId:'AN',sharedOutfitId:'DEFAULT',characters:[{character_id:'AN',identity_description_en:'Character',reference_key:'AN',outfits:[{outfit_id:'DEFAULT'}]}],library:{AN:{path:referencePath,reviewStatus:'approved'}},sharedStyle:'Style'}},{id:'s',type:'scene-template',data:{}},{id:'u',type:'upload-image',data:{}},{id:'g',type:'generate-image',data:{model:'GEM_PIX_2'}},{id:'o',type:'result',data:{}}],edges:[['a','s','text-out','text-in-0'],['r','s','text-out','text-in-1'],['s','u','image-out','image-in'],['s','g','text-out','text-in'],['u','g','image-out','image-in'],['g','o','image-out','image-in']].map(([source,target,sourceHandle,targetHandle])=>({source,target,sourceHandle,targetHandle}))};
 const saved=new Map(),projects=new Map(),events=[];let run=0;
 const deps={workflow:async()=>def,profiles:async ids=>({missing:[],deduped:ids}),store:{put:async q=>saved.set(q.id,structuredClone(q)),get:async id=>structuredClone(saved.get(id)),list:async()=>[...saved.values()].map(x=>structuredClone(x))},audio:{start:vi.fn(async()=>{events.push('audio'+(++run));return {runId:'r'+run,root:path.join(root,'r'+run)}}),get:vi.fn(async()=>({status:'COMPLETED'}))},transfer:vi.fn(async(_root,id)=>{events.push('transfer'+id);const project={id:'p'+id,status:'READY',jobs:[{status:'DRAFT'}]};projects.set(project.id,project);return {projectId:project.id,count:1}}),repository:{getProject:async id=>projects.get(id)},service:{updateProject:vi.fn(async(id,values)=>Object.assign(projects.get(id),values)),startGeneration:vi.fn(async id=>{events.push('start'+id);projects.get(id).jobs[0].status='COMPLETED'}),resumeProject:vi.fn(async id=>{events.push('resume'+id);projects.get(id).jobs[0].status='COMPLETED'})},wait:async()=>{}};
 deps.download=vi.fn(async()=>({saved:1,failed:[],root:path.join(root,'images')}));
 const body={workflowId:'w',profileIds:['profile'],imageModelKey:'HARBOR_SEAL',concurrency:8,batchSize:4,delaySeconds:7,fields:{outputDir:root,referencePath,style:'Shared style',characterDescription:'Shared person'},items:await scanStorySets(root)};
 return {root,body,deps,saved,projects,events};
}
describe('multi Story queue',()=>{
 it('scans folders in natural order and rejects missing or ambiguous groups',async()=>{
  const f=await fixture();expect(f.body.items.map(x=>x.name)).toEqual(['Bộ 2','Bộ 10']);expect(f.body.items.every(x=>x.valid)).toBe(true);
  await writeFile(path.join(f.root,'Bộ 2','second.mp3'),'x');await rm(path.join(f.root,'Bộ 10','voice.srt'));
  const rows=await scanStorySets(f.root);expect(rows[0].errors).toContain('Có nhiều file audio');expect(rows[1].errors).toContain('Thiếu SRT');
 });
 it('creates separate projects sequentially, freezes reference, and uses common settings',async()=>{
  const f=await fixture(),q=new MultiStoryQueue(f.deps),view=await q.create(f.body);await q.task;
  expect(f.events).toEqual(['audio1','transferr1','startpr1','audio2','transferr2','startpr2']);
  expect((await q.get(view.id)).status).toBe('COMPLETED');expect(f.projects.get('pr1').name).toBe('Bộ 2');
  expect(f.deps.service.startGeneration.mock.calls[0]).toEqual(['pr1',8,7,undefined,4,'HARBOR_SEAL']);
  const saved=f.saved.get(view.id);await writeFile(f.body.fields.referencePath,'changed');expect(await readFile(saved.fields.referencePath,'utf8')).toBe('reference snapshot');
  expect(view.definition).toBeUndefined();expect(view.fields).toBeUndefined();
 });
 it('records preparation errors and continues the next group',async()=>{
  const f=await fixture();f.deps.audio.start.mockRejectedValueOnce(Error('Bad SRT'));const q=new MultiStoryQueue(f.deps),v=await q.create(f.body);await q.task;
  const state=await q.get(v.id);expect(state.status).toBe('COMPLETED_WITH_ERRORS');expect(state.items[0].error).toBe('Bad SRT');expect(state.items[1].status).toBe('COMPLETED');
 });
 it('pauses after current project and resumes without duplicate projects',async()=>{
  const f=await fixture();let release,entered;const ready=new Promise(r=>entered=r);
  f.deps.service.startGeneration.mockImplementationOnce(async id=>{entered();await new Promise(r=>release=r);f.projects.get(id).jobs[0].status='COMPLETED'});
  const q=new MultiStoryQueue(f.deps),v=await q.create(f.body);await ready;await q.pause(v.id);
  await expect(q.create(f.body)).rejects.toThrow('đang chạy');release();await q.task;
  expect((await q.get(v.id)).status).toBe('PAUSED');expect(f.deps.transfer).toHaveBeenCalledTimes(1);
  const restarted=new MultiStoryQueue(f.deps);await restarted.resume(v.id);await restarted.task;
  expect((await restarted.get(v.id)).status).toBe('COMPLETED');expect(f.deps.transfer).toHaveBeenCalledTimes(2);
 });
 it('recovers a saved running project without resplitting or creating another project',async()=>{
  const f=await fixture(),q=new MultiStoryQueue(f.deps),v=await q.create(f.body);await q.task;
  const saved=f.saved.get(v.id);saved.status='RUNNING';saved.items[0].status='GENERATING';f.projects.get(saved.items[0].projectId).jobs[0].status='QUEUED';
  const restarted=new MultiStoryQueue(f.deps);expect((await restarted.get(v.id)).status).toBe('INTERRUPTED');await restarted.resume(v.id);await restarted.task;
  expect(f.deps.audio.start).toHaveBeenCalledTimes(2);expect(f.deps.transfer).toHaveBeenCalledTimes(2);expect(f.deps.service.resumeProject).toHaveBeenCalledTimes(1);
 });
 it('does not start next project after partial start leaves queued jobs',async()=>{
  const f=await fixture();f.deps.service.startGeneration.mockImplementationOnce(async id=>{f.projects.get(id).jobs[0].status='QUEUED';throw Error('start interrupted')});
  const q=new MultiStoryQueue(f.deps),v=await q.create(f.body);await q.task;expect((await q.get(v.id)).status).toBe('PAUSED');expect(f.deps.transfer).toHaveBeenCalledTimes(1);
 });
 it('rejects duplicate sets before creating jobs',async()=>{
  const f=await fixture();f.body.items=[f.body.items[0],f.body.items[0]];await expect(new MultiStoryQueue(f.deps).create(f.body)).rejects.toThrow('trùng');expect(f.deps.audio.start).not.toHaveBeenCalled();
 });
});
