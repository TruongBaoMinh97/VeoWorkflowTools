/**
 * Batch Flow progress derivation — pure functions, no I/O.
 *
 * Imported by the poll route to enrich each item with per-node progress so the
 * UI can show "node X/Y + current node" without extra DB round-trips.
 */
const NODE_TYPE_LABELS = {
    'audio-splitter': 'Nạp cảnh audio đã cắt',
    'scene-template': 'Nạp prompt và tham chiếu đã chốt',
    'story-references': 'Nhân vật và style',
    prompt: 'Nhập prompt',
    'template-merge': 'Ghép template và JSON',
    'ai-prompt': 'AI đọc ảnh / viết prompt',
    chatgpt: 'ChatGPT API đọc ảnh / viết prompt',
    'save-images': 'Lưu ảnh và prompt',
    'image-review': 'Kiểm tra ảnh sản phẩm',
    'gemini-script': 'Tạo script AI',
    'upload-image': 'Tải ảnh',
    'folder-input': 'Tải ảnh sản phẩm trong folder',
    'generate-image': 'Tạo ảnh',
    'generate-video': 'Tạo video',
    'upscale-image': 'Nâng cấp ảnh',
    'upscale-video': 'Nâng cấp video',
    'merge-video': 'Ghép video',
    'extract-endframe': 'Trích khung cuối',
    'remove-image-logo': 'Xóa logo ảnh',
    'remove-video-logo': 'Xóa logo video',
    result: 'Lấy kết quả',
};
/**
 * Derive progress counts from a run's nodeStates + the workflow node index.
 * Pure: no I/O, testable in isolation.
 *
 * `totalNodes` excludes 'skipped' nodes — the engine skips them when an upstream
 * node fails, so they were never going to run and must not count toward progress.
 */
export function deriveProgress(nodeStates, nodeIndex) {
    const executable = Object.entries(nodeStates).filter(([, s]) => s.status !== 'skipped');
    const completedNodes = executable.filter(([, s]) => s.status === 'done').length;
    const errorNodes = executable.filter(([, s]) => s.status === 'error').length;
    const running = executable.find(([, s]) => s.status === 'running');
    let currentNodeLabel = null;
    if (running) {
        const def = nodeIndex.get(running[0]);
        if (def) {
            currentNodeLabel = def.label?.trim() || NODE_TYPE_LABELS[def.type] || def.type;
        }
        else {
            currentNodeLabel = running[0];
        }
    }
    if (running?.[1]?.quotaFallbackNotice) currentNodeLabel += ` · ${running[1].quotaFallbackNotice}`;
    return { completedNodes, totalNodes: executable.length, currentNodeLabel, errorNodes };
}
