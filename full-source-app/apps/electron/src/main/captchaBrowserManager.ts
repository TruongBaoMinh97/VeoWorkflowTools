import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  tryMintCaptchaFromFrames,
  type CaptchaFrameLike,
} from './captchaFrameMint';
import { ensureFlowEnterpriseScript } from './captchaEnterpriseLoader';
import { readCaptchaEngine, writeCaptchaEngine, type CaptchaEngine } from './captchaEngineStore';
import { describeCloakExitCode, findCloakBrowserExecutable, hasCloakLicense } from './cloakBrowserPath';

interface CdpSessionLike {
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
}

interface PageLike {
  isClosed(): boolean;
  url(): string;
  goto(url: string, options: Record<string, unknown>): Promise<unknown>;
  frames(): CaptchaFrameLike[];
  evaluate<T>(pageFunction: (...args: any[]) => T | Promise<T>, ...args: any[]): Promise<T>;
  evaluateOnNewDocument(pageFunction: string | ((...args: any[]) => any), ...args: any[]): Promise<unknown>;
  createCDPSession(): Promise<CdpSessionLike>;
  removeAllListeners(): void;
}

interface BrowserLike {
  readonly connected: boolean;
  pages(): Promise<PageLike[]>;
  newPage(): Promise<PageLike>;
  on(event: 'disconnected', listener: () => void): void;
  removeAllListeners(): void;
  disconnect(): void;
}

const { connect } = require('puppeteer-core') as {
  connect(options: { browserURL: string; defaultViewport: null }): Promise<BrowserLike>;
};

const { app } = require('electron') as {
  app: { getPath(name: 'userData'): string };
};
const { resolveChromeExecutable } = require('./chromePath') as {
  resolveChromeExecutable(): string;
};
const {
  killOrphanChromeForProfile,
  getRandomFreePort,
  waitForDebugPort,
  logChromeSpawn,
} = require('./systemBrowserLogin') as {
  killOrphanChromeForProfile(profileDir: string): Promise<void>;
  getRandomFreePort(): Promise<number>;
  waitForDebugPort(
    port: number,
    options: {
      child: ChildProcess;
      spawnTimeMs: number;
      timeoutMs: number;
      getStderrTail: () => string;
    },
  ): Promise<void>;
  logChromeSpawn(reason: string): void;
};
const { mainLog } = require('./mainLogger') as {
  mainLog: { info(...args: unknown[]): void };
};
const { globalProxyClient } = require('./globalProxyClient') as {
  globalProxyClient: {
    poll(): Promise<void>;
    getSocks5Rule(): string | null;
  };
};

const FLOW_URL = 'https://flow.google.com/';
const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
const MINT_TIMEOUT_MS = 30_000;
const CHROME_START_TIMEOUT_MS = 20_000;
const HARD_RESET_SETTLE_MS = 2_500;
const MAX_QUEUED_MINTS = 6;
const HARD_RESET_AFTER_MINTS = (() => {
  const configured = Number(process.env.CAPTCHA_HARD_ROTATE_EVERY);
  return Number.isInteger(configured) && configured >= 0 ? configured : 12;
})();

export type CaptchaResetKind = 'soft_reset' | 'hard_reset';

export type CaptchaBrowserErrorCode =
  | 'NO_FLOW_PAGE'
  | 'CHROME_LAUNCH_FAILED'
  | 'CHROME_NOT_FOUND'
  | 'CHROME_TIMEOUT'
  | 'MINT_TIMEOUT'
  | 'MINT_FAILED';

export interface CaptchaBrowserStatus {
  engine: CaptchaEngine;
  running: boolean;
  pageUrl: string | null;
  lastMintAt: number | null;
  lastMintDurationMs: number | null;
  lastError: string | null;
  mintCount: number;
  failureCount: number;
}

export class CaptchaBrowserError extends Error {
  constructor(
    message: string,
    public readonly code: CaptchaBrowserErrorCode,
  ) {
    super(message);
    this.name = 'CaptchaBrowserError';
  }
}

let browser: BrowserLike | null = null;
let flowPage: PageLike | null = null;
let chromeProcess: ChildProcess | null = null;
let launchPromise: Promise<void> | null = null;
let shuttingDown = false;
let mintChain: Promise<void> = Promise.resolve();
let queuedMints = 0;
let consecutiveMintTimeouts = 0;
let mintsSinceReset = 0;
let resetBeforeNextMint = false;
let proxyRuleAtLaunch: string | null = null;
let engineAtLaunch: CaptchaEngine | null = null;

