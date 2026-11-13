import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/modules/workflow/workflow.service.js', () => ({ workflowService: {} }));
vi.mock('../../src/modules/workflow/workflow.repository.js', () => ({ workflowRepository: {} }));
vi.mock('../../src/modules/workflow/workflow.batch.repository.js', () => ({ loadBatchParallel:vi.fn(async()=>null),saveBatchParallel:vi.fn(),workflowBatchRepository: {
    claimNextItem: vi.fn(), failItem: vi.fn().mockResolvedValue(undefined), failPendingItems: vi.fn(),
    countItemsByStatus: vi.fn(), updateBatchStatus: vi.fn(),
} }));
import { workflowBatchOrchestrator as runner } from '../../src/modules/workflow/workflow.batch.orchestrator.js';
import { workflowBatchRepository as repo } from '../../src/modules/workflow/workflow.batch.repository.js';
import { ProfileJobSlots, batchProfileSlots, flowProfileUnavailable } from '../../src/modules/workflow/lib/profileJobSlots.js';
const definition = { nodes: [{ id: 'image', type: 'generate-image' }, { type: 'folder-input' }] };
const state = () => ({ cancelled: false, runIds: new Set(), blockedProfiles: new Map() });
const tick = () => new Promise(resolve => setImmediate(resolve));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });

describe('multi-profile Batch scheduling', () => {
    it('shares two slots per profile across batches, while three profiles run six unique jobs', async () => {
        const jobs = { a: Array.from({ length: 9 }, (_, id) => ({ id: `a${id}` })), b: Array.from({ length: 9 }, (_, id) => ({ id: `b${id}` })) };
        repo.claimNextItem.mockImplementation(async batchId => jobs[batchId].shift() ?? null);
        const counts = new Map(), seen = new Set(), pending = [];
        let peak = 0;
        vi.spyOn(runner, 'processItem').mockImplementation(async (batch, def, schema, item, profile) => {
            expect(seen.has(item.id)).toBe(false); seen.add(item.id);
            counts.set(profile, (counts.get(profile) ?? 0) + 1);
            expect(counts.get(profile)).toBeLessThanOrEqual(2);
            peak = Math.max(peak, [...counts.values()].reduce((a, b) => a + b, 0));
            await new Promise(resolve => pending.push(resolve));
            counts.set(profile, counts.get(profile) - 1);
        });
        const workers = ['a', 'b'].flatMap(id => ['p1', 'p2', 'p3'].map(profile =>
            runner.runProfileWorker({ id, rowsPerProfile: 2 }, definition, {}, profile, state())));
        for (let i = 0; i < 30; i++) { await tick(); pending.splice(0).forEach(resolve => resolve()); }
        await Promise.all(workers);
        expect(seen.size).toBe(18); expect(peak).toBe(6);
        expect(batchProfileSlots.active.size).toBe(0);
        expect(batchProfileSlots.waiting.size).toBe(0);
    });
    it('cancels a waiting reservation without claiming a job and releases idempotently', async () => {
        vi.useFakeTimers();
        const slots = new ProfileJobSlots();
        const first = await slots.acquire('p'), second = await slots.acquire('p');
        let cancelled = false;
        const waiting = slots.acquire('p', () => cancelled);
        cancelled = true;
        await vi.advanceTimersByTimeAsync(100);
        expect(await waiting).toBe(null);
        first(); first(); second();
        expect(slots.active.size).toBe(0); expect(slots.waiting.size).toBe(0);
    });
    it('releases capacity after a job throws and continues the next row', async () => {
        repo.claimNextItem.mockResolvedValueOnce({ id: 'bad' }).mockResolvedValueOnce({ id: 'good' }).mockResolvedValue(null);
        repo.failItem.mockResolvedValue(undefined);
        const process = vi.spyOn(runner, 'processItem').mockRejectedValueOnce(new Error('download failed')).mockResolvedValue();
        await runner.runProfileLane({ id: 'a' }, definition, {}, 'p', state());
        expect(process).toHaveBeenCalledTimes(2);
        expect(repo.failItem).toHaveBeenCalledWith('bad', 'ERROR', 'download failed');
        expect(batchProfileSlots.active.size).toBe(0);
    });
    it('does not assign more rows to an unavailable profile while healthy profiles drain the queue', async () => {
        const items = Array.from({ length: 8 }, (_, id) => ({ id }));
        repo.claimNextItem.mockImplementation(async () => items.shift() ?? null);
        const shared = state(), assigned = [];
        vi.spyOn(runner, 'processItem').mockImplementation(async (batch, def, schema, item, profile) => {
            assigned.push(profile);
            if (profile === 'bad') shared.blockedProfiles.set(profile, 'quota');
            await tick();
        });
        await Promise.all(['bad', 'good'].map(profile => runner.runProfileWorker({ id: 'a', rowsPerProfile: 2 }, definition, {}, profile, shared)));
        expect(assigned.filter(p => p === 'bad').length).toBeLessThanOrEqual(2);
        expect(assigned.length).toBe(8);
    });
    it('finishes with actionable errors when all profiles are unavailable', async () => {
        const shared = state(); shared.blockedProfiles.set('bad', 'quota');
        repo.countItemsByStatus.mockResolvedValue({ total: 4, pending: 0, running: 0, done: 0, error: 4, cancelled: 0 });
        await runner.runBatch({ id: 'a', profileIds: ['bad'] }, definition, {}, null, shared);
        expect(repo.failPendingItems).toHaveBeenCalledWith('a', expect.stringContaining('PROFILE_UNAVAILABLE'));
        expect(repo.updateBatchStatus).toHaveBeenCalledWith('a', 'FAILED', null);
    });
    it('blocks explicit Flow account failures, not OpenAI quota, content rejection or traffic limits', () => {
        const def = { nodes: [{ id: 'flow', type: 'generate-image' }, { id: 'ai', type: 'chatgpt' }] };
        const run = (id, error) => ({ error, nodeStates: { [id]: { status: 'error', error } } });
        expect(flowProfileUnavailable(run('flow', 'PUBLIC_ERROR_USER_QUOTA_REACHED'), def)).toBe(true);
        expect(flowProfileUnavailable(run('flow', 'UNAUTHENTICATED'), def)).toBe(true);
        expect(flowProfileUnavailable(run('ai', 'PUBLIC_ERROR_USER_QUOTA_REACHED'), def)).toBe(false);
        expect(flowProfileUnavailable(run('flow', 'PUBLIC_ERROR_SEXUAL'), def)).toBe(false);
        expect(flowProfileUnavailable(run('flow', '429 PUBLIC_ERROR_HIGH_TRAFFIC'), def)).toBe(false);
    });
});

