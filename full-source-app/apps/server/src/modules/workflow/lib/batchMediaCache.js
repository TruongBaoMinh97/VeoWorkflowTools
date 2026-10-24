import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {prisma} from '../../../lib/prisma.js';

export class BatchMediaCache {
 constructor({ttlMs=2*60*60*1000,now=()=>Date.now()}={}){this.uploads=new Map();this.projects=new Map();this.ttlMs=ttlMs;this.now=now;}
 async project(batchId,profileId,create,read=async()=>null,save=async()=>{}){
  const key=JSON.stringify([batchId,profileId]);
  if(!this.projects.has(key)){
   const task=(async()=>{const existing=await read(key);if(existing)return existing;const id=await create();if(!id)throw Error('Flow không trả project ID.');await save(key,id);return id;})();
   this.projects.set(key,task);task.catch(()=>{if(this.projects.get(key)===task)this.projects.delete(key)});
  }
  return this.projects.get(key);
 }
 async upload(profileId,projectId,file,upload){
  if(!profileId||!projectId)throw Error('Thiếu profile/project cho ảnh tham chiếu.');
  const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
  const key=JSON.stringify([profileId,projectId,hash.digest('hex')]);
  for(const [k,v] of this.uploads)if(v.expires<=this.now())this.uploads.delete(k);
  let entry=this.uploads.get(key);
  if(!entry){
   entry={expires:Infinity,promise:null};
   entry.promise=Promise.resolve().then(()=>upload(file,projectId)).then(id=>{if(!id)throw Error('Flow không trả media ID.');entry.expires=this.now()+this.ttlMs;return id;}).catch(error=>{if(this.uploads.get(key)===entry)this.uploads.delete(key);throw error});
   this.uploads.set(key,entry);
  }
  return entry.promise;
 }
 clearProject(profileId,projectId){for(const key of this.uploads.keys()){const [p,id]=JSON.parse(key);if(p===profileId&&id===projectId)this.uploads.delete(key)}}
}
export const batchMediaCache=new BatchMediaCache();
export function sharedBatchProject(batchId,profileId,create){
 const settingKey=k=>'workflow_batch_project:'+k;
 return batchMediaCache.project(batchId,profileId,create,async k=>(await prisma.appSetting.findUnique({where:{key:settingKey(k)}}))?.value,
 async(k,value)=>{const key=settingKey(k);await prisma.appSetting.upsert({where:{key},create:{key,value},update:{value}})});
}
