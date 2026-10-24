/**
 * Ask the Electron shell to mint a fresh Flow session for a profile.
 *
 * The server cannot do this itself: a new grant only comes from re-running the
 * Google sign-in in the profile's real Chrome, which Electron owns. Requests
 * are fire-and-forget and rate-limited per profile so a burst of jobs hitting
 * the same dead grant does not queue a burst of Chrome windows.
 */
import { fetchIpcBridge } from './ipcBridgeFetch.js';
import { logger } from './logger.js';
const REQUEST_COOLDOWN_MS = 5 * 60000;
const lastRequestAt = new Map();
export function requestProfileRemint(profileId, reason, opts = {}) {
    const now = Date.now();
    if (!opts.force && now - (lastRequestAt.get(profileId) ?? 0) < REQUEST_COOLDOWN_MS)
        return;
    // Drop entries that are past their cooldown so a long-running server with many
    // profiles does not accumulate them for the life of the process.
    for (const [id, at] of lastRequestAt) {
        if (now - at >= REQUEST_COOLDOWN_MS)
            lastRequestAt.delete(id);
    }
    lastRequestAt.set(profileId, now);
    fetchIpcBridge(`/profile/${profileId}/remint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
    })
        .then(async (res) => {
        const payload = await res.json().catch(() => ({}));
        if (payload && payload.accepted === false) {
            lastRequestAt.delete(profileId);
        }
        logger.info(`[SessionRemint] requested re-mint for ${profileId.substring(0, 8)} (${reason}) → ${res.status} (accepted=${payload?.accepted ?? 'unknown'})`);
    })
        .catch((err) => {
        lastRequestAt.delete(profileId);
        logger.warn(`[SessionRemint] could not reach Electron to re-mint ${profileId.substring(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    });
}

