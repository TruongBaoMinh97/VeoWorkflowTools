/**
 * Upload ảnh vào project Flow qua BOQ RPC `maseQ` (flow.google.com).
 *
 * REST `aisandbox-pa …/v1/flow/uploadImage` trả 400 INVALID_ARGUMENT từ 2026-09;
 * web Flow chuyển sang `maseQ`. Shape dưới đây lấy từ capture thật của web client.
 * Tách khỏi `veo3Service` để test được mà không kéo theo cả service.
 */
import { randomUUID } from 'node:crypto';
import { FlowRpcError, FlowSignedOutError } from '../../lib/flowBoq.js';
/** Ô thứ 2 của clientContext BOQ — web gửi 22 cho cả upload (maseQ) lẫn upscale ảnh (SPrCad). */
const FLOW_CLIENT_CONTEXT_TOOL = 22;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** clientContext dạng mảng của BOQ, mang projectId và token reCAPTCHA (single-use). */
export function flowClientContext(projectId, recaptchaToken) {
    return [
        null,
        FLOW_CLIENT_CONTEXT_TOOL,
        null,
        null,
        null,
        projectId,
        null,
        null,
        null,
        null,
        [recaptchaToken, 1],
    ];
}
/**
 * Nhận dạng ảnh bằng magic bytes. KHÔNG tin đuôi file: route upload luôn lưu file
 * tạm thành `.jpg` bất kể ảnh gốc là PNG/WEBP.
 */
export function detectImageKind(buf) {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return { mime: 'image/jpeg', ext: 'jpeg' };
    }
    if (buf.length >= 4 && buf.readUInt32BE(0) === 0x89504e47) {
        return { mime: 'image/png', ext: 'png' };
    }
    if (buf.length >= 12 &&
        buf.toString('ascii', 0, 4) === 'RIFF' &&
        buf.toString('ascii', 8, 12) === 'WEBP') {
        return { mime: 'image/webp', ext: 'webp' };
    }
    if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'GIF') {
        return { mime: 'image/gif', ext: 'gif' };
    }
    return { mime: 'image/jpeg', ext: 'jpeg' };
}
/**
 * Args cho `maseQ`. Hai UUID cuối do web client tự sinh (in hoa) — chưa rõ nghĩa,
 * sinh mới mỗi lần như web làm.
 */
export function buildMaseQArgs(input) {
    return [
        flowClientContext(input.projectId, input.recaptchaToken),
        input.base64,
        input.mime,
        1,
        null,
        null,
        null,
        null,
        input.fileName,
        null,
        randomUUID().toUpperCase(),
        randomUUID().toUpperCase(),
    ];
}
/** mediaId (UUID) nằm ở `payload[0][0]` — cùng loại ID dùng cho imageInputs / referenceImages. */
export function extractUploadedMediaId(payload) {
    const first = Array.isArray(payload) ? payload[0] : undefined;
    const mediaId = Array.isArray(first) ? first[0] : undefined;
    if (typeof mediaId !== 'string' || !UUID_RE.test(mediaId)) {
        throw new FlowRpcError('maseQ', `phản hồi upload không có mediaId hợp lệ: ${JSON.stringify(payload ?? null).slice(0, 200)}`);
    }
    return mediaId;
}
/**
 * `errorText` mang mã gốc (vd. INVALID_ARGUMENT) để các bộ phân loại dựa trên
 * `isNonRetryableError(errorText)` — như vòng retry của workflow — nhận ra.
 */
function tagged(message, cause, errorText, tags) {
    return Object.assign(new Error(message), tags, { cause, errorText });
}
/**
 * Đổi lỗi BOQ (mã gRPC/HTTP) sang thông điệp có "403"/"429"/"reCAPTCHA" + cờ, để
 * logic thử lại sẵn có của gen-normal / workflow vẫn nhận ra như với REST cũ.
 */
export function toUploadError(err) {
    if (err instanceof FlowSignedOutError || !(err instanceof FlowRpcError))
        return err;
    switch (err.status) {
        case 7: // PERMISSION_DENIED
        case 403:
            return tagged('Xác thực reCAPTCHA thất bại khi tải ảnh (Mã 403). Vui lòng thử tải ảnh lại.', err, `PERMISSION_DENIED: ${err.message}`, { isRecaptchaFailure: true });
        case 8: // RESOURCE_EXHAUSTED
        case 429:
            return tagged('Google đang giới hạn tốc độ (Mã 429) khi tải ảnh. Vui lòng thử lại sau ít phút.', err, `RESOURCE_EXHAUSTED: ${err.message}`, { isTransientTrafficLimit: true });
        case 3: // INVALID_ARGUMENT
        case 400:
            // Có thể là ảnh hỏng, hoặc Flow đổi shape maseQ — log ở veo3Service giữ lỗi gốc để phân định.
            return tagged('Google từ chối ảnh (Mã 400) — ảnh hỏng hoặc định dạng không được hỗ trợ.', err, `INVALID_ARGUMENT: ${err.message}`, { isNonRetryable: true });
        default:
            return err;
    }
}
