import { CaptchaGatewayContract, IntegrationError } from '../../contracts/integration.js';
import { captchaManager } from '../../lib/captchaManager.js';
import {
    cdpReset,
    cdpStatus,
    getCaptchaProvider,
} from '../../lib/captchaProvider.js';

export class CaptchaGateway extends CaptchaGatewayContract {
    constructor(dependencies = {}) {
        super();
        this.manager = dependencies.manager ?? captchaManager;
        this.getProvider = dependencies.getProvider ?? getCaptchaProvider;
        this.getCdpStatus = dependencies.getCdpStatus ?? cdpStatus;
        this.resetCdp = dependencies.resetCdp ?? cdpReset;
    }

    async ensureReady() {
        const status = await this.status();
        if (!status.connected) {
            throw new IntegrationError(
                status.provider === 'cdp' ? 'CAPTCHA_BROWSER_OFFLINE' : 'CAPTCHA_EXTENSION_OFFLINE',
                status.provider === 'cdp'
                    ? 'Trinh duyet captcha chua bat. Bam "Bat trinh duyet" truoc khi chay workflow.'
                    : 'Extension captcha chua ket noi. Hay mo profile va tab Flow truoc khi chay workflow.',
                { retryable: true, details: status },
            );
        }
        if (!status.hasFlowTab) {
            throw new IntegrationError(
                'CAPTCHA_FLOW_TAB_MISSING',
                'Chua co tab Flow AI trong trinh duyet captcha. Hay bat lai trinh duyet roi chay workflow.',
                { retryable: true, details: status },
            );
        }
        return status;
    }

    async getToken(action) {
        return this.manager.requestToken(action);
    }

    notifySuccess() {
        this.manager.notifySuccess();
    }

    notifyRecaptchaScoreDead() {
        this.manager.notifyRecaptchaScoreDead();
    }

    async reset(kind = 'soft') {
        if (this.getProvider() === 'cdp') {
            await this.resetCdp(kind === 'hard' ? 'hard_reset' : 'soft_reset');
        }
    }

    async status() {
        const provider = this.getProvider();
        if (provider === 'cdp') {
            const browser = await this.getCdpStatus();
            const running = Boolean(browser?.running);
            const hasFlowTab = Boolean(browser?.pageUrl?.startsWith('https://flow.google.com'));
            return {
                provider,
                connected: running,
                hasFlowTab,
                browser: browser ?? null,
            };
        }

        const liveness = this.manager.extensionLiveness();
        const stats = this.manager.stats();
        return {
            provider,
            connected: liveness !== 'offline',
            hasFlowTab: stats.hasFlowTab !== false,
            liveness,
            stats,
        };
    }
}

export const captchaGateway = new CaptchaGateway();
