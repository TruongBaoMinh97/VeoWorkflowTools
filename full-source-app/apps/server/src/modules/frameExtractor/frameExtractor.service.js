import { logger } from '../../lib/logger.js';
import { spawn } from 'child_process';
import fs from 'fs';
import { resolvePythonBinary, resolvePythonScript } from '../../utils/pythonResolver.js';
import { resolveFfmpegBinary, resolveFfprobeBinary } from '../../utils/ffmpegResolver.js';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
class FrameExtractorService {
    constructor() {
        this.jobs = new Map();
    }
    /**
     * Start frame extraction job
     */
    async startExtraction(videoSource, outputDir, options) {
        const jobId = uuidv4();
        const job = {
            id: jobId,
            status: 'PENDING',
            progress: 'Initializing...',
            outputDir,
            startedAt: new Date()
        };
        this.jobs.set(jobId, job);
        // Start extraction in background
        this.runExtraction(jobId, videoSource, outputDir, options);
        return { jobId };
    }
    /**
     * Get job status
     */
    getJobStatus(jobId) {
        return this.jobs.get(jobId) || null;
    }
    /**
     * Run extraction using Python script
     */
    async runExtraction(jobId, videoSource, outputDir, options) {
        const job = this.jobs.get(jobId);
        if (!job)
            return;
        job.status = 'PROCESSING';
        job.progress = 'Starting extraction...';
        const pythonBin = resolvePythonBinary();
        const scriptPath = resolvePythonScript('frame_extractor.py');
        if (!pythonBin || !scriptPath) {
            job.status = 'FAILED';
            job.error = 'Python or script not found';
            job.completedAt = new Date();
            logger.error('[FrameExtractor] Python or script not found', { pythonBin, scriptPath });
            return;
        }
        // Resolve FFmpeg/FFprobe paths for Windows compatibility
        const ffmpegPath = resolveFfmpegBinary();
        const ffprobePath = resolveFfprobeBinary();
        const env = { ...process.env };
        // Pass full binary paths as env vars so Python can use them directly
        // This handles platform-prefixed names (e.g., win32-x64-ffmpeg.exe)
        if (ffmpegPath) {
            env.FFMPEG_PATH = ffmpegPath;
            const ffmpegDir = path.dirname(ffmpegPath);
            const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
            const separator = process.platform === 'win32' ? ';' : ':';
            const currentPath = env[pathKey] || '';
            env[pathKey] = `${ffmpegDir}${separator}${currentPath}`;
            logger.info('[FrameExtractor] Injected ffmpeg to PATH', { ffmpegDir, ffmpegPath });
        }
        else {
            // Fail immediately with clear error instead of silently hoping system PATH works
            job.status = 'FAILED';
            job.error = 'FFmpeg không được tìm thấy. Vui lòng cài đặt FFmpeg hoặc kiểm tra cài đặt phần mềm.';
            job.completedAt = new Date();
            logger.error('[FrameExtractor] ❌ FFmpeg binary not found! Cannot extract frames. Install FFmpeg or check bundled binaries.');
            return;
        }
        if (ffprobePath) {
            env.FFPROBE_PATH = ffprobePath;
            logger.info('[FrameExtractor] Set FFPROBE_PATH', { ffprobePath });
        }
        else {
            logger.warn('[FrameExtractor] FFprobe binary not found via resolver, will use ffmpeg fallback');
        }
        // Resolve output directory to absolute path to prevent saving to backend default path
        const absoluteOutputDir = path.resolve(outputDir);
        // Ensure output directory exists
        if (!fs.existsSync(absoluteOutputDir)) {
            fs.mkdirSync(absoluteOutputDir, { recursive: true });
        }
        // Determine mode
        const mode = options.mode === 'split-segments' ? 'split-segments' : 'extract-interval';
        // Try to get cookies from any active profile to bypass YouTube 403
        let cookiesPath = '';
        try {
            const { profileService } = await import('../profiles/profile.service.js');
            const { getProfileCookiesCompat } = await import('../../utils/profileCookies.js');
            const { writeCookiesToTempFile } = await import('../../utils/cookieConverter.js');
            const profiles = await profileService.list();
            const activeProfile = profiles.find(p => p.active);
            if (activeProfile) {
                const { cookies, hasCookies } = await getProfileCookiesCompat(activeProfile);
                if (hasCookies) {
                    cookiesPath = writeCookiesToTempFile(cookies);
                    logger.info('[FrameExtractor] Using cookies from profile', { profileId: activeProfile.id, cookiesPath });
                }
            }
        }
        catch (error) {
            logger.warn('[FrameExtractor] Failed to inject cookies', { error });
        }
        const optionsJson = JSON.stringify({
            interval: options.interval || 5,
            cookiesPath: cookiesPath || undefined
        });
        logger.info('[FrameExtractor] Starting extraction', {
            jobId,
            videoSource,
            outputDir: absoluteOutputDir,
            mode,
            options,
            hasCookies: !!cookiesPath,
            ffmpegInjected: !!ffmpegPath
        });
        const processSpawn = spawn(pythonBin, [
            scriptPath,
            mode,
            videoSource,
            absoluteOutputDir,
            optionsJson
        ], {
            env
        });
        let stdout = '';
        let stderr = '';
        processSpawn.stdout?.on('data', (data) => {
            stdout += data.toString();
        });
        processSpawn.stderr?.on('data', (data) => {
            const line = data.toString().trim();
            stderr += line + '\n';
            // Parse progress updates
            const progressMatch = line.match(/\[PROGRESS\] (.+) \((\d+)%\)/);
            if (progressMatch) {
                job.progress = `${progressMatch[1]} (${progressMatch[2]}%)`;
            }
            logger.info('[FrameExtractor] Progress', { jobId, line });
        });
        processSpawn.on('close', (code) => {
            job.completedAt = new Date();
            // Clean up temp cookie file
            if (cookiesPath && fs.existsSync(cookiesPath)) {
                try {
                    fs.unlinkSync(cookiesPath);
                    logger.debug('[FrameExtractor] Cleaned up temp cookie file', { cookiesPath });
                }
                catch (e) {
                    logger.warn('[FrameExtractor] Failed to delete temp cookie file', { cookiesPath, error: e });
                }
            }
            if (code !== 0) {
                job.status = 'FAILED';
                // Python script outputs JSON error to stdout, progress to stderr
                let errorMsg = 'Trích xuất thất bại';
                try {
                    // Check stdout first (Python script prints JSON result there)
                    const stdoutMatch = stdout.match(/\{[^}]*"error"\s*:\s*"([^"]+)"/);
                    if (stdoutMatch) {
                        errorMsg = stdoutMatch[1];
                    }
                    else {
                        // Fallback: check stderr
                        const stderrMatch = stderr.match(/\{[^}]*"error"\s*:\s*"([^"]+)"/);
                        if (stderrMatch) {
                            errorMsg = stderrMatch[1];
                        }
                    }
                }
                catch { /* use default */ }
                job.error = errorMsg;
                logger.error('[FrameExtractor] Failed', { jobId, code, error: errorMsg });
                return;
            }
            try {
                const result = JSON.parse(stdout);
                if (result.success) {
                    job.status = 'COMPLETED';
                    job.videoPath = result.videoPath;
                    job.frames = result.frames;
                    job.frameCount = result.frameCount;
                    job.segments = result.segments;
                    job.segmentCount = result.segmentCount;
                    job.progress = result.segmentCount
                        ? `Completed: ${result.segmentCount} segments created`
                        : `Completed: ${result.frameCount} frames extracted`;
                    logger.info('[FrameExtractor] Completed', {
                        jobId,
                        frameCount: result.frameCount
                    });
                }
                else {
                    job.status = 'FAILED';
                    job.error = result.error || 'Unknown error';
                }
            }
            catch (parseError) {
                job.status = 'FAILED';
                job.error = `Failed to parse result: ${parseError.message}`;
                logger.error('[FrameExtractor] Parse error', { jobId, stdout, parseError });
            }
        });
        processSpawn.on('error', (err) => {
            job.status = 'FAILED';
            job.error = err.message;
            job.completedAt = new Date();
            logger.error('[FrameExtractor] Process error', { jobId, error: err.message });
        });
    }
    /**
     * Clean up old jobs (older than 1 hour)
     */
    cleanupOldJobs() {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        for (const [jobId, job] of this.jobs.entries()) {
            if (job.completedAt && job.completedAt < oneHourAgo) {
                this.jobs.delete(jobId);
            }
        }
    }
}
export const frameExtractorService = new FrameExtractorService();
