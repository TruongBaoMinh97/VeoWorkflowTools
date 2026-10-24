/**
 * Whisper transcription bridge (Node → Python) for the Doodle Video Pipeline.
 * Mirrors frameExtractor.service.ts: spawns a python worker, parses
 * "[PROGRESS] step (NN%)" on stderr and a single JSON result on stdout, and
 * tracks jobs in an in-memory Map polled by the routes.
 */
import { spawn } from 'child_process';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { resolvePythonBinary, resolvePythonScript } from '../../utils/pythonResolver.js';
import { resolveFfmpegBinary, resolveFfprobeBinary } from '../../utils/ffmpegResolver.js';
import { logger } from '../../lib/logger.js';
const SCRIPT_NAME = 'whisper_transcribe.py';
function buildEnv() {
    const env = { ...process.env };
    const ffmpegPath = resolveFfmpegBinary();
    const ffprobePath = resolveFfprobeBinary();
    // faster-whisper decodes via PyAV and does not require system ffmpeg, but we
    // surface the bundled binaries anyway for parity with the frame extractor.
    if (ffmpegPath) {
        env.FFMPEG_PATH = ffmpegPath;
        const ffmpegDir = path.dirname(ffmpegPath);
        const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
        const separator = process.platform === 'win32' ? ';' : ':';
        env[pathKey] = `${ffmpegDir}${separator}${env[pathKey] || ''}`;
    }
    if (ffprobePath)
        env.FFPROBE_PATH = ffprobePath;
    return env;
}
class WhisperTranscribeService {
    constructor() {
        this.jobs = new Map();
        this.installedCache = null;
        this.installedCacheUntil = 0;
    }
    /** Check whether faster-whisper is importable in the resolved venv (cached 30s). */
    async checkInstalled() {
        if (this.installedCache !== null && Date.now() < this.installedCacheUntil) {
            return this.installedCache;
        }
        const pythonBin = resolvePythonBinary();
        const scriptPath = resolvePythonScript(SCRIPT_NAME);
        if (!pythonBin || !scriptPath)
            return false;
        return new Promise((resolve) => {
            const proc = spawn(pythonBin, [scriptPath, 'check-install'], { env: buildEnv() });
            let stdout = '';
            proc.stdout?.on('data', (d) => (stdout += d.toString()));
            proc.on('error', () => resolve(false));
            proc.on('close', () => {
                try {
                    const parsed = JSON.parse(stdout.trim().split('\n').pop() || '{}');
                    const installed = parsed.installed === true;
                    this.installedCache = installed;
                    this.installedCacheUntil = Date.now() + 30000;
                    resolve(installed);
                }
                catch {
                    resolve(false);
                }
            });
        });
    }
    startTranscription(audioPath, options = {}) {
        const jobId = uuidv4();
        const job = {
            id: jobId,
            status: 'PENDING',
            progress: 'Đang khởi tạo...',
            startedAt: new Date(),
        };
        this.jobs.set(jobId, job);
        void this.run(jobId, audioPath, options);
        return { jobId };
    }
    getJobStatus(jobId) {
        return this.jobs.get(jobId) || null;
    }
    async run(jobId, audioPath, options) {
        const job = this.jobs.get(jobId);
        if (!job)
            return;
        job.status = 'PROCESSING';
        job.progress = 'Đang bắt đầu...';
        const pythonBin = resolvePythonBinary();
        const scriptPath = resolvePythonScript(SCRIPT_NAME);
        if (!pythonBin || !scriptPath) {
            job.status = 'FAILED';
            job.error = 'Không tìm thấy Python hoặc whisper_transcribe.py';
            job.completedAt = new Date();
            logger.error('[Whisper] python or script not found', { pythonBin, scriptPath });
            return;
        }
        const optionsJson = JSON.stringify({
            model: options.model || 'small',
            language: options.language,
        });
        const proc = spawn(pythonBin, [scriptPath, 'transcribe', path.resolve(audioPath), optionsJson], { env: buildEnv() });
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (d) => (stdout += d.toString()));
        proc.stderr?.on('data', (d) => {
            const line = d.toString().trim();
            stderr += line + '\n';
            const m = line.match(/\[PROGRESS\] (.+) \((\d+)%\)/);
            if (m)
                job.progress = `${m[1]} (${m[2]}%)`;
        });
        proc.on('error', (err) => {
            job.status = 'FAILED';
            job.error = err.message;
            job.completedAt = new Date();
            logger.error('[Whisper] process error', { jobId, error: err.message });
        });
        proc.on('close', (code) => {
            job.completedAt = new Date();
            if (code !== 0) {
                job.status = 'FAILED';
                job.error = this.extractError(stdout) || this.extractError(stderr) || 'Transcribe thất bại';
                logger.error('[Whisper] failed', { jobId, code, error: job.error });
                return;
            }
            try {
                const result = JSON.parse(stdout.trim().split('\n').pop() || '{}');
                if (result.success) {
                    job.status = 'COMPLETED';
                    job.segments = result.segments;
                    job.segmentCount = result.segmentCount;
                    job.duration = result.duration;
                    job.language = result.language;
                    job.progress = `Hoàn thành: ${result.segmentCount} phân đoạn`;
                }
                else {
                    job.status = 'FAILED';
                    job.error = result.error || 'Lỗi không xác định';
                }
            }
            catch (e) {
                job.status = 'FAILED';
                job.error = `Không đọc được kết quả: ${e.message}`;
                logger.error('[Whisper] parse error', { jobId, stdout: stdout.slice(0, 500) });
            }
        });
    }
    extractError(text) {
        // Parse the last JSON line (the worker prints one JSON result object).
        // Regex on {...} breaks when the error message itself contains "}".
        try {
            const lastLine = text.trim().split('\n').pop() ?? '';
            const parsed = JSON.parse(lastLine);
            if (parsed &&
                typeof parsed === 'object' &&
                typeof parsed.error === 'string') {
                return parsed.error;
            }
        }
        catch {
            /* not JSON — fall through */
        }
        return null;
    }
}
export const whisperTranscribeService = new WhisperTranscribeService();
