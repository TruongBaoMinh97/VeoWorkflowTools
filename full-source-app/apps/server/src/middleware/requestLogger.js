/**
 * List of endpoints to exclude from request logging
 * These are frequently polled endpoints that clutter the logs
 */
const EXCLUDED_ENDPOINTS = [
    '/api/license/machine-id',
    '/api/admin/stats',
    '/api/admin/profiles/analytics',
    '/api/auth/verify',
    '/api/profiles/warmup-status',
    '/api/profiles/warmup-all',
    '/api/profiles/warmup-single',
    '/api/health',
    '/api/gen-normal/projects?source=normal',
    '/api/system/python-status',
    '/api/system/extension-status',
    '/api/gemini/api-key-status',
    '/api/internal/captcha/event',
    '/api/internal/captcha/result',
    '/api/internal/captcha/stats',
    '/api/internal/captcha/poll',
    '/api/profiles',
    // Flow workflow run-status poll — UI polls GET /api/workflow/runs/:runId
    // (+ /events, /cancel) every ~2s while a run is active, burying real signal.
    '/api/workflow/runs/',
];
/**
 * URL patterns to exclude from logging (matched with .includes())
 * Used for dynamic routes like /poll that appear in many paths,
 * and high-frequency polls that bury real signal in the log.
 */
const EXCLUDED_PATTERNS = [
    '/poll',
    // Per-mint / per-submit polls — fire 2-3 times per job cycle.
    '/proxy', // /api/profiles/:id/proxy
    '/proxy/status', // /api/proxy/status (every 10s)
    // UI refresh polls — fire every few seconds while the dashboard is open.
    '/system-stats', // /api/gen-normal/system-stats
    '/credits', // /api/gen-normal/projects/:id/credits
    '/image-models', // /api/gen-normal/image-models
    '/api/gen-normal/models', // /api/gen-normal/models?generationType=...
    // Admin housekeeping endpoints that fire on project navigation.
    '/jobs/delete-all-completed',
];
/**
 * Check if an endpoint should be excluded from logging
 */
function shouldExcludeLogging(url) {
    if (EXCLUDED_ENDPOINTS.some(endpoint => url.startsWith(endpoint)))
        return true;
    if (EXCLUDED_PATTERNS.some(pattern => url.includes(pattern)))
        return true;
    return false;
}
/**
 * Request logging middleware
 * Logs incoming requests and responses with timing
 * Excludes frequently polled endpoints to reduce log noise
 */
export async function requestLogger(request, reply) {
    // Skip logging for excluded endpoints
    if (shouldExcludeLogging(request.url)) {
        return;
    }
    const startTime = Date.now();
    // Log request
    request.log.info({
        type: 'request',
        method: request.method,
        url: request.url,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
    });
    // Hook into response to log completion
    reply.raw.on('finish', () => {
        const duration = Date.now() - startTime;
        request.log.info({
            type: 'response',
            method: request.method,
            url: request.url,
            statusCode: reply.statusCode,
            duration: `${duration}ms`,
        });
    });
}
