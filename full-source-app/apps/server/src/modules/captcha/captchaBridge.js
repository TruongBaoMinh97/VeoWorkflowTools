import { z } from 'zod';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { captchaManager } from '../../lib/captchaManager.js';
import { cdpClose, cdpEnsure, cdpStatus, getCaptchaProvider, setCaptchaProvider, } from '../../lib/captchaProvider.js';
import { ipMatchesAllowlist } from '../../lib/ipAllowlist.js';
import { logger } from '../../lib/logger.js';
import { safeStringEqual } from '../../lib/safeCompare.js';
const DEFAULT_ALLOWED_IPS = [
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
];
const pollQuerySchema = z.object({
    profileId: z.string().min(1).optional(),
    timeout: z.coerce.number().int().min(1000).max(50000).default(25000),
});
const resultBodySchema = z.object({
    profileId: z.string().min(1).optional(),
    commandId: z.string().min(1),
    token: z.string().optional(),
    error: z.string().optional(),
});
const providerBodySchema = z.object({
    provider: z.enum(['extension', 'cdp']),
});
const eventBodySchema = z.object({
    profileId: z.string().min(1).optional(),
    type: z.string().min(1),
    version: z.string().min(1).optional(),
    // Extension v1.5+ reports Flow AI tab presence in heartbeat so the renderer
    // pre-flight modal can give an authoritative red/green instead of guessing
    // from lastMintAt.
    hasFlowTab: z.boolean().optional(),
    // Extension v1.5+ `anchor_clear` event: how many _GRECAPTCHA cookies it deleted
    // (unpartitioned vs CHIPS-partitioned) so score-reset success is visible server-side.
    removed: z.number().int().min(0).optional(),
    partitionedRemoved: z.number().int().min(0).optional(),
    // Extension v1.6+: grecaptcha cookies visible before/after the clear + a sample
    // of their name@domain[partition] so we can see WHAT exists, not just a count.
    before: z.number().int().min(0).optional(),
    after: z.number().int().min(0).optional(),
    sample: z.array(z.string()).optional(),
});
function parseAllowedIps(raw) {
    if (!raw)
        return DEFAULT_ALLOWED_IPS;
    const parsed = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_IPS;
}
// Locate the secret file Electron writes at `<userData>/captcha-bridge.secret`.
// When the server runs standalone (no Electron in front), reading this file
// keeps the bridge usable across restarts without re-pairing the extension.
import { getElectronUserDataPath } from '../../lib/electronPaths.js';
function resolveBridgeSecret() {
    const envSecret = process.env.CAPTCHA_BRIDGE_SECRET;
    if (envSecret && envSecret.length >= 8) {
        return { secret: envSecret, source: 'env' };
    }
    const filePath = path.join(getElectronUserDataPath(), 'captcha-bridge.secret');
    try {
        const existing = fs.readFileSync(filePath, 'utf8').trim();
        if (existing.length >= 16) {
            process.env.CAPTCHA_BRIDGE_SECRET = existing;
            return { secret: existing, source: 'file' };
        }
    }
    catch {
        /* file missing — generate below */
    }
    const generated = crypto.randomBytes(32).toString('hex');
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, generated, { mode: 0o600 });
        fs.chmodSync(filePath, 0o600);
    }
    catch (err) {
        logger.warn(`[captcha-bridge] could not persist generated secret to ${filePath}: ${err instanceof Error ? err.message : err}`);
    }
    process.env.CAPTCHA_BRIDGE_SECRET = generated;
    return { secret: generated, source: 'generated' };
}
function buildAuthorizer(secret, allowedIps) {
    return function authorize(req, reply) {
        if (!ipMatchesAllowlist(req.ip, allowedIps)) {
            logger.warn(`[captcha-bridge] rejected from disallowed IP ${req.ip} path=${req.url}`);
            reply.code(403).send({ ok: false, error: 'source ip not allowed' });
            return false;
        }
        const header = req.headers['x-local-auth'];
        if (typeof header !== 'string' || !safeStringEqual(header, secret)) {
            reply.code(401).send({ ok: false, error: 'invalid bridge secret' });
            return false;
        }
        return true;
    };
}
export async function registerCaptchaBridgeRoutes(app) {
    registerExtensionStatusRoute(app);
    const { secret, source } = resolveBridgeSecret();
    const allowedIps = parseAllowedIps(process.env.CAPTCHA_BRIDGE_ALLOWED_IPS);
    const authorize = buildAuthorizer(secret, allowedIps);
    logger.info(`[captcha-bridge] registering internal routes (secretSource=${source}, allowedIps=${allowedIps.join(',')}, secretFile=${path.join(getElectronUserDataPath(), 'captcha-bridge.secret')})`);
    app.get('/api/internal/captcha/provider', { schema: { hide: true } }, async (req, reply) => {
        if (!authorize(req, reply))
            return;
        reply.send({ ok: true, provider: getCaptchaProvider() });
    });
    app.post('/api/internal/captcha/provider', { schema: { hide: true } }, async (req, reply) => {
        if (!authorize(req, reply))
            return;
        const parsed = providerBodySchema.safeParse(req.body);
        if (!parsed.success) {
            reply.code(400).send({ ok: false, error: parsed.error.message });
            return;
        }
        const provider = setCaptchaProvider(parsed.data.provider);
        // Boot the browser eagerly on switch so a failure surfaces here, at the
        // moment the user flips it, instead of inside the first video job.
        if (provider === 'cdp') {
            try {
                const status = await cdpEnsure();
                reply.send({ ok: true, provider, status });
                return;
            }
            catch (err) {
                reply.code(502).send({
                    ok: false,
                    provider,
                    error: err instanceof Error ? err.message : String(err),
                });
                return;
            }
        }
        // Switching to the extension provider makes the managed CDP browser
        // unnecessary. Teardown is best-effort and must not delay the response.
        void cdpClose();
        reply.send({ ok: true, provider });
    });
    app.get('/api/internal/captcha/poll', { schema: { hide: true } }, async (req, reply) => {
        if (!authorize(req, reply))
            return;
        const parsed = pollQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            reply.code(400).send({ ok: false, error: parsed.error.message });
            return;
        }
        const commands = await captchaManager.drainCommands(parsed.data.timeout);
        if (commands.length === 0) {
            reply.code(204).send();
            return;
        }
        reply.send({ commands });
    });
    app.post('/api/internal/captcha/result', { schema: { hide: true } }, async (req, reply) => {
        if (!authorize(req, reply))
            return;
        const parsed = resultBodySchema.safeParse(req.body);
        if (!parsed.success) {
            reply.code(400).send({ ok: false, error: parsed.error.message });
            return;
        }
        const matched = captchaManager.resolveCommand(parsed.data);
        if (!matched) {
            logger.warn(`[captcha-bridge] result for unknown commandId=${parsed.data.commandId}`);
        }
        reply.send({ ok: true, matched });
    });
    app.post('/api/internal/captcha/event', { schema: { hide: true } }, async (req, reply) => {
        if (!authorize(req, reply))
            return;
        const parsed = eventBodySchema.safeParse(req.body);
        if (!parsed.success) {
            reply.code(400).send({ ok: false, error: parsed.error.message });
            return;
        }
        captchaManager.recordExtensionHeartbeat({
            type: parsed.data.type,
            version: parsed.data.version,
            hasFlowTab: parsed.data.hasFlowTab,
        });
        if (parsed.data.type === 'anchor_clear') {
            const removed = parsed.data.removed ?? 0;
            const partitioned = parsed.data.partitionedRemoved ?? 0;
            const total = removed + partitioned;
            const before = parsed.data.before;
            const after = parsed.data.after;
            const sample = parsed.data.sample?.length
                ? ` [${parsed.data.sample.join(', ')}]`
                : '';
            const beforeAfter = before !== undefined ? ` before=${before} after=${after}` : '';
            if (total > 0) {
                logger.info(`[Anchor] ✅ extension cleared grecaptcha: unpartitioned=${removed} partitioned=${partitioned}${beforeAfter} ` +
                    `(ext v${parsed.data.version ?? '?'}) — reCAPTCHA score should reset after tab reload${sample}`);
            }
            else if (before === 0) {
                logger.warn(`[Anchor] ⚠️ extension saw 0 grecaptcha cookies (ext v${parsed.data.version ?? '?'}) — ` +
                    `the anchor may live on a host outside host_permissions, or the score is NOT cookie-anchored ` +
                    `(retries recover via sessionId rotation, not cookie clear).`);
            }
            else {
                logger.warn(`[Anchor] ⚠️ extension cleared 0 grecaptcha cookies but ${before ?? '?'} were present${sample} ` +
                    `(ext v${parsed.data.version ?? '?'}) — removal failed (CHIPS partitionKey mismatch?); the 403 cliff may persist.`);
            }
        }
        else {
            logger.debug(`[captcha-bridge] event type=${parsed.data.type} version=${parsed.data.version ?? '?'}`);
        }
        reply.send({ ok: true });
    });
    app.get('/api/internal/captcha/stats', { schema: { hide: true } }, async (req, reply) => {
        if (!authorize(req, reply))
            return;
        reply.send(captchaManager.stats());
    });
}
function registerExtensionStatusRoute(app) {
    app.get('/api/system/extension-status', { schema: { hide: true } }, async (_req, reply) => {
        const stats = captchaManager.stats();
        // Provider 'cdp' has no extension and therefore no heartbeat. Reporting
        // its liveness from the extension clock would leave the preflight gate
        // permanently red and block every generation, so the browser's own
        // running state stands in for it.
        const browser = stats.provider === 'cdp' ? await cdpStatus() : null;
        const liveness = stats.provider === 'cdp'
            ? browser?.running
                ? 'connected'
                : 'offline'
            : captchaManager.extensionLiveness();
        reply.send({
            provider: stats.provider,
            browser,
            connected: liveness === 'connected',
            stale: liveness === 'stale',
            offline: liveness === 'offline',
            liveness,
            lastSeenAt: stats.provider === 'cdp'
                ? browser?.running
                    ? new Date().toISOString()
                    : null
                : stats.lastExtensionSeenAt
                    ? new Date(stats.lastExtensionSeenAt).toISOString()
                    : null,
            lastMintAt: stats.lastMintAt ? new Date(stats.lastMintAt).toISOString() : null,
            lastMintDurationMs: stats.lastMintDurationMs,
            version: stats.provider === 'cdp' ? 'CDP' : stats.extensionVersion,
            // null = extension chưa report (build cũ hoặc vừa khởi động). Renderer
            // fallback proxy lastMintAt khi null.
            hasFlowTab: stats.provider === 'cdp'
                ? !!browser?.pageUrl?.startsWith('https://flow.google.com')
                : stats.hasFlowTab,
            captcha: {
                pendingCount: stats.pendingCount,
                queuedCount: stats.queuedCount,
                pollerWaitingCount: stats.pollerWaitingCount,
                consecutiveFailures: stats.consecutiveFailures,
                pendingReset: stats.pendingReset,
                mintTimeoutMs: stats.mintTimeoutMs,
            },
        });
    });
}
