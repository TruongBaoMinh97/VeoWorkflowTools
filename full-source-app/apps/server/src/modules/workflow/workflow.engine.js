import {batchMediaCache,sharedBatchProject} from './lib/batchMediaCache.js';
import { hydrateStoryPayload } from './lib/storyScenes.js';
/**
 * WorkflowEngine — in-process DAG runner.
 *
 * Architecture:
 *  - One WorkflowEngine instance per active run, held in ACTIVE_ENGINES map.
 *  - Promise memoisation: each node's promise is created once and awaited by all
 *    downstream dependants — topological ordering falls out naturally.
 *  - Semaphore (NODE_CONCURRENCY=4) limits concurrent dispatches per run.
 *  - Every state transition persists nodeStates to DB and emits 'engine:event'.
 *  - Pause: engine.pauseSignal() sets a flag; checkPauseOrCancel() yields until
 *    resume(). Cancel: unblocks all waiters and throws from checkPauseOrCancel.
 *  - On restart: RUNNING/PENDING/PAUSED runs are reset to FAILED.
 *
 * Node-type contract — node.type is canonical:
 *   prompt | gemini-script | upload-image | generate-image | generate-video |
 *   upscale-image | upscale-video | merge-video | extract-endframe | result
 *
 * Sub-modes live in node.data:
 *   generate-image → data.imageMode: 'text' | 'reference'
 *   generate-video → data.videoMode: 'text-to-video' | 'image-to-video' |
 *                                    'reference-to-video' | 'frame-to-frame'
 */
import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../../lib/logger.js';
import { sessionIdManager } from '../../lib/sessionIdManager.js';
import { captchaGateway } from '../../integrations/captcha/CaptchaGateway.js';
import { profileCaptchaGuard, nextRecaptchaGapMs, BATCH_RECAPTCHA_GAP_MS, } from '../../lib/profileCaptchaGuard.js';
import { extractUUIDFromMediaId } from '../../services/veo3/veo3Service.js';
import { flowGatewayFactory } from '../../integrations/flow/FlowGateway.js';
import { profileExecutionSessionProvider } from '../../integrations/profiles/ProfileExecutionSessionProvider.js';
import { parseVeo3Error, briefVeo3Error, isNonRetryableError } from '../../services/veo3/veo3ErrorHandler.js';
import { convertAspectRatioToEnum, convertAspectRatioToImageEnum, getModelKeyForGenerationType, isOmniFlashKey, normalizeImageModelKey, } from '../../utils/videoModelResolver.js';
import { concatVideos, downloadImageToTemp } from './lib/ffmpegConcat.js';
import { extractLastSharpFrame } from './lib/extractEndFrame.js';
import { removeImageLogo, removeVideoLogo } from './lib/removeLogo.js';
import { resolveFfmpegBinary, resolveFfprobeBinary } from '../../utils/ffmpegResolver.js';
import { resolvePythonBinary, resolvePythonScript } from '../../utils/pythonResolver.js';
import { workflowRepository } from './workflow.repository.js';
import { createDefaultNodeExecutorRegistry } from './engine/NodeExecutorRegistry.js';
import { workflowImageQueue } from './lib/imageGenerationQueue.js';
import { generateWithImageQuotaFallback } from './lib/imageQuotaFallback.js';
import { needsContentReview, contentReviewMessage } from './lib/contentReview.js';
import { generateWithMannequinFallback } from './lib/mannequinFallback.js';
import { NonRetryableNodeError as NonRetryableError } from './engine/WorkflowNodeError.js';
import { isRecaptcha403, isDailyQuotaError, isTrafficLimit429, DAILY_QUOTA_SENTINEL, CAPTCHA_BURNED_SENTINEL, } from './lib/captchaErrors.js';
import { extractVerifiedBase64Image } from '../../utils/imagePayload.js';
// ── Constants ──────────────────────────────────────────────────────────────────
const NODE_CONCURRENCY = Number(process.env.WORKFLOW_NODE_CONCURRENCY) || 2;
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_MS = 10 * 60 * 1000; // 10 minutes per video operation
// A Veo 3.1 media can report SUCCESSFUL a beat before its signed CDN /video/ URL
// is provisioned (getMediaUrlRedirect 400s that instant). Rather than accept an
// empty URL, we keep re-polling that finished shot on a slower cadence — it costs
// no credits, the video already generated — until the link resolves or we give up.
const URL_RETRY_INTERVAL_MS = 10000; // re-poll a finished-but-linkless shot every 10s
const MAX_URL_WAIT_ATTEMPTS = 6; // 6 × 10s ≈ 60s grace before failing with a clear message
// Per-node auto-retry: a transient upstream/captcha/network failure on one node
// shouldn't sink the whole row. Retry the node up to maxRetries times with
// exponential backoff, releasing the concurrency slot while we sleep so ready
// nodes aren't starved.
const DEFAULT_NODE_RETRIES = 3;
const RETRY_BASE_MS = 2000;
const RETRY_CAP_MS = 30000;
const MAX_NODE_RETRIES = 5;
const TRAFFIC_LIMIT_MAX_RETRIES = 3;
const CAPTCHA_403_BUDGET_MS = Number(process.env.WORKFLOW_CAPTCHA_403_BUDGET_MS) || 30 * 60 * 1000;
const STATUS_OK = 'MEDIA_GENERATION_STATUS_SUCCESSFUL';
const STATUS_FAIL = 'MEDIA_GENERATION_STATUS_FAILED';
/** Source node types whose outputs are classified as text by edge inference. */
const TEXT_SOURCES = ['prompt', 'ai-prompt', 'chatgpt', 'gemini-script', 'template-merge'];
const GOOGLE_NODE_TYPES = new Set([
    'generate-image',
    'generate-video',
    'upscale-image',
    'upscale-video',
    'upload-image',
]);
function rawErrorTextOf(err) {
    const raw = err?.errorText;
    if (typeof raw === 'string')
        return raw.slice(0, 500);
    return err instanceof Error ? err.message : String(err);
}
// ── Gemini Script (remote system AI) helpers ────────────────────────────────
const FIREBASE_API_URL = 'https://api-ihfthcrdoq-uc.a.run.app';
const MAX_GEMINI_IMAGES = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB / image
/**
 * Build a human-readable run-level error from the failed nodes' states — never
 * raw node IDs (meaningless to users). Uses each node's friendly `error` and
 * embeds the first `reason` code in brackets so it stays greppable.
 */
export function summarizeFailedNodes(nodeStates) {
    const failed = Object.values(nodeStates).filter((s) => s.status === 'error');
    if (failed.length === 0)
        return 'Một hoặc nhiều bước thất bại';
    const messages = [...new Set(failed.map((s) => s.error ?? 'Lỗi không xác định'))];
    const reason = failed.find((s) => s.reason)?.reason;
    const body = messages.length === 1 ? messages[0] : `${messages[0]} (+ ${messages.length - 1} lỗi khác)`;
    // Only surface the code when the friendly message doesn't already contain it
    // (some parseVeo3Error messages embed it in parentheses → avoid duplication).
    const reasonSuffix = reason && !body.includes(reason) ? ` [${reason}]` : '';
    const countSuffix = failed.length > 1 ? ` (${failed.length} nodes thất bại)` : '';
    return body + reasonSuffix + countSuffix;
}
/** Map a sourceHandle to its multi-output index: 'text-out-2' → 2, else null. */
function parseTextOutIndex(handle) {
    if (!handle)
        return null;
    const m = handle.match(/^text-out-(\d+)$/);
    return m ? parseInt(m[1], 10) : null;
}
/** Fresh replay-protection nonce (no secret — mirrors the client's buildClientNonce). */
function mintNonce() {
    return { nonce: randomBytes(16).toString('hex'), ts: Date.now() };
}
/**
 * Convert an upstream image (upload-image localPath / generate-image fifeUrl) to a
 * base64 data URL for Gemini vision. Returns null on failure (skip + warn, never throw).
 */
