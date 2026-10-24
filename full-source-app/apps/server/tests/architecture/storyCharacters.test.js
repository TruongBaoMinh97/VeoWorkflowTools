import { it, expect, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import Fastify from 'fastify';
import { prepareCharacterDefinition, characterRunSummary } from '../../src/modules/workflow/lib/storyCharacters.js';
import { compileScene } from '../../src/modules/workflow/lib/storyScenes.js';
const mocks=vi.hoisted(()=>({runs:[],start:vi.fn()}));
vi.mock('../../src/modules/workflow/workflow.repository.js',()=>({workflowRepository:{listRunsByWorkflow:async()=>mocks.runs}}));
vi.mock('../../src/modules/workflow/workflow.service.js',()=>({workflowService:{startCharacters:mocks.start}}));
import { registerStoryCharacterRoutes } from '../../src/modules/workflow/storyCharacters.routes.js';
const fixture=JSON.parse(await readFile(new URL('../../../../../docs/workflows/STORY-IMAGES-V1.json',import.meta.url),'utf8'));
let app;
afterEach(async()=>{await app?.close();mocks.runs=[];mocks.start.mockReset()});
function setup(){const def=structuredClone(fixture);def.id='story';def.nodes[0].data.outputDir=os.tmpdir();return def}
it('builds only a sequential character preparation graph and freezes prompt/style',()=>{
 const def=setup();def.nodes[1].data.characterPrompts={CHAR_AN_DEFAULT:'My approved description'};
 const p=prepareCharacterDefinition(def,'refs',['CHAR_AN_DEFAULT','CHAR_BAO_DEFAULT']);
 expect(p.definition.nodes.map(n=>n.type)).toEqual(['character-generator','character-generator']);
 expect(p.definition.edges).toHaveLength(1);expect(p.definition.nodes[0].data.entries[0].prompt).toBe('My approved description');
 expect(p.definition.nodes[0].data.stylePrompt).toBe(def.nodes[0].data.document.style.style_prompt_en);
 expect(def.nodes.some(n=>n.type==='story-input')).toBe(true);
 expect(()=>prepareCharacterDefinition(def,'refs',['UNKNOWN'])).toThrow();
 expect(()=>prepareCharacterDefinition(def,'refs',['CHAR_AN_DEFAULT','CHAR_AN_DEFAULT'])).toThrow();
});
it('retains successful candidates in failed or cancelled runs without approving them',()=>{
 const run={id:'run',status:'FAILED',inputOverrides:{__storyCharacters:{referenceNodeId:'refs',entries:[{reference_key:'A',prompt:'a'},{reference_key:'B',prompt:'b'}]}},nodeStates:{character_0:{status:'done',results:[{savedPath:'D:/a.png',url:'file://D:/a.png'}]},character_1:{status:'error',error:'quota'}}};
 const summary=characterRunSummary(JSON.parse(JSON.stringify(run)));
 expect(summary.entries[0].results[0].path).toBe('D:/a.png');expect(summary.entries[1].error).toBe('quota');expect(summary.library).toBeUndefined();
});
it('rejects pending generated references before scene generation',()=>{
 const doc=setup().nodes[0].data.document;
 expect(()=>compileScene(doc,doc.scenes[0],{CHAR_AN_DEFAULT:{path:'D:/a.png',generated:true,reviewStatus:'pending'}})).toThrow(/chưa được duyệt/);
});
it('starts preparation and lists persistent candidates; blocks duplicate active starts',async()=>{
 app=Fastify();await registerStoryCharacterRoutes(app);await app.ready();mocks.start.mockResolvedValue({id:'run'});
 let r=await app.inject({method:'POST',url:'/api/workflow/story/characters',payload:{referenceNodeId:'refs',profileId:'profile',keys:['A']}});
 expect(r.statusCode).toBe(200);expect(mocks.start).toHaveBeenCalledWith({workflowId:'story',referenceNodeId:'refs',profileId:'profile',keys:['A']});
 mocks.runs=[{id:'run',status:'RUNNING',inputOverrides:{__storyCharacters:{referenceNodeId:'refs',entries:[{reference_key:'A',prompt:'a'}]}},nodeStates:{}}];
 r=await app.inject({method:'POST',url:'/api/workflow/story/characters',payload:{referenceNodeId:'refs',profileId:'profile',keys:['A']}});expect(r.statusCode).toBe(400);expect(mocks.start).toHaveBeenCalledTimes(1);
 r=await app.inject({method:'GET',url:'/api/workflow/story/characters'});expect(r.json().data[0].entries[0].status).toBe('pending');
});
