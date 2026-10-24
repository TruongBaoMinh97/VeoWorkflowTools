import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { globalProxyManager } from '../../lib/GlobalProxyManager.js';
import { SocksProxyAgent } from 'socks-proxy-agent';
const settingsSchema = z.object({
    enabled: z.boolean().optional(),
    providerType: z.string().optional(),
    apiKey: z.string().optional().nullable(),
    nhamang: z.string().optional(),
    tinhthanh: z.string().optional(),
    whitelist: z.string().optional().nullable(),
    autoRotate: z.boolean().optional(),
    rotationIntervalMinutes: z.number().int().min(0).max(60).optional(),
    forbiddenThreshold: z.number().int().min(1).max(10).optional(),
    rotateOnProxyError: z.boolean().optional(),
});
function maskApiKey(key) {
    if (!key)
        return null;
    if (key.length <= 8)
        return '***';
    return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
export async function registerProxyRoutes(app) {
    app.get('/api/proxy/settings', async (_req, reply) => {
        let s = await prisma.proxySettings.findUnique({ where: { id: 1 } });
        if (!s)
            s = await prisma.proxySettings.create({ data: { id: 1 } });
        return reply.send({
            enabled: s.enabled,
            providerType: s.providerType,
            apiKeyMasked: maskApiKey(s.apiKey),
            hasApiKey: !!s.apiKey,
            nhamang: s.nhamang,
            tinhthanh: s.tinhthanh,
            whitelist: s.whitelist,
            autoRotate: s.autoRotate,
            rotationIntervalMinutes: s.rotationIntervalMinutes,
            forbiddenThreshold: s.forbiddenThreshold,
            rotateOnProxyError: s.rotateOnProxyError,
        });
    });
    app.put('/api/proxy/settings', async (req, reply) => {
        const body = settingsSchema.parse(req.body ?? {});
        const data = { ...body };
        // Don't overwrite apiKey with null if not explicitly provided
        if (body.apiKey === undefined)
            delete data.apiKey;
        await prisma.proxySettings.upsert({
            where: { id: 1 },
            update: data,
            create: { id: 1, ...data },
        });
        await globalProxyManager.invalidate();
        return reply.send({ ok: true });
    });
    app.get('/api/proxy/status', async (_req, reply) => {
        const status = await globalProxyManager.getStatus();
        return reply.send(status);
    });
    app.get('/api/proxy/keys', async (_req, reply) => {
        try {
            const keys = await globalProxyManager.fetchKeyxoayList(true);
            return reply.send({ ok: true, count: keys.length, keys });
        }
        catch (err) {
            return reply.status(500).send({ error: err?.message ?? String(err) });
        }
    });
    app.post('/api/proxy/rotate', async (_req, reply) => {
        try {
            const proxy = await globalProxyManager.forceRotate();
            if (!proxy)
                return reply.status(400).send({ error: 'Proxy disabled or no API key' });
            return reply.send({ ok: true, socks5: proxy.socks5, expiresAt: proxy.expiresAt });
        }
        catch (err) {
            return reply.status(500).send({ error: err?.message ?? String(err) });
        }
    });
    // Test by fetching a known IP-echo endpoint through current proxy
    app.post('/api/proxy/test', async (_req, reply) => {
        try {
            const proxy = await globalProxyManager.getProxy();
            if (!proxy)
                return reply.status(400).send({ error: 'Proxy disabled or unavailable' });
            const agent = new SocksProxyAgent(proxy.socks5Url);
            const res = await fetch('https://api.ipify.org?format=json', {
                // @ts-expect-error node fetch accepts agent via undici dispatcher shim
                agent,
            });
            const body = await res.json().catch(() => ({}));
            return reply.send({ ok: true, proxy: proxy.socks5, ipEcho: body });
        }
        catch (err) {
            return reply.status(500).send({ error: err?.message ?? String(err) });
        }
    });
}
