import { logger } from '../lib/logger.js';
/**
 * Google trả ảnh dưới hai dạng: `fifeUrl` (link CDN) hoặc `encodedImage`
 * (base64 vài MB). Code gọi `fifeUrl || encodedImage` rồi ghi vào `resultUrl`,
 * nên nếu Google ngừng trả link thì cả khối base64 sẽ vào SQLite, vào mọi lượt
 * poll 1,5s, rồi vào mảng jobs của renderer.
 *
 * Đo trên DB thật: `resultUrl` dài nhất 158 byte, 0 dòng base64 — chưa từng xảy
 * ra. Hàm này là chốt chặn để nó không âm thầm xảy ra.
 */
/** Link CDN thật dài ~150 byte; 2 KB là ngưỡng rộng rãi cho mọi link hợp lệ. */
const MAX_RESULT_URL_LENGTH = 2048;
export function sanitizeResultUrl(candidate, jobId) {
    if (!candidate)
        return '';
    if (!candidate.startsWith('data:') && candidate.length <= MAX_RESULT_URL_LENGTH) {
        return candidate;
    }
    logger.error('[GenNormal] resultUrl là base64/quá dài — đã chặn, không ghi vào DB', {
        jobId,
        length: candidate.length,
        prefix: candidate.slice(0, 32),
    });
    return '';
}
