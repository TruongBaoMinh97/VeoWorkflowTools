/**
 * Veo3 Proxy Agent Manager
 * Manages proxy agent creation, caching, and eviction for Veo3 API requests
 */
import { logger } from '../../lib/logger.js';
import { loadHttpsProxyAgent } from '../../utils/proxyUtils.js';
import { ProxyAgent as UndiciProxyAgent } from 'undici';
// Eager-load HttpsProxyAgent constructor once at module init
let _HttpsProxyAgentCtor = null;
loadHttpsProxyAgent()
    .then(ctor => { _HttpsProxyAgentCtor = ctor; })
    .catch(err => logger.error('[Veo3ProxyManager] Failed to preload HttpsProxyAgent:', err));
/**
 * Cache ProxyAgentPair by proxyUrl to reuse — static proxies don't need rebuild.
 * Prevents socket pool exhaustion from creating new UndiciProxyAgent instances
 * on every updateConfig call (10+ concurrent jobs same profile → fetch failed).
 */
const proxyAgentCache = new Map();
export function buildProxyAgents(proxyUrl) {
    const cached = proxyAgentCache.get(proxyUrl);
    if (cached)
        return cached;
    try {
        const dispatcher = new UndiciProxyAgent({
            uri: proxyUrl,
            keepAliveTimeout: 10000,
            keepAliveMaxTimeout: 30000,
            connections: 8,
            bodyTimeout: 90000,
            headersTimeout: 60000,
        });
        let httpAgent = null;
        if (_HttpsProxyAgentCtor) {
            httpAgent = new _HttpsProxyAgentCtor(proxyUrl);
        }
        const pair = { httpAgent, dispatcher };
        proxyAgentCache.set(proxyUrl, pair);
        logger.info(`[Veo3ProxyManager] Built & cached proxy agent for ${new URL(proxyUrl).host} (total cached: ${proxyAgentCache.size})`);
        return pair;
    }
    catch (err) {
        logger.error('[Veo3ProxyManager] Failed to build proxy agents:', err?.message || err);
        return null;
    }
}
/** Close and evict agent when proxy URL changes (rotate) or profile is disabled. */
export function evictProxyAgent(proxyUrl) {
    const pair = proxyAgentCache.get(proxyUrl);
    if (!pair)
        return;
    proxyAgentCache.delete(proxyUrl);
    try {
        pair.dispatcher?.close?.();
    }
    catch (err) {
        logger.warn(`[Veo3ProxyManager] Failed to close dispatcher for ${proxyUrl}:`, err?.message || err);
    }
}
/** Global inter-profile submit jitter to avoid synchronized-timing bot patterns. */
let __lastGlobalSubmitAt = 0;
const GLOBAL_MIN_GAP_MS = 300;
const GLOBAL_MAX_GAP_MS = 800;
export async function applyInterProfileJitter() {
    const now = Date.now();
    const sinceLast = now - __lastGlobalSubmitAt;
    if (sinceLast < GLOBAL_MIN_GAP_MS) {
        const jitter = Math.floor(Math.random() * (GLOBAL_MAX_GAP_MS - GLOBAL_MIN_GAP_MS + 1)) + GLOBAL_MIN_GAP_MS;
        const waitMs = jitter - sinceLast;
        if (waitMs > 0)
            await new Promise(r => setTimeout(r, waitMs));
    }
    __lastGlobalSubmitAt = Date.now();
}
