import path from 'node:path';
import {readdir,stat,mkdir,copyFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {configureInlineStory} from './inlineStoryPrompts.js';
import {sharedConfiguration,requireFile} from './audioStory.js';

const audioExtensions=new Set(['.mp3','.wav','.m4a','.aac','.flac','.ogg','.opus','.wma']);
const kind=file=>path.extname(file).toLowerCase()==='.txt'?'txtPath':path.extname(file).toLowerCase()==='.srt'?'srtPath':audioExtensions.has(path.extname(file).toLowerCase())?'audioPath':null;
export async function scanStorySets(root,mode='folders'){
 if(!path.isAbsolute(root||'')||!(await stat(root).catch(()=>null))?.isDirectory())throw Error('Chọn thư mục đầu vào hợp lệ.');
 if(!['folders','names'].includes(mode))throw Error('Cách ghép bộ không hợp lệ.');
 const entries=await readdir(root,{withFileTypes:true}),groups=new Map();
 if(mode==='folders'){
  for(const entry of entries.filter(e=>e.isDirectory()&&!e.isSymbolicLink())){
   const dir=path.join(root,entry.name),files=await readdir(dir,{withFileTypes:true});
   const relevant=files.filter(f=>f.isFile()&&kind(f.name)).map(f=>path.join(dir,f.name));
   if(relevant.length)groups.set(entry.name,relevant);
  }
 }else{
  for(const entry of entries.filter(e=>e.isFile()&&kind(e.name))){
   const name=path.parse(entry.name).name.normalize('NFC').toLowerCase();
   if(!groups.has(name))groups.set(name,[]);
   groups.get(name).push(path.join(root,entry.name));
  }
 }
 if(groups.size>100)throw Error('Mỗi lượt hỗ trợ tối đa 100 bộ.');
 return [...groups].sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true})).map(([name,files])=>{
  const row={name,txtPath:'',srtPath:'',audioPath:'',errors:[]};
  for(const [key,label] of [['txtPath','TXT'],['srtPath','SRT'],['audioPath','audio']]){
   const matches=files.filter(f=>kind(f)===key);
   if(matches.length!==1)row.errors.push(matches.length?'Có nhiều file '+label:'Thiếu '+label);
   else row[key]=matches[0];
  }
  return {...row,valid:row.errors.length===0};
 });
}
const terminal=new Set(['COMPLETED','FAILED','CANCELLED']);
const doneItem=new Set(['COMPLETED','ERROR']);
export class MultiStoryQueue{
 constructor(deps){this.deps=deps;this.active=null;this.changing=false;this.writes=Promise.resolve();}
 save(queue){queue.updatedAt=new Date().toISOString();const snapshot=structuredClone(queue);const next=this.writes.then(()=>this.deps.store.put(snapshot));this.writes=next.catch(()=>{});return next;}
 view(queue){const {definition,fields,...publicQueue}=queue;return publicQueue;}
 async list(){return (await this.deps.store.list()).map(q=>this.view(this.active?.id===q.id?this.active:this.recovered(q)));}
 recovered(q){if(['RUNNING','PAUSING'].includes(q.status))q.status='INTERRUPTED';return q;}
 async get(id){const q=this.active?.id===id?this.active:await this.deps.store.get(id);if(!q)throw Error('Không tìm thấy hàng đợi.');return this.view(this.active?.id===id?q:this.recovered(q));}
 async create(body){
  if(this.changing||this.active)throw Error('Một hàng đợi đang chạy. Dừng sau dự án hiện tại trước khi tạo lượt khác.');
  this.changing=true;
  try{
   const def=await this.deps.workflow(body.workflowId);if(!def)throw Error('Chọn mẫu Story.');
   const profiles=await this.deps.profiles(body.profileIds);if(profiles.missing.length||!profiles.deduped.length)throw Error('Chọn ít nhất một profile hợp lệ.');
   const settings={concurrency:body.concurrency,batchSize:body.batchSize,delaySeconds:body.delaySeconds,imageModelKey:body.imageModelKey};
   const fields={...body.fields};
   if(!path.isAbsolute(fields.outputDir||''))throw Error('Chọn thư mục lưu kết quả.');
   for(const row of body.items)for(const [key,label]of [['txtPath','TXT'],['srtPath','SRT'],['audioPath','audio']])await requireFile(row[key],row.name+' / '+label);
   const distinct=new Set(body.items.map(r=>JSON.stringify([r.txtPath,r.srtPath,r.audioPath].map(x=>path.resolve(x).toLowerCase()))));
   if(distinct.size!==body.items.length)throw Error('Có bộ file bị trùng trong hàng đợi.');
   const first=body.items[0];
   const configured=configureInlineStory(def,{profiles:profiles.deduped.map(profileId=>({profileId})),imageModelKey:settings.imageModelKey},{...fields,...first});
   sharedConfiguration(configured);
   await requireFile(fields.referencePath,'Ảnh nhân vật');
   const id=randomUUID(),root=path.join(fields.outputDir,'multi-story-'+id);
   await mkdir(root,{recursive:true});
   const referencePath=path.join(root,'shared-character'+path.extname(fields.referencePath));await copyFile(fields.referencePath,referencePath);
   fields.referencePath=referencePath;fields.outputDir=root;
   const q={id,name:body.name||'Story nhiều bộ',status:'RUNNING',createdAt:new Date().toISOString(),definition:def,fields,settings,profileIds:profiles.deduped,root,items:body.items.map((r,i)=>({name:r.name,txtPath:r.txtPath,srtPath:r.srtPath,audioPath:r.audioPath,index:i,status:'WAITING',projectId:null,runId:null,runRoot:null,completed:0,total:0,failed:0})),error:null};
   await this.save(q);this.launch(q);return this.view(q);
  }finally{this.changing=false;}
 }
 launch(q){this.active=q;this.task=this.run(q).catch(async error=>{q.status='INTERRUPTED';q.error=error.message;await this.save(q).catch(()=>{});}).finally(()=>{if(this.active===q)this.active=null;});}
 async pause(id){if(this.active?.id!==id)throw Error('Hàng đợi không đang chạy.');this.active.status='PAUSING';await this.save(this.active);return this.view(this.active);}
 async resume(id){
  if(this.active||this.changing)throw Error('Một hàng đợi đang chạy.');this.changing=true;
  try{const q=await this.deps.store.get(id);if(!q||!['PAUSED','RUNNING','PAUSING','INTERRUPTED'].includes(q.status))throw Error('Hàng đợi không thể tiếp tục.');q.status='RUNNING';q.error=null;await this.save(q);this.launch(q);return this.view(q);}finally{this.changing=false;}
 }
 async run(q){
  for(const item of q.items){
   if(doneItem.has(item.status))continue;
   if(q.status==='PAUSING'){q.status='PAUSED';await this.save(q);return;}
   try{
    if(!item.runId){
     item.status='PREPARING';await this.save(q);
     const outputDir=path.join(q.root,String(item.index+1).padStart(3,'0'));await mkdir(outputDir,{recursive:true});
     const def=configureInlineStory(q.definition,{profiles:q.profileIds.map(profileId=>({profileId})),imageModelKey:q.settings.imageModelKey},{...q.fields,...item,outputDir});
     const audio=await this.deps.audio.start(def,{promptsOnly:true});item.runId=audio.runId;item.runRoot=audio.root;await this.save(q);
    }
    if(!item.projectId){
     while(true){
      const audio=await this.deps.audio.get(item.runId,item.runRoot);item.message=audio.message;
      if(audio.status==='COMPLETED')break;
      if(['FAILED','CANCELLED'].includes(audio.status))throw Error(audio.error||'Lỗi chuẩn bị audio.');
      await this.save(q);await this.wait();
     }
     item.status='TRANSFERRING';await this.save(q);
     const result=await this.deps.transfer(item.runRoot,item.runId,q.profileIds);
     item.projectId=result.projectId;item.total=result.count;await this.save(q);
     await this.deps.service.updateProject(item.projectId,{name:item.name,...q.settings,autoDownload:true});
    }
    let project=await this.deps.repository.getProject(item.projectId);if(!project)throw Error('Dự án đã bị xóa.');
    const jobs=project.jobs||[];if(!jobs.length)throw Error('Dự án chưa có job.');
    if(jobs.some(j=>j.status==='DRAFT'))await this.deps.service.startGeneration(item.projectId,q.settings.concurrency,q.settings.delaySeconds,undefined,q.settings.batchSize,q.settings.imageModelKey);
    else if(jobs.some(j=>!terminal.has(j.status)))await this.deps.service.resumeProject(item.projectId);
    item.status='GENERATING';await this.save(q);
    while(true){
     project=await this.deps.repository.getProject(item.projectId);if(!project)throw Error('Dự án đã bị xóa.');
     const current=project.jobs||[];
     item.total=current.length;item.completed=current.filter(j=>j.status==='COMPLETED').length;item.failed=current.filter(j=>['FAILED','CANCELLED'].includes(j.status)).length;
     if(!current.length)throw Error('Dự án không còn job.');
     if(current.every(j=>terminal.has(j.status))){
      item.status='DOWNLOADING';await this.save(q);
      const downloads=await this.deps.download(project,async(saved,failed)=>{item.downloaded=saved;item.downloadFailed=failed;await this.save(q);});
      item.downloaded=downloads.saved;item.downloadFailed=downloads.failed.length;item.imagesRoot=downloads.root;
      item.status=item.failed||item.downloadFailed?'ERROR':'COMPLETED';
      item.error=[item.failed?`${item.failed} ảnh lỗi/hủy. Mở dự án để kiểm tra và gen lại.`:'',item.downloadFailed?`${item.downloadFailed} ảnh chưa tải được. Mở dự án để tải lại.`:''].filter(Boolean).join(' ')||null;
      await this.save(q);break;
     }
     if(['PAUSED','STOPPED'].includes(project.status)){q.status='PAUSED';item.message='Dự án đã tạm dừng. Bấm Tiếp tục hàng đợi để chạy lại.';await this.save(q);return;}
     await this.save(q);await this.wait();
    }
   }catch(error){
    item.error=error.message;
    // If start partially succeeded, do not overlap another project with its live jobs.
    if(item.projectId){
     const project=await this.deps.repository.getProject(item.projectId);
     if(project?.jobs?.some(j=>['QUEUED','PROCESSING'].includes(j.status))){q.status='PAUSED';await this.save(q);return;}
    }
    item.status='ERROR';await this.save(q);
   }
  }
  q.status=q.items.some(i=>i.status==='ERROR')?'COMPLETED_WITH_ERRORS':'COMPLETED';await this.save(q);
 }
 wait(){return this.deps.wait?this.deps.wait():new Promise(r=>setTimeout(r,3000));}
}
