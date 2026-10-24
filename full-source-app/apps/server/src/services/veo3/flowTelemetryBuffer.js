/**
 * Flow Telemetry Buffer
 *
 * Real Flow batches `:batchLog` and `/flow:batchLogFrontendEvents` events
 * across many gens and flushes them PERIODICALLY in single accumulated POSTs
 * (verified via captures/flowai-lifecycle-*.json — one POST contained 12+
 * FLOW_IMAGE_LATENCY events). The previous tool implementation fired 4 POSTs
 * per gen (2× pre + 2× post), producing a per-gen telemetry signature Google's
 * reCAPTCHA Enterprise scoring system flags as bot behaviour.
 *
 * Symptoms before this fix:
 *   - 1 successful gen, then PUBLIC_ERROR_UNUSUAL_ACTIVITY 403 on every
 *     subsequent gen
 *   - Per-gen pattern: log → log → gen → log → log → log → log
 *   - Real Flow pattern: gen → /clr  +  one accumulated batchLog every N gens
 *
 * This buffer:
 *   1. Receives appEvents / frontendEvents per gen (push, no immediate fetch)
 *   2. Schedules a flush after FLUSH_DELAY_MS (default 6s) — coalesces back-
 *      to-back gens into a single POST
 *   3. Force-flushes when buffered events exceed FLUSH_MAX_EVENTS
 *   4. Exposes flushNow(profileId) for shutdown / browser reset
 */
import { googleFetch } from './veo3HttpClient.js';
import { logger } from '../../lib/logger.js';
const buffers = new Map();
/** How long to wait before flushing after the last enqueued event. */
const FLUSH_DELAY_MS = Number(process.env.FLOW_TELEMETRY_FLUSH_DELAY_MS) || 6000;
/** Force flush when a single event class hits this size (mirrors browser flush behaviour). */
const FLUSH_MAX_EVENTS = Number(process.env.FLOW_TELEMETRY_FLUSH_MAX_EVENTS) || 12;
/** Minimum spacing between two flushes for the same profile to avoid burst patterns. */
const MIN_FLUSH_SPACING_MS = Number(process.env.FLOW_TELEMETRY_MIN_SPACING_MS) || 1500;
function getOrCreate(profileId) {
    let b = buffers.get(profileId);
    if (!b) {
        b = {
            appEvents: [],
            frontendEvents: [],
            flushTimer: null,
            lastFlushAt: 0,
            baseUrl: null,
            headers: null,
            veo3ProjectId: undefined,
            locale: undefined,
        };
        buffers.set(profileId, b);
    }
    return b;
}
/**
 * Push events to the buffer. Schedules a flush if not already pending.
 *
 * @param appEvents      Events for `${baseUrl}:batchLog` (appEvents array)
 * @param frontendEvents Events for `${baseUrl}/flow:batchLogFrontendEvents` (events array)
 */
export function pushFlowTelemetry(params) {
    const { profileId, baseUrl, headers, veo3ProjectId, locale, appEvents = [], frontendEvents = [] } = params;
    if (!profileId)
        return;
    if (appEvents.length === 0 && frontendEvents.length === 0)
        return;
    const buf = getOrCreate(profileId);
    buf.baseUrl = baseUrl;
    buf.headers = headers;
    buf.veo3ProjectId = veo3ProjectId;
    buf.locale = locale;
    if (appEvents.length > 0)
        buf.appEvents.push(...appEvents);
    if (frontendEvents.length > 0)
        buf.frontendEvents.push(...frontendEvents);
    // Force-flush if either bucket exceeds the cap.
    if (buf.appEvents.length >= FLUSH_MAX_EVENTS || buf.frontendEvents.length >= FLUSH_MAX_EVENTS) {
        void flushNow(profileId);
        return;
    }
    if (buf.flushTimer)
        return;
    buf.flushTimer = setTimeout(() => {
        buf.flushTimer = null;
        void flushNow(profileId);
    }, FLUSH_DELAY_MS);
}
/**
 * Flush pending events for a profile right now (idempotent / safe to call
 * with empty buffers). Honours MIN_FLUSH_SPACING_MS to avoid burst patterns
 * but never blocks longer than that.
 */
export async function flushNow(profileId) {
    const buf = buffers.get(profileId);
    if (!buf)
        return;
    if (buf.flushTimer) {
        clearTimeout(buf.flushTimer);
        buf.flushTimer = null;
    }
    if (buf.appEvents.length === 0 && buf.frontendEvents.length === 0)
        return;
    if (!buf.baseUrl || !buf.headers)
        return;
    const sinceLast = Date.now() - buf.lastFlushAt;
    if (sinceLast < MIN_FLUSH_SPACING_MS) {
        const wait = MIN_FLUSH_SPACING_MS - sinceLast;
        await new Promise((r) => setTimeout(r, wait));
    }
    // Snapshot + clear before await so concurrent pushes go to a fresh batch.
    const appEvents = buf.appEvents.splice(0);
    const frontendEvents = buf.frontendEvents.splice(0);
    const baseUrl = buf.baseUrl;
    const headers = buf.headers;
    const veo3ProjectId = buf.veo3ProjectId;
    const locale = buf.locale;
    buf.lastFlushAt = Date.now();
    if (appEvents.length > 0) {
        googleFetch({
            profileId,
            veo3ProjectId,
            locale,
            url: `${baseUrl}:batchLog`,
            method: 'POST',
            headers,
            body: JSON.stringify({ appEvents }),
        }).catch((err) => {
            logger.debug?.(`[FlowTelemetry] batchLog flush failed (non-fatal): ${err?.message || err}`);
        });
    }
    if (frontendEvents.length > 0) {
        googleFetch({
            profileId,
            veo3ProjectId,
            locale,
            url: `${baseUrl}/flow:batchLogFrontendEvents`,
            method: 'POST',
            headers,
            body: JSON.stringify({ events: frontendEvents }),
        }).catch((err) => {
            logger.debug?.(`[FlowTelemetry] frontendEvents flush failed (non-fatal): ${err?.message || err}`);
        });
    }
}
