/**
 * Batch repository — CRUD for WorkflowBatch + WorkflowBatchItem.
 *
 * JSON columns (profileIds, inputValues, outputPaths) are stored as strings and
 * parsed on read, mirroring workflow.repository's nodeStates handling.
 */
import { prisma } from '../../lib/prisma.js';
// ── Row parsers ────────────────────────────────────────────────────────────────
function parseJsonArray(value) {
    if (typeof value !== 'string' || !value)
        return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
    }
    catch {
        return [];
    }
}
function parseInputValues(value) {
    if (typeof value !== 'string' || !value)
        return {};
    try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const out = {};
            for (const [k, v] of Object.entries(parsed)) {
                if (typeof v === 'string')
                    out[k] = v;
            }
            return out;
        }
        return {};
    }
    catch {
        return {};
    }
}
function parseBatchRow(row) {
    return {
        id: row['id'],
        workflowId: row['workflowId'],
        name: row['name'],
        status: row['status'],
        outputDir: row['outputDir'],
        profileIds: parseJsonArray(row['profileIds']),
        autoDownload: Boolean(row['autoDownload']),
        rowsPerProfile: Math.max(1, Math.min(8, Number(row['rowsPerProfile']) || 1)),
        error: row['error'] ?? null,
        startedAt: row['startedAt'] ?? null,
        completedAt: row['completedAt'] ?? null,
        createdAt: row['createdAt'],
        updatedAt: row['updatedAt'],
    };
}
function parseItemRow(row) {
    return {
        id: row['id'],
        batchId: row['batchId'],
        rowIndex: row['rowIndex'],
        profileId: row['profileId'] ?? null,
        inputValues: parseInputValues(row['inputValues']),
        runId: row['runId'] ?? null,
        status: row['status'],
        retryCount: row['retryCount'] ?? 0,
        outputPaths: parseJsonArray(row['outputPaths']),
        error: row['error'] ?? null,
        startedAt: row['startedAt'] ?? null,
        completedAt: row['completedAt'] ?? null,
        createdAt: row['createdAt'],
        updatedAt: row['updatedAt'],
    };
}
// ── Repository ─────────────────────────────────────────────────────────────────
export const workflowBatchRepository = {
    /**
     * Split `profileIds` into the ones that no longer exist and a de-duplicated
     * copy. One indexed `in` query regardless of list length. Used to reject a
     * batch that still references a since-deleted profile.
     */
    async validateProfileIds(profileIds) {
        const deduped = [...new Set(profileIds)];
        if (deduped.length === 0)
            return { missing: [], deduped };
        const found = (await prisma.profile.findMany({
            where: { id: { in: deduped } },
            select: { id: true },
        }));
        const foundSet = new Set(found.map((p) => p.id));
        return { missing: deduped.filter((id) => !foundSet.has(id)), deduped };
    },
    async createBatch(input) {
        const batchRow = await prisma.workflowBatch.create({
            data: {
                workflowId: input.workflowId,
                name: input.name,
                status: 'PENDING',
                outputDir: input.outputDir,
                profileIds: JSON.stringify(input.profileIds),
                autoDownload: input.autoDownload ?? true,
                rowsPerProfile: Math.max(1, Math.min(8, input.rowsPerProfile ?? 1)),
                items: {
                    create: input.items.map((it) => ({
                        rowIndex: it.rowIndex,
                        inputValues: JSON.stringify(it.inputValues ?? {}),
                        status: 'PENDING',
                    })),
                },
            },
            include: { items: { orderBy: { rowIndex: 'asc' } } },
        });
        return {
            ...parseBatchRow(batchRow),
            items: batchRow.items.map(parseItemRow),
        };
    },
    async getBatch(batchId) {
        const row = await prisma.workflowBatch.findUnique({ where: { id: batchId } });
        return row ? parseBatchRow(row) : null;
    },
    async getBatchWithItems(batchId) {
        const row = await prisma.workflowBatch.findUnique({
            where: { id: batchId },
            include: { items: { orderBy: { rowIndex: 'asc' } } },
        });
        if (!row)
            return null;
        return {
            ...parseBatchRow(row),
            items: row.items.map(parseItemRow),
        };
    },
    async listBatches(workflowId) {
        const rows = await prisma.workflowBatch.findMany({
            where: workflowId ? { workflowId } : undefined,
            orderBy: { createdAt: 'desc' },
        });
        return rows.map(parseBatchRow);
    },
    async listItems(batchId) {
        const rows = await prisma.workflowBatchItem.findMany({
            where: { batchId },
            orderBy: { rowIndex: 'asc' },
        });
        return rows.map(parseItemRow);
    },
    async updateBatchStatus(batchId, status, error) {
        const data = { status };
        if (status === 'RUNNING')
            data['startedAt'] = new Date();
        if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') {
            data['completedAt'] = new Date();
        }
        if (error !== undefined)
            data['error'] = error;
        await prisma.workflowBatch.update({ where: { id: batchId }, data });
    },
    /**
     * Atomically claim the next PENDING item for a profile. Returns the claimed
     * item or null when the queue is drained. The `updateMany` guard (id +
     * status=PENDING) guarantees only one worker wins a contested row.
     */
    async claimNextItem(batchId, profileId) {
        // Loop because a lost race (count === 0) means another worker took this row;
        // try the next candidate rather than giving up. A spin cap + event-loop yield
        // guarantees we never busy-loop forever on a pathological status mismatch.
        const MAX_SPINS = 256;
        for (let spin = 0; spin < MAX_SPINS; spin++) {
            const candidate = await prisma.workflowBatchItem.findFirst({
                where: { batchId, status: 'PENDING' },
                orderBy: { rowIndex: 'asc' },
            });
            if (!candidate)
                return null;
            const claim = await prisma.workflowBatchItem.updateMany({
                where: { id: candidate.id, status: 'PENDING' },
                data: { status: 'RUNNING', profileId, startedAt: new Date() },
            });
            if (claim.count === 1) {
                const row = await prisma.workflowBatchItem.findUnique({
                    where: { id: candidate.id },
                });
                return row ? parseItemRow(row) : null;
            }
            // count === 0 → another worker claimed it; yield then retry.
            await new Promise((r) => setImmediate(r));
        }
        return null;
    },
    async setItemRun(itemId, runId) {
        await prisma.workflowBatchItem.update({
            where: { id: itemId },
            data: { runId },
        });
    },
    async completeItem(itemId, outputPaths, retryCount) {
        await prisma.workflowBatchItem.update({
            where: { id: itemId },
            data: {
                status: 'DONE',
                outputPaths: JSON.stringify(outputPaths),
                retryCount,
                error: null,
                completedAt: new Date(),
            },
        });
    },
    async failItem(itemId, status, error, retryCount = 0) {
        await prisma.workflowBatchItem.update({
            where: { id: itemId },
            data: { status, error, retryCount, completedAt: new Date() },
        });
    },
    /**
     * Reset a single terminal-error item (ERROR/CANCELLED) back to PENDING so the
     * worker pool re-runs it. Atomic `updateMany` guard: two concurrent retries of
     * the same item — only the first flips it, the loser gets `false`. `retryCount`
     * is preserved (the re-run overwrites it on completion); outputPaths cleared so
     * the poll shows a clean queued state.
     *
     * `newInputValues` (prompt/ảnh user vừa sửa) được ghi TRONG CÙNG câu update
     * với việc flip status — lane claim PENDING vì thế không bao giờ đọc được
     * giá trị cũ. Không truyền = giữ nguyên inputValues (retry thuần).
     */
    async resetItemForRetry(itemId, newInputValues) {
        const data = {
            status: 'PENDING',
            profileId: null,
            startedAt: null,
            completedAt: null,
            error: null,
            outputPaths: JSON.stringify([]),
        };
        if (newInputValues !== undefined) {
            data['inputValues'] = JSON.stringify(newInputValues);
        }
        const result = await prisma.workflowBatchItem.updateMany({
            where: { id: itemId, status: { in: ['ERROR', 'CANCELLED'] } },
            data,
        });
        return result.count === 1;
    },
    /** Reset items left RUNNING by a crash back to PENDING (resume path). */
    async resetRunningItems(batchId) {
        await prisma.workflowBatchItem.updateMany({
            where: { batchId, status: 'RUNNING' },
            data: { status: 'PENDING', profileId: null, runId: null, startedAt: null },
        });
    },
    async findBatchesByStatus(statuses) {
        const rows = await prisma.workflowBatch.findMany({
            where: { status: { in: statuses } },
        });
        return rows.map(parseBatchRow);
    },
    /** Counts used to decide a batch's terminal status. */
    async countItemsByStatus(batchId) {
        const grouped = (await prisma.workflowBatchItem.groupBy({
            by: ['status'],
            where: { batchId },
            _count: { _all: true },
        }));
        const counts = { total: 0, pending: 0, running: 0, done: 0, error: 0, cancelled: 0 };
        for (const g of grouped) {
            const n = g._count._all;
            counts.total += n;
            if (g.status === 'PENDING')
                counts.pending = n;
            else if (g.status === 'RUNNING')
                counts.running = n;
            else if (g.status === 'DONE')
                counts.done = n;
            else if (g.status === 'ERROR')
                counts.error = n;
            else if (g.status === 'CANCELLED')
                counts.cancelled = n;
        }
        return counts;
    },
    async failPendingItems(batchId, error) {
        await prisma.workflowBatchItem.updateMany({
            where: { batchId, status: 'PENDING' },
            data: { status: 'ERROR', error, completedAt: new Date() },
        });
    },
    /** Mark every still-open item of a batch as CANCELLED (cancel path). */
    async cancelOpenItems(batchId) {
        await prisma.workflowBatchItem.updateMany({
            where: { batchId, status: { in: ['PENDING', 'RUNNING'] } },
            data: { status: 'CANCELLED', completedAt: new Date() },
        });
    },
};

export async function saveBatchParallel(batchId, settings) {
 const key='workflow_batch_parallel:'+batchId,value=JSON.stringify(settings);
 await prisma.appSetting.upsert({where:{key},create:{key,value},update:{value}});
 await prisma.workflowBatch.update({where:{id:batchId},data:{rowsPerProfile:settings.concurrency}});
}
export async function loadBatchParallel(batchId) {
 const row=await prisma.appSetting.findUnique({where:{key:'workflow_batch_parallel:'+batchId}});
 return row?.value ? JSON.parse(row.value) : null;
}
