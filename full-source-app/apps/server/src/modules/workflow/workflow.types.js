// ── Canonical node-type contract (must match frontend exactly) ─────────────────
export function emptyNodeState() {
    return { status: 'pending', results: [] };
}
// ── Shared constants ───────────────────────────────────────────────────────────
export const NODE_CONCURRENCY = 4;
export const POLL_INTERVAL_MS = 5000;
export const MAX_POLL_MS = 10 * 60 * 1000;
/** Exact veo3 terminal status strings returned by pollVideoStatuses. */
export const STATUS_OK = 'MEDIA_GENERATION_STATUS_SUCCESSFUL';
export const STATUS_FAIL = 'MEDIA_GENERATION_STATUS_FAILED';
export const TEXT_SOURCES = ['prompt', 'ai-prompt', 'chatgpt', 'gemini-script', 'template-merge'];
export const IMAGE_SOURCES = [
    'character-generator',
    'upload-image',
    'generate-image',
    'upscale-image',
    'extract-endframe',
    'remove-image-logo',
];
export const VIDEO_SOURCES = [
    'generate-video',
    'upscale-video',
    'merge-video',
    'remove-video-logo',
];
// ── Shared utility ─────────────────────────────────────────────────────────────
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
