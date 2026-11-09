/**
 * Keeps the live Flow model catalogue (lib/modelCatalog.ts) current: restores the last good copy from disk
 * at boot, then refreshes it in the background and every few hours. A failed refresh keeps the previous
 * snapshot, so the pickers never go empty because Google or the network hiccuped.
 */
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { CATALOG_TTL_MS, getCatalogSnapshot, isCatalogFresh, loadCatalogFromDisk, refreshModelCatalog, setCatalogSnapshot, } from "../lib/modelCatalog.js";
const FIRST_REFRESH_DELAY_MS = 20000;
const RETRY_DELAY_MS = 5 * 60000;
const MAX_PROFILES_TRIED = 4;
let timer = null;
let inFlight = null;
async function candidateProfileIds() {
    const profiles = await prisma.profile.findMany({
        where: { active: true },
        select: { id: true },
        take: MAX_PROFILES_TRIED,
    });
    return profiles.map((p) => p.id);
}
/** One refresh at a time; concurrent callers share the same request. */
export function refreshCatalogNow() {
    if (inFlight)
        return inFlight;
    inFlight = (async () => {
        try {
            return await refreshModelCatalog(await candidateProfileIds());
        }
        finally {
            inFlight = null;
        }
    })();
    return inFlight;
}
function schedule(delayMs) {
    if (timer)
        clearTimeout(timer);
    timer = setTimeout(async () => {
        const catalog = await refreshCatalogNow().catch(() => null);
        schedule(catalog ? CATALOG_TTL_MS : RETRY_DELAY_MS);
    }, delayMs);
    timer.unref();
}
/** Call once after the server is up. Safe to call twice. */
export function startModelCatalogService() {
    if (!getCatalogSnapshot()) {
        const cached = loadCatalogFromDisk();
        if (cached) {
            setCatalogSnapshot(cached);
            logger.info(`[ModelCatalog] restored ${cached.videoGroups.length} video groups from disk cache`);
        }
    }
    schedule(isCatalogFresh() ? CATALOG_TTL_MS : FIRST_REFRESH_DELAY_MS);
}
