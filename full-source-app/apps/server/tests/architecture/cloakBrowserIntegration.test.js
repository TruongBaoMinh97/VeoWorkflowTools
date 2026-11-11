import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeCloakExitCode,
  findCloakBrowserExecutable,
  hasCloakLicense,
} from '../../../electron/src/main/cloakBrowserPath.ts';
import {
  readCaptchaEngine,
  writeCaptchaEngine,
} from '../../../electron/src/main/captchaEngineStore.ts';

const tempDirs = [];
function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'veo-cloak-test-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('CloakBrowser browser selection', () => {
  it('finds the newest installed Chromium and detects a saved license without exposing its contents', () => {
    const home = temporaryDirectory();
    const cache = path.join(home, '.cloakbrowser');
    for (const version of ['154.0.8000.1', '156.0.8078.47.1']) {
      const build = path.join(cache, `chromium-${version}-pro`);
      fs.mkdirSync(build, { recursive: true });
      fs.writeFileSync(path.join(build, 'chrome.exe'), '');
    }
    fs.writeFileSync(path.join(cache, 'license.key'), 'private-test-key');
    const context = {
      env: {}, homedir: home, platform: 'win32',
      exists: fs.existsSync,
      readDir: (directory) => fs.readdirSync(directory),
      readFile: (file) => fs.readFileSync(file, 'utf8'),
    };
    expect(findCloakBrowserExecutable(context)).toBe(path.join(cache, 'chromium-156.0.8078.47.1-pro', 'chrome.exe'));
    expect(hasCloakLicense(context)).toBe(true);
  });

  it('allows an explicit binary path and reports the free-seat exit code', () => {
    const home = temporaryDirectory();
    const binary = path.join(home, 'custom-cloak.exe');
    fs.writeFileSync(binary, '');
    const context = {
      env: { VEO3_CLOAKBROWSER_PATH: binary }, homedir: home, platform: 'win32',
      exists: fs.existsSync,
      readDir: (directory) => fs.readdirSync(directory),
      readFile: (file) => fs.readFileSync(file, 'utf8'),
    };
    expect(findCloakBrowserExecutable(context)).toBe(binary);
    expect(describeCloakExitCode(76)).toContain('giới hạn phiên');
  });

  it('persists an explicit Chrome fallback and honors the environment override', () => {
    const userData = temporaryDirectory();
    expect(readCaptchaEngine(userData, 'cloak')).toBe('cloak');
    writeCaptchaEngine(userData, 'chrome');
    expect(readCaptchaEngine(userData, 'cloak')).toBe('chrome');
    vi.stubEnv('VEO_CAPTCHA_ENGINE', 'cloak');
    expect(readCaptchaEngine(userData, 'chrome')).toBe('cloak');
  });
});
