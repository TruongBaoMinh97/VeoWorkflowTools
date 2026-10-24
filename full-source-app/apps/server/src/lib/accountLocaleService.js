import { logger } from './logger.js';
const SUPPORTED_LOCALES = new Set([
    'vi', 'en', 'ja', 'ko', 'zh-CN', 'zh-TW', 'fr', 'de', 'es', 'pt', 'it',
    'nl', 'ru', 'id', 'th', 'tr', 'pl', 'ar', 'hi',
]);
export class AccountLocaleService {
    constructor() {
        this.cache = new Map();
        this.CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
        this.DETECT_TIMEOUT_MS = 10000;
    }
    /**
     * Detect Flow AI locale của account qua redirect.
     * Returns cached value nếu còn fresh, otherwise fetch mới.
     */
    async getAccountLocale(profileId, cookieHeader, userAgent, fallback = 'vi') {
        const cached = this.cache.get(profileId);
        if (cached && Date.now() - cached.detectedAt < this.CACHE_TTL_MS) {
            return cached.locale;
        }
        try {
            const locale = await this.detectViaRedirect(cookieHeader, userAgent);
            if (locale) {
                this.cache.set(profileId, { locale, detectedAt: Date.now() });
                logger.info(`✅ [AccountLocale] Detected locale for profile ${profileId}: ${locale}`);
                return locale;
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`⚠️  [AccountLocale] Detect failed for profile ${profileId}: ${message}. Using fallback: ${fallback}`);
        }
        // Cache fallback cũng để tránh spam fetch khi fail liên tục
        this.cache.set(profileId, { locale: fallback, detectedAt: Date.now() });
        return fallback;
    }
    /**
     * Trả về locale đã cache cho profile (không fetch lại). Trả undefined nếu chưa cache.
     * Dùng khi caller không có cookies trong tay nhưng cần locale (vd. reset + prewarm path).
     */
    getCachedLocale(profileId) {
        const cached = this.cache.get(profileId);
        if (!cached)
            return undefined;
        if (Date.now() - cached.detectedAt > this.CACHE_TTL_MS)
            return undefined;
        return cached.locale;
    }
    /**
     * Force refresh locale cho 1 profile (vd. sau khi cookies đổi).
     */
    clearCache(profileId) {
        if (profileId) {
            this.cache.delete(profileId);
        }
        else {
            this.cache.clear();
        }
    }
    /**
     * Core detect: fetch flow homepage không locale → đọc Location header.
     *
     * Google thường redirect 302/301 với:
     *   Location: https://labs.google/fx/{locale}/tools/flow
     *
     * Trường hợp không redirect (200 trực tiếp) → không detect được, return null.
     */
    async detectViaRedirect(cookieHeader, userAgent) {
        const url = 'https://labs.google/fx/tools/flow';
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.DETECT_TIMEOUT_MS);
        try {
            const response = await fetch(url, {
                method: 'GET',
                redirect: 'manual', // KHÔNG follow redirect — phải đọc Location
                headers: {
                    'Cookie': cookieHeader,
                    'User-Agent': userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1',
                },
                signal: controller.signal,
            });
            // Redirect status (301/302/303/307/308)
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                if (location) {
                    const fromUrl = this.extractLocaleFromUrl(location);
                    if (fromUrl)
                        return fromUrl;
                    // Google (từ 2026-09-11) 308 labs.google/fx/tools/flow → flow.google.com
                    // KHÔNG còn locale trong URL. Follow tới đích và đọc <html lang="...">.
                    // Dùng chung signal → tổng thời gian vẫn nằm trong DETECT_TIMEOUT_MS.
                    return await this.detectLocaleFromPage(location, cookieHeader, userAgent, controller.signal);
                }
            }
            // Đôi khi server trả 200 + HTML với <html lang="..."> — parse trực tiếp.
            if (response.status === 200) {
                return this.parseLangFromHtml(await response.text().catch(() => ''));
            }
            return null;
        }
        finally {
            clearTimeout(timeoutId);
        }
    }
    /** Fetch một trang (follow redirect) rồi đọc `<html lang="...">`. */
    async detectLocaleFromPage(url, cookieHeader, userAgent, signal) {
        try {
            const response = await fetch(url, {
                method: 'GET',
                redirect: 'follow',
                headers: {
                    'Cookie': cookieHeader,
                    'User-Agent': userAgent ||
                        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
                },
                signal,
            });
            if (!response.ok)
                return null;
            // `<html lang>` nằm ngay đầu tài liệu — chỉ cần vài KB đầu, không buffer
            // cả SPA HTML (có thể >500KB).
            const html = await response.text().catch(() => '');
            return this.parseLangFromHtml(html.slice(0, 4096));
        }
        catch {
            return null;
        }
    }
    /** Đọc locale từ thuộc tính `lang` của thẻ `<html>`. */
    parseLangFromHtml(html) {
        const langMatch = html.match(/<html[^>]*\blang=["']([a-zA-Z-]+)["']/i);
        if (!langMatch?.[1])
            return null;
        const lang = this.normalizeLocale(langMatch[1]);
        if (lang && SUPPORTED_LOCALES.has(lang))
            return lang;
        const short = lang?.split('-')[0];
        return short && SUPPORTED_LOCALES.has(short) ? short : null;
    }
    /**
     * Parse `/fx/{locale}/tools/flow...` từ URL.
     * Chấp nhận cả absolute và relative location.
     */
    extractLocaleFromUrl(location) {
        // Pattern: /fx/{locale}/tools/flow
        const match = location.match(/\/fx\/([a-zA-Z-]{2,6})\/tools\/flow/);
        if (!match)
            return null;
        const raw = match[1];
        const normalized = this.normalizeLocale(raw);
        if (!normalized)
            return null;
        if (SUPPORTED_LOCALES.has(normalized)) {
            return normalized;
        }
        // Thử match theo phần đầu (vd. "en-US" → "en")
        const short = normalized.split('-')[0];
        if (SUPPORTED_LOCALES.has(short)) {
            return short;
        }
        return null;
    }
    normalizeLocale(raw) {
        if (!raw)
            return null;
        const trimmed = raw.trim().toLowerCase();
        if (!trimmed)
            return null;
        // zh-CN / zh-TW giữ nguyên case region
        if (trimmed.startsWith('zh')) {
            return trimmed === 'zh-cn' ? 'zh-CN' : trimmed === 'zh-tw' ? 'zh-TW' : 'zh-CN';
        }
        return trimmed;
    }
}
export const accountLocaleService = new AccountLocaleService();
