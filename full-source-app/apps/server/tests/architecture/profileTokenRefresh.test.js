import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/tlsClient.js', () => ({
  tlsFetch: vi.fn(),
}));

vi.mock('../../src/lib/sessionRemintRequest.js', () => ({
  requestProfileRemint: vi.fn(),
}));

import { tlsFetch } from '../../src/lib/tlsClient.js';
import {
  cookieTokenService,
  fingerprintProfileCookies,
} from '../../src/lib/cookieTokenService.js';
import { refreshAccessTokenFromCookies } from '../../src/providers/utils/cookieAuth.js';

const cookies = (sessionValue) => JSON.stringify([
  {
    name: '__Secure-next-auth.session-token',
    value: sessionValue,
    domain: 'labs.google',
    path: '/',
    secure: true,
  },
  {
    name: 'SID',
    value: `sid-${sessionValue}`,
    domain: '.google.com',
    path: '/',
    secure: true,
  },
]);

describe('profile access-token refresh', () => {
  beforeEach(() => {
    cookieTokenService.clearCache();
    vi.mocked(tlsFetch).mockReset();
    vi.mocked(tlsFetch).mockImplementation(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: JSON.stringify({
        access_token: `token-${vi.mocked(tlsFetch).mock.calls.length}`,
        expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    }));
  });

  it('keeps the cache for the same cookies regardless of array order', async () => {
    const first = JSON.parse(cookies('session-a'));
    const reordered = JSON.stringify([...first].reverse());

    expect(fingerprintProfileCookies(JSON.stringify(first)))
      .toBe(fingerprintProfileCookies(reordered));

    await cookieTokenService.getAccessTokenFromCookies(JSON.stringify(first), 'profile-1');
    await cookieTokenService.getAccessTokenFromCookies(reordered, 'profile-1');

    expect(tlsFetch).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a token after the profile cookies change', async () => {
    const oldToken = await cookieTokenService.getAccessTokenFromCookies(cookies('session-old'), 'profile-1');
    const newToken = await cookieTokenService.getAccessTokenFromCookies(cookies('session-new'), 'profile-1');

    expect(tlsFetch).toHaveBeenCalledTimes(2);
    expect(newToken.accessToken).not.toBe(oldToken.accessToken);
  });

  it('forces an explicit profile refresh even when cookies are unchanged', async () => {
    await refreshAccessTokenFromCookies(cookies('session-a'), 'profile-1');
    await refreshAccessTokenFromCookies(cookies('session-a'), 'profile-1', { force: true });

    expect(tlsFetch).toHaveBeenCalledTimes(2);
  });
});
