import { describe,it,expect,beforeEach,afterEach,vi } from 'vitest';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { MangaStoryStore,defaultMangaConfig,assertMangaDrafts,buildCharacterSheetPrompt } from '../../src/modules/genNormal/mangaStory.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=','base64');
describe('Manga Story project integration',()=>{
 let root,store,project,service,asset,config;
 beforeEach(async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),'manga-test-'));
  project={id:'project',profiles:[{profileId:'p1',veo3ProjectId:'remote1'},{profileId:'p2',veo3ProjectId:'remote2'}],jobs:[],aspectRatio:'16:9',imageModelKey:'GEM_PIX_2'};
  service={ensureVeo3Projects:vi.fn(),uploadImageAndGetMediaId:vi.fn(async(file,profile)=>({mediaId:profile+'-'+path.basename(file)})),startGeneration:vi.fn(),submitStoryboardImageBatch:vi.fn(async(id,prompts,aspect,refs,append)=>{expect(append).toBe(true);prompts.forEach((prompt,i)=>project.jobs.push({id:randomUUID(),prompt,status:'DRAFT',refs:refs[i]}));})};
  store=new MangaStoryStore({root,repository:{getProject:async()=>project},service,download:vi.fn()});
  const file=path.join(root,'ref.png');await writeFile(file,png);asset=(await store.importAsset('project',file)).asset;
  config={...defaultMangaConfig(),characters:[{id:'KEIKO',name:'Keiko',description:'66 years old',outfit:'green cardigan',asset},{id:'YUMI',name:'Yumi',description:'35 years old',outfit:'blue shirt',asset}],text:'SC001 | @KEIKO greets @YUMI.\nSC002 | @YUMI talks to @KEIKO.\nSC003 | A cup, no people.'};
 });
 afterEach(async()=>{while(store.locks.size||store.tasks.size)await new Promise(r=>setTimeout(r,10));await rm(root,{recursive:true,force:true});});
 const finish=async()=>{await new Promise(r=>setTimeout(r,10));while(store.tasks.size)await new Promise(r=>setTimeout(r,10));};
 it('binds each visible character in scene order and leaves object scene empty',async()=>{
  const p=await store.preview('project',config);expect(p.rows.map(r=>r.images.map(i=>i.characterId))).toEqual([['KEIKO','YUMI'],['YUMI','KEIKO'],[]]);expect(p.rows.every(r=>r.ready)).toBe(true);expect(p.rows[1].prompt).toContain('Reference image 1: Yumi');
 });
 it('rejects duplicate IDs, missing characters and missing images',async()=>{
  await expect(store.save('project',{...config,characters:[config.characters[0],config.characters[0]]},0)).rejects.toThrow('Trùng');
  await expect(store.preview('project',{...config,text:'@UNKNOWN smiles.'})).rejects.toThrow('chưa có');
  config.characters[0].asset='';const p=await store.preview('project',config);expect(p.rows[0].ready).toBe(false);expect(p.rows[0].error).toContain('Thiếu');
 });
 it('counts style references and never drops them silently',async()=>{
  const p=await store.preview('project',{...config,styleAsset:asset,maxReferences:2});expect(p.rows[0].ready).toBe(false);expect(p.rows[0].error).toContain('giới hạn');expect(p.rows[2].images[0].role).toBe('style');
 });
 it('persists configuration and refuses stale edits',async()=>{
  await store.save('project',config,0);const reopened=new MangaStoryStore({root,repository:store.repository,service});expect((await reopened.read('project')).config).toEqual(config);await expect(store.save('project',config,0)).rejects.toThrow('cửa sổ khác');
 });
 it('keeps snapshots, appends jobs, deduplicates request and maps references per profile',async()=>{
  project.jobs.push({id:'existing',prompt:'old',status:'COMPLETED'});await store.save('project',config,0);const request={revision:1,sceneIds:['SC002','SC003'],requestId:randomUUID()};
  const run=await store.submit('project',request);await finish();expect(project.jobs).toHaveLength(3);expect(service.uploadImageAndGetMediaId).toHaveBeenCalledTimes(2);expect(project.jobs[1].refs[0]).toHaveProperty('p2');expect(project.jobs[2].refs).toEqual([]);
  expect((await store.submit('project',request)).id).toBe(run.id);expect(service.submitStoryboardImageBatch).toHaveBeenCalledTimes(1);
  await store.save('project',{...config,style:'Changed style'},1);const state=await store.context('project');expect(state.runs[0].config.style).toBe(config.style);expect(state.runs[0].rows[0].job.id).toBe(project.jobs[1].id);
 });
 it('does not submit jobs after incomplete upload',async()=>{
  service.uploadImageAndGetMediaId.mockResolvedValue({});await store.save('project',config,0);await store.submit('project',{revision:1,sceneIds:['SC001'],requestId:randomUUID()});await finish();expect(service.submitStoryboardImageBatch).not.toHaveBeenCalled();expect((await store.read('project')).runs[0].status).toBe('FAILED');
 });
 it('requires confirmation for bulk without requiring approved images and rejects duplicate scenes',async()=>{
  config.text=Array.from({length:5},(_,i)=>`SC${i} | A cup.`).join('\n');await store.save('project',config,0);
  await expect(store.submit('project',{revision:1,sceneIds:['SC0','SC1','SC2','SC3','SC4'],requestId:randomUUID(),verified:false})).rejects.toThrow('Xác nhận');
  await expect(store.submit('project',{revision:1,sceneIds:['SC0','SC0'],requestId:randomUUID()})).rejects.toThrow('không hợp lệ');
  await store.submit('project',{revision:1,sceneIds:['SC0','SC1','SC2','SC3','SC4'],requestId:randomUUID(),verified:true});await finish();expect(project.jobs).toHaveLength(5);expect((await store.read('project')).approved).toEqual({});
 });
 it('protects start from unrelated drafts and changed models',async()=>{
  await store.save('project',config,0);const run=await store.submit('project',{revision:1,sceneIds:['SC003'],requestId:randomUUID()});await finish();project.jobs.push({id:'other',prompt:'other',status:'DRAFT'});await expect(store.start('project',run.id)).rejects.toThrow('job chờ khác');project.jobs.pop();project.imageModelKey='other';await expect(store.start('project',run.id)).rejects.toThrow('Cấu hình Gen');project.imageModelKey='GEM_PIX_2';await store.start('project',run.id);expect(service.startGeneration).toHaveBeenCalledOnce();
 });
 it('adopts completed character image and retains approved scene versions',async()=>{
  await store.save('project',config,0);await store.submit('project',{revision:1,sceneIds:[],characterId:'KEIKO',requestId:randomUUID()});await finish();const job=project.jobs[0];job.status='COMPLETED';job.resultUrl=store.assetPath('project',asset);await store.approve('project',job.id,'KEIKO');const state=await store.read('project');expect(state.revision).toBe(2);expect(state.config.characters[0].asset).toBe(asset);expect(state.runs).toHaveLength(1);
 });
 it('adopts an old character run after JSON import renames a placeholder ID to its former name',async()=>{
  const legacy={...config,characters:[{...config.characters[0],id:'CHAR1',name:'MICHIKO_HOME',asset:''}]};
  await store.save('project',legacy,0);await store.submit('project',{revision:1,sceneIds:[],characterId:'CHAR1',requestId:randomUUID()});await finish();
  const job=project.jobs[0];job.status='COMPLETED';job.resultUrl=store.assetPath('project',asset);
  await store.save('project',{...legacy,characters:[{...legacy.characters[0],id:'MICHIKO_HOME',name:'Michiko'}]},1);
  await store.approve('project',job.id,'CHAR1');const state=await store.read('project');expect(state.config.characters[0].id).toBe('MICHIKO_HOME');expect(state.config.characters[0].asset).toBe(asset);
 });
 it('returns the complete Manga history and can adopt a completed historical character image',async()=>{
  await store.save('project',config,0);await store.submit('project',{revision:1,sceneIds:[],characterId:'KEIKO',requestId:randomUUID()});await finish();
  const job=project.jobs[0];job.status='COMPLETED';job.resultUrl=store.assetPath('project',asset);
  const history=await store.history('project');expect(history.runs).toHaveLength(1);expect(history.runs[0].sourceProjectId).toBe('project');expect(history.runs[0].targetCharacterId).toBe('KEIKO');
  await store.adopt('project',{sourceProjectId:'project',jobId:job.id,targetCharacterId:'KEIKO'});expect((await store.read('project')).config.characters[0].asset).toBe(asset);
 });
 it('rejects non-image input and asset traversal',async()=>{
  const file=path.join(root,'bad.png');await writeFile(file,'not image');await expect(store.importAsset('project',file)).rejects.toThrow('không chứa ảnh');expect(()=>store.assetPath('project','../state.json')).toThrow();
 });
 it('also protects ordinary Gen start from model changes',async()=>{
  await store.save('project',config,0);await store.submit('project',{revision:1,sceneIds:['SC003'],requestId:randomUUID()});await finish();await expect(assertMangaDrafts(project,project.jobs,'other',root)).rejects.toThrow('snapshot');await expect(assertMangaDrafts(project,project.jobs,'GEM_PIX_2',root)).resolves.toBeUndefined();
 });
 it('recovers an interrupted manifest without duplicating existing jobs',async()=>{
  await store.save('project',config,0);const run=await store.submit('project',{revision:1,sceneIds:['SC003'],requestId:randomUUID()});await finish();const state=await store.read('project');state.runs[0].status='PREPARING';await store.write('project',state);const reopened=new MangaStoryStore({root,repository:store.repository,service});expect((await reopened.context('project')).runs[0].status).toBe('READY');expect(service.submitStoryboardImageBatch).toHaveBeenCalledOnce();
 });
 it('generates five-view character sheets while scene prompts forbid copying the sheet layout',async()=>{
  const prompt=buildCharacterSheetPrompt(config.characters[0],config.style,'16:9',true);
  expect(prompt).toContain('Reference image 1 defines');expect(prompt).toContain('Reference image 2 is STYLE ONLY');
  for(const part of ['back view','front-facing','true side-profile','three-quarter','Exactly five views','green cardigan','66 years old','Canvas aspect ratio: 16:9'])expect(prompt).toContain(part);
  expect(prompt).not.toContain('medium full shot');
  const fresh=buildCharacterSheetPrompt({...config.characters[0],asset:''},config.style,'16:9',true);expect(fresh).toContain('Reference image 1 is STYLE ONLY');expect(fresh).not.toContain('defines the existing');
  await store.save('project',config,0);await store.submit('project',{revision:1,sceneIds:[],characterId:'KEIKO',requestId:randomUUID()});await finish();expect(project.jobs[0].prompt).toContain('Exactly five views');
  const preview=await store.preview('project',config);expect(preview.rows[0].prompt).toContain('ONE continuous scene');expect(preview.rows[0].prompt).toContain('Each sheet represents ONE person');
 });
 it('supports batch generating sample jobs for all characters in a single run',async()=>{
  await store.save('project',config,0);
  const request={revision:1,sceneIds:[],characterIds:['KEIKO','YUMI'],requestId:randomUUID()};
  const run=await store.submit('project',request);
  await finish();
  expect(run.characterIds).toEqual(['KEIKO','YUMI']);
  expect(project.jobs).toHaveLength(2);
  expect(project.jobs[0].prompt).toContain('Character: Keiko');
  expect(project.jobs[1].prompt).toContain('Character: Yumi');
  const job0=project.jobs[0];job0.status='COMPLETED';job0.resultUrl=store.assetPath('project',asset);
  await store.approve('project',job0.id,'KEIKO');
  const updated=await store.read('project');
  expect(updated.config.characters[0].asset).toBe(asset);
 });
});
