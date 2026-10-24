import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const electronLoginPath = fileURLToPath(new URL(
  '../../../electron/src/main/systemBrowserLogin.ts',
  import.meta.url,
));
const rendererPath = fileURLToPath(new URL(
  '../../../renderer/src/core/app-shell.js',
  import.meta.url,
));
const profileRoutesPath = fileURLToPath(new URL(
  '../../src/modules/profiles/profile.routes.js',
  import.meta.url,
));
const flowBoqPath = fileURLToPath(new URL(
  '../../src/lib/flowBoq.js',
  import.meta.url,
));

describe('Veo3Studio 1.8.9 Flow profile login', () => {
  it('verifies login on Flow instead of the retired Labs auth endpoint', () => {
    const source = fs.readFileSync(electronLoginPath, 'utf8');

    expect(source).toContain("const FLOW_URL = 'https://flow.google.com/'");
    expect(source).toContain('WIZ_global_data?.oPEP7c');
    expect(source).toContain("errorCode: 'FLOW_SIGNED_OUT'");
    expect(source).not.toContain('labs.google/fx/api/auth/signin');
    expect(source).not.toContain('__Secure-next-auth.session-token');
  });

  it('always opens an existing profile on flow.google.com', () => {
    const source = fs.readFileSync(rendererPath, 'utf8');
    const openProfileBlock = source.slice(
      source.indexOf('const H = await window.electronAPI.profileOpenRealChrome'),
      source.indexOf('if (!H.success)', source.indexOf('const H = await window.electronAPI.profileOpenRealChrome')),
    );

    expect(openProfileBlock).toContain('url: "https://flow.google.com/"');
    expect(openProfileBlock).not.toContain('labs.google');
  });

  it('verifies profile health through Flow instead of refreshing a Labs token', () => {
    const routes = fs.readFileSync(profileRoutesPath, 'utf8');
    const flowBoq = fs.readFileSync(flowBoqPath, 'utf8');

    expect(routes).toContain('checkFlowSignIn');
    expect(routes).toContain("errorCode: 'FLOW_SIGNED_OUT'");
    expect(routes).not.toContain('refreshAccessTokenFromCookies');
    expect(routes).not.toContain('LABS_SESSION_COOKIE_MISSING');
    expect(flowBoq).toContain('export async function checkFlowSignIn');
  });
});
