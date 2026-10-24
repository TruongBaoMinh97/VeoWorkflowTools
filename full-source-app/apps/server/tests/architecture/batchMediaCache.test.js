import {it,expect,vi} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {BatchMediaCache} from '../../src/modules/workflow/lib/batchMediaCache.js';
it('single-flights uploads by content/profile/project, expires and evicts failures',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'media-cache-'));
 try{
  const a=path.join(root,'a.png'),b=path.join(root,'b.png');await writeFile(a,'same');await writeFile(b,'same');
  let now=0;const cache=new BatchMediaCache({ttlMs:10,now:()=>now}),upload=vi.fn(async()=> 'media');
  expect(await Promise.all(Array.from({length:8},(_,i)=>cache.upload('p','project',i%2?a:b,upload)))).toEqual(Array(8).fill('media'));expect(upload).toHaveBeenCalledTimes(1);
  await cache.upload('other','project',a,upload);await cache.upload('p','other-project',a,upload);expect(upload).toHaveBeenCalledTimes(3);
  await writeFile(a,'changed');await cache.upload('p','project',a,upload);expect(upload).toHaveBeenCalledTimes(4);
  now=11;await cache.upload('p','project',b,upload);expect(upload).toHaveBeenCalledTimes(5);
  const failing=vi.fn().mockRejectedValueOnce(Error('upload failed')).mockResolvedValue('new');
  await expect(cache.upload('x','x',a,failing)).rejects.toThrow('upload failed');expect(await cache.upload('x','x',a,failing)).toBe('new');
 }finally{await rm(root,{recursive:true,force:true})}
});
it('shares project creation within batch/profile, restores persisted project, retries failures',async()=>{
 const c=new BatchMediaCache(),create=vi.fn(async()=> 'project'),save=vi.fn();
 await Promise.all(Array.from({length:8},()=>c.project('batch','p',create,async()=>null,save)));expect(create).toHaveBeenCalledTimes(1);expect(save).toHaveBeenCalledTimes(1);
 await c.project('batch','other',create);expect(create).toHaveBeenCalledTimes(2);
 const next=new BatchMediaCache();expect(await next.project('batch','p',create,async()=> 'persisted')).toBe('persisted');expect(create).toHaveBeenCalledTimes(2);
 const fail=vi.fn().mockRejectedValueOnce(Error('expired session')).mockResolvedValue('ok');await expect(c.project('bad','p',fail)).rejects.toThrow();expect(await c.project('bad','p',fail)).toBe('ok');
});
