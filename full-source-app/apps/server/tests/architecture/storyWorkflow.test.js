import { describe, it, expect, afterEach } from 'vitest';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileScene, parseStory, previewStory, snapshotStory, detectGhostCharacterWarnings } from '../../src/modules/workflow/lib/storyScenes.js';
import { parsePromptPatch, mergePromptPatch } from '../../src/modules/workflow/lib/promptStory.js';
import { saveStoryResults, listStoryResults, selectStoryResult } from '../../src/modules/workflow/lib/storyResults.js';
import { createDefaultNodeExecutorRegistry } from '../../src/modules/workflow/engine/NodeExecutorRegistry.js';
import { resolveInputs } from '../../src/modules/workflow/workflow.engine.js';
import { extractBatchSchema } from '../../src/modules/workflow/workflow.batch.schema.js';
const fixture = JSON.parse(await readFile(new URL('../../../../../docs/story-workflow-test/03-STORY-PROMPTS-TEST.json', import.meta.url), 'utf8'));
const workflow = JSON.parse(await readFile(new URL('../../../../../docs/workflows/STORY-IMAGES-V1.json', import.meta.url), 'utf8'));
const temp=[];
afterEach(async()=>{for(const dir of temp.splice(0))await rm(dir,{recursive:true,force:true})});
async function setup(){const root=await mkdtemp(path.join(os.tmpdir(),'story-test-'));temp.push(root);const image=path.join(root,'test.png');await writeFile(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9S8AAAAASUVORK5CYII=','base64'));const library=Object.fromEntries(fixture.characters.map(c=>[c.reference_key,{path:image}]));return {root,image,library};}
describe('Story workflow',()=>{
 it('covers all SRT cues and excludes mentioned-only characters',()=>{const doc=parseStory(fixture);expect(doc.scenes).toHaveLength(15);expect(doc.scenes[2].visible_character_ids).not.toContain('ONG_LAM');for(const i of [4,9,12])expect(compileScene(doc,doc.scenes[i],{}).images).toEqual([]);expect(doc.scenes[13].visible_character_ids).toHaveLength(4)});
 it('selects only visible characters, fixed order, style last and substitutes tags',async()=>{const {library,image}=await setup();library.STYLE_STORY_STYLE_01={path:image};const result=compileScene(fixture,fixture.scenes[6],library);expect(result.images.map(i=>i.key)).toEqual(['CHAR_AN_DEFAULT','CHAR_BAO_DEFAULT','CHAR_MIU_DEFAULT','STYLE_STORY_STYLE_01']);expect(result.prompt).not.toMatch(/@AN|@BAO|@MIU/);expect(result.ready).toBe(true)});
 it('rejects unknown, duplicate, mismatched and unsafe input',()=>{for(const patch of [{scene_id:'../escape'},{start_time:'bad'},{end_ms:1},{visible_character_ids:['AN','AN']},{prompt_en:'@UNKNOWN waits.'},{reference_bindings:[]}]){const doc=structuredClone(fixture);Object.assign(doc.scenes[0],patch);expect(()=>compileScene(doc,doc.scenes[0],{})).toThrow()}});
 it('marks missing references and enforces limits without dropping characters',async()=>{expect((await previewStory(fixture,{})).rows[0].ready).toBe(false);const {library}=await setup();expect(()=>compileScene(fixture,fixture.scenes[13],library,{maxReferences:2})).toThrow(/giới hạn/)});
 it('freezes images and prompts; gates full-story generation until verified',async()=>{const {root,image,library}=await setup();await expect(snapshotStory(fixture,library,{},root)).rejects.toThrow(/chạy thử/);const {snapshot}=await snapshotStory(fixture,library,{},root,['SC001']);const original=await readFile(snapshot.library.CHAR_AN_DEFAULT.path);await writeFile(image,'changed');expect(await readFile(snapshot.library.CHAR_AN_DEFAULT.path)).toEqual(original);expect(snapshot.document.scenes[0].scene_id).toBe('SC001')});
 it('passes structured context and does not upload unused or empty references',async()=>{const registry=createDefaultNodeExecutorRegistry();const {root,library}=await setup();const {snapshot}=await snapshotStory(fixture,library,{},root,['SC001','SC013']);const input=await registry.execute('story-input',{data:{storyPayload:{snapshot,sceneId:'SC001'}}});const resolved=resolveInputs('prepare',workflow.edges,workflow.nodes,{story:input,refs:{storyLibrary:library}});const prepared=await registry.execute('scene-prepare',{resolved});const uploads=[];await registry.execute('upload-image',{data:{},resolved:{imageResults:prepared.results,story:prepared.story},provider:{async uploadImageAndExtractMediaId(file,project){uploads.push([file,project]);return String(uploads.length)}},projectId:'project-A'});expect(uploads).toHaveLength(2);const empty=await registry.execute('scene-prepare',{resolved:{story:{snapshot,sceneId:'SC013'}}});const noImages=await registry.execute('upload-image',{data:{},resolved:{imageResults:[],story:empty.story}});expect(noImages.results).toEqual([]);expect(noImages.story.sceneId).toBe('SC013')});
 it('persists attempts and selected image independently, reloads after restart',async()=>{const {root,image}=await setup();await writeFile(path.join(root,'story-manifest.json'),JSON.stringify({document:fixture}));const story={root,sceneId:'SC001',scene:fixture.scenes[0],prompt:'test'};await saveStoryResults(story,[{url:`file://${image}`,kind:'image'}],'run-1');await saveStoryResults(story,[{url:`file://${image}`,kind:'image'}],'run-2');let rows=await listStoryResults(root);expect(rows[0].attempts).toHaveLength(2);await selectStoryResult(root,'SC001',rows[0].attempts[0].id,0);rows=await listStoryResults(root);expect(rows[0].selection.reviewStatus).toBe('selected');await expect(selectStoryResult(root,'../bad','bad',0)).rejects.toThrow()});
 it('exports all scenes into one images folder and preserves previous attempts on retry',async()=>{
  const {root,image}=await setup();const story={root,sceneId:'SC001',prompt:'test'};
  const first=await saveStoryResults(story,[{url:`file://${image}`,kind:'image'}],'run-1');
  expect(first[0].savedPath).toBe(path.join(root,'images','SC001.png'));
  const original=await readFile(first[0].savedPath);await writeFile(image,'new image');
  await saveStoryResults(story,[{url:`file://${image}`,kind:'image'}],'run-2');
  expect(await readFile(first[0].savedPath,'utf8')).toBe('new image');
  const {readdir}=await import('node:fs/promises');const attempts=await readdir(path.join(root,'scenes','SC001'));expect(attempts).toHaveLength(2);
  const bytes=await Promise.all(attempts.map(a=>readFile(path.join(root,'scenes','SC001',a,'01.png'))));expect(bytes.some(b=>b.equals(original))).toBe(true);
 });
 it('exposes story row input without changing existing image/text schema',()=>{const schema=extractBatchSchema(workflow);expect(schema.inputs).toHaveLength(1);expect(schema.inputs[0].storyInput).toBe(true);expect(schema.outputs).toHaveLength(1)});
 it('merges QA prompt patches (.txt with # comments and .json) while preserving original scene order',()=>{
  const existing = 'UT001_A | @HARUKO_HOME drinks tea.\nUT002_B | @HARUKO_HOME reads a book.\nUT003_C | @SUMIE_HOME walks outside.';
  const patchTxt = '# Header comment\n# Fix UT002_B character leak\nUT002_B | @HARUKO_HOME sits alone at the table.';
  const merged = mergePromptPatch(existing, patchTxt);
  expect(merged.patchedSceneIds).toEqual(['UT002_B']);
  expect(merged.count).toBe(1);
  expect(merged.notes.UT002_B).toContain('Fix UT002_B character leak');
  expect(merged.text).toBe('UT001_A | @HARUKO_HOME drinks tea.\nUT002_B | @HARUKO_HOME sits alone at the table.\nUT003_C | @SUMIE_HOME walks outside.');
  const jsonPatch = JSON.stringify({patches:[{scene_id:'UT003_C',reason:'Fix pose',prompt_en:'@SUMIE_HOME stands near the gate.'}]});
  const mergedJson = mergePromptPatch(merged.text, jsonPatch);
  expect(mergedJson.patchedSceneIds).toEqual(['UT003_C']);
  expect(mergedJson.notes.UT003_C).toBe('Fix pose');
  expect(mergedJson.text).toContain('UT003_C | @SUMIE_HOME stands near the gate.');
 });
 it('detects ghost character plain-text name leaks when @ID is missing',()=>{
  const document = {
   characters: [
    {character_id:'HARUKO_HOME',display_name:'Haruko (At Home)',identity_description_en:'64yo woman'},
    {character_id:'HARUKO_OUT',display_name:'Haruko (Outdoor)',identity_description_en:'64yo woman'},
    {character_id:'REIKO',display_name:'Reiko',identity_description_en:'65yo woman'},
   ],
   scenes: [
    {scene_id:'UT012_C',visible_character_ids:['HARUKO_HOME'],prompt_en:'@HARUKO_HOME sits across from Reiko at the cafe.'},
    {scene_id:'UT013_A',visible_character_ids:['HARUKO_OUT'],prompt_en:'@HARUKO_OUT walks while Haruko smiles.'},
   ],
  };
  const warnings1 = detectGhostCharacterWarnings(document, document.scenes[0]);
  expect(warnings1).toHaveLength(1);
  expect(warnings1[0]).toMatch(/reiko/i);
  expect(warnings1[0]).toContain('@REIKO');
  const warnings2 = detectGhostCharacterWarnings(document, document.scenes[1]);
  expect(warnings2).toEqual([]);
 });
});
