/**
 * Video generation, polling and upscale over Flow's batchexecute RPCs.
 *
 * The web client stopped using aisandbox-pa (no Bearer can be issued any more), so every
 * video call is a cookie-authenticated batchexecute RPC. One rpc per generation mode,
 * one shared poll rpc, and `getMedia` to read the finished URLs. Wire shapes and the
 * captures they come from: docs/flow-api-migration.md.
 */
import crypto from 'node:crypto';
import { FLOW_PRODUCT_SLOT, FLOW_RPC } from '../../lib/flowBoq.js';
import { UnsupportedFlowImageOptionError } from './flowImageGen.js';
/** rpc used to submit each mode. */
export const VIDEO_SUBMIT_RPC = {
    t2v: FLOW_RPC.generateVideoText,
    i2v: FLOW_RPC.generateVideoStartImage,
    f2f: FLOW_RPC.generateVideoStartAndEndImage,
    r2v: FLOW_RPC.generateVideoReferences,
};
/** Legacy clips were always 8s; the new keys carry the length in their name. */
export const DEFAULT_FLOW_VIDEO_SECONDS = 8;
/**
 * Keys Flow was seen to accept (2026-10-22): captured sends, plus probes where Flow got past
 * argument validation (a wrong key answers INVALID_ARGUMENT / NOT_FOUND, a right one only fails
 * later at the captcha). Everything else is built from the naming rules and flagged.
 */
const VERIFIED_KEYS = new Set([
    // t2v — 4s/6s carry the length, 8s is the plain legacy key
    'veo_3_1_t2v_lite_4s', 'veo_3_1_t2v_lite_6s', 'veo_3_1_t2v_fast_4s', 'veo_3_1_t2v_quality_4s',
    'veo_3_1_t2v_lite', 'veo_3_1_t2v_fast', 'veo_3_1_t2v_fast_ultra', 'veo_3_1_t2v',
    // i2v
    'veo_3_1_i2v_s_quality_4s', 'veo_3_1_i2v_s_lite_4s', 'veo_3_1_i2v_s_fast_4s',
    'veo_3_1_i2v_lite', 'veo_3_1_i2v_s_fast_ultra', 'veo_3_1_i2v_s',
    // f2f
    'veo_3_1_i2v_s_lite_4s_fl', 'veo_3_1_i2v_s_fast_4s_fl',
    'veo_3_1_interpolation_lite', 'veo_3_1_i2v_s_fast_ultra_fl', 'veo_3_1_i2v_s_fl',
    // r2v — orientation stays in the fast key
    'veo_3_1_r2v_lite', 'veo_3_1_r2v_fast_landscape_ultra',
]);
function tierOf(legacyKey) {
    if (/lite/.test(legacyKey))
        return 'lite';
    if (/fast/.test(legacyKey))
        return 'fast';
    return 'quality';
}
/** Orientation is the aspect code now, not part of the key. */
const stripOrientation = (key) => key.replace(/_(portrait|landscape)(?=_|$)/g, '');
/**
 * Keys to try, best first, for a legacy model key.
 *
 * - 4s / 6s: `veo_3_1_<mode>_<tier>_<N>s` (+`_fl` for end frame).
 * - 8s (the old fixed length): the plain legacy key. Probed: the `_8s` spelling does not exist
 *   (NOT_FOUND), the plain keys do. For t2v/i2v/f2f orientation is the aspect code, so the
 *   orientation word is dropped first and the original key kept as a fallback.
 * - r2v: the key as-is. `…r2v_fast_landscape_ultra` exists, `…r2v_fast_ultra` / `…r2v` / `…r2v_fast`
 *   do not, so the orientation word must stay; only `veo_3_1_r2v_lite` has no orientation at all.
 *
 * A wrong key is refused (INVALID_ARGUMENT / NOT_FOUND) before anything is charged, so walking
 * the list is safe.
 */
