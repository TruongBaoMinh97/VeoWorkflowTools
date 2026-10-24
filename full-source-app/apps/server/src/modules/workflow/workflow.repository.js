import { prisma } from '../../lib/prisma.js';
import {
    migrateWorkflowDefinition,
    serializeWorkflowDefinition,
} from './versioning/workflowVersioning.js';
// ── Row parsers ────────────────────────────────────────────────────────────────
function parseWorkflowRow(row) {
    return migrateWorkflowDefinition({
        id: row['id'],
        name: row['name'],
        description: row['description'] ?? undefined,
        nodes: JSON.parse(row['nodes'] || '[]'),
        edges: JSON.parse(row['edges'] || '[]'),
    });
}
function parseRunRow(row) {
    return {
        id: row['id'],
        workflowId: row['workflowId'],
        profileId: row['profileId'],
        veo3ProjectId: row['veo3ProjectId'] ?? null,
        status: row['status'],
        nodeStates: JSON.parse(row['nodeStates'] || '{}'),
        inputOverrides: row['inputOverrides']
            ? JSON.parse(row['inputOverrides'])
            : null,
        error: row['error'] ?? null,
        startedAt: row['startedAt'] ?? null,
        completedAt: row['completedAt'] ?? null,
        createdAt: row['createdAt'],
        updatedAt: row['updatedAt'],
    };
}
// ── Repository ─────────────────────────────────────────────────────────────────
export const workflowRepository = {
    // ── Workflow CRUD ────────────────────────────────────────────────────────────
    async createWorkflow(def) {
        const serialized = serializeWorkflowDefinition(def);
        const row = await prisma.workflow.create({
            data: {
                name: serialized.name,
                description: serialized.description ?? null,
                nodes: JSON.stringify(serialized.nodes),
                edges: JSON.stringify(serialized.edges),
            },
        });
        return parseWorkflowRow(row);
    },
    async getWorkflow(id) {
        const row = await prisma.workflow.findUnique({ where: { id } });
        return row ? parseWorkflowRow(row) : null;
    },
    async listWorkflows() {
        const rows = await prisma.workflow.findMany({
            orderBy: { createdAt: 'desc' },
        });
        return rows.map(parseWorkflowRow);
    },
    async updateWorkflow(id, patch) {
        const data = {};
        if (patch.name !== undefined)
            data['name'] = patch.name;
        if (patch.description !== undefined)
            data['description'] = patch.description ?? null;
        if (patch.nodes !== undefined) {
            const serialized = serializeWorkflowDefinition({
                nodes: patch.nodes,
                edges: patch.edges ?? [],
            });
            data['nodes'] = JSON.stringify(serialized.nodes);
        }
        if (patch.edges !== undefined)
            data['edges'] = JSON.stringify(patch.edges);
        const row = await prisma.workflow.update({ where: { id }, data });
        return parseWorkflowRow(row);
    },
    async deleteWorkflow(id) {
        await prisma.workflow.delete({ where: { id } });
    },
    // ── WorkflowRun CRUD ─────────────────────────────────────────────────────────
    async createRun(opts, seededNodeStates) {
        const row = await prisma.workflowRun.create({
            data: {
                workflowId: opts.workflowId,
                profileId: opts.profileId,
                veo3ProjectId: opts.veo3ProjectId ?? null,
                status: 'PENDING',
                // Seed with preserved upstream results for a retry; else start blank.
                nodeStates: seededNodeStates ? JSON.stringify(seededNodeStates) : '{}',
                inputOverrides: opts.inputOverrides ? JSON.stringify(opts.inputOverrides) : null,
            },
        });
        return parseRunRow(row);
    },
    async getRun(runId) {
        const row = await prisma.workflowRun.findUnique({ where: { id: runId } });
        return row ? parseRunRow(row) : null;
    },
    /** List runs, optionally filtered by workflowId. */
    async listRuns(workflowId) {
        const rows = await prisma.workflowRun.findMany({
            where: workflowId ? { workflowId } : undefined,
            orderBy: { createdAt: 'desc' },
        });
        return rows.map(parseRunRow);
    },
    /** Alias used by routes — delegates to listRuns with a required workflowId. */
    async listRunsByWorkflow(workflowId) {
        return workflowRepository.listRuns(workflowId);
    },
    async updateRunStatus(runId, status, error) {
        const data = { status };
        if (status === 'RUNNING')
            data['startedAt'] = new Date();
        if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') {
            data['completedAt'] = new Date();
        }
        if (error !== undefined)
            data['error'] = error;
        await prisma.workflowRun.update({ where: { id: runId }, data });
    },
    async setRunProjectId(runId, veo3ProjectId) {
        await prisma.workflowRun.update({
            where: { id: runId },
            data: { veo3ProjectId },
        });
    },
    async persistNodeStates(runId, nodeStates) {
        await prisma.workflowRun.update({
            where: { id: runId },
            data: { nodeStates: JSON.stringify(nodeStates) },
        });
    },
    async findRunsByStatus(statuses) {
        const rows = await prisma.workflowRun.findMany({
            where: { status: { in: statuses } },
        });
        return rows.map(parseRunRow);
    },
    /** Batch-fetch nodeStates for a set of run IDs (poll enrichment, avoids N+1). */
    async findRunsByIds(runIds) {
        if (runIds.length === 0)
            return new Map();
        const rows = await prisma.workflowRun.findMany({
            where: { id: { in: runIds } },
            select: { id: true, nodeStates: true },
        });
        const map = new Map();
        for (const r of rows) {
            try {
                map.set(r.id, JSON.parse(r.nodeStates || '{}'));
            }
            catch {
                map.set(r.id, {});
            }
        }
        return map;
    },
};
