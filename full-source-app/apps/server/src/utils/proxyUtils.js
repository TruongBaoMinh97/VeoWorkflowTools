/**
 * Proxy Utils - Parse, validate, encrypt/decrypt proxy configurations
 *
 * Supported proxy formats:
 * 1. host:port:username:password (standard)
 * 2. username:password@host:port (URL-style)
 * 3. host:port (no auth)
 *
 * Example: proxy02058.proxydancu.org:19541:6gn4:1766985303
 * Example: r0s8:r0s8@171.236.42.237:37744
 */
import crypto from 'crypto';
import os from 'os';
/**
 * Load HttpsProxyAgent constructor, handling both ESM and CJS interop.
 * https-proxy-agent@7.x is ESM-only; when compiled to CJS, the module shape
 * can be `{ HttpsProxyAgent }`, `{ default: { HttpsProxyAgent } }`, or
 * `{ default: HttpsProxyAgent }` depending on bundler / tsconfig.
 */
export async function loadHttpsProxyAgent() {
    const mod = await import('https-proxy-agent');
    const Ctor = mod.HttpsProxyAgent ??
        mod.default?.HttpsProxyAgent ??
        (typeof mod.default === 'function' ? mod.default : undefined);
    if (typeof Ctor !== 'function') {
        throw new Error('Failed to load HttpsProxyAgent constructor from https-proxy-agent');
    }
    return Ctor;
}
// Derive encryption key from machine-specific data
// This ensures proxy passwords are encrypted but portable within same machine
function getEncryptionKey() {
    const machineInfo = [
        os.hostname(),
        os.platform(),
        os.arch(),
        os.cpus()[0]?.model || 'unknown',
    ].join('|');
    // Create 32-byte key using SHA-256
    return crypto.createHash('sha256').update(machineInfo).digest();
}
/**
 * Encrypt proxy password
 * NOTE: Now stores plain text for simplicity (local tool, no security concern)
 */
export function encryptPassword(password) {
    if (!password)
        return '';
    // Store plain text - no encryption needed for local tool
    return password;
}
/**
 * Decrypt proxy password
 * NOTE: Now returns plain text directly (local tool, no security concern)
 */
export function decryptPassword(encryptedPassword) {
    if (!encryptedPassword)
        return '';
    // Return as-is - no decryption needed for local tool
    return encryptedPassword;
}
/**
 * Parse proxy string into components
 * Supports multiple formats:
 * 1. host:port:username:password (standard - 4 colons)
 * 2. username:password@host:port (URL-style with @)
 * 3. host:port (no auth - 2 parts)
 *
 * Examples:
 * - 171.236.42.237:37744:r0s8:r0s8
 * - r0s8:r0s8@171.236.42.237:37744
 * - 171.236.42.237:37744
 */
