import {describe,it,expect,vi,afterEach} from 'vitest';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {saveMultiStoryImages} from '../../src/modules/workflow/lib/multiStoryImages.js';
const roots=[];afterEach(async()=>{for(const r of roots.splice(0))await rm(r,{recursive:true,force:true})});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9kAAAAASUVORK5CYII=','base64');
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'multi-images-'));roots.push(root);return {outputDir:root,jobs:[{id:'one',jobIndex:0,status:'COMPLETED',resultUrl:'https://example.test/one'},{id:'two',jobIndex:1,status:'FAILED',resultUrl:null}]};}
describe('background image saving',()=>{
 it('downloads successful images once and reuses persisted paths after restart',async()=>{
  const p=await fixture(),download=vi.fn(async(_url,file)=>writeFile(file,png)),track=vi.fn(async()=>{});
  expect((await saveMultiStoryImages(p,{download,track})).saved).toBe(1);
  const result=await saveMultiStoryImages(p,{download,track});expect(result.saved).toBe(1);expect(download).toHaveBeenCalledTimes(1);
  const manifest=JSON.parse(await readFile(path.join(result.root,'image-downloads.json'),'utf8'));expect(await readFile(path.join(result.root,manifest.one.file))).toEqual(png);
 });
 it('refreshes an expired URL and rejects non-images without marking downloaded',async()=>{
  const p=await fixture(),download=vi.fn().mockRejectedValueOnce(Error('403')).mockImplementationOnce(async(_url,file)=>writeFile(file,png)),track=vi.fn(async()=>{}),refresh=vi.fn(async()=>({success:true,freshUrl:'https://example.test/new'}));
  const result=await saveMultiStoryImages(p,{download,track,refresh});expect(result.saved).toBe(1);expect(download.mock.calls[1][0]).toContain('/new');
  p.jobs[0].resultUrl='https://example.test/bad';const bad=await saveMultiStoryImages(p,{download:async(_url,file)=>writeFile(file,'not an image'),track});
  expect(bad.failed).toHaveLength(1);expect(track.mock.calls.filter(([,v])=>v.downloadedAt)).toHaveLength(1);
 });
});
