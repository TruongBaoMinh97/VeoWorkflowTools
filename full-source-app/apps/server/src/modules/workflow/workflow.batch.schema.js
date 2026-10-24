/**
 * Batch schema extraction.
 *
 * Reads `batchRole` / `batchKey` / `batchLabel` from node.data (set in the flow
 * editor) and returns the input columns + output sinks for a batch run. The
 * input TYPE (image | text) is DERIVED from node.type so it can never drift from
 * what the node actually consumes.
 */
/** Only these node types can be marked as a batch INPUT. */
const INPUT_NODE_TYPES = new Set(['prompt', 'upload-image', 'folder-input', 'story-input', 'audio-splitter']);
/** Only these node types can be marked as a batch OUTPUT (they emit final media). */
const OUTPUT_NODE_TYPES = new Set([
    'generate-image',
    'upscale-image',
    'remove-image-logo',
    'save-images',
    'image-review',
    'generate-video',
    'merge-video',
    'upscale-video',
    'remove-video-logo',
    'result',
]);
/** Map an input node type to the value kind a row cell must supply. */
function inputTypeForNode(type) {
    if (type === 'story-input' || type === 'audio-splitter') return 'text';
    if (type === 'prompt')
        return 'text';
    if (type === 'upload-image' || type === 'folder-input')
        return 'image';
    return null;
}
function slugify(value) {
    return value
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // strip combining diacritics (Việt → Viet)
        .replace(/[đĐ]/g, 'd')
        .toLowerCase()
        .trim()
        .replace(/[^\w-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}
/** Resolve a stable column key: explicit batchKey → slug(label) → node id. */
function resolveKey(node) {
    const explicit = node.data?.['batchKey'];
    if (typeof explicit === 'string' && explicit.trim())
        return slugify(explicit);
    const label = node.data?.['batchLabel'];
    if (typeof label === 'string' && label.trim())
        return slugify(label) || node.id;
    return node.id;
}
function resolveLabel(node, fallbackKey) {
    const label = node.data?.['batchLabel'];
    if (typeof label === 'string' && label.trim())
        return label.trim();
    return fallbackKey;
}
/** Parse a user-set order index from node.data — a positive integer, or null. */
function validOrder(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
/**
 * Order columns by the user-defined index (node.data.batchOrder) when present,
 * otherwise keep the original left-to-right (position.x) layout order. Nodes with
 * an explicit order sort ascending and ahead of unordered ones; ties fall back to
 * position.x then id for stability.
 */
function compareBatchOrder(a, b) {
    const oa = validOrder(a.data?.['batchOrder']);
    const ob = validOrder(b.data?.['batchOrder']);
    if (oa !== null && ob !== null) {
        if (oa !== ob)
            return oa - ob;
    }
    else if (oa !== null) {
        return -1;
    }
    else if (ob !== null) {
        return 1;
    }
    const dx = (a.position?.x ?? 0) - (b.position?.x ?? 0);
    if (dx !== 0)
        return dx;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
export function extractBatchSchema(def) {
    const inputNodes = def.nodes
        .filter((n) => n.type === 'audio-splitter' || n.type === 'story-input' || n.type === 'folder-input' || (n.data?.['batchRole'] === 'input' && INPUT_NODE_TYPES.has(n.type)))
        .sort(compareBatchOrder);
    const outputNodes = def.nodes
        .filter((n) => n.data?.['batchRole'] === 'output' && OUTPUT_NODE_TYPES.has(n.type))
        .sort(compareBatchOrder);
    const seenInputKeys = new Set();
    const inputs = [];
    for (const node of inputNodes) {
        const batchInputType = inputTypeForNode(node.type);
        if (!batchInputType)
            continue;
        const key = uniqueKey(resolveKey(node), seenInputKeys);
        inputs.push({
            nodeId: node.id,
            batchKey: key,
            batchLabel: resolveLabel(node, key),
            batchInputType,
            ...(node.type === 'folder-input' ? { folderInput: true } : {}),
            ...(['story-input','audio-splitter'].includes(node.type) ? { storyInput: true } : {}),
            ...(node.type === 'audio-splitter' ? { audioSplitter: true } : {}),
        });
    }
    const seenOutputKeys = new Set();
    const outputs = [];
    for (const node of outputNodes) {
        const key = uniqueKey(resolveKey(node), seenOutputKeys);
        outputs.push({ nodeId: node.id, batchKey: key, batchLabel: resolveLabel(node, key) });
    }
    return { inputs, outputs };
}
/** Disambiguate duplicate keys by suffixing -2, -3, … so columns stay distinct. */
function uniqueKey(base, seen) {
    let key = base;
    let n = 2;
    while (seen.has(key))
        key = `${base}-${n++}`;
    seen.add(key);
    return key;
}
