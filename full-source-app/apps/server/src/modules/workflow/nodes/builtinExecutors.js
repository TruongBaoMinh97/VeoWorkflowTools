import { characterGeneratorExecutor } from './characterGeneratorExecutor.js';
import { storyExecutors } from './storyExecutors.js';
import { templateMergeExecutor } from './templateMergeExecutor.js';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveFfmpegBinary, resolveFfprobeBinary } from '../../../utils/ffmpegResolver.js';
import { resolvePythonBinary, resolvePythonScript } from '../../../utils/pythonResolver.js';
import { concatVideos, downloadImageToTemp } from '../lib/ffmpegConcat.js';
import { extractLastSharpFrame } from '../lib/extractEndFrame.js';
import { removeImageLogo, removeVideoLogo } from '../lib/removeLogo.js';
import { NonRetryableNodeError } from '../engine/WorkflowNodeError.js';
import { aiPromptExecutor } from './aiPromptExecutor.js';
import { chatGPTExecutor } from './chatGPTExecutor.js';
import { saveImagesExecutor } from './saveImagesExecutor.js';
import { imageReviewExecutor } from './imageReviewExecutor.js';
import { imagePaths, imageDataUrl, localImagePath } from '../lib/imageInputs.js';

function assertNotCancelled(context) {
    if (context.isCancelled?.())
        throw new Error('Run was cancelled');
}

const promptExecutor = {
    type: 'prompt',
    version: 1,
    execute: ({ data }) => ({ results: [], textValue: data.prompt ?? '' }),
};

const uploadImageExecutor = {
    type: 'upload-image', version: 1,
    async execute({ data, resolved, provider, projectId, isCancelled }) {
        const incoming = resolved.imageResults ?? [];
        if (resolved.story && !incoming.length) return { results: [], story: resolved.story };
        const sources = incoming.length ? incoming : imagePaths(data.localPaths?.length ? data.localPaths : data.localPath)
            .map(file => ({ url: `file://${file}`, kind: 'image' }));
        if (sources.length > 8) throw new NonRetryableNodeError('Upload Image: tối đa 8 ảnh.', { code: 'IMAGE_INPUT_LIMIT' });
        for (const source of sources) {
            if (!source.url) throw new NonRetryableNodeError('Ảnh thiếu URL.', { code: 'IMAGE_URL_MISSING' });
            if (source.url.startsWith('file://')) await imageDataUrl(source.url);
        }
        const results = [];
        for (const source of sources) {
            if (isCancelled?.()) throw new Error('Run was cancelled');
            let temporary = null;
            try {
                const local = source.url.startsWith('file://') ? localImagePath(source.url)
                    : (temporary = await downloadImageToTemp(source.url, 'upload-image'));
                const mediaId = await provider.uploadImageAndExtractMediaId(local, projectId);
                results.push({ ...source, mediaId, url: source.url, kind: 'image', referenceRole: resolved.story ? source.referenceRole : data.referenceRole || source.referenceRole || 'garment' });
            } finally {
                if (temporary) await unlink(temporary).catch(() => {});
            }
        }
        return { results };
    },
};

const mergeVideoExecutor = {
    type: 'merge-video',
    version: 1,
    async execute({ data, resolved, isCancelled }) {
        const portCount = Number(data.portCount ?? resolved.videoResults.length);
        const inputs = resolved.videoResults.slice(0, portCount);
        inputs.forEach((input, index) => {
            if (!input.url?.trim()) {
                throw new NonRetryableNodeError(
                    `Video input #${index + 1} has no URL. Regenerate that branch first.`,
                    { code: 'MERGE_VIDEO_URL_MISSING' },
                );
            }
        });
        if (inputs.length < 2)
            throw new Error(`merge-video requires at least 2 inputs, got ${inputs.length}`);

        const inputPaths = inputs.map((item) => item.url.startsWith('file://') ? item.url.slice(7) : item.url);
        const outputPath = path.join(os.tmpdir(), `wf_merge_${randomUUID()}.mp4`);
        await concatVideos(inputPaths, outputPath);
        if (isCancelled?.())
            throw new Error('Run was cancelled');
        return { results: [{ mediaId: '', url: `file://${outputPath}`, kind: 'video' }] };
    },
};