export function parseProxyString(proxyString) {
    if (!proxyString || !proxyString.trim())
        return null;
    const proxy = proxyString.trim();
    // Format 2: username:password@host:port (URL-style)
    if (proxy.includes('@')) {
        const atIndex = proxy.lastIndexOf('@');
        const authPart = proxy.substring(0, atIndex);
        const hostPart = proxy.substring(atIndex + 1);
        // Parse auth: username:password
        const authColonIndex = authPart.indexOf(':');
        if (authColonIndex === -1)
            return null;
        const username = authPart.substring(0, authColonIndex);
        const password = authPart.substring(authColonIndex + 1);
        // Parse host:port
        const hostColonIndex = hostPart.lastIndexOf(':');
        if (hostColonIndex === -1)
            return null;
        const host = hostPart.substring(0, hostColonIndex);
        const port = parseInt(hostPart.substring(hostColonIndex + 1), 10);
        // Validate
        if (!host || host.length === 0)
            return null;
        if (isNaN(port) || port < 1 || port > 65535)
            return null;
        if (!username || username.length === 0)
            return null;
        if (!password || password.length === 0)
            return null;
        return { host, port, username, password };
    }
    // Format 1 & 3: Split by colon
    const parts = proxy.split(':');
    // Format 3: host:port (no auth)
    if (parts.length === 2) {
        const [host, portStr] = parts;
        const port = parseInt(portStr, 10);
        if (!host || host.length === 0)
            return null;
        if (isNaN(port) || port < 1 || port > 65535)
            return null;
        return { host, port, username: '', password: '' };
    }
    // Format 1: host:port:username:password (standard - exactly 4 parts)
    if (parts.length === 4) {
        const [host, portStr, username, password] = parts;
        const port = parseInt(portStr, 10);
        if (!host || host.length === 0)
            return null;
        if (isNaN(port) || port < 1 || port > 65535)
            return null;
        if (!username || username.length === 0)
            return null;
        if (!password || password.length === 0)
            return null;
        return { host, port, username, password };
    }
    // Format 1 extended: If more than 4 parts, assume password contains colons
    // host:port:username:pass:word:with:colons
    if (parts.length > 4) {
        const host = parts[0];
        const port = parseInt(parts[1], 10);
        const username = parts[2];
        const password = parts.slice(3).join(':'); // Join remaining parts as password
        if (!host || host.length === 0)
            return null;
        if (isNaN(port) || port < 1 || port > 65535)
            return null;
        if (!username || username.length === 0)
            return null;
        if (!password || password.length === 0)
            return null;
        return { host, port, username, password };
    }
    return null;
}
/**
 * Normalize proxy string to standard format: host:port:username:password
 * Accepts any supported format and converts to standard
 */
export function normalizeProxyString(proxyString) {
    const parsed = parseProxyString(proxyString);
    if (!parsed)
        return null;
    if (parsed.username && parsed.password) {
        return `${parsed.host}:${parsed.port}:${parsed.username}:${parsed.password}`;
    }
    return `${parsed.host}:${parsed.port}`;
}
/**
 * Build proxy string from components
 * Format: host:port:username:password
 */
export function buildProxyString(config) {
    if (!config.proxyHost || !config.proxyPort || !config.proxyUsername || !config.proxyPassword) {
        return null;
    }
    // Password is stored plain text now, use directly
    return `${config.proxyHost}:${config.proxyPort}:${config.proxyUsername}:${config.proxyPassword}`;
}
/**
 * Validate proxy string format
 * Supports multiple formats:
 * 1. host:port:username:password
 * 2. username:password@host:port
 * 3. host:port (no auth)
 * Returns { valid: boolean, error?: string, normalized?: string }
 */
export function validateProxyFormat(proxyString) {
    if (!proxyString || !proxyString.trim()) {
        return { valid: true }; // Empty is valid (no proxy)
    }
    const parsed = parseProxyString(proxyString.trim());
    if (!parsed) {
        return {
            valid: false,
            error: 'Invalid format. Supported formats:\n• host:port:username:password\n• username:password@host:port\n• host:port (no auth)'
        };
    }
    // Validate host
    if (!parsed.host || parsed.host.length === 0) {
        return { valid: false, error: 'Proxy host is required' };
    }
    // Validate port
    if (isNaN(parsed.port) || parsed.port < 1 || parsed.port > 65535) {
        return { valid: false, error: 'Port must be a number between 1 and 65535' };
    }
    // Return normalized format
    const normalized = normalizeProxyString(proxyString.trim());
    return { valid: true, normalized: normalized || undefined };
}
/**
 * Build proxy URL for Electron session.setProxy()
 * Format: http://username:password@host:port
 */
