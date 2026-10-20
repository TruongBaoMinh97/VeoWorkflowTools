import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    __resetForTest,
    buildSecChUaForMajor,
    getHostChromeMajor,
    getHostSecChUaPlatform,
    getHostUa,
} from '../../src/lib/hostChromeUa.js';

const bridgeMock = vi.hoisted(() => ({
    requestJson: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../src/integrations/browser/ElectronBrowserBridge.js', () => ({
    electronBrowserBridge: bridgeMock,
}));

let tempAppData;
let originalAppData;
let originalProvider;
let originalChromeFull;
let originalChromeMajor;

beforeEach(() => {
    tempAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'veo-workflow-captcha-'));
    originalAppData = process.env.APPDATA;
    originalProvider = process.env.CAPTCHA_PROVIDER;
    originalChromeFull = process.env.VEO3_CHROME_FULL;
    originalChromeMajor = process.env.VEO3_CHROME_MAJOR;
    process.env.APPDATA = tempAppData;
    delete process.env.CAPTCHA_PROVIDER;
    bridgeMock.requestJson.mockReset();
    bridgeMock.requestJson.mockResolvedValue({ ok: true });
    vi.resetModules();
});

afterEach(() => {
    restoreEnv('APPDATA', originalAppData);
    restoreEnv('CAPTCHA_PROVIDER', originalProvider);
    restoreEnv('VEO3_CHROME_FULL', originalChromeFull);
    restoreEnv('VEO3_CHROME_MAJOR', originalChromeMajor);
    __resetForTest();
    fs.rmSync(tempAppData, { recursive: true, force: true });
});

function restoreEnv(name, value) {
    if (value === undefined)
        delete process.env[name];
    else
        process.env[name] = value;
}

describe('Veo3Studio 1.8.8 captcha-core sync', () => {
    it('persists the selected provider in VeoWorkflow userData and reloads it', async () => {
        const first = await import('../../src/lib/captchaProvider.js');
        expect(first.getCaptchaProvider()).toBe('cdp');

        first.setCaptchaProvider('extension');
        const providerFile = path.join(tempAppData, 'Veo Workflow Tools', 'captcha-provider.json');
        expect(JSON.parse(fs.readFileSync(providerFile, 'utf8'))).toEqual({ provider: 'extension' });

        vi.resetModules();
        const reloaded = await import('../../src/lib/captchaProvider.js');
        expect(reloaded.getCaptchaProvider()).toBe('extension');

        process.env.CAPTCHA_PROVIDER = 'cdp';
        vi.resetModules();
        const overridden = await import('../../src/lib/captchaProvider.js');
        expect(overridden.getCaptchaProvider()).toBe('cdp');
    });

    it('closes the CDP browser best-effort without leaking bridge failures', async () => {
        const provider = await import('../../src/lib/captchaProvider.js');
        bridgeMock.requestJson.mockRejectedValueOnce(new Error('Electron unavailable'));
        await expect(provider.cdpClose()).resolves.toBeUndefined();

        await provider.cdpClose();
        expect(bridgeMock.requestJson).toHaveBeenLastCalledWith('/captcha/close', { method: 'POST' });
    });

    it('derives UA and client hints from the detected host Chrome', () => {
        process.env.VEO3_CHROME_FULL = '155.0.8123.41';
        process.env.VEO3_CHROME_MAJOR = '155';
        __resetForTest({ platform: 'win32' });

        expect(getHostChromeMajor()).toBe(155);
        expect(getHostUa()).toContain('Chrome/155.0.8123.41');
        expect(getHostUa()).toContain('Windows NT 10.0; Win64; x64');
        expect(getHostSecChUaPlatform()).toBe('"Windows"');
        expect(buildSecChUaForMajor(155)).toContain('"Google Chrome";v="155"');
    });
});