export function flowVideoModelKeyCandidates(input) {
    const { legacyKey, mode } = input;
    if (/^abra/.test(legacyKey))
        return [{ key: legacyKey, verified: true }];
    const seconds = input.seconds ?? DEFAULT_FLOW_VIDEO_SECONDS;
    const tier = tierOf(legacyKey);
    const stripped = stripOrientation(legacyKey);
    let ordered;
    if (mode === 'r2v') {
        ordered = [legacyKey, stripped];
    }
    else if (seconds >= DEFAULT_FLOW_VIDEO_SECONDS) {
        ordered = [stripped, legacyKey];
    }
    else {
        const suffixed = mode === 't2v'
            ? `veo_3_1_t2v_${tier}_${seconds}s`
            : mode === 'i2v'
                ? `veo_3_1_i2v_s_${tier}_${seconds}s`
                : `veo_3_1_i2v_s_${tier}_${seconds}s_fl`;
        ordered = [suffixed];
    }
    return [...new Set(ordered)].map((key) => ({ key, verified: VERIFIED_KEYS.has(key) }));
}
/** First candidate — kept for callers that need a single key. */
export function toFlowVideoModelKey(input) {
    return flowVideoModelKeyCandidates(input)[0];
}
/** Keys that Flow accepted, remembered per slot so later jobs skip the probing. */
const acceptedKeys = new Map();
export const modelKeySlot = (mode, legacyKey, seconds = DEFAULT_FLOW_VIDEO_SECONDS) => `${mode}|${legacyKey}|${seconds}`;
export const rememberAcceptedKey = (slot, key) => void acceptedKeys.set(slot, key);
export const acceptedKeyFor = (slot) => acceptedKeys.get(slot);
/** `1` = portrait 9:16, `2` = landscape 16:9 (both measured). */
export function videoAspectCode(aspect) {
    if (/PORTRAIT/.test(aspect))
        return 1;
    if (/LANDSCAPE/.test(aspect))
        return 2;
    throw new UnsupportedFlowImageOptionError(`Tỉ lệ video "${aspect}" chưa hỗ trợ trên Flow mới (chỉ 16:9 và 9:16).`);
}
const newClientUuid = () => crypto.randomUUID().toUpperCase();
/** Pixel size of uploaded images, remembered at upload so start frames can be cropped to the video aspect. */
const imageSizes = new Map();
export function rememberImageSize(mediaId, width, height) {
    if (mediaId && width > 0 && height > 0)
        imageSizes.set(mediaId, { width, height });
}
/**
 * Crop rectangle Flow sends with a start/end frame: `[y0, null, y1, 1]` — a full-width
 * band, centred, whose aspect equals the video's. Measured for a 768x1376 image on 16:9
 * (0.343…0.657). Without a known size, or when the image is not taller than the target,
 * no crop is sent.
 */
export function frameCrop(mediaId, aspectCode) {
    const size = imageSizes.get(mediaId);
    if (!size)
        return null;
    const target = aspectCode === 1 ? 9 / 16 : 16 / 9; // width / height
    const imageRatio = size.width / size.height;
    if (imageRatio >= target)
        return null;
    const visible = imageRatio / target;
    return [Number(((1 - visible) / 2).toFixed(16)), null, Number(((1 + visible) / 2).toFixed(16)), 1];
}
/** Build the argument tree for one generation row. */
export function buildVideoSubmitArgs(input) {
    const ctx = [null, FLOW_PRODUCT_SLOT, null, null, null, input.projectId, null, null, null, null, [input.recaptchaToken, 1]];
    const text = [null, null, [[[input.prompt]]]];
    const ids = [null, null, null, null, newClientUuid(), newClientUuid()];
    const frame = (mediaId) => [null, mediaId, null, null, null, frameCrop(mediaId, input.aspectCode)];
    let row;
    switch (input.mode) {
        case 't2v':
            row = [text, input.modelKey, input.aspectCode, null, ids];
            if (/^abra/.test(input.modelKey))
                row.push(null, null, [input.omniSeconds ?? DEFAULT_FLOW_VIDEO_SECONDS]);
            break;
        case 'i2v':
            if (!input.startMediaId)
                throw new Error('i2v cần ảnh khung đầu');
            row = [text, input.modelKey, input.aspectCode, null, frame(input.startMediaId), ids];
            break;
        case 'f2f':
            if (!input.startMediaId || !input.endMediaId)
                throw new Error('f2f cần cả ảnh khung đầu và khung cuối');
            row = [text, input.modelKey, input.aspectCode, null, frame(input.startMediaId), frame(input.endMediaId), ids];
            break;
        case 'r2v':
            row = [text, (input.referenceMediaIds ?? []).map((id) => [null, id]), input.modelKey, input.aspectCode, null, ids];
            if (input.referenceAudioIds?.length)
                row.push(null, input.referenceAudioIds.map((voice) => [voice]));
            break;
    }
    return [[row], ctx, [newClientUuid(), 1]];
}
/** Args for the upscale rpc (`p0UkFb`): `row[2]` is the aspect, `row[6]` is the resolution (1080p → 2, 4K → 3). */
export function buildUpscaleArgs(input) {
    const ctx = [null, FLOW_PRODUCT_SLOT, null, null, null, input.projectId, null, null, null, null, [input.recaptchaToken, 1]];
    const row = new Array(32).fill(null);
    row[0] = [null, input.sourceMediaId];
    row[2] = input.aspectCode;
    row[4] = [null, input.workflowId, null, null, newClientUuid()];
    row[6] = input.resolution === '4k' ? 3 : 2;
    row[31] = `veo_3_1_upsampler_${input.resolution}`;
    return [[row], ctx, [newClientUuid()]];
}
/** Id Flow gives the upscaled copy of a media: `<id>_upsampled` / `<id>_4k_upsampled`. */
export const upscaledMediaId = (mediaId, resolution) => `${mediaId}${resolution === '4k' ? '_4k' : ''}_upsampled`;
export function upscaleResolutionOf(legacyResolution, key) {
    return /4k/i.test(`${legacyResolution ?? ''} ${key ?? ''}`) ? '4k' : '1080p';
}
/**
 * Read a submit response: `[null, <credits left>, [[<workflowId>, …]], [[<operationId>, <projectId>, <workflowId>, …]]]`.
 */