export function buildProxyUrl(config) {
    if (!config.proxyHost || !config.proxyPort) {
        return null;
    }
    // Decrypt password if it's encrypted
    let password = config.proxyPassword || '';
    if (password.includes(':')) {
        password = decryptPassword(password);
    }
    const username = config.proxyUsername || '';
    // If we have auth credentials, include them in URL
    if (username && password) {
        // URL encode username and password in case they contain special characters
        const encodedUser = encodeURIComponent(username);
        const encodedPass = encodeURIComponent(password);
        return `http://${encodedUser}:${encodedPass}@${config.proxyHost}:${config.proxyPort}`;
    }
    // No auth
    return `http://${config.proxyHost}:${config.proxyPort}`;
}
/**
 * Resolve the effective proxy URL for server-side HTTP clients.
 *
 * Priority:
 *   1. Global rotating proxy (SOCKS5 preferred; HTTP variant as dispatcher-compat fallback)
 *   2. Profile's static proxy (legacy per-profile fallback)
 *
 * Returns HTTP proxy URL (http://host:port) because undici.ProxyAgent and
 * HttpsProxyAgent don't speak SOCKS5. proxyxoay returns BOTH variants; we use
 * the http one for server fetch/axios while Electron browser uses socks5.
 */
export async function getActiveProxyUrl(fallbackStatic) {
    try {
        const { globalProxyManager } = await import('../lib/GlobalProxyManager.js');
        const proxy = await globalProxyManager.getProxy();
        if (proxy && proxy.http) {
            return `http://${proxy.http}`;
        }
    }
    catch {
        // Manager unavailable — fall through to static
    }
    if (!fallbackStatic)
        return null;
    return buildProxyUrl(fallbackStatic);
}
/**
 * Convert ParsedProxy to ProxyConfig for database storage
 * Encrypts password before storage
 */
export function toProxyConfig(parsed) {
    if (!parsed) {
        return {
            proxyHost: null,
            proxyPort: null,
            proxyUsername: null,
            proxyPassword: null,
        };
    }
    return {
        proxyHost: parsed.host,
        proxyPort: parsed.port,
        proxyUsername: parsed.username,
        proxyPassword: encryptPassword(parsed.password),
    };
}
/**
 * Test proxy connection by making request through proxy
 * Returns { success: boolean, message: string, ip?: string }
 */
export async function testProxyConnection(proxyString) {
    const parsed = parseProxyString(proxyString);
    if (!parsed) {
        return {
            success: false,
            message: 'Invalid proxy format. Use: host:port:username:password'
        };
    }
    const startTime = Date.now();
    try {
        // Use https-proxy-agent to test connection
        const HttpsProxyAgent = await loadHttpsProxyAgent();
        const proxyUrl = `http://${parsed.username}:${parsed.password}@${parsed.host}:${parsed.port}`;
        const agent = new HttpsProxyAgent(proxyUrl);
        // Test connection by fetching IP check service
        const response = await fetch('https://api.ipify.org?format=json', {
            agent: agent,
            signal: AbortSignal.timeout(15000), // 15 second timeout
        });
        if (!response.ok) {
            return {
                success: false,
                message: `Proxy returned error: HTTP ${response.status}`,
            };
        }
        const data = await response.json();
        const latencyMs = Date.now() - startTime;
        return {
            success: true,
            message: `Proxy working! Your IP: ${data.ip}`,
            ip: data.ip,
            latencyMs,
        };
    }
    catch (error) {
        const latencyMs = Date.now() - startTime;
        // Handle specific error types
        if (error.code === 'ECONNREFUSED') {
            return {
                success: false,
                message: `Connection refused. Check proxy host:port (${parsed.host}:${parsed.port})`,
            };
        }
        if (error.code === 'ETIMEDOUT' || error.name === 'TimeoutError') {
            return {
                success: false,
                message: `Connection timeout after ${latencyMs}ms. Proxy may be slow or blocked.`,
            };
        }
        if (error.code === 'ENOTFOUND') {
            return {
                success: false,
                message: `Host not found: ${parsed.host}`,
            };
        }
        if (error.message?.includes('407') || error.message?.includes('Proxy Authentication Required')) {
            return {
                success: false,
                message: 'Authentication failed. Check username/password.',
            };
        }
        return {
            success: false,
            message: `Connection failed: ${error.message || 'Unknown error'}`,
        };
    }
}
