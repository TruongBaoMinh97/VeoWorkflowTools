/**
 * Doodle Video Pipeline orchestrator (backend).
 *
 * Owns persistence of the DoodleVideoProject, drives the existing GenNormal
 * image/video generation, runs Whisper transcription, and assembles the final
 * timeline-synced video. LLM stages (topics/script/image prompts) run in the
 * renderer via Firebase→OpenRouter; the renderer PATCHes their results here.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { genNormalService } from '../genNormal/genNormal.service.js';
import { whisperTranscribeService } from './whisperTranscribe.service.js';
import { concatVideos, overlayAudio, generateASS, burnSubtitles, getMediaDuration, } from '../../utils/ffmpegUtils.js';
import { imageToFixedClip, trimOrPadClip } from '../../utils/ffmpegTimeline.js';
import { buildFablecutProject } from './fablecutBuilder.js';
import { DEFAULT_SUBTITLE_CONFIG, wrapAndSplit } from './subtitleLayout.js';
/** Timeline clip resolution per aspect ratio (portrait vs landscape). */
function resolutionForAspect(aspectRatio) {
    return aspectRatio === '9:16' ? '1080x1920' : '1920x1080';
}
function doodleProjectDir(id) {
    return path.join(os.homedir(), 'Documents', 'Veo3Studio', 'doodle-projects', id);
}
// Whisper can stop transcribing before the real audio EOF (trailing silence);
// stretch the last segment so the assembled timeline covers the full audio.
function driftAdjust(segments, audioDuration) {
    if (segments.length === 0)
        return segments;
    return segments.map((s, i) => i === segments.length - 1 ? { ...s, end: Math.max(s.end, audioDuration) } : s);
}
const DEFAULT_MIN_SHOT_SECONDS = 4;
const DEFAULT_MAX_SHOT_SECONDS = 8;
/**
 * Merge consecutive short Whisper segments into "shots" of at least `minSec`
 * (with `maxSec` as a soft ceiling), so fewer images/videos are generated.
 * Absorbs segments until the accumulated span reaches minSec; stops before
 * exceeding maxSec only once minSec is met (else force-merges past maxSec).
 */
function groupSegments(raw, minSec, maxSec) {
    const groups = [];
    let i = 0;
    while (i < raw.length) {
        const anchor = raw[i];
        let accEnd = anchor.end;
        let accText = anchor.text ?? '';
        let accDur = anchor.end - anchor.start;
        while (i + 1 < raw.length) {
            const wouldBeDur = raw[i + 1].end - anchor.start;
            if (wouldBeDur > maxSec && accDur >= minSec)
                break;
            i++;
            accEnd = raw[i].end;
            accText = `${accText} ${raw[i].text ?? ''}`;
            accDur = accEnd - anchor.start;
        }
        groups.push({ start: anchor.start, end: accEnd, text: accText.trim() });
        i++;
    }
    return groups;
}
/**
 * Map completed gen results onto the shot timeline, SKIPPING failed/missing shots
 * by folding their duration into the previous completed clip (the still holds /
 * the video loops longer). Leading gaps carry into the first completed clip.
 * Total duration is preserved so the assembled video stays in sync with the audio.
 */
