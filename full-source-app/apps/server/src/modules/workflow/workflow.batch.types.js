/**
 * Batch Flow types — run one workflow template across N input rows.
 *
 * A batch holds N items (rows). Each item becomes an independent WorkflowRun
 * (its own veo3 project). `profileIds` drives a multi-profile worker pool that
 * pulls rows off a shared queue; concurrency = profiles × rowsPerProfile (1-3).
 */
export {};
