/**
 * GlobalProxyManager — single rotating SOCKS5 proxy shared by all profiles + HTTP clients.
 *
 * Policy:
 * - One proxy globally at a time (provider: proxyxoay.shop).
 * - Single-flight: concurrent getProxy() calls collapse to one upstream fetch.
 * - minIntervalMs = 60_000 between rotate calls (protects against status=102).
 * - Proactive refresh: 3 consecutive 403s OR remaining TTL < 90s.
 * - Emits 'rotated' with new proxy so browser sessions + HTTP agents can swap.
 */
import { EventEmitter } from 'events';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
const MIN_ROTATE_INTERVAL_MS = 60000; // 60s between upstream API calls
const EXPIRY_BUFFER_MS = 90000; // refresh when < 90s remains
const DEFAULT_FORBIDDEN_THRESHOLD = 3; // default 3x 403 triggers rotate
/** Parse "HH:MM DD-MM-YY" → Date (local tz). Returns epoch 0 on parse failure. */
function parseTopproxyExpired(raw) {
    const m = /^(\d{1,2}):(\d{1,2})\s+(\d{1,2})-(\d{1,2})-(\d{2,4})$/.exec(raw.trim());
    if (!m)
        return new Date(0);
    const [, hh, mm, dd, mon, yyRaw] = m;
    const year = yyRaw.length === 2 ? 2000 + parseInt(yyRaw, 10) : parseInt(yyRaw, 10);
    return new Date(year, parseInt(mon, 10) - 1, parseInt(dd, 10), parseInt(hh, 10), parseInt(mm, 10));
}
class GlobalProxyManagerImpl extends EventEmitter {
    constructor() {
        super(...arguments);
        this.current = null;
        this.currentAgent = null;
        this.inflight = null;
        this.lastFetchAt = 0;
        this.forbiddenHits = 0;
        this.lastError = null;
        this.backoffMs = 0;
        this.proactiveTimer = null;
        this.periodicRotationTimer = null;
        /** Cached list of rotating keys from topproxy.vn, with their own expiries. */
        this.keyxoayCache = [];
        this.keyxoayCacheAt = 0;
        this.KEYXOAY_CACHE_TTL_MS = 5 * 60000; // 5 min
        /** True if global rotating proxy is enabled (from loaded settings cache). */
        this._enabledCached = false;
    }
    /**
     * Temporary kill-switch: set `PROXY_MANAGER_DISABLED=1` to short-circuit
     * every public entry point. Useful when the upstream rotation API
     * (keyxoay / proxyxoay) is degraded — the manager would otherwise burn
     * 403 streaks trying to rotate a key that no longer exists.
     */
    isDisabled() {
        const raw = process.env.PROXY_MANAGER_DISABLED;
        return raw === '1' || /^true$/i.test(String(raw ?? ''));
    }
    async init() {
        if (this.isDisabled()) {
            logger.warn('[ProxyManager] disabled via PROXY_MANAGER_DISABLED=1 — skipping init');
            return;
        }
        // Restore cached proxy from DB if still valid
        const settings = await this.loadSettings();
        if (settings?.currentSocks5 &&
            settings.currentExpiresAt &&
            settings.currentExpiresAt.getTime() > Date.now() + EXPIRY_BUFFER_MS) {
            this.current = {
                http: settings.currentHttp || '',
                socks5: settings.currentSocks5,
                socks5Url: `socks5://${settings.currentSocks5}`,
                expiresAt: settings.currentExpiresAt,
            };
            this.currentAgent = new SocksProxyAgent(this.current.socks5Url);
            logger.info('[ProxyManager] Restored cached proxy', { expiresAt: this.current.expiresAt });
        }
        await this.refreshEnabledCache();
        this.startProactiveTimer();
        await this.restartPeriodicRotation();
    }
    /** Returns current proxy, fetching if needed. Returns null if disabled. */
    async getProxy() {
        if (this.isDisabled())
            return null;
        const settings = await this.loadSettings();
        if (!settings?.enabled || !settings.apiKey)
            return null;
        if (this.current && this.current.expiresAt.getTime() > Date.now() + EXPIRY_BUFFER_MS) {
            return this.current;
        }
        return this.rotate();
    }
    /** Returns SOCKS5 agent bound to current proxy (for http.Agent/axios). */
    getAgent() {
        return this.currentAgent;
    }
    /** Get socks5 rule string for Electron session.setProxy(). */
    getSocks5Rule() {
        return this.current ? `socks5://${this.current.socks5}` : null;
    }
    /** Sync getter for server HTTP clients — returns http://host:port or null. */
    getCurrentHttpProxyUrl() {
        if (!this.current || !this.current.http)
            return null;
        if (this.current.expiresAt.getTime() <= Date.now())
            return null;
        return `http://${this.current.http}`;
    }
    async refreshEnabledCache() {
        const s = await this.loadSettings();
        this._enabledCached = !!s?.enabled;
    }
    isEnabled() {
        return this._enabledCached;
    }
    /** Force a rotation. Respects minInterval + single-flight. */
    async forceRotate() {
        if (this.isDisabled())
            return null;
        const settings = await this.loadSettings();
        if (!settings?.enabled || !settings.apiKey)
            return null;
        return this.rotate();
    }
    /** Call this when an HTTP request returns 403 through the proxy. */
    async reportForbidden() {
        if (this.isDisabled())
            return;
        this.forbiddenHits += 1;
        const settings = await this.loadSettings();
        const threshold = settings?.forbiddenThreshold ?? DEFAULT_FORBIDDEN_THRESHOLD;
        logger.warn('[ProxyManager] 403 reported', { count: this.forbiddenHits, threshold });
        if (this.forbiddenHits >= threshold) {
            this.forbiddenHits = 0;
            logger.info(`[ProxyManager] Threshold (${threshold}) reached → rotating`);
            try {
                await this.rotate();
            }
            catch (err) {
                logger.error('[ProxyManager] forced rotate failed', { err: String(err) });
            }
        }
    }
    /** Call this when proxy connection itself fails (ECONNREFUSED, ETIMEOUT, etc.). */
    async reportProxyError() {
        const settings = await this.loadSettings();
        if (!settings?.rotateOnProxyError)
            return;
        logger.warn('[ProxyManager] Proxy error → auto-rotating (rotateOnProxyError=true)');
        try {
            await this.rotate();
        }
        catch (err) {
            logger.error('[ProxyManager] proxy-error rotate failed', { err: String(err) });
        }
    }
    resetForbiddenHits() {
        this.forbiddenHits = 0;
    }
    async getStatus() {
        const settings = await this.loadSettings();
        const ttlSeconds = this.current
            ? Math.max(0, Math.floor((this.current.expiresAt.getTime() - Date.now()) / 1000))
            : 0;
        return {
            enabled: !!settings?.enabled,
            hasProxy: !!this.current,
            http: this.current?.http ?? null,
            socks5: this.current?.socks5 ?? null,
            expiresAt: this.current?.expiresAt.toISOString() ?? null,
            ttlSeconds,
            lastError: this.lastError,
            forbiddenHits: this.forbiddenHits,
        };
    }
    /** Clear cache — called when settings change (key/nhamang/etc.). */
    async invalidate() {
        this.current = null;
        this.currentAgent = null;
        this.forbiddenHits = 0;
        await this.refreshEnabledCache();
        await this.restartPeriodicRotation();
        this.emit('invalidated');
    }
    async rotate() {
        if (this.inflight)
            return this.inflight;
        const sinceLast = Date.now() - this.lastFetchAt;
        if (sinceLast < MIN_ROTATE_INTERVAL_MS) {
            const wait = MIN_ROTATE_INTERVAL_MS - sinceLast;
            // If we have a non-expired proxy, return it rather than wait
            if (this.current && this.current.expiresAt.getTime() > Date.now()) {
                logger.debug('[ProxyManager] within minInterval, returning current', { waitMs: wait });
                return this.current;
            }
            // Otherwise wait out the interval
            logger.info('[ProxyManager] within minInterval, waiting', { waitMs: wait });
            await new Promise((r) => setTimeout(r, wait));
        }
        this.inflight = this.fetchFromProvider()
            .then((proxy) => {
            this.current = proxy;
            this.currentAgent = new SocksProxyAgent(proxy.socks5Url);
            this.lastError = null;
            this.forbiddenHits = 0;
            this.backoffMs = 0;
            this.emit('rotated', proxy);
            logger.info('[ProxyManager] rotated', {
                socks5: proxy.socks5,
                expiresAt: proxy.expiresAt,
            });
            return proxy;
        })
            .catch(async (err) => {
            this.lastError = err?.message ?? String(err);
            // Exponential backoff up to 120s
            this.backoffMs = Math.min(120000, Math.max(5000, this.backoffMs * 3 || 5000));
            logger.error('[ProxyManager] rotate failed', { err: this.lastError, backoffMs: this.backoffMs });
            throw err;
        })
            .finally(() => {
            this.lastFetchAt = Date.now();
            this.inflight = null;
        });
        return this.inflight;
    }
    /**
     * Fetch list of rotating keys from topproxy.vn using master API key.
     * Cached 5 min to avoid spam. Returns only keys not yet expired.
     */
    async fetchKeyxoayList(force = false) {
        if (!force && Date.now() - this.keyxoayCacheAt < this.KEYXOAY_CACHE_TTL_MS) {
            return this.keyxoayCache;
        }
        const settings = await this.loadSettings();
        if (!settings?.apiKey)
            throw new Error('Master API key not configured');
        const url = new URL('https://topproxy.vn/proxyxoay/apigetkeyxoay.php');
        url.searchParams.set('key', settings.apiKey);
        const res = await fetch(url.toString(), { method: 'GET' });
        if (!res.ok)
            throw new Error(`Topproxy HTTP ${res.status}`);
        // Response can be a stream of multiple JSON objects OR a single object.
        const text = await res.text();
        const entries = [];
        // Match each {...} block
        const blocks = text.match(/\{[^{}]*\}/g) || [];
        for (const block of blocks) {
            try {
                const obj = JSON.parse(block);
                if (obj.status === 100 && obj.keyxoay) {
                    entries.push({ keyxoay: obj.keyxoay, expired: obj.expired ?? '' });
                }
                else if (obj.status === 101) {
                    throw new Error(obj.comen ?? 'master key does not exist');
                }
            }
            catch (err) {
                if (err instanceof SyntaxError)
                    continue;
                throw err;
            }
        }
        const now = Date.now();
        const valid = entries.filter((e) => {
            const exp = parseTopproxyExpired(e.expired);
            return exp.getTime() > now;
        });
        this.keyxoayCache = valid;
        this.keyxoayCacheAt = now;
        logger.info('[ProxyManager] keyxoay list refreshed', { total: entries.length, valid: valid.length });
        return valid;
    }
    async fetchFromProvider() {
        const settings = await this.loadSettings();
        if (!settings?.apiKey)
            throw new Error('API key not configured');
        // Resolve list of candidate keyxoay based on providerType:
        //  - "proxyxoay"        → user's apiKey IS the keyxoay, use directly
        //  - "topproxy-master"  → fetch list of keyxoay from topproxy.vn via master key
        let keys;
        if (settings.providerType === 'topproxy-master') {
            keys = await this.fetchKeyxoayList().catch((err) => {
                throw new Error(`Load keyxoay list failed: ${err?.message ?? err}`);
            });
            if (keys.length === 0)
                keys = await this.fetchKeyxoayList(true);
            if (keys.length === 0)
                throw new Error('No valid keyxoay available');
        }
        else {
            // Direct mode — the apiKey IS the keyxoay
            keys = [{ keyxoay: settings.apiKey, expired: '' }];
        }
        // Try each keyxoay until one returns a proxy.
        let data = null;
        let lastMsg = '';
        for (const entry of keys) {
            const url = new URL('https://proxyxoay.shop/api/get.php');
            url.searchParams.set('key', entry.keyxoay);
            url.searchParams.set('nhamang', settings.nhamang || 'random');
            url.searchParams.set('tinhthanh', settings.tinhthanh || '0');
            if (settings.whitelist)
                url.searchParams.set('whitelist', settings.whitelist);
            const res = await fetch(url.toString(), { method: 'GET' });
            if (!res.ok) {
                lastMsg = `HTTP ${res.status}`;
                continue;
            }
            const body = (await res.json());
            if (body.status === 100 && body.proxysocks5) {
                data = body;
                break;
            }
            lastMsg = `status=${body.status} msg=${body.message ?? ''}`;
            // 101 = key expired → drop from cache; 102 = too fast → try next
            if (body.status === 101) {
                this.keyxoayCache = this.keyxoayCache.filter((k) => k.keyxoay !== entry.keyxoay);
            }
        }
        if (!data || !data.proxysocks5) {
            throw new Error(`All keyxoay failed: ${lastMsg}`);
        }
        // proxysocks5 format: "ip:port::" (trailing empty user:pass). Keep only ip:port.
        const socks5 = data.proxysocks5.split(':').slice(0, 2).join(':');
        const http = (data.proxyhttp || '').split(':').slice(0, 2).join(':');
        // Derive expiry from message "proxy nay se die sau NNNs", fallback 25 min.
        const match = /(\d+)\s*s/.exec(data.message || '');
        const ttlSec = match ? parseInt(match[1], 10) : 1500;
        const expiresAt = new Date(Date.now() + ttlSec * 1000);
        const proxy = {
            http,
            socks5,
            socks5Url: `socks5://${socks5}`,
            expiresAt,
        };
        await prisma.proxySettings.update({
            where: { id: 1 },
            data: {
                currentHttp: http,
                currentSocks5: socks5,
                currentExpiresAt: expiresAt,
                lastFetchAt: new Date(),
                lastRotateError: null,
            },
        }).catch((e) => {
            logger.warn('[ProxyManager] could not persist proxy', { err: String(e) });
        });
        return proxy;
    }
    async loadSettings() {
        try {
            let settings = await prisma.proxySettings.findUnique({ where: { id: 1 } });
            if (!settings) {
                settings = await prisma.proxySettings.create({ data: { id: 1 } });
            }
            return settings;
        }
        catch (e) {
            logger.error('[ProxyManager] loadSettings failed', { err: String(e) });
            return null;
        }
    }
    /** Start/restart periodic rotation timer based on rotationIntervalMinutes setting. */
    async restartPeriodicRotation() {
        if (this.periodicRotationTimer) {
            clearInterval(this.periodicRotationTimer);
            this.periodicRotationTimer = null;
        }
        const settings = await this.loadSettings();
        const intervalMinutes = settings?.rotationIntervalMinutes ?? 0;
        if (!settings?.enabled || !settings?.autoRotate || intervalMinutes <= 0)
            return;
        const intervalMs = intervalMinutes * 60000;
        logger.info(`[ProxyManager] ⏰ Periodic rotation: every ${intervalMinutes}m`);
        this.periodicRotationTimer = setInterval(async () => {
            try {
                const s = await this.loadSettings();
                if (!s?.enabled || !s?.autoRotate)
                    return;
                logger.info(`[ProxyManager] ⏰ Periodic rotation triggered (interval=${intervalMinutes}m)`);
                await this.rotate().catch(() => { });
            }
            catch { /* swallow */ }
        }, intervalMs);
    }
    startProactiveTimer() {
        if (this.proactiveTimer)
            return;
        this.proactiveTimer = setInterval(async () => {
            try {
                const settings = await this.loadSettings();
                if (!settings?.enabled || !settings.autoRotate)
                    return;
                if (!this.current)
                    return;
                const remaining = this.current.expiresAt.getTime() - Date.now();
                if (remaining < EXPIRY_BUFFER_MS) {
                    logger.info('[ProxyManager] proactive refresh (near expiry)');
                    await this.rotate().catch(() => { });
                }
            }
            catch {
                /* swallow */
            }
        }, 30000);
    }
}
export const globalProxyManager = new GlobalProxyManagerImpl();