export function parseVideoSubmitResponse(payload) {
    if (!Array.isArray(payload))
        return { operations: [] };
    const rows = Array.isArray(payload[3]) ? payload[3] : [];
    const operations = rows
        .filter((r) => Array.isArray(r) && typeof r[0] === 'string')
        .map((r) => ({ operationId: r[0], workflowId: typeof r[2] === 'string' ? r[2] : undefined }));
    return { creditsLeft: typeof payload[1] === 'number' ? payload[1] : undefined, operations };
}
/** Measured: 6 right after submit, 2 while running, 3 when done. Other codes are treated as failure. */
export function legacyStatusOf(code) {
    if (code === 3)
        return 'MEDIA_GENERATION_STATUS_SUCCESSFUL';
    if (code === 2)
        return 'MEDIA_GENERATION_STATUS_ACTIVE';
    if (code === undefined || code === 0 || code === 1 || code === 6)
        return 'MEDIA_GENERATION_STATUS_PENDING';
    return 'MEDIA_GENERATION_STATUS_FAILED';
}
const asUrl = (v) => (typeof v === 'string' && /^https?:\/\//.test(v) ? v : undefined);
/**
 * Read one media row, as returned by `jwpduf` (`payload[2][0]`) and `getMedia` (`payload`):
 * `[id, projectId, workflowId, null, null, [[ts], prompt, …, status at [8], 1, <thumb url at [10]>], null, [[…, video url at [8], …], …, [null, [video, thumb]]]]`.
 */
export function parseMediaRow(row) {
    if (!Array.isArray(row) || typeof row[0] !== 'string')
        return null;
    const meta = Array.isArray(row[5]) ? row[5] : [];
    const statusCode = Array.isArray(meta[8]) && typeof meta[8][0] === 'number' ? meta[8][0] : undefined;
    const output = Array.isArray(row[7]) ? row[7] : [];
    const generated = Array.isArray(output[0]) ? output[0] : [];
    const pair = Array.isArray(output[5]) && Array.isArray(output[5][1]) ? output[5][1] : [];
    const status = legacyStatusOf(statusCode);
    const request = Array.isArray(meta[6]) && Array.isArray(meta[6][1]) ? meta[6][1][0] : undefined;
    const echoedAspect = Array.isArray(request) ? request[4] : undefined;
    return {
        aspectCode: echoedAspect === 1 || echoedAspect === 2 ? echoedAspect : undefined,
        operationId: row[0],
        workflowId: typeof row[2] === 'string' ? row[2] : undefined,
        statusCode,
        status,
        videoUrl: asUrl(generated[8]) ?? asUrl(pair[0]),
        thumbnailUrl: asUrl(meta[10]) ?? asUrl(pair[1]),
        error: status === 'MEDIA_GENERATION_STATUS_FAILED' ? `Flow báo trạng thái ${statusCode} cho video` : undefined,
    };
}
/** Rows of a `jwpduf` poll response. */
export function parsePollResponse(payload) {
    const rows = Array.isArray(payload) && Array.isArray(payload[2]) ? payload[2] : [];
    return rows.map(parseMediaRow).filter((r) => r !== null);
}
/** Pixel size from a `maseQ` upload response (`payload[0][6][2] = [width, height]`). */
export function readUploadedImageSize(payload) {
    const row = Array.isArray(payload) ? payload[0] : undefined;
    const dims = Array.isArray(row) && Array.isArray(row[6]) ? row[6][2] : undefined;
    return Array.isArray(dims) && typeof dims[0] === 'number' && typeof dims[1] === 'number'
        ? { width: dims[0], height: dims[1] }
        : null;
}
