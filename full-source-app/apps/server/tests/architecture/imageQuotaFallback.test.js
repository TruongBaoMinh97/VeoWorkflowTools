import { describe, it, expect, vi } from 'vitest';
import { generateWithImageQuotaFallback as fallback, isImageModelDailyQuota, imageModelOrder } from '../../src/modules/workflow/lib/imageQuotaFallback.js';
import { flowProfileUnavailable } from '../../src/modules/workflow/lib/profileJobSlots.js';
const quota = () => Object.assign(new Error('quota'), { errorText: JSON.stringify({ error: { details: [{ reason: 'PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED' }] } }) });
const setup = extra => ({ profileId: 'p', primary: 'GEM_PIX_2', cooldowns: new Map(), ...extra });
describe('image model quota fallback', () => {
    it('continues the same request on the next model and records the real model', async () => {
        const generate = vi.fn().mockRejectedValueOnce(quota()).mockResolvedValue(['image']);
        const onModel = vi.fn();
        const result = await fallback(setup({ generate, onModel }));
        expect(generate.mock.calls.map(call => call[0])).toEqual(['GEM_PIX_2', 'BELUGA']);
        expect(result.value).toEqual(['image']);
        expect(result.actualImageModel).toBe('BELUGA');
        expect(onModel.mock.calls[1][0].quotaFallbackNotice).toContain('Nano Banana Pro hết quota → Nano Banana 2.1');
    });
    it.each(['429 RESOURCE_EXHAUSTED', 'reCAPTCHA evaluation failed', 'PUBLIC_ERROR_USER_QUOTA_REACHED', 'PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED_UPGRADEABLE', 'PUBLIC_ERROR_HIGH_TRAFFIC', 'PUBLIC_ERROR_SEXUAL', 'network timeout'])(
        'does not change models for %s', async message => {
            const generate = vi.fn().mockRejectedValue(new Error(message));
            await expect(fallback(setup({ generate }))).rejects.toThrow(message);
            expect(generate).toHaveBeenCalledTimes(1);
        });
    it('shares cooldown by profile AND model, and expires it', async () => {
        const cooldowns = new Map(); let time = 0;
        const args = setup({ cooldowns, now: () => time });
        await fallback({ ...args, generate: vi.fn().mockRejectedValueOnce(quota()).mockResolvedValue(['image']) });
        const generate = vi.fn().mockResolvedValue(['image']);
        await fallback({ ...args, generate }); expect(generate.mock.calls[0][0]).toBe('BELUGA');
        await fallback({ ...args, profileId: 'other', generate }); expect(generate.mock.calls[1][0]).toBe('GEM_PIX_2');
        time = 24 * 60 * 60 * 1000;
        await fallback({ ...args, generate }); expect(generate.mock.calls[2][0]).toBe('GEM_PIX_2');
    });
    it('rechecks cooldown at launch when concurrent requests were queued', async () => {
        const cooldowns = new Map(); let launch;
        const waiting = fallback(setup({ cooldowns, generate: async (model, blocked) => {
            if (model === 'GEM_PIX_2') { await new Promise(resolve => { launch = resolve; }); if (blocked()) throw quota(); }
            return ['image'];
        } }));
        await new Promise(resolve => setImmediate(resolve));
        await fallback(setup({ cooldowns, generate: vi.fn().mockRejectedValueOnce(quota()).mockResolvedValue(['image']) }));
        launch();
        expect((await waiting).actualImageModel).toBe('BELUGA');
    });
    it('honors order, opt-out and deduplicates invalid model names', async () => {
        expect(imageModelOrder('GEM_PIX_2', true, ['HARBOR_SEAL', 'bad', 'HARBOR_SEAL', 'BELUGA'])).toEqual(['GEM_PIX_2', 'HARBOR_SEAL', 'BELUGA']);
        const generate = vi.fn().mockRejectedValue(quota());
        await expect(fallback(setup({ enabled: false, generate }))).rejects.toMatchObject({ code: 'IMAGE_MODELS_QUOTA_EXHAUSTED' });
        expect(generate).toHaveBeenCalledTimes(1);
    });
    it('stops permanently when all models are exhausted without blocking the entire profile', async () => {
        const generate = vi.fn().mockRejectedValue(quota()); let error;
        try { await fallback(setup({ generate })); } catch (caught) { error = caught; }
        expect(generate).toHaveBeenCalledTimes(3);
        expect(error).toMatchObject({ name: 'NonRetryableNodeError', code: 'IMAGE_MODELS_QUOTA_EXHAUSTED' });
        expect(flowProfileUnavailable({ error: error.message, nodeStates: { i: { status: 'error', error: error.message } } }, { nodes: [{ id: 'i', type: 'generate-image' }] })).toBe(false);
    });
    it('does not issue fallback after cancellation or repeat successful generations', async () => {
        let cancelled = false;
        const generate = vi.fn(async () => { cancelled = true; throw quota(); });
        await expect(fallback(setup({ generate, isCancelled: () => cancelled }))).rejects.toThrow('quota');
        expect(generate).toHaveBeenCalledTimes(1);
        const success = vi.fn().mockResolvedValue(['image']);
        await fallback(setup({ generate: success })); expect(success).toHaveBeenCalledTimes(1);
        expect(isImageModelDailyQuota(quota())).toBe(true);
    });
});
