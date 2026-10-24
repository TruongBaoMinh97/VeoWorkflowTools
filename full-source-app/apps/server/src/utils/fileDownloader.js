/**
 * File Downloader Utility
 * Downloads files from URL and saves to local path.
 *
 * Strategy:
 *   - HEAD probe to discover Content-Length + Accept-Ranges
 *   - If file > CHUNK_SIZE AND server accepts Range → chunked download
 *     (HTTP 206 Partial Content, per-chunk size verify, chunk-level retry)
 *   - Otherwise → single-shot streaming GET with tightened verification
 *   - MP4/MOV files get a structural integrity check (ftyp + moov atoms)
 *     to catch silent truncations that slip past Content-Length checks.
 */
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import { logger } from '../lib/logger.js';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
// Chunked download tuning. 4MB per chunk is large enough to keep handshake
// overhead minimal but small enough that a retry for one bad chunk is cheap.
const CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_CHUNK_RETRIES = 3;
const CHUNK_RETRY_DELAY_MS = 2000;
const CHUNK_TIMEOUT_MS = 60000;
const MAX_REDIRECTS = 5;
const HEAD_TIMEOUT_MS = 15000;
const SINGLE_SHOT_TIMEOUT_MS = 120000;
const MOOV_BOX_TYPE = Buffer.from('moov', 'latin1');
// Files that fail the structural check are parked here instead of deleted. No
// leading dot: the users of this tool are on Windows, where a dot-prefixed
// folder is not hidden anyway, so a self-explanatory name is worth more.
const QUARANTINE_DIR_NAME = '_quarantine';
// Browser-like headers — Google Flow's CDN may downgrade quality (or serve a
// preview) for clients without a real UA. Mirror Chrome 148 so the upscaled
// 1080p MP4 streams the same way it does in the Flow tab.
const BROWSER_LIKE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.205 Safari/537.36',
    Accept: 'video/mp4,video/*;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity', // never gzip a video stream
    Referer: 'https://labs.google/',
};
export function isRetryableDownloadError(error) {
    const err = error;
    const msg = err?.message || '';
    return (msg.includes('ENOTFOUND') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('timeout') ||
        msg.includes('fetch failed') ||
        // `Truncated:` is a byte-count mismatch — a genuinely partial transfer that
        // another attempt can fix. A structural failure is not retried: the bytes
        // are complete and identical every time, so re-downloading only repeated
        // the quarantine three times per file.
        msg.includes('Truncated:') ||
        msg.includes('aborted at') ||
        msg.includes('Chunk ') ||
        err?.code === 'ENOTFOUND' ||
        err?.code === 'ECONNRESET' ||
        err?.code === 'ETIMEDOUT');
}
/**
 * HEAD-request the URL and follow redirects manually. Returns final URL plus
 * any Content-Length / Accept-Ranges advertised by the server. Returns size=null
 * if anything fails so the caller can fall back to single-shot streaming.
 */
async function probeContentLength(url) {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const result = await new Promise((resolve) => {
            try {
                const client = current.startsWith('https://') ? https : http;
                const req = client.request(current, { method: 'HEAD', headers: BROWSER_LIKE_HEADERS }, (res) => {
                    const location = typeof res.headers.location === 'string' ? res.headers.location : undefined;
                    resolve({ status: res.statusCode || 0, headers: res.headers, location });
                    res.resume();
                });
                req.on('error', () => resolve(null));
                req.setTimeout(HEAD_TIMEOUT_MS, () => {
                    req.destroy();
                    resolve(null);
                });
                req.end();
            }
            catch {
                resolve(null);
            }
        });
        if (!result)
            return { size: null, finalUrl: current, acceptRanges: false };
        if (result.status >= 300 && result.status < 400 && result.location) {
            current = new URL(result.location, current).toString();
            continue;
        }
        if (result.status < 200 || result.status >= 400) {
            return { size: null, finalUrl: current, acceptRanges: false };
        }
        const cl = result.headers['content-length'];
        const size = typeof cl === 'string' ? Number(cl) : NaN;
        const ar = String(result.headers['accept-ranges'] || '').toLowerCase();
        return {
            size: Number.isFinite(size) && size > 0 ? size : null,
            finalUrl: current,
            acceptRanges: ar === 'bytes',
        };
    }
    return { size: null, finalUrl: current, acceptRanges: false };
}
/**
 * Walk the top-level MP4 box chain looking for `moov`.
 *
 * Replaces an earlier scan of the first 64KB + last 256KB, which had a blind
 * spot in between: Google Flow prefixes its videos with a variable-size `uuid`
 * (XMP metadata) box, and when that box is ~100KB it pushes `moov` past the head
 * window while leaving it far short of the tail window. Perfectly valid videos
 * were reported as truncated and deleted.
 *
 * Walking the chain is both cheaper (a handful of 8-16 byte header reads instead
 * of 320KB) and stricter — `moov` only counts at a real box boundary, where a
 * substring scan could match the same four bytes inside `mdat` payload.
 */
