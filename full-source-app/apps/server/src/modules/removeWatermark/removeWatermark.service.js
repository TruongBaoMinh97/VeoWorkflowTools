import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../lib/logger.js';
import { getElectronUserDataPath } from '../../lib/electronPaths.js';
import { resolvePythonBinary, resolvePythonScript } from '../../utils/pythonResolver.js';
import { resolveFfmpegBinary, resolveFfprobeBinary } from '../../utils/ffmpegResolver.js';
const ALPHA_FILENAME = 'alpha_watermark.npy';
const BATCH_SCRIPT = 'remove_watermark_batch.py';
const VIDEO_BATCH_SCRIPT = 'remove_video_watermark_batch.py';
const CALIBRATE_SCRIPT = 'remove_watermark.py';
const VIDEO_EXTS = ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'];
const PROGRESS_RE = /\[PROGRESS\]\s+(\d+)\/(\d+)\s+\((\d+)%\)/;
// Video wrapper adds a suffix: `... video k/N | <name>`
const VIDEO_SUFFIX_RE = /video\s+(\d+)\/(\d+)\s+\|\s+(.*)$/;
/**
 * Build a child env with the bundled ffmpeg/ffprobe injected by FULL PATH
 * (Electron bundles platform-prefixed names like `win32-x64-ffmpeg.exe`, so a
 * bare `ffmpeg` PATH lookup would fail) plus the dir prepended to PATH.
 */
export function buildFfmpegEnv(ffmpegPath, ffprobePath) {
    const env = { ...process.env, FFMPEG_PATH: ffmpegPath };
    if (ffprobePath)
        env.FFPROBE_PATH = ffprobePath;
    const sep = process.platform === 'win32' ? ';' : ':';
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = `${path.dirname(ffmpegPath)}${sep}${env[pathKey] ?? ''}`;
    return env;
}
/**
 * Thư mục user-writable chứa packages cài qua nút "Cài tự động"
 * (pip install --target). Bản cài NSIS per-machine để resources/ read-only
 * lúc runtime nên KHÔNG thể pip install vào bundled site-packages.
 */
export function userPythonPackagesDir() {
    return path.join(getElectronUserDataPath(), 'python-packages');
}
/**
 * Env cho mọi lần spawn Python: prepend PYTHONPATH = userData/python-packages
 * (nếu tồn tại) để packages cài runtime được ưu tiên khi bundle thiếu cv2/numpy.
 */
export function buildPythonEnv(base = process.env) {
    const pkgDir = userPythonPackagesDir();
    if (!fs.existsSync(pkgDir))
        return { ...base };
    const sep = process.platform === 'win32' ? ';' : ':';
    const existing = base.PYTHONPATH ?? '';
    return {
        ...base,
        PYTHONPATH: existing ? `${pkgDir}${sep}${existing}` : pkgDir,
    };
}
/** Persistent, writable location for a user-calibrated alpha map. */
function userAlphaPath() {
    return path.join(getElectronUserDataPath(), 'watermark', ALPHA_FILENAME);
}
/**
 * Resolve the alpha map to use: a user-calibrated map wins over a bundled one;
 * `null` means the Python side falls back to fsr/telea.
 */
