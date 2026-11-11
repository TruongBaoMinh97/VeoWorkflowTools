import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface CloakPathEnvironment {
  env: NodeJS.ProcessEnv;
  homedir: string;
  platform: NodeJS.Platform;
  exists(filePath: string): boolean;
  readDir(dirPath: string): string[];
  readFile(filePath: string): string;
}

function systemEnvironment(): CloakPathEnvironment {
  return {
    env: process.env,
    homedir: os.homedir(),
    platform: process.platform,
    exists: fs.existsSync,
    readDir: (dirPath) => fs.readdirSync(dirPath),
    readFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
  };
}

function cacheDir(context: CloakPathEnvironment): string {
  return context.env.CLOAKBROWSER_CACHE_DIR?.trim() || path.join(context.homedir, '.cloakbrowser');
}

function binaryInBuildDir(buildDir: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return path.join(buildDir, 'chrome.exe');
  if (platform === 'darwin') return path.join(buildDir, 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
  return path.join(buildDir, 'chrome');
}

export function findCloakBrowserExecutable(context = systemEnvironment()): string | null {
  for (const name of ['VEO3_CLOAKBROWSER_PATH', 'CLOAKBROWSER_BINARY_PATH']) {
    const candidate = context.env[name]?.trim();
    if (candidate && context.exists(candidate)) return candidate;
  }

  const root = cacheDir(context);
  let entries: string[];
  try { entries = context.readDir(root); }
  catch { return null; }
  const versions = entries
    .map((entry) => /^chromium-(\d+(?:\.\d+){2,4})-pro$/.exec(entry)?.[1])
    .filter((version): version is string => Boolean(version))
    .sort((left, right) => {
      const a = left.split('.').map(Number);
      const b = right.split('.').map(Number);
      for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        if ((a[index] ?? 0) !== (b[index] ?? 0)) return (b[index] ?? 0) - (a[index] ?? 0);
      }
      return 0;
    });
  for (const version of versions) {
    const candidate = binaryInBuildDir(path.join(root, `chromium-${version}-pro`), context.platform);
    if (context.exists(candidate)) return candidate;
  }
  return null;
}

export function hasCloakLicense(context = systemEnvironment()): boolean {
  if (context.env.CLOAKBROWSER_LICENSE_KEY?.trim()) return true;
  try { return context.readFile(path.join(cacheDir(context), 'license.key')).trim().length > 0; }
  catch { return false; }
}

export function describeCloakExitCode(code: number | null): string | null {
  const messages: Record<number, string> = {
    76: 'CloakBrowser đã đạt giới hạn phiên. Đóng phiên khác rồi thử lại.',
    77: 'Khóa CloakBrowser không hợp lệ hoặc đã hết hạn. Chạy `cloakbrowser login`.',
    78: 'CloakBrowser không xác thực được khóa. Kiểm tra kết nối mạng rồi thử lại.',
    79: 'CloakBrowser không ghi được thư mục cấu hình cục bộ.',
  };
  return code === null ? null : messages[code] ?? null;
}