const state: CaptchaBrowserStatus = {
  engine: 'chrome',
  running: false,
  pageUrl: null,
  lastMintAt: null,
  lastMintDurationMs: null,
  lastError: null,
  mintCount: 0,
  failureCount: 0,
};

function selectedEngine(): CaptchaEngine {
  const available = findCloakBrowserExecutable() && hasCloakLicense();
  return readCaptchaEngine(app.getPath('userData'), available ? 'cloak' : 'chrome');
}

function captchaProfileDir(engine: CaptchaEngine): string {
  return path.join(app.getPath('userData'), engine === 'cloak' ? 'captcha-browser-cloak' : 'captcha-browser');
}

function log(message: string): void {
  console.log(`[CaptchaBrowser] ${message}`);
  mainLog.info(`[CaptchaBrowser] ${message}`);
}

function chromeArgs(profileDir: string, port: number, proxyRule: string | null): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--disable-background-mode',
    '--window-size=1100,800',
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    ...(proxyRule ? [`--proxy-server=${proxyRule}`, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] : []),
    FLOW_URL,
  ];
}

function cleanupBrowserRefs(): void {
  if (flowPage) {
    flowPage.removeAllListeners();
    flowPage = null;
  }
  if (browser) {
    browser.removeAllListeners();
    try {
      browser.disconnect();
    }
    catch {
      // Already disconnected.
    }
    browser = null;
  }
  state.running = false;
  state.pageUrl = null;
  proxyRuleAtLaunch = null;
  engineAtLaunch = null;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function stopBrowserProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGTERM'); } catch { /* Already exited. */ }
  if (await waitForChildExit(child, 5_000)) return;
  try { child.kill('SIGKILL'); } catch { /* Best-effort cleanup. */ }
  await waitForChildExit(child, 2_000);
}

async function injectAntiHijackDefense(page: PageLike): Promise<void> {
  await page.evaluateOnNewDocument(`
    (() => {
      let realExecute = null;

      const origDefineProperty = Object.defineProperty;
      Object.defineProperty = function(obj, prop, descriptor) {
        if (prop === 'execute' && obj && typeof obj === 'object') {
          if (descriptor && descriptor.value && typeof descriptor.value === 'function') {
            const fnString = descriptor.value.toString();
            if (fnString.includes('extension_hijack_detected') || fnString.includes('a.ha')) {
              console.warn('🛡️ [Anti-Hijack Defense] Đã chặn đứng thành công honeypot của Google Flow!');
              return obj;
            }
          }
        }
        return origDefineProperty.call(this, obj, prop, descriptor);
      };

      const captureRealExecute = (grecaptchaObj) => {
        if (
          grecaptchaObj &&
          grecaptchaObj.enterprise &&
          typeof grecaptchaObj.enterprise.execute === 'function'
        ) {
          if (!realExecute) {
            realExecute = grecaptchaObj.enterprise.execute.bind(grecaptchaObj.enterprise);

            globalThis.__realExecute = async (siteKey, options) => {
              if (!realExecute) {
                throw new Error('ORIGINAL_EXECUTE_NOT_FOUND');
              }
              return await realExecute(siteKey, options);
            };
            console.log('🛡️ [Anti-Hijack] Đã nắm giữ thành công globalThis.__realExecute gốc!');
          }
        }
      };

      let cachedGrecaptcha = globalThis.grecaptcha;
      Object.defineProperty(globalThis, 'grecaptcha', {
        get() { return cachedGrecaptcha; },
        set(val) {
          cachedGrecaptcha = val;
          captureRealExecute(val);

          if (val && !val.enterprise) {
            let cachedEnterprise = val.enterprise;
            Object.defineProperty(val, 'enterprise', {
              get() { return cachedEnterprise; },
              set(entVal) {
                cachedEnterprise = entVal;
                captureRealExecute(val);
              },
              configurable: true,
              enumerable: true
            });
          }
        },
        configurable: true,
        enumerable: true
      });
    })();
  `);
}

