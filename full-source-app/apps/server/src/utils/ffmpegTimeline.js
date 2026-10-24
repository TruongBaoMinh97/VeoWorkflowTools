/**
 * FFmpeg timeline helpers for the Doodle Video Pipeline.
 *
 * The existing merge primitives (ffmpegUtils.concatVideos / lib/ffmpegConcat)
 * only stitch clips back-to-back in list order. The doodle pipeline needs each
 * shot to occupy an EXACT duration derived from a Whisper segment so the final
 * concat lines up with the original narration audio. These helpers turn one
 * asset (a still image, or a generated video clip) into a silent clip of a
 * precise duration, normalised to a uniform codec so the downstream
 * `concatVideos(..., -c copy)` works without re-encoding.
 */
import { spawn } from 'child_process';
import { resolveFfmpegBinary } from './ffmpegResolver.js';
import { getMediaDuration } from './ffmpegUtils.js';
import { logger } from '../lib/logger.js';
const DEFAULT_FPS = 25;
const DEFAULT_RESOLUTION = '1920x1080';
// Floor so a near-zero segment never produces a broken zero-length clip.
const MIN_CLIP_SECONDS = 0.5;
function ffmpegBin() {
    return resolveFfmpegBinary() ?? 'ffmpeg';
}
/** Scale to fit + pad to the exact canvas (letterbox), keep 16:9 without distortion. */
function scalePadFilter(resolution) {
    const [w, h] = resolution.split('x');
    return (`scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1`);
}
function runFfmpeg(args, label) {
    return new Promise((resolve, reject) => {
        const proc = spawn(ffmpegBin(), args);
        let stderrTail = '';
        proc.stderr?.on('data', (d) => {
            // Keep only the tail — ffmpeg stderr is verbose; we want the error line.
            stderrTail = (stderrTail + d.toString()).slice(-1500);
        });
        proc.on('error', (err) => reject(new Error(`${label}: spawn failed — ${err.message}`)));
        proc.on('close', (code) => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`${label}: ffmpeg exited ${code}\n${stderrTail.trim()}`));
        });
    });
}
/**
 * Render a still image into a silent video clip of EXACTLY `durationSec`.
 * Used for the IMAGE output path — gives frame-accurate timeline sync.
 */
export async function imageToFixedClip(imagePath, durationSec, outputPath, opts = {}) {
    const fps = opts.fps ?? DEFAULT_FPS;
    const resolution = opts.resolution ?? DEFAULT_RESOLUTION;
    const duration = Math.max(MIN_CLIP_SECONDS, durationSec);
    const args = [
        '-y',
        '-loop', '1',
        '-i', imagePath,
        '-t', duration.toFixed(3),
        '-vf', scalePadFilter(resolution),
        '-r', String(fps),
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'veryfast',
        '-an', // silent — master audio is muxed in later
        outputPath,
    ];
    await runFfmpeg(args, `imageToFixedClip(${imagePath})`);
    logger.debug(`[ffmpegTimeline] image clip ${duration.toFixed(2)}s → ${outputPath}`);
    return outputPath;
}
/**
 * Fit a generated VIDEO clip to EXACTLY `durationSec` (silent, normalised codec).
 * - clip longer than target → trimmed.
 * - clip shorter than target → looped (`-stream_loop`) then cut at target.
 * Used for the VIDEO output path (approximate per-clip sync).
 */
export async function trimOrPadClip(clipPath, durationSec, outputPath, opts = {}) {
    const fps = opts.fps ?? DEFAULT_FPS;
    const resolution = opts.resolution ?? DEFAULT_RESOLUTION;
    const duration = Math.max(MIN_CLIP_SECONDS, durationSec);
    let sourceDuration = 0;
    try {
        sourceDuration = await getMediaDuration(clipPath);
    }
    catch {
        sourceDuration = 0; // unknown → treat as "needs loop" defensively
    }
    const needsLoop = sourceDuration > 0 && sourceDuration < duration - 0.05;
    const args = [
        '-y',
        ...(needsLoop ? ['-stream_loop', '-1'] : []),
        '-i', clipPath,
        '-t', duration.toFixed(3),
        '-vf', scalePadFilter(resolution),
        '-r', String(fps),
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'veryfast',
        '-an', // silent — master audio is muxed in later
        outputPath,
    ];
    await runFfmpeg(args, `trimOrPadClip(${clipPath})`);
    logger.debug(`[ffmpegTimeline] video clip ${sourceDuration.toFixed(2)}s → ${duration.toFixed(2)}s (${needsLoop ? 'loop' : 'trim'}) → ${outputPath}`);
    return outputPath;
}
