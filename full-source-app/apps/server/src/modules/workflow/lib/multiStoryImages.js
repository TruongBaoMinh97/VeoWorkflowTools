import path from 'node:path';
import {mkdir,readFile,writeFile,rename,stat,copyFile,open} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {downloadFile} from '../../../utils/fileDownloader.js';

// Download on the backend: the Gen detail screen need not stay open.
export async function saveMultiStoryImages(project,{download=downloadFile,track=async()=>{},refresh=async()=>null,progress=async()=>{}}={}){
 if(!path.isAbsolute(project.outputDir||''))throw Error('Dự án thiếu thư mục kết quả.');
 const root=path.join(project.outputDir,'images');await mkdir(root,{recursive:true});
 const manifestPath=path.join(root,'image-downloads.json');let manifest={};
 try{manifest=JSON.parse(await readFile(manifestPath,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error;}
 const failed=[];let saved=0;
 const persist=async()=>{const temp=manifestPath+'.tmp';await writeFile(temp,JSON.stringify(manifest,null,2));await rename(temp,manifestPath);};
 for(const job of project.jobs.filter(j=>j.status==='COMPLETED')){
  let url=job.resultUrl;
  try{
   if(!url)throw Error('Thiếu kết quả ảnh.');
   const cached=manifest[job.id];
   const existing=cached?.file&&path.basename(cached.file)===cached.file?path.join(root,cached.file):null;
   if(cached?.source===url&&existing&&(await stat(existing).catch(()=>null))?.size>0){saved++;await progress(saved,failed.length);continue;}
   const digest=createHash('sha256').update(job.id+'\n'+url).digest('hex').slice(0,12);
   const stem='SC'+String(job.jobIndex+1).padStart(3,'0')+'_'+digest;
   const temp=path.join(root,stem+'_'+randomUUID()+'.part');
   const fetchToDisk=async source=>{if(source.startsWith('file://'))await copyFile(fileURLToPath(source),temp);else if(path.isAbsolute(source))await copyFile(source,temp);else await download(source,temp);};
   try{await fetchToDisk(url)}catch(error){const next=await refresh(job.id);if(!next?.freshUrl)throw error;url=next.freshUrl;await fetchToDisk(url);}
   const handle=await open(temp,'r');const header=Buffer.alloc(12);try{await handle.read(header,0,12,0)}finally{await handle.close()}
   const ext=header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'.png':header[0]===255&&header[1]===216?'.jpg':header.toString('ascii',0,4)==='RIFF'&&header.toString('ascii',8,12)==='WEBP'?'.webp':null;
   if(!ext)throw Error('Tệp tải về không phải PNG/JPEG/WebP.');
   const filename=stem+ext;await rename(temp,path.join(root,filename));
   manifest[job.id]={file:filename,source:url,jobIndex:job.jobIndex};await persist();
   await track(job.id,{downloadedAt:new Date(),lastDownloadError:null});saved++;
  }catch(error){failed.push({jobId:job.id,scene:job.jobIndex+1,error:error.message});await track(job.id,{lastDownloadError:error.message.slice(0,300),downloadAttempts:{increment:1}}).catch(()=>{});}
  await progress(saved,failed.length);
 }
 return {saved,failed,root};
}
