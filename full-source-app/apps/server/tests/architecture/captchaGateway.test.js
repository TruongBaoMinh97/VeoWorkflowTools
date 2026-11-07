import { describe, expect, it, vi } from 'vitest';
import { CaptchaGateway } from '../../src/integrations/captcha/CaptchaGateway.js';
import { cdpMint } from '../../src/lib/captchaProvider.js';
import { electronBrowserBridge } from '../../src/integrations/browser/ElectronBrowserBridge.js';
import { IntegrationError } from '../../src/contracts/integration.js';

function createManager(overrides = {}) {
    return {
        requestToken: vi.fn(async () => 'token'),
        extensionLiveness: vi.fn(() => 'online'),
        stats: vi.fn(() => ({ hasFlowTab: true })),
        ...overrides,
    };
}

describe('CaptchaGateway', () => {
    it('reports an SDK failure as a mint error instead of a disconnected bridge', async () => {
        const request = vi.spyOn(electronBrowserBridge, 'requestJson').mockRejectedValueOnce(
            new IntegrationError('BROWSER_BRIDGE_REQUEST_FAILED', 'GRECAPTCHA_UNAVAILABLE', {
                retryable: true,
                details: { status: 502, body: { code: 'MINT_FAILED', error: 'GRECAPTCHA_UNAVAILABLE: no execute' } },
            }),
        );
        try {
            await expect(cdpMint('IMAGE_GENERATION')).rejects.toMatchObject({
                code: 'CAPTCHA_SDK_UNAVAILABLE',
                retryable: true,
            });
        }
        finally {
            request.mockRestore();
        }
    });

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