async function findMoovBox(fd, fileSize) {
    const header = Buffer.alloc(16);
    let offset = 0;
    while (offset + 8 <= fileSize) {
        const { bytesRead } = await fd.read(header, 0, 8, offset);
        if (bytesRead < 8) {
            return { found: false, reason: `unreadable box header at ${offset}` };
        }
        if (header.subarray(4, 8).equals(MOOV_BOX_TYPE))
            return { found: true };
        const size32 = header.readUInt32BE(0);
        let boxSize;
        if (size32 === 1) {
            // 64-bit `largesize` follows the type field and counts the 16-byte header.
            if (offset + 16 > fileSize) {
                return { found: false, reason: `largesize header past EOF at ${offset}` };
            }
            const { bytesRead: sizeBytes } = await fd.read(header, 0, 8, offset + 8);
            if (sizeBytes < 8) {
                return { found: false, reason: `unreadable largesize at ${offset}` };
            }
            const large = header.readBigUInt64BE(0);
            if (large < 16n || large > BigInt(fileSize - offset)) {
                return { found: false, reason: `invalid largesize at ${offset}` };
            }
            boxSize = Number(large);
        }
        else if (size32 === 0) {
            // Runs to EOF, so this is the last box — and it is not moov.
            return { found: false, reason: 'missing moov atom (truncated?)' };
        }
        else if (size32 < 8) {
            return { found: false, reason: `invalid box size ${size32} at ${offset}` };
        }
        else {
            boxSize = size32;
        }
        // A box claiming more bytes than the file holds is the real truncation this
        // check exists to catch.
        if (offset + boxSize > fileSize) {
            return { found: false, reason: `box at ${offset} runs past EOF (truncated?)` };
        }
        offset += boxSize;
    }
    return { found: false, reason: 'missing moov atom (truncated?)' };
}
/**
 * Structural sanity check for MP4/MOV files. Detects truncated downloads that
 * still happen to land at a byte boundary the size check would otherwise accept
 * (e.g. server closes connection mid-mdat with FIN).
 *
 * Exported for tests.
 */
export async function verifyMp4Integrity(filePath) {
    let fd = null;
    try {
        const stat = await fs.promises.stat(filePath);
        if (stat.size < 1024) {
            return { valid: false, reason: `too small (${stat.size} bytes)` };
        }
        fd = await fs.promises.open(filePath, 'r');
        const headBuf = Buffer.alloc(8);
        await fd.read(headBuf, 0, 8, 0);
        const ftyp = headBuf.subarray(4, 8).toString('latin1');
        if (ftyp !== 'ftyp') {
            return { valid: false, reason: `missing ftyp box (got "${ftyp}")` };
        }
        const moov = await findMoovBox(fd, stat.size);
        if (!moov.found) {
            return { valid: false, reason: moov.reason ?? 'missing moov atom (truncated?)' };
        }
        return { valid: true };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        return { valid: false, reason: `read error: ${msg}` };
    }
    finally {
        if (fd) {
            try {
                await fd.close();
            }
            catch {
                /* ignore */
            }
        }
    }
}
/**
 * GET a single byte range and write it into the pre-allocated output file at
 * the given offset. Retries up to MAX_CHUNK_RETRIES with backoff.
 */
