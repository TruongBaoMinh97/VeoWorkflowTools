import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProfileImageScheduler } from '../../src/lib/profileImageScheduler.js';

afterEach(() => vi.useRealTimers());
describe('shared image admission', () => {
    it('spaces individual images across products and caps in-flight work', async () => {
        vi.useFakeTimers();
        const queue = new ProfileImageScheduler();
        const starts = [], finishes = [];
        const jobs = Array.from({ length: 4 }, (_, i) => queue.run('p', () => {
            starts.push(i);
            return new Promise(resolve => { finishes[i] = resolve; });
        }));
        await vi.advanceTimersByTimeAsync(0);
        expect(starts).toEqual([0]);
        await vi.advanceTimersByTimeAsync(5000);
        expect(starts).toEqual([0, 1]);
        await vi.advanceTimersByTimeAsync(10000);
        expect(starts).toEqual([0, 1]);
        finishes[0]();
        await vi.advanceTimersByTimeAsync(100);
        expect(starts).toEqual([0, 1, 2]);
        finishes[1](); finishes[2]();
        await vi.advanceTimersByTimeAsync(5000);
        finishes[3]();
        await Promise.all(jobs);
    });
    it('stops queued work on verification rejection until explicit restart', async () => {
        vi.useFakeTimers();
        const queue = new ProfileImageScheduler();
        const blocked = { status: 403, message: 'PUBLIC_ERROR_UNUSUAL_ACTIVITY' };
        const first = queue.run('p', () => { throw blocked; }).catch(e => e.code);
        const execute = vi.fn();
        const next = queue.run('p', execute).catch(e => e.code);
        await vi.advanceTimersByTimeAsync(100);
        expect(await first).toBe('FLOW_VERIFICATION_REQUIRED');
        expect(await next).toBe('FLOW_VERIFICATION_REQUIRED');
        expect(execute).not.toHaveBeenCalled();
        await expect(queue.run('other', () => 'ok')).resolves.toBe('ok');
        queue.resume('p');
        const retry = queue.run('p', () => 'resumed');
        await vi.advanceTimersByTimeAsync(5000);
        expect(await retry).toBe('resumed');
    });
    it('rechecks traffic cooldown after waiting and honors Retry-After', async () => {
        vi.useFakeTimers();
        const queue = new ProfileImageScheduler();
        const first = queue.run('p', () => { throw { status: 429, response: { headers: { 'retry-after': '180' } } }; }).catch(() => {});
        const execute = vi.fn(() => 'ok');
        const next = queue.run('p', execute);
        await vi.advanceTimersByTimeAsync(179900);
        expect(execute).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(100);
        await first;
        expect(await next).toBe('ok');
    });
});
