/**
 * Builds the video-model picker from the live Flow catalogue (see lib/modelCatalog.ts) instead of
 * hard-coded tables: a model Google adds shows up, one it removes disappears, and one with a retirement
 * date is hidden by itself once that day arrives.
 */
import { isClosed, sunsetFor, } from "../lib/modelCatalog.js";
const TIER_ID = { ENTRY: 1, INTERMEDIATE: 2, ADVANCED: 3 };
const DEFAULT_TIER = "INTERMEDIATE";
/** Which catalogue modes satisfy a requested generation type, best match first. */
const MODES_FOR = {
    TEXT_TO_VIDEO: ["t2v"],
    IMAGE_TO_VIDEO: ["i2v"],
    FRAME_TO_FRAME: ["f2f"],
    REFERENCE_TO_VIDEO: ["r2v"],
    REFERENCE_TO_VIDEO_AUDIO: ["r2v"],
};
const GENERATION_TYPE_OF = {
    t2v: ["TEXT_TO_VIDEO"],
    i2v: ["IMAGE_TO_VIDEO"],
    f2f: ["FRAME_TO_FRAME"],
    r2v: ["REFERENCE_TO_VIDEO", "REFERENCE_TO_VIDEO_AUDIO"],
};
const DEFAULT_GENERATION_SECONDS = 120;
/** Modes with a captured 360p row (Omni): text-to-video and reference-to-video. */
const LOW_RES_MODES = new Set(["TEXT_TO_VIDEO", "REFERENCE_TO_VIDEO"]);
export function isOmniGroup(group) {
    return /^omni\b.*flash/i.test(group.displayName);
}
/** `macaron_cookie_t2v_8s` → `macaron_cookie`; `abra_i2v_4s_360p` → `abra`. */
export function omniFamilyId(key) {
    return key.replace(/_(?:t2v|i2v_fl|i2v|r2v|edit|extend)(?:_\d+s)?(?:_360p)?$/, "");
}
function groupRank(group) {
    if (isOmniGroup(group))
        return 3;
    if (/lower priority/i.test(group.displayName))
        return 1;
    if (/\blite\b/i.test(group.displayName))
        return 0;
    return 2;
}
function offered(model, tier, landscape, lowRes = false) {
    if (model.isLowRes !== lowRes || model.credit[tier] === undefined)
        return false;
    return landscape ? model.aspects.landscape : model.aspects.portrait;
}
function candidatesFor(group, generationType, tier, landscape, lowRes = false) {
    let modes = new Set(MODES_FOR[generationType]);
    // Omni Flash 1.1 has no end-image model (only legacy `*_first_last` rows we never submit): its
    // Frame-to-Frame goes out as a start-image job. Omni 1.2 ships real `i2v_fl` keys.
    if (generationType === "FRAME_TO_FRAME" && isOmniGroup(group) && !group.models.some((m) => /_i2v_fl_/.test(m.key))) {
        modes = new Set(["i2v"]);
    }
    return group.models.filter((m) => modes.has(m.mode) && offered(m, tier, landscape, lowRes));
}
function supportedModes(group, tier, landscape) {
    const out = new Set();
    for (const type of Object.keys(MODES_FOR)) {
        if (candidatesFor(group, type, tier, landscape).length > 0)
            out.add(type);
    }
    return [...out];
}
function creditByDuration(models, tier) {
    const out = {};
    for (const m of models) {
        const price = m.credit[tier];
        if (m.clipSeconds !== null && price !== undefined)
            out[m.clipSeconds] = price;
    }
    return out;
}
function omniEntry(group, models, tier, landscape, sunset, lowRes = false) {
    const byDuration = creditByDuration(models, tier);
    const durations = Object.keys(byDuration).map(Number).sort((a, b) => a - b);
    const preferred = durations.includes(8) ? 8 : durations[0];
    const reference = group.models.find((m) => m.mode === "r2v" && m.maxImages !== null);
    const supported = supportedModes(group, tier, landscape);
    return {
        key: `${group.groupId ?? omniFamilyId(models[0].key)}${lowRes ? "_360p" : ""}`,
        displayName: `⚡ ${group.displayName}${lowRes ? " 360p" : ""}`,
        creditCost: byDuration[preferred] ?? 0,
        videoLengthSeconds: preferred,
        videoGenerationTimeSeconds: 240,
        isRelaxed: false,
        capabilities: ["VIDEO_MODEL_CAPABILITY_AUDIO", "VIDEO_MODEL_CAPABILITY_DURATION_ADJUSTABLE"],
        family: "omni_flash",
        availableDurations: durations,
        creditByDuration: byDuration,
        supportedModes: lowRes ? [...LOW_RES_MODES] : supported,
        maxImageInputs: reference?.maxImages ?? 7,
        maxAudioReferences: reference?.maxAudio ?? 5,
        maxCharacters: reference?.maxCharacters ?? 3,
        ...(sunset ? { closesOn: sunset.closesOn } : {}),
    };
}
function veoEntry(group, models, tier, sunset) {
    const model = models.find((m) => m.clipSeconds === 8) ?? models[0];
    const price = model.credit[tier] ?? 0;
    return {
        key: model.key,
        displayName: group.displayName,
        creditCost: price,
        videoLengthSeconds: model.clipSeconds ?? 8,
        videoGenerationTimeSeconds: model.generationSeconds ?? DEFAULT_GENERATION_SECONDS,
        isRelaxed: price === 0 || /low_priority/.test(model.key),
        capabilities: ["VIDEO_MODEL_CAPABILITY_AUDIO"],
        ...(sunset ? { closesOn: sunset.closesOn } : {}),
    };
}
export function buildLiveVideoModels(input) {
    const { catalog, generationType, aspectRatio, sunsets, now = Date.now() } = input;
    if (generationType === "IMAGE_GENERATION")
        return [];
    const tier = TIER_ID[input.userTier ?? DEFAULT_TIER];
    const landscape = aspectRatio !== "9:16";
    const groups = catalog.videoGroups
        .filter((g) => g.models.some((m) => m.mode !== "upscale"))
        .map((group, index) => ({ group, index }))
        .sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.index - b.index);
    const entries = [];
    for (const { group } of groups) {
        const sunset = sunsetFor(group.displayName, sunsets);
        if (isClosed(sunset, now))
            continue;
        const models = candidatesFor(group, generationType, tier, landscape);
        if (models.length === 0)
            continue;
        entries.push(isOmniGroup(group) ? omniEntry(group, models, tier, landscape, sunset) : veoEntry(group, models, tier, sunset));
        // 360p preview tier: cheaper; offered only for the modes whose row shape was captured from the web.
        if (isOmniGroup(group) && LOW_RES_MODES.has(generationType)) {
            const lowResModels = candidatesFor(group, generationType, tier, landscape, true);
            if (lowResModels.length > 0)
                entries.push(omniEntry(group, lowResModels, tier, landscape, sunset, true));
        }
    }
    return entries;
}
/** Generation types a catalogue mode stands for (used by callers that need the reverse mapping). */
export function generationTypesOf(mode) {
    return GENERATION_TYPE_OF[mode] ?? [];
}
/** Image-generation models (Nano Banana …) in catalogue order, without the 2K/4K upscalers. */
export function buildLiveImageModels(catalog, userTier) {
    const tier = TIER_ID[userTier ?? DEFAULT_TIER];
    const out = [];
    for (const group of catalog.imageGroups) {
        const model = group.models.find((m) => m.mode === "image" && m.credit[tier] !== undefined);
        if (model)
            out.push({ key: model.key, displayName: group.displayName });
    }
    return out;
}
export function buildLiveUpscaleModels(catalog, userTier) {
    const tier = TIER_ID[userTier ?? DEFAULT_TIER];
    const out = [];
    const add = (groups, kind) => {
        for (const group of groups) {
            for (const m of group.models) {
                if (m.mode === "upscale")
                    out.push({ key: m.key, displayName: group.displayName, kind, credit: m.credit[tier] ?? null });
            }
        }
    };
    add(catalog.videoGroups, "video");
    add(catalog.imageGroups, "image");
    return out;
}
