import { scanImageFolder } from './folderInputs.js';
import { extractBatchSchema } from '../workflow.batch.schema.js';

export async function prepareFolderBatch(definition) {
    const folders = definition.nodes.filter(node => node.type === 'folder-input');
    if (folders.length !== 1) throw new Error('Dùng đúng một Folder Input cho mỗi workflow để tránh trộn sản phẩm.');
    const folder = folders[0];
    if (!folder.data?.folderPath) throw new Error('Chưa chọn thư mục sản phẩm trong Folder Input.');
    const schema = extractBatchSchema(definition);
    const input = schema.inputs.find(column => column.nodeId === folder.id);
    const scanned = await scanImageFolder(folder.data.folderPath, folder.data.groupMode || 'files');
    const defaults = {};
    for (const column of schema.inputs) {
        if (column === input) continue;
        const node = definition.nodes.find(item => item.id === column.nodeId);
        defaults[column.batchKey] = column.batchInputType === 'text' ? String(node.data.prompt || '')
            : node.data.localPaths?.length ? JSON.stringify(node.data.localPaths) : String(node.data.localPath || '');
    }
    return { rowsPerProfile: 2, outputDir: folder.data.outputDir || '', warnings: scanned.warnings,
        items: scanned.products.map((product, rowIndex) => ({ rowIndex, productId: product.productId,
            inputValues: { ...defaults, [input.batchKey]: folder.data.groupMode === 'subfolders' ? JSON.stringify(product.paths) : product.paths[0] } })) };
}
