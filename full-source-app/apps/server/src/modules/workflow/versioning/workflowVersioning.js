import { BUILTIN_NODE_VERSIONS } from '../engine/NodeExecutorRegistry.js';

export const CURRENT_WORKFLOW_SCHEMA_VERSION = 1;

function migrateNode(node) {
    const currentVersion = BUILTIN_NODE_VERSIONS[node?.type] ?? 1;
    const storedVersion = Number.isInteger(node?.version) ? node.version : 1;
    if (storedVersion > currentVersion) {
        throw new Error(
            `Node '${node.id ?? node.type}' uses version ${storedVersion}, ` +
            `but this app supports version ${currentVersion}`,
        );
    }
    return { ...node, version: currentVersion };
}

export function migrateWorkflowDefinition(definition) {
    const nodes = Array.isArray(definition?.nodes) ? definition.nodes.map(migrateNode) : [];
    const edges = Array.isArray(definition?.edges) ? definition.edges : [];
    return {
        ...definition,
        schemaVersion: CURRENT_WORKFLOW_SCHEMA_VERSION,
        nodes,
        edges,
    };
}

export function serializeWorkflowDefinition(definition) {
    const migrated = migrateWorkflowDefinition(definition);
    return {
        ...migrated,
        nodes: migrated.nodes.map((node) => ({ ...node, version: node.version ?? 1 })),
    };
}
