import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { logger } from '../lib/logger.js';
const electronProcess = process;
// Get __dirname equivalent for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/**
 * Resolve an FFmpeg-family binary (ffmpeg or ffprobe).
 * Checks packaged app paths, ffmpeg-static, then system PATH.
 */
function resolveFFBinary(tool) {
    const resourcesPath = electronProcess.resourcesPath || '';
    const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const ext = platform === 'win32' ? '.exe' : '';
    const binaryName = `${platform}-${arch}-${tool}${ext}`;
    // Also check standard name (e.g., ffmpeg.exe / ffprobe.exe)
    const standardName = `${tool}${ext}`;
    logger.info(`[${tool}] Looking for binary: ${binaryName} or ${standardName}`);
    logger.info(`[${tool}] resourcesPath: ${resourcesPath}`);
    try {
        // Build candidate paths for both platform-prefixed and standard names
        const baseDirs = [
            path.join(resourcesPath, 'server', 'binaries', 'ffmpeg'),
            path.join(__dirname, '..', '..', 'binaries', 'ffmpeg'),
            path.join(__dirname, '..', 'binaries', 'ffmpeg'),
            path.join(process.cwd(), 'binaries', 'ffmpeg'),
            path.join(process.cwd(), '..', 'resources', 'server', 'binaries', 'ffmpeg'),
            path.join(path.dirname(process.execPath), 'resources', 'server', 'binaries', 'ffmpeg'),
        ];
        for (const dir of baseDirs) {
            // Try platform-prefixed name first, then standard name
            for (const name of [binaryName, standardName]) {
                const fullPath = path.normalize(path.join(dir, name));
                if (fs.existsSync(fullPath)) {
                    logger.info(`[${tool}] Found binary at: ${fullPath}`);
                    return fullPath;
                }
            }
        }
    }
    catch (err) {
        logger.error(`[${tool}] Error checking custom paths:`, err);
    }
    // Try ffmpeg-static package (only for ffmpeg, not ffprobe)
    if (tool === 'ffmpeg') {
        try {
            logger.info(`[${tool}] Trying ffmpeg-static package...`);
            const ffmpegStatic = require('ffmpeg-static');
            if (ffmpegStatic && typeof ffmpegStatic === 'string') {
                const finalPath = ffmpegStatic.includes('app.asar')
                    ? ffmpegStatic.replace('app.asar', 'app.asar.unpacked')
                    : ffmpegStatic;
                if (fs.existsSync(finalPath)) {
                    logger.info(`[${tool}] Using ffmpeg-static: ${finalPath}`);
                    return finalPath;
                }
            }
        }
        catch (err) {
            logger.info(`[${tool}] ffmpeg-static not available:`, err);
        }
    }
    // Fallback to system PATH
    try {
        logger.info(`[${tool}] Checking system PATH...`);
        const whichCmd = process.platform === 'win32' ? `where ${tool}` : `which ${tool}`;
        const out = execSync(whichCmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        if (out) {
            const first = out.split(/\r?\n/)[0];
            if (first && first.length > 0) {
                logger.info(`[${tool}] Found in system PATH: ${first}`);
                return first;
            }
        }
    }
    catch {
        logger.info(`[${tool}] Not found in system PATH`);
    }
    logger.error(`[${tool}] ❌ Binary not found!`);
    return null;
}
/**
 * Resolve ffmpeg binary path
 */
export function resolveFfmpegBinary() {
    return resolveFFBinary('ffmpeg');
}
/**
 * Resolve ffprobe binary path
 */
export function resolveFfprobeBinary() {
    return resolveFFBinary('ffprobe');
}
/**
 * Resolve both ffmpeg and ffprobe binaries
 */
export function resolveFFmpegBinaries() {
    return {
        ffmpeg: resolveFfmpegBinary(),
        ffprobe: resolveFfprobeBinary(),
    };
}
export function getDefaultMergedOutputDir(projectId) {
    const baseDir = path.join(os.homedir(), 'Documents', 'Veo3Studio', 'video-outputs');
    return path.join(baseDir, projectId);
}
