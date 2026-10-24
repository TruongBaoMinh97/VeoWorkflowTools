import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { NonRetryableNodeError } from '../engine/WorkflowNodeError.js';

export const MAX_REFERENCE_IMAGES = 8;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export function localImagePath(url) {
    if (!url.startsWith('file://')) return url;
    // Older workflows store file://D:\path rather than a canonical file URL.
    return /^file:\/\/[a-z]:[\\/]/i.test(url) ? url.slice(7) : fileURLToPath(url);
}
export function imagePaths(value) {
    const parsed = Array.isArray(value) ? value : String(value ?? '').trim().startsWith('[')
        ? JSON.parse(value) : [value];
    if (!Array.isArray(parsed) || !parsed.length || parsed.length > MAX_REFERENCE_IMAGES ||
        parsed.some(p => typeof p !== 'string' || !p.trim()))
        throw new NonRetryableNodeError(`Cần 1–${MAX_REFERENCE_IMAGES} ảnh hợp lệ.`, { code: 'IMAGE_INPUT_INVALID' });
    return [...new Set(parsed.map(p => p.trim()))];
}
export async function imageDataUrl(file) {
    const filePath = localImagePath(file);
    const info = await stat(filePath);
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES || info.size === 0)
        throw new NonRetryableNodeError('Ảnh phải là file không rỗng, tối đa 20 MB.', { code: 'IMAGE_SIZE_INVALID' });
    const bytes = await readFile(filePath);
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
    if (!mime) throw new NonRetryableNodeError('Chỉ hỗ trợ ảnh JPEG, PNG, WebP đúng định dạng.', { code: 'IMAGE_FORMAT_INVALID' });
    return `data:${mime};base64,${bytes.toString('base64')}`;
}
