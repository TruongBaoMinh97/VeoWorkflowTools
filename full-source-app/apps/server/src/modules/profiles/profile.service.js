import { z } from 'zod';
import { profileRepository } from './profile.repository.js';
import { parseProxyString, toProxyConfig, buildProxyString, validateProxyFormat } from '../../utils/proxyUtils.js';
import { fetchIpcBridge } from '../../lib/ipcBridgeFetch.js';
import { logger } from '../../lib/logger.js';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const profileSchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    cookies: z.string().optional(),
    accessToken: z.string().optional(),
    // Nullable so a dead Flow grant can clear the stored expiry instead of
    // leaving /auth-status reporting a token Google no longer honours.
    accessTokenExpires: z.date().nullable().optional(),
    maxConcurrency: z.number().int().positive().default(1),
    // Veo3 raw concurrent-job ceiling per profile (default 12). Honored by
    // VeoProfileManager.acquireSlot() for FarmVideo jobs.
    maxConcurrentVeo3Jobs: z.coerce.number().int().min(1).max(20).default(12),
    dailyQuota: z.number().int().positive().optional(),
    active: z.boolean().default(true),
    // Proxy config as single string: host:port:username:password
    proxyConfig: z.string().optional().nullable(),
});
// Helper to transform profile from DB to API response (decrypt proxy)
function transformProfileForResponse(profile) {
    if (!profile)
        return profile;
    // Build proxyConfig string from DB fields (with decrypted password)
    const proxyConfig = buildProxyString({
        proxyHost: profile.proxyHost,
        proxyPort: profile.proxyPort,
        proxyUsername: profile.proxyUsername,
        proxyPassword: profile.proxyPassword,
    });
    return {
        ...profile,
        proxyConfig,
    };
}
// Helper to transform payload for DB (encrypt proxy password)
function transformPayloadForDb(payload) {
    const result = { ...payload };
    // If proxyConfig is provided, parse and store as separate fields
    if (payload.proxyConfig !== undefined) {
        if (payload.proxyConfig === null || payload.proxyConfig === '') {
            // Clear proxy settings
            result.proxyHost = null;
            result.proxyPort = null;
            result.proxyUsername = null;
            result.proxyPassword = null;
        }
        else {
            const parsed = parseProxyString(payload.proxyConfig);
            if (parsed) {
                const config = toProxyConfig(parsed);
                result.proxyHost = config.proxyHost;
                result.proxyPort = config.proxyPort;
                result.proxyUsername = config.proxyUsername;
                result.proxyPassword = config.proxyPassword;
            }
        }
        delete result.proxyConfig;
    }
    return result;
}
export const profileService = {
    list: async () => {
        const profiles = await profileRepository.list();
        return profiles.map(transformProfileForResponse);
    },
    getById: async (id) => {
        const profile = await profileRepository.getById(id);
        return transformProfileForResponse(profile);
    },
    create: async (payload) => {
        const dbPayload = transformPayloadForDb({
            name: payload.name,
            description: payload.description,
            cookies: payload.cookies,
            accessToken: payload.accessToken,
            maxConcurrency: payload.maxConcurrency,
            maxConcurrentVeo3Jobs: payload.maxConcurrentVeo3Jobs,
            dailyQuota: payload.dailyQuota,
            active: payload.active,
            proxyConfig: payload.proxyConfig,
        });
        // Add runningJobs separately (not part of ProfilePayload)
        dbPayload.runningJobs = 0;
        const profile = await profileRepository.create(dbPayload);
        return transformProfileForResponse(profile);
    },
    update: async (id, payload) => {
        const dbPayload = transformPayloadForDb({
            ...(payload.name !== undefined ? { name: payload.name } : {}),
            ...(payload.description !== undefined ? { description: payload.description } : {}),
            ...(payload.cookies !== undefined ? { cookies: payload.cookies } : {}),
            ...(payload.accessToken !== undefined ? { accessToken: payload.accessToken } : {}),
            ...(payload.accessTokenExpires !== undefined ? { accessTokenExpires: payload.accessTokenExpires } : {}),
            ...(payload.maxConcurrency !== undefined ? { maxConcurrency: payload.maxConcurrency } : {}),
            ...(payload.maxConcurrentVeo3Jobs !== undefined ? { maxConcurrentVeo3Jobs: payload.maxConcurrentVeo3Jobs } : {}),
            ...(payload.dailyQuota !== undefined ? { dailyQuota: payload.dailyQuota } : {}),
            ...(payload.active !== undefined ? { active: payload.active } : {}),
            ...(payload.proxyConfig !== undefined ? { proxyConfig: payload.proxyConfig } : {}),
        });
        const profile = await profileRepository.update(id, dbPayload);
        return transformProfileForResponse(profile);
    },
    delete: (id) => profileRepository.delete(id),
    // Get proxy config for a profile (used by browser manager)
    getProxyConfig: async (id) => {
        const profile = await profileRepository.getById(id);
        if (!profile)
            return null;
        return buildProxyString({
            proxyHost: profile.proxyHost,
            proxyPort: profile.proxyPort,
            proxyUsername: profile.proxyUsername,
            proxyPassword: profile.proxyPassword,
        });
    },
    /**
     * Get proxy config OBJECT (proxyHost/Port/Username/Password) for use with
     * Veo3Service / HttpsProxyAgent. Returns null if profile has no proxy.
     * Unlike getProxyConfig (which returns a string), this returns the shape
     * expected by buildProxyUrl() so the agent can be constructed.
     */
    getProxyConfigObject: async (id) => {
        const profile = await profileRepository.getById(id);
        if (!profile || !profile.proxyHost || !profile.proxyPort)
            return null;
        return {
            proxyHost: profile.proxyHost,
            proxyPort: profile.proxyPort,
            proxyUsername: profile.proxyUsername,
            proxyPassword: profile.proxyPassword,
        };
    },
    /**
     * Clone a profile N times. Each clone gets a fresh DB row with a new cuid()
     * (→ unique fingerprint via getProfileFingerprint), then source cookies are
     * imported into the new Electron partition so the clone shares the source's
     * Google login session without sharing the partition.
     *
     * Stagger 800-1400ms between creates to avoid bulk-pattern signal at Google.
     * Caller-side cap is 1-10; recommended sweet spot is 2-4 per Google account.
     */
    cloneProfile: async (sourceId, count, opts) => {
        if (count < 1 || count > 10) {
            const err = new Error('count must be between 1 and 10');
            err.statusCode = 400;
            throw err;
        }
        const source = await profileRepository.getById(sourceId);
        if (!source) {
            const err = new Error('Source profile not found');
            err.statusCode = 404;
            throw err;
        }
        const cookieCtl = new AbortController();
        const cookieTimeoutId = setTimeout(() => cookieCtl.abort(), 5000);
        let cookieData;
        try {
            const r = await fetchIpcBridge(`/profile/${sourceId}/cookies`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
                signal: cookieCtl.signal,
            });
            cookieData = (await r.json());
        }
        finally {
            clearTimeout(cookieTimeoutId);
        }
        if (!cookieData.success || !cookieData.cookies || cookieData.cookies.trim() === '') {
            const err = new Error('Source has no cookies — login Flow AI first');
            err.statusCode = 400;
            throw err;
        }
        const clones = [];
        for (let i = 1; i <= count; i++) {
            try {
                const cloneDbPayload = {
                    name: `${opts?.namePrefix || source.name} (Clone ${i})`,
                    description: `Cloned from ${source.name}`,
                    proxyHost: source.proxyHost,
                    proxyPort: source.proxyPort,
                    proxyUsername: source.proxyUsername,
                    proxyPassword: source.proxyPassword,
                    maxConcurrency: source.maxConcurrency,
                    maxConcurrentVeo3Jobs: source.maxConcurrentVeo3Jobs,
                    dailyQuota: source.dailyQuota,
                    active: true,
                    runningJobs: 0,
                };
                const cloned = await profileRepository.create(cloneDbPayload);
                const importCtl = new AbortController();
                const importTimeoutId = setTimeout(() => importCtl.abort(), 10000);
                let importResult = { ok: false };
                try {
                    try {
                        const impResp = await fetchIpcBridge(`/profile/${cloned.id}/import-cookies`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ cookies: cookieData.cookies }),
                            signal: importCtl.signal,
                        });
                        importResult = (await impResp.json());
                    }
                    finally {
                        clearTimeout(importTimeoutId);
                    }
                    if (!importResult.ok || (importResult.imported ?? 0) === 0) {
                        logger.warn(`[Profile] Clone ${cloned.id} (source=${sourceId}): cookie import returned ` +
                            `ok=${importResult.ok}, imported=${importResult.imported ?? 0}, failed=${importResult.failed ?? '?'} — ` +
                            `clone may be unusable until cookies are re-imported`);
                    }
                }
                catch (importErr) {
                    logger.warn(`[Profile] Cookie import network error for clone ${cloned.id} (source=${sourceId}): ${importErr.message}`);
                }
                clones.push(transformProfileForResponse(cloned));
            }
            catch (loopErr) {
                logger.warn(`[Profile] Clone ${i}/${count} failed (source=${sourceId}), continuing: ${loopErr?.message ?? String(loopErr)}`);
            }
            if (i < count) {
                await sleep(800 + Math.random() * 600);
            }
        }
        return clones;
    },
};
