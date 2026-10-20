/**
 * Central source of UA / sec-ch-ua strings derived from the host Chrome version.
 *
 * Electron injects VEO3_CHROME_FULL and VEO3_CHROME_MAJOR into the server child
 * process before startup. Standalone server runs use a generic fallback instead.
 */
const FALLBACK_FULL = '148.0.0.0';
let cache = null;
let platformOverride = null;

/** Reset the lazy cache and optionally override process.platform in tests. */
export function __resetForTest(opts) {
    cache = null;
    platformOverride = typeof opts?.platform === 'string' ? opts.platform : null;
}

function resolveFullVersion() {
    const full = process.env.VEO3_CHROME_FULL ?? '';
    if (/^\d+\.\d+\.\d+\.\d+$/.test(full))
        return full;
    const major = Number.parseInt(process.env.VEO3_CHROME_MAJOR ?? '', 10);
    if (Number.isFinite(major) && major > 0)
        return `${major}.0.0.0`;
    return FALLBACK_FULL;
}

function resolvePlatform() {
    const platform = platformOverride ?? process.platform;
    if (platform === 'win32')
        return '"Windows"';
    if (platform === 'linux')
        return '"Linux"';
    return '"macOS"';
}

function buildUa(platform, full) {
    if (platform === '"Windows"') {
        return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`;
    }
    if (platform === '"Linux"') {
        return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`;
    }
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`;
}

/** Build the `sec-ch-ua` brand string for an arbitrary Chrome major. */
export function buildSecChUaForMajor(major) {
    const notABrand = major >= 129 ? '"Not(A:Brand";v="99"' : '"Not_A Brand";v="8"';
    return `"Chromium";v="${major}", "Google Chrome";v="${major}", ${notABrand}`;
}

function compute() {
    if (cache)
        return cache;
    const full = resolveFullVersion();
    const major = Number.parseInt(full.split('.')[0], 10);
    const platform = resolvePlatform();
    cache = {
        full,
        major,
        ua: buildUa(platform, full),
        secChUa: buildSecChUaForMajor(major),
        platform,
    };
    return cache;
}

export function getHostUa() {
    return compute().ua;
}

export function getHostSecChUa() {
    return compute().secChUa;
}

export function getHostSecChUaPlatform() {
    return compute().platform;
}

export function getHostChromeMajor() {
    return compute().major;
}
