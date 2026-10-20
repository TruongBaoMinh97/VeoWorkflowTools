import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  tryMintCaptchaFromFrames,
  type CaptchaFrameLike,
} from './captchaFrameMint';

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

const FLOW_URL = 'https://flow.google.com/';
const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
const MINT_TIMEOUT_MS = 30_000;
const CHROME_START_TIMEOUT_MS = 20_000;
const HARD_RESET_SETTLE_MS = 2_500;

export type CaptchaResetKind = 'soft_reset' | 'hard_reset';

export type CaptchaBrowserErrorCode =
  | 'NO_FLOW_PAGE'
  | 'CHROME_LAUNCH_FAILED'
  | 'CHROME_NOT_FOUND'
  | 'CHROME_TIMEOUT'
  | 'MINT_TIMEOUT'
  | 'MINT_FAILED';

export interface CaptchaBrowserStatus {
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

const state: CaptchaBrowserStatus = {
  running: false,
  pageUrl: null,
  lastMintAt: null,
  lastMintDurationMs: null,
  lastError: null,
  mintCount: 0,
  failureCount: 0,
};

function captchaProfileDir(): string {
  return path.join(app.getPath('userData'), 'captcha-browser');
}

function log(message: string): void {
  console.log(`[CaptchaBrowser] ${message}`);
  mainLog.info(`[CaptchaBrowser] ${message}`);
}

function chromeArgs(profileDir: string, port: number): string[] {
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
    return flowPage;
  }

  const page = pages.find((candidate) => !candidate.isClosed()) ?? await browser.newPage();
  await page.goto(FLOW_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  flowPage = page;
  return flowPage;
}

export async function ensureCaptchaBrowser(): Promise<CaptchaBrowserStatus> {
  if (shuttingDown) {
    throw new CaptchaBrowserError('App đang thoát', 'CHROME_LAUNCH_FAILED');
  }
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
      executable = resolveChromeExecutable();
    }
    catch (error) {
      throw new CaptchaBrowserError(
        `Không tìm thấy Google Chrome trên máy: ${error instanceof Error ? error.message : String(error)}`,
        'CHROME_NOT_FOUND',
      );
    }

    const profileDir = captchaProfileDir();
    fs.mkdirSync(profileDir, { recursive: true });
    await killOrphanChromeForProfile(profileDir);

    const port = await getRandomFreePort();
    const spawnTimeMs = Date.now();
    let stderrTail = '';
    logChromeSpawn('captcha');
    const child = spawn(executable, chromeArgs(profileDir, port), {
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
    }
    catch (error) {
      try {
        child.kill('SIGTERM');
      }
      catch {
        // Best-effort cleanup.
      }
      chromeProcess = null;
      throw new CaptchaBrowserError(
        `Chrome không mở được cổng gỡ lỗi: ${error instanceof Error ? error.message : String(error)}`,
        'CHROME_TIMEOUT',
      );
    }

    browser = await connect({
      browserURL: `http://127.0.0.1:${port}`,
      defaultViewport: null,
    });
    browser.on('disconnected', () => {
      if (!shuttingDown) {
        log('Chrome đã đóng — provider cdp sẽ mở lại ở lần mint kế tiếp');
        cleanupBrowserRefs();
      }
    });
    await ensureFlowPage();
    state.running = true;
    state.pageUrl = flowPage?.url() ?? null;
    state.lastError = null;
    log(`sẵn sàng (port ${port}, pid ${child.pid ?? 'unknown'})`);
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

async function mintFromFlowFrames(page: PageLike, action: string): Promise<string> {
  const deadline = Date.now() + (MINT_TIMEOUT_MS - 5_000);
  while (Date.now() < deadline) {
    const result = await tryMintCaptchaFromFrames(page.frames(), SITE_KEY, action);
    if (result) {
      log(`mint thành công từ frame ${safeFrameLabel(result.frameUrl)}`);
      return result.token;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('GRECAPTCHA_UNAVAILABLE: Không tìm thấy frame hoặc hàm execute hợp lệ');
}

export async function mintCaptchaToken(action: string): Promise<string> {
  await ensureCaptchaBrowser();
  const page = await ensureFlowPage();
  const startedAt = Date.now();
  try {
    const token = await Promise.race([
      mintFromFlowFrames(page, action),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new CaptchaBrowserError('Mint quá thời gian', 'MINT_TIMEOUT')),
          MINT_TIMEOUT_MS,
        );
      }),
    ]);
    state.lastMintAt = Date.now();
    state.lastMintDurationMs = state.lastMintAt - startedAt;
    state.mintCount += 1;
    state.lastError = null;
    state.pageUrl = page.url();
    return token;
  }
  catch (error) {
    state.failureCount += 1;
    state.lastError = error instanceof Error ? error.message : String(error);
    if (error instanceof CaptchaBrowserError) {
      throw error;
    }
    throw new CaptchaBrowserError(state.lastError, 'MINT_FAILED');
  }
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
  await page
    .goto(FLOW_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    .catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, HARD_RESET_SETTLE_MS));
  state.pageUrl = page.url();
  log('hard reset xong');
}

export function getCaptchaBrowserStatus(): CaptchaBrowserStatus {
  return {
    ...state,
    running: Boolean(browser?.connected && flowPage && !flowPage.isClosed()),
    pageUrl: flowPage && !flowPage.isClosed() ? flowPage.url() : null,
  };
}

export async function closeCaptchaBrowser(): Promise<void> {
  shuttingDown = true;
  cleanupBrowserRefs();
  if (chromeProcess && !chromeProcess.killed) {
    try {
      chromeProcess.kill('SIGTERM');
    }
    catch {
      // Best-effort cleanup.
    }
  }
  chromeProcess = null;
  shuttingDown = false;
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