async function downloadOneRange(url, start, end, fd) {
    const expectedBytes = end - start + 1;
    for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES; attempt++) {
        try {
            const written = await new Promise((resolve, reject) => {
                const client = url.startsWith('https://') ? https : http;
                const req = client.get(url, {
                    headers: {
                        ...BROWSER_LIKE_HEADERS,
                        Range: `bytes=${start}-${end}`,
                    },
                }, (res) => {
                    const status = res.statusCode || 0;
                    // 206 = Partial Content (expected). 200 = server ignored Range and
                    // is going to stream the whole file again — bail out, caller can
                    // either fall back to single-shot or retry.
                    if (status !== 206 && status !== 200) {
                        res.resume();
                        reject(new Error(`Chunk ${start}-${end}: HTTP ${status}`));
                        return;
                    }
                    if (status === 200) {
                        res.resume();
                        reject(new Error(`Chunk ${start}-${end}: server ignored Range (HTTP 200)`));
                        return;
                    }
                    let received = 0;
                    const buffers = [];
                    res.on('data', (chunk) => {
                        received += chunk.length;
                        buffers.push(chunk);
                    });
                    res.on('aborted', () => {
                        reject(new Error(`Chunk ${start}-${end}: aborted at ${received} bytes`));
                    });
                    res.on('error', (err) => reject(err));
                    res.on('end', () => {
                        if (received !== expectedBytes) {
                            reject(new Error(`Chunk ${start}-${end}: got ${received}/${expectedBytes} bytes`));
                            return;
                        }
                        const buf = Buffer.concat(buffers, received);
                        fd.write(buf, 0, received, start)
                            .then(() => resolve(received))
                            .catch((err) => reject(err));
                    });
                });
                req.on('error', reject);
                req.setTimeout(CHUNK_TIMEOUT_MS, () => {
                    req.destroy();
                    reject(new Error(`Chunk ${start}-${end}: timeout`));
                });
            });
            return written;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'unknown';
            if (attempt === MAX_CHUNK_RETRIES) {
                throw err;
            }
            logger.warn(`[FileDownloader] Chunk ${start}-${end} attempt ${attempt}/${MAX_CHUNK_RETRIES} failed (${msg}), retrying...`);
            await new Promise((r) => setTimeout(r, CHUNK_RETRY_DELAY_MS * attempt));
        }
    }
    throw new Error(`Chunk ${start}-${end}: exhausted retries`);
}
/**
 * Download a file by issuing sequential Range requests and writing each chunk
 * to the pre-allocated output file at its offset.
 */
async function downloadInChunks(url, outputPath, totalSize) {
    const fd = await fs.promises.open(outputPath, 'w');
    try {
        await fd.truncate(totalSize);
        let totalWritten = 0;
        for (let start = 0; start < totalSize; start += CHUNK_SIZE) {
            const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
            const written = await downloadOneRange(url, start, end, fd);
            totalWritten += written;
        }
        if (totalWritten !== totalSize) {
            throw new Error(`Truncated: chunked total ${totalWritten}/${totalSize} bytes`);
        }
    }
    finally {
        await fd.close().catch(() => {
            /* ignore */
        });
    }
    await verifyOnDiskOrThrow(outputPath, totalSize);
    logger.info(`[FileDownloader] Chunked download complete: ${totalSize} bytes → ${outputPath}`);
}
/**
 * Single-shot streaming GET. Used for small files (< CHUNK_SIZE) or when the
 * server does not advertise Accept-Ranges. Performs Content-Length match
 * against either the response header OR the size we learned from HEAD probe.
 */