async function ensureFlowPage(): Promise<PageLike> {
  if (!browser) {
    throw new CaptchaBrowserError('Chrome chưa sẵn sàng', 'NO_FLOW_PAGE');
  }
  if (flowPage && !flowPage.isClosed() && flowPage.url().startsWith(FLOW_URL)) {
    return flowPage;
  }

  const pages = await browser.pages();
  const existing = pages.find(
    (page) => !page.isClosed() && page.url().startsWith(FLOW_URL),
  );
  if (existing) {
    flowPage = existing;
    await injectAntiHijackDefense(flowPage);
    return flowPage;
  }

  const page = pages.find((candidate) => !candidate.isClosed()) ?? await browser.newPage();
  await injectAntiHijackDefense(page);
  await page.goto(FLOW_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  flowPage = page;
  return flowPage;
}

export async function ensureCaptchaBrowser(): Promise<CaptchaBrowserStatus> {
  if (shuttingDown) {
    throw new CaptchaBrowserError('App đang thoát', 'CHROME_LAUNCH_FAILED');
  }
  await globalProxyClient.poll();
  const proxyRule = globalProxyClient.getSocks5Rule();
  const engine = selectedEngine();
  if (browser?.connected && (proxyRuleAtLaunch !== proxyRule || engineAtLaunch !== engine))
    await closeCaptchaBrowser();
  if (browser?.connected && flowPage && !flowPage.isClosed()) {
    return getCaptchaBrowserStatus();
  }
  if (launchPromise) {
    await launchPromise;
    return getCaptchaBrowserStatus();
  }

  launchPromise = (async () => {
    cleanupBrowserRefs();
    let executable: string;
    try {
      if (engine === 'cloak') {
        executable = findCloakBrowserExecutable() ?? '';
        if (!executable) throw new Error('Chạy `cloakbrowser install` để cài trình duyệt.');
        if (!hasCloakLicense()) throw new Error('Chạy `cloakbrowser login` để đăng nhập khóa miễn phí.');
      }
      else executable = resolveChromeExecutable();
    }
    catch (error) {
      throw new CaptchaBrowserError(
        `Không dùng được ${engine === 'cloak' ? 'CloakBrowser' : 'Google Chrome'}: ${error instanceof Error ? error.message : String(error)}`,
        'CHROME_NOT_FOUND',
      );
    }

    const profileDir = captchaProfileDir(engine);
    fs.mkdirSync(profileDir, { recursive: true });
    await killOrphanChromeForProfile(profileDir);

    let port = 0;
    let child: ChildProcess | null = null;
    for (let attempt = 1; attempt <= (engine === 'cloak' ? 3 : 1); attempt += 1) {
      port = await getRandomFreePort();
      const spawnTimeMs = Date.now();
      let stderrTail = '';
      logChromeSpawn(`captcha-${engine}`);
      child = spawn(executable, chromeArgs(profileDir, port, proxyRule), {
        detached: false,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2_000);
      });
      chromeProcess = child;
      try {
        await waitForDebugPort(port, {
          child,
          spawnTimeMs,
          timeoutMs: CHROME_START_TIMEOUT_MS,
          getStderrTail: () => stderrTail,
        });
        break;
      }
      catch (error) {
        const exitCode = (error as { exitCode?: number | null }).exitCode ?? child.exitCode;
        await stopBrowserProcess(child);
        chromeProcess = null;
        if (engine === 'cloak' && exitCode === 76 && attempt < 3) {
          log('CloakBrowser đang hết chỗ trong gói miễn phí; thử lại sau 8 giây');
          await new Promise((resolve) => setTimeout(resolve, 8_000));
          continue;
        }
        throw new CaptchaBrowserError(
          (engine === 'cloak' && describeCloakExitCode(exitCode)) ||
            `${engine === 'cloak' ? 'CloakBrowser' : 'Chrome'} không mở được cổng gỡ lỗi: ${error instanceof Error ? error.message : String(error)}`,
          'CHROME_TIMEOUT',
        );
      }
    }
    if (!child) throw new CaptchaBrowserError('Không mở được trình duyệt CAPTCHA', 'CHROME_LAUNCH_FAILED');

    browser = await connect({
      browserURL: `http://127.0.0.1:${port}`,
      defaultViewport: null,
    });
    browser.on('disconnected', () => {
      if (!shuttingDown) {
        log(`${engine === 'cloak' ? 'CloakBrowser' : 'Chrome'} đã đóng — provider cdp sẽ mở lại ở lần mint kế tiếp`);
        cleanupBrowserRefs();
      }
    });
    await ensureFlowPage();
    proxyRuleAtLaunch = proxyRule;
    engineAtLaunch = engine;
    state.engine = engine;
    state.running = true;
    state.pageUrl = flowPage?.url() ?? null;
    state.lastError = null;
    log(`${engine} sẵn sàng (port ${port}, pid ${child.pid ?? 'unknown'})`);
  })();

  try {
    await launchPromise;
  }
  finally {
    launchPromise = null;
  }
  return getCaptchaBrowserStatus();
}

