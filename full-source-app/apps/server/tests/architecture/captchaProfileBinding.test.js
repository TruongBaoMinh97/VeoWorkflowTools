import { describe, expect, it, vi } from 'vitest';

const mint = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/captchaProvider.js', () => ({
    getCaptchaProvider: () => 'cdp',
    cdpMint: mint,
    cdpReset: vi.fn(),
}));

import { captchaManager } from '../../src/lib/captchaManager.js';

describe('CDP CAPTCHA profile binding', () => {
    it('keeps the selected account bound to each serialized mint', async () => {
        let releaseFirst;
        const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
        mint.mockImplementationOnce(async () => {
            await firstGate;
            return 'first-token';
        }).mockResolvedValueOnce('second-token');

        const first = captchaManager.requestToken('IMAGE_GENERATION', 'profile-first');
        await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
        expect(captchaManager.getActiveMintProfileId()).toBe('profile-first');

        const second = captchaManager.requestToken('IMAGE_GENERATION', 'profile-second');
        expect(captchaManager.getActiveMintProfileId()).toBe('profile-first');
        releaseFirst();
        await expect(first).resolves.toMatchObject({ token: 'first-token' });
        await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(2));
        await expect(second).resolves.toMatchObject({ token: 'second-token' });
        expect(captchaManager.getActiveMintProfileId()).toBeNull();
    });
});
