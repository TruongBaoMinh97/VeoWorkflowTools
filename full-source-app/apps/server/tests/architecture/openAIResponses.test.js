import {afterEach,describe,it,expect,vi} from 'vitest';
import {OpenAIResponsesClient,openAIResponsesClient} from '../../src/integrations/ai/OpenAIResponsesClient.js';
import {createDefaultNodeExecutorRegistry} from '../../src/modules/workflow/engine/NodeExecutorRegistry.js';
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status});
const ok={status:'completed',output:[{type:'reasoning',summary:[]},{type:'message',content:[{type:'output_text',text:'Catalog prompt'}]}]};
afterEach(()=>vi.restoreAllMocks());
describe('ChatGPT API',()=>{
 it('sends text and vision via Responses without persisting a conversation or leaking the key into body',async()=>{
  const fetchImpl=vi.fn().mockResolvedValue(reply(ok));
  const client=new OpenAIResponsesClient({fetchImpl,getApiKey:async()=>'test-secret'});
  expect(await client.complete({model:'selected-model',maxTokens:1234,messages:[{role:'system',content:'Master'},{role:'user',content:[{type:'text',text:'Describe'},{type:'image_url',image_url:{url:'data:image/png;base64,AAA'}}]}]})).toBe('Catalog prompt');
  const [url,options]=fetchImpl.mock.calls[0];const body=JSON.parse(options.body);
  expect(url).toBe('https://api.openai.com/v1/responses');expect(options.headers.Authorization).toBe('Bearer test-secret');
  expect(body).toMatchObject({model:'selected-model',instructions:'Master',max_output_tokens:1234,store:false});
  expect(body.input[0].content[1]).toEqual({type:'input_image',image_url:'data:image/png;base64,AAA',detail:'auto'});
  expect(options.body).not.toContain('test-secret');
 });
 it('does not call the API when key is missing',async()=>{
  const fetchImpl=vi.fn();const client=new OpenAIResponsesClient({fetchImpl,getApiKey:async()=>null});
  await expect(client.complete({})).rejects.toMatchObject({code:'OPENAI_KEY_MISSING',retryable:false});expect(fetchImpl).not.toHaveBeenCalled();
 });
 it.each([[401,{},false],[429,{code:'insufficient_quota'},false],[429,{},true],[503,{},true]])('classifies HTTP %s safely',async(status,error,retryable)=>{
  const client=new OpenAIResponsesClient({getApiKey:async()=>'secret',fetchImpl:async()=>reply({error:{message:'secret',...error}},status)});
  await expect(client.complete({model:'m',messages:[]})).rejects.toMatchObject({retryable,message:expect.not.stringContaining('secret')});
 });
 it.each([{status:'incomplete',output:ok.output},{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]},{status:'completed',output:[]}])('blocks incomplete/refused/empty output',async(body)=>{
  const client=new OpenAIResponsesClient({getApiKey:async()=>'secret',fetchImpl:async()=>reply(body)});
  await expect(client.complete({model:'m',messages:[]})).rejects.toMatchObject({retryable:false});
 });
 it('registers a node that emits downstream text and requires an explicit model',async()=>{
  const complete=vi.spyOn(openAIResponsesClient,'complete').mockResolvedValue('Result from OpenAI');
  const registry=createDefaultNodeExecutorRegistry();
  await expect(registry.execute('chatgpt',{data:{},resolved:{promptTexts:['Hello']}})).rejects.toMatchObject({code:'OPENAI_MODEL_REQUIRED'});
  expect(complete).not.toHaveBeenCalled();
  const result=await registry.execute('chatgpt',{data:{model:'selected-model',prompt:'Write prompt'},resolved:{promptTexts:['Product']},isCancelled:()=>false});
  expect(result.textValues).toEqual(['Result from OpenAI']);expect(complete).toHaveBeenCalledTimes(1);
 });
});
