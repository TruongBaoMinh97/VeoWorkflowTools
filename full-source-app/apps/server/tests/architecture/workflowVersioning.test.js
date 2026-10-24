import { describe, expect, it } from 'vitest';
import {
    CURRENT_WORKFLOW_SCHEMA_VERSION,
    migrateWorkflowDefinition,
    serializeWorkflowDefinition,
} from '../../src/modules/workflow/versioning/workflowVersioning.js';

describe('workflow versioning', () => {
    it('upgrades legacy nodes in memory', () => {
        const migrated = migrateWorkflowDefinition({
            id: 'wf-1',
            nodes: [{ id: 'n1', type: 'prompt', data: { prompt: 'x' } }],
            edges: [],
        });

        expect(migrated.schemaVersion).toBe(CURRENT_WORKFLOW_SCHEMA_VERSION);
        expect(migrated.nodes[0].version).toBe(1);
    });

    it('persists node versions and rejects unsupported future versions', () => {
        expect(serializeWorkflowDefinition({
            nodes: [{ id: 'n1', type: 'result', data: {} }],
            edges: [],
        }).nodes[0].version).toBe(1);

        expect(() => migrateWorkflowDefinition({
            nodes: [{ id: 'n1', type: 'result', version: 99, data: {} }],
            edges: [],
        })).toThrow(/supports version 1/);
    });
});