function safeFrameLabel(frameUrl: string): string {
  try {
    const parsed = new URL(frameUrl);
    return `${parsed.origin}${parsed.pathname}`;
  }
  catch {
    return 'unknown-frame';
  }
}

async function mintFromFlowFrames(page: PageLike, action: string, cancelled: () => boolean): Promise<string> {
  const deadline = Date.now() + (MINT_TIMEOUT_MS - 5_000);
  let loaderStatus = 'not-needed';
  while (Date.now() < deadline && !cancelled()) {
    try {
      const result = await tryMintCaptchaFromFrames(page.frames(), SITE_KEY, action);
      if (result) {
        log(`mint thành công từ frame ${safeFrameLabel(result.frameUrl)}`);
        return result.token;
      }
      if (loaderStatus === 'not-needed') {
        loaderStatus = await ensureFlowEnterpriseScript(page, SITE_KEY);
        if (loaderStatus === 'wrong-origin') {
          throw new CaptchaBrowserError(
            `Trang CAPTCHA đã rời Flow (${safeFrameLabel(page.url())}); cần mở lại Flow và đăng nhập`,
            'NO_FLOW_PAGE',
          );
        }
        if (loaderStatus === 'script-error') {
          throw new CaptchaBrowserError('Không tải được reCAPTCHA Enterprise trên trang Flow', 'MINT_FAILED');
        }
        log(`reCAPTCHA Enterprise ${loaderStatus} trên ${safeFrameLabel(page.url())}`);
      }
    }
    catch (error) {
      if (error instanceof CaptchaBrowserError)
        throw error;
      // Bỏ qua lỗi context/frame tạm thời để tiếp tục thử lại ở chu kỳ kế tiếp
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const diagnostic = await page.evaluate(() => ({
    origin: location.origin,
    path: location.pathname,
    sdk: document.querySelector<HTMLScriptElement>('script[data-veo-recaptcha-loader]')?.dataset.veoRecaptchaLoader ?? 'missing',
    execute: typeof (window as any).grecaptcha?.enterprise?.execute === 'function',
  })).catch(() => ({ origin: 'unknown', path: '', sdk: 'unknown', execute: false }));
  let frameCount = 0;
  try { frameCount = page.frames().length; } catch { /* Page may have closed. */ }
  throw new Error(`GRECAPTCHA_UNAVAILABLE: Không tìm thấy frame hoặc hàm execute hợp lệ sau khi timeout (page=${diagnostic.origin}${diagnostic.path}, sdk=${diagnostic.sdk}, execute=${diagnostic.execute}, frames=${frameCount})`);
}

async function mintCaptchaTokenSerial(action: string): Promise<string> {
  await ensureCaptchaBrowser();
  if (resetBeforeNextMint) {
    await resetCaptchaBrowser('hard_reset');
  }
  const page = await ensureFlowPage();
  const startedAt = Date.now();
  let cancelled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const token = await Promise.race([
      mintFromFlowFrames(page, action, () => cancelled),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new CaptchaBrowserError('Mint quá thời gian', 'MINT_TIMEOUT')),
          MINT_TIMEOUT_MS,
        );
      }),
    ]);
    consecutiveMintTimeouts = 0;
    mintsSinceReset += 1;
    if (HARD_RESET_AFTER_MINTS > 0 && mintsSinceReset >= HARD_RESET_AFTER_MINTS)
      resetBeforeNextMint = true;
    state.lastMintAt = Date.now();
    state.lastMintDurationMs = state.lastMintAt - startedAt;
    state.mintCount += 1;
    state.lastError = null;
    state.pageUrl = page.url();
    return token;
  }
  catch (error) {
    cancelled = true;
    state.failureCount += 1;
    state.lastError = error instanceof Error ? error.message : String(error);
    if ((error instanceof CaptchaBrowserError && error.code === 'MINT_TIMEOUT') ||
        state.lastError.startsWith('GRECAPTCHA_UNAVAILABLE')) {
      consecutiveMintTimeouts += 1;
      if (consecutiveMintTimeouts >= 2) {
        consecutiveMintTimeouts = 0;
        resetBeforeNextMint = true;
      }
    }
    if (error instanceof CaptchaBrowserError) {
      throw error;
    }
    throw new CaptchaBrowserError(state.lastError, 'MINT_FAILED');
  }
  finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function mintCaptchaToken(action: string): Promise<string> {
  if (queuedMints >= MAX_QUEUED_MINTS)
    return Promise.reject(new CaptchaBrowserError('Hàng chờ mint đầy — captcha browser đang bận', 'MINT_FAILED'));
  queuedMints += 1;
  const result = mintChain.then(() => mintCaptchaTokenSerial(action), () => mintCaptchaTokenSerial(action));
  mintChain = result.then(() => undefined, () => undefined);
  return result.finally(() => { queuedMints -= 1; });
}

