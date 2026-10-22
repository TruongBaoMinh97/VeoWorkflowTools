import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createCapcutProject, patchCapcutProject, collectLatestSceneJobs, defaultCapcutRoot, imageBatches, resolveCapcutBatchIndex } from './lib/capcutStory.js';
import { configureInlineStory, readInlineStoryResult } from './lib/inlineStoryPrompts.js';
import { genNormalService } from '../genNormal/genNormal.service.js';
import { genNormalRepository } from '../genNormal/genNormal.repository.js';
import { createStoryGenTransfer } from './lib/storyGenNormal.js';
import { workflowRepository } from './workflow.repository.js';
import { workflowBatchRepository } from './workflow.batch.repository.js';
import { workflowBatchOrchestrator } from './workflow.batch.orchestrator.js';
import { createAudioRuns } from './lib/audioRuns.js';
import {createStoryDataRuns} from './lib/storyDataExport.js';
import {MultiStoryQueue,scanStorySets} from './lib/multiStory.js';
import {saveMultiStoryImages} from './lib/multiStoryImages.js';
import {prisma} from '../../lib/prisma.js';
import {z} from 'zod';

export const audioRuns=createAudioRuns({
    profiles:ids=>workflowBatchRepository.validateProfileIds(ids),
    createBatch:body=>workflowBatchRepository.createBatch(body),
    startBatch:id=>workflowBatchOrchestrator.startBatch(id),
    cancelBatch:id=>workflowBatchOrchestrator.cancelBatch(id),
    getBatch:id=>workflowBatchRepository.getBatchWithItems(id),
});
export const storyDataRuns=createStoryDataRuns();
const transferToGen=createStoryGenTransfer({service:genNormalService,repository:genNormalRepository,profiles:ids=>workflowBatchRepository.validateProfileIds(ids)});
const multiPrefix='story_multi_queue:';
export const multiStoryQueue=new MultiStoryQueue({
    audio:audioRuns,transfer:transferToGen,service:genNormalService,repository:genNormalRepository,
    download:(project,progress)=>saveMultiStoryImages(project,{progress,track:(id,data)=>prisma.genNormalJob.update({where:{id},data}),refresh:id=>genNormalService.refreshJobResultUrl(id)}),
    workflow:id=>workflowRepository.getWorkflow(id),profiles:ids=>workflowBatchRepository.validateProfileIds(ids),
    store:{
        get:async id=>{const row=await prisma.appSetting.findUnique({where:{key:multiPrefix+id}});return row?JSON.parse(row.value):null;},
        list:async()=>{const rows=await prisma.appSetting.findMany({where:{key:{startsWith:multiPrefix}},orderBy:{updatedAt:'desc'},take:50});return rows.map(r=>JSON.parse(r.value));},
        put:async q=>{const key=multiPrefix+q.id,value=JSON.stringify(q);await prisma.appSetting.upsert({where:{key},create:{key,value},update:{value}});},
    },
});
const multiBody=z.object({
    name:z.string().trim().min(1).max(150).optional(),workflowId:z.string().min(1),profileIds:z.array(z.string().min(1)).min(1).max(50),
    fields:z.object({outputDir:z.string().min(1),referencePath:z.string().min(1),style:z.string().trim().min(1),characterDescription:z.string().trim().min(1)}),
    imageModelKey:z.enum(['GEM_PIX_2','BELUGA','HARBOR_SEAL','NARWHAL']),concurrency:z.number().int().min(1).max(12),batchSize:z.number().int().min(1).max(4),delaySeconds:z.number().int().min(1).max(180),
    items:z.array(z.object({name:z.string().trim().min(1).max(200),txtPath:z.string().min(1),srtPath:z.string().min(1),audioPath:z.string().min(1)})).min(1).max(100),
});
const capcutTasks = new Map();
export async function registerAudioRoutes(app){
    const handle=fn=>async(req,reply)=>{try{return {success:true,data:await fn(req)}}catch(error){return reply.code(400).send({success:false,error:error.message})}};
    app.post('/api/workflow/story-data/start',handle(req=>storyDataRuns.start(z.object({
        txtPath:z.string().min(1),audioPath:z.string().min(1),srtPath:z.string().min(1),outputDir:z.string().min(1),
        visualMinDurationMs:z.coerce.number().int().min(1000).max(6000).default(2500),
        visualMaxDurationMs:z.coerce.number().int().min(4000).max(20000).default(9000),
        visualMaxUtterances:z.coerce.number().int().min(1).max(5).default(3),
    }).refine(value=>value.visualMaxDurationMs>=value.visualMinDurationMs,{message:'Thời lượng cảnh hình tối đa phải lớn hơn hoặc bằng mức tối thiểu.'}).parse(req.body))));
    app.get('/api/workflow/story-data/:runId',handle(req=>storyDataRuns.get(req.params.runId,req.query.root)));
    app.post('/api/workflow/story-data/:runId/cancel',handle(req=>storyDataRuns.cancel(req.params.runId,req.body?.root)));
    app.post('/api/workflow/multi-story/scan',handle(req=>{const b=z.object({root:z.string().min(1)}).parse(req.body);return scanStorySets(b.root,'folders');}));
    app.get('/api/workflow/multi-story',handle(()=>multiStoryQueue.list()));
    app.post('/api/workflow/multi-story',handle(req=>multiStoryQueue.create(multiBody.parse(req.body))));
    app.get('/api/workflow/multi-story/:id',handle(req=>multiStoryQueue.get(req.params.id)));
    app.post('/api/workflow/multi-story/:id/pause',handle(req=>multiStoryQueue.pause(req.params.id)));
    app.post('/api/workflow/multi-story/:id/resume',handle(req=>multiStoryQueue.resume(req.params.id)));
    app.get('/api/workflow/capcut/context/:projectId',handle(async req=>{
        const project=await genNormalRepository.getProject(req.params.projectId);
        if(!project)throw Error('Project không tồn tại.');
        let audioFolder='';
        if(project.outputDir){try{const transfer=JSON.parse(await readFile(path.join(project.outputDir,'gen-normal-transfer.json'),'utf8'));if(transfer.projectId===project.id)audioFolder=project.outputDir;}catch{}}
        const mergedJobs=collectLatestSceneJobs(project);
        return {audioFolder,draftsRoot:defaultCapcutRoot(),mergedSceneCount:mergedJobs.size,batches:imageBatches(project).map(b=>({batchIndex:b.batchIndex,count:b.jobs.length,completed:b.jobs.filter(j=>j.status==='COMPLETED'&&j.resultUrl).length}))};
    }));
    app.post('/api/workflow/capcut/start',handle(async req=>{
        const project=await genNormalRepository.getProject(req.body?.projectId);
        if(!project)throw Error('Project không tồn tại.');
        const batchIndex=resolveCapcutBatchIndex(project,req.body?.batchIndex);
        const running=[...capcutTasks.values()].find(t=>t.status==='RUNNING');
        if(running)throw Error('Đang tạo một project CapCut. Vui lòng chờ hoàn tất.');
        for(const [id,t]of capcutTasks)if(Date.now()-t.createdAt>86400000)capcutTasks.delete(id);
        const task={id:randomUUID(),projectId:project.id,status:'RUNNING',message:'Đang kiểm tra ảnh và audio…',progress:0,createdAt:Date.now()};
        capcutTasks.set(task.id,task);
        createCapcutProject({...req.body,batchIndex,project},{progress:(message,progress)=>Object.assign(task,{message,progress})})
            .then(result=>Object.assign(task,{status:'COMPLETED',result,progress:1}))
            .catch(error=>Object.assign(task,{status:'FAILED',error:error.message}));
        return task;
    }));
    app.post('/api/workflow/capcut/patch',handle(async req=>{
        const project=await genNormalRepository.getProject(req.body?.projectId);
        if(!project)throw Error('Project không tồn tại.');
        const running=[...capcutTasks.values()].find(t=>t.status==='RUNNING');
        if(running)throw Error('Đang đồng bộ một project CapCut. Vui lòng chờ hoàn tất.');
        for(const [id,t]of capcutTasks)if(Date.now()-t.createdAt>86400000)capcutTasks.delete(id);
        const task={id:randomUUID(),projectId:project.id,status:'RUNNING',message:'Đang kiểm tra project CapCut cần cập nhật…',progress:0,createdAt:Date.now()};
        capcutTasks.set(task.id,task);
        patchCapcutProject({...req.body,project},{progress:(message,progress)=>Object.assign(task,{message,progress})})
            .then(result=>Object.assign(task,{status:'COMPLETED',result,progress:1}))
            .catch(error=>Object.assign(task,{status:'FAILED',error:error.message}));
        return task;
    }));
    app.get('/api/workflow/capcut/tasks/:id',handle(req=>{
        const task=capcutTasks.get(req.params.id);if(!task)throw Error('Lượt đồng bộ không còn hoạt động. Kiểm tra thư mục project trước khi thử lại.');return task;
    }));
    app.post('/api/workflow/inline-story/start' ,handle(async req=>{
        const project=await genNormalRepository.getProject(req.body?.projectId);
        const def=await workflowRepository.getWorkflow(req.body?.workflowId);
        if(!project||!def)throw Error('Không tìm thấy project hoặc mẫu Story.');
        return audioRuns.start(configureInlineStory(def,project,req.body.fields||{}),{promptsOnly:true});
    }));
    app.post('/api/workflow/inline-story/result',handle(async req=>{
        const project=await genNormalRepository.getProject(req.body?.projectId);
        if(!project)throw Error('Project không tồn tại.');
        const result=await readInlineStoryResult(req.body?.root,req.body?.runId);
        const images=[];
        for(const image of result.references){
            const mediaIds={};
            for(const profile of project.profiles){
                const uploaded=await genNormalService.uploadImageAndGetMediaId(image.path,profile.profileId,project.aspectRatio||'16:9',project.id);
                if(!uploaded.mediaId)throw Error('Không upload được ảnh tham chiếu.');
                mediaIds[profile.profileId]=uploaded.mediaId;
            }
            images.push({name:image.key,preview:'file://'+image.path,mediaIds});
        }
        return {prompts:result.prompts,images,audioRoot:req.body.root};
    }));
    app.post('/api/workflow/:id/audio-runs',handle(async req=>{
        const def=await workflowRepository.getWorkflow(req.params.id);
        if(!def)throw Error('Workflow không tồn tại.');
        return audioRuns.start(def);
    }));
    app.post('/api/workflow/audio-runs/:runId/gen-normal',handle(req=>transferToGen(req.body?.root,req.params.runId,req.body?.profileIds)));
    app.get('/api/workflow/audio-runs/:runId',handle(req=>audioRuns.get(req.params.runId,req.query.root)));
    app.post('/api/workflow/audio-runs/:runId/cancel',handle(req=>audioRuns.cancel(req.params.runId,req.query.root)));
}
