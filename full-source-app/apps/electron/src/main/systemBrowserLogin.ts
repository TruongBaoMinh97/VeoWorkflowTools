import * as crypto from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expires?: number;
}

interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  detach(): Promise<void>;
}

interface PageLike {
  isClosed(): boolean;
  url(): string;
  goto(url: string, options: Record<string, unknown>): Promise<unknown>;
  cookies(...urls: string[]): Promise<BrowserCookie[]>;
  evaluate<T>(pageFunction: () => T | Promise<T>): Promise<T>;
  createCDPSession(): Promise<CdpSessionLike>;
}

interface BrowserLike {
  readonly connected: boolean;
  pages(): Promise<PageLike[]>;
  newPage(): Promise<PageLike>;
  targets(): Array<{ type(): string; createCDPSession(): Promise<CdpSessionLike> }>;
  on(event: 'disconnected', listener: () => void): void;
  off(event: 'disconnected', listener: () => void): void;
  disconnect(): void;
}

interface LoginResult {
  success: boolean;
  cookies: BrowserCookie[];
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  chromeProc?: ChildProcess;
  diagnostics?: Record<string, unknown>;
}

interface ActiveChrome {
  proc: ChildProcess;
  browser: BrowserLike | null;
  pollHandle: NodeJS.Timeout | null;
}

const { connect } = require('puppeteer-core') as {
  connect(options: { browserURL: string; defaultViewport: null }): Promise<BrowserLike>;
};
const { app, BrowserWindow, session } = require('electron') as any;
const { mainLog } = require('./mainLogger') as {
  mainLog: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
};

const execFileAsync = promisify(execFile);
const FLOW_URL = 'https://flow.google.com/';
const GOOGLE_LOGIN_URL = 'https://accounts.google.com/';
const AUTH_COOKIE_NAMES = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID'];
const SECURE_AUTH_COOKIE_NAMES = ['__Secure-1PSID', '__Secure-3PSID'];
const SETTLED_COOKIE_NAMES = ['__Secure-1PSIDTS', '__Secure-1PSIDCC', 'SIDCC'];
const SINGLETON_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

const cookieHashes = new Map<string, string>();
const launchedProfileChromes = new Map<string, ChildProcess>();
const activeProfileChromes = new Map<string, ActiveChrome>();
const loginProcesses = new Map<string, ChildProcess>();
const loginInProgress = new Set<string>();

export class ChromeDedupError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly elapsedMs: number;
  readonly port: number;
  readonly stderrTail?: string;

  constructor(options: {
    port: number;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    elapsedMs: number;
    stderrTail?: string;
  }) {
    super(
      `Chrome process exited before debug port ${options.port} opened ` +
      `(exitCode=${options.exitCode} signal=${options.signal ?? 'none'} ` +
      `elapsed=${options.elapsedMs}ms platform=${process.platform})`,
    );
    this.name = 'ChromeDedupError';
    this.port = options.port;
    this.exitCode = options.exitCode;
    this.signal = options.signal;
    this.elapsedMs = options.elapsedMs;
    this.stderrTail = options.stderrTail;
  }
}

export function logChromeSpawn(reason: string): void {
  if (process.platform === 'win32')
    mainLog.info(`[FocusDiag] chrome-spawn    reason=${reason}`);
}

export function getRandomFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate free port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function probePort(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('tcp probe timeout'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

export async function waitForDebugPort(
  port: number,
  options: {
    child?: ChildProcess;
    spawnTimeMs?: number;
    timeoutMs?: number;
    getStderrTail?: () => string;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const spawnTimeMs = options.spawnTimeMs ?? Date.now();
  let exited = false;
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) => {
    exited = true;
    exitCode = code;
    signal = exitSignal;
  };
  options.child?.once('exit', onExit);

  const throwExited = () => {
    throw new ChromeDedupError({
      port,
      exitCode,
      signal,
      elapsedMs: Date.now() - spawnTimeMs,
      stderrTail: options.getStderrTail?.(),
    });
  };

  try {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (exited || options.child?.killed || (options.child && options.child.exitCode !== null))
        throwExited();
      try {
        await probePort(port, 500);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 500);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: controller.signal,
          });
          if (response.ok)
            return;
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        lastError = error;
      }
      await delay(200);
    }
    if (exited || options.child?.killed || (options.child && options.child.exitCode !== null))
      throwExited();
    const suffix = lastError instanceof Error ? ` (last error: ${lastError.message})` : '';
    throw new Error(`Chrome debug port ${port} not ready after ${timeoutMs}ms${suffix}`);
  } finally {
    options.child?.removeListener('exit', onExit);
  }
}