async function downloadSingleShot(url, outputPath, knownSize) {
    await new Promise((resolve, reject) => {
        let redirectHops = 0;
        let currentUrl = url;
        const fire = (target) => {
            const client = target.startsWith('https://') ? https : http;
            const file = fs.createWriteStream(outputPath);
            const cleanup = () => {
                try {
                    file.close();
                }
                catch {
                    /* ignore */
                }
                if (fs.existsSync(outputPath)) {
                    try {
                        fs.unlinkSync(outputPath);
                    }
                    catch {
                        /* ignore */
                    }
                }
            };
            const req = client.get(target, { headers: BROWSER_LIKE_HEADERS }, (res) => {
                const status = res.statusCode || 0;
                if (status >= 300 && status < 400 && res.headers.location) {
                    try {
                        file.close();
                    }
                    catch {
                        /* ignore */
                    }
                    if (fs.existsSync(outputPath)) {
                        try {
                            fs.unlinkSync(outputPath);
                        }
                        catch {
                            /* ignore */
                        }
                    }
                    res.resume();
                    redirectHops += 1;
                    if (redirectHops > MAX_REDIRECTS) {
                        reject(new Error(`Too many redirects (>${MAX_REDIRECTS}) for ${url}`));
                        return;
                    }
                    const nextUrl = new URL(res.headers.location, target).toString();
                    currentUrl = nextUrl;
                    fire(nextUrl);
                    return;
                }
                if (status >= 400) {
                    cleanup();
                    reject(new Error(`HTTP ${status}: ${res.statusMessage || 'Download failed'}`));
                    return;
                }
                const expectedHeader = res.headers['content-length'];
                const expectedBytes = typeof expectedHeader === 'string' ? Number(expectedHeader) : NaN;
                let receivedBytes = 0;
                res.on('data', (chunk) => {
                    receivedBytes += chunk.length;
                });
                res.on('aborted', () => {
                    cleanup();
                    reject(new Error(`Download aborted at ${receivedBytes} bytes for ${currentUrl}`));
                });
                res.pipe(file);
                file.on('error', (err) => {
                    cleanup();
                    reject(err);
                });
                file.on('finish', () => {
                    file.close(() => {
                        // Prefer response Content-Length; fall back to HEAD probe size.
                        const effectiveExpected = Number.isFinite(expectedBytes) && expectedBytes > 0
                            ? expectedBytes
                            : knownSize;
                        if (effectiveExpected !== null &&
                            effectiveExpected !== undefined &&
                            receivedBytes !== effectiveExpected) {
                            try {
                                fs.unlinkSync(outputPath);
                            }
                            catch {
                                /* ignore */
                            }
                            reject(new Error(`Truncated: got ${receivedBytes}/${effectiveExpected} bytes from ${currentUrl}`));
                            return;
                        }
                        logger.info(`[FileDownloader] Single-shot complete: ${receivedBytes} bytes ` +
                            `(expected=${effectiveExpected ?? 'unknown'}) → ${outputPath}`);
                        resolve();
                    });
                });
            });
            req.on('error', (err) => {
                cleanup();
                reject(err);
            });
            req.on('timeout', () => {
                req.destroy();
                cleanup();
                reject(new Error('Download timeout'));
            });
            req.setTimeout(SINGLE_SHOT_TIMEOUT_MS);
        };
        fire(currentUrl);
    });
    // After single-shot completes, run structural verify for video files.
    await verifyOnDiskOrThrow(outputPath, knownSize);
}
/**
 * Final on-disk verification: size sanity + MP4 structural check for video
 * files. Throws (and unlinks) if file looks corrupt so the outer retry loop
 * can take another shot.
 */
async function verifyOnDiskOrThrow(outputPath, expectedSize) {
    if (expectedSize !== null && expectedSize !== undefined) {
        const stat = await fs.promises.stat(outputPath);
        if (stat.size !== expectedSize) {
            try {
                await fs.promises.unlink(outputPath);
            }
            catch {
                /* ignore */
            }
            throw new Error(`Truncated: on-disk size ${stat.size} != expected ${expectedSize} for ${outputPath}`);
        }
    }
    const ext = path.extname(outputPath).toLowerCase();
    if (ext === '.mp4' || ext === '.mov') {
        const integrity = await verifyMp4Integrity(outputPath);
        if (!integrity.valid) {
            // Never delete: this check has produced false positives on complete files,
            // and the video costs credits to regenerate. Park it for the user to judge.
            const parked = await quarantineFile(outputPath, integrity.reason ?? 'unknown');
            throw new Error(`MP4 integrity: ${integrity.reason} — file giữ lại tại ${parked} (${outputPath})`);
        }
    }
}
/**
 * Move a suspect file into a sibling `_quarantine/` folder and drop a sidecar
 * recording why. Returns the resting path. Falls back to leaving the file where
 * it is rather than throwing — losing the diagnostic is better than losing the
 * file, which is the failure mode this whole function exists to prevent.
 */