async function mediaResultToBase64(r) {
    const url = r?.url;
    if (!url)
        return null;
    try {
        const isRemote = url.startsWith('http://') || url.startsWith('https://');
        if (!isRemote) {
            const filePath = url.startsWith('file://') ? url.slice('file://'.length) : url;
            const data = await readFile(filePath);
            if (data.byteLength > MAX_IMAGE_BYTES) {
                logger.warn(`[gemini-script] skip oversized local image (${data.byteLength}B)`);
                return null;
            }
            const ext = path.extname(filePath).toLowerCase().slice(1);
            const mime = ext === 'png' ? 'image/png'
                : ext === 'webp' ? 'image/webp'
                    : ext === 'gif' ? 'image/gif'
                        : 'image/jpeg';
            return `data:${mime};base64,${data.toString('base64')}`;
        }
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) {
            logger.warn(`[gemini-script] remote image fetch ${res.status}: ${url.slice(0, 80)}`);
            return null;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > MAX_IMAGE_BYTES) {
            logger.warn(`[gemini-script] skip oversized remote image (${buf.byteLength}B)`);
            return null;
        }
        const mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim();
        return `data:${mime};base64,${buf.toString('base64')}`;
    }
    catch (err) {
        logger.warn(`[gemini-script] image conversion failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
/** Source node types whose outputs are classified as image by edge inference. */
const IMAGE_SOURCES = [
    'character-generator',
    'upload-image',
    'generate-image',
    'upscale-image',
    'extract-endframe',
    'remove-image-logo',
];
/** Source node types whose outputs are classified as video by edge inference. */
const VIDEO_SOURCES = [
    'generate-video',
    'upscale-video',
    'merge-video',
    'remove-video-logo',
];
// ── Utilities ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// generate-video: UI videoMode → Veo generation type. The node stores a
// text-to-video model key by default; sending that to the reference / frame
// endpoints returns 500 INTERNAL. So we derive the user's tier from the stored
// key and re-resolve the CORRECT family key per mode (reuses videoModelResolver).
const GEN_TYPE_BY_VIDEO_MODE = {
    'text-to-video': 'TEXT_TO_VIDEO',
    'image-to-video': 'IMAGE_TO_VIDEO',
    'reference-to-video': 'REFERENCE_TO_VIDEO',
    'frame-to-frame': 'FRAME_TO_FRAME',
};
function deriveModelTier(modelKey) {
    if (isOmniFlashKey(modelKey))
        return { family: 'omni_flash', quality: 'fast' };
    const m = modelKey.toLowerCase();
    if (m.includes('lite_low_priority'))
        return { family: 'veo_3_1', quality: 'lite_relaxed' };
    if (m.includes('fast'))
        return { family: 'veo_3_1', quality: 'fast' };
    if (m.includes('lite'))
        return { family: 'veo_3_1', quality: 'lite' };
    return { family: 'veo_3_1', quality: 'quality' };
}
/**
 * Resolve the correct video model key for a given UI videoMode, preserving the
 * user's tier (lite/fast/omni) but switching to the family the target endpoint
 * needs (t2v/i2v/r2v/interpolation). Falls back to lite, then the stored key.
 */
function resolveVideoModelForMode(videoMode, rawRatio, storedModel, durationSec) {
    const genType = GEN_TYPE_BY_VIDEO_MODE[videoMode] ?? 'TEXT_TO_VIDEO';
    const { family, quality } = deriveModelTier(storedModel);
    return (getModelKeyForGenerationType(genType, rawRatio, quality, durationSec, family) ??
        getModelKeyForGenerationType(genType, rawRatio, 'lite', durationSec, family) ??
        storedModel);
}
function emptyNodeState() {
    return { status: 'pending', results: [] };
}
// ── Semaphore ──────────────────────────────────────────────────────────────────
class Semaphore {
    constructor(limit) {
        this.queue = [];
        this.counter = limit;
    }
    async acquire() {
        if (this.counter > 0) {
            this.counter--;
            return () => this.release();
        }
        return new Promise((resolve) => {
            this.queue.push(() => resolve(() => this.release()));
        });
    }
    release() {
        const next = this.queue.shift();
        if (next) {
            next();
        }
        else {
            this.counter++;
        }
    }
}
// ── Topological sort (Kahn's algorithm) ───────────────────────────────────────
/**
 * Returns execution order, or null if the graph contains a cycle.
 * Silently ignores edges that reference unknown node IDs.
 */
function topoSort(nodes, edges) {
    const ids = new Set(nodes.map((n) => n.id));
    const inDegree = new Map(nodes.map((n) => [n.id, 0]));
    const adj = new Map(nodes.map((n) => [n.id, []]));
    for (const e of edges) {
        if (!ids.has(e.source) || !ids.has(e.target))
            continue;
        inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
        adj.get(e.source).push(e.target);
    }
    const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    const order = [];
    while (queue.length > 0) {
        const id = queue.shift();
        order.push(id);
        for (const next of adj.get(id) ?? []) {
            const d = (inDegree.get(next) ?? 1) - 1;
            inDegree.set(next, d);
            if (d === 0)
                queue.push(next);
        }
    }
    return order.length === nodes.length ? order : null;
}
/** Classify an edge by handle name prefix, then fall back to source node type. */
function classifyEdge(e, nodes) {
    const handle = (e.targetHandle ?? e.sourceHandle ?? '').toLowerCase();
    if (handle.startsWith('text'))
        return 'text';
    if (handle.startsWith('image'))
        return 'image';
    if (handle.startsWith('video'))
        return 'video';
    const srcType = nodes.find((n) => n.id === e.source)?.type;
    if (srcType && TEXT_SOURCES.includes(srcType))
        return 'text';
    if (srcType && IMAGE_SOURCES.includes(srcType))
        return 'image';
    if (srcType && VIDEO_SOURCES.includes(srcType))
        return 'video';
    return 'unknown';
}
function incomingByKind(targetId, edges, nodes) {
    const inc = edges.filter((e) => e.target === targetId);
    return {
        text: inc.filter((e) => classifyEdge(e, nodes) === 'text'),
        image: inc.filter((e) => classifyEdge(e, nodes) === 'image'),
        video: inc.filter((e) => classifyEdge(e, nodes) === 'video'),
    };
}
/**
 * Build resolved inputs for a node from completed upstream node states.
 * Sorts each kind by the source node's position.x for deterministic ordering
 * (left-to-right mirrors visual graph layout).
 */
export function resolveInputs(targetId, edges, nodes, nodeStates) {
    const byKind = incomingByKind(targetId, edges, nodes);
    const byX = (a, b) => {
        const ax = nodes.find((n) => n.id === a.source)?.position?.x ?? 0;
        const bx = nodes.find((n) => n.id === b.source)?.position?.x ?? 0;
        if (ax !== bx)
            return ax - bx;
        return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
    };
    const sortByX = (list) => list.slice().sort(byX);
    // Ordered by the wired target port index (e.g. `video-in-2` → 2) so a merge
    // follows the port order the user connected — NOT the source node's canvas
    // x-position. Handles without an index (single `video-in` on upscale/result)
    // fall back to x-order, preserving prior behaviour.
    const portIndex = (e) => {
        const m = (e.targetHandle ?? '').match(/^video-in-(\d+)$/);
        return m ? parseInt(m[1], 10) : null;
    };
    const sortByPortThenX = (list) => list.slice().sort((a, b) => {
        const ia = portIndex(a);
        const ib = portIndex(b);
        if (ia !== null && ib !== null)
            return ia - ib;
        if (ia !== null)
            return -1;
        if (ib !== null)
            return 1;
        return byX(a, b);
    });
    const templateMerge = nodes.find(node => node.id === targetId)?.type === 'template-merge';
    let textEdges = sortByX(byKind.text);
    if (templateMerge && textEdges.some(edge => /^text-in-[01]$/.test(edge.targetHandle ?? ''))) {
        if (textEdges.some(edge => !/^text-in-[01]$/.test(edge.targetHandle ?? '')) ||
            new Set(textEdges.map(edge => edge.targetHandle)).size !== textEdges.length)
            throw new NonRetryableError('template-merge: mỗi cổng Template/JSON chỉ nhận một kết nối.');
        textEdges = [0, 1].map(index => textEdges.find(edge => edge.targetHandle === `text-in-${index}`));
    }
    const promptTexts = textEdges
        .map((e) => {
        if (!e) return '';
        const state = nodeStates[e.source];
        if (!state)
            return '';
        // Multi-output node (gemini-script): 'text-out-2' → textValues[2].
        const idx = parseTextOutIndex(e.sourceHandle);
        if (idx !== null && state.textValues)
            return state.textValues[idx] ?? '';
        // Single-output (prompt node / handle-less graphs): backward compatible.
        return state.textValue ?? '';
    })
        .filter(value => templateMerge || Boolean(value));
    const imageEdges = sortByX(byKind.image);
    const resultsOf = (e) => nodeStates[e.source]?.results ?? [];
    const imageResults = imageEdges.flatMap(resultsOf);
    const handleHas = (e, kw) => (e.targetHandle ?? '').toLowerCase().includes(kw);
    const startEdge = imageEdges.find((e) => handleHas(e, 'start'));
    const endEdge = imageEdges.find((e) => handleHas(e, 'end'));
    const startImage = (startEdge ? resultsOf(startEdge) : imageResults)[0];
    // End frame: explicit `image-in-end` handle if present; otherwise position
    // fallback ONLY when no start/end handles are wired at all.
    const endImage = endEdge
        ? resultsOf(endEdge)[0]
        : startEdge
            ? undefined
            : imageResults[1];
    const videoResults = sortByPortThenX(byKind.video).flatMap(resultsOf);
    const reviewReferences = imageEdges.filter(e => e.targetHandle === 'image-in-reference').flatMap(resultsOf);
    const reviewCandidates = imageEdges.filter(e => e.targetHandle === 'image-in-result').flatMap(resultsOf);
    const upstream = edges.filter(e => e.target === targetId).map(e => nodeStates[e.source]).filter(Boolean);
    const story = upstream.find(s => s.story)?.story;
    const storyLibrary = upstream.find(s => s.storyLibrary)?.storyLibrary;
    return { promptTexts, imageResults, videoResults, startImage, endImage, reviewReferences, reviewCandidates, story, storyLibrary };
}
// ── Engine registry ────────────────────────────────────────────────────────────
export const ACTIVE_ENGINES = new Map();
// ── WorkflowEngine ─────────────────────────────────────────────────────────────
export class WorkflowEngine extends EventEmitter {
    constructor(runId, options = {}) {
        super();
        this.cancelled = false;
        this.paused = false;
        this.pauseWaiters = [];
        this.profileId = '';
        this.veo3ProjectId = null;
        // Account paygate tier, resolved once per run from getCredits() and reused by
        // image AND video gen/upscale (Ultra accounts need PAYGATE_TIER_TWO or Google
        // downgrades to a watermarked free-tier output). Cached as a Promise so the
        // concurrent node tasks share one inflight fetch instead of racing.
        this.userPaygateTierPromise = null;
        // System AI credentials (license key + deviceId) supplied by the renderer at
        // run start — used by the gemini-script node to call the remote /openrouter
        // proxy (credit-metered). Held in memory for the run only; never logged/persisted.
        this.aiCreds = null;
        this.runId = runId;
        this.nodeExecutorRegistry = options.nodeExecutorRegistry ?? createDefaultNodeExecutorRegistry();
    }
    static getInstance(runId) {
        if (!ACTIVE_ENGINES.has(runId)) {
            ACTIVE_ENGINES.set(runId, new WorkflowEngine(runId));
        }
        return ACTIVE_ENGINES.get(runId);
    }
    static releaseInstance(runId) {
        ACTIVE_ENGINES.delete(runId);
    }
    static hasInstance(runId) {
        return ACTIVE_ENGINES.has(runId);
    }
    // ── Control signals ────────────────────────────────────────────────────────
    /** Pause execution at the next poll iteration or node boundary. */
    pauseSignal() {
        this.paused = true;
        this.emit('engine:event', { type: 'run:status', status: 'PAUSED' });
    }
    /** Resume a paused run; unblocks all checkPauseOrCancel waiters. */
    resumeSignal() {
        this.paused = false;
        const waiters = this.pauseWaiters.splice(0);
        for (const resolve of waiters)
            resolve();
        this.emit('engine:event', { type: 'run:status', status: 'RUNNING' });
    }
    /** Cancel the run; terminates at the next checkpoint. */
    cancel() {
        this.cancelled = true;
        const waiters = this.pauseWaiters.splice(0);
        for (const resolve of waiters)
            resolve(); // unblock waiters so they see cancelled=true
        this.emit('engine:event', { type: 'run:status', status: 'CANCELLED' });
    }
    // ── Entry point ────────────────────────────────────────────────────────────
    async startRun(run, def, profile, veo3ProjectId, aiCreds) {
        const storyPayload = Object.values(run.inputOverrides || {}).find(v => v?.storyPayload)?.storyPayload;
        if (storyPayload) def = (await hydrateStoryPayload(storyPayload)).snapshot.definition || def;
        def = run.inputOverrides?.__storyCharacters?.definition || def;
        this.cancelled = false;
        this.paused = false;
        this.profileId = profile.id;
        this.veo3ProjectId = veo3ProjectId ?? null;
        this.userPaygateTierPromise = null;
        this.aiCreds = aiCreds ?? null;
        // Build ONE Veo3Service for the entire run (mirrors GenNormalJobHandler pattern).
        const provider = await this.buildProvider(profile, this.veo3ProjectId);
        // Ensure a Veo3 (Flow) project exists — every generation call needs a non-empty
        // projectId, otherwise the API returns 400 INVALID_ARGUMENT (/v1/projects//...).
        // Mirrors genNormalService.ensureVeo3Projects. The run modal only supplies a
        // profileId, so create the project on first run and persist it for resume.
        if (!this.veo3ProjectId) {
            try {
                const batchId=run.inputOverrides?.__batchMedia?.batchId;
                const create=()=>provider.createProjectAndGetId(`Flow: ${def.name}`, 'PINHOLE');
                const newProjectId = batchId ? await sharedBatchProject(batchId,profile.id,create) : await create();
                this.veo3ProjectId = newProjectId;
                provider.updateConfig({ veo3ProjectId: newProjectId });
                await workflowRepository.setRunProjectId(run.id, newProjectId);
                logger.info(`[WorkflowEngine] Created Veo3 project ${newProjectId} for run ${run.id}`);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.error(`[WorkflowEngine] run ${run.id} — failed to create Veo3 project:`, err);
                await workflowRepository.updateRunStatus(run.id, 'FAILED', `Không tạo được Veo3 project (kiểm tra cookie/JWT của profile): ${msg}`);
                this.emit('engine:event', { type: 'run:status', status: 'FAILED', error: msg });
                WorkflowEngine.releaseInstance(this.runId);
                return;
            }
        }
        if(run.inputOverrides?.__batchMedia?.batchId){
            const upload=provider.uploadImageAndExtractMediaId.bind(provider);
            provider.uploadImageAndExtractMediaId=(file,projectId)=>batchMediaCache.upload(profile.id,projectId,file,upload);
        }
        // Seed nodeStates — preserve 'done' nodes so resume skips them.
        const nodeStates = {};
        for (const n of def.nodes) {
            const prev = run.nodeStates[n.id];
            nodeStates[n.id] = prev?.status === 'done' ? prev : emptyNodeState();
        }
        await workflowRepository.updateRunStatus(run.id, 'RUNNING');
        await workflowRepository.persistNodeStates(run.id, nodeStates);
        this.emit('engine:event', { type: 'run:status', status: 'RUNNING' });
        try {
            await this.walkDag(def.nodes, def.edges, run, nodeStates, provider);
            if (this.cancelled) {
                // Sweep any node still running/pending → skipped so the UI clears every
                // spinner (a node not yet at a cancel checkpoint won't transition itself).
                for (const [nid, s] of Object.entries(nodeStates)) {
                    if (s.status === 'running' || s.status === 'pending') {
                        nodeStates[nid] = { status: 'skipped', results: [] };
                        this.emit('engine:event', { type: 'node:state', nodeId: nid, state: nodeStates[nid] });
                    }
                }
                await workflowRepository.persistNodeStates(run.id, nodeStates);
                await workflowRepository.updateRunStatus(run.id, 'CANCELLED');
                this.emit('engine:event', { type: 'run:status', status: 'CANCELLED' });
            }
            else {
                const errorNodes = Object.entries(nodeStates).filter(([, s]) => s.status === 'error');
                if (errorNodes.length > 0) {
                    const msg = summarizeFailedNodes(nodeStates);
                    await workflowRepository.updateRunStatus(run.id, 'FAILED', msg);
                    this.emit('engine:event', { type: 'run:status', status: 'FAILED', error: msg });
                }
                else {
                    await workflowRepository.updateRunStatus(run.id, 'COMPLETED');
                    this.emit('engine:event', { type: 'run:status', status: 'COMPLETED' });
                }
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[WorkflowEngine] run ${run.id} fatal:`, err);
            await workflowRepository.updateRunStatus(run.id, 'FAILED', msg).catch(() => { });
            this.emit('engine:event', { type: 'run:status', status: 'FAILED', error: msg });
        }
        finally {
            WorkflowEngine.releaseInstance(this.runId);
        }
    }
    // ── DAG walk ───────────────────────────────────────────────────────────────
    async walkDag(nodes, edges, run, nodeStates, provider) {
        const order = topoSort(nodes, edges);
        if (order === null) {
            throw new Error('Workflow graph contains a cycle — execution aborted');
        }
        const sem = new Semaphore(NODE_CONCURRENCY);
        /** Persist a state transition and notify SSE subscribers. */
        const transition = async (nodeId, state) => {
            nodeStates[nodeId] = state;
            await workflowRepository.persistNodeStates(run.id, nodeStates);
            this.emit('engine:event', { type: 'node:state', nodeId, state });
        };
        // Promise memo: each node executes exactly once even when multiple
        // downstream nodes depend on it (their awaits all hit the same promise).
        const memo = new Map();
        const execNode = (nodeId) => {
            if (memo.has(nodeId))
                return memo.get(nodeId);
            const node = nodes.find((n) => n.id === nodeId);
            if (!node)
                return Promise.resolve();
            const p = (async () => {
                // 1. Await all upstream nodes first (natural topological ordering).
                const inEdges = edges.filter((e) => e.target === nodeId);
                for (const e of inEdges) {
                    await execNode(e.source);
                }
                // Pause here if paused. On cancel, mark this node skipped and return
                // (don't let the throw reject the DAG) so walkDag settles normally and
                // the run finalizes as CANCELLED with every node in a clean state.
                try {
                    await this.checkPauseOrCancel();
                }
                catch {
                    // A DB error while marking skipped must NOT reject this promise (that
                    // would route the run to FAILED). The post-walkDag sweep fixes up state.
                    try {
                        await transition(nodeId, { status: 'skipped', results: [] });
                    }
                    catch { /* swept up after walkDag */ }
                    return;
                }
                // 2. Skip if any upstream errored or was skipped.
                const upstreamFailed = inEdges.some((e) => {
                    const s = nodeStates[e.source]?.status;
                    return s === 'error' || s === 'skipped';
                });
                if (upstreamFailed) {
                    await transition(nodeId, { status: 'skipped', results: [] });
                    return;
                }
                // 3. Skip already-done nodes (resume path — preserves completed work).
                if (nodeStates[nodeId]?.status === 'done')
                    return;
                // 4. Acquire concurrency slot before heavy I/O. A `holding` flag keeps
                //    release idempotent across the backoff release/re-acquire dance so
                //    a cancellation mid-backoff can't double-release the semaphore.
                let release = await sem.acquire();
                let holding = true;
                const releaseSlot = () => {
                    if (holding) {
                        holding = false;
                        release();
                    }
                };
                // 5. Mark running.
                await transition(nodeId, { status: 'running', results: [] });
                let attempt = 0;
                try {
                    // Merge node.data with per-run overrides (override wins).
                    const mergedData = {
                        ...node.data,
                        ...(run.inputOverrides?.[nodeId] ?? {}),
                    };
                    const resolved = resolveInputs(nodeId, edges, nodes, nodeStates);
                    const maxRetries = Math.max(0, Math.min(MAX_NODE_RETRIES, Number(mergedData['maxRetries'] ?? DEFAULT_NODE_RETRIES)));
                    let dispatch = null;
                    let captcha403Attempts = 0;
                    let trafficLimitAttempts = 0;
                    const captcha403Deadline = Date.now() + CAPTCHA_403_BUDGET_MS;
                    while (dispatch === null) {
                        try {
                            await this.paceProfile(node.type, mergedData.batchParallel ?? run.inputOverrides?.__batchParallel);
                            dispatch = await this.dispatchNode(node, mergedData, resolved, provider,
                                metadata => transition(nodeId, { ...nodeStates[nodeId], ...metadata }));
                            if (GOOGLE_NODE_TYPES.has(node.type)) {
                                captchaGateway.notifySuccess();
                                profileCaptchaGuard.onSuccess(this.profileId);
                            }
                        }
                        catch (err) {
                            if (err?.code === 'FLOW_VERIFICATION_REQUIRED')
                                throw new NonRetryableError(err.message);
                            if (isDailyQuotaError(err)) {
                                logger.warn('[Workflow] quota ngày — dừng riêng node này', {
                                    profile: this.profileId.slice(0, 8),
                                    nodeId,
                                    nodeType: node.type,
                                    attempt,
                                    errorText: rawErrorTextOf(err),
                                });
                                throw new NonRetryableError(DAILY_QUOTA_SENTINEL);
                            }
                            if (isTrafficLimit429(err)) {
                                if (this.cancelled)
                                    throw err;
                                if (trafficLimitAttempts >= TRAFFIC_LIMIT_MAX_RETRIES) {
                                    throw new NonRetryableError(`Google đang giới hạn tốc độ tài khoản (429 TOO_MUCH_TRAFFIC) — đã nghỉ ${TRAFFIC_LIMIT_MAX_RETRIES} lần vẫn chưa hết. Chạy lại dòng này sau vài phút.`);
                                }
                                trafficLimitAttempts += 1;
                                const { waitMs } = profileCaptchaGuard.onTrafficLimit(this.profileId);
                                logger.warn('[Workflow429] too-much-traffic — nghỉ rồi thử lại', {
                                    profile: this.profileId.slice(0, 8),
                                    nodeId,
                                    nodeType: node.type,
                                    trafficLimitAttempts,
                                    waitMs,
                                    errorText: rawErrorTextOf(err),
                                });
                                await transition(nodeId, {
                                    status: 'running',
                                    results: [],
                                    retryCount: attempt + captcha403Attempts + trafficLimitAttempts,
                                });
                                releaseSlot();
                                await this.waitCancellable(waitMs);
                                await this.checkPauseOrCancel();
                                release = await sem.acquire();
                                holding = true;
                                continue;
                            }
                            if (isRecaptcha403(err)) {
                                const outcome = profileCaptchaGuard.onRecaptcha403(this.profileId);
                                captcha403Attempts += 1;
                                this.logRecaptcha403(nodeId, node.type, captcha403Attempts, outcome, err);
                                if (outcome.resetScore)
                                    captchaGateway.notifyRecaptchaScoreDead();
                                if (outcome.resetSession)
                                    sessionIdManager.reset(this.profileId);
                                if (this.cancelled)
                                    throw err;
                                if (Date.now() >= captcha403Deadline)
                                    throw new NonRetryableError(CAPTCHA_BURNED_SENTINEL);
                                await transition(nodeId, {
                                    status: 'running',
                                    results: [],
                                    retryCount: attempt + captcha403Attempts + trafficLimitAttempts,
                                });
                                releaseSlot();
                                await this.waitCancellable(outcome.waitMs);
                                await this.checkPauseOrCancel();
                                release = await sem.acquire();
                                holding = true;
                                continue;
                            }
                            // Never retry a cancellation, a permanent error, or once retries are exhausted.
                            // Also stop on a terminal Veo3 reason (quota/credit/content) — retrying wastes
                            // credit + captcha. Guard on errorText being a string: non-veo3 errors (network,
                            // upload) have none and must keep their normal retry behavior.
                            const et = err?.errorText;
                            const terminalVeoError = typeof et === 'string' && isNonRetryableError(et);
                            if (this.cancelled ||
                                attempt >= maxRetries ||
                                err instanceof NonRetryableError ||
                                terminalVeoError || needsContentReview(err)) {
                                throw err;
                            }
                            attempt += 1;
                            const backoff = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
                            const msg = err instanceof Error ? err.message : String(err);
                            logger.warn(`[WorkflowEngine] node ${nodeId} (${node.type}) attempt ${attempt}/${maxRetries} ` +
                                `failed (${msg}); retrying in ${backoff}ms`);
                            await transition(nodeId, { status: 'running', results: [], retryCount: attempt + captcha403Attempts + trafficLimitAttempts });
                            // Free the slot while backing off, then re-acquire to continue.
                            releaseSlot();
                            await sleep(backoff);
                            await this.checkPauseOrCancel(); // throws on cancel; waits on pause
                            release = await sem.acquire();
                            holding = true;
                        }
                    }
                    await transition(nodeId, {
                        status: 'done',
                        results: dispatch.results,
                        ...((dispatch.story || resolved.story) ? { story: dispatch.story || resolved.story } : {}),
                        ...(dispatch.storyLibrary ? { storyLibrary: dispatch.storyLibrary } : {}),
                        ...(dispatch.imageModelMetadata ?? {}),
                        ...(dispatch.textValue !== undefined ? { textValue: dispatch.textValue } : {}),
                        ...(dispatch.textValues !== undefined ? { textValues: dispatch.textValues } : {}),
                        ...(attempt > 0 ? { retryCount: attempt } : {}),
                        completedAt: new Date().toISOString(),
                    });
                }
                catch (err) {
                    const rawMsg = err instanceof Error ? err.message : String(err);
                    // Veo3 API errors carry `errorText` (Google JSON) → map to a friendly
                    // Vietnamese message + keep the raw reason code. Non-veo3 errors (upload,
                    // merge, network) have no errorText → fall back to the raw message.
                    const errorText = err?.errorText;
                    const brief = typeof errorText === 'string' ? briefVeo3Error(err) : null;
                    const parsedMsg = brief ? parseVeo3Error(errorText, rawMsg) : rawMsg;
                    const displayMsg = needsContentReview(err) || needsContentReview(parsedMsg) ? contentReviewMessage(parsedMsg) : parsedMsg;
                    const reasonCode = brief?.reason;
                    // Cancellation is not a failure — mark the node skipped (grey), not a
                    // red error, so the UI shows a clean "cancelled" state.
                    if (this.cancelled) {
                        await transition(nodeId, { status: 'skipped', results: [] });
                    }
                    else {
                        logger.error(`[WorkflowEngine] node ${nodeId} (${node.type}) error:`, brief ?? err);
                        await transition(nodeId, {
                            ...nodeStates[nodeId],
                            status: 'error',
                            results: [],
                            error: displayMsg,
                            ...(reasonCode !== undefined ? { reason: reasonCode } : {}),
                            ...(attempt > 0 ? { retryCount: attempt } : {}),
                        });
                    }
                }
                finally {
                    releaseSlot();
                }
            })();
            memo.set(nodeId, p);
            return p;
        };
        // Kick all nodes; memoisation + upstream awaits enforce ordering.
        await Promise.all(order.map((id) => execNode(id)));
    }
    // ── Pause / cancel checkpoint ──────────────────────────────────────────────
    async checkPauseOrCancel() {
        if (this.cancelled)
            throw new Error('Run was cancelled');
        if (this.paused) {
            await new Promise((resolve) => this.pauseWaiters.push(resolve));
            if (this.cancelled)
                throw new Error('Run was cancelled after being paused');
        }
    }
    logRecaptcha403(nodeId, nodeType, attempt, outcome, err) {
        const errorText = err?.errorText;
        const reason = typeof errorText === 'string'
            ? (errorText.match(/PUBLIC_ERROR_\w+/)?.[0] ?? 'UNKNOWN')
            : 'UNKNOWN';
        logger.warn('[Workflow403]', {
            profile: this.profileId.slice(0, 8),
            nodeId,
            nodeType,
            attempt,
            reason,
            failures: outcome.failures,
            in5min: outcome.windowCount,
            msSincePrevious: outcome.msSincePrevious,
            waitMs: outcome.waitMs,
            action: outcome.action,
            didResetScore: outcome.resetScore,
            nodeConcurrency: NODE_CONCURRENCY,
            note: outcome.reason,
        });
    }
    async waitCancellable(totalMs, stepMs = 1000) {
        const deadline = Date.now() + totalMs;
        while (Date.now() < deadline) {
            if (this.cancelled)
                return;
            await sleep(Math.min(stepMs, deadline - Date.now()));
        }
    }
    async paceProfile(nodeType, parallelSettings = null) {
        if (!GOOGLE_NODE_TYPES.has(nodeType))
            return;
        // Batch ảnh bám đúng Veo3 Gen: các ảnh trong một burst đi gần song song,
        // workflowImageQueue sẽ nghỉ `restSeconds` sau cả đợt. Upload và thao tác
        // Google phụ vẫn giãn nhẹ 1s như hàng đợi Gen gốc.
        const gapMs = parallelSettings
            ? (nodeType === 'generate-image' ? 0 : BATCH_RECAPTCHA_GAP_MS)
            : nextRecaptchaGapMs(nodeType === 'generate-video' ? 'video' : 'image');
        const waitMs = profileCaptchaGuard.reserveSlot(this.profileId, gapMs);
        if (waitMs > 0)
            await this.waitCancellable(waitMs);
    }
    // ── Gemini Script: remote system AI call ────────────────────────────────────
    /**
     * Call the credit-metered remote /openrouter/generate proxy (task `flow.script`)
     * and return EXACTLY `outputCount` prompts. Charges 5 credits server-side on
     * success (free quota first); refunds on AI failure. Retries once on a 409
     * nonce replay (pre-charge), never on a 402 (insufficient credit).
     */
    async callGeminiScript(args, retry = 0) {
        const creds = this.aiCreds;
        const { nonce, ts } = mintNonce();
        const res = await fetch(`${FIREBASE_API_URL}/openrouter/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                key: creds.key,
                deviceId: creds.deviceId,
                task: 'flow.script',
                prompt: args.prompt,
                base64Images: args.base64Images.length ? args.base64Images : undefined,
                contextData: { ratio: args.ratio, outputMode: args.outputMode, outputCount: args.outputCount },
                _nonce: nonce,
                _ts: ts,
            }),
            signal: AbortSignal.timeout(120000),
        });
        if (!(res.headers.get('content-type') || '').includes('application/json')) {
            throw new Error(`gemini-script: phản hồi không hợp lệ từ máy chủ AI (${res.status})`);
        }
        const body = (await res.json());
        if (!body.success) {
            if (res.status === 409 && retry === 0)
                return this.callGeminiScript(args, 1); // nonce replay (pre-charge)
            // 402 = no charge, permanent → don't let the engine retry-loop re-attempt.
            if (res.status === 402)
                throw new NonRetryableError('gemini-script: Không đủ credit để tạo kịch bản');
            throw new Error(`gemini-script: ${body.message ?? 'máy chủ AI lỗi'}`);
        }
        let raw = body.data?.parsed?.prompts;
        if (raw === undefined) {
            try {
                raw = JSON.parse(body.data?.text ?? '{}').prompts;
            }
            catch { /* leave undefined */ }
        }
        // Keep positions (don't filter blanks) — output port #k must map to prompt #k.
        let prompts = Array.isArray(raw) ? raw.map((p) => String(p).trim()) : [];
        // Server already charged (success=true); throwing here would let the retry loop
        // re-charge. Treat "no usable prompts" as N empty outputs instead.
        if (prompts.length === 0) {
            logger.warn('[gemini-script] server returned success but 0 prompts — using empty outputs');
            prompts = Array(args.outputCount).fill('');
        }
        // Force exactly outputCount (pad '' / truncate).
        if (prompts.length < args.outputCount) {
            prompts = [...prompts, ...Array(args.outputCount - prompts.length).fill('')];
        }
        else if (prompts.length > args.outputCount) {
            prompts = prompts.slice(0, args.outputCount);
        }
        return prompts;
    }
    // ── Node dispatch ──────────────────────────────────────────────────────────
    /**
     * Dispatch a single node to the appropriate veo3Service call(s).
     *
     * node.type drives the outer switch; for 'generate-image' and 'generate-video'
     * the sub-mode is read from merged data.imageMode / data.videoMode.
     *
     * Returns { results, textValue? }:
     *   - results  → stored in NodeRunState.results (empty for prompt nodes)
     *   - textValue → stored in NodeRunState.textValue (prompt nodes only)
     */
    async dispatchNode(node, data, resolved, provider, onImageModel = async () => {}) {
        return this.nodeExecutorRegistry.execute(node.type, {
            engine: this,
            node,
            data,
            resolved,
            provider,
            projectId: this.veo3ProjectId ?? '',
            isCancelled: () => this.cancelled,
            executeLegacy: () => this.dispatchLegacyNode(node, data, resolved, provider, onImageModel),
        });
    }
    async dispatchLegacyNode(node, data, resolved, provider, onImageModel = async () => {}) {
        const projectId = this.veo3ProjectId ?? '';
        switch (node.type) {
            // ── prompt ────────────────────────────────────────────────────────────
            case 'prompt': {
                const value = data['prompt'] ?? '';
                // Text is stored in textValue; resolveInputs reads it from NodeRunState.textValue.
                return { results: [], textValue: value };
            }
            // ── upload-image ──────────────────────────────────────────────────────
            case 'upload-image': {
                // Dual role: a picked local file (data.localPath) OR an incoming image
                // edge (e.g. remove-image-logo) — connecting a cleaned image re-uploads
                // it to Veo3 so downstream nodes get a real mediaId. The edge wins.
                const upstream = resolved.imageResults[0];
                let localPath;
                let downloadedTemp = null;
                if (upstream?.url) {
                    if (upstream.url.startsWith('file://')) {
                        localPath = upstream.url.slice('file://'.length);
                    }
                    else {
                        localPath = await downloadImageToTemp(upstream.url, 'upload-image');
                        downloadedTemp = localPath;
                    }
                }
                else {
                    localPath = data['localPath'] ?? '';
                    if (!localPath) {
                        throw new NonRetryableError('upload-image: chưa nối ảnh đầu vào và chưa chọn file — nối ảnh từ node Xóa Logo/Generate/Upscale hoặc chọn ảnh');
                    }
                }
                try {
                    // Use the extractor that prefers the UUID `name` (what flow/uploadImage
                    // returns and what image-to-image's imageInputs[].name requires).
                    const mediaId = await provider.uploadImageAndExtractMediaId(localPath, projectId);
                    return { results: [{ mediaId, url: `file://${localPath}`, kind: 'image' }] };
                }
                finally {
                    if (downloadedTemp)
                        await unlink(downloadedTemp).catch(() => { });
                }
            }
            // ── generate-image ────────────────────────────────────────────────────
            case 'generate-image': {
                if (resolved.story) data = { ...data, imageMode: resolved.imageResults.length ? 'image-to-image' : 'text-to-image', quotaFallback: false, contentFallback: 'none' };
                const imageMode = data['imageMode'] ?? 'text-to-image';
                const model = data['model'] ?? 'GEM_PIX_2';
                const rawImageRatio = (data['ratio'] ?? '1:1');
                const imageAspectRatio = convertAspectRatioToImageEnum(rawImageRatio);
                const count = Math.max(1, Math.min(4, Number(data['count'] ?? 1)));
                const seed = data['seed'] !== undefined ? Number(data['seed']) : undefined;
                const prompt = resolved.promptTexts[0] ?? '';
                const refMediaIds = resolved.imageResults.map((r) => r.mediaId).filter(Boolean);
                // Reference mode = the frontend "Image → Image" mode (or explicit 'reference').
                const isReference = imageMode === 'reference' || imageMode === 'image-to-image';
                if (!prompt.trim()) throw new NonRetryableError('Generate Image: prompt trống. Kiểm tra node AI Gen Prompt.');
                if (isReference && (!refMediaIds.length || refMediaIds.length !== resolved.imageResults.length))
                    throw new NonRetryableError('Generate Image: thiếu ảnh tham chiếu đã upload. Nối Upload Image vào cổng ảnh.');
                // Normalize the stored model key; removed catalog entries (e.g. legacy 'R2I',
                // 'IMAGEN_3_5') coerce to 'GEM_PIX_2'. The key is then passed verbatim to the
                // Flow API — all 3 Nano Banana models accept reference images via imageInputs.
                const imageModelName = normalizeImageModelKey(model);
                const prompts = Array.from({ length: count }, (_, i) => ({
                    prompt,
                    seed: seed !== undefined ? seed + i : undefined,
                    referenceImageMediaIds: isReference && refMediaIds.length > 0 ? refMediaIds : undefined,
                }));
                let imageModelMetadata;
                this.completedImageRequests ??= new Map();
                const generated = await generateWithMannequinFallback({
                    enabled: data.contentFallback === 'mannequin', images: resolved.imageResults, count,
                    isCancelled: () => this.cancelled,
                    generate: async (fallbackPrompts) => {
                        const outcome = await generateWithImageQuotaFallback({
                            profileId: this.profileId, primary: imageModelName,
                            enabled: data.quotaFallback !== false, models: data.quotaFallbackModels,
                            isCancelled: () => this.cancelled, onModel: onImageModel,
                            generate: (selectedModel, blocked) => workflowImageQueue.run(this.profileId, count, () => this.cancelled, async (onSubmitFired) => {
                                await this.checkPauseOrCancel();
                                if (blocked()) throw new Error('PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED');
                                const imageRequestKey = JSON.stringify([node.id, projectId, selectedModel, imageAspectRatio, fallbackPrompts ?? prompts]);
                                if (!this.completedImageRequests.has(imageRequestKey)) this.completedImageRequests.set(imageRequestKey, new Map());
                                return provider.generateBatchImages({
                                    projectId,
                                    imageModelName: selectedModel,
                                    imageAspectRatio,
                                    prompts: fallbackPrompts ?? prompts,
                                    onSubmitFired,
                                    isCancelled: () => this.cancelled,
                                    completedImages: this.completedImageRequests.get(imageRequestKey),
                                });
                            }, data.batchParallel),
                        });
                        const { value, ...metadata } = outcome;
                        imageModelMetadata = metadata;
                        return value;
                    },
                });
                const batchResults = generated.results;
                if (!batchResults?.length) {
                    throw new Error('generate-image: provider returned no results');
                }
                return {
                    imageModelMetadata,
                    ...(generated.fallbackPrompt ? { textValue: generated.fallbackPrompt, textValues: [generated.fallbackPrompt] } : {}),
                    results: batchResults.map((r) => ({
                        // `mediaId` = UUID resource name — the id Flow resolves for EVERY
                        // image input: image-to-image, upscale, AND video start/reference
                        // frames. Sending the generation id (`veoMediaId`) to the video
                        // endpoints returns 500 INTERNAL because the decoded generation UUID
                        // is not the media-resource id.
                        mediaId: r.name ?? r.veoMediaId ?? '',
                        // `veoMediaId` = generation id. Kept for diagnostics/fallback only.
                        veoMediaId: r.veoMediaId ?? r.mediaGenerationId ?? r.name ?? '',
                        url: r.fifeUrl ?? '',
                        kind: 'image',
                        imageModel: imageModelMetadata.actualImageModel,
                        quotaFallbackHistory: imageModelMetadata.quotaFallbackHistory,
                        ...(generated.fallbackPrompt ? { presentation: 'mannequin', prompt: generated.fallbackPrompt } : {}),
                    })),
                };
            }
            // ── generate-video ────────────────────────────────────────────────────
            case 'generate-video': {
                const videoMode = data['videoMode'] ?? 'text-to-video';
                const storedModel = data['model'] ?? 'veo_3_1_t2v_lite';
                const rawVideoRatio = (data['ratio'] ?? '16:9');
                const durationSec = Math.max(4, Math.min(10, Number(data['duration'] ?? 8)));
                // Resolve the model key for THIS mode. The node stores a t2v-family key by
                // default; sending it to the reference/frame endpoints returns 500 INTERNAL.
                // This preserves the user's lite/fast/omni tier but picks the right family.
                const videoModelKey = resolveVideoModelForMode(videoMode, rawVideoRatio, storedModel, durationSec);
                const aspectRatio = convertAspectRatioToEnum(rawVideoRatio);
                const count = Math.max(1, Math.min(4, Number(data['count'] ?? 1)));
                const prompt = resolved.promptTexts[0] ?? '';
                const batchId = randomUUID();
                const tier = await this.resolveUserPaygateTier(provider);
                let operations;
                switch (videoMode) {
                    case 'text-to-video': {
                        const res = await provider.batchAsyncGenerateVideoText({
                            clientContext: this.buildClientContext(projectId, tier),
                            requests: Array.from({ length: count }, () => ({
                                textInput: { prompt },
                                videoModelKey,
                                aspectRatio,
                                metadata: { sceneId: randomUUID() },
                            })),
                            useV2ModelConfig: true,
                            mediaGenerationContext: {
                                batchId,
                                audioFailurePreference: 'BLOCK_SILENCED_VIDEOS',
                            },
                        });
                        operations = res.operations;
                        break;
                    }
                    case 'image-to-video': {
                        // Use the media-resource id (mediaId = name), not the generation id.
                        const startInput = resolved.startImage ?? resolved.imageResults[0];
                        const startMediaId = startInput?.mediaId ?? startInput?.veoMediaId;
                        if (!startMediaId) {
                            throw new Error('generate-video (image-to-video): no image input connected — connect an image node');
                        }
                        const res = await provider.batchAsyncGenerateVideoStartImage({
                            clientContext: this.buildClientContext(projectId, tier),
                            requests: Array.from({ length: count }, () => ({
                                textInput: { prompt },
                                videoModelKey,
                                aspectRatio,
                                metadata: { sceneId: randomUUID() },
                                startImage: { mediaId: startMediaId },
                            })),
                            useV2ModelConfig: true,
                            mediaGenerationContext: { batchId },
                        });
                        operations = res.operations;
                        break;
                    }
                    case 'reference-to-video': {
                        // Reference frames must be the media-resource id (mediaId = name).
                        // The generation id (veoMediaId) decodes to a non-resource UUID that
                        // Flow can't resolve → 500 INTERNAL.
                        const refIds = resolved.imageResults
                            .map((r) => r.mediaId ?? r.veoMediaId)
                            .filter(Boolean);
                        if (refIds.length === 0) {
                            throw new Error('generate-video (reference-to-video): no reference image inputs connected');
                        }
                        const res = await provider.batchAsyncGenerateVideoReferenceImages({
                            clientContext: this.buildClientContext(projectId, tier),
                            requests: Array.from({ length: count }, () => ({
                                textInput: { prompt },
                                videoModelKey,
                                aspectRatio,
                                metadata: { sceneId: randomUUID() },
                                referenceImages: refIds.map((id) => ({ mediaId: id })),
                            })),
                            useV2ModelConfig: true,
                            mediaGenerationContext: { batchId },
                        });
                        operations = res.operations;
                        break;
                    }
                    case 'frame-to-frame': {
                        // Frames use the media-resource id (mediaId = name). Start frame is
                        // resolved by the `image-in-start` handle; end by `image-in-end`.
                        const startInput = resolved.startImage ?? resolved.imageResults[0];
                        const startId = startInput?.mediaId ?? startInput?.veoMediaId;
                        const endId = resolved.endImage?.mediaId ?? resolved.endImage?.veoMediaId;
                        if (!startId) {
                            throw new Error('generate-video (frame-to-frame): start image input required');
                        }
                        if (!endId) {
                            // Only a start frame is wired → animate it as image-to-video. The
                            // start+end endpoint requires BOTH frames (else 400 INVALID_ARGUMENT),
                            // and it needs the i2v model family, not the interpolation key.
                            const i2vModelKey = resolveVideoModelForMode('image-to-video', rawVideoRatio, storedModel, durationSec);
                            const res = await provider.batchAsyncGenerateVideoStartImage({
                                clientContext: this.buildClientContext(projectId, tier),
                                requests: Array.from({ length: count }, () => ({
                                    textInput: { prompt },
                                    videoModelKey: i2vModelKey,
                                    aspectRatio,
                                    metadata: { sceneId: randomUUID() },
                                    startImage: { mediaId: startId },
                                })),
                                useV2ModelConfig: true,
                                mediaGenerationContext: { batchId },
                            });
                            operations = res.operations;
                            break;
                        }
                        const res = await provider.batchAsyncGenerateVideoStartAndEndImage({
                            clientContext: this.buildClientContext(projectId, tier),
                            requests: Array.from({ length: count }, () => ({
                                textInput: { prompt },
                                videoModelKey,
                                aspectRatio,
                                metadata: { sceneId: randomUUID() },
                                startImage: { mediaId: startId },
                                endImage: { mediaId: endId },
                            })),
                            useV2ModelConfig: true,
                            mediaGenerationContext: { batchId },
                        });
                        operations = res.operations;
                        break;
                    }
                    default:
                        throw new Error(`generate-video: unknown videoMode '${videoMode}' — expected text-to-video | image-to-video | reference-to-video | frame-to-frame`);
                }
                const results = await this.pollMultipleVideos(provider, operations);
                return { results };
            }
            // ── upscale-image ─────────────────────────────────────────────────────
            case 'upscale-image': {
                const imageResult = resolved.imageResults[0];
                if (!imageResult) {
                    throw new Error('upscale-image: no image input connected');
                }
                const resKey = data['resolution'] ?? '2K';
                const targetResolution = resKey === '4K' ? 'UPSAMPLE_IMAGE_RESOLUTION_4K' : 'UPSAMPLE_IMAGE_RESOLUTION_2K';
                // Pass the account's REAL tier. The Flow engine runs without session
                // cookies, so Google can't infer the tier; sending the wrong tier (e.g.
                // TIER_ONE for an Ultra account) yields a watermarked, blurred upscale.
                const tier = await this.resolveUserPaygateTier(provider);
                const response = await provider.upsampleImage(imageResult.mediaId, targetResolution, projectId, tier);
                // Synchronous path: base64-encoded image returned directly. Google
                // returns JPEG bytes (with C2PA metadata) — write the real extension so
                // the file is served + downloaded with the correct content type.
                const verifiedBuf = response?.verifiedBuf;
                const verified = verifiedBuf
                    ? { buf: verifiedBuf, ext: response?.ext || 'jpg' }
                    : extractVerifiedBase64Image(response);
                if (verified) {
                    const tmpPath = path.join(os.tmpdir(), `wf_upscale_${randomUUID()}.${verified.ext}`);
                    await writeFile(tmpPath, verified.buf);
                    return { results: [{ mediaId: imageResult.mediaId, url: `file://${tmpPath}`, kind: 'image' }] };
                }
                // Asynchronous path: operation name to poll.
                const opName = response.operations?.[0]?.name ?? response.name ?? response.operation?.name;
                if (!opName) {
                    throw new Error('upscale-image: response contained neither encodedImage nor operation name');
                }
                const url = await this.pollSingleOperation(provider, opName);
                if (!url)
                    throw new Error('upscale-image: poll succeeded but returned no URL');
                return { results: [{ mediaId: imageResult.mediaId, url, kind: 'image' }] };
            }
            // ── upscale-video ─────────────────────────────────────────────────────
            case 'upscale-video': {
                const videoResult = resolved.videoResults[0];
                if (!videoResult) {
                    throw new Error('upscale-video: no video input connected');
                }
                // Veo 3.1 upsample requires videoInput.mediaId = the FLAT UUID of the
                // source video. The encoded CAUS…/CAM… id (which encodes the project)
                // is rejected with 404 NOT_FOUND — verified in genNormal's
                // VideoUpsamplingHandler.resolveSourceVideoUuid.
                const sourceUuid = this.resolveVideoUuid(videoResult);
                if (!sourceUuid) {
                    throw new Error('upscale-video: could not resolve source video UUID (encoded media id cannot be upsampled)');
                }
                const resKey = data['resolution'] ?? '1080P';
                const is4K = resKey === '4K';
                const targetResolution = is4K ? 'VIDEO_RESOLUTION_4K' : 'VIDEO_RESOLUTION_1080P';
                const videoModelKey = is4K ? 'veo_3_1_upsampler_4k' : 'veo_3_1_upsampler_1080p';
                // Aspect ratio not explicitly in canonical spec for this node, default 16:9.
                const rawRatio = (data['ratio'] ?? '16:9');
                const aspectRatioEnum = convertAspectRatioToEnum(rawRatio);
                const workflowId = randomUUID();
                const tier = await this.resolveUserPaygateTier(provider);
                const res = await provider.batchAsyncGenerateVideoUpsampleVideo({
                    clientContext: this.buildClientContext(projectId, tier),
                    mediaGenerationContext: {
                        audioFailurePreference: 'BLOCK_SILENCED_VIDEOS',
                    },
                    requests: [
                        {
                            aspectRatio: aspectRatioEnum,
                            resolution: targetResolution,
                            seed: Math.floor(Math.random() * 1000000),
                            videoInput: { mediaId: sourceUuid },
                            videoModelKey,
                            metadata: { workflowId },
                        },
                    ],
                    useV2ModelConfig: true,
                });
                const results = await this.pollMultipleVideos(provider, res.operations);
                return { results };
            }
            // ── merge-video ───────────────────────────────────────────────────────
            case 'merge-video': {
                const portCount = Number(data['portCount'] ?? resolved.videoResults.length);
                const rawResults = resolved.videoResults.slice(0, portCount);
                // A missing shot URL here means an upstream generate-video finished without
                // a resolvable link. Fail with a clear, actionable message instead of letting
                // an empty path reach ffmpeg (which dies with a cryptic "string required").
                // NonRetryable: the upstream result is cached in this run's node graph, so
                // retrying the merge alone re-reads the same empty value and can't re-resolve.
                rawResults.forEach((r, i) => {
                    if (!r.url?.trim()) {
                        throw new NonRetryableError(`Ghép video: đoạn #${i + 1} thiếu link (URL rỗng). Bấm "gen lại" dòng này.`);
                    }
                });
                const videoPaths = rawResults.map((r) => r.url.startsWith('file://') ? r.url.slice(7) : r.url);
                if (videoPaths.length < 2) {
                    throw new Error(`merge-video: requires ≥2 video inputs, got ${videoPaths.length}`);
                }
                const outputPath = path.join(os.tmpdir(), `wf_merge_${randomUUID()}.mp4`);
                await concatVideos(videoPaths, outputPath);
                return { results: [{ mediaId: '', url: `file://${outputPath}`, kind: 'video' }] };
            }
            // ── gemini-script (remote system AI → list of N prompts) ────────────────
            case 'gemini-script': {
                const nodePrompt = (data['prompt'] ?? '').trim();
                const ratio = data['ratio'] === '16:9' ? '16:9' : '9:16';
                const outputMode = data['outputMode'] === 'video' ? 'video' : 'image';
                const rawCount = Number(data['outputCount'] ?? 2);
                const outputCount = Number.isFinite(rawCount) ? Math.max(1, Math.min(6, rawCount)) : 2;
                // The node's own brief + an optional upstream text-in (context).
                const prompt = [resolved.promptTexts[0] ?? '', nodePrompt].filter(Boolean).join('\n\n');
                if (!prompt) {
                    throw new NonRetryableError('gemini-script: prompt trống — nhập trong node hoặc nối một prompt node');
                }
                if (!this.aiCreds?.key || !this.aiCreds?.deviceId) {
                    throw new NonRetryableError('gemini-script: thiếu thông tin đăng nhập để gọi AI hệ thống (hãy đăng nhập lại)');
                }
                // Reference images (cap 4) → base64; failures skipped, not fatal.
                const base64Images = (await Promise.all(resolved.imageResults.slice(0, MAX_GEMINI_IMAGES).map((r) => mediaResultToBase64(r)))).filter((b) => b !== null);
                const prompts = await this.callGeminiScript({
                    prompt, base64Images, ratio, outputMode, outputCount,
                });
                // Cancel may have fired during the (up to 120s) fetch — throw so the
                // outer catch marks this node skipped instead of done in a cancelled run.
                if (this.cancelled)
                    throw new Error('Run was cancelled');
                return { results: [], textValues: prompts, textValue: prompts[0] ?? '' };
            }
            // ── remove-image-logo ─────────────────────────────────────────────────
            case 'remove-image-logo': {
                const imageResult = resolved.imageResults[0];
                if (!imageResult?.url) {
                    throw new NonRetryableError('remove-image-logo: chưa nối ảnh đầu vào — hãy nối từ node Generate/Upscale/Upload Image');
                }
                // Resolve binaries before the download so a missing environment fails
                // instantly instead of after pulling the image off the CDN.
                const pythonBin = resolvePythonBinary();
                const scriptPath = resolvePythonScript('remove_watermark_batch.py');
                if (!pythonBin || !scriptPath) {
                    throw new NonRetryableError('remove-image-logo: không tìm thấy Python hoặc script xóa logo — kiểm tra cài đặt môi trường');
                }
                const dstPath = await removeImageLogo(imageResult.url, {
                    pythonBin,
                    scriptPath,
                    method: data['method'] ?? 'calib',
                    strength: data['strength'] !== undefined ? Number(data['strength']) : undefined,
                });
                // Download + Python can span a cancel; don't emit a stale result.
                if (this.cancelled)
                    throw new Error('Run was cancelled');
                // mediaId is empty: this is a local-only file. Connect an Upload Image
                // node to re-upload it to Veo3 when a mediaId is needed downstream.
                return { results: [{ mediaId: '', url: `file://${dstPath}`, kind: 'image' }] };
            }
            // ── remove-video-logo ─────────────────────────────────────────────────
            case 'remove-video-logo': {
                const videoInput = resolved.videoResults[0];
                if (!videoInput?.url) {
                    throw new NonRetryableError('remove-video-logo: chưa nối video đầu vào — hãy nối từ node Generate/Upscale/Merge Video');
                }
                const pythonBin = resolvePythonBinary();
                const scriptPath = resolvePythonScript('remove_video_watermark_batch.py');
                const ffmpegBin = resolveFfmpegBinary();
                const ffprobeBin = resolveFfprobeBinary();
                if (!pythonBin || !scriptPath) {
                    throw new NonRetryableError('remove-video-logo: không tìm thấy Python hoặc script xóa logo — kiểm tra cài đặt môi trường');
                }
                if (!ffmpegBin || !ffprobeBin) {
                    throw new NonRetryableError('remove-video-logo: cần cả ffmpeg và ffprobe — cài đặt rồi chạy lại');
                }
                const dstPath = await removeVideoLogo(videoInput.url, {
                    pythonBin,
                    scriptPath,
                    ffmpegBin,
                    ffprobeBin,
                    logo: data['logo'] ?? 'auto',
                    corner: data['corner'] ?? 'br',
                    crf: data['crf'] !== undefined ? Number(data['crf']) : undefined,
                    strength: data['strength'] !== undefined ? Number(data['strength']) : undefined,
                });
                if (this.cancelled)
                    throw new Error('Run was cancelled');
                return { results: [{ mediaId: '', url: `file://${dstPath}`, kind: 'video' }] };
            }
            // ── extract-endframe ──────────────────────────────────────────────────
            case 'extract-endframe': {
                const videoResult = resolved.videoResults[0];
                if (!videoResult?.url) {
                    throw new NonRetryableError('extract-endframe: chưa nối video đầu vào — hãy nối từ node Generate/Upscale/Merge Video');
                }
                // Resolved before the download so a missing binary fails instantly
                // instead of after pulling a few hundred MB off the CDN.
                const ffmpegBin = resolveFfmpegBinary();
                if (!ffmpegBin) {
                    throw new NonRetryableError('extract-endframe: không tìm thấy ffmpeg — cài ffmpeg rồi chạy lại');
                }
                const framePath = await extractLastSharpFrame(videoResult.url, ffmpegBin);
                // Download + ffmpeg can span a cancel; don't spend an upload on a run
                // that is already going away.
                if (this.cancelled)
                    throw new Error('Run was cancelled');
                // Identical call to the upload-image case above, so the mediaId is the
                // same UUID resource `name` every image consumer resolves — video
                // start/reference frames, upscale-image, generate-image references.
                const mediaId = await provider.uploadImageAndExtractMediaId(framePath, projectId);
                return { results: [{ mediaId, url: `file://${framePath}`, kind: 'image' }] };
            }
            // ── result ────────────────────────────────────────────────────────────
            case 'result': {
                // Terminal aggregator — surfaces all upstream media to the UI.
                const allMedia = [...resolved.imageResults, ...resolved.videoResults];
                return { results: allMedia };
            }
            default: {
                // TypeScript exhaustiveness guard
                const _exhaustive = node.type;
                throw new Error(`Unknown node type: '${String(_exhaustive)}'`);
            }
        }
    }
    // ── Helpers ────────────────────────────────────────────────────────────────
    /**
     * Resolve (and cache) the account's real paygate tier. Image upscale must send
     * the account's actual tier — an Ultra account upscaled as PAYGATE_TIER_ONE
     * gets a watermarked/blurred free-tier image. Falls back to PAYGATE_TIER_ONE
     * if credits can't be fetched.
     */
    resolveUserPaygateTier(provider) {
        if (this.userPaygateTierPromise)
            return this.userPaygateTierPromise;
        this.userPaygateTierPromise = provider
            .getCredits()
            .then((credits) => {
            const tier = credits?.userPaygateTier === 'PAYGATE_TIER_TWO'
                ? 'PAYGATE_TIER_TWO'
                : 'PAYGATE_TIER_ONE';
            logger.info(`[WorkflowEngine] resolved userPaygateTier=${tier} for run ${this.runId}`);
            return tier;
        })
            .catch((err) => {
            // Fail-safe: most accounts are TIER_ONE, so falling back keeps upscale
            // working on a transient getCredits blip rather than failing the node.
            logger.warn(`[WorkflowEngine] getCredits failed, defaulting tier to PAYGATE_TIER_ONE: ${err instanceof Error ? err.message : String(err)}`);
            return 'PAYGATE_TIER_ONE';
        });
        return this.userPaygateTierPromise;
    }
    buildClientContext(projectId, tier = 'PAYGATE_TIER_ONE') {
        return {
            sessionId: sessionIdManager.get(this.profileId, this.veo3ProjectId),
            projectId,
            tool: 'PINHOLE',
            userPaygateTier: tier,
        };
    }
    /**
     * Resolve the flat UUID of a generated video for upsampling. Mirrors
     * genNormal's VideoUpsamplingHandler.resolveSourceVideoUuid: the Veo upsample
     * API needs the bare UUID (parsed from the CDN url `…/video/<uuid>?…`), not the
     * encoded CAUS…/CAM… media id (which encodes the project and 404s).
     */
    resolveVideoUuid(result) {
        const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
        // 1) CDN url: /video/<uuid>, then any UUID in the url.
        const url = result.url ?? '';
        if (url) {
            const fromPath = url.match(/\/video\/([0-9a-f-]{36})/i);
            if (fromPath && UUID_RE.test(fromPath[1]))
                return fromPath[1];
            const anyUuid = url.match(UUID_RE);
            if (anyUuid)
                return anyUuid[0];
        }
        // 2) mediaId already a flat UUID (t2v operation name).
        const mediaId = result.mediaId ?? '';
        if (mediaId && !mediaId.startsWith('CA')) {
            const m = mediaId.match(UUID_RE);
            return m ? m[0] : mediaId;
        }
        // 3) CAM… → decode to UUID.
        if (mediaId.startsWith('CAM')) {
            const decoded = extractUUIDFromMediaId(mediaId);
            if (UUID_RE.test(decoded))
                return decoded;
        }
        // 4) CAUS… / undecodable.
        return null;
    }
    /**
     * Poll a set of video generation operations until all reach a terminal status.
     * Works for batchAsyncGenerateVideo*, batchAsyncGenerateVideoUpsampleVideo.
     * Checks pause/cancel at every iteration.
     */
    async pollMultipleVideos(provider, operations) {
        if (!operations?.length) {
            throw new Error('No operations returned in video generate response');
        }
        const pending = operations.map((op) => ({
            operationName: op.operation.name,
            sceneId: op.sceneId ?? randomUUID(),
            mediaId: '',
            url: '',
            error: null,
            done: false,
            awaitingUrl: false, // SUCCESSFUL but the playable URL hasn't resolved yet
            urlAttempts: 0, // count of 10s link-resolve retries so far
        }));
        const deadline = Date.now() + MAX_POLL_MS;
        const MAX_POLL_ERRORS = 8;
        let consecutiveErrors = 0;
        while (true) {
            await this.checkPauseOrCancel();
            if (Date.now() > deadline) {
                throw new Error('Video generation timed out after 10 minutes');
            }
            const notDone = pending.filter((p) => !p.done);
            if (notDone.length === 0)
                break;
            // Videos are async — wait a tick before each poll so the first poll isn't
            // a guaranteed miss, and the API isn't hammered. Once the only work left is
            // waiting for a finished shot's CDN link, slow the cadence to give it time.
            const onlyAwaitingUrl = notDone.every((p) => p.awaitingUrl);
            await sleep(onlyAwaitingUrl ? URL_RETRY_INTERVAL_MS : POLL_INTERVAL_MS);
            let pollResults;
            try {
                pollResults = await provider.pollVideoStatuses(
                // Pass projectId so Veo 3.1 media-UUID operations poll via the media
                // endpoint instead of the legacy one (which 400s on a media UUID).
                notDone.map((p) => ({
                    operationName: p.operationName,
                    sceneId: p.sceneId,
                    projectId: this.veo3ProjectId ?? undefined,
                })));
                consecutiveErrors = 0;
            }
            catch (err) {
                // pollVideoStatuses throws transiently (e.g. "No operation returned"
                // before the op is registered). Tolerate a few before giving up.
                consecutiveErrors += 1;
                logger.warn(`[WorkflowEngine] video poll error ${consecutiveErrors}/${MAX_POLL_ERRORS}: ${err instanceof Error ? err.message : String(err)}`);
                if (consecutiveErrors >= MAX_POLL_ERRORS) {
                    throw new Error('Lost connection while polling video status');
                }
                continue;
            }
            for (const r of pollResults) {
                const item = pending.find((p) => p.operationName === r.operationName);
                if (!item || item.done)
                    continue;
                if (r.status === STATUS_OK) {
                    if (r.videoUrl) {
                        // The shot is only truly done once its playable URL has resolved.
                        item.done = true;
                        item.awaitingUrl = false;
                        item.mediaId = r.mediaId ?? r.operationName;
                        item.url = r.videoUrl;
                    }
                    else {
                        // Generated, but the CDN link isn't ready yet — keep it pending so the
                        // next (slower) cycle re-resolves, bounded so a truly broken link fails.
                        item.awaitingUrl = true;
                        item.urlAttempts += 1;
                        logger.warn(`[WorkflowEngine] SUCCESSFUL nhưng chưa có URL video (${item.urlAttempts}/${MAX_URL_WAIT_ATTEMPTS}): ${item.operationName.slice(-12)}`);
                        if (item.urlAttempts >= MAX_URL_WAIT_ATTEMPTS) {
                            item.done = true;
                            item.error =
                                `Video đã tạo xong nhưng không lấy được link sau ${MAX_URL_WAIT_ATTEMPTS} lần thử ` +
                                    `(~${(MAX_URL_WAIT_ATTEMPTS * URL_RETRY_INTERVAL_MS) / 1000}s). Bấm "gen lại" dòng này.`;
                        }
                    }
                }
                else if (r.status === STATUS_FAIL) {
                    item.done = true;
                    item.error = r.error ?? 'Video generation failed';
                }
            }
        }
        const errors = pending.filter((p) => p.error);
        if (errors.length > 0) {
            throw new Error(`${errors.length} video operation(s) failed: ${errors.map((e) => e.error).join('; ')}`);
        }
        return pending.map((p) => ({ mediaId: p.mediaId, url: p.url, kind: 'video' }));
    }
    /** Poll a single async operation (used for async upscale-image path). */
    async pollSingleOperation(provider, operationName) {
        const sceneId = randomUUID();
        const deadline = Date.now() + MAX_POLL_MS;
        let urlAttempts = 0;
        while (true) {
            await this.checkPauseOrCancel();
            if (Date.now() > deadline)
                throw new Error('Image upscale timed out after 10 minutes');
            const results = await provider.pollVideoStatuses([{ operationName, sceneId }]);
            const r = results[0];
            if (!r)
                throw new Error('pollVideoStatuses returned empty result');
            if (r.status === STATUS_OK) {
                if (r.videoUrl)
                    return r.videoUrl;
                // Finished but the CDN link isn't ready — retry on the slow cadence.
                urlAttempts += 1;
                logger.warn(`[WorkflowEngine] Upscale SUCCESSFUL nhưng chưa có URL (${urlAttempts}/${MAX_URL_WAIT_ATTEMPTS}): ${operationName.slice(-12)}`);
                if (urlAttempts >= MAX_URL_WAIT_ATTEMPTS) {
                    // Sleep sits after the increment here, so the actual wait is (N-1) × interval.
                    throw new Error(`Upscale xong nhưng không lấy được link sau ${MAX_URL_WAIT_ATTEMPTS} lần thử ` +
                        `(~${((MAX_URL_WAIT_ATTEMPTS - 1) * URL_RETRY_INTERVAL_MS) / 1000}s). Bấm "gen lại" dòng này.`);
                }
                await sleep(URL_RETRY_INTERVAL_MS);
                continue;
            }
            if (r.status === STATUS_FAIL)
                throw new Error(r.error ?? 'Image upscale operation failed');
            await sleep(POLL_INTERVAL_MS);
        }
    }
    /**
     * Mirror credential loading from GenNormalJobHandler lines 84–119.
     * Builds one Veo3Service per run, configured for the given profile.
     */
    async buildProvider(profile, veo3ProjectId) {
        const session = await profileExecutionSessionProvider.getExecutionSession(profile, {
            veo3ProjectId,
        });
        return flowGatewayFactory.create(session);
    }
}
// ── Engine facade (used by workflow.service.ts and core/init.ts) ───────────────
export const workflowEngine = {
    /**
     * Start a run asynchronously (fire-and-forget).
     * Route handlers return { runId } immediately; clients subscribe via SSE.
     */
    startRun(run, def, profile, veo3ProjectId, aiCreds) {
        const engine = WorkflowEngine.getInstance(run.id);
        engine.startRun(run, def, profile, veo3ProjectId, aiCreds).catch(async (err) => {
            if (run.inputOverrides?.__storyCharacters) { await workflowRepository.updateRunStatus(run.id, 'FAILED', err.message); WorkflowEngine.releaseInstance(run.id); }
            logger.error(`[workflowEngine] uncaught error in run ${run.id}:`, err);
        });
    },
    cancelRun(runId) {
        ACTIVE_ENGINES.get(runId)?.cancel();
    },
    async pauseRun(runId) {
        const engine = ACTIVE_ENGINES.get(runId);
        if (!engine)
            return;
        engine.pauseSignal();
        await workflowRepository.updateRunStatus(runId, 'PAUSED');
    },
    async resumeRun(runId) {
        const engine = ACTIVE_ENGINES.get(runId);
        if (!engine)
            return;
        engine.resumeSignal();
        await workflowRepository.updateRunStatus(runId, 'RUNNING');
    },
    /**
     * Called once at server boot.
     * Resets any runs that were interrupted by a prior crash so the UI shows FAILED.
     * Running nodes are reset to pending so a manual restart attempt is consistent.
     */
    async rehydrateRunningRuns() {
        const runs = await workflowRepository.findRunsByStatus(['RUNNING', 'PENDING', 'PAUSED']);
        if (runs.length === 0)
            return;
        logger.info(`[workflowEngine] Resetting ${runs.length} interrupted run(s) after restart`);
        for (const run of runs) {
            const patched = { ...run.nodeStates };
            for (const [id, state] of Object.entries(patched)) {
                if (state.status === 'running') {
                    patched[id] = { ...state, status: 'pending' };
                }
            }
            await workflowRepository.persistNodeStates(run.id, patched);
            await workflowRepository.updateRunStatus(run.id, 'FAILED', 'Server restarted while run was in progress — restart the run manually');
        }
    },
};
