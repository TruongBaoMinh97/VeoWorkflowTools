import { describe, expect, it, vi } from 'vitest';
import { CaptchaGateway } from '../../src/integrations/captcha/CaptchaGateway.js';

function createManager(overrides = {}) {
    return {
        requestToken: vi.fn(async () => 'token'),
        extensionLiveness: vi.fn(() => 'online'),
        stats: vi.fn(() => ({ hasFlowTab: true })),
        ...overrides,
    };
}

describe('CaptchaGateway', () => {
    it('normalizes CDP readiness', async () => {
        const gateway = new CaptchaGateway({
            manager: createManager(),
            getProvider: () => 'cdp',
            getCdpStatus: async () => ({ running: true, pageUrl: 'https://flow.google.com/' }),
        });

        await expect(gateway.ensureReady()).resolves.toMatchObject({
            provider: 'cdp',
            connected: true,
            hasFlowTab: true,
        });
    });

    it('returns one stable error when the browser is offline', async () => {
        const gateway = new CaptchaGateway({
            manager: createManager(),
            getProvider: () => 'cdp',
            getCdpStatus: async () => ({ running: false, pageUrl: null }),
        });

        await expect(gateway.ensureReady()).rejects.toMatchObject({
            code: 'CAPTCHA_BROWSER_OFFLINE',
            retryable: true,
        });
    });

    it('supports the extension adapter through the same contract', async () => {
        const gateway = new CaptchaGateway({
            manager: createManager(),
            getProvider: () => 'extension',
        });

        await expect(gateway.ensureReady()).resolves.toMatchObject({
            provider: 'extension',
            connected: true,
            hasFlowTab: true,
        });
        await expect(gateway.getToken('VIDEO_GENERATION')).resolves.toBe('token');
    });
});
