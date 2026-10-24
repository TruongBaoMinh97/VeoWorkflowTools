// Per-profile ya29 access token cache + single-flight refresh against
// labs.google/fx/api/auth/session through the chrome_131_PSK TLS lane.
import { logger } from '../../lib/logger.js';
import { tlsFetch } from '../../lib/tlsClient.js';
import { UnauthorizedError } from '../../lib/errors.js';
const TOKEN_TTL_MS = 55 * 60 * 1000;
export class Veo3TokenService {
    constructor() {
        this.tokenCache = new Map();
        this.refreshInFlight = new Map();
    }
    async getAccessTokenFromProfile(profileId, forceRefresh = false) {
        if (!forceRefresh) {
            const cached = this.tokenCache.get(profileId);
            if (cached && cached.expiresAt > Date.now()) {
                return cached.token;
            }
        }
        const { profileService } = await import('../../modules/profiles/profile.service.js');
        const profile = await profileService.getById(profileId);
        if (!profile) {
            throw new Error(`Profile ${profileId} not found`);
        }
        if (!profile.accessToken || profile.accessToken.trim().length === 0) {
            throw new Error(`No access token for profile ${profileId}. Open Profiles → Login để lấy cookies, sau đó server sẽ tự refresh JWT.`);
        }
        if (profile.accessTokenExpires) {
            const expiresAt = new Date(profile.accessTokenExpires).getTime();
            if (expiresAt <= Date.now()) {
                throw new Error(`Access token for profile ${profileId} has expired. Refresh from cookies (Profiles tab) hoặc login lại.`);
            }
            if (expiresAt <= Date.now() + 5 * 60 * 1000) {
                logger.warn(`⚠️ Access token for profile ${profileId} will expire soon (${new Date(expiresAt).toLocaleString()})`);
            }
        }
        const expiresAt = profile.accessTokenExpires
            ? new Date(profile.accessTokenExpires).getTime()
            : Date.now() + TOKEN_TTL_MS;
        this.tokenCache.set(profileId, {
            token: profile.accessToken,
            expiresAt,
            profileId,
        });
        return profile.accessToken;
    }
    /** Background refresh if cache is empty or expires within 5 minutes. */
    async refreshAccessTokenIfNeeded(profileId) {
        const cached = this.tokenCache.get(profileId);
        if (!cached || cached.expiresAt < Date.now() + 5 * 60 * 1000) {
            return await this.getAccessTokenFromProfile(profileId, true);
        }
        return cached.token;
    }
    clearCache(profileId) {
        if (profileId) {
            this.tokenCache.delete(profileId);
        }
        else {
            this.tokenCache.clear();
        }
    }
    getCachedToken(profileId) {
        const cached = this.tokenCache.get(profileId);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.token;
        }
        return null;
    }
    async getAccessTokenFromCookies(cookiesString, referer, profileId) {
        const result = await this.callAuthSession(cookiesString, referer, profileId);
        return result.accessToken;
    }
    async refreshTokenFromCookies(cookiesString, referer, profileId) {
        return this.callAuthSession(cookiesString, referer, profileId);
    }
    async callAuthSession(cookiesString, referer, profileId) {
        if (!cookiesString || cookiesString.trim().length === 0) {
            throw new Error('Cookies are required to refresh JWT');
        }
        if (!profileId) {
            return this.performAuthSession(cookiesString, referer, 'anonymous');
        }
        const existing = this.refreshInFlight.get(profileId);
        if (existing)
            return existing;
        const promise = this.performAuthSession(cookiesString, referer, profileId).finally(() => {
            this.refreshInFlight.delete(profileId);
        });
        this.refreshInFlight.set(profileId, promise);
        return promise;
    }
    // auth/session may return either `{ access_token, expires }` or a raw cookie
    // array (server rotated session cookies); handleCookieArrayResponse re-issues
    // the call with the rotated cookies to get the token.
    async performAuthSession(cookiesString, referer, profileId) {
        const shortId = profileId.substring(0, 8);
        const url = 'https://labs.google/fx/api/auth/session';
        const headers = {
            Accept: '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Content-Type': 'application/json',
            Priority: 'u=1, i',
            Referer: referer || 'https://labs.google/fx/en/tools/flow',
        };
        const resp = await tlsFetch({
            profileId,
            url,
            method: 'GET',
            headers,
            cookies: cookiesString.trim(),
            timeoutMs: 15000,
        });
        if (!resp.ok) {
            logger.error(`[Veo3TokenService] auth/session failed for ${shortId}: ${resp.status} ${resp.statusText}`);
            if (resp.status === 401 || resp.status === 403) {
                throw new UnauthorizedError(`Auth session returned ${resp.status} for profile ${profileId}. Cookies invalid or expired — re-login profile.`);
            }
            throw new Error(`Failed to call auth session: ${resp.status} ${resp.statusText} - ${resp.body.substring(0, 200)}`);
        }
        let parsed;
        try {
            parsed = JSON.parse(resp.body);
        }
        catch (err) {
            throw new Error(`auth/session returned non-JSON for ${shortId}: ${resp.body.substring(0, 200)}`);
        }
        if (Array.isArray(parsed)) {
            return this.handleCookieArrayResponse(parsed, headers, profileId);
        }
        const data = parsed;
        if (data.access_token) {
            logger.info(`[Veo3TokenService] access token fetched for ${shortId}`);
            return {
                cookies: cookiesString.trim(),
                accessToken: data.access_token,
            };
        }
        throw new Error(`auth/session for ${shortId} returned neither access_token nor cookie array: ${JSON.stringify(parsed).substring(0, 200)}`);
    }
    async handleCookieArrayResponse(cookies, baseHeaders, profileId) {
        const cookiesHeaderString = cookies
            .map((c) => `${c.name}=${c.value}`)
            .join('; ');
        const resp = await tlsFetch({
            profileId,
            url: 'https://labs.google/fx/api/auth/session',
            method: 'GET',
            headers: baseHeaders,
            cookies: cookiesHeaderString,
            timeoutMs: 15000,
        });
        if (!resp.ok) {
            throw new Error(`auth/session second call failed: ${resp.status} ${resp.statusText}`);
        }
        const data = JSON.parse(resp.body);
        if (!data.access_token) {
            throw new Error('auth/session rotated cookies but second call still returned no access_token');
        }
        return {
            cookies: cookiesHeaderString,
            accessToken: data.access_token,
        };
    }
}
export const veo3TokenService = new Veo3TokenService();