export async function quarantineFile(outputPath, reason) {
    let target;
    try {
        const dir = path.join(path.dirname(outputPath), QUARANTINE_DIR_NAME);
        await fs.promises.mkdir(dir, { recursive: true });
        const ext = path.extname(outputPath);
        const base = path.basename(outputPath, ext);
        target = path.join(dir, `${base}${ext}`);
        // A retry, or a same-named file from another batch, must not clobber an
        // earlier quarantined copy.
        for (let n = 2; n < 1000 && fs.existsSync(target); n++) {
            target = path.join(dir, `${base}_${n}${ext}`);
        }
        if (fs.existsSync(target)) {
            // Numbered slots exhausted. Overwriting here would destroy a quarantined
            // file, which is the one thing this function exists to prevent.
            target = path.join(dir, `${base}_${Date.now()}${ext}`);
        }
        await fs.promises.rename(outputPath, target);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        logger.error(`[FileDownloader] Quarantine failed for ${outputPath}: ${msg}`);
        return outputPath;
    }
    // The file has moved; `target` is now the truth regardless of what follows.
    // The sidecar is a diagnostic — losing it must not misreport where the file is.
    try {
        await fs.promises.writeFile(`${target}.json`, JSON.stringify({
            reason,
            originalPath: outputPath,
            size: (await fs.promises.stat(target)).size,
            quarantinedAt: new Date().toISOString(),
        }, null, 2), 'utf8');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        logger.warn(`[FileDownloader] Sidecar write failed for ${target}: ${msg}`);
    }
    logger.warn(`[FileDownloader] Quarantined ${outputPath} → ${target} (${reason})`);
    return target;
}
/**
 * Top-level orchestrator. Probes the URL, then picks chunked or single-shot.
 */
async function downloadHttpFile(url, outputPath) {
    const probe = await probeContentLength(url);
    if (probe.size !== null && probe.size > CHUNK_SIZE && probe.acceptRanges) {
        const chunkCount = Math.ceil(probe.size / CHUNK_SIZE);
        logger.info(`[FileDownloader] Using Range download: ${probe.size} bytes in ${chunkCount} chunks of ${CHUNK_SIZE}B`);
        return downloadInChunks(probe.finalUrl, outputPath, probe.size);
    }
    logger.info(`[FileDownloader] Using single-shot download: size=${probe.size ?? 'unknown'} acceptRanges=${probe.acceptRanges}`);
    return downloadSingleShot(probe.finalUrl, outputPath, probe.size);
}
/**
 * Return a path that does not yet exist on disk. If `desiredPath` is free it is
 * returned unchanged; otherwise an index suffix (`_1`, `_2`, …) is appended
 * before the extension. Used to keep re-downloads (e.g. a regenerated batch row)
 * from overwriting an earlier file. Same numbering scheme as `quarantineFile`.
 */
export function resolveUniquePath(desiredPath) {
    if (!fs.existsSync(desiredPath))
        return desiredPath;
    const ext = path.extname(desiredPath);
    const base = desiredPath.slice(0, desiredPath.length - ext.length);
    for (let n = 1; n <= 1000; n++) {
        const candidate = `${base}_${n}${ext}`;
        if (!fs.existsSync(candidate))
            return candidate;
    }
    return `${base}_${Date.now()}${ext}`;
}
/**
 * Public entry point: download a file from URL to local path with retry.
 *
 * @param url        Source URL (http://, https://, file://, or local path)
 * @param outputPath Local path where the file should be saved
 * @returns          The final outputPath when the download succeeds
 */
export async function downloadFile(url, outputPath) {
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    if (url.startsWith('file://')) {
        const localPath = decodeURIComponent(url.replace('file://', ''));
        if (fs.existsSync(localPath)) {
            fs.copyFileSync(localPath, outputPath);
            logger.info(`[FileDownloader] Copied file: ${localPath} -> ${outputPath}`);
            return outputPath;
        }
        throw new Error(`Source file not found: ${localPath}`);
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        if (fs.existsSync(url)) {
            fs.copyFileSync(url, outputPath);
            logger.info(`[FileDownloader] Copied local file: ${url} -> ${outputPath}`);
            return outputPath;
        }
        throw new Error(`Invalid URL or file not found: ${url}`);
    }
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            await downloadHttpFile(url, outputPath);
            logger.info(`[FileDownloader] Downloaded: ${url} -> ${outputPath}`);
            return outputPath;
        }
        catch (error) {
            lastError = error;
            const retryable = isRetryableDownloadError(error);
            const msg = error instanceof Error ? error.message : 'unknown';
            if (!retryable || attempt === MAX_RETRIES) {
                logger.error(`[FileDownloader] Failed to download ${url}: ${msg}`);
                throw new Error(`Failed to download file: ${msg}`);
            }
            logger.warn(`[FileDownloader] Download attempt ${attempt}/${MAX_RETRIES} failed (${msg}), retrying in ${RETRY_DELAY_MS / 1000}s...`);
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
        }
    }
    const lastMsg = lastError instanceof Error ? lastError.message : 'unknown';
    throw new Error(`Failed to download file after ${MAX_RETRIES} attempts: ${lastMsg}`);
}