function clearSingletonFiles(profileDir: string): void {
  for (const fileName of SINGLETON_FILES) {
    try {
      fs.unlinkSync(path.join(profileDir, fileName));
    } catch {
      // File is absent or still owned by a live Chrome process.
    }
  }
}

async function killWindowsProfileChrome(profileDir: string): Promise<boolean> {
  const escaped = profileDir.replace(/'/g, "''");
  const script = "$ErrorActionPreference = 'SilentlyContinue'; " +
    `Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ` +
    `Where-Object { $_.CommandLine -like '*${escaped}*' } | ` +
    'ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; ' +
    'Write-Output $_.ProcessId } catch {} }';
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true },
    );
    const killed = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (killed.length > 0)
      mainLog.info(`[SystemLogin] Killed stale Chrome PIDs: ${killed.join(', ')}`);
    await delay(1_000);
    clearSingletonFiles(profileDir);
    return killed.length > 0;
  } catch (error) {
    mainLog.warn(`[SystemLogin] Could not inspect stale Chrome: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function killUnixProfileChrome(profileDir: string): Promise<boolean> {
  const lockPath = path.join(profileDir, 'SingletonLock');
  let target: string;
  try {
    if (!fs.lstatSync(lockPath).isSymbolicLink())
      return false;
    target = fs.readlinkSync(lockPath);
  } catch {
    return false;
  }
  const match = target.match(/-(\d+)$/);
  if (!match)
    return false;
  const pid = Number.parseInt(match[1], 10);
  try {
    process.kill(pid, 0);
  } catch {
    clearSingletonFiles(profileDir);
    return false;
  }
  try {
    process.kill(pid, 'SIGTERM');
    await delay(500);
    clearSingletonFiles(profileDir);
    return true;
  } catch {
    return false;
  }
}

export async function killOrphanChromeForProfile(profileDir: string): Promise<boolean> {
  return process.platform === 'win32'
    ? killWindowsProfileChrome(profileDir)
    : killUnixProfileChrome(profileDir);
}

export function findChromePath(): string | null {
  const candidates: string[] = [];
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    );
  } else if (process.platform === 'win32') {
    const programFiles = process.env.PROGRAMFILES ?? 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA ?? '';
    candidates.push(
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    );
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate))
        return candidate;
    } catch {
      // Continue scanning standard locations.
    }
  }
  return null;
}

function hasGoogleAuthCookies(cookies: BrowserCookie[]): boolean {
  const names = new Set(cookies.map((cookie) => cookie.name));
  const normalCount = AUTH_COOKIE_NAMES.filter((name) => names.has(name)).length;
  return normalCount >= 3 && SECURE_AUTH_COOKIE_NAMES.some((name) => names.has(name));
}

function hasSettledCookie(cookies: BrowserCookie[]): boolean {
  const names = new Set(cookies.map((cookie) => cookie.name));
  return SETTLED_COOKIE_NAMES.some((name) => names.has(name));
}

async function waitForGoogleLogin(browser: BrowserLike, page: PageLike): Promise<boolean> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let finished = false;
    const onDisconnected = () => {
      if (finished)
        return;
      finished = true;
      resolve(false);
    };
    browser.on('disconnected', onDisconnected);
    const timer = setInterval(async () => {
      if (finished) {
        clearInterval(timer);
        return;
      }
      if (Date.now() - startedAt > 5 * 60_000 || page.isClosed()) {
        finished = true;
        clearInterval(timer);
        browser.off('disconnected', onDisconnected);
        resolve(false);
        return;
      }
      try {
        const cookies = await page.cookies(
          'https://accounts.google.com',
          'https://www.google.com',
          'https://google.com',
        );
        if (!hasGoogleAuthCookies(cookies))
          return;
        finished = true;
        clearInterval(timer);
        browser.off('disconnected', onDisconnected);
        try {
          await page.goto('https://myaccount.google.com/', {
            waitUntil: 'networkidle2',
            timeout: 20_000,
          });
        } catch (error) {
          mainLog.warn(`[SystemLogin] myaccount warmup failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const settleDeadline = Date.now() + 8_000;
        while (Date.now() < settleDeadline) {
          try {
            const settled = await page.cookies(
              'https://accounts.google.com',
              'https://www.google.com',
              'https://google.com',
              'https://myaccount.google.com',
            );
            if (hasSettledCookie(settled))
              break;
          } catch {
            // Retry until the short settle deadline.
          }
          await delay(500);
        }
        resolve(true);
      } catch {
        // The login page may be navigating; retry on the next poll.
      }
    }, 2_000);
  });
}

