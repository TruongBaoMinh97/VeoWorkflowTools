/**
 * extractEndFrame — pick the LAST still-sharp frame from the tail of a video.
 *
 * Veo3 clips routinely end on a fade-out or a motion-blurred frame, so the
 * literal final frame makes a poor start-frame for the next clip. Sharpness is
 * scored by JPEG file size at a fixed `-q:v`: at constant quality, size tracks
 * high-frequency detail, and black / faded / blurred frames compress far
 * smaller. That keeps the whole thing dependency-free — no sharp, jimp, opencv
 * or Python needed.
 *
 * Measured on an 8s clip with a 0.8s fade-to-black tail:
 *   literal last frame  → 4,705 B, visually near-black   ← the bug being fixed
 *   ffmpeg thumbnail=45 → 26,856 B but 0.79s before EOF  ← sharp, wrong position
 *   this algorithm      → t=7.458s / 8.0s, visually sharp
 * Control on a clip with no fade: last/max size ratio is 0.984, so the 0.88
 * threshold still returns the true final frame.
 */
import { mkdir, readdir, stat, copyFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../../../lib/logger.js';
import { downloadToTemp } from './ffmpegConcat.js';
import { spawnFfmpeg } from './spawnFfmpeg.js';
const REMOTE_URL = /^https?:\/\//i;
const CANDIDATE_FILE = /^cand_\d+\.jpg$/;
/** Tail window scanned for a sharp frame — "the final second", with margin. */
const TAIL_WINDOW_SEC = 1.2;
/** Frame cap for the tail pass. 90 covers 1.2s even at 60fps. */
const TAIL_MAX_FRAMES = 90;
/** Sampling rate for the no-duration fallback pass. */
const FALLBACK_FPS = 6;
/** Frame cap for the fallback pass — 60s of coverage at FALLBACK_FPS. */
const FALLBACK_MAX_FRAMES = 360;
/** Only the final ~2s of the fallback sample is scored. */
const FALLBACK_TAIL_FRAMES = 12;
/** A candidate counts as sharp when its size reaches this fraction of the best. */
const SHARP_RATIO = 0.88;
const JPEG_QUALITY = '2';
/**
 * Extract the last sharp frame of a video and return an absolute path to it.
 *
 * Accepts an https URL, a `file://` URL, or a bare absolute path.
 *
 * The returned JPEG deliberately outlives this call: the renderer streams it
 * through `GET /api/workflow/media` and `mediaResultToBase64` may read it when
 * the node feeds gemini-script. Same lifetime contract as `wf_upscale_*.jpg`.
 *
 * Throws plain `Error` only — `NonRetryableError` is private to the engine, so
 * retry classification stays in the dispatch case.
 */
export async function extractLastSharpFrame(videoUrl, ffmpegBinary) {
    // `-sseof` needs seekable byte-range access and Veo3's signed CDN URLs don't
    // serve ranges reliably — the same reason ffmpegConcat materializes remote
    // inputs before handing them to ffmpeg.
    let localVideo;
    let downloadedVideo = null;
    if (REMOTE_URL.test(videoUrl)) {
        localVideo = await downloadToTemp(videoUrl, 'extract-endframe');
        downloadedVideo = localVideo;
    }
    else {
        localVideo = videoUrl.startsWith('file://') ? videoUrl.slice('file://'.length) : videoUrl;
    }
    const id = randomUUID();
    const workDir = path.join(tmpdir(), `wf_endframe_${id}`);
    const outPath = path.join(tmpdir(), `wf_endframe_${id}.jpg`);
    const candidatePattern = path.join(workDir, 'cand_%03d.jpg');
    try {
        await mkdir(workDir, { recursive: true });
        // `-sseof` seeks relative to EOF and clamps to 0 on clips shorter than the
        // window. `-fps_mode passthrough` emits the decoded frames untouched (the
        // non-deprecated spelling of `-vsync 0`; both work on the bundled ffmpeg 6).
        await spawnFfmpeg(ffmpegBinary, [
            '-y', '-loglevel', 'error',
            '-sseof', String(-TAIL_WINDOW_SEC),
            '-i', localVideo,
            '-fps_mode', 'passthrough',
            '-frames:v', String(TAIL_MAX_FRAMES),
            '-q:v', JPEG_QUALITY,
            candidatePattern,
        ]);
        let candidates = await listCandidates(workDir);
        // A container without duration metadata turns `-sseof` into a no-op: ffmpeg
        // exits 0 having written nothing. Sample the whole file at a low frame rate
        // instead and keep only the tail slice, so the choice still comes from the
        // end of the clip rather than its beginning.
        if (candidates.length === 0) {
            await spawnFfmpeg(ffmpegBinary, [
                '-y', '-loglevel', 'error',
                '-i', localVideo,
                '-vf', `fps=${FALLBACK_FPS}`,
                '-frames:v', String(FALLBACK_MAX_FRAMES),
                '-q:v', JPEG_QUALITY,
                candidatePattern,
            ]).catch((err) => {
                // An empty workDir is the real signal, but keep the ffmpeg diagnostic:
                // a partial write here would otherwise be silently scored.
                logger.warn(`[extract-endframe] fallback pass failed: ${err instanceof Error ? err.message : String(err)}`);
            });
            candidates = (await listCandidates(workDir)).slice(-FALLBACK_TAIL_FRAMES);
        }
        if (candidates.length === 0) {
            throw new Error('extract-endframe: không trích được frame nào — video có thể hỏng hoặc quá ngắn');
        }
        const scored = await Promise.all(candidates.map(async (file) => ({ file, size: (await stat(file)).size })));
        const threshold = Math.max(...scored.map((c) => c.size)) * SHARP_RATIO;
        // Scan backwards so the LATEST frame clearing the sharpness bar wins — that
        // is precisely "the last frame that is still sharp".
        const winner = [...scored].reverse().find((c) => c.size >= threshold) ?? scored[scored.length - 1];
        await copyFile(winner.file, outPath);
        return outPath;
    }
    finally {
        // Drop the candidate scratch dir and the downloaded source. `outPath` lives
        // outside workDir precisely so this cleanup cannot take it.
        await rm(workDir, { recursive: true, force: true }).catch(() => { });
        if (downloadedVideo) {
            await unlink(downloadedVideo).catch(() => { });
        }
    }
}
/** Absolute paths of the extracted candidates, in temporal (zero-padded) order. */
async function listCandidates(dir) {
    const entries = await readdir(dir).catch(() => []);
    return entries
        .filter((f) => CANDIDATE_FILE.test(f))
        .sort()
        .map((f) => path.join(dir, f));
}
