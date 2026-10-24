import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parsePromptLines, normalizePromptWorkflow } from '../../src/modules/workflow/lib/promptStory.js';
import { compileScene } from '../../src/modules/workflow/lib/storyScenes.js';
import { prepareCharacterDefinition } from '../../src/modules/workflow/lib/storyCharacters.js';
import os from 'node:os';
const fixture=JSON.parse(await readFile(new URL('../../../../../docs/workflows/STORY-IMAGES-V1.json',import.meta.url),'utf8'));
function def(){const d=structuredClone(fixture);d.nodes[0].data.promptText='SC001 | @AN hugs @MIU.\nSC002 | Moonlight on a lake.';d.nodes[0].data.outputDir=os.tmpdir();d.nodes[1].data.sharedStyle='Watercolor with warm light';return d}
it('parses lines, explicit ids, repeated tags, no characters; rejects duplicate and unsafe ids',()=>{
 expect(parsePromptLines('\uFEFF@AN sees @AN.\n\nLake.').map(s=>s.visible_character_ids)).toEqual([['AN'],[]]);
 expect(()=>parsePromptLines('SC001 | a\nSC001 | b')).toThrow(/Trùng/);
 expect(()=>parsePromptLines('CON | a')).toThrow();
 expect(()=>parsePromptLines('')).toThrow();
});
it('compiles prompt-only scenes without invented timestamps and selects only tagged references',()=>{
 const d=normalizePromptWorkflow(def()),doc=d.nodes[0].data.document;
 expect(doc.scenes[0].start_time).toBeUndefined();expect(doc.timing_mode).toBe('none');
 const p=compileScene(doc,doc.scenes[0],{CHAR_AN_DEFAULT:{path:'D:/a.png'},CHAR_MIU_DEFAULT:{path:'D:/m.png'},CHAR_BAO_DEFAULT:{path:'D:/b.png'}});
 expect(p.images.map(im=>im.key)).toEqual(['CHAR_AN_DEFAULT','CHAR_MIU_DEFAULT']);expect(p.prompt).toContain('Watercolor with warm light');
 expect(compileScene(doc,doc.scenes[1],{}).images).toEqual([]);
});
it('rejects unknown tags and applies exactly the same shared style to character creation',()=>{
 const d=def();d.nodes[1].data.characterStyle='OLD STYLE';
 const characters=prepareCharacterDefinition(d,'refs',['CHAR_AN_DEFAULT']);
 expect(characters.definition.nodes[0].data.stylePrompt).toBe('Watercolor with warm light');
 d.nodes[0].data.promptText='@UNKNOWN walks';expect(()=>normalizePromptWorkflow(d)).toThrow(/UNKNOWN/);
 // Character preparation is independent of an unfinished scene list.
 expect(prepareCharacterDefinition(d,'refs',['CHAR_AN_DEFAULT']).entries).toHaveLength(1);
});
it('keeps legacy timed documents readable and does not mutate the original definition',()=>{
 const old=structuredClone(fixture);const normalized=normalizePromptWorkflow(old);
 expect(normalized.nodes[0].data.document.scenes[0].start_time).toBeDefined();
 expect(old).toEqual(fixture);
});
