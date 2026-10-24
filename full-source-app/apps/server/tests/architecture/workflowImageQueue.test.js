import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageGenerationQueue, batchProductLanes, singleImageWorkflow, normalizeParallel, defaultImagesPerProduct } from '../../src/modules/workflow/lib/imageGenerationQueue.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

describe('workflow profile image scheduling', () => {
    it('overlaps two four-image products after the gap, but holds a third until capacity frees', async () => {
        const queue = new ImageGenerationQueue({ gapMs: () => 8000 });
        const active = [], started = [];
        const jobs = [0, 1, 2].map(i => queue.run('profile', 4, () => false, fired => {
            started.push(i); fired(); const wait = deferred(); active[i] = wait; return wait.promise;
        }));
        expect(started).toEqual([0]);
        await vi.advanceTimersByTimeAsync(7900); expect(started).toEqual([0]);
        await vi.advanceTimersByTimeAsync(100); expect(started).toEqual([0, 1]);
        await vi.advanceTimersByTimeAsync(9000); expect(started).toEqual([0, 1]);
        active[0].resolve('product A'); await vi.advanceTimersByTimeAsync(100);
        expect(started).toEqual([0, 1, 2]);
        active[1].resolve('product B'); active[2].resolve('product C');
        expect(await Promise.all(jobs)).toEqual(['product A', 'product B', 'product C']);
        await vi.advanceTimersByTimeAsync(8100); expect(queue.profiles.size).toBe(0);
    });
    it('anchors the gap to actual submit after slow preparation and keeps profiles independent', async () => {
        const queue = new ImageGenerationQueue({ gapMs: () => 7000 });
        const ready = deferred(), done = deferred(); const calls = [];
        const a = queue.run('p', 4, () => false, async fired => { await ready.promise; fired(); calls.push('a'); return done.promise; });
        const b = queue.run('p', 4, () => false, fired => { fired(); calls.push('b'); return 'b'; });
        await expect(queue.run('other', 4, () => false, fired => { fired(); return 'other'; })).resolves.toBe('other');
        await vi.advanceTimersByTimeAsync(15000); expect(calls).toEqual([]);
        ready.resolve(); await vi.advanceTimersByTimeAsync(6900); expect(calls).toEqual(['a']);
        await vi.advanceTimersByTimeAsync(100); expect(calls).toEqual(['a', 'b']);
        done.resolve('a'); await Promise.all([a, b]);
    });
    it('removes cancelled waiting work and releases slots after preparation failure', async () => {
        const queue = new ImageGenerationQueue({ gapMs: () => 7000 });
        let cancelled = false;
        const first = queue.run('p', 4, () => false, () => { throw new Error('token failure'); }).catch(e => e.message);
        const execute = vi.fn();
        const second = queue.run('p', 4, () => cancelled, execute).catch(e => e.message);
        const third = queue.run('p', 4, () => false, fired => { fired(); return 'ok'; });
        cancelled = true;
        await vi.advanceTimersByTimeAsync(7100);
        expect(await first).toBe('token failure'); expect(await second).toBe('Run was cancelled');
        expect(execute).not.toHaveBeenCalled(); expect(await third).toBe('ok');
    });
    it('rejects oversized requests and defaults folder batches to two product lanes', async () => {
        const queue = new ImageGenerationQueue();
        await expect(queue.run('p', 5, () => false, vi.fn())).rejects.toThrow('1–4');
        const folder = { nodes: [{ type: 'folder-input' }] };
        expect(batchProductLanes({}, folder)).toBe(2);
        expect(batchProductLanes({ rowsPerProfile: 3 }, folder)).toBe(2);
        expect(batchProductLanes({ rowsPerProfile: 1 }, folder)).toBe(1);
        expect(batchProductLanes({}, { nodes: [] })).toBe(1);
    });
});

describe('single-image advanced batches',()=>{
 it('runs eight single-image jobs while respecting bursts and waits for capacity before a ninth',async()=>{
  const q=new ImageGenerationQueue({tickMs:10}),started=[],waits=[];
  const jobs=Array.from({length:9},(_,i)=>q.run('p',1,()=>false,fired=>{started.push(i);fired();const d=deferred();waits[i]=d;return d.promise},{imageModelKey:'GEM_PIX_2',concurrency:2,burst:4,restSeconds:2,imagesPerProduct:1}));
  await vi.advanceTimersByTimeAsync(100);expect(started).toHaveLength(4);
  await vi.advanceTimersByTimeAsync(1800);expect(started).toHaveLength(4);
  await vi.advanceTimersByTimeAsync(200);expect(started).toHaveLength(8);
  await vi.advanceTimersByTimeAsync(6000);expect(started).toHaveLength(8);
  waits[0].resolve();await vi.advanceTimersByTimeAsync(20);expect(started).toHaveLength(9);
  waits.forEach(d=>d.resolve());await Promise.all(jobs);
 });
 it('defaults Etsy product folders to four outputs per product and validates 1–4',()=>{
  const def={nodes:[{type:'generate-image',data:{count:1}}]};expect(singleImageWorkflow(def)).toBe(true);
  expect(batchProductLanes({parallelSettings:{concurrency:2,burst:4,imagesPerProduct:1}},def)).toBe(8);
  expect(batchProductLanes({parallelSettings:{concurrency:2,burst:4,imagesPerProduct:2}},def)).toBe(4);
  expect(batchProductLanes({parallelSettings:{concurrency:2,burst:4,imagesPerProduct:3}},def)).toBe(2);
  expect(batchProductLanes({parallelSettings:{concurrency:2,burst:2,imagesPerProduct:4}},def)).toBe(2);
  expect(singleImageWorkflow({nodes:[...def.nodes,{type:'generate-video'}]})).toBe(false);
  expect(singleImageWorkflow({nodes:[{type:'generate-image',data:{count:4}}]})).toBe(true);
  expect(singleImageWorkflow({nodes:[{type:'generate-image',data:{count:5}}]})).toBe(false);
  expect(defaultImagesPerProduct({nodes:[...def.nodes,{type:'folder-input',data:{groupMode:'product-images'}}]})).toBe(4);
  expect(defaultImagesPerProduct(def)).toBe(1);
  expect(normalizeParallel({concurrency:2,burst:4}).burst).toBe(4);
  expect(normalizeParallel({imageModelKey:'HARBOR_SEAL',concurrency:8,burst:4,restSeconds:10,imagesPerProduct:4})).toMatchObject({imageModelKey:'HARBOR_SEAL',imagesPerProduct:4});
  expect(()=>normalizeParallel({imagesPerProduct:5})).toThrow();
  expect(()=>normalizeParallel({restSeconds:0})).toThrow();
  expect(()=>normalizeParallel({restSeconds:-1})).toThrow();
 });

 it('reserves four output slots for one product request instead of four product requests',async()=>{
  const q=new ImageGenerationQueue({tickMs:10}),started=[],waits=[];
  const settings={imageModelKey:'GEM_PIX_2',concurrency:2,burst:4,restSeconds:10,imagesPerProduct:4};
  const jobs=Array.from({length:3},(_,i)=>q.run('p',4,()=>false,fired=>{started.push(i);fired();const d=deferred();waits[i]=d;return d.promise},settings));
  await vi.advanceTimersByTimeAsync(100);expect(started).toEqual([0,1]);
  waits[0].resolve('p0');await vi.advanceTimersByTimeAsync(20);expect(started).toEqual([0,1,2]);
  waits[1].resolve('p1');waits[2].resolve('p2');expect(await Promise.all(jobs)).toEqual(['p0','p1','p2']);
 });
});
