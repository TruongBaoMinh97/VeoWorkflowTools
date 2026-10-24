import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareFolderBatch } from '../../src/modules/workflow/lib/prepareFolderBatch.js';
import { extractBatchSchema } from '../../src/modules/workflow/workflow.batch.schema.js';
import { createDefaultNodeExecutorRegistry } from '../../src/modules/workflow/engine/NodeExecutorRegistry.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const temps=[];
afterEach(async()=>{for(const dir of temps.splice(0)) await rm(dir,{recursive:true,force:true});});
async function setup(mode='files') {
 const dir=await mkdtemp(path.join(os.tmpdir(),'folder-node-')); temps.push(dir);
 return { dir, def:{nodes:[{id:'folder',type:'folder-input',data:{folderPath:dir,groupMode:mode,outputDir:path.join(dir,'output')}},{id:'brief',type:'prompt',data:{prompt:'Shared instructions'}},{id:'result',type:'result',data:{batchRole:'output'}}],edges:[]} };
}
describe('Folder Input execution boundary',()=>{
 it('prepares single-reference rows for each image in a product subfolder',async()=>{
  const {dir,def}=await setup('product-images');await mkdir(path.join(dir,'dress'));
  await writeFile(path.join(dir,'dress','red.png'),png);await writeFile(path.join(dir,'dress','blue.png'),png);
  const prepared=await prepareFolderBatch(def);
  expect(prepared.items).toHaveLength(2);
  expect(prepared.items.map(item=>item.productId)).toEqual(['dress/blue.png','dress/red.png']);
  expect(prepared.items.every(item=>!item.inputValues.folder.startsWith('['))).toBe(true);
 });
 it('automatically exposes exactly one image input without requiring a batch toggle',()=>{
  const schema=extractBatchSchema({nodes:[{id:'folder',type:'folder-input',data:{}}]});
  expect(schema.inputs).toEqual([expect.objectContaining({nodeId:'folder',folderInput:true,batchInputType:'image'})]);
 });
 it('creates separate rows per product and keeps the shared brief out of row inputs',async()=>{
  const {dir,def}=await setup();
  await writeFile(path.join(dir,'a.png'),png);await writeFile(path.join(dir,'b.png'),png);
  const prepared=await prepareFolderBatch(def);
  expect(prepared.items).toHaveLength(2);
  expect(Object.keys(prepared.items[0].inputValues)).toEqual(['folder']);
  expect(prepared.items[0].inputValues.folder).not.toBe(prepared.items[1].inputValues.folder);
  expect(prepared.outputDir).toBe(path.join(dir,'output'));
 });
 it('groups references inside each subfolder without crossing product boundaries',async()=>{
  const {dir,def}=await setup('subfolders');
  for(const product of ['dress-a','dress-b']) {await mkdir(path.join(dir,product));for(const image of ['front.png','back.png']) await writeFile(path.join(dir,product,image),png);}
  const prepared=await prepareFolderBatch(def);
  expect(prepared.items).toHaveLength(2);
  for(const item of prepared.items){const refs=JSON.parse(item.inputValues.folder);expect(refs).toHaveLength(2);expect(refs.every(file=>path.basename(path.dirname(file))===item.productId)).toBe(true);}
 });
 it('rejects multiple folders and direct execution instead of mixing products',async()=>{
  const {def}=await setup();def.nodes.push({...def.nodes[0],id:'folder2'});
  await expect(prepareFolderBatch(def)).rejects.toThrow(/đúng một/);
  const registry=createDefaultNodeExecutorRegistry();
  await expect(registry.execute('folder-input',{data:{folderPath:'C:\\products'}})).rejects.toMatchObject({code:'FOLDER_BATCH_REQUIRED'});
 });
 it('uploads all references for just the current product',async()=>{
  const {dir}=await setup();const paths=[path.join(dir,'front.png'),path.join(dir,'back.png')];
  for(const file of paths) await writeFile(file,png);
  const upload=vi.fn().mockResolvedValueOnce('m1').mockResolvedValueOnce('m2');
  const result=await createDefaultNodeExecutorRegistry().execute('folder-input',{data:{localPaths:paths},resolved:{imageResults:[]},provider:{uploadImageAndExtractMediaId:upload},projectId:'product-project'});
  expect(result.results.map(r=>r.mediaId)).toEqual(['m1','m2']);expect(upload).toHaveBeenCalledTimes(2);
 });
});
