import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { MAX_REFERENCE_IMAGES, MAX_IMAGE_BYTES } from './imageInputs.js';

const isImage = name => /\.(png|jpe?g|webp)$/i.test(name);
export async function scanImageFolder(folder, mode = 'files') {
    if (!['files', 'subfolders', 'product-images'].includes(mode)) throw new Error('Chế độ quét folder không hợp lệ.');
    if (!path.isAbsolute(folder)) throw new Error('Vui lòng chọn đường dẫn folder tuyệt đối.');
    const root = path.resolve(folder);
    const entries = (await readdir(root, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    const products = [];
    const warnings = [];
    async function add(name, files) {
        if (!files.length) { warnings.push(`${name}: không có ảnh JPEG/PNG/WebP.`); return; }
        if (files.length > MAX_REFERENCE_IMAGES) throw new Error(`${name}: tối đa ${MAX_REFERENCE_IMAGES} ảnh/sản phẩm; hãy tách hoặc chọn lại folder.`);
        for (const file of files) {
            const info = await stat(file);
            if (!info.size || info.size > MAX_IMAGE_BYTES) throw new Error(`${path.basename(file)}: ảnh rỗng hoặc vượt 20 MB.`);
        }
        products.push({ productId: name, paths: files });
        if (products.length > 1000) throw new Error('Tối đa 1.000 sản phẩm mỗi lần nhập.');
    }
    for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (mode === 'files' && entry.isFile() && isImage(entry.name))
            await add(entry.name, [path.join(root, entry.name)]);
        if (['subfolders', 'product-images'].includes(mode) && entry.isDirectory()) {
            const dir = path.join(root, entry.name);
            const files = (await readdir(dir, { withFileTypes: true }))
                .filter(f => f.isFile() && isImage(f.name)).map(f => path.join(dir, f.name))
                .sort((a,b) => a.localeCompare(b, 'en', { numeric: true }));
            if (mode === 'product-images' && files.length) {
                for (const file of files) await add(`${entry.name}/${path.basename(file)}`, [file]);
            } else await add(entry.name, files);
        }
    }
    if (!products.length) throw new Error('Không tìm thấy sản phẩm. Kiểm tra chế độ mỗi ảnh / mỗi folder con.');
    return { products, warnings };
}
