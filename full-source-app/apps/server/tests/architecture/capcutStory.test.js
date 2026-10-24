import {describe,it,expect,beforeAll,afterAll} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {readAudioScenes,readVisualTimeline,parseSrtTimeline,pairScenes,pairImagesToSrt,pairImagesToTimeline,resolveCapcutBatchIndex,createCapcutProject,patchCapcutProject,collectLatestSceneJobs} from '../../src/modules/workflow/lib/capcutStory.js';
let root,audio,image,project;
const ffmpeg=path.resolve('binaries/ffmpeg/win32-x64-ffmpeg.exe'),ffprobe=path.resolve('binaries/ffmpeg/win32-x64-ffprobe.exe');
beforeAll(async()=>{
 root=await fs.mkdtemp(path.join(os.tmpdir(),'story-capcut-'));audio=path.join(root,'âm thanh');await fs.mkdir(audio);
 image=path.join(root,'ảnh.png');execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=blue:s=64x36','-frames:v','1',image],{windowsHide:true});
 for(const [i,d]of [[1,0.731],[2,1.257]])execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t',String(d),path.join(audio,String(i).padStart(3,'0')+'.wav')],{windowsHide:true});
 project={id:'test',name:'Story test',aspectRatio:'16:9',jobs:[0,1].map(i=>({id:'job'+i,jobIndex:i,batchIndex:0,mode:'IMAGE_GENERATION',status:'COMPLETED',resultUrl:image}))};
},30000);
afterAll(async()=>{if(root&&path.basename(root).startsWith('story-capcut-'))await fs.rm(root,{recursive:true,force:true})});
describe('Story CapCut export',()=>{
 it('writes equal image/audio timing from real WAV duration, self-contained files, unique drafts and preserves root index',async()=>{
  const output=path.join(root,'drafts');await fs.mkdir(output);const existing={draft_id:'keep',draft_name:'old'};await fs.writeFile(path.join(output,'root_meta_info.json'),JSON.stringify({all_draft_store:[existing],keep:true}));
  const args={project,batchIndex:0,audioFolder:audio,draftsRoot:output};
  const first=await createCapcutProject(args,{ffprobe,isCapcutRunning:async()=>false});
  const second=await createCapcutProject(args,{ffprobe,isCapcutRunning:async()=>false});
  expect(first.path).not.toBe(second.path);expect(first.count).toBe(2);
  const draft=JSON.parse(await fs.readFile(path.join(first.path,'draft_content.json'),'utf8'));
  const [v,a]=draft.tracks.map(t=>t.segments);expect(v.map(s=>s.target_timerange)).toEqual(a.map(s=>s.target_timerange));
  expect(v.map(s=>s.target_timerange)).toEqual([{start:0,duration:731000},{start:731000,duration:1257000}]);expect(draft.duration).toBe(1988000);
  for(const material of [...draft.materials.videos,...draft.materials.audios])expect((await fs.stat(material.path)).size).toBeGreaterThan(0);
  const ids=new Set(Object.values(draft.materials).flat().map(m=>m.id));for(const seg of [...v,...a])for(const id of [seg.material_id,...seg.extra_material_refs])expect(ids.has(id)).toBe(true);
  const index=JSON.parse(await fs.readFile(path.join(output,'root_meta_info.json'),'utf8'));expect(index.all_draft_store).toHaveLength(3);expect(index.all_draft_store[2]).toEqual(existing);expect(index.keep).toBe(true);
 },15000);
 it('does not modify an open CapCut index and keeps a complete new draft',async()=>{
  const output=path.join(root,'open-drafts');await fs.mkdir(output);await fs.writeFile(path.join(output,'root_meta_info.json'),'original');
  const result=await createCapcutProject({project,batchIndex:0,audioFolder:audio,draftsRoot:output},{ffprobe,isCapcutRunning:async()=>true});
  expect(result.warning).toContain('CapCut đang mở');expect(await fs.readFile(path.join(output,'root_meta_info.json'),'utf8')).toBe('original');
 });
 it('uses UT SRT timing for fewer images and stops audio at the selected SRT range',async()=>{
  const groupedAudio=path.join(root,'grouped-audio');await fs.mkdir(groupedAudio);
  for(const [i,d]of [[1,0.4],[2,0.331],[3,1.257],[4,0.5]])execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t',String(d),path.join(groupedAudio,String(i).padStart(3,'0')+'.wav')],{windowsHide:true});
  const srt=path.join(root,'ut.srt');await fs.writeFile(srt,'1\n00:00:00,000 --> 00:00:00,500\nUT001 | NARRATOR\n\n2\n00:00:00,731 --> 00:00:01,988\nUT002 | MICHIKO\n');
  const cues=parseSrtTimeline(await fs.readFile(srt,'utf8'));
  expect(cues.map(c=>[c.utteranceId,c.startUs,c.durationUs])).toEqual([['UT001',0,731000],['UT002',731000,1257000]]);
  expect(pairImagesToSrt(project,0,cues).map(p=>p.job.id)).toEqual(['job0','job1']);
  const output=path.join(root,'srt-drafts');await fs.mkdir(output);
  const result=await createCapcutProject({project,batchIndex:0,audioFolder:groupedAudio,srtPath:srt,alignmentMode:'srt',draftsRoot:output},{ffprobe,isCapcutRunning:async()=>false});
  expect(result.count).toBe(2);expect(result.audioCount).toBe(3);expect(result.alignmentMode).toBe('srt');
  const draft=JSON.parse(await fs.readFile(path.join(result.path,'draft_content.json'),'utf8'));
  const [images,audios]=draft.tracks.map(t=>t.segments.map(s=>s.target_timerange));
  expect(images).toEqual([{start:0,duration:731000},{start:731000,duration:1257000}]);
  expect(audios).toEqual([{start:0,duration:400000},{start:400000,duration:331000},{start:731000,duration:1257000}]);
  const report=JSON.parse(await fs.readFile(path.join(result.path,'story-sync.json'),'utf8'));
  expect(report.alignmentMode).toBe('srt');expect(report.images).toHaveLength(2);expect(report.audios).toHaveLength(3);
 });
 it('uses one continuous master audio and stable scene IDs from visual timeline',async()=>{
  const story=path.join(root,'timeline-story');await fs.mkdir(story);const inputs=path.join(story,'inputs');await fs.mkdir(inputs);
  const master=path.join(inputs,'audio.wav');execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=330:sample_rate=48000','-t','1.988',master],{windowsHide:true});
  await fs.writeFile(path.join(story,'visual_timeline.json'),JSON.stringify({schema_version:'visual-timeline/v1',master_audio:master,audio_duration_ms:1988,scenes:[
   {scene_id:'UT001',utterance_ids:['UT001'],speaker_id:'NARRATOR',source_text:'Mở đầu.',start_ms:0,end_ms:731},
   {scene_id:'UT002',utterance_ids:['UT002'],speaker_id:'KEIKO',source_text:'Câu tiếp theo.',start_ms:731,end_ms:1988},
  ]}));
  const timeline=await readVisualTimeline(story);expect(timeline.scenes.map(s=>s.sceneId)).toEqual(['UT001','UT002']);
  const tagged={...project,jobs:[
   {...project.jobs[0],prompt:'Manga run abc / UT002. Do not render this identifier as text.'},
   {...project.jobs[1],prompt:'Manga run abc / UT001. Do not render this identifier as text.'},
  ]};
  expect(pairImagesToTimeline(tagged,0,timeline.scenes).map(p=>p.job.id)).toEqual(['job1','job0']);
  const output=path.join(root,'timeline-drafts');await fs.mkdir(output);
  const result=await createCapcutProject({project,batchIndex:0,audioFolder:story,alignmentMode:'timeline',draftsRoot:output},{ffprobe,isCapcutRunning:async()=>false});
  expect(result).toMatchObject({count:2,audioCount:1,alignmentMode:'timeline'});
  const draft=JSON.parse(await fs.readFile(path.join(result.path,'draft_content.json'),'utf8'));
  const [images,audios]=draft.tracks.map(track=>track.segments.map(segment=>segment.target_timerange));
  expect(images).toEqual([{start:0,duration:731000},{start:731000,duration:1257000}]);
  expect(audios).toEqual([{start:0,duration:1988000}]);
  const report=JSON.parse(await fs.readFile(path.join(result.path,'story-sync.json'),'utf8'));
  expect(report.visualTimeline).toBe(path.join(story,'visual_timeline.json'));expect(report.images[1].sceneId).toBe('UT002');
 });
 it('merges partial regenerated scene batches with earlier batches and hot-patches existing CapCut drafts',async()=>{
  const story=path.join(root,'timeline-merge-story');await fs.mkdir(story);const inputs=path.join(story,'inputs');await fs.mkdir(inputs);
  const master=path.join(inputs,'audio.wav');execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=330:sample_rate=48000','-t','1.988',master],{windowsHide:true});
  await fs.writeFile(path.join(story,'visual_timeline.json'),JSON.stringify({schema_version:'visual-timeline/v1',master_audio:master,audio_duration_ms:1988,scenes:[
   {scene_id:'UT001',utterance_ids:['UT001'],speaker_id:'NARRATOR',source_text:'Cảnh 1.',start_ms:0,end_ms:731},
   {scene_id:'UT002',utterance_ids:['UT002'],speaker_id:'KEIKO',source_text:'Cảnh 2.',start_ms:731,end_ms:1988},
  ]}));
  const patchedImage=path.join(root,'ảnh-vá.png');execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=red:s=64x36','-frames:v','1',patchedImage],{windowsHide:true});
  const multiBatchProject={...project,jobs:[
   {id:'b0_1',jobIndex:0,batchIndex:0,mode:'IMAGE_GENERATION',status:'COMPLETED',resultUrl:image,prompt:'Manga run r1 / UT001. Do not render this identifier as text.'},
   {id:'b0_2',jobIndex:1,batchIndex:0,mode:'IMAGE_GENERATION',status:'COMPLETED',resultUrl:image,prompt:'Manga run r1 / UT002. Do not render this identifier as text.'},
   {id:'b1_2',jobIndex:2,batchIndex:1,mode:'IMAGE_GENERATION',status:'COMPLETED',resultUrl:patchedImage,prompt:'Manga run r2 / UT002. Do not render this identifier as text.'},
  ]};
  const timeline=await readVisualTimeline(story);
  // Selecting partial batch 1 automatically merges with batch 0 for missing scenes
  expect(pairImagesToTimeline(multiBatchProject,1,timeline.scenes).map(p=>p.job.id)).toEqual(['b0_1','b1_2']);
  // Selecting 'merged' also picks the latest job per sceneId
  expect(pairImagesToTimeline(multiBatchProject,'merged',timeline.scenes).map(p=>p.job.id)).toEqual(['b0_1','b1_2']);
  // Create initial draft from batch 0, then hot-patch it with batch 1
  const output=path.join(root,'patch-drafts');await fs.mkdir(output);
  const initialProject={...multiBatchProject,jobs:multiBatchProject.jobs.slice(0,2)};
  const created=await createCapcutProject({project:initialProject,batchIndex:0,audioFolder:story,alignmentMode:'timeline',draftsRoot:output},{ffprobe,isCapcutRunning:async()=>false});
  const beforeBytes=await fs.readFile(path.join(created.path,'media','UT002.png'));
  const patchRes=await patchCapcutProject({project:multiBatchProject,draftPath:created.path,batchIndex:1},{isCapcutRunning:async()=>false});
  expect(patchRes.patchedCount).toBe(1);
  expect(patchRes.patchedScenes).toEqual(['UT002']);
  const afterBytes=await fs.readFile(path.join(created.path,'media','UT002.png'));
  expect(afterBytes.equals(beforeBytes)).toBe(false);
  const syncReport=JSON.parse(await fs.readFile(path.join(created.path,'story-sync.json'),'utf8'));
  expect(syncReport.images.find(img=>img.sceneId==='UT002').jobId).toBe('b1_2');
 });
 it('blocks failed/missing/extra image jobs and never uses a different batch or edit child',async()=>{
  const scenes=await readAudioScenes(audio);
  expect(()=>pairScenes({...project,jobs:project.jobs.slice(1)},0,scenes)).toThrow('ảnh');
  expect(()=>pairScenes({...project,jobs:project.jobs.map((j,i)=>i?{...j,status:'FAILED'}:j)},0,scenes)).toThrow('chưa hoàn tất');
  expect(()=>pairScenes({...project,jobs:[...project.jobs,{...project.jobs[0],id:'extra',jobIndex:2}]},0,scenes)).toThrow('ảnh');
  expect(pairScenes({...project,jobs:[...project.jobs,{...project.jobs[0],parentJobId:'job0'},{...project.jobs[0],batchIndex:1}]},0,scenes).map(p=>p.job.id)).toEqual(['job0','job1']);
 });
 it('does not coerce an empty saved batch selection to batch zero',()=>{
  const withCharacterRuns={...project,jobs:[
   {...project.jobs[0],id:'character',jobIndex:0,batchIndex:0},
   {...project.jobs[0],id:'scene1',jobIndex:1,batchIndex:3,prompt:'Manga run r1 / SC001. Do not render this identifier as text.'},
   {...project.jobs[1],id:'scene2',jobIndex:2,batchIndex:3,prompt:'Manga run r1 / SC002. Do not render this identifier as text.'},
  ]};
  expect(resolveCapcutBatchIndex(withCharacterRuns,'')).toBe(3);
  expect(resolveCapcutBatchIndex(withCharacterRuns,0)).toBe(0);
  expect(resolveCapcutBatchIndex(withCharacterRuns,'merged')).toBe('merged');
  expect(()=>pairScenes(withCharacterRuns,'',[{sceneId:'SC001'},{sceneId:'SC002'}])).toThrow('Chưa có lượt');
 });
 it('uses manifest scene order and rejects duplicate or missing audio numbers without a manifest',async()=>{
  const story=path.join(root,'story');await fs.mkdir(story);await fs.writeFile(path.join(story,'story-manifest.json'),JSON.stringify({selectedSceneIds:['SC002','SC001'],document:{scenes:[{scene_id:'SC001',audio_file:'a'},{scene_id:'SC002',audio_file:'b'}]}}));
  expect((await readAudioScenes(story)).map(s=>s.audioFile)).toEqual(['b','a']);
  const bad=path.join(root,'bad');await fs.mkdir(bad);await fs.writeFile(path.join(bad,'002.wav'),'');await expect(readAudioScenes(bad)).rejects.toThrow('thiếu');await fs.writeFile(path.join(bad,'SC002.mp3'),'');await expect(readAudioScenes(bad)).rejects.toThrow('trùng');
 });
 it('rolls back only its own staging folder when media are corrupt',async()=>{
  const output=path.join(root,'failed');await fs.mkdir(output);await fs.writeFile(path.join(output,'keep.txt'),'unchanged');
  const corrupt=path.join(root,'broken.png');await fs.writeFile(corrupt,'not an image');
  await expect(createCapcutProject({project:{...project,jobs:project.jobs.map(j=>({...j,resultUrl:corrupt}))},batchIndex:0,audioFolder:audio,draftsRoot:output},{ffprobe})).rejects.toThrow();
  expect(await fs.readdir(output)).toEqual(['keep.txt']);
 });
});