function planShots(segments, jobsByIndex) {
    const clips = [];
    let carry = 0;
    let carryStart = null;
    for (let i = 0; i < segments.length; i++) {
        const nextSeg = segments[i + 1];
        const span = Math.max(0.5, nextSeg !== undefined ? nextSeg.start - segments[i].start : segments[i].end - segments[i].start);
        const job = jobsByIndex.get(i);
        if (job && job.status === 'COMPLETED' && job.resultUrl) {
            clips.push({
                resultUrl: job.resultUrl,
                index: i,
                start: carryStart ?? segments[i].start,
                duration: span + carry,
            });
            carry = 0;
            carryStart = null;
        }
        else if (clips.length > 0) {
            clips[clips.length - 1].duration += span; // extend the previous shot
        }
        else {
            carry += span; // leading failure — hold the first completed shot longer
            if (carryStart === null)
                carryStart = segments[i].start;
        }
    }
    return clips;
}
class DoodleVideoService {
    constructor() {
        this.assemblyJobs = new Map();
    }
    // ── CRUD ────────────────────────────────────────────────────────────────
    async createProject(title, article, opts) {
        const mode = opts?.mode ?? 'full';
        // audio-first skips topic+script generation → start at the AUDIO stage.
        const stage = mode === 'audio-first' ? 'AUDIO' : 'DRAFT';
        return prisma.doodleVideoProject.create({
            data: {
                title,
                article,
                outputDir: opts?.outputDir ?? null,
                style: opts?.style ?? 'doodle',
                aspectRatio: opts?.aspectRatio ?? '16:9',
                language: opts?.language ?? 'vi',
                voiceStyle: opts?.voiceStyle ?? 'calm',
                mode,
                storyStyle: opts?.storyStyle ?? null,
                audioStyle: opts?.audioStyle ?? null,
                styleSuffix: opts?.styleSuffix ?? null,
                cultureStyle: opts?.cultureStyle ?? null,
                minShotSeconds: opts?.minShotSeconds ?? null,
                maxShotSeconds: opts?.maxShotSeconds ?? null,
                stage,
                status: 'IDLE',
            },
        });
    }
    listProjects() {
        return prisma.doodleVideoProject.findMany({ orderBy: { createdAt: 'desc' } });
    }
    /** Lightweight list for the gallery — excludes large JSON blobs (article/script/segments). */
    listProjectSummaries() {
        return prisma.doodleVideoProject.findMany({
            select: {
                id: true,
                title: true,
                stage: true,
                status: true,
                style: true,
                aspectRatio: true,
                thumbnailPath: true,
                finalVideoPath: true,
                createdAt: true,
                updatedAt: true,
            },
            orderBy: { createdAt: 'desc' },
            take: 100,
        });
    }
    getProject(id) {
        return prisma.doodleVideoProject.findUnique({ where: { id } });
    }
    async deleteProject(id) {
        await prisma.doodleVideoProject.delete({ where: { id } });
    }
    /** Persist LLM artifacts sent from the renderer (topics/script/prompts/stage). */
    async updateProject(id, patch) {
        return prisma.doodleVideoProject.update({ where: { id }, data: patch });
    }
    // ── Audio + Whisper ───────────────────────────────────────────────────────
    async setAudioPath(id, audioPath) {
        let duration = null;
        try {
            duration = await getMediaDuration(audioPath);
        }
        catch (e) {
            logger.warn('[DoodleVideo] could not probe audio duration', { error: e?.message });
        }
        return prisma.doodleVideoProject.update({
            where: { id },
            data: { audioPath, audioDuration: duration, stage: 'AUDIO' },
        });
    }
    async startTranscription(id, opts) {
        const project = await this.getProject(id);
        if (!project?.audioPath)
            throw new Error('Chưa có file audio để transcribe');
        return whisperTranscribeService.startTranscription(project.audioPath, opts);
    }
    getTranscribeJobStatus(jobId) {
        return whisperTranscribeService.getJobStatus(jobId);
    }
    async applyTranscriptionResult(id, segments, duration, opts) {
        const minSec = opts?.minSec ?? DEFAULT_MIN_SHOT_SECONDS;
        const maxSec = opts?.maxSec ?? DEFAULT_MAX_SHOT_SECONDS;
        const grouped = groupSegments(segments, minSec, maxSec);
        return prisma.doodleVideoProject.update({
            where: { id },
            data: {
                rawWhisperSegments: JSON.stringify(segments), // keep original for re-grouping
                whisperSegments: JSON.stringify(grouped), // grouped = what the whole pipeline reads
                audioDuration: duration,
                stage: 'TRANSCRIBED',
            },
        });
    }
    /**
     * Re-derive the grouped shots from the raw segments with new min/max seconds.
     * Invalidates any existing image prompts (their count would no longer match)
     * and gates on stage — after gen has started the user must reset-gen first.
     */
    async regroupSegments(id, minSec, maxSec) {
        const project = await this.getProject(id);
        if (!project)
            throw new Error('Không tìm thấy dự án');
        if (['GEN_IN_PROGRESS', 'GEN_DONE', 'COMPLETED'].includes(project.stage)) {
            throw new Error('Không đổi được thời lượng shot sau khi đã gen — hãy "Gen lại" trước.');
        }
        const rawJson = project.rawWhisperSegments ?? project.whisperSegments; // bootstrap old projects
        if (!rawJson)
            throw new Error('Chưa có phân đoạn Whisper');
        let raw;
        try {
            raw = JSON.parse(rawJson);
        }
        catch {
            throw new Error('Dữ liệu phân đoạn Whisper bị lỗi định dạng.');
        }
        const grouped = groupSegments(raw, minSec, maxSec);
        return prisma.doodleVideoProject.update({
            where: { id },
            data: {
                rawWhisperSegments: project.rawWhisperSegments ?? JSON.stringify(raw),
                whisperSegments: JSON.stringify(grouped),
                minShotSeconds: minSec,
                maxShotSeconds: maxSec,
                imagePrompts: null, // stale — count no longer matches the new shots
                stage: 'TRANSCRIBED',
            },
        });
    }
    checkWhisperInstalled() {
        return whisperTranscribeService.checkInstalled();
    }
    // ── Generation (reuse GenNormal) ──────────────────────────────────────────
    async startGeneration(id, opts) {
        const project = await this.getProject(id);
        if (!project)
            throw new Error('Không tìm thấy dự án');
        if (!project.imagePrompts)
            throw new Error('Chưa có image prompts');
        let prompts;
        try {
            prompts = JSON.parse(project.imagePrompts);
        }
        catch {
            throw new Error(`Dữ liệu image prompts bị lỗi định dạng (dự án ${id}). Hãy tạo lại prompts.`);
        }
        if (!Array.isArray(prompts) || prompts.length === 0)
            throw new Error('Danh sách prompt rỗng');
        const outputDir = opts.outputDir ?? doodleProjectDir(id);
        const aspectRatio = project.aspectRatio ?? '16:9';
        const gnProject = await genNormalService.createProject({
            name: `Doodle - ${project.chosenTopicTitle ?? project.title}`,
            profileIds: opts.profileIds,
            aspectRatio,
            outputDir,
            source: 'normal',
        });
        if (!gnProject)
            throw new Error('Tạo GenNormal project thất bại');
        // Signed Google CDN resultUrl expires (~1h); auto-save assets to disk so the
        // assembly step (which may run hours later) reads local file:// paths.
        await genNormalService.updateProject(gnProject.id, { autoDownload: true });
        const seedRefs = this.buildSeedRefs(opts.seedImageMediaId, opts.profileIds);
        if (opts.outputType === 'IMAGE') {
            await genNormalService.submitImageGenerationBatch(gnProject.id, prompts, aspectRatio, seedRefs, false);
            await genNormalService.startGeneration(gnProject.id, opts.concurrency ?? 4, opts.delaySeconds ?? 10, undefined, opts.batchSize ?? 1, opts.imageModelKey);
        }
        else {
            await genNormalService.submitBatch(gnProject.id, prompts, aspectRatio, 'TEXT_TO_VIDEO', opts.concurrency ?? 4, opts.delaySeconds ?? 10, opts.videoModelKey, seedRefs, undefined, false);
            await genNormalService.startGeneration(gnProject.id, opts.concurrency ?? 4, opts.delaySeconds ?? 10, opts.videoModelKey, opts.batchSize ?? 1);
        }
        await prisma.doodleVideoProject.update({
            where: { id },
            data: {
                genNormalProjectId: gnProject.id,
                outputType: opts.outputType,
                seedImageMediaId: opts.seedImageMediaId ?? null,
                outputDir,
                stage: 'GEN_IN_PROGRESS',
                status: 'RUNNING',
            },
        });
        return { genNormalProjectId: gnProject.id, jobCount: prompts.length };
    }
    /** Stop the running GenNormal gen (cancel active + queued jobs). */
    async stopGeneration(id) {
        const project = await this.getProject(id);
        if (!project?.genNormalProjectId)
            throw new Error('Chưa bắt đầu gen');
        return genNormalService.stopProject(project.genNormalProjectId);
    }
    /** Reset the gen step so the user can start a fresh run (best-effort stops the old one). */
    async resetGeneration(id) {
        const project = await this.getProject(id);
        if (!project)
            throw new Error('Không tìm thấy dự án');
        if (project.genNormalProjectId) {
            try {
                await genNormalService.stopProject(project.genNormalProjectId);
            }
            catch {
                /* best-effort — the old project may already be gone */
            }
        }
        return prisma.doodleVideoProject.update({
            where: { id },
            data: { genNormalProjectId: null, thumbnailPath: null, stage: 'PROMPTS_READY', status: 'IDLE' },
        });
    }
    /** Normalise the seed reference into GenNormal's Array<Record<profileId,mediaId>>. */
    buildSeedRefs(seedImageMediaId, profileIds) {
        if (!seedImageMediaId)
            return [];
        let perProfile;
        try {
            const parsed = JSON.parse(seedImageMediaId);
            perProfile = typeof parsed === 'object' && parsed !== null ? parsed : {};
        }
        catch {
            // Single mediaId → reuse for every profile.
            perProfile = {};
            for (const pid of profileIds)
                perProfile[pid] = seedImageMediaId;
        }
        return Object.keys(perProfile).length > 0 ? [perProfile] : [];
    }
    async pollGenStatus(id) {
        const project = await this.getProject(id);
        if (!project?.genNormalProjectId)
            throw new Error('Chưa bắt đầu gen');
        const poll = await genNormalService.pollJobs(project.genNormalProjectId);
        const stats = poll.stats;
        const allDone = stats &&
            stats.total > 0 &&
            stats.completed + stats.failed + (stats.cancelled ?? 0) >= stats.total &&
            !stats.processing &&
            !stats.queued;
        if (allDone && project.stage === 'GEN_IN_PROGRESS') {
            // Capture a LOCAL thumbnail (first completed shot) for gallery cards — Google
            // CDN result URLs expire ~1h, so never store the remote URL. Best-effort.
            let thumbnailPath = null;
            try {
                const jobs = await genNormalService.getProjectJobs(project.genNormalProjectId);
                const first = jobs
                    .filter((j) => j.status === 'COMPLETED' && j.resultUrl)
                    .sort((a, b) => a.jobIndex - b.jobIndex)[0];
                const url = first?.resultUrl;
                if (url) {
                    if (url.startsWith('file://')) {
                        thumbnailPath = fileURLToPath(url);
                    }
                    else if (fs.existsSync(url)) {
                        thumbnailPath = url;
                    }
                    else {
                        const dir = project.outputDir ?? doodleProjectDir(id);
                        fs.mkdirSync(dir, { recursive: true });
                        const dest = path.join(dir, 'thumbnail.png');
                        await this.downloadTo(url, dest);
                        thumbnailPath = dest;
                    }
                }
            }
            catch {
                /* best-effort thumbnail; ignore */
            }
            await prisma.doodleVideoProject.update({
                where: { id },
                data: { stage: 'GEN_DONE', ...(thumbnailPath ? { thumbnailPath } : {}) },
            });
        }
        return poll;
    }
    // ── Assembly (ffmpeg timeline) ────────────────────────────────────────────
    startAssembly(id, opts) {
        // Idempotency: never launch a 2nd assembly for the same project — both would
        // write the same temp files (asset_0000, clip_0000, silent_timeline) and corrupt.
        for (const existing of this.assemblyJobs.values()) {
            if (existing.doodleProjectId === id && existing.status === 'RUNNING') {
                return { assemblyJobId: existing.id };
            }
        }
        const jobId = uuidv4();
        const job = {
            id: jobId,
            doodleProjectId: id,
            status: 'RUNNING',
            progress: 'Bắt đầu ghép...',
            progressPct: 0,
            startedAt: new Date(),
        };
        this.assemblyJobs.set(jobId, job);
        void this.runAssembly(id, job, opts).catch(async (err) => {
            job.status = 'FAILED';
            job.error = err?.message ?? String(err);
            job.completedAt = new Date();
            logger.error('[DoodleVideo] assembly failed', { id, error: job.error });
            try {
                fs.rmSync(path.join(doodleProjectDir(id), 'assembly'), { recursive: true, force: true });
            }
            catch {
                /* best-effort temp cleanup */
            }
            await prisma.doodleVideoProject
                .update({ where: { id }, data: { status: 'FAILED' } })
                .catch(() => undefined);
        });
        return { assemblyJobId: jobId };
    }
    getAssemblyJobStatus(jobId) {
        return this.assemblyJobs.get(jobId) ?? null;
    }
    async runAssembly(id, job, opts) {
        const project = await this.getProject(id);
        if (!project)
            throw new Error('Không tìm thấy dự án');
        if (!project.genNormalProjectId)
            throw new Error('Chưa có project gen');
        if (!project.whisperSegments)
            throw new Error('Chưa có phân đoạn Whisper');
        if (!project.audioPath || !fs.existsSync(project.audioPath))
            throw new Error('File audio bị thiếu');
        let parsedSegments;
        try {
            parsedSegments = JSON.parse(project.whisperSegments);
        }
        catch {
            throw new Error(`Dữ liệu phân đoạn Whisper bị lỗi định dạng (dự án ${id}). Hãy phân tích lại audio.`);
        }
        const segments = driftAdjust(parsedSegments, project.audioDuration ?? 0);
        const outputType = project.outputType ?? 'IMAGE';
        const outputDir = project.outputDir ?? doodleProjectDir(id);
        const assemblyDir = path.join(doodleProjectDir(id), 'assembly');
        fs.mkdirSync(assemblyDir, { recursive: true });
        fs.mkdirSync(outputDir, { recursive: true });
        // 1. Completed jobs in timeline (jobIndex) order.
        job.progress = 'Đang tải kết quả gen...';
        job.progressPct = 5;
        const allJobs = await genNormalService.getProjectJobs(project.genNormalProjectId);
        // Skip failed/missing shots: fold their duration into the previous clip so the
        // timeline still covers the full audio (still holds longer / video loops).
        const jobsByIndex = new Map(allJobs.map((j) => [j.jobIndex, { status: j.status, resultUrl: j.resultUrl ?? null }]));
        const planned = planShots(segments, jobsByIndex);
        if (planned.length === 0) {
            throw new Error('Chưa có shot nào tạo thành công để ghép. Hãy retry job lỗi hoặc gen lại.');
        }
        const clipOpts = {
            fps: opts.fps ?? 25,
            resolution: opts.resolution ?? resolutionForAspect(project.aspectRatio),
        };
        const CHUNK = 4;
        const clipPaths = [];
        // 2. Per-planned-clip: download asset → fixed-duration silent clip.
        job.progress = 'Đang tạo clip từng shot...';
        for (let start = 0; start < planned.length; start += CHUNK) {
            const chunk = planned.slice(start, start + CHUNK);
            const results = await Promise.all(chunk.map(async (clip) => {
                const duration = Math.max(0.5, clip.duration);
                const ext = outputType === 'IMAGE' ? '.png' : '.mp4';
                const assetPath = path.join(assemblyDir, `asset_${String(clip.index).padStart(4, '0')}${ext}`);
                const clipPath = path.join(assemblyDir, `clip_${String(clip.index).padStart(4, '0')}.mp4`);
                await this.downloadTo(clip.resultUrl, assetPath);
                if (outputType === 'IMAGE') {
                    await imageToFixedClip(assetPath, duration, clipPath, clipOpts);
                }
                else {
                    await trimOrPadClip(assetPath, duration, clipPath, clipOpts);
                }
                try {
                    fs.unlinkSync(assetPath);
                }
                catch {
                    /* best-effort */
                }
                return clipPath;
            }));
            clipPaths.push(...results);
            job.progressPct = 10 + Math.floor(((start + chunk.length) / planned.length) * 55);
            job.progress = `Đã tạo ${start + chunk.length}/${planned.length} clip...`;
        }
        // 3. Concat → silent timeline.
        job.progress = 'Đang ghép clip...';
        job.progressPct = 70;
        const silentTimeline = path.join(assemblyDir, 'silent_timeline.mp4');
        await concatVideos(clipPaths, silentTimeline);
        // 4. Mux original audio (master clock).
        job.progress = 'Đang khớp audio gốc...';
        job.progressPct = 80;
        const timedVideo = path.join(assemblyDir, 'timed_video.mp4');
        await overlayAudio(silentTimeline, project.audioPath, timedVideo, { trimToShortest: true });
        // 5. Optional burn-in subtitles → final. `burnSubtitles` is the FFmpeg gate;
        // the frontend sends it as subtitleConfig.enabled, so the two stay in sync.
        let finalVideoPath;
        if (opts.burnSubtitles) {
            job.progress = 'Đang burn phụ đề...';
            job.progressPct = 90;
            const cfg = { ...DEFAULT_SUBTITLE_CONFIG, ...opts.subtitleConfig };
            const [vw, vh] = clipOpts.resolution.split('x').map(Number);
            const videoWidth = vw || 1920;
            const videoHeight = vh || 1080;
            const assPath = path.join(assemblyDir, 'subtitles.ass');
            const cues = segments.flatMap((seg) => wrapAndSplit(seg, cfg, videoWidth));
            fs.writeFileSync(assPath, generateASS(cues, cfg, videoWidth, videoHeight), 'utf8');
            finalVideoPath = path.join(outputDir, `doodle_${id}_final_sub.mp4`);
            await burnSubtitles(timedVideo, assPath, finalVideoPath);
        }
        else {
            finalVideoPath = path.join(outputDir, `doodle_${id}_final.mp4`);
            fs.copyFileSync(timedVideo, finalVideoPath);
        }
        // 6. Finalize + cleanup temp.
        job.progress = 'Hoàn thành';
        job.progressPct = 100;
        job.status = 'COMPLETED';
        job.finalVideoPath = finalVideoPath;
        job.completedAt = new Date();
        await prisma.doodleVideoProject.update({
            where: { id },
            data: { finalVideoPath, stage: 'COMPLETED', status: 'COMPLETED' },
        });
        try {
            fs.rmSync(assemblyDir, { recursive: true, force: true });
        }
        catch {
            /* best-effort */
        }
        logger.info('[DoodleVideo] assembly complete', { id, finalVideoPath });
    }
    // ── FableCut advanced editor bridge ───────────────────────────────────────
    /**
     * Copy this project's shot assets + narration into FableCut's media dir and
     * return the prefilled project.json document. Called by the Electron main
     * process (which owns the FableCut app dir) before opening the editor.
     */
    async prepareFablecut(id, mediaDir, settings) {
        const project = await this.getProject(id);
        if (!project)
            throw new Error('Không tìm thấy dự án');
        if (!project.genNormalProjectId)
            throw new Error('Chưa có project gen');
        if (!project.whisperSegments)
            throw new Error('Chưa có phân đoạn Whisper');
        if (!project.audioPath || !fs.existsSync(project.audioPath))
            throw new Error('File audio bị thiếu');
        // Defense-in-depth: mediaDir comes from Electron main, but any token holder
        // could POST this route. Only ever write into a FableCut app "media" dir.
        const resolvedMedia = path.resolve(mediaDir);
        if (resolvedMedia !== mediaDir ||
            path.basename(resolvedMedia) !== 'media' ||
            path.basename(path.dirname(resolvedMedia)) !== 'fablecut-app') {
            throw new Error('mediaDir không hợp lệ');
        }
        let parsed;
        try {
            parsed = JSON.parse(project.whisperSegments);
        }
        catch {
            throw new Error(`Dữ liệu phân đoạn Whisper bị lỗi định dạng (dự án ${id}).`);
        }
        const segments = driftAdjust(parsed, project.audioDuration ?? 0);
        const outputType = project.outputType ?? 'IMAGE';
        const allJobs = await genNormalService.getProjectJobs(project.genNormalProjectId);
        const jobsByIndex = new Map(allJobs.map((j) => [j.jobIndex, { status: j.status, resultUrl: j.resultUrl ?? null }]));
        const planned = planShots(segments, jobsByIndex);
        if (planned.length === 0) {
            throw new Error('Chưa có shot nào tạo thành công để mở trình chỉnh sửa. Hãy retry job lỗi hoặc gen lại.');
        }
        fs.mkdirSync(mediaDir, { recursive: true });
        const ext = outputType === 'IMAGE' ? '.png' : '.mp4';
        const shotFilenames = [];
        // Contiguous shots (failed shots folded into the previous clip's duration).
        const fcSegments = [];
        let cursor = planned[0].start;
        for (let i = 0; i < planned.length; i++) {
            const clip = planned[i];
            const filename = `shot_${String(i).padStart(4, '0')}${ext}`;
            await this.downloadTo(clip.resultUrl, path.join(mediaDir, filename));
            shotFilenames.push(filename);
            fcSegments.push({ start: cursor, end: cursor + clip.duration, text: segments[clip.index]?.text ?? '' });
            cursor += clip.duration;
        }
        const audioFilename = path.basename(project.audioPath);
        fs.copyFileSync(project.audioPath, path.join(mediaDir, audioFilename));
        return buildFablecutProject({
            title: project.title,
            aspectRatio: project.aspectRatio,
            outputType,
            audioFilename,
            audioDuration: project.audioDuration ?? 0,
            shotFilenames,
            segments: fcSegments,
            settings: {
                transitionType: settings.transitionType ?? 'none',
                transitionDuration: settings.transitionDuration ?? 0.5,
                includeSubtitles: settings.includeSubtitles ?? false,
                kenBurns: settings.kenBurns ?? false,
                fps: settings.fps ?? 25,
                subtitleConfig: { ...DEFAULT_SUBTITLE_CONFIG, ...settings.subtitleConfig },
            },
        });
    }
    /** Import a FableCut-exported MP4 back into the project as the final video. */
    async finalizeFablecutExport(id, exportPath) {
        const project = await this.getProject(id);
        if (!project)
            throw new Error('Không tìm thấy dự án');
        // The path is relayed by the renderer, so trust nothing: only import an .mp4
        // that actually lives under a FableCut app "exports" dir.
        const resolvedExport = path.resolve(exportPath);
        if (resolvedExport !== exportPath ||
            path.extname(resolvedExport).toLowerCase() !== '.mp4' ||
            path.basename(path.dirname(resolvedExport)) !== 'exports' ||
            path.basename(path.dirname(path.dirname(resolvedExport))) !== 'fablecut-app') {
            throw new Error('exportPath không hợp lệ');
        }
        if (!fs.existsSync(exportPath))
            throw new Error('File export không tồn tại');
        const outputDir = project.outputDir ?? doodleProjectDir(id);
        fs.mkdirSync(outputDir, { recursive: true });
        const finalVideoPath = path.join(outputDir, `doodle_${id}_advanced.mp4`);
        fs.copyFileSync(exportPath, finalVideoPath);
        return prisma.doodleVideoProject.update({
            where: { id },
            data: { finalVideoPath, stage: 'COMPLETED', status: 'COMPLETED' },
        });
    }
    async downloadTo(url, destPath) {
        // Local file already on disk (e.g. autoDownload) — copy without the network.
        // fileURLToPath handles Windows drive paths (file:///C:/...) correctly.
        if (url.startsWith('file://')) {
            fs.copyFileSync(fileURLToPath(url), destPath);
            return;
        }
        const res = await fetch(url);
        if (!res.ok)
            throw new Error(`Tải asset thất bại: HTTP ${res.status}`);
        if (!res.body)
            throw new Error('Tải asset thất bại: không có body');
        // Stream to disk — Veo clips can be 30–100MB; avoid buffering the whole asset in heap.
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
    }
}
export const doodleVideoService = new DoodleVideoService();