async function readAllCookies(page: PageLike, cdpRef: { current: CdpSessionLike | null }): Promise<BrowserCookie[]> {
  if (!cdpRef.current)
    cdpRef.current = await page.createCDPSession();
  const result = await cdpRef.current.send('Network.getAllCookies');
  return result.cookies as BrowserCookie[];
}

async function flowShowsSignedIn(page: PageLike): Promise<boolean> {
  return page.evaluate(() => Boolean((window as any).WIZ_global_data?.oPEP7c));
}

function createChromeArgs(profileDir: string, debugPort: number, targetUrl: string): string[] {
  const args = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--disable-background-mode',
    '--window-size=1280,900',
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    targetUrl,
  ];
  try {
    const { globalProxyClient } = require('./globalProxyClient') as {
      globalProxyClient: { getSocks5Rule(): string | null };
    };
    const proxy = globalProxyClient.getSocks5Rule();
    if (proxy)
      args.push(`--proxy-server=${proxy}`);
  } catch {
    // Global proxy is optional.
  }
  return args;
}

function mapLaunchError(error: unknown): string {
  if (error instanceof ChromeDedupError)
    return error.exitCode !== 0 ? 'CHROME_LAUNCH_FAILED' : 'CHROME_DEDUP';
  if (error && typeof error === 'object') {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT')
      return 'CHROME_NOT_FOUND';
    if (code === 'EPERM' || code === 'EACCES')
      return 'CHROME_BLOCKED';
    if (/not ready after/i.test((error as { message?: string }).message ?? ''))
      return 'CHROME_TIMEOUT';
  }
  return 'CHROME_LAUNCH_FAILED';
}

async function syncCookiesForProfile(profileId: string, browser: BrowserLike): Promise<void> {
  const target = browser.targets().find((item) => item.type() === 'page');
  if (!target)
    return;
  const cdp = await target.createCDPSession();
  try {
    const result = await cdp.send('Network.getAllCookies');
    const cookies = result.cookies as BrowserCookie[];
    const digest = crypto.createHash('sha256')
      .update(cookies.map((cookie) => `${cookie.name}|${cookie.value}|${cookie.domain}`).join('\n'))
      .digest('hex');
    if (cookieHashes.get(profileId) === digest)
      return;
    cookieHashes.set(profileId, digest);
    await importCookiesIntoPartition(profileId, cookies);
  } finally {
    try {
      await cdp.detach();
    } catch {
      // CDP may already be disconnected.
    }
  }
}

