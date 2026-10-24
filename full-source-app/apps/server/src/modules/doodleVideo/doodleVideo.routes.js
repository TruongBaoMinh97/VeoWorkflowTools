import { z } from 'zod';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { doodleVideoService } from './doodleVideo.service.js';
import { resolvePythonBinary } from '../../utils/pythonResolver.js';
import { logger } from '../../lib/logger.js';
// IDs are Prisma cuids (lowercase alphanumeric). Constrain to a path-safe charset
// so a `:id` segment can never carry `/`, `\`, or `..` into a filesystem path.
const idParam = z.object({ id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/) });
// Partial subtitle config from the frontend. The server merges it with
// DEFAULT_SUBTITLE_CONFIG, so any omitted field falls back to the default.
const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const subtitleConfigSchema = z
    .object({
    enabled: z.boolean(),
    maxLines: z.union([z.literal(1), z.literal(2)]),
    fontSize: z.number().min(8).max(120),
    textColor: hexColor,
    outline: z.boolean(),
    outlineWidth: z.number().min(0).max(20),
    outlineColor: hexColor,
    background: z.boolean(),
    backgroundColor: hexColor,
    backgroundOpacity: z.number().min(0).max(1),
    position: z.enum(['bottom', 'center', 'top']),
    sideMargin: z.number().min(0).max(40),
    maxCharsPerCue: z.number().min(12).max(200),
})
    .partial()
    .optional();
