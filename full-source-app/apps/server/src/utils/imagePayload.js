import { logger } from '../lib/logger.js';
/** Ảnh upscale thật quan sát được nhỏ nhất ~450 KB; 50 KB là ngưỡng rộng rãi. */
const MIN_IMAGE_BYTES = 50 * 1024;
/** Cần ít nhất 12 byte để nhận được chữ ký WEBP (RIFF....WEBP). */
const MIN_SNIFF_BYTES = 12;
/** Key hay chứa ảnh — duyệt trước để không vớ phải prompt nằm sớm hơn trong cây. */
const PRIORITY_KEYS = ['encodedImage', 'image', 'imageBytes', 'data'];
function sniffMagic(buf) {
    if (buf.length < MIN_SNIFF_BYTES)
        return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return { mime: 'image/jpeg', ext: 'jpg' };
    }
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { mime: 'image/png', ext: 'png' };
    }
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        return { mime: 'image/webp', ext: 'webp' };
    }
    return null;
}
/**
 * Trả về ảnh đã xác thực, hoặc null nếu `candidate` không phải ảnh.
 *
 * Không bao giờ ném lỗi: mọi đầu vào rác đều trả null để caller tự quyết định
 * thông điệp lỗi phù hợp với ngữ cảnh của nó.
 */
export function verifyBase64AsImage(candidate,
/**
 * Ngưỡng mặc định sinh ra để bắt payload upscale hỏng (ảnh thật ≥ 450 KB).
 * Ảnh người dùng tự chọn có thể nhỏ hơn nhiều, nên caller hạ được ngưỡng —
 * phần bảo đảm "đúng là ảnh" vẫn do magic bytes gánh, không do kích thước.
 */
opts = {}) {
    if (typeof candidate !== 'string' || !candidate)
        return null;
    let b64 = candidate;
    if (b64.startsWith('data:')) {
        const comma = b64.indexOf(',');
        if (comma === -1)
            return null; // data: URI cụt
        b64 = b64.slice(comma + 1);
    }
    // base64 hợp lệ vẫn có thể xuống dòng. Bỏ khoảng trắng thay vì loại chuỗi —
    // dùng tỉ lệ ký tự lạ để từ chối sẽ tạo âm tính giả ở đúng những payload này.
    b64 = b64.replace(/\s+/g, '');
    if (!b64)
        return null;
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < (opts.minBytes ?? MIN_IMAGE_BYTES))
        return null;
    const magic = sniffMagic(buf);
    if (!magic)
        return null;
    return { base64: b64, buf, ...magic };
}
/**
 * Duyệt đệ quy `obj` tìm chuỗi là ảnh hợp lệ.
 *
 * Vẫn duyệt toàn cây thay vì hard-code chỉ số mảng, vì hình dạng thật của phản
 * hồi BOQ chưa ai bắt được (bản dump duy nhất trong log ra `null`). Magic bytes
 * gánh phần an toàn; ưu tiên key chỉ để chọn đúng nhánh khi có nhiều ứng viên.
 */
export function extractVerifiedBase64Image(obj, maxDepth = 10) {
    if (maxDepth <= 0 || obj == null)
        return null;
    if (typeof obj === 'string')
        return verifyBase64AsImage(obj);
    if (Array.isArray(obj)) {
        for (const item of obj) {
            const found = extractVerifiedBase64Image(item, maxDepth - 1);
            if (found)
                return found;
        }
        return null;
    }
    if (typeof obj === 'object') {
        const record = obj;
        for (const key of PRIORITY_KEYS) {
            if (key in record) {
                const found = extractVerifiedBase64Image(record[key], maxDepth - 1);
                if (found)
                    return found;
            }
        }
        for (const key of Object.keys(record)) {
            if (PRIORITY_KEYS.includes(key))
                continue;
            const found = extractVerifiedBase64Image(record[key], maxDepth - 1);
            if (found)
                return found;
        }
    }
    return null;
}
/**
 * `true` khi file tại `filePath` KHÔNG phải ảnh hợp lệ (thiếu, quá nhỏ, hoặc sai
 * magic bytes). Dùng chung một định nghĩa "thế nào là ảnh" với lúc ghi, để việc
 * quét file hỏng không bao giờ lệch chuẩn so với chốt chặn ở đầu vào.
 */
export async function isCorruptImageFile(filePath) {
    const fs = await import('fs/promises');
    let handle;
    try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || stat.size < MIN_IMAGE_BYTES)
            return true;
        handle = await fs.open(filePath, 'r');
        const head = Buffer.alloc(MIN_SNIFF_BYTES);
        const { bytesRead } = await handle.read(head, 0, MIN_SNIFF_BYTES, 0);
        return sniffMagic(head.subarray(0, bytesRead)) === null;
    }
    catch (err) {
        // Không đọc được (thiếu file, thiếu quyền) → coi như hỏng; caller sẽ thử
        // lấy lại link gốc, chi phí thấp hơn nhiều so với bỏ sót một ảnh hỏng.
        logger.warn('[imagePayload] không đọc được file để kiểm tra', {
            filePath,
            error: err?.message || String(err),
        });
        return true;
    }
    finally {
        await handle?.close().catch(() => { });
    }
}
export const IMAGE_PAYLOAD_LIMITS = { MIN_IMAGE_BYTES };