export async function loginWithSystemBrowser(
  profileId: string,
  reason = 'login',
  profileType = 'flow',
): Promise<LoginResult> {
  const chromePath = findChromePath();
  if (!chromePath) {
    return {
      success: false,
      cookies: [],
      error: 'Chrome/Chromium not found. Please install Google Chrome.',
      errorCode: 'CHROME_NOT_FOUND',
      retryable: false,
    };
  }
  if (isProfileChromeOpen(profileId) || loginInProgress.has(profileId)) {
    return {
      success: false,
      cookies: [],
      error: 'A Chrome session for this profile is already in progress',
      errorCode: 'CHROME_BUSY',
      retryable: true,
    };
  }

  const profileDir = path.join(app.getPath('userData'), 'chrome-profiles', profileId);
  fs.mkdirSync(profileDir, { recursive: true });
  loginInProgress.add(profileId);

  let chromeProc: ChildProcess | null = null;
  let browser: BrowserLike | null = null;
  try {
    await killOrphanChromeForProfile(profileDir);
    const port = await getRandomFreePort();
    const args = createChromeArgs(profileDir, port, GOOGLE_LOGIN_URL);
    logChromeSpawn(reason);
    const spawnTimeMs = Date.now();
    chromeProc = spawn(chromePath, args, { detached: false, stdio: ['ignore', 'ignore', 'pipe'] });
    loginProcesses.set(profileId, chromeProc);
    await waitForDebugPort(port, { child: chromeProc, spawnTimeMs, timeoutMs: 15_000 });
    browser = await connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
    const pages = await browser.pages();
    const page = pages[0] ?? await browser.newPage();

    mainLog.info(`[SystemLogin] Waiting for Google login for ${profileId.substring(0, 8)}`);
    if (!await waitForGoogleLogin(browser, page)) {
      return {
        success: false,
        cookies: [],
        error: 'Login was cancelled or timed out (5 minutes)',
        errorCode: 'FLOW_SIGNED_OUT',
        retryable: true,
        chromeProc,
      };
    }

    const cdpRef: { current: CdpSessionLike | null } = { current: null };
    let signedIn = profileType === 'vids';
    if (profileType === 'vids') {
      await page.goto('https://workspace.google.com/intl/vi/products/vids/', {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      }).catch(() => undefined);
    } else {
      for (let attempt = 1; attempt <= 3 && !signedIn; attempt += 1) {
        mainLog.info(`[SystemLogin] Verifying Flow sign-in (attempt ${attempt}/3)`);
        try {
          await page.goto(FLOW_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 45_000 + 15_000 * (attempt - 1),
          });
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline && !signedIn) {
            signedIn = await flowShowsSignedIn(page).catch(() => false);
            if (!signedIn)
              await delay(1_000);
          }
        } catch (error) {
          mainLog.warn(`[SystemLogin] Flow check failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    const cookies = await readAllCookies(page, cdpRef).catch(() => []);
    const pollHandle = setInterval(() => {
      if (browser)
        syncCookiesForProfile(profileId, browser).catch(() => undefined);
    }, 5_000);
    activeProfileChromes.set(profileId, { proc: chromeProc, browser, pollHandle });
    browser.on('disconnected', () => {
      clearInterval(pollHandle);
      const active = activeProfileChromes.get(profileId);
      if (!active || active.proc === chromeProc)
        activeProfileChromes.delete(profileId);
      cookieHashes.delete(profileId);
      notifyRenderer('profile:browser-closed', { profileId });
      notifyRenderer('profile:cookies-synced', { profileId });
    });

    if (!signedIn) {
      return {
        success: false,
        cookies,
        error: 'flow.google.com shows no signed-in account after 3 attempts',
        errorCode: 'FLOW_SIGNED_OUT',
        retryable: true,
        chromeProc,
      };
    }

    return { success: true, cookies, chromeProc };
  } catch (error) {
    const errorCode = mapLaunchError(error);
    if (browser) {
      try {
        browser.disconnect();
      } catch {
        // Already disconnected.
      }
    } else if (chromeProc && !chromeProc.killed) {
      try {
        chromeProc.kill('SIGTERM');
      } catch {
        // Process already exited.
      }
    }
    return {
      success: false,
      cookies: [],
      error: error instanceof Error ? error.message : String(error),
      errorCode,
      retryable: ['CHROME_DEDUP', 'CHROME_TIMEOUT', 'FLOW_SIGNED_OUT'].includes(errorCode),
      chromeProc: chromeProc ?? undefined,
    };
  } finally {
    loginInProgress.delete(profileId);
    if (chromeProc && loginProcesses.get(profileId) === chromeProc)
      loginProcesses.delete(profileId);
  }
}

function cookieUrl(cookie: BrowserCookie): string {
  const protocol = cookie.secure ? 'https' : 'http';
  const domain = cookie.domain.replace(/^\./, '');
  return `${protocol}://${domain}${cookie.path ?? '/'}`;
}

function normalizeSameSite(value?: string): string {
  switch (value?.toLowerCase()) {
    case 'strict': return 'strict';
    case 'lax': return 'lax';
    case 'none': return 'no_restriction';
    default: return 'unspecified';
  }
}

export async function importCookiesIntoPartition(
  profileId: string,
  cookies: BrowserCookie[],
): Promise<{ imported: number; failed: number }> {
  const partition = `persist:profile-${profileId}`;
  const profileSession = session.fromPartition(partition);
  let imported = 0;
  let failed = 0;
  for (const cookie of cookies) {
    try {
      const details: Record<string, unknown> = {
        url: cookieUrl(cookie),
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path ?? '/',
        secure: cookie.secure ?? false,
        httpOnly: cookie.httpOnly ?? false,
        sameSite: normalizeSameSite(cookie.sameSite),
      };
      if (cookie.expires && cookie.expires > 0)
        details.expirationDate = cookie.expires;
      await profileSession.cookies.set(details);
      imported += 1;
    } catch (error) {
      if (!cookie.name.startsWith('__Host-'))
        mainLog.warn(`[SystemLogin] Failed to import cookie ${cookie.name}: ${error instanceof Error ? error.message : String(error)}`);
      failed += 1;
    }
  }
  await profileSession.cookies.flushStore();

  try {
    const snapshotDir = path.join(app.getPath('userData'), 'profile-cookies');
    fs.mkdirSync(snapshotDir, { recursive: true });
    const stored = await profileSession.cookies.get({});
    fs.writeFileSync(
      path.join(snapshotDir, `${profileId}.json`),
      JSON.stringify(stored.length > 0 ? stored : cookies),
      { mode: 0o600 },
    );
  } catch (error) {
    mainLog.warn(`[SystemLogin] Cookie snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { imported, failed };
}

export function abortProfileLogin(profileId: string): boolean {
  const processToKill = loginProcesses.get(profileId);
  if (!processToKill || processToKill.killed)
    return false;
  try {
    processToKill.kill('SIGTERM');
  } catch {
    // Process may already have exited.
  }
  loginProcesses.delete(profileId);
  return true;
}

export function isProfileChromeOpen(profileId: string): boolean {
  if (loginInProgress.has(profileId))
    return true;
  const loginProc = loginProcesses.get(profileId);
  if (loginProc && !loginProc.killed)
    return true;
  const active = activeProfileChromes.get(profileId);
  return Boolean(active && !active.proc.killed);
}

function profileChromeArgs(profileDir: string, targetUrl: string, debugPort?: number): string[] {
  const args = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (debugPort)
    args.push(`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1');
  try {
    const { globalProxyClient } = require('./globalProxyClient') as {
      globalProxyClient: { getSocks5Rule(): string | null };
    };
    const proxy = globalProxyClient.getSocks5Rule();
    if (proxy)
      args.push(`--proxy-server=${proxy}`);
  } catch {
    // Global proxy is optional.
  }
  args.push(targetUrl);
  return args;
}

export async function openProfileInRealChrome(
  profileId: string,
  targetUrl = FLOW_URL,
): Promise<{ success: boolean; error?: string }> {
  const chromePath = findChromePath();
  if (!chromePath)
    return { success: false, error: 'Chrome/Chromium not found. Please install Google Chrome.' };
  const profileDir = path.join(app.getPath('userData'), 'chrome-profiles', profileId);
  if (!fs.existsSync(profileDir))
    return { success: false, error: 'Profile has no Chrome user-data — login the profile first.' };

  const existing = activeProfileChromes.get(profileId);
  if (existing && !existing.proc.killed) {
    try {
      spawn(chromePath, profileChromeArgs(profileDir, targetUrl), { detached: true, stdio: 'ignore' }).unref();
      return { success: true };
    } catch {
      // Fall through and reopen with a fresh debug port.
    }
  }

  await killOrphanChromeForProfile(profileDir);
  const port = await getRandomFreePort();
  const chromeProc = spawn(
    chromePath,
    profileChromeArgs(profileDir, targetUrl, port),
    { detached: false, stdio: 'ignore' },
  );
  launchedProfileChromes.set(profileId, chromeProc);
  try {
    await waitForDebugPort(port, { child: chromeProc, timeoutMs: 15_000 });
  } catch (error) {
    mainLog.warn(`[SystemLogin] Chrome opened without cookie sync: ${error instanceof Error ? error.message : String(error)}`);
    return { success: true };
  }

  const browser = await connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
  const pollHandle = setInterval(() => {
    syncCookiesForProfile(profileId, browser).catch(() => undefined);
  }, 5_000);
  activeProfileChromes.set(profileId, { proc: chromeProc, browser, pollHandle });
  browser.on('disconnected', () => {
    clearInterval(pollHandle);
    activeProfileChromes.delete(profileId);
    launchedProfileChromes.delete(profileId);
    cookieHashes.delete(profileId);
    notifyRenderer('profile:cookies-synced', { profileId });
    notifyRenderer('profile:browser-closed', { profileId });
    try {
      const { triggerWarmupAfterBrowserClose } = require('./profileBrowserManager') as {
        triggerWarmupAfterBrowserClose(id: string): void;
      };
      triggerWarmupAfterBrowserClose(profileId);
    } catch {
      // Browser close notification is still sufficient for the renderer.
    }
  });
  return { success: true };
}

export async function closeProfileRealChrome(
  profileId: string,
  options: { only?: ChildProcess } = {},
): Promise<{ success: boolean }> {
  const active = activeProfileChromes.get(profileId);
  const chromeProc = launchedProfileChromes.get(profileId) ?? active?.proc;
  if (options.only && chromeProc && chromeProc !== options.only)
    return { success: false };
  if (active) {
    if (active.pollHandle)
      clearInterval(active.pollHandle);
    try {
      active.browser?.disconnect();
    } catch {
      // Already disconnected.
    }
    activeProfileChromes.delete(profileId);
  }
  launchedProfileChromes.delete(profileId);
  cookieHashes.delete(profileId);
  if (chromeProc && !chromeProc.killed) {
    try {
      chromeProc.kill('SIGTERM');
    } catch {
      // Process already exited.
    }
  }
  return { success: true };
}

function notifyRenderer(channel: string, payload: Record<string, unknown>): void {
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed())
        window.webContents.send(channel, payload);
    }
  } catch {
    // App is shutting down.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