const extractEndFrameExecutor = {
    type: 'extract-endframe',
    version: 1,
    async execute(context) {
        const video = context.resolved.videoResults[0];
        if (!video?.url) {
            throw new NonRetryableNodeError('Extract end frame requires a video input.', {
                code: 'EXTRACT_FRAME_INPUT_MISSING',
            });
        }
        const ffmpeg = resolveFfmpegBinary();
        if (!ffmpeg) {
            throw new NonRetryableNodeError('FFmpeg is required to extract an end frame.', {
                code: 'FFMPEG_MISSING',
            });
        }
        const framePath = await extractLastSharpFrame(video.url, ffmpeg);
        assertNotCancelled(context);
        const mediaId = await context.provider.uploadImageAndExtractMediaId(framePath, context.projectId);
        return { results: [{ mediaId, url: `file://${framePath}`, kind: 'image' }] };
    },
};

const removeImageLogoExecutor = {
    type: 'remove-image-logo',
    version: 1,
    async execute(context) {
        const image = context.resolved.imageResults[0];
        if (!image?.url) {
            throw new NonRetryableNodeError('Remove image logo requires an image input.', {
                code: 'REMOVE_IMAGE_INPUT_MISSING',
            });
        }
        const pythonBin = resolvePythonBinary();
        const scriptPath = resolvePythonScript('remove_watermark_batch.py');
        if (!pythonBin || !scriptPath) {
            throw new NonRetryableNodeError('Python watermark tools are not available.', {
                code: 'WATERMARK_TOOLS_MISSING',
            });
        }
        const outputPath = await removeImageLogo(image.url, {
            pythonBin,
            scriptPath,
            method: context.data.method ?? 'calib',
            strength: context.data.strength !== undefined ? Number(context.data.strength) : undefined,
        });
        assertNotCancelled(context);
        return { results: [{ mediaId: '', url: `file://${outputPath}`, kind: 'image' }] };
    },
};

const removeVideoLogoExecutor = {
    type: 'remove-video-logo',
    version: 1,
    async execute(context) {
        const video = context.resolved.videoResults[0];
        if (!video?.url) {
            throw new NonRetryableNodeError('Remove video logo requires a video input.', {
                code: 'REMOVE_VIDEO_INPUT_MISSING',
            });
        }
        const pythonBin = resolvePythonBinary();
        const scriptPath = resolvePythonScript('remove_video_watermark_batch.py');
        const ffmpegBin = resolveFfmpegBinary();
        const ffprobeBin = resolveFfprobeBinary();
        if (!pythonBin || !scriptPath) {
            throw new NonRetryableNodeError('Python watermark tools are not available.', {
                code: 'WATERMARK_TOOLS_MISSING',
            });
        }
        if (!ffmpegBin || !ffprobeBin) {
            throw new NonRetryableNodeError('FFmpeg and FFprobe are required.', {
                code: 'FFMPEG_MISSING',
            });
        }
        const outputPath = await removeVideoLogo(video.url, {
            pythonBin,
            scriptPath,
            ffmpegBin,
            ffprobeBin,
            logo: context.data.logo ?? 'auto',
            corner: context.data.corner ?? 'br',
            crf: context.data.crf !== undefined ? Number(context.data.crf) : undefined,
            strength: context.data.strength !== undefined ? Number(context.data.strength) : undefined,
        });
        assertNotCancelled(context);
        return { results: [{ mediaId: '', url: `file://${outputPath}`, kind: 'video' }] };
    },
};

const resultExecutor = {
    type: 'result',
    version: 1,
    execute: ({ resolved }) => ({
        results: [...resolved.imageResults, ...resolved.videoResults],
    }),
};

export function createBuiltinNodeExecutors() {
    return [
        ...storyExecutors, characterGeneratorExecutor,
        promptExecutor,
        aiPromptExecutor,
        chatGPTExecutor,
        templateMergeExecutor,
        saveImagesExecutor,
        imageReviewExecutor,
        uploadImageExecutor,
        { ...uploadImageExecutor, type: 'folder-input', execute(context) {
            if (!context.data.localPaths?.length && !context.data.localPath)
                throw new NonRetryableNodeError('Folder Input phải chạy bằng Batch: bấm Chuẩn bị chạy folder trong node.', { code: 'FOLDER_BATCH_REQUIRED' });
            return uploadImageExecutor.execute(context);
        } },
        mergeVideoExecutor,
        extractEndFrameExecutor,
        removeImageLogoExecutor,
        removeVideoLogoExecutor,
        resultExecutor,
    ];
}
