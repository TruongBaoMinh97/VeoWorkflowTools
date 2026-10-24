/**
 * Resolve Flow's batchexecute rpcids at runtime.
 *
 * An rpcid is a short alias for a gRPC method, registered in the Flow web bundle as
 *
 *     {Xa:"ogiZ0b",Za:"/FlowService.BatchGenerateImages",…}
 *
 * The method name is stable; the alias can change when Google rebuilds the bundle. So
 * the code keeps the METHOD as the identity and treats the rpcid in `FLOW_RPC` as a
 * default that a discovered table may override. The table is produced by
 * `scripts/discover-flow-rpc.mjs --cdp <port> --write` (open the Flow home page, then a
 * project page if some method is still missing) and stored in the app-data folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getAppDataDirectory } from '../utils/directoryInit.js';
import { logger } from './logger.js';
/** Method each default rpcid stands for (verified against the live bundle, 2026-10-22). */
export const FLOW_METHOD_BY_DEFAULT_ID = {
    jHPbke: '/AiSandbox.CreateProject',
    ngNC2: '/AiSandbox.GetProject',
    ogiZ0b: '/FlowService.BatchGenerateImages',
    nzlxg: '/VideoFxService.GetCredits',
    Zzl0ze: '/FlowService.GetProjectContents',
    HTrJv: '/FlowService.GetModels',
    SPrCad: '/FlowService.UpsampleImage',
    maseQ: '/FlowService.UploadImage',
    as29s: '/FlowService.GetMedia',
    UpteDb: '/FlowService.GetProjects',
    WuwhI: '/FlowService.BatchLogFrontendEvents',
    DTaVef: '/FlowLikenessService.ListUserLikenesses',
    YhhmEf: '/VideoFxService.BatchAsyncGenerateVideoText',
    eb1hJf: '/VideoFxService.BatchAsyncGenerateVideoStartImage',
    nprQif: '/VideoFxService.BatchAsyncGenerateVideoStartAndEndImage',
    MZZa6b: '/VideoFxService.BatchAsyncGenerateVideoReferenceImages',
    p0UkFb: '/VideoFxService.BatchAsyncGenerateVideoUpsampleVideo',
    jwpduf: '/VideoFxService.BatchCheckAsyncVideoGenerationStatus',
};
/** `{<prop>:"<rpcid>",<prop>:"/<Service>.<Method>"` — property names are minified, so match any. */
const REGISTRATION = /\{\w{1,3}:"([A-Za-z0-9_]{4,12})",\w{1,3}:"(\/[A-Za-z0-9_]+\.[A-Za-z0-9_]+)"/g;
/** method → rpcid for every registration found in one bundle's source. */
export function scanBundleForRpcIds(source) {
    const table = new Map();
    for (const match of source.matchAll(REGISTRATION)) {
        if (!table.has(match[2]))
            table.set(match[2], match[1]);
    }
    return table;
}
const TABLE_FILE = 'flow-rpc-table.json';
let overrides = null;
const tablePath = () => path.join(getAppDataDirectory(), TABLE_FILE);
function loadOverrides() {
    if (overrides)
        return overrides;
    overrides = new Map();
    try {
        const parsed = JSON.parse(fs.readFileSync(tablePath(), 'utf8'));
        for (const [method, id] of Object.entries(parsed.ids ?? {})) {
            if (typeof id === 'string' && /^[A-Za-z0-9_]{4,12}$/.test(id))
                overrides.set(method, id);
        }
    }
    catch {
        // No table yet (or unreadable): defaults apply.
    }
    return overrides;
}
/** Replace the discovered table (in memory and on disk). */
export function applyRpcTable(ids, buildLabel) {
    overrides = new Map(ids);
    const file = {
        discoveredAt: new Date().toISOString(),
        ...(buildLabel ? { buildLabel } : {}),
        ids: Object.fromEntries(ids),
    };
    fs.writeFileSync(tablePath(), JSON.stringify(file, null, 2));
}
/** Forget the cached table so the next resolve re-reads the file (tests, manual refresh). */
export function resetRpcTableCache() {
    overrides = null;
}
/**
 * The rpcid to send for `defaultId`: the discovered id for its method when the table
 * has one, otherwise `defaultId` itself. Unknown ids pass through unchanged.
 */
export function resolveRpcId(defaultId) {
    const method = FLOW_METHOD_BY_DEFAULT_ID[defaultId];
    if (!method)
        return defaultId;
    const live = loadOverrides().get(method);
    if (live && live !== defaultId) {
        logger.info(`[FlowRpc] ${method}: dùng rpcid ${live} (mặc định ${defaultId})`);
        return live;
    }
    return defaultId;
}
