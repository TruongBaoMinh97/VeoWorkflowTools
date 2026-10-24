import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { characterEntries, characterGeneratorExecutor } from '../../src/modules/workflow/nodes/characterGeneratorExecutor.js';

it('rejects invalid or duplicate keys before generating',()=>{
  for(const entries of [[],[{reference_key:'../bad',prompt:'x'}],[{reference_key:'A',prompt:''}],[{reference_key:'A',prompt:'x'},{reference_key:'A',prompt:'y'}]])
    expect(()=>characterEntries({entries,outputDir:os.tmpdir()})).toThrow();
});
it('generates each character independently, persists a library and disables fallbacks',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'character-test-'));
  const image=path.join(root,'source.png');await writeFile(image,'test-image');const calls=[];
  const engine={async checkPauseOrCancel(){},async dispatchNode(...args){calls.push(args);return {results:[{url:`file://${image}`,kind:'image'}]}}};
  const data={outputDir:root,entries:[{reference_key:'A',prompt:'Alice'},{reference_key:'B',prompt:'Bob'}],stylePrompt:'Watercolor'};
  const result=await characterGeneratorExecutor.execute({data,engine,provider:{}});
  const manifest=JSON.parse(await readFile(result.textValue,'utf8'));
  expect(Object.keys(manifest.library)).toEqual(['A','B']);expect(result.results).toHaveLength(2);
  expect(calls[0][1]).toMatchObject({count:1,quotaFallback:false,contentFallback:'none'});
  expect(calls[1][2]).toMatchObject({promptTexts:['Bob\n\nWatercolor'],imageResults:[]});
  expect(await readFile(manifest.library.A.path,'utf8')).toBe('test-image');
});
it('keeps completed images and marks a partial failure without automatic retry',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'character-failure-'));const image=path.join(root,'source.png');await writeFile(image,'image');let count=0;
  const engine={async checkPauseOrCancel(){},async dispatchNode(){if(count++)throw Error('Quota');return {results:[{url:`file://${image}`,kind:'image'}]}}};
  await expect(characterGeneratorExecutor.execute({data:{outputDir:root,entries:[{reference_key:'A',prompt:'a'},{reference_key:'B',prompt:'b'}]},engine})).rejects.toThrow(/1\/2/);
  const folder=(await readdir(root)).find(n=>n.startsWith('characters_'));const manifest=JSON.parse(await readFile(path.join(root,folder,'character-library.json'),'utf8'));
  expect(manifest.completed).toEqual(['A']);expect(manifest.error).toBe('Quota');expect(await readFile(manifest.library.A.path,'utf8')).toBe('image');
});
