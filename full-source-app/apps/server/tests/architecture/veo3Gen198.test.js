import { describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
const mint = vi.hoisted(() => vi.fn());
const scheduleImage = vi.hoisted(() => vi.fn(async (_profileId, execute) => execute()));
vi.mock('../../src/lib/flowBoq.js', async (importOriginal) => ({
    ...(await importOriginal()),
    callFlowRpc: rpc,
}));
vi.mock('../../src/lib/captchaManager.js', () => ({
    captchaManager: { requestToken: mint },
}));
vi.mock('../../src/lib/profileImageScheduler.js', () => ({
    profileImageScheduler: { run: scheduleImage },
}));

import { Veo3Service } from '../../src/services/veo3/veo3Service.js';
import { buildVideoBatchArgs, parseMediaRow } from '../../src/services/veo3/flowVideoGen.js';
import { getModelKeyForGenerationType } from '../../src/utils/videoModelResolver.js';
import { ProxyGate } from '../../src/lib/proxyGate.js';

describe('Veo3Studio 1.9.8 generation core in VeoWorkflow', () => {
    it('keeps CAPTCHA token requests bound to the selected profile', async () => {
        mint.mockResolvedValue({ token: 'token-for-minh' });
        const service = new Veo3Service({ profileId: 'minh' });

        await expect(service.requestRecaptchaTokens('IMAGE_GENERATION', 1)).resolves.toEqual(['token-for-minh']);
        expect(mint).toHaveBeenCalledWith('IMAGE_GENERATION', 'minh');
        mint.mockReset();
    });

    it('submits matching video rows in one Flow call and preserves scene mapping', async () => {
        let sentArgs;
        rpc.mockImplementation(async (_profileId, _rpcId, buildArgs) => {
            sentArgs = await buildArgs();
            return [null, 10, null, [
                ['operation-1', null, 'workflow-1'],
                ['operation-2', null, 'workflow-2'],
            ]];
        });
        const service = new Veo3Service({ profileId: 'minh' });
        vi.spyOn(service, 'requestRecaptchaTokens').mockResolvedValue(['video-token']);
        const request = {
            clientContext: { projectId: 'project-1' },
            requests: ['scene-1', 'scene-2'].map((sceneId) => ({
                textInput: { prompt: `Prompt for ${sceneId}` },
                videoModelKey: 'veo_3_1_t2v_lite',
                aspectRatio: 'VIDEO_ASPECT_RATIO_LANDSCAPE',
                metadata: { sceneId },
            })),
        };

        const result = await service.submitVideoViaFlow('t2v', request);

        expect(rpc).toHaveBeenCalledTimes(1);
        expect(sentArgs[0]).toHaveLength(2);
        expect(sentArgs[1][10]).toEqual(['video-token', 1]);
        expect(result.operations.map((operation) => operation.sceneId)).toEqual(['scene-1', 'scene-2']);
        rpc.mockReset();
    });

    it('builds Omni 1.2 keys and the measured 360p batch shape', () => {
        expect(getModelKeyForGenerationType(
            'TEXT_TO_VIDEO', 'VIDEO_ASPECT_RATIO_LANDSCAPE', 'fast', 15,
            'omni_flash', 'macaron_cookie_360p',
        )).toBe('macaron_cookie_t2v_15s_360p');
        const args = buildVideoBatchArgs({
            mode: 't2v',
            projectId: 'project-1',
            modelKey: 'macaron_cookie_t2v_15s_360p',
            aspectCode: 2,
            recaptchaToken: 'video-token',
            rows: [{ prompt: 'one' }, { prompt: 'two' }],
        });
        expect(args[0]).toHaveLength(2);
        expect(args[0][0].at(-1)).toEqual([4]);
        expect(args[1][10]).toEqual(['video-token', 1]);
    });

    it('does not submit an already completed image again after a partial batch failure', async () => {
        const media = Array(12).fill(null);
        media[0] = 'media-2';
        media[11] = [null, 'https://images.example/result.jpg'];
        rpc.mockImplementationOnce(async (_profileId, _rpcId, buildArgs) => {
            await buildArgs();
            throw new Error('temporary failure');
        }).mockImplementationOnce(async (_profileId, _rpcId, buildArgs) => {
            await buildArgs();
            return [[media]];
        });
        const service = new Veo3Service({ profileId: 'minh' });
        const requestTokens = vi.spyOn(service, 'requestRecaptchaTokens')
            .mockImplementation(async (_action, count) => Array.from({ length: count }, (_, i) => `token-${i}`));
        const completedImages = new Map();
        const options = {
            projectId: 'project-1',
            imageModelName: 'GEM_PIX_2',
            prompts: [{ prompt: 'first' }, { prompt: 'second' }],
            completedImages,
        };

        await expect(service.generateBatchImages(options)).rejects.toThrow('temporary failure');
        expect(completedImages.has(1)).toBe(true);
        expect(completedImages.has(0)).toBe(false);

        media[0] = 'media-1';
        rpc.mockImplementationOnce(async (_profileId, _rpcId, buildArgs) => {
            await buildArgs();
            return [[media]];
        });
        const results = await service.generateBatchImages(options);

        expect(results.map((result) => result.name)).toEqual(['media-1', 'media-2']);
        expect(rpc).toHaveBeenCalledTimes(3);
        expect(requestTokens.mock.calls.map((call) => call[1])).toEqual([1, 1, 1]);
        expect(scheduleImage.mock.calls.map((call) => call[0])).toEqual(['minh', 'minh', 'minh']);
        rpc.mockReset();
        scheduleImage.mockClear();
    });

    it('keeps the provider reason when a polled video row fails', () => {
        const row = ['media-1', null, null, null, null, [
            null, null, null, null, null, null, null, null,
            [4, 'PUBLIC_ERROR_UNSAFE_GENERATION'],
        ]];
        expect(parseMediaRow(row).error).toContain('PUBLIC_ERROR_UNSAFE_GENERATION');
    });

    it('waits for a mint-and-submit unit before switching proxy egress', async () => {
        const gate = new ProxyGate();
        let finishUnit;
        const unit = gate.hold(() => new Promise((resolve) => { finishUnit = resolve; }));
        const switchEgress = vi.fn();
        const rotation = gate.exclusive(switchEgress, 1000);

        await Promise.resolve();
        expect(switchEgress).not.toHaveBeenCalled();
        finishUnit();
        await unit;
        await expect(rotation).resolves.toMatchObject({ drained: true });
        expect(switchEgress).toHaveBeenCalledOnce();
    });
});
