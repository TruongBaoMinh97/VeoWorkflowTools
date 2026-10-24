import {describe,it,expect,vi} from 'vitest';
import {PromptRewriteService,parseRewrites,packPrompts,isPolicyFailure} from '../../src/modules/genNormal/promptRewrite.service.js';
import {OpenAIResponsesClient} from '../../src/integrations/ai/OpenAIResponsesClient.js';
const jobs=()=>Array.from({length:8},(_,i)=>({id:'j'+i,jobIndex:i,prompt:'Character and style\nScene '+i,status:'FAILED',error:'vi phạm chính sách'}));
const finish=async t=>{for(let i=0;i<30&&t.status==='RUNNING';i++)await new Promise(r=>setTimeout(r,1));};
function fixture(complete){
 const state=jobs(),logs=[];
 const db={genNormalJob:{findMany:vi.fn(async()=>state.map(j=>({...j}))),updateMany:vi.fn(async({where,data})=>{const j=state.find(j=>j.id===where.id&&j.prompt===where.prompt&&j.status===where.status);if(!j)return {count:0};Object.assign(j,data);return {count:1}})},activityLog:{create:vi.fn(async r=>logs.push(r))}};
 db.$transaction=async fn=>{const before=structuredClone(state);try{return await fn(db)}catch(e){state.splice(0,state.length,...before);throw e}};
 const client={complete:vi.fn(complete|| (async input=>JSON.stringify({prompts:JSON.parse(input.messages[1].content).prompts.reverse().map(j=>({id:j.id,prompt:'Safe '+j.id}))})))};
 const settings={getValue:vi.fn(async k=>k==='openai_api_key'?'test-key':'chosen-model')};
 return {state,logs,db,client,settings,service:new PromptRewriteService({db,settings,client})};
}
describe('policy prompt rewrite',()=>{
 it('batches 8 into 5+3 and maps reversed output by ID without changing jobs before apply',async()=>{
  const f=fixture(),t=await f.service.start('p');await finish(t);
  expect(t.status).toBe('READY');expect(f.client.complete.mock.calls.map(([x])=>JSON.parse(x.messages[1].content).prompts.length)).toEqual([5,3]);
  expect(f.client.complete.mock.calls[0][0].textFormat.strict).toBe(true);
  expect(t.results.map(r=>r.prompt)).toEqual(jobs().map(j=>'Safe '+j.id));expect(f.db.genNormalJob.updateMany).not.toHaveBeenCalled();
  expect(await f.service.start('p')).toBe(t);expect(f.client.complete).toHaveBeenCalledTimes(2);
  await f.service.apply('p',t.id,t.results);expect(f.state.every(j=>j.status==='FAILED'&&j.error.startsWith('PROMPT_REWRITTEN:'))).toBe(true);
  expect(f.logs[0].data.data.prompts[0].original).toBe(jobs()[0].prompt);
  await expect(f.service.apply('p',t.id,t.results)).rejects.toMatchObject({statusCode:409});
 });
 it('does not overwrite a concurrently edited job and rolls back the group',async()=>{
  const f=fixture(),t=await f.service.start('p');await finish(t);f.state[3].prompt='manual edit';
  await expect(f.service.apply('p',t.id,t.results)).rejects.toMatchObject({statusCode:409});
  expect(f.state[0].prompt).toBe(jobs()[0].prompt);expect(f.state[3].prompt).toBe('manual edit');expect(t.status).toBe('READY');
 });
 it('keeps successful groups on a later failure, without automatic extra paid requests',async()=>{
  const f=fixture();f.client.complete.mockImplementationOnce(async x=>JSON.stringify({prompts:JSON.parse(x.messages[1].content).prompts.map(j=>({id:j.id,prompt:'safe'}))})).mockRejectedValueOnce(Error('private upstream detail'));
  const t=await f.service.start('p');await finish(t);expect(t.status).toBe('PARTIAL');expect(t.results).toHaveLength(5);expect(t.error).not.toContain('private');expect(f.client.complete).toHaveBeenCalledTimes(2);
 });
 it('rejects missing/duplicate/unknown IDs, malformed JSON and empty text',()=>{
  const j=jobs().slice(0,2);
  for(const text of ['bad','{}',JSON.stringify({prompts:[{id:'j0',prompt:'a'},{id:'j0',prompt:'b'}]}),JSON.stringify({prompts:[{id:'other',prompt:'a'},{id:'j1',prompt:'b'}]}),JSON.stringify({prompts:[{id:'j0',prompt:''},{id:'j1',prompt:'b'}]})])expect(()=>parseRewrites(text,j)).toThrow();
 });
 it('filters unrelated errors, blocks missing configuration, and scopes task access',async()=>{
  expect(isPolicyFailure({status:'FAILED',error:'HTTP 400 timeout'})).toBe(false);expect(isPolicyFailure({status:'COMPLETED',error:'policy'})).toBe(false);
  const f=fixture();f.settings.getValue.mockResolvedValue(null);await expect(f.service.start('p')).rejects.toThrow('API key');expect(f.client.complete).not.toHaveBeenCalled();
  expect(()=>f.service.get('other','unknown')).toThrow();
 });
 it('deduplicates shared prefix without losing original input',()=>{
  const j=jobs(),p=packPrompts(j);expect(p.sharedPrefix).toBe('Character and style\n');expect(p.prompts.map(x=>p.sharedPrefix+x.prompt)).toEqual(j.map(x=>x.prompt));
 });
 it('sends schema to Responses API, with no key in body',async()=>{
  const fetchImpl=vi.fn(async()=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{}'}]}]})));
  await new OpenAIResponsesClient({fetchImpl,getApiKey:async()=>'private-key'}).complete({model:'m',messages:[],textFormat:{type:'json_schema',name:'test',strict:true,schema:{type:'object'}}});
  const body=JSON.parse(fetchImpl.mock.calls[0][1].body);expect(body.text.format.name).toBe('test');expect(body.store).toBe(false);expect(JSON.stringify(body)).not.toContain('private-key');
 });
});
