import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const ipcBridgePath = path.resolve(
  here,
  '../../../electron/dist/main/ipcBridge.js',
);

describe('Electron captcha bridge actions', () => {
  it('allows the UPLOAD_IMAGE action required by FlowService.UploadImage', () => {
    const source = fs.readFileSync(ipcBridgePath, 'utf8');

    expect(source).toContain('"UPLOAD_IMAGE"!==i');
    expect(source).toContain(
      'action must be VIDEO_GENERATION, IMAGE_GENERATION, or UPLOAD_IMAGE',
    );
    expect(source).not.toContain(
      'action must be VIDEO_GENERATION or IMAGE_GENERATION',
    );
  });
});
