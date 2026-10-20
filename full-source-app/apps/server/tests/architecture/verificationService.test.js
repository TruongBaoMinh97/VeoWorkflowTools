import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, runtimeVerboseLogsEnabled: () => false }));
vi.mock('../../src/lib/captchaManager.js', () => ({ captchaManager: {} }));
vi.mock('../../src/services/veo3/veo3ProxyManager.js', () => ({
    buildProxyAgents: vi.fn(), evictProxyAgent: vi.fn(), applyInterProfileJitter: vi.fn(),
}));
import { Veo3Service } from '../../src/services/veo3/veo3Service.js';

const rejected = () => Object.assign(new Error('reCAPTCHA evaluation failed'), {
    response: { status: 403 },
    errorText: JSON.stringify({ error: { code: 403, message: 'reCAPTCHA evaluation failed', details: [{ reason: 'PUBLIC_ERROR_UNUSUAL_ACTIVITY' }] } }),
});

describe('Flow authentication versus verification', () => {
    it.each([{}, { cookies: 'test-cookie' }])('does not refresh credentials or repeat a rejected verification', async config => {
        const service = new Veo3Service(config);
        const refresh = vi.spyOn(service, 'refreshAccessTokenFromCookies');
        const submit = vi.fn().mockRejectedValue(rejected());
        await expect(service.executeWithTokenRefresh(submit)).rejects.toMatchObject({
            code: 'FLOW_VERIFICATION_REQUIRED', nonRetryable: true,
        });
        expect(submit).toHaveBeenCalledTimes(1);
        expect(refresh).not.toHaveBeenCalled();
    });

    it('preserves verification rejection after a legitimate 401 refresh instead of reporting expired cookies', async () => {
        const service = new Veo3Service({ cookies: 'test-cookie' });
        vi.spyOn(service, 'refreshAccessTokenFromCookies').mockResolvedValue('fresh-test-token');
        const submit = vi.fn()
            .mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { response: { status: 401 }, errorText: '' }))
            .mockRejectedValueOnce(rejected());
        await expect(service.executeWithTokenRefresh(submit)).rejects.toMatchObject({ code: 'FLOW_VERIFICATION_REQUIRED' });
        expect(submit).toHaveBeenCalledTimes(2);
        expect(service.refreshAccessTokenFromCookies).toHaveBeenCalledTimes(1);
    });
});
