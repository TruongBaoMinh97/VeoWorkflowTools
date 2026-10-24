import path from 'node:path';
import { mkdir, copyFile, rename, writeFile, unlink } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { downloadFile } from '../../../utils/fileDownloader.js';
import { localImagePath } from './imageInputs.js';

export function safeSegment(value) {
    const clean = String(value ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 90);
    return !clean || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? `item_${clean}` : clean;
}
export async function saveMediaBundle({ outputDir, productId, results, prompts = [], metadata = {}, batchId, productGroup }) {
    if (!path.isAbsolute(outputDir ?? '')) throw new Error('Chọn folder đầu ra tuyệt đối trước khi lưu ảnh.');
    if (!results.length || results.some(r => !r.url)) throw new Error('Đầu ra không có media hoặc thiếu URL; chưa lưu kết quả.');
    // Batch downloads share one stable directory. Unique filenames isolate concurrent
    // products and retries; standalone Save Images retains its existing layout.
    const attemptId = randomUUID();
    const batchFolder = batchId ? `batch_${safeSegment(batchId).slice(0, 40)}_${createHash('sha256').update(String(batchId)).digest('hex').slice(0, 12)}` : null;
    const groupFolder = productGroup ? `${safeSegment(productGroup.name).slice(0, 40)}_${createHash('sha256').update(String(productGroup.key)).digest('hex').slice(0, 8)}` : null;
    const folder = batchFolder ? path.join(outputDir, batchFolder, ...(groupFolder ? [groupFolder] : []))
        : path.join(outputDir, safeSegment(productId || 'product'), attemptId);
    const prefix = batchFolder ? `${safeSegment(productId || 'product').slice(0, groupFolder ? 45 : 90)}_${attemptId}_` : '';
    await mkdir(folder, { recursive: true });
    const saved = [];
    for (const [index, result] of results.entries()) {
        const match = result.url.split(/[?#]/)[0].match(/\.(png|jpe?g|webp|gif|mp4|mov|webm)$/i);
        const ext = match ? `.${match[1].toLowerCase()}` : result.kind === 'video' ? '.mp4' : '.png';
        const destination = path.join(folder, `${prefix}${String(index + 1).padStart(2, '0')}${ext}`);
        const temporary = path.join(folder, `${prefix}${String(index + 1).padStart(2, '0')}.part${ext}`);
        try {
            if (result.url.startsWith('file://')) await copyFile(localImagePath(result.url), temporary);
            else await downloadFile(result.url, temporary);
            await rename(temporary, destination);
        } catch (error) {
            await unlink(temporary).catch(() => {});
            throw error;
        }
        saved.push({ ...result, url: `file://${destination}`, savedPath: destination });
    }
    await writeFile(path.join(folder, `${prefix}prompts.txt`), prompts.join('\n\n---\n\n'), 'utf8');
    await writeFile(path.join(folder, `${prefix}manifest.json`), JSON.stringify({ ...metadata, productId, ...(productGroup ? { productGroup } : {}), createdAt: new Date().toISOString(), results: saved, prompts }, null, 2), 'utf8');
    return saved;
}
