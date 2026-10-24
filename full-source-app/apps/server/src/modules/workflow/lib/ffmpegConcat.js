/**
 * ffmpegConcat — concatenate video files using ffmpeg concat demuxer.
 * No re-encode: streams are copied directly (-c copy). All inputs must share
 * the same codec, resolution, and frame rate (standard for same-model outputs).
 */
import { writeFile, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveFfmpegBinary } from '../../../utils/ffmpegResolver.js';
import { spawnFfmpeg } from './spawnFfmpeg.js';
const REMOTE_URL = /^https?:\/\//i;
/**
 * Stream a remote video to a local temp file. The concat demuxer's protocol
 * whitelist excludes https, and Veo3's signed CDN URLs (Expires/Signature) do
 * not stream reliably through `-c copy` range requests — so we materialize each
 * remote input to disk first. Streamed (not buffered) to handle 4K outputs.
 *
 * `label` prefixes the error so the failing node is identifiable — this helper
 * is shared with extract-endframe, not merge-video alone.
 */
export async function downloadToTemp(url, label) {
    const res = await fetch(url);
    if (!res.ok || !res.body) {
        throw new Error(`${label}: download failed (${res.status}) for ${url.slice(0, 80)}`);
    }
    const file = path.join(tmpdir(), `wf_seg_${randomUUID()}.mp4`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
    return file;
}
/**
 * Stream a remote image to a local temp file, preserving the real extension from
 * the response `content-type`. `downloadToTemp` hardcodes `.mp4`, which corrupts
 * the filename the logo-removal Python scripts derive their output name from —
 * they write `<outDir>/<basename(input)>`, so a `.mp4`-named JPEG produces a
 * `.mp4`-named output that the renderer's content-type inference mishandles.
 */
export async function downloadImageToTemp(url, label) {
    const res = await fetch(url);
    if (!res.ok || !res.body) {
        throw new Error(`${label}: download failed (${res.status}) for ${url.slice(0, 80)}`);
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    const ext = contentType === 'image/png' ? 'png'
        : contentType === 'image/webp' ? 'webp'
            : contentType === 'image/gif' ? 'gif'
                : 'jpg'; // image/jpeg + unknown fall through to jpg
    const file = path.join(tmpdir(), `wf_imgdl_${randomUUID()}.${ext}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
    return file;
}
export async function concatVideos(inputPaths, outputPath) {
    if (inputPaths.length < 2) {
        throw new Error(`concatVideos requires ≥2 inputs, got ${inputPaths.length}`);
    }
    // Reject empty/whitespace entries before they reach the concat list — an empty
    // path becomes `file ''`, which ffmpeg rejects with a cryptic "string required".
    inputPaths.forEach((p, i) => {
        if (!p?.trim()) {
            throw new Error(`Không thể ghép: đoạn #${i + 1} không có đường dẫn. Bấm "gen lại" dòng này.`);
        }
    });
    const ffmpeg = resolveFfmpegBinary();
    if (!ffmpeg)
        throw new Error('ffmpeg binary not found — install ffmpeg to use merge-video nodes');
    // Materialize remote inputs to local temp files (downloads run in parallel,
    // order preserved). Local paths pass through untouched.
    const materialized = await Promise.all(inputPaths.map(async (p) => REMOTE_URL.test(p)
        ? { path: await downloadToTemp(p, 'merge-video'), temp: true }
        : { path: p, temp: false }));
    const localPaths = materialized.map((m) => m.path);
    const tempFiles = materialized.filter((m) => m.temp).map((m) => m.path);
    // Write concat list to a temp file. Single-quote the paths and escape embedded quotes.
    const listPath = path.join(tmpdir(), `ffconcat_${randomUUID()}.txt`);
    const listContent = localPaths
        .map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
        .join('\n');
    await writeFile(listPath, listContent, 'utf8');
    try {
        await spawnFfmpeg(ffmpeg, [
            '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', listPath,
            '-c', 'copy',
            outputPath,
        ]);
    }
    finally {
        await unlink(listPath).catch(() => { });
        await Promise.all(tempFiles.map((f) => unlink(f).catch(() => { })));
    }
}
