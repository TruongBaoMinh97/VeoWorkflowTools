import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
vi.mock('../../src/modules/workflow/workflow.service.js', () => ({ workflowService: { startRun: vi.fn() } }));
vi.mock('../../src/modules/workflow/workflow.repository.js', () => ({ workflowRepository: { getRun: vi.fn() } }));
vi.mock('../../src/modules/workflow/workflow.batch.repository.js', () => ({ workflowBatchRepository: { completeItem: vi.fn(), setItemRun: vi.fn(), failItem: vi.fn(), claimNextItem: vi.fn(), getBatchWithItems: vi.fn(), resetItemForRetry: vi.fn() } }));
import { workflowBatchOrchestrator as runner } from '../../src/modules/workflow/workflow.batch.orchestrator.js';
import { workflowRepository } from '../../src/modules/workflow/workflow.repository.js';
import { workflowService } from '../../src/modules/workflow/workflow.service.js';
import { workflowBatchRepository } from '../../src/modules/workflow/workflow.batch.repository.js';
import * as storySaver from '../../src/modules/workflow/lib/storyResults.js';
import * as mediaSaver from '../../src/modules/workflow/lib/saveMedia.js';
import path from 'node:path';
const def = { nodes: [], edges: [] };
const fingerprint = createHash('sha256').update(JSON.stringify(def)).digest('hex');
const schema = { inputs: [{nodeId:'p',batchKey:'brief',batchInputType:'text'}], outputs: [] };
const item = { id:'item',runId:'old',inputValues:{brief:'original'} };
const old = { id:'old',profileId:'profile',status:'COMPLETED',nodeStates:{},inputOverrides:{p:{prompt:'original'},__batchTemplate:{fingerprint}} };
afterEach(() => {vi.restoreAllMocks();vi.clearAllMocks();});
describe('batch resume',()=>{
 it('saves from the compiled output context, not the unprepared audio input',async()=>{
  const save=vi.spyOn(storySaver,'saveStoryResults').mockResolvedValue([{savedPath:'SC001.png'}]);
  const story={sceneId:'SC001',root:'D:/story',prompt:'compiled'};
  await runner.downloadOutputs({}, {}, {outputs:[{nodeId:'result'}]}, {id:'run',nodeStates:{audio:{story:{sceneId:'SC001',snapshotPath:'D:/story/story-manifest.json'}},result:{story,results:[{url:'image.png'}]}}}, {});
  expect(save).toHaveBeenCalledWith(story,[{url:'image.png'}],'run');
 });
    it('passes the product source folder as output group rather than the color row',async()=>{
        const save=vi.spyOn(mediaSaver,'saveMediaBundle').mockResolvedValue([{savedPath:'saved.png'}]);
        const source=path.resolve('products','dress-a','red.png');
        await runner.downloadOutputs({id:'batch',outputDir:'output'}, {nodes:[{id:'folder',type:'folder-input',data:{groupMode:'product-images'}}]},
            {inputs:[{nodeId:'folder',folderInput:true,batchInputType:'image',batchKey:'product'}],outputs:[{nodeId:'result'}]},
            {id:'run',nodeStates:{result:{results:[{url:'image.png'}]}}}, {rowIndex:0,inputValues:{product:source}});
        expect(save).toHaveBeenCalledWith(expect.objectContaining({batchId:'batch',productGroup:{name:'dress-a',key:path.dirname(source)}}));
    });
    it('marks refused content for review and continues the next product in the same lane',async()=>{
        workflowRepository.getRun.mockResolvedValue(null);
        workflowBatchRepository.claimNextItem.mockResolvedValueOnce({...item,id:'refused',runId:null}).mockResolvedValueOnce({...item,id:'good',runId:null}).mockResolvedValueOnce(null);
        workflowService.startRun.mockResolvedValue({id:'new'});
        vi.spyOn(runner,'waitForRun').mockResolvedValueOnce({status:'FAILED',error:'PUBLIC_ERROR_SEXUAL',nodeStates:{}}).mockResolvedValueOnce({status:'COMPLETED',nodeStates:{}});
        await runner.runProfileLane({id:'batch',autoDownload:false},def,schema,'profile',{cancelled:false,runIds:new Set()});
        expect(workflowBatchRepository.failItem).toHaveBeenCalledWith('refused','ERROR',expect.stringContaining('[CONTENT_REVIEW_REQUIRED]'),0);
        expect(workflowBatchRepository.completeItem).toHaveBeenCalledWith('good',[],0);
    });
    it('does not reset a content-rejected row without explicit review confirmation',async()=>{
        workflowBatchRepository.getBatchWithItems.mockResolvedValue({items:[{rowIndex:0,id:'refused',status:'ERROR',error:'PUBLIC_ERROR_SEXUAL'}]});
        await expect(runner.retryItem('batch',0)).rejects.toThrow(/xác nhận/);
        expect(workflowBatchRepository.resetItemForRetry).not.toHaveBeenCalled();
    });
    it('retries saving without generating again when only download failed',async()=>{
        workflowRepository.getRun.mockResolvedValue(old);
        const save = vi.spyOn(runner,'downloadOutputs').mockResolvedValue(['saved.png']);
        await runner.processItem({autoDownload:true},def,schema,item,'profile',{cancelled:false,runIds:new Set()});
        expect(save).toHaveBeenCalled();expect(workflowService.startRun).not.toHaveBeenCalled();
        expect(workflowBatchRepository.completeItem).toHaveBeenCalledWith('item',['saved.png'],0);
    });
    it('seeds completed nodes when retrying a failed run with unchanged inputs',async()=>{
        workflowRepository.getRun.mockResolvedValue({...old,status:'FAILED'});
        workflowService.startRun.mockResolvedValue({id:'new'});
        vi.spyOn(runner,'waitForRun').mockResolvedValue({status:'COMPLETED',nodeStates:{}});
        await runner.processItem({autoDownload:false},def,schema,item,'profile',{cancelled:false,runIds:new Set()});
        expect(workflowService.startRun).toHaveBeenCalledWith(expect.objectContaining({sourceRunId:'old',resumeCompleted:true}));
    });
    it('does not reuse cached prompts after inputs changed',async()=>{
        workflowRepository.getRun.mockResolvedValue(old);
        workflowService.startRun.mockResolvedValue({id:'new'});
        vi.spyOn(runner,'waitForRun').mockResolvedValue({status:'COMPLETED',nodeStates:{}});
        await runner.processItem({autoDownload:false},def,schema,{...item,inputValues:{brief:'changed'}},'profile',{cancelled:false,runIds:new Set()});
        expect(workflowService.startRun.mock.calls[0][0].resumeCompleted).toBeUndefined();
    });
});
