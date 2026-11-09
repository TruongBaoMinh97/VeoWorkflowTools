/**
 * Live model catalogue of Flow (RPC `HTrJv`), parsed into a normalised shape.
 *
 * Google renames and retires models without notice (Nano Banana 2 → 2.1, Omni Flash 1.1 → 1.2,
 * Veo 3.1 Fast/Quality retiring on 2026-12-05). Hard-coded tables go stale, so the model pickers read
 * this snapshot instead; the static tables in videoModelResolver stay only as an offline fallback.
 *
 * Wire layout (verified against a real response, 2026-11-09). `raw[0]` is:
 *   [4] video groups  → [displayName, models[], flag, groupId?]
 *   [5] image groups  → same shape (Nano Banana models, plus the 2K / 4K upscalers)
 * and a model row is: [0] key, [4] credits per tier, [7] capability codes, [8] image capability codes,
 * [9] max image inputs, [12] aspect ratios (1 portrait, 2 landscape), [14] generation seconds,
 * [16] clip seconds, [21] [maxAudio, maxCharacters, maxImages].
 */
import fs from "fs";
import path from "path";
import { logger } from "./logger.js";
import { getElectronUserDataPath } from "./electronPaths.js";
const CODE_MODE = [
    [21, "upscale"],
    [16, "upscale"],
    [15, "upscale"],
    [14, "extend"],
    [20, "edit"],
    [6, "r2v"],
];
function asList(value) {
    return Array.isArray(value) ? value : [];
}
function numberOrNull(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function creditByTier(raw) {
    const out = {};
    for (const entry of asList(raw)) {
        const [tier, priced] = asList(entry);
        const price = numberOrNull(asList(asList(priced)[0])[1]);
        if ((tier === 1 || tier === 2 || tier === 3) && price !== null)
            out[tier] = price;
    }
    return out;
}
/** Capability codes live three lists deep: `[[[ [codes] ]]]`. */
function capabilityCodes(row) {
    const nested = asList(asList(asList(asList(row[7])[0])[0])[0]);
    return nested.filter((c) => typeof c === "number");
}
function modeFromCodes(codes, isImage) {
    if (isImage)
        return "image";
    for (const [code, mode] of CODE_MODE)
        if (codes.includes(code))
            return mode;
    if (codes.includes(7))
        return "f2f";
    if (codes.includes(5))
        return "i2v";
    return "t2v";
}
function parseAspects(raw) {
    const flat = asList(raw).flatMap((entry) => asList(entry));
    return { landscape: flat.includes(2), portrait: flat.includes(1) };
}
function parseModel(rowRaw, isImage) {
    const row = asList(rowRaw);
    const key = row[0];
    if (typeof key !== "string" || key.length === 0)
        return null;
    const limits = asList(row[21]);
    const isUpscaleKey = /UPSAMPLE|upsampler/i.test(key);
    return {
        key,
        credit: creditByTier(row[4]),
        mode: isUpscaleKey ? "upscale" : modeFromCodes(capabilityCodes(row), isImage),
        aspects: parseAspects(row[12]),
        clipSeconds: numberOrNull(row[16]) ?? numberFromKey(key),
        generationSeconds: numberOrNull(row[14]),
        maxImages: numberOrNull(row[9]) ?? numberOrNull(limits[2]),
        maxAudio: numberOrNull(limits[0]),
        maxCharacters: numberOrNull(limits[1]),
        isLowRes: /_360p$/.test(key),
    };
}
function numberFromKey(key) {
    const m = /_(\d+)s(?:_|$)/.exec(key);
    return m ? Number(m[1]) : null;
}
function parseGroups(rawGroups, isImage) {
    const groups = [];
    for (const g of asList(rawGroups)) {
        const group = asList(g);
        const displayName = group[0];
        if (typeof displayName !== "string")
            continue;
        const models = asList(group[1])
            .map((m) => parseModel(m, isImage))
            .filter((m) => m !== null);
        if (models.length === 0)
            continue;
        const id = group.find((v, i) => i >= 2 && typeof v === "string");
        groups.push({ displayName, groupId: typeof id === "string" ? id : null, models });
    }
    return groups;
}
/** Throws on a shape it does not recognise, so a changed wire format never silently empties the pickers. */
export function parseModelCatalog(payload, now = Date.now()) {
    const root = asList(asList(payload)[0]);
    const videoGroups = parseGroups(root[4], false);
    const imageGroups = parseGroups(root[5], true);
    if (videoGroups.length === 0) {
        throw new Error("Catalog HTrJv không có nhóm model video (định dạng đã đổi?)");
    }
    return { fetchedAt: now, videoGroups, imageGroups };
}
export const DEFAULT_SUNSETS = [
    { group: "Veo 3.1 - Fast", closesOn: "2026-12-05", hideFrom: "2026-11-08", note: "Google Flow retires it 2026-12-05; hidden earlier on request" },
    { group: "Veo 3.1 - Quality", closesOn: "2026-12-05", hideFrom: "2026-11-08", note: "Google Flow retires it 2026-12-05; hidden earlier on request" },
    { group: "Omni 1.1 Flash", closesOn: "2026-12-05", note: "Google Flow: Omni Flash 1.1 retired" },
];
const SUNSET_FILE = "model-sunsets.json";
function dataDir() {
    return path.join(getElectronUserDataPath(), "model-catalog");
}
function isSunset(value) {
    const v = value;
    return (!!v &&
        typeof v.group === "string" &&
        typeof v.closesOn === "string" &&
        !Number.isNaN(Date.parse(v.closesOn)) &&
        (v.hideFrom === undefined || (typeof v.hideFrom === "string" && !Number.isNaN(Date.parse(v.hideFrom)))));
}
/** Defaults, overridden per group by the VeoWorkflow user-data model-catalog folder. */
export function loadSunsets(dir = dataDir()) {
    const byGroup = new Map(DEFAULT_SUNSETS.map((s) => [s.group.toLowerCase(), s]));
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, SUNSET_FILE), "utf8"));
        for (const s of Array.isArray(parsed) ? parsed : []) {
            if (isSunset(s))
                byGroup.set(s.group.toLowerCase(), s);
        }
    }
    catch {
        /* no override file */
    }
    return [...byGroup.values()];
}
export function sunsetFor(groupName, sunsets) {
    const wanted = groupName.trim().toLowerCase();
    return sunsets.find((s) => s.group.trim().toLowerCase() === wanted) ?? null;
}
/** True once the model must no longer be offered: from `hideFrom` when set, else from `closesOn` (UTC). */
export function isClosed(sunset, now = Date.now()) {
    return !!sunset && now >= Date.parse(`${sunset.hideFrom ?? sunset.closesOn}T00:00:00Z`);
}
// ── Snapshot store ─────────────────────────────────────────────────────────────────────────────────
const CATALOG_FILE = "model-catalog.json";
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
let snapshot = null;
export function getCatalogSnapshot() {
    return snapshot;
}
export function setCatalogSnapshot(next) {
    snapshot = next;
}
export function isCatalogFresh(now = Date.now()) {
    return !!snapshot && now - snapshot.fetchedAt < CATALOG_TTL_MS;
}
export function loadCatalogFromDisk(dir = dataDir()) {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, CATALOG_FILE), "utf8"));
        const cached = raw;
        if (cached && Array.isArray(cached.videoGroups) && cached.videoGroups.length > 0 && typeof cached.fetchedAt === "number") {
            return cached;
        }
    }
    catch {
        /* no cache yet */
    }
    return null;
}
export function saveCatalogToDisk(catalog, dir = dataDir()) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const target = path.join(dir, CATALOG_FILE);
        const temp = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(catalog));
        fs.renameSync(temp, target);
    }
    catch (error) {
        logger.warn("[ModelCatalog] could not persist the catalog", error);
    }
}
/** Fetches `HTrJv` with any one usable profile and replaces the snapshot. Never throws. */
export async function refreshModelCatalog(profileIds) {
    const { callFlowRpc } = await import("./flowBoq.js");
    for (const profileId of profileIds) {
        try {
            const payload = await callFlowRpc(profileId, "HTrJv", [], { sourcePath: "/" });
            const catalog = parseModelCatalog(payload);
            snapshot = catalog;
            saveCatalogToDisk(catalog);
            logger.info(`[ModelCatalog] refreshed: ${catalog.videoGroups.length} video groups, ${catalog.imageGroups.length} image groups`);
            return catalog;
        }
        catch (error) {
            logger.warn(`[ModelCatalog] refresh with profile ${profileId.slice(0, 8)} failed`, error);
        }
    }
    return null;
}
