import { randomUUID } from 'node:crypto';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Flow validates the declared MIME type against the bytes. Prefer the file
 * signature because generated images can be saved with a misleading extension.
 */
export function detectFlowImageMimeType(bytes, explicitMimeType) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 12) {
        throw new Error('Ảnh tham chiếu không có dữ liệu hợp lệ.');
    }
    if (bytes.subarray(0, 8).equals(PNG_SIGNATURE))
        return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        return 'image/jpeg';
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
        return 'image/webp';
    if (['image/png', 'image/jpeg', 'image/webp'].includes(explicitMimeType))
        return explicitMimeType;
    throw new Error('Flow chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP đúng định dạng.');
}

/**
 * Positional request captured from the current Flow web client
 * (`FlowService.UploadImage`, RPC `maseQ`). Tool enum 22 is PINHOLE.
 */
export function buildFlowImageUploadArgs({
    projectId,
    imageBytes,
    mimeType,
    fileName,
    captchaToken,
    seedIds,
}) {
    if (!projectId || !imageBytes || !mimeType || !fileName || !captchaToken) {
        throw new Error('Thiếu dữ liệu bắt buộc để tải ảnh lên Flow.');
    }
    const ids = seedIds ?? [randomUUID(), randomUUID()];
    if (!Array.isArray(ids) || ids.length !== 2)
        throw new Error('Flow upload requires two request ids.');
    const upperIds = ids.map((value) => String(value).toUpperCase());
    const clientContext = [
        null,
        22,
        null,
        null,
        null,
        projectId,
        null,
        null,
        null,
        null,
        [captchaToken, 1],
    ];
    return [
        clientContext,
        imageBytes,
        mimeType,
        1,
        null,
        null,
        null,
        null,
        fileName,
        null,
        upperIds[0],
        upperIds[1],
    ];
}

/**
 * The first field of the returned media proto is the UUID consumed by
 * `imageInputs[].name`. Keep the legacy response shape for existing callers.
 */
export function normalizeFlowImageUploadResponse(payload) {
    const media = Array.isArray(payload) && Array.isArray(payload[0]) ? payload[0] : null;
    const name = typeof media?.[0] === 'string' ? media[0] : '';
    if (!name) {
        throw new Error('Flow đã nhận ảnh nhưng không trả về media UUID.');
    }
    return {
        name,
        media: { name },
        projectId: typeof media[1] === 'string' ? media[1] : undefined,
        assetId: typeof media[2] === 'string' ? media[2] : undefined,
    };
}
