/**
 * Tiny CIDR-aware IP allow-list check used by the captcha-bridge route guard.
 *
 * Supports:
 *   - Exact match (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`)
 *   - IPv4 CIDR (`172.28.0.0/16`)
 *
 * IPv6 CIDR is not supported; list `::1` explicitly when needed.
 */
export function ipMatchesAllowlist(ip, allowlist) {
    for (const entry of allowlist) {
        if (entry.includes('/')) {
            if (cidrMatch(ip, entry))
                return true;
        }
        else if (entry === ip) {
            return true;
        }
    }
    return false;
}
function cidrMatch(ip, cidr) {
    const [range, bitsStr] = cidr.split('/');
    const bits = Number.parseInt(bitsStr ?? '', 10);
    if (!range || Number.isNaN(bits))
        return false;
    const normalizedIp = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
    if (normalizedIp.includes('.') && range.includes('.')) {
        return ipv4InCidr(normalizedIp, range, bits);
    }
    return false;
}
function ipv4InCidr(ip, range, bits) {
    const ipNum = ipv4ToInt(ip);
    const rangeNum = ipv4ToInt(range);
    if (ipNum === null || rangeNum === null || bits < 0 || bits > 32)
        return false;
    if (bits === 0)
        return true;
    const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
    return (ipNum & mask) === (rangeNum & mask);
}
function ipv4ToInt(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4)
        return null;
    let n = 0;
    for (const part of parts) {
        const v = Number.parseInt(part, 10);
        if (Number.isNaN(v) || v < 0 || v > 255)
            return null;
        n = (n << 8) | v;
    }
    return n >>> 0;
}
