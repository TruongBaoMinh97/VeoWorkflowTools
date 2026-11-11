import * as fs from 'node:fs';
import * as path from 'node:path';

export type CaptchaEngine = 'chrome' | 'cloak';

export function readCaptchaEngine(userDataDir: string, fallback: CaptchaEngine): CaptchaEngine {
  const override = process.env.VEO_CAPTCHA_ENGINE?.trim().toLowerCase();
  if (override === 'chrome' || override === 'cloak') return override;
  try {
    const value = JSON.parse(fs.readFileSync(path.join(userDataDir, 'captcha-engine.json'), 'utf8')) as { engine?: unknown };
    if (value.engine === 'chrome' || value.engine === 'cloak') return value.engine;
  }
  catch { /* Use the available browser. */ }
  return fallback;
}

export function writeCaptchaEngine(userDataDir: string, engine: CaptchaEngine): void {
  fs.mkdirSync(userDataDir, { recursive: true });
  const file = path.join(userDataDir, 'captcha-engine.json');
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ engine }), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