export async function registerDoodleVideoRoutes(app) {
    // ── Whisper install / status (static routes — declared before /:id) ───────
    app.get('/api/doodle-video/whisper-install-status', async () => {
        return { installed: await doodleVideoService.checkWhisperInstalled() };
    });
    // Stream `pip install faster-whisper` progress as text/event-stream.
    app.post('/api/doodle-video/install-whisper', async (req, reply) => {
        const pythonBin = resolvePythonBinary();
        if (!pythonBin) {
            reply.code(500).send({ error: 'Không tìm thấy Python' });
            return;
        }
        reply.hijack();
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        // Guard writes: if the client disconnects mid-install, reply.raw.write throws
        // EPIPE (uncaught → crash) and the orphaned pip keeps running. Track + kill.
        let clientGone = false;
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
        const proc = spawn(pythonBin, ['-m', 'pip', 'install', 'faster-whisper'], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
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
            send(code === 0 ? '__DONE__' : `__ERROR__ exit ${code}`);
            if (!clientGone)
                reply.raw.end();
        });
    });
    app.get('/api/doodle-video/whisper-job/:jobId', async (req) => {
        const { jobId } = z.object({ jobId: z.string() }).parse(req.params);
        const { doodleProjectId } = z
            .object({ doodleProjectId: z.string().optional() })
            .parse(req.query ?? {});
        const status = doodleVideoService.getTranscribeJobStatus(jobId);
        if (!status)
            throw Object.assign(new Error('Không tìm thấy job'), { statusCode: 404 });
        // Persist ONLY while still at AUDIO stage — this GET is polled every ~1s, so an
        // unguarded write would regress a more-advanced stage (PROMPTS_READY/GEN_*) on
        // every repeated poll. DB stage is the source of truth (survives restart).
        if (status.status === 'COMPLETED' && status.segments && doodleProjectId) {
            const current = await doodleVideoService.getProject(doodleProjectId);
            if (current?.stage === 'AUDIO') {
                await doodleVideoService.applyTranscriptionResult(doodleProjectId, status.segments, status.duration ?? 0, { minSec: current.minShotSeconds, maxSec: current.maxShotSeconds });
            }
        }
        return status;
    });
    app.get('/api/doodle-video/assembly-job/:jobId', async (req) => {
        const { jobId } = z.object({ jobId: z.string() }).parse(req.params);
        const job = doodleVideoService.getAssemblyJobStatus(jobId);
        if (!job)
            throw Object.assign(new Error('Không tìm thấy job ghép'), { statusCode: 404 });
        return job;
    });
    // ── Project CRUD ──────────────────────────────────────────────────────────
    app.get('/api/doodle-video', async () => doodleVideoService.listProjects());
    // Lightweight gallery list (static route wins over /:id in Fastify's router).
    app.get('/api/doodle-video/summaries', async () => doodleVideoService.listProjectSummaries());
    app.post('/api/doodle-video', async (req) => {
        const body = z
            .object({
            title: z.string().min(1),
            article: z.string().min(0), // audio-first mode can start with an empty article
            outputDir: z.string().optional(),
            style: z.string().max(80).optional(),
            aspectRatio: z.enum(['16:9', '9:16']).optional(),
            language: z.string().max(10).optional(),
            voiceStyle: z.enum(['calm', 'energetic', 'dramatic', 'storytelling']).optional(),
            mode: z.enum(['full', 'audio-first']).optional(),
            storyStyle: z.string().max(200).optional(),
            audioStyle: z.string().max(200).optional(),
            styleSuffix: z.string().max(200).optional(),
            cultureStyle: z.string().max(80).optional(),
            minShotSeconds: z.number().min(0.5).max(30).optional(),
            maxShotSeconds: z.number().min(1).max(60).optional(),
        })
            .refine((v) => (v.minShotSeconds ?? 4) <= (v.maxShotSeconds ?? 8), {
            message: 'minShotSeconds phải <= maxShotSeconds',
        })
            .parse(req.body);
        const { title, article, ...opts } = body;
        return doodleVideoService.createProject(title, article, opts);
    });
    app.get('/api/doodle-video/:id', async (req) => {
        const { id } = idParam.parse(req.params);
        const project = await doodleVideoService.getProject(id);
        if (!project)
            throw Object.assign(new Error('Không tìm thấy dự án'), { statusCode: 404 });
        return project;
    });
    app.patch('/api/doodle-video/:id', async (req) => {
        const { id } = idParam.parse(req.params);
        const patch = z
            .object({
            title: z.string().optional(),
            topicOptions: z.string().optional(),
            chosenTopicTitle: z.string().optional(),
            script: z.string().optional(),
            imagePrompts: z.string().optional(),
            outputType: z.enum(['IMAGE', 'VIDEO']).optional(),
            outputDir: z.string().optional(),
            stage: z
                .enum([
                'DRAFT', 'TOPICS', 'SCRIPT', 'AUDIO', 'TRANSCRIBED',
                'PROMPTS_READY', 'GEN_IN_PROGRESS', 'GEN_DONE', 'COMPLETED',
            ])
                .optional(),
            status: z.enum(['IDLE', 'RUNNING', 'COMPLETED', 'FAILED']).optional(),
            style: z.string().max(80).optional(),
            aspectRatio: z.enum(['16:9', '9:16']).optional(),
            language: z.string().max(10).optional(),
            voiceStyle: z.enum(['calm', 'energetic', 'dramatic', 'storytelling']).optional(),
            mode: z.enum(['full', 'audio-first']).optional(),
            ttsVoice: z.string().max(120).optional(),
            ttsRate: z.string().max(16).optional(),
            ttsPitch: z.string().max(16).optional(),
            // null explicitly clears an override → falls back to the builtin prompt.
            storyStyle: z.string().max(200).nullable().optional(),
            audioStyle: z.string().max(200).nullable().optional(),
            styleSuffix: z.string().max(200).nullable().optional(),
            customTopicsPrompt: z.string().max(1000).nullable().optional(),
            customScriptPrompt: z.string().max(1000).nullable().optional(),
            customImagePrompt: z.string().max(1000).nullable().optional(),
            minShotSeconds: z.number().min(0.5).max(30).nullable().optional(),
            maxShotSeconds: z.number().min(1).max(60).nullable().optional(),
            cultureStyle: z.string().max(80).nullable().optional(),
        })
            .parse(req.body ?? {});
        return doodleVideoService.updateProject(id, patch);
    });
    app.delete('/api/doodle-video/:id', async (req) => {
        const { id } = idParam.parse(req.params);
        await doodleVideoService.deleteProject(id);
        return { success: true };
    });
    app.get('/api/doodle-video/:id/script.txt', async (req, reply) => {
        const { id } = idParam.parse(req.params);
        const project = await doodleVideoService.getProject(id);
        if (!project?.script) {
            reply.code(404).send('Chưa có kịch bản');
            return;
        }
        reply
            .header('Content-Type', 'text/plain; charset=utf-8')
            .header('Content-Disposition', `attachment; filename="script_${id}.txt"`)
            .send(project.script);
    });
    // ── Audio upload (base64 JSON, like /upload-image) ────────────────────────
    // base64 JSON for large audio (200MB ≈ 267MB encoded) exceeds Fastify's global
    // 50MB bodyLimit → raise it per-route or the framework 413s before the handler.
    app.post('/api/doodle-video/:id/upload-audio', { bodyLimit: 300 * 1024 * 1024 }, async (req) => {
        const { id } = idParam.parse(req.params);
        const { audioBase64, filename } = z
            .object({ audioBase64: z.string().min(1), filename: z.string().optional() })
            .parse(req.body);
        let clean = audioBase64;
        if (clean.includes(',') && clean.startsWith('data:'))
            clean = clean.split(',')[1] ?? clean;
        const approxBytes = Math.floor((clean.length * 3) / 4);
        const MAX = 200 * 1024 * 1024;
        if (approxBytes > MAX)
            throw new Error('File audio quá lớn (tối đa 200MB)');
        const ext = (filename ? path.extname(filename) : '').toLowerCase() || '.mp3';
        const allowed = ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.opus'];
        if (!allowed.includes(ext))
            throw new Error(`Định dạng audio không hỗ trợ: ${ext}`);
        const dir = path.join(os.homedir(), 'Documents', 'Veo3Studio', 'doodle-projects', id);
        await fs.promises.mkdir(dir, { recursive: true });
        const audioPath = path.join(dir, `audio${ext}`);
        // Async write: decoding + flushing 200MB synchronously would block the event
        // loop for seconds, stalling the whisper-job polls the wizard fires every ~1s.
        await fs.promises.writeFile(audioPath, Buffer.from(clean, 'base64'));
        logger.info('[DoodleVideo] audio uploaded', { id, audioPath, bytes: approxBytes });
        return doodleVideoService.setAudioPath(id, audioPath);
    });
    // ── Transcribe / Generate / Assemble ──────────────────────────────────────
    app.post('/api/doodle-video/:id/transcribe', async (req) => {
        const { id } = idParam.parse(req.params);
        const opts = z
            .object({ model: z.string().optional(), language: z.string().optional() })
            .parse(req.body ?? {});
        return doodleVideoService.startTranscription(id, opts);
    });
    app.post('/api/doodle-video/:id/start-gen', async (req) => {
        const { id } = idParam.parse(req.params);
        const opts = z
            .object({
            profileIds: z.array(z.string()).min(1),
            outputType: z.enum(['IMAGE', 'VIDEO']).default('IMAGE'),
            seedImageMediaId: z.string().optional(),
            outputDir: z.string().optional(),
            concurrency: z.number().int().min(1).max(12).optional(),
            delaySeconds: z.number().int().min(1).max(180).optional(),
            batchSize: z.number().int().min(1).max(4).optional(),
            imageModelKey: z.string().optional(),
            videoModelKey: z.string().optional(),
        })
            .parse(req.body);
        return doodleVideoService.startGeneration(id, opts);
    });
    app.get('/api/doodle-video/:id/gen-poll', async (req) => {
        const { id } = idParam.parse(req.params);
        return doodleVideoService.pollGenStatus(id);
    });
    app.post('/api/doodle-video/:id/stop-gen', async (req) => {
        const { id } = idParam.parse(req.params);
        return doodleVideoService.stopGeneration(id);
    });
    app.post('/api/doodle-video/:id/reset-gen', async (req) => {
        const { id } = idParam.parse(req.params);
        return doodleVideoService.resetGeneration(id);
    });
    // Re-group Whisper segments into longer shots (fewer images/videos to generate).
    app.post('/api/doodle-video/:id/regroup', async (req) => {
        const { id } = idParam.parse(req.params);
        const { minShotSeconds, maxShotSeconds } = z
            .object({
            minShotSeconds: z.number().min(0.5).max(30).optional(),
            maxShotSeconds: z.number().min(1).max(60).optional(),
        })
            .refine((v) => (v.minShotSeconds ?? 4) <= (v.maxShotSeconds ?? 8), {
            message: 'minShotSeconds phải <= maxShotSeconds',
        })
            .parse(req.body ?? {});
        return doodleVideoService.regroupSegments(id, minShotSeconds ?? 4, maxShotSeconds ?? 8);
    });
    app.post('/api/doodle-video/:id/assemble', async (req) => {
        const { id } = idParam.parse(req.params);
        const opts = z
            .object({
            burnSubtitles: z.boolean().optional(),
            resolution: z.string().regex(/^\d+x\d+$/).optional(),
            fps: z.number().int().min(1).max(60).optional(),
            subtitleConfig: subtitleConfigSchema,
        })
            .parse(req.body ?? {});
        return doodleVideoService.startAssembly(id, opts);
    });
    // Serve the finished video to the renderer. The wizard fetches this whole
    // response into a blob: URL (a single full GET, no Range), so we send the file
    // as one Buffer — the most reliable path (a manual Content-Length + a Node
    // stream via reply.send produced an empty/0-byte body under this Fastify setup).
    app.get('/api/doodle-video/:id/preview-video', async (req, reply) => {
        const { id } = idParam.parse(req.params);
        const project = await doodleVideoService.getProject(id);
        if (!project?.finalVideoPath) {
            reply.code(404).send({ error: 'Video chưa sẵn sàng' });
            return;
        }
        // Read directly and treat a missing file as 404 — avoids a TOCTOU gap between
        // an existsSync check and the read (file could be cleaned up in between).
        let buf;
        try {
            buf = await fs.promises.readFile(project.finalVideoPath);
        }
        catch {
            reply.code(404).send({ error: 'Video chưa sẵn sàng' });
            return;
        }
        reply
            .header('Content-Type', 'video/mp4')
            .header('Content-Length', buf.length)
            .header('Cache-Control', 'no-store')
            .send(buf);
    });
    // ── FableCut advanced editor bridge (called by the Electron main process) ──
    // Copy shot assets + narration into FableCut's media dir and return the
    // prefilled project.json. `mediaDir` is an absolute path owned by Electron main.
    app.post('/api/doodle-video/:id/fablecut-prepare', async (req) => {
        const { id } = idParam.parse(req.params);
        const body = z
            .object({
            mediaDir: z.string().min(1),
            transitionType: z.string().max(40).optional(),
            transitionDuration: z.number().min(0).max(5).optional(),
            includeSubtitles: z.boolean().optional(),
            kenBurns: z.boolean().optional(),
            fps: z.number().int().min(1).max(60).optional(),
            subtitleConfig: subtitleConfigSchema,
        })
            .parse(req.body ?? {});
        const { mediaDir, ...settings } = body;
        const project = await doodleVideoService.prepareFablecut(id, mediaDir, settings);
        return { project };
    });
    // Import a FableCut-exported MP4 back as the project's final video.
    app.post('/api/doodle-video/:id/fablecut-export-done', async (req) => {
        const { id } = idParam.parse(req.params);
        const { exportPath } = z.object({ exportPath: z.string().min(1) }).parse(req.body);
        return doodleVideoService.finalizeFablecutExport(id, exportPath);
    });
}
