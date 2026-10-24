/**
 * Profile Cookies Helper
 *
 * Cookies are stored in Electron's persist: partition (not the DB). Server
 * accesses the partition via the IPC Bridge (HTTP server in Electron main
 * process). Auth runs off `accessToken`, refreshed by `cookieTokenService`
 * (tlsClient → labs.google /api/auth/session) when expired.
 */
import fs from 'node:fs';
import { fetchIpcBridge } from '../lib/ipcBridgeFetch.js';
import { logger } from '../lib/logger.js';
import { getProfileCookiesSnapshotPath } from '../lib/electronPaths.js';
// Rate-limit IPC Bridge error logging (1 log per 30s max)
let lastIpcErrorLogTime = 0;
const IPC_ERROR_LOG_INTERVAL_MS = 30000;
// Read the JSON snapshot the Electron login flow writes after a successful
// cookie import. Used as a fallback when the IPC bridge is unreachable
// (port conflict, AV blocking loopback, crashed Electron main). Returns the
// stringified cookies array, or empty string if no snapshot exists.
function readSnapshotFallback(profileId) {
    try {
        const snapshotPath = getProfileCookiesSnapshotPath(profileId);
        if (!fs.existsSync(snapshotPath))
            return '';
        const raw = fs.readFileSync(snapshotPath, 'utf8').trim();
        if (!raw)
            return '';
        // Validate it parses as an array — defends against partial writes.
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0)
            return '';
        return raw;
    }
    catch (err) {
        logger.warn(`[ProfileCookies] snapshot fallback read failed for ${profileId.substring(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
        return '';
    }
}
/**
 * Get cookies for a profile
 *
 * SERVER: Calls Electron IPC Bridge to get cookies from partition
 *
 * @param profileId - Profile ID
 * @returns Cookie string from partition, or empty string if failed
 */
export async function getProfileCookies(profileId) {
    try {
        // Call Electron IPC Bridge with timeout. Windows + antivirus / EDR can add
        // hundreds of ms to localhost HTTP — 1s was tight enough to false-positive
        // as "fetch failed" on some user machines. 3s is still well under any UX
        // budget but absorbs the AV scan latency.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        try {
            const response = await fetchIpcBridge(`/profile/${profileId}/cookies`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!response.ok) {
                logger.error('[ProfileCookies] IPC Bridge returned error:', response.status);
                const snapshot = readSnapshotFallback(profileId);
                if (snapshot) {
                    logger.warn(`[ProfileCookies] Using snapshot fallback for ${profileId.substring(0, 8)} (bridge HTTP ${response.status})`);
                }
                return snapshot;
            }
            const data = await response.json();
            if (data.success && data.cookies) {
                // Bridge returned an empty/parseable-empty payload — treat as bridge
                // alive but partition empty, and TRY the snapshot before giving up.
                // This catches the Windows case where partition writes silently drop.
                if (data.cookies === '[]' || data.cookies.trim() === '') {
                    const snapshot = readSnapshotFallback(profileId);
                    if (snapshot) {
                        logger.warn(`[ProfileCookies] Bridge returned empty partition for ${profileId.substring(0, 8)} — using snapshot fallback`);
                        return snapshot;
                    }
                }
                return data.cookies;
            }
            // success=false or no cookies field — try snapshot before returning empty.
            const snapshot = readSnapshotFallback(profileId);
            if (snapshot) {
                logger.warn(`[ProfileCookies] Bridge returned no cookies for ${profileId.substring(0, 8)} — using snapshot fallback`);
            }
            return snapshot;
        }
        catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                logger.warn(`[ProfileCookies] Fetch timed out for profile ${profileId} — trying snapshot fallback`);
                return readSnapshotFallback(profileId);
            }
            throw error; // Re-throw to be caught by outer catch
        }
    }
    catch (error) {
        // Electron might not be running — rate-limit this log to avoid spam
        const now = Date.now();
        if (now - lastIpcErrorLogTime > IPC_ERROR_LOG_INTERVAL_MS) {
            lastIpcErrorLogTime = now;
            logger.warn('[ProfileCookies] IPC Bridge unavailable (logging suppressed for 30s):', error.message);
        }
        // Even when the bridge is completely unreachable, the JSON snapshot
        // written at login time lets the Test button + first JWT refresh succeed.
        return readSnapshotFallback(profileId);
    }
}
/**
 * Check if profile has cookies
 *
 * SERVER: Checks via IPC Bridge
 *
 * @param profileId - Profile ID
 * @returns true if profile has cookies in partition
 */
export async function hasProfileCookies(profileId) {
    const cookies = await getProfileCookies(profileId);
    return cookies.trim() !== '';
}
/**
 * Get profile cookies with backward compatibility
 * Drop-in replacement for old `if (profile.cookies)` pattern
 *
 * Replaces old pattern: if (profile.cookies) { ... JSON.parse(profile.cookies) ... }
 * New pattern: const { cookies, hasCookies, parsed } = await getProfileCookiesCompat(profile);
 *
 * SERVER: Gets cookies from partition via IPC Bridge
 *
 * Example OLD code:
 * ```
 * if (profile.cookies && profile.cookies.trim() !== '') {
 *   const parsed = JSON.parse(profile.cookies);
 *   const cookiesString = profile.cookies;
 * }
 * ```
 *
 * Example NEW code:
 * ```
 * const { cookies, hasCookies, parsed } = await getProfileCookiesCompat(profile);
 * if (hasCookies) {
 *   // Use parsed or cookies
 * }
 * ```
 *
 * @param profile - Profile object with id
 * @returns Object with cookies, hasCookies flag, and parsed array
 */
export async function getProfileCookiesCompat(profile) {
    const cookies = await getProfileCookies(profile.id);
    const hasCookies = cookies.trim() !== '';
    let parsed = null;
    if (hasCookies) {
        try {
            parsed = JSON.parse(cookies);
        }
        catch (error) {
            logger.error('[ProfileCookies] Failed to parse cookies:', error);
            parsed = null;
        }
    }
    return {
        cookies,
        hasCookies,
        parsed
    };
}