async function clearCaptchaCookies(page: PageLike): Promise<void> {
  const session = await page.createCDPSession();
  try {
    for (const origin of [
      'https://www.google.com',
      'https://www.recaptcha.net',
      'https://flow.google.com',
    ]) {
      await session
        .send('Storage.clearDataForOrigin', { origin, storageTypes: 'cookies' })
        .catch(() => undefined);
    }
  }
  finally {
    await session.detach().catch(() => undefined);
  }
}

export async function resetCaptchaBrowser(kind: CaptchaResetKind): Promise<void> {
  await ensureCaptchaBrowser();
  const page = await ensureFlowPage();
  if (kind === 'soft_reset') {
    await page
      .evaluate(() => {
        Object.keys(localStorage)
          .filter((key) => key.startsWith('_grecaptcha'))
          .forEach((key) => localStorage.removeItem(key));
      })
      .catch(() => undefined);
    await clearCaptchaCookies(page);
    log('soft reset xong');
    return;
  }

  await clearCaptchaCookies(page);
  await page.goto('about:blank', { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await page.goto(FLOW_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, HARD_RESET_SETTLE_MS));
  mintsSinceReset = 0;
  resetBeforeNextMint = false;
  state.pageUrl = page.url();
  log('hard reset xong');
}

export function getCaptchaBrowserStatus(): CaptchaBrowserStatus {
  return {
    ...state,
    engine: engineAtLaunch ?? selectedEngine(),
    running: Boolean(browser?.connected && flowPage && !flowPage.isClosed()),
    pageUrl: flowPage && !flowPage.isClosed() ? flowPage.url() : null,
  };
}

export function getCaptchaEngineInfo(): { engine: CaptchaEngine; cloakAvailable: boolean; licensePresent: boolean } {
  return {
    engine: selectedEngine(),
    cloakAvailable: findCloakBrowserExecutable() !== null,
    licensePresent: hasCloakLicense(),
  };
}

export async function setCaptchaEngine(engine: CaptchaEngine): Promise<ReturnType<typeof getCaptchaEngineInfo>> {
  if (engine !== 'chrome' && engine !== 'cloak') throw new Error('CAPTCHA engine không hợp lệ');
  if (engine === 'cloak' && (!findCloakBrowserExecutable() || !hasCloakLicense()))
    throw new Error('CloakBrowser chưa được cài hoặc chưa đăng nhập khóa.');
  if (process.env.VEO_CAPTCHA_ENGINE) throw new Error('Gỡ VEO_CAPTCHA_ENGINE trước khi đổi engine trong ứng dụng.');
  if (launchPromise) await launchPromise.catch(() => undefined);
  if (selectedEngine() !== engine) {
    writeCaptchaEngine(app.getPath('userData'), engine);
    await closeCaptchaBrowser();
  }
  return getCaptchaEngineInfo();
}

export async function closeCaptchaBrowser(): Promise<void> {
  shuttingDown = true;
  cleanupBrowserRefs();
  const child = chromeProcess;
  chromeProcess = null;
  try { if (child) await stopBrowserProcess(child); }
  finally { shuttingDown = false; }
}

export function shutdownCaptchaBrowser(): void {
  shuttingDown = true;
  if (chromeProcess && !chromeProcess.killed) {
    try {
      chromeProcess.kill('SIGTERM');
    }
    catch {
      // Best-effort cleanup.
    }
  }
  cleanupBrowserRefs();
  chromeProcess = null;
}