it('shares at most eight advanced slots across batches and releases cancelled waiters',async()=>{
 const slots=new ProfileJobSlots(),release=[];
 for(let i=0;i<8;i++)release.push(await slots.acquire('p',()=>false,8));
 let admitted=false,cancelled=false;
 const waiting=slots.acquire('p',()=>cancelled,8).then(r=>{admitted=!!r;return r});
 await tick();expect(admitted).toBe(false);expect(slots.active.get('p')).toBe(8);
 cancelled=true;slots.pump('p');expect(await waiting).toBe(null);
 release.forEach(r=>r());expect(slots.active.size).toBe(0);
});

it('pause lets the current job finish, blocks new claims, resumes remaining rows',async()=>{
 vi.useFakeTimers();const shared=state();let finish;const current=new Promise(r=>finish=r);
 repo.claimNextItem.mockResolvedValueOnce({id:'one'}).mockResolvedValueOnce({id:'two'}).mockResolvedValue(null);
 const process=vi.spyOn(runner,'processItem').mockImplementationOnce(async()=>{await current}).mockResolvedValue(undefined);
 const work=runner.runProfileLane({id:'pause-test',rowsPerProfile:1},definition,{},'pause-p',shared);
 await vi.advanceTimersByTimeAsync(0);expect(process).toHaveBeenCalledTimes(1);
 shared.paused=true;finish();await vi.advanceTimersByTimeAsync(500);
 expect(repo.claimNextItem).toHaveBeenCalledTimes(1);expect(batchProfileSlots.active.has('pause-p')).toBe(false);
 shared.paused=false;await vi.advanceTimersByTimeAsync(100);await work;
 expect(process).toHaveBeenCalledTimes(2);
});
it('cancel exits a paused lane without claiming any row',async()=>{
 vi.useFakeTimers();const shared={...state(),paused:true};const work=runner.runProfileLane({id:'paused'},definition,{},'paused-p',shared);
 await vi.advanceTimersByTimeAsync(200);expect(repo.claimNextItem).not.toHaveBeenCalled();shared.cancelled=true;await vi.advanceTimersByTimeAsync(100);await work;
 expect(repo.claimNextItem).not.toHaveBeenCalled();
});

it('applies edited lane settings when a paused product batch resumes',async()=>{
 vi.useFakeTimers();
 const shared={...state(),paused:true};
 const batch={id:'reconfigure',parallelSettings:{imageModelKey:'GEM_PIX_2',concurrency:1,burst:1,restSeconds:10,imagesPerProduct:4}};
 const items=Array.from({length:4},(_,id)=>({id:'item-'+id}));
 repo.claimNextItem.mockImplementation(async()=>items.shift()??null);
 const finishes=[];
 const process=vi.spyOn(runner,'processItem').mockImplementation(()=>new Promise(resolve=>finishes.push(resolve)));
 const work=runner.runProfileWorker(batch,definition,{},'reconfigure-p',shared);
 await vi.advanceTimersByTimeAsync(200);expect(process).not.toHaveBeenCalled();
 batch.parallelSettings={...batch.parallelSettings,concurrency:2,burst:2};
 shared.paused=false;
 await vi.advanceTimersByTimeAsync(200);
 expect(process).toHaveBeenCalledTimes(2); // 2 products × 4 images = the eight-image cap
 shared.cancelled=true;finishes.splice(0).forEach(resolve=>resolve());
 await vi.advanceTimersByTimeAsync(200);await work;
});
