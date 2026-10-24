/**
 * removeLogo — workflow-engine helpers for logo/watermark removal.
 *
 * Each helper materialises the upstream media to a local file (downloading
 * remote CDN urls first), runs the shipped Python batch script synchronously
 * (Promise-wrapped `spawn`, NOT detached — the engine awaits it directly, like
 * `spawnFfmpeg`), then copies the single cleaned output to a stable temp path
 * that OUTLIVES this call. The renderer streams that `file://` path through
 * `GET /api/workflow/media`; same lifetime contract as `wf_endframe_*` /
 * `wf_upscale_*`.
 *
 * The per-run scratch dir and any downloaded input are removed in `finally`;
 * the returned output file is written outside that dir so cleanup cannot take
 * it. Callers own the returned file's eventual lifetime (shared with the rest
 * of the engine's temp-file behaviour).
 */
import { spawn } from 'node:child_process';
import { mkdir, copyFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../../../lib/logger.js';
import { downloadToTemp, downloadImageToTemp } from './ffmpegConcat.js';
import { resolveAlphaPath, buildFfmpegEnv } from '../../removeWatermark/removeWatermark.service.js';
const REMOTE_URL = /^https?:\/\//i;
/**
 * Remove the logo/watermark from a single image. Returns an absolute path to the
 * cleaned image. Throws a plain `Error` on failure — the engine case decides
 * retry classification.
 */
export async function removeImageLogo(url, opts) {
    const { inputFile, downloadedInput } = await materialise(url, 'image', 'remove-image-logo');
    const runId = randomUUID();
    const outDir = path.join(tmpdir(), `wf_logo_img_${runId}`);
    const stableDst = path.join(tmpdir(), `wf_logo_img_${runId}${path.extname(inputFile) || '.jpg'}`);
    try {
        await mkdir(outDir, { recursive: true });
        const args = [
            opts.scriptPath,
            inputFile,
            outDir,
            '--method', opts.method ?? 'calib',
            '--strength', String(opts.strength ?? 1.0),
        ];
        const alphaPath = resolveAlphaPath();
        if (alphaPath) {
            args.push('--alpha', alphaPath);
        }
        else {
            logger.warn('[remove-image-logo] no alpha map found — Python falls back to fsr/telea');
        }
        logger.info('[remove-image-logo] spawning python', { input: inputFile, outDir });
        const dst = await runPythonBatch(opts.pythonBin, args, process.env, 'remove-image-logo');
        await copyFile(dst, stableDst);
        return stableDst;
    }
    finally {
        await rm(outDir, { recursive: true, force: true }).catch(() => { });
        if (downloadedInput)
            await unlink(downloadedInput).catch(() => { });
    }
}
/**
 * Remove the logo/watermark from a single video (short clip or merged output).
 * Returns an absolute path to the cleaned video.
 */
export async function removeVideoLogo(url, opts) {
    const { inputFile, downloadedInput } = await materialise(url, 'video', 'remove-video-logo');
    const runId = randomUUID();
    const outDir = path.join(tmpdir(), `wf_logo_vid_${runId}`);
    const stableDst = path.join(tmpdir(), `wf_logo_vid_${runId}${path.extname(inputFile) || '.mp4'}`);
    try {
        await mkdir(outDir, { recursive: true });
        const args = [
            opts.scriptPath,
            inputFile,
            outDir,
            '--logo', opts.logo ?? 'auto',
            '--corner', opts.corner ?? 'br',
            '--crf', String(opts.crf ?? 15),
            '--strength', String(opts.strength ?? 1.0),
        ];
        const env = buildFfmpegEnv(opts.ffmpegBin, opts.ffprobeBin);
        logger.info('[remove-video-logo] spawning python', { input: inputFile, outDir });
        const dst = await runPythonBatch(opts.pythonBin, args, env, 'remove-video-logo');
        await copyFile(dst, stableDst);
        return stableDst;
    }
    finally {
        await rm(outDir, { recursive: true, force: true }).catch(() => { });
        if (downloadedInput)
            await unlink(downloadedInput).catch(() => { });
    }
}
// ── Internal ──────────────────────────────────────────────────────────────────
/**
 * Resolve an upstream media url to a local file. Remote urls are downloaded to a
 * temp file (kept with the right extension for images); `file://` urls are
 * unwrapped; bare paths pass through. `downloadedInput` is non-null only when a
 * temp file was created and must be cleaned up.
 */
async function materialise(url, kind, label) {
    if (REMOTE_URL.test(url)) {
        const inputFile = kind === 'image' ? await downloadImageToTemp(url, label) : await downloadToTemp(url, label);
        return { inputFile, downloadedInput: inputFile };
    }
    const inputFile = url.startsWith('file://') ? url.slice('file://'.length) : url;
    return { inputFile, downloadedInput: null };
}
/**
 * Spawn a `<script> <input> <outDir> …` batch run, parse its stdout JSON, and
 * return the single output's `dst` path. Rejects on non-zero exit, unparsable
 * output, or a script-reported failure.
 */
function runPythonBatch(bin, args, env, label) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { env });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
                reject(new Error(`${label}: Python exited ${code}${tail ? ` — ${tail}` : ''}`));
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(stdout);
            }
            catch {
                reject(new Error(`${label}: could not parse Python output — ${stdout.slice(0, 200)}`));
                return;
            }
            const first = parsed.outputs?.[0];
            if (!parsed.success || !first?.ok || !first.dst) {
                const reason = first?.error ?? parsed.error ?? 'unknown error';
                reject(new Error(`${label}: xử lý thất bại — ${reason}`));
                return;
            }
            resolve(first.dst);
        });
    });
}
