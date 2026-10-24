import { z } from 'zod';
import { spawn } from 'child_process';
import fs from 'fs';
import { removeWatermarkService, buildPythonEnv, userPythonPackagesDir, } from './removeWatermark.service.js';
import { resolvePythonBinary } from '../../utils/pythonResolver.js';
// Cùng pin với bước bundle trong build-release.sh — numpy<2 vì wheel cv2 build
// trên ABI numpy 1.x; contrib (không phải bản thường) vì script dùng cv2.xphoto.
const PIP_PACKAGES = [
    'opencv-contrib-python-headless>=4.9,<5',
    'numpy>=1.26,<2',
    'pillow>=10,<12',
];
const processSchema = z.object({
    inputPath: z
        .string()
        .min(1, 'Thiếu đường dẫn ảnh/video/thư mục')
        .refine((p) => !/^https?:\/\//i.test(p), 'Chỉ hỗ trợ tệp/thư mục cục bộ'),
    outputDir: z.string().min(1, 'Thiếu thư mục lưu'),
    mediaType: z.enum(['image', 'video']).default('image'),
    strength: z.number().min(0.1).max(2.0).default(1.0),
    // image-only (bỏ qua khi mediaType='video')
    aspectRatio: z.enum(['9:16', '16:9', '4:3', '3:4', '1:1']).optional(),
    method: z.enum(['calib', 'fsr', 'telea']).default('calib'),
    quality: z.number().int().min(50).max(100).default(97),
    workers: z.number().int().min(1).max(16).optional(),
    // video-only (bỏ qua khi mediaType='image')
    logo: z.enum(['auto', 'veo', 'star', 'both']).default('auto'),
    corner: z.enum(['br', 'bl', 'tr', 'tl']).default('br'),
    crf: z.number().int().min(12).max(28).default(15),
    samples: z.number().int().min(50).max(500).default(250),
});
const jobIdSchema = z.object({ jobId: z.string().uuid() });
export async function registerRemoveWatermarkRoutes(app) {
    app.post('/api/remove-watermark/process', async (req, reply) => {
        const body = processSchema.parse(req.body);
        const result = removeWatermarkService.startProcessing(body);
        reply.status(202);
        return { success: true, data: result };
    });
    app.get('/api/remove-watermark/status/:jobId', async (req, reply) => {
        const { jobId } = jobIdSchema.parse(req.params);
        const job = removeWatermarkService.getJobStatus(jobId);
        if (!job) {
            reply.status(404);
            return { success: false, message: 'Không tìm thấy job' };
        }
        return { success: true, data: job };
    });
    app.post('/api/remove-watermark/cancel/:jobId', async (req) => {
        const { jobId } = jobIdSchema.parse(req.params);
        return { success: removeWatermarkService.cancelJob(jobId) };
    });
    app.post('/api/remove-watermark/calibrate', async (req, reply) => {
        const { folder } = z.object({ folder: z.string().min(1) }).parse(req.body);
        try {
            const data = await removeWatermarkService.calibrate(folder);
            return { success: true, data };
        }
        catch (err) {
            reply.status(400);
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    });
    /**
     * Kiểm tra môi trường Python cho tính năng xóa logo/vật thể. Bundle Windows
     * từng ship thiếu cv2/numpy — UI dùng endpoint này để hiện banner + nút
     * "Cài tự động" thay vì để job chết với traceback thô.
     */
    app.get('/api/remove-watermark/env-check', async () => {
        const pythonBin = resolvePythonBinary();
        if (!pythonBin) {
            return {
                success: true,
                data: {
                    ok: false,
                    pythonFound: false,
                    cv2: false,
                    numpy: false,
                    canAutoInstall: false,
                    missing: ['python'],
                    error: 'Không tìm thấy Python',
                },
            };
        }
        const data = await new Promise((resolve) => {
            const child = spawn(pythonBin, ['-c', 'import cv2, numpy; print(cv2.__version__, numpy.__version__)'], { env: buildPythonEnv() });
            // Import cv2 lần đầu có thể chậm trên đĩa quay — 15s là dư, nhưng phải
            // có trần để endpoint không treo vô hạn khi python.exe kẹt.
            const killer = setTimeout(() => child.kill(), 15000);
            let out = '';
            let err = '';
            child.stdout?.on('data', (d) => (out += d.toString()));
            child.stderr?.on('data', (d) => (err += d.toString()));
            child.on('error', (e) => {
                clearTimeout(killer);
                // spawn error = binary không exec được (path hỏng/sai arch) — pip cũng
                // sẽ chết y hệt, nên KHÔNG được mời user bấm "Cài tự động".
                resolve({
                    ok: false,
                    pythonFound: false,
                    cv2: false,
                    numpy: false,
                    canAutoInstall: false,
                    missing: ['python'],
                    error: e.message,
                });
            });
            child.on('close', (code) => {
                clearTimeout(killer);
                if (code === 0) {
                    const [cv2Version, numpyVersion] = out.trim().split(/\s+/);
                    resolve({
                        ok: true,
                        pythonFound: true,
                        cv2: true,
                        numpy: true,
                        canAutoInstall: true,
                        missing: [],
                        versions: { cv2: cv2Version ?? '?', numpy: numpyVersion ?? '?' },
                    });
                    return;
                }
                const missing = [];
                if (err.includes("No module named 'cv2'"))
                    missing.push('opencv');
                if (err.includes("No module named 'numpy'"))
                    missing.push('numpy');
                // Import cv2 fail vì lý do khác (DLL hỏng…) vẫn coi là chưa sẵn sàng —
                // cài lại qua nút tự động thường tự chữa.
                if (missing.length === 0)
                    missing.push('opencv');
                resolve({
                    ok: false,
                    pythonFound: true,
                    cv2: !missing.includes('opencv'),
                    numpy: !missing.includes('numpy'),
                    canAutoInstall: true,
                    missing,
                    error: err.trim().split('\n').slice(-2).join(' ').slice(0, 200),
                });
            });
        });
        return { success: true, data };
    });
    /**
     * Cài cv2/numpy vào <userData>/python-packages (user-writable — resources/
     * read-only với bản cài NSIS per-machine), stream tiến trình pip dạng SSE.
     * Mirror pattern install-whisper (doodleVideo.routes.ts).
     */
    app.post('/api/remove-watermark/install-deps', async (req, reply) => {
        const pythonBin = resolvePythonBinary();
        if (!pythonBin) {
            reply.code(500).send({ error: 'Không tìm thấy Python' });
            return;
        }
        const pkgDir = userPythonPackagesDir();
        try {
            fs.mkdirSync(pkgDir, { recursive: true });
        }
        catch (err) {
            reply.code(500).send({
                error: `Không tạo được thư mục cài đặt: ${err instanceof Error ? err.message : String(err)}`,
            });
            return;
        }
        reply.hijack();
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        // Guard writes: client rớt giữa chừng → write EPIPE (uncaught = crash) và
        // pip mồ côi chạy tiếp. Track + kill như install-whisper. Node không throw
        // sync trên EPIPE mà emit 'error' trên socket — phải bắt cả event này.
        let clientGone = false;
        reply.raw.on('error', () => {
            clientGone = true;
        });
        const send = (line) => {
            if (clientGone)
                return;
            try {
                reply.raw.write(`data: ${line}\n\n`);
            }
            catch {
                clientGone = true;
            }
        };
        const proc = spawn(pythonBin, ['-m', 'pip', 'install', '--target', pkgDir, '--upgrade', ...PIP_PACKAGES], { stdio: ['ignore', 'pipe', 'pipe'] });
        req.raw.on('close', () => {
            clientGone = true;
            proc.kill();
        });
        proc.stdout?.on('data', (d) => send(d.toString().trim()));
        proc.stderr?.on('data', (d) => send(d.toString().trim()));
        proc.on('error', (err) => {
            send(`__ERROR__ ${err.message}`);
            if (!clientGone)
                reply.raw.end();
        });
        proc.on('close', (code) => {
            send(code === 0 ? '__DONE__' : `__ERROR__ pip thoát với mã ${code}`);
            if (!clientGone)
                reply.raw.end();
        });
    });
}
