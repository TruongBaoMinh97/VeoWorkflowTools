/**
 * Image generation over Flow's `ogiZ0b` batchexecute RPC.
 *
 * Google retired the Bearer-authenticated aisandbox-pa lane (labs auth/session answers
 * 410), and the web client now generates through batchexecute with cookies only. The
 * call is synchronous (~25s) and answers with the finished image URL, so there is no
 * operation to poll. Wire shape: docs/flow-api-migration.md ("Gen qua batchexecute").
 */
import crypto from 'node:crypto';
import { FLOW_PRODUCT_SLOT, FlowRpcError } from '../../lib/flowBoq.js';
/**
 * Aspect codes for `ogiZ0b`. Only LANDSCAPE (3) was measured; SQUARE/PORTRAIT follow the
 * proto enum order and are unverified. Ratios without a code are rejected rather than
 * guessed — add them here once captured.
 */
const ASPECT_CODE = {
    IMAGE_ASPECT_RATIO_LANDSCAPE: { code: 3, verified: true },
    IMAGE_ASPECT_RATIO_SQUARE: { code: 1, verified: false },
    IMAGE_ASPECT_RATIO_PORTRAIT: { code: 2, verified: false },
};
export class UnsupportedFlowImageOptionError extends Error {
    constructor(message) {
        super(message);
        this.isNonRetryable = true;
        this.name = 'UnsupportedFlowImageOptionError';
    }
}
export function resolveAspectCode(aspect) {
    const hit = ASPECT_CODE[aspect];
    if (!hit) {
        throw new UnsupportedFlowImageOptionError(`Tỉ lệ ảnh "${aspect}" chưa hỗ trợ trên Flow mới (chưa bắt được mã). Dùng 16:9.`);
    }
    return hit;
}
const newClientUuid = () => crypto.randomUUID().toUpperCase();
/**
 * Build the `ogiZ0b` argument tree exactly as the web client sends it.
 * Reference images go in row[2] as `[mediaId, null, null, null, 1]` each (null when there are none).
 */
export function buildGenerateImageArgs(input) {
    const ctx = [
        null,
        FLOW_PRODUCT_SLOT,
        null,
        null,
        null,
        input.projectId,
        null,
        null,
        null,
        null,
        [input.recaptchaToken, 1],
    ];
    return [
        null,
        [
            [
                null,
                null,
                input.referenceMediaIds?.length
                    ? input.referenceMediaIds.map((id) => [id, null, null, null, 1])
                    : null,
                input.seed,
                input.aspectCode,
                input.imageModelName,
                null,
                ctx,
                [[[input.prompt]]],
                null,
                null,
                null,
                newClientUuid(),
                newClientUuid(),
            ],
        ],
        1,
        ctx,
        [newClientUuid()],
    ];
}
const asString = (v) => (typeof v === 'string' && v ? v : undefined);
/**
 * Read the `ogiZ0b` answer: `payload[0][0]` is the media row
 * `[mediaId, null, workflowId, …, [[null, seed, …, prompt, …, url]], null, [w, h], …, [null, url]]`.
 */
export function parseGenerateImageResponse(payload, ctx) {
    const media = Array.isArray(payload) && Array.isArray(payload[0]) ? payload[0][0] : undefined;
    const mediaId = Array.isArray(media) ? asString(media[0]) : undefined;
    if (!Array.isArray(media) || !mediaId) {
        throw new FlowRpcError('ogiZ0b', `không có ảnh trong phản hồi: ${JSON.stringify(payload)?.slice(0, 160)}`);
    }
    const detail = Array.isArray(media[6]) && Array.isArray(media[6][0]) ? media[6][0] : [];
    const fifeUrl = asString(Array.isArray(media[11]) ? media[11][1] : undefined) ?? asString(detail[13]);
    if (!fifeUrl) {
        throw new FlowRpcError('ogiZ0b', `phản hồi có mediaId nhưng thiếu URL ảnh (${mediaId})`);
    }
    const echoedPrompt = asString(detail[7]);
    return {
        promptIndex: ctx.promptIndex,
        name: mediaId,
        seed: typeof detail[1] === 'number' ? detail[1] : undefined,
        prompt: echoedPrompt?.replace(/^"|"$/g, ''),
        aspectRatio: ctx.aspectRatio,
        modelNameType: ctx.imageModelName,
        fifeUrl,
        mediaGenerationId: mediaId,
        veoMediaId: mediaId,
    };
}
/** gRPC codes Google puts in the status cell of a failed row. */
const GRPC = { INVALID_ARGUMENT: 3, PERMISSION_DENIED: 7, RESOURCE_EXHAUSTED: 8, INTERNAL: 13, UNAVAILABLE: 14, UNAUTHENTICATED: 16 };
const tag = (message, flags, cause) => Object.assign(new Error(message), flags, { cause });
/**
 * Translate a failed `ogiZ0b` call into the flags the queue manager already routes on
 * (isNonRetryable / isRecaptchaFailure / rate limit / server error / retryable network).
 * `FlowRpcError.status` is an HTTP status when >= 100 and a gRPC code otherwise.
 */
export function classifyImageGenError(err) {
    if (!(err instanceof FlowRpcError))
        return err;
    const status = err.status;
    const isHttp = typeof status === 'number' && status >= 100;
    const grpc = typeof status === 'number' && status < 100 ? status : undefined;
    if (status === 0) {
        return tag('Image gen network error (kết nối Flow không hoàn tất). Token có thể đã bị consume — retry với token mới.', { isRetryable: true }, err);
    }
    if (grpc === GRPC.INVALID_ARGUMENT) {
        return tag(`Prompt bị từ chối (INVALID_ARGUMENT): nội dung không hợp lệ hoặc vi phạm chính sách. [${err.message}]`, { isNonRetryable: true }, err);
    }
    if (grpc === GRPC.PERMISSION_DENIED || status === 403) {
        return tag('reCAPTCHA bị Google từ chối (Mã 403): Browser session score thấp. Profile sẽ được reset và thử lại.', { isRecaptchaFailure: true }, err);
    }
    if (grpc === GRPC.RESOURCE_EXHAUSTED || status === 429) {
        return tag('Rate limit (Mã 429): Gen quá nhanh, sẽ tự retry sau 30s.', {}, err);
    }
    if (grpc === GRPC.UNAUTHENTICATED || status === 401) {
        return tag('Chưa đăng nhập Flow trên profile này. Mở Profiles → Đăng nhập lại để cấp phiên mới.', { code: 'FLOW_SIGNED_OUT' }, err);
    }
    if (grpc === GRPC.INTERNAL || grpc === GRPC.UNAVAILABLE || (isHttp && status >= 500)) {
        return tag(`Lỗi Google (Mã ${isHttp ? status : 500}): Hệ thống Google đang gặp sự cố. Vui lòng thử lại sau!`, { isGoogleServerError: true }, err);
    }
    return err;
}
/** Same flag translation serves every Flow generation rpc (image, video, upscale). */
export const classifyFlowGenError = classifyImageGenError;