export function resolveAlphaPath() {
    const userAlpha = userAlphaPath();
    if (fs.existsSync(userAlpha))
        return userAlpha;
    const bundled = resolvePythonScript(ALPHA_FILENAME); // searches resources/server/python + dev
    return bundled && fs.existsSync(bundled) ? bundled : null;
}
class RemoveWatermarkService {
    constructor() {
        this.jobs = new Map();
        this.processes = new Map();
    }
    startProcessing(opts) {
        this.cleanupOldJobs();
        const jobId = uuidv4();
        const mediaType = opts.mediaType ?? 'image';
        this.jobs.set(jobId, {
            id: jobId,
            status: 'PENDING',
            progress: 'Đang khởi động...',
            done: 0,
            total: 0,
            failed: 0,
            outputs: [],
            outputDir: path.resolve(opts.outputDir),
            mediaType,
            startedAt: new Date(),
        });
        if (mediaType === 'video') {
            void this.runVideoJob(jobId, opts);
        }
        else {
            void this.runJob(jobId, opts);
        }
        return { jobId };
    }
    /** Shared pre-flight: refuse output dir == source dir (would overwrite originals). */
    ensureOutputSafe(job, absInput, absOutput) {
        try {
            const inputDir = fs.statSync(absInput).isDirectory() ? absInput : path.dirname(absInput);
            if (inputDir === absOutput) {
                this.fail(job, 'Thư mục lưu không được trùng thư mục gốc (sẽ ghi đè bản gốc)');
                return false;
            }
        }
        catch {
            /* input không tồn tại — Python sẽ báo lỗi rõ ràng */
        }
        try {
            fs.mkdirSync(absOutput, { recursive: true });
        }
        catch (err) {
            this.fail(job, `Không tạo được thư mục lưu: ${err.message}`);
            return false;
        }
        return true;
    }
    getJobStatus(jobId) {
        return this.jobs.get(jobId) ?? null;
    }
    cancelJob(jobId) {
        const child = this.processes.get(jobId);
        const job = this.jobs.get(jobId);
        if (!child || !job)
            return false;
        // Kill the whole process tree so ProcessPoolExecutor workers stop too.
        if (process.platform === 'win32' && child.pid) {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        }
        else if (child.pid) {
            try {
                process.kill(-child.pid, 'SIGTERM'); // negative pid = the detached group
            }
            catch {
                child.kill('SIGTERM');
            }
        }
        else {
            child.kill('SIGTERM');
        }
        job.status = 'FAILED';
        job.error = 'Đã hủy bởi người dùng';
        job.completedAt = new Date();
        return true;
    }
    isAlphaAvailable() {
        return resolveAlphaPath() !== null;
    }
    async runJob(jobId, opts) {
        const job = this.jobs.get(jobId);
        if (!job)
            return;
        job.status = 'PROCESSING';
        const pythonBin = resolvePythonBinary();
        const scriptPath = resolvePythonScript(BATCH_SCRIPT);
        if (!pythonBin || !scriptPath) {
            // Copy ngắn để vừa cả node Flow 240px lẫn job card.
            this.fail(job, 'Thiếu Python — vào Tiện ích › Xóa Logo để cài.');
            return;
        }
        const absOutput = path.resolve(opts.outputDir);
        const absInput = path.resolve(opts.inputPath);
        if (!this.ensureOutputSafe(job, absInput, absOutput))
            return;
        const args = [
            scriptPath,
            absInput,
            absOutput,
            '--method', opts.method ?? 'calib',
            '--strength', String(opts.strength ?? 1.0),
            '--quality', String(opts.quality ?? 97),
        ];
        const alphaPath = resolveAlphaPath();
        if (alphaPath)
            args.push('--alpha', alphaPath);
        if (opts.workers)
            args.push('--workers', String(opts.workers));
        if (opts.aspectRatio)
            args.push('--aspect-ratio', opts.aspectRatio);
        logger.info('[RemoveWatermark] start', { jobId, input: opts.inputPath, output: absOutput, hasAlpha: !!alphaPath });
        // detached on Unix → child becomes a process-group leader so cancel can kill
        // the whole tree (ProcessPoolExecutor workers included), not just the wrapper.
        const child = spawn(pythonBin, args, {
            detached: process.platform !== 'win32',
            env: buildPythonEnv(),
        });
        this.processes.set(jobId, child);
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d) => {
            stdout += d.toString();
        });
        child.stderr?.on('data', (d) => {
            const text = d.toString();
            stderr += text;
            for (const line of text.split('\n')) {
                const m = line.match(PROGRESS_RE);
                if (m) {
                    job.done = Number(m[1]);
                    job.total = Number(m[2]);
                    job.progress = `Đang xử lý ${m[1]}/${m[2]} (${m[3]}%)`;
                }
            }
        });
        child.on('close', (code) => {
            this.processes.delete(jobId);
            if (job.status === 'FAILED')
                return; // cancelled
            job.completedAt = new Date();
            if (code !== 0) {
                this.fail(job, this.extractError(stdout, stderr, code));
                return;
            }
            try {
                const result = JSON.parse(stdout);
                job.total = result.total;
                job.done = result.done;
                job.failed = result.failed;
                job.method = result.method;
                job.fallback = result.fallback ?? false;
                job.outputs = (result.outputs ?? []).filter((o) => o.ok).map((o) => o.dst);
                if (result.success) {
                    job.status = 'COMPLETED';
                    job.progress = `Hoàn tất: ${result.done}/${result.total} ảnh`
                        + (result.failed ? ` (${result.failed} lỗi)` : '')
                        + (result.fallback ? ' — chế độ tuần tự' : '');
                }
                else {
                    this.fail(job, result.error || 'Xử lý thất bại');
                }
            }
            catch {
                this.fail(job, `Không đọc được kết quả: ${stdout.slice(0, 200)}`);
            }
        });
        child.on('error', (err) => {
            this.processes.delete(jobId);
            this.fail(job, err.message);
        });
    }
    async runVideoJob(jobId, opts) {
        const job = this.jobs.get(jobId);
        if (!job)
            return;
        job.status = 'PROCESSING';
        const pythonBin = resolvePythonBinary();
        const scriptPath = resolvePythonScript(VIDEO_BATCH_SCRIPT);
        const ffmpegPath = resolveFfmpegBinary();
        const ffprobePath = resolveFfprobeBinary();
        if (!pythonBin || !scriptPath) {
            this.fail(job, 'Thiếu Python — vào Tiện ích › Xóa Logo để cài.');
            return;
        }
        if (!ffmpegPath) {
            this.fail(job, 'FFmpeg bắt buộc cho xử lý video — không tìm thấy');
            return;
        }
        if (!ffprobePath) {
            this.fail(job, 'FFprobe bắt buộc cho xử lý video — không tìm thấy (cần bundle ffprobe cùng ffmpeg)');
            return;
        }
        const absOutput = path.resolve(opts.outputDir);
        const absInput = path.resolve(opts.inputPath);
        try {
            if (fs.statSync(absInput).isFile() && !VIDEO_EXTS.includes(path.extname(absInput).toLowerCase())) {
                this.fail(job, `Không hỗ trợ định dạng video: ${path.extname(absInput)}`);
                return;
            }
        }
        catch {
            this.fail(job, `Không tìm thấy: ${opts.inputPath}`);
            return;
        }
        if (!this.ensureOutputSafe(job, absInput, absOutput))
            return;
        const args = [
            scriptPath,
            absInput,
            absOutput,
            '--logo', opts.logo ?? 'auto',
            '--corner', opts.corner ?? 'br',
            '--crf', String(opts.crf ?? 15),
            '--strength', String(opts.strength ?? 1.0),
            '--samples', String(opts.samples ?? 250),
        ];
        logger.info('[RemoveWatermark] video start', { jobId, input: opts.inputPath, output: absOutput });
        const env = buildPythonEnv(buildFfmpegEnv(ffmpegPath, ffprobePath));
        const child = spawn(pythonBin, args, { detached: process.platform !== 'win32', env });
        this.processes.set(jobId, child);
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d) => {
            stdout += d.toString();
        });
        child.stderr?.on('data', (d) => {
            const text = d.toString();
            stderr += text;
            for (const line of text.split('\n')) {
                const m = line.match(PROGRESS_RE);
                if (!m)
                    continue;
                job.done = Number(m[1]); // frames of the current video
                job.total = Number(m[2]);
                job.progress = `Đang xử lý khung hình ${m[1]}/${m[2]} (${m[3]}%)`;
                const v = line.match(VIDEO_SUFFIX_RE);
                if (v) {
                    job.currentVideoIndex = Number(v[1]);
                    job.videosTotal = Number(v[2]);
                    job.currentVideoName = v[3].trim();
                }
            }
        });
        child.on('close', (code) => {
            this.processes.delete(jobId);
            if (job.status === 'FAILED')
                return; // cancelled
            job.completedAt = new Date();
            if (code !== 0) {
                this.fail(job, this.extractError(stdout, stderr, code));
                return;
            }
            try {
                const result = JSON.parse(stdout);
                job.fallback = result.fallback ?? false;
                job.done = result.done; // videos succeeded
                job.total = result.total; // videos total
                job.failed = result.failed;
                job.videosTotal = result.total;
                job.outputs = (result.outputs ?? []).filter((o) => o.ok).map((o) => o.dst);
                if (result.success) {
                    job.status = 'COMPLETED';
                    job.progress = `Hoàn tất: ${result.done}/${result.total} video` + (result.failed ? ` (${result.failed} lỗi)` : '');
                }
                else {
                    const firstErr = (result.outputs ?? []).find((o) => !o.ok)?.error;
                    this.fail(job, result.error || firstErr || 'Xử lý video thất bại');
                }
            }
            catch {
                this.fail(job, `Không đọc được kết quả: ${stdout.slice(0, 200)}`);
            }
        });
        child.on('error', (err) => {
            this.processes.delete(jobId);
            this.fail(job, err.message);
        });
    }
    fail(job, error) {
        job.status = 'FAILED';
        job.error = error;
        job.completedAt = new Date();
        logger.error('[RemoveWatermark] failed', { jobId: job.id, error });
    }
    extractError(stdout, stderr, code) {
        const m = stdout.match(/"error"\s*:\s*"([^"]+)"/) || stderr.match(/"error"\s*:\s*"([^"]+)"/);
        if (m)
            return m[1];
        // Safety net: after the Python-side sequential fallback this should not
        // reach the user, but if the pool still hard-fails, replace the raw
        // traceback with an actionable message.
        const combined = `${stdout}\n${stderr}`;
        // Bundle thiếu cv2/numpy (bản cài cũ trước khi build bundle wheels) — thay
        // traceback thô bằng chỉ đường tới nút "Cài tự động". Copy ngắn để vừa cả
        // node Flow remove-logo (240px) dùng chung service này.
        if (combined.includes("No module named 'cv2'") ||
            combined.includes("No module named 'numpy'")) {
            return 'Thiếu OpenCV/NumPy — vào Tiện ích › Xóa Logo, nhấn «Cài tự động».';
        }
        if (combined.includes('BrokenProcessPool') || combined.includes('process pool was terminated')) {
            return 'Tiến trình xử lý song song bị gián đoạn (thường do hết RAM hoặc thư viện Windows). '
                + 'Hãy thử lại — hệ thống sẽ tự chuyển sang chế độ tuần tự.';
        }
        const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
        return tail || `Tiến trình Python thoát với mã ${code}`;
    }
    /** One-shot calibration → writes a user alpha map into userData/watermark/. */
    calibrate(folder) {
        return new Promise((resolve, reject) => {
            const pythonBin = resolvePythonBinary();
            const scriptPath = resolvePythonScript(CALIBRATE_SCRIPT);
            if (!pythonBin || !scriptPath) {
                reject(new Error('Không tìm thấy Python hoặc script'));
                return;
            }
            const outPath = userAlphaPath();
            try {
                fs.mkdirSync(path.dirname(outPath), { recursive: true });
            }
            catch (err) {
                reject(err);
                return;
            }
            const child = spawn(pythonBin, [scriptPath, 'calibrate', path.resolve(folder), '-o', outPath], {
                env: buildPythonEnv(),
            });
            let out = '';
            let err = '';
            child.stdout?.on('data', (d) => (out += d.toString()));
            child.stderr?.on('data', (d) => (err += d.toString()));
            child.on('close', (code) => {
                if (code === 0 && fs.existsSync(outPath)) {
                    const m = out.match(/\((\d+)\s*anh/);
                    resolve({ alphaPath: outPath, count: m ? Number(m[1]) : 0 });
                }
                else {
                    reject(new Error(err.trim().split('\n').slice(-2).join(' ') || 'Cân chỉnh thất bại'));
                }
            });
            child.on('error', reject);
        });
    }
    cleanupOldJobs() {
        const cutoff = Date.now() - 60 * 60 * 1000;
        for (const [id, job] of this.jobs.entries()) {
            if (job.completedAt && job.completedAt.getTime() < cutoff) {
                this.jobs.delete(id);
                this.processes.delete(id);
            }
        }
    }
}
export const removeWatermarkService = new RemoveWatermarkService();
