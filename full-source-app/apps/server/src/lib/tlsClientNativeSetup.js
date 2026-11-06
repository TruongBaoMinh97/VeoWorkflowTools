/**
 * Seed node-tls-client's native shared library from the app bundle into the
 * OS temp dir BEFORE node-tls-client loads.
 *
 * node-tls-client (bogdanfinn/tls-client) ships no binary — at runtime it
 * downloads `tls-client-<plat>.<ext>` from GitHub releases into `os.tmpdir()`
 * and then reuses whatever file is already there WITHOUT any integrity check.
 * That design has bitten us twice:
 *   1. On networks that throttle/block GitHub the download fails → server can't
 *      start the TLS lane at all.
 *   2. A corrupt/partial cached file (interrupted download, AV tampering, a temp
 *      cleanup that truncates it) is silently reused → `koffi.load` crashes the
 *      server child with "Failed to load shared library" and there is NO
 *      self-recovery (it only re-downloads when the file is MISSING, never when
 *      it is present-but-broken).
 *
 * We ship the correct lib for every platform inside the app
 * (`resources/server/binaries/tls-client/`) and copy the matching one into
 * `os.tmpdir()` here, overwriting a missing or wrong-sized cache. This removes
 * the runtime GitHub download entirely and self-heals a corrupt cache. It is
 * best-effort: on any failure we leave node-tls-client to its own download path.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Electron sets process.resourcesPath on the spawned server child (it runs via
// ELECTRON_RUN_AS_NODE); plain Node leaves it undefined.
const electronProcess = process;
const require = createRequire(import.meta.url);
function nodeTlsClientVersion() {
    try {
        return require('node-tls-client/package.json').version ?? null;
    }
    catch {
        return null;
    }
}
/**
 * The exact filename node-tls-client's `LibraryHandler.retrieveFileInfo()` loads
 * from `os.tmpdir()` for the current platform/arch. MUST stay in sync with
 * node-tls-client (see its `dist/utils/native.js`).
 */
function tmpLibFileName() {
    const version = nodeTlsClientVersion();
    if (!version)
        return null;
    const map = {
        win32: { x64: 'windows-amd64.dll', ia32: 'windows-386.dll' },
        darwin: { arm64: 'darwin-arm64.dylib', x64: 'darwin-amd64.dylib' },
        linux: { x64: 'linux-amd64.so', arm64: 'linux-arm64.so' },
    };
    const platformName = map[process.platform]?.[process.arch];
    return platformName ? `tls-client-${version}-${platformName}` : null;
}
/** Locate the bundled lib across packaged (resources) and dev layouts. */
function findBundledLib(fileName) {
    const resourcesPath = electronProcess.resourcesPath || '';
    const candidates = [
        path.join(resourcesPath, 'server', 'binaries', 'tls-client', fileName),
        path.join(__dirname, '..', '..', 'binaries', 'tls-client', fileName), // dist/lib → server root
        path.join(__dirname, '..', 'binaries', 'tls-client', fileName),
        path.join(process.cwd(), 'binaries', 'tls-client', fileName),
        path.join(path.dirname(process.execPath), 'resources', 'server', 'binaries', 'tls-client', fileName),
    ];
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate))
                return candidate;
        }
        catch {
            /* ignore and try next */
        }
    }
    return null;
}
/**
 * Copy the bundled native lib into `os.tmpdir()` if it is missing or differs in
 * size from the bundled copy. Synchronous and idempotent — safe to call right
 * before `import('node-tls-client')`. Never throws.
 */
export function ensureBundledTlsLibrary() {
    try {
        const fileName = tmpLibFileName();
        if (!fileName) {
            logger.warn(`[TlsClient] No bundled lib mapping for ${process.platform}/${process.arch}; runtime download will be used`);
            return;
        }
        const bundled = findBundledLib(fileName);
        if (!bundled) {
            logger.warn(`[TlsClient] Bundled native lib ${fileName} not found in app; falling back to runtime download`);
            return;
        }
        const dest = path.join(os.tmpdir(), fileName);
        const bundledSize = fs.statSync(bundled).size;
        let needCopy = true;
        try {
            // Same size ⇒ the good bundled copy is already seeded. A corrupt/partial
            // download almost always differs in size, and matching lets us skip the
            // multi-MB copy on every boot once seeded.
            if (fs.statSync(dest).size === bundledSize)
                needCopy = false;
        }
        catch {
            /* dest missing ⇒ copy */
        }
        if (needCopy) {
            fs.copyFileSync(bundled, dest);
            logger.info(`[TlsClient] Seeded native lib from bundle → ${dest} (${bundledSize} bytes)`);
        }
    }
    catch (err) {
        logger.warn(`[TlsClient] Failed to seed bundled native lib (falling back to download): ${err?.message || err}`);
    }
}
