import { writeFileSync, appendFileSync } from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';
import { getAppDataDirectory } from '../utils/directoryInit.js';
/** RSS + OS free memory snapshot — surfaces memory pressure during boot. */
function memSnapshot() {
    const mb = (n) => Math.round(n / (1024 * 1024));
    try {
        return `rss=${mb(process.memoryUsage().rss)}MB free=${mb(os.freemem())}MB/${mb(os.totalmem())}MB`;
    }
    catch {
        return 'mem=?';
    }
}
/**
 * Synchronous boot-status sidecar (userData/logs/boot-status.json).
 *
 * winston's File transport is stream-buffered, so an abrupt kill during startup
 * loses the last lines. writeFileSync lands on disk immediately — each call
 * OVERWRITES the file, so after a hang/kill the file holds the LAST phase the
 * server reached. Used to pinpoint where startup stops (e.g. which Fastify
 * plugin blocks the event loop during the ready sequence).
 */
const BOOT_STATUS_PATH = nodePath.join(getAppDataDirectory(), 'logs', 'boot-status.json');
const APP_LOG_PATH = nodePath.join(getAppDataDirectory(), 'logs', 'app.log');
/**
 * Boot breadcrumb: update boot-status.json AND append a line SYNCHRONOUSLY to
 * app.log. winston's File transport is buffered, so lines emitted right before
 * an event-loop-blocking hang (and the subsequent kill) never reach disk — that
 * is why failing runs show no "Server listening"/no error. A synchronous append
 * survives, so the LAST `[boot-trace]` line in app.log is exactly the step that
 * blocked. Use for the Fastify ready-phase plugin trace.
 */
export function traceBoot(phase) {
    writeBootStatus(phase);
    try {
        appendFileSync(APP_LOG_PATH, `${new Date().toISOString()} INFO [boot-trace] ${phase} ${memSnapshot()}\n`);
    }
    catch {
        /* best-effort */
    }
}
export function writeBootStatus(phase, error) {
    try {
        writeFileSync(BOOT_STATUS_PATH, JSON.stringify({
            phase,
            pid: process.pid,
            ts: new Date().toISOString(),
            version: process.env.VEO3_APP_VERSION ?? null,
            ...(error ? { error: error.slice(0, 500) } : {}),
        }));
    }
    catch {
        /* best-effort — never let diagnostics break boot */
    }
}
