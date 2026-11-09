import { logger } from '../lib/logger.js';
/**
 * Video Model Resolver
 * Logic để chọn đúng video model key dựa trên generation type và aspect ratio
 * Dựa trên dữ liệu model thực tế từ Veo3 API
 *
 * UPDATED 2026-05-16: Flow API đã bỏ family "Fast [Lower Priority]"
 * (`*_fast_*_ultra_relaxed`). Thay vào đó:
 * - "Lite [Lower Priority]" (`*_lite_low_priority`) là tier free/relaxed mới.
 * - REFERENCE_TO_VIDEO giờ chấp nhận `veo_3_1_r2v_lite` cho cả LANDSCAPE và
 *   PORTRAIT (3 image refs, audio, 8s).
 *
 * Active tiers per mode:
 * - TEXT_TO_VIDEO   : lite | lite_relaxed | fast | quality
 * - IMAGE_TO_VIDEO  : lite | lite_relaxed | fast | quality
 * - FRAME_TO_FRAME  : lite | lite_relaxed | fast | quality
 * - REFERENCE_TO_VIDEO : lite | lite_relaxed | fast  (no Quality from API)
 */
import { getCatalogSnapshot, isClosed, loadSunsets, sunsetFor, } from '../lib/modelCatalog.js';
import { buildLiveImageModels, buildLiveVideoModels } from './liveVideoModels.js';
// Omni Flash families. 1.1 = id "abra" (4/6/8/10s); 1.2 = id "macaron_cookie" (3-15s, real end-image
// key `i2v_fl` up to 10s). The picker is built from the live catalogue; these tables serve the
// key builder and the offline fallback.
export const OMNI_FLASH_DURATIONS = [4, 6, 8, 10];
const OMNI_FAMILIES = {
    abra: {
        durations: OMNI_FLASH_DURATIONS,
        maxSecondsByPrefix: {},
        frameToFramePrefix: null,
        creditByDuration: { 4: 7, 6: 10, 8: 12, 10: 15 },
    },
    macaron_cookie: {
        durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        maxSecondsByPrefix: { i2v_fl: 10 },
        frameToFramePrefix: 'i2v_fl',
        creditByDuration: { 3: 9, 4: 12, 5: 15, 6: 18, 7: 21, 8: 24, 9: 27, 10: 30, 11: 36, 12: 42, 13: 48, 14: 54, 15: 60 },
    },
};
const OMNI_FLASH_CREDIT_BY_DURATION = { ...OMNI_FAMILIES.abra.creditByDuration };
const OMNI_FLASH_SUPPORTED_MODES = [
    'TEXT_TO_VIDEO',
    'REFERENCE_TO_VIDEO',
    'REFERENCE_TO_VIDEO_AUDIO',
    'IMAGE_TO_VIDEO',
    'FRAME_TO_FRAME',
];
function omniPrefixFor(family, generationType) {
    switch (generationType) {
        case 'TEXT_TO_VIDEO': return 't2v';
        case 'REFERENCE_TO_VIDEO':
        case 'REFERENCE_TO_VIDEO_AUDIO': return 'r2v';
        case 'IMAGE_TO_VIDEO': return 'i2v';
        case 'FRAME_TO_FRAME': return OMNI_FAMILIES[family].frameToFramePrefix ?? 'i2v';
        default: return null;
    }
}
export function omniFamilyOfKey(key) {
    if (!key)
        return null;
    if (key === 'macaron_cookie' || key.startsWith('macaron_cookie_'))
        return 'macaron_cookie';
    if (key === 'abra' || key.startsWith('abra_'))
        return 'abra';
    return null;
}
export function isOmniFlashKey(key) {
    return omniFamilyOfKey(key) !== null;
}
/** Supported duration for a family and key prefix: out of range is clamped, a gap inside the range falls back to 8s. */
function normalizeOmniDuration(family, prefix, duration) {
    const spec = OMNI_FAMILIES[family];
    const max = spec.maxSecondsByPrefix[prefix] ?? Math.max(...spec.durations);
    const allowed = spec.durations.filter((d) => d <= max);
    if (!duration)
        return 8;
    if (allowed.includes(duration))
        return duration;
    if (duration > allowed[allowed.length - 1])
        return allowed[allowed.length - 1];
    if (duration < allowed[0])
        return allowed[0];
    return allowed.includes(8) ? 8 : allowed[0];
}
/** A picker key like `abra_360p` / `macaron_cookie_360p` asks for the low-resolution (cheaper) variant. */
export function isOmniLowResKey(key) {
    return !!key && /_360p$/.test(key) && isOmniFlashKey(key);
}
/**
 * `lowRes` is honoured for text-to-video and reference-to-video without voices: those are the 360p row shapes
 * captured from the web client, so other modes always get the full-resolution key.
 */
export function buildOmniModelKey(family, generationType, duration, lowRes = false) {
    const prefix = omniPrefixFor(family, generationType);
    if (!prefix)
        return null;
    const lowResMode = generationType === 'TEXT_TO_VIDEO' || generationType === 'REFERENCE_TO_VIDEO';
    const suffix = lowRes && lowResMode ? '_360p' : '';
    return `${family}_${prefix}_${normalizeOmniDuration(family, prefix, duration)}s${suffix}`;
}
/**
 * Image generation model keys
 */
export const IMAGE_GENERATION_MODELS = {
    GEM_PIX_2: 'GEM_PIX_2', // 🍌 Nano Banana Pro
    BELUGA: 'BELUGA', // 🍌 Nano Banana 2 (Google renamed NARWHAL → BELUGA, 2026-10)
    HARBOR_SEAL: 'HARBOR_SEAL', // 🍌 Nano Banana 2 Lite
};
/**
 * Normalize an image model key from DB / flow-node storage.
 * Removed or unknown keys (e.g. legacy 'R2I', 'IMAGEN_3_5') coerce to 'GEM_PIX_2'
 * so old projects/flows never submit an invalid model to the Flow API.
 */
// Legacy key aliases — Google renamed models server-side. Old projects/flows that
// saved the previous key get remapped to the current working one instead of
// coercing to the GEM_PIX_2 default.
const LEGACY_IMAGE_MODEL_ALIASES = {
    NARWHAL: 'BELUGA', // Nano Banana 2: NARWHAL → 404 since 2026-10; now BELUGA
};
export function normalizeImageModelKey(key) {
    if (key != null && Object.prototype.hasOwnProperty.call(LEGACY_IMAGE_MODEL_ALIASES, key)) {
        return LEGACY_IMAGE_MODEL_ALIASES[key];
    }
    // Own-property check (not `in`) so prototype-chain keys like 'constructor'/'__proto__'
    // don't slip through and get sent verbatim to the Flow API.
    return key != null && Object.prototype.hasOwnProperty.call(IMAGE_GENERATION_MODELS, key)
        ? key
        : 'GEM_PIX_2';
}
// TEXT_TO_VIDEO models (VIDEO_MODEL_CAPABILITY_TEXT)
// API: batchAsyncGenerateVideoText
const TEXT_TO_VIDEO_MODELS = {
    'VIDEO_ASPECT_RATIO_PORTRAIT': {
        fast: 'veo_3_1_t2v_fast_portrait_ultra', // 9:16 - 10 credits, ~100s
        quality: 'veo_3_1_t2v_portrait', // 9:16 - 100 credits, ~210s
        lite: 'veo_3_1_t2v_lite', // 9:16 - 5/10 credits, ~110s
        lite_relaxed: 'veo_3_1_t2v_lite_low_priority', // 9:16 - 0 credits, ~110s
    },
    'VIDEO_ASPECT_RATIO_LANDSCAPE': {
        fast: 'veo_3_1_t2v_fast_ultra', // 16:9 - 10 credits, ~100s
        quality: 'veo_3_1_t2v', // 16:9 - 100 credits, ~210s
        lite: 'veo_3_1_t2v_lite', // 16:9 - 5/10 credits, ~110s
        lite_relaxed: 'veo_3_1_t2v_lite_low_priority', // 16:9 - 0 credits, ~110s
    },
};
// IMAGE_TO_VIDEO models (VIDEO_MODEL_CAPABILITY_START_IMAGE)
// API: batchAsyncGenerateVideoStartImage
const IMAGE_TO_VIDEO_MODELS = {
    'VIDEO_ASPECT_RATIO_PORTRAIT': {
        fast: 'veo_3_1_i2v_s_fast_portrait_ultra', // 9:16 - 10 credits, ~120s
        quality: 'veo_3_1_i2v_s_portrait', // 9:16 - 100 credits, ~210s
        lite: 'veo_3_1_i2v_lite', // 9:16 - 5/10 credits, ~110s
        lite_relaxed: 'veo_3_1_i2v_lite_low_priority', // 9:16 - 0 credits, ~110s
    },
    'VIDEO_ASPECT_RATIO_LANDSCAPE': {
        fast: 'veo_3_1_i2v_s_fast_ultra', // 16:9 - 10 credits, ~120s
        quality: 'veo_3_1_i2v_s', // 16:9 - 100 credits, ~210s
        lite: 'veo_3_1_i2v_lite', // 16:9 - 5/10 credits, ~110s
        lite_relaxed: 'veo_3_1_i2v_lite_low_priority', // 16:9 - 0 credits, ~110s
    },
};
// FRAME_TO_FRAME models (VIDEO_MODEL_CAPABILITY_START_IMAGE_AND_END_IMAGE)
// API: batchAsyncGenerateVideoStartAndEndImage
// NOTE: Ultra/Fast/Quality variants use "_fl" suffix; Lite uses the separate
// `veo_3_1_interpolation_lite` key returned by the Flow API.
// NOTE: F2F Ultra fast key suffix is `_ultra_fl` (ultra BEFORE fl), verified
// against the real PRO/Ultra catalog. The previous `_fl_ultra` ordering does
// not exist in Google's catalog; Pro accounts only worked because the
// `_ultra` strip produced a valid key by coincidence. Must stay in sync with
// ULTRA_TO_PRO_KEY below.
const FRAME_TO_FRAME_MODELS = {
    'VIDEO_ASPECT_RATIO_PORTRAIT': {
        fast: 'veo_3_1_i2v_s_fast_portrait_ultra_fl', // 9:16 - 10 credits, ~120s
        quality: 'veo_3_1_i2v_s_portrait_fl', // 9:16 - 100 credits, ~210s
        lite: 'veo_3_1_interpolation_lite', // 9:16 - 5/10 credits, ~110s
        lite_relaxed: 'veo_3_1_interpolation_lite_low_priority', // 9:16 - 0 credits, ~110s
    },
    'VIDEO_ASPECT_RATIO_LANDSCAPE': {
        fast: 'veo_3_1_i2v_s_fast_ultra_fl', // 16:9 - 10 credits, ~120s
        quality: 'veo_3_1_i2v_s_fl', // 16:9 - 100 credits, ~210s
        lite: 'veo_3_1_interpolation_lite', // 16:9 - 5/10 credits, ~110s
        lite_relaxed: 'veo_3_1_interpolation_lite_low_priority', // 16:9 - 0 credits, ~110s
    },
};
// REFERENCE_TO_VIDEO models (VIDEO_MODEL_CAPABILITY_MULTI_REFERENCE_NO_STYLE)
// API: batchAsyncGenerateVideoReferenceImages
// 2026-05-16: Flow API now accepts `veo_3_1_r2v_lite` for both LANDSCAPE and
// PORTRAIT (3 image refs, audio, 8s). Fast [Lower Priority] (*_ultra_relaxed)
// has been removed by Google — `lite_relaxed` is the new free queue tier.
// No Quality model is offered by the API for this mode.
const REFERENCE_TO_VIDEO_MODELS = {
    'VIDEO_ASPECT_RATIO_PORTRAIT': {
        fast: 'veo_3_1_r2v_fast_portrait_ultra', // 9:16 - 10 credits
        lite: 'veo_3_1_r2v_lite', // 9:16 - 5/10 credits, ~110s
        lite_relaxed: 'veo_3_1_r2v_lite_low_priority', // 9:16 - 0 credits, ~110s
    },
    'VIDEO_ASPECT_RATIO_LANDSCAPE': {
        fast: 'veo_3_1_r2v_fast_landscape_ultra', // 16:9 - 10 credits
        lite: 'veo_3_1_r2v_lite', // 16:9 - 5/10 credits, ~110s
        lite_relaxed: 'veo_3_1_r2v_lite_low_priority', // 16:9 - 0 credits, ~110s
    },
};
/**
 * Khoá Fast (Ultra-only) → khoá tài khoản Pro chạy được.
 *
 * Đích là bản **Lite**, KHÔNG phải bản Fast của Pro. Lý do là tiền: trên tài
 * khoản Pro, Fast tính 20 credit/video còn Lite chỉ 10 (xem bảng giá ở
 * getAvailableVideoModels). Tài khoản Pro thường ít credit, nên hạ về Fast-Pro
 * sẽ đốt gấp đôi so với chính mức người dùng nhìn thấy khi chọn model.
 *
 * Dùng bảng tra tường minh thay cho `.replace('_ultra','')`: khoá F2F có đuôi
 * `_ultra_fl` (chữ `_ultra` KHÔNG ở cuối) nên `endsWith('_ultra')` sẽ bỏ sót.
 * Khoá không có trong bảng là bất biến theo tier (lite, quality, Omni Flash,
 * ảnh) và đi thẳng qua. Phải khớp với các mục `fast` của bốn bảng *_MODELS.
 *
 * Khoá Lite không phân biệt khung hình, nên hai tỉ lệ cùng trỏ về một đích.
 */
export const ULTRA_TO_PRO_KEY = {
    veo_3_1_t2v_fast_ultra: 'veo_3_1_t2v_lite',
    veo_3_1_t2v_fast_portrait_ultra: 'veo_3_1_t2v_lite',
    veo_3_1_i2v_s_fast_ultra: 'veo_3_1_i2v_lite',
    veo_3_1_i2v_s_fast_portrait_ultra: 'veo_3_1_i2v_lite',
    veo_3_1_i2v_s_fast_ultra_fl: 'veo_3_1_interpolation_lite',
    veo_3_1_i2v_s_fast_portrait_ultra_fl: 'veo_3_1_interpolation_lite',
    veo_3_1_r2v_fast_landscape_ultra: 'veo_3_1_r2v_lite',
    veo_3_1_r2v_fast_portrait_ultra: 'veo_3_1_r2v_lite',
};
/** Map an Ultra key to its Pro equivalent; pass tier-invariant keys through. */
export function toProModelKey(key) {
    return ULTRA_TO_PRO_KEY[key] ?? key;
}
/**
 * Get available video models for a generation type
 * @param userTier Optional user paygate tier. Affects Lite credit cost (5 for ADVANCED, 10 otherwise).
 */
export function getAvailableVideoModels(generationType, aspectRatio, userTier) {
    if (generationType === 'IMAGE_GENERATION') {
        return []; // Image generation uses different models
    }
    const sunsets = loadSunsets();
    const catalog = getCatalogSnapshot();
    if (catalog) {
        const live = buildLiveVideoModels({ catalog, generationType, aspectRatio, userTier, sunsets });
        if (live.length > 0)
            return live;
    }
    return filterClosed(getStaticVideoModels(generationType, aspectRatio, userTier), sunsets);
}
function filterClosed(models, sunsets) {
    return models.filter((m) => !isClosed(sunsetFor(staticGroupName(m), sunsets)));
}
/** Group name of a static entry, used to apply sunsets when the live catalogue is unavailable. */
function staticGroupName(model) {
    if (model.family === 'omni_flash')
        return model.key === 'macaron_cookie' ? 'Omni 1.2 Flash' : 'Omni 1.1 Flash';
    return model.displayName;
}
/** Offline fallback built from the hard-coded tables (used until the first catalogue fetch succeeds). */
function getStaticVideoModels(generationType, aspectRatio, userTier) {
    const aspectRatioEnum = convertAspectRatioToEnum(aspectRatio);
    const models = [];
    const modelMap = {
        'TEXT_TO_VIDEO': TEXT_TO_VIDEO_MODELS,
        'IMAGE_TO_VIDEO': IMAGE_TO_VIDEO_MODELS,
        'FRAME_TO_FRAME': FRAME_TO_FRAME_MODELS,
        'REFERENCE_TO_VIDEO': REFERENCE_TO_VIDEO_MODELS,
        // Audio mode reuses the r2v model family — every r2v model has outputsAudio=true.
        'REFERENCE_TO_VIDEO_AUDIO': REFERENCE_TO_VIDEO_MODELS,
    }[generationType];
    if (!modelMap || !modelMap[aspectRatioEnum])
        return models;
    const aspectModels = modelMap[aspectRatioEnum];
    // Veo 3.1 Lite — cheapest tier, shown first so users see the low-cost option.
    if (aspectModels.lite) {
        models.push({
            key: aspectModels.lite,
            displayName: 'Veo 3.1 - Lite',
            creditCost: userTier === 'ADVANCED' ? 5 : 10,
            videoLengthSeconds: 8,
            videoGenerationTimeSeconds: 110,
            isRelaxed: false,
            capabilities: ['VIDEO_MODEL_CAPABILITY_AUDIO'],
        });
    }
    // Veo 3.1 Lite [Lower Priority] — free but slower queue
    if (aspectModels.lite_relaxed) {
        models.push({
            key: aspectModels.lite_relaxed,
            displayName: 'Veo 3.1 - Lite [Lower Priority]',
            creditCost: 0,
            videoLengthSeconds: 8,
            videoGenerationTimeSeconds: 110,
            isRelaxed: true,
            capabilities: ['VIDEO_MODEL_CAPABILITY_AUDIO'],
        });
    }
    // Fast / Quality are not listed offline: Google retires both on 2026-12-05 and they were hidden on request.
    // Omni Flash — duration-driven. Only surfaced for the modes it actually supports.
    for (const family of ['macaron_cookie', 'abra']) {
        if (!OMNI_FLASH_SUPPORTED_MODES.includes(generationType))
            continue;
        const spec = OMNI_FAMILIES[family];
        const durations = generationType === 'FRAME_TO_FRAME'
            ? spec.durations.filter((d) => d <= (spec.maxSecondsByPrefix.i2v_fl ?? Infinity))
            : [...spec.durations];
        models.push({
            key: family,
            displayName: family === 'macaron_cookie' ? '⚡ Omni 1.2 Flash' : '⚡ Omni 1.1 Flash',
            creditCost: spec.creditByDuration[8],
            videoLengthSeconds: 8,
            videoGenerationTimeSeconds: 240,
            isRelaxed: false,
            capabilities: ['VIDEO_MODEL_CAPABILITY_AUDIO', 'VIDEO_MODEL_CAPABILITY_DURATION_ADJUSTABLE'],
            family: 'omni_flash',
            availableDurations: durations,
            creditByDuration: Object.fromEntries(durations.map((d) => [d, spec.creditByDuration[d]])),
            supportedModes: [...OMNI_FLASH_SUPPORTED_MODES],
            maxImageInputs: 7,
            maxAudioReferences: 5,
            maxCharacters: 3,
        });
    }
    return models;
}
/**
 * Get available image generation models
 */
export function getAvailableImageModels(userTier) {
    const catalog = getCatalogSnapshot();
    if (catalog) {
        const live = buildLiveImageModels(catalog, userTier);
        if (live.length > 0)
            return live;
    }
    // Offline fallback: the Nano Banana models of the catalogue as of 2026-11-09. Keys go to Google
    // verbatim as `imageModelName`.
    return [
        { key: 'GEM_PIX_2', displayName: '🍌 Nano Banana Pro' },
        { key: 'HARBOR_SEAL', displayName: '🍌 Nano Banana 2 Lite' },
        { key: 'BELUGA', displayName: '🍌 Nano Banana 2.1' },
    ];
}
/**
 * Convert aspect ratio from format (16:9, 1:1, …) to VIDEO enum format.
 * Only 16:9 / 9:16 are valid for video generation; image-only ratios (1:1, 3:4,
 * 4:3) fall back to LANDSCAPE because they must never be passed to the video
 * endpoints — the fallback avoids throwing mid-submit in case of bad input.
 */
export function convertAspectRatioToEnum(aspectRatio) {
    const ratioMap = {
        '16:9': 'VIDEO_ASPECT_RATIO_LANDSCAPE',
        '9:16': 'VIDEO_ASPECT_RATIO_PORTRAIT',
    };
    return ratioMap[aspectRatio] || 'VIDEO_ASPECT_RATIO_LANDSCAPE';
}
/**
 * Convert aspect ratio from enum format (VIDEO_ASPECT_RATIO_LANDSCAPE) to format (16:9)
 */
export function convertAspectRatioFromEnum(aspectRatioEnum) {
    const enumMap = {
        'VIDEO_ASPECT_RATIO_LANDSCAPE': '16:9',
        'VIDEO_ASPECT_RATIO_PORTRAIT': '9:16',
    };
    return enumMap[aspectRatioEnum] || '16:9';
}
/**
 * Convert aspect ratio from format (16:9, 1:1, 3:4, 4:3, 9:16) to IMAGE enum format.
 * Used when submitting image-generation jobs to the Flow API.
 */
export function convertAspectRatioToImageEnum(aspectRatio) {
    const ratioMap = {
        '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
        '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT',
        '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
        '3:4': 'IMAGE_ASPECT_RATIO_PORTRAIT_3_4',
        '4:3': 'IMAGE_ASPECT_RATIO_LANDSCAPE_4_3',
    };
    return ratioMap[aspectRatio] || 'IMAGE_ASPECT_RATIO_LANDSCAPE';
}
/**
 * Get the correct model key for a specific generation type, aspect ratio, and quality.
 * This directly looks up the model from the defined model maps (no string manipulation).
 *
 * Use this when you need to convert a project's model key to the correct model
 * based on the ACTUAL job mode (IMAGE_TO_VIDEO vs FRAME_TO_FRAME).
 *
 * @param generationType - IMAGE_TO_VIDEO or FRAME_TO_FRAME
 * @param aspectRatio - 9:16 or 16:9 (or VIDEO_ASPECT_RATIO_* enum)
 * @param quality - fast, quality, lite, or lite_relaxed
 * @returns The correct model key from the model maps
 */
export function getModelKeyForGenerationType(generationType, aspectRatio, quality = 'fast', duration, family = 'veo_3_1', omniKey) {
    if (family === 'omni_flash') {
        return buildOmniModelKey(omniFamilyOfKey(omniKey) ?? 'abra', generationType, duration, isOmniLowResKey(omniKey));
    }
    // Convert aspect ratio to enum format if needed
    let aspectRatioEnum;
    if (aspectRatio.startsWith('VIDEO_ASPECT_RATIO_')) {
        aspectRatioEnum = aspectRatio;
    }
    else {
        aspectRatioEnum = convertAspectRatioToEnum(aspectRatio);
    }
    const modelMaps = {
        'TEXT_TO_VIDEO': TEXT_TO_VIDEO_MODELS,
        'IMAGE_TO_VIDEO': IMAGE_TO_VIDEO_MODELS,
        'FRAME_TO_FRAME': FRAME_TO_FRAME_MODELS,
        'REFERENCE_TO_VIDEO': REFERENCE_TO_VIDEO_MODELS,
        'REFERENCE_TO_VIDEO_AUDIO': REFERENCE_TO_VIDEO_MODELS,
    };
    const modelMap = modelMaps[generationType];
    if (!modelMap || !modelMap[aspectRatioEnum]) {
        return null;
    }
    return modelMap[aspectRatioEnum][quality] || null;
}
/**
 * Resolve the correct video model key based on generation type, aspect ratio, and quality
 *
 * @param generationType - TEXT_TO_VIDEO, REFERENCE_TO_VIDEO, IMAGE_TO_VIDEO, or FRAME_TO_FRAME
 * @param aspectRatio - 9:16, 16:9, etc. (format) or VIDEO_ASPECT_RATIO_* (enum format)
 * @param quality - fast or quality (default: fast)
 * @returns Object with modelKey and validation result
 */
export function resolveVideoModelKey(generationType, aspectRatio, quality = 'fast', duration, family = 'veo_3_1', omniKey) {
    if (family === 'omni_flash') {
        const omniFamily = omniFamilyOfKey(omniKey) ?? 'abra';
        const modelKey = buildOmniModelKey(omniFamily, generationType, duration, isOmniLowResKey(omniKey));
        if (!modelKey) {
            return {
                modelKey: buildOmniModelKey(omniFamily, 'TEXT_TO_VIDEO', duration) ?? `${omniFamily}_t2v_8s`,
                isValid: false,
                error: `Omni Flash không hỗ trợ mode ${generationType} (chỉ T2V, R2V, I2V, F2F).`,
            };
        }
        logger.info(`[VideoModelResolver] Omni Flash → ${modelKey} (mode=${generationType}, duration=${duration ?? 8}s)`);
        return { modelKey, isValid: true };
    }
    // Convert aspect ratio to enum format if needed
    let aspectRatioEnum;
    if (aspectRatio.startsWith('VIDEO_ASPECT_RATIO_')) {
        aspectRatioEnum = aspectRatio;
    }
    else {
        aspectRatioEnum = convertAspectRatioToEnum(aspectRatio);
    }
    logger.info(`[VideoModelResolver] Resolving model: generationType=${generationType}, aspectRatio=${aspectRatio}, aspectRatioEnum=${aspectRatioEnum}, quality=${quality}`);
    // FRAME_TO_FRAME (start image + end image)
    if (generationType === 'FRAME_TO_FRAME') {
        const modelKey = FRAME_TO_FRAME_MODELS[aspectRatioEnum]?.[quality];
        if (!modelKey) {
            // Fallback to landscape if portrait not available
            const fallbackKey = FRAME_TO_FRAME_MODELS['VIDEO_ASPECT_RATIO_LANDSCAPE']?.[quality];
            if (fallbackKey) {
                return {
                    modelKey: fallbackKey,
                    isValid: false,
                    error: `FRAME_TO_FRAME không hỗ trợ aspect ratio ${aspectRatioEnum}. Sử dụng landscape model.`,
                };
            }
            return {
                modelKey: 'veo_3_1_i2v_s_fast_ultra_fl', // Default fallback (correct API key ordering)
                isValid: false,
                error: `Không tìm thấy model cho FRAME_TO_FRAME với aspect ratio ${aspectRatioEnum}`,
            };
        }
        return {
            modelKey,
            isValid: true,
        };
    }
    // IMAGE_TO_VIDEO (start image only)
    if (generationType === 'IMAGE_TO_VIDEO') {
        const modelKey = IMAGE_TO_VIDEO_MODELS[aspectRatioEnum]?.[quality];
        if (!modelKey) {
            // Fallback to landscape if portrait not available
            const fallbackKey = IMAGE_TO_VIDEO_MODELS['VIDEO_ASPECT_RATIO_LANDSCAPE']?.[quality];
            if (fallbackKey) {
                return {
                    modelKey: fallbackKey,
                    isValid: false,
                    error: `IMAGE_TO_VIDEO không hỗ trợ aspect ratio ${aspectRatioEnum}. Sử dụng landscape model.`,
                };
            }
            return {
                modelKey: 'veo_3_1_i2v_s_fast_ultra', // Default fallback (current API key)
                isValid: false,
                error: `Không tìm thấy model cho IMAGE_TO_VIDEO với aspect ratio ${aspectRatioEnum}`,
            };
        }
        return {
            modelKey,
            isValid: true,
        };
    }
    // REFERENCE_TO_VIDEO - Now supports both landscape and portrait (2026-01-15)
    // REFERENCE_TO_VIDEO_AUDIO reuses the same r2v model family — adds referenceAudio at request time.
    if (generationType === 'REFERENCE_TO_VIDEO' || generationType === 'REFERENCE_TO_VIDEO_AUDIO') {
        const modelKey = REFERENCE_TO_VIDEO_MODELS[aspectRatioEnum]?.[quality];
        if (!modelKey) {
            // Fallback to landscape fast
            const fallbackKey = REFERENCE_TO_VIDEO_MODELS['VIDEO_ASPECT_RATIO_LANDSCAPE']?.fast;
            return {
                modelKey: fallbackKey || 'veo_3_1_r2v_fast_landscape_ultra',
                isValid: false,
                error: `${generationType}: Không tìm thấy model cho quality=${quality}. Sử dụng fast model.`,
            };
        }
        return {
            modelKey,
            isValid: true,
        };
    }
    // TEXT_TO_VIDEO
    logger.info(`[VideoModelResolver] TEXT_TO_VIDEO: Looking for model with aspectRatioEnum=${aspectRatioEnum}, quality=${quality}`);
    logger.info(`[VideoModelResolver] Available TEXT_TO_VIDEO_MODELS keys:`, Object.keys(TEXT_TO_VIDEO_MODELS));
    const modelKey = TEXT_TO_VIDEO_MODELS[aspectRatioEnum]?.[quality];
    logger.info(`[VideoModelResolver] Found modelKey: ${modelKey || 'NOT FOUND'}`);
    if (!modelKey) {
        // Fallback to landscape
        const fallbackKey = TEXT_TO_VIDEO_MODELS['VIDEO_ASPECT_RATIO_LANDSCAPE']?.[quality];
        logger.info(`[VideoModelResolver] Using fallback model: ${fallbackKey || 'veo_3_1_t2v_fast_ultra'}`);
        return {
            modelKey: fallbackKey || 'veo_3_1_t2v_fast_ultra',
            isValid: false,
            error: `Không tìm thấy model cho TEXT_TO_VIDEO với aspect ratio ${aspectRatioEnum}`,
        };
    }
    logger.info(`[VideoModelResolver] Returning modelKey: ${modelKey}`);
    return {
        modelKey,
        isValid: true,
    };
}
/**
 * Validate if a combination of generation type and aspect ratio is supported
 */
export function validateGenerationConfig(generationType, aspectRatio) {
    const resolution = resolveVideoModelKey(generationType, aspectRatio);
    return {
        isValid: resolution.isValid,
        error: resolution.error,
    };
}
/**
 * Get list of supported aspect ratios for a generation type.
 * Video types: 9:16 + 16:9. Image generation: 5 ratios (1:1, 3:4, 4:3, 9:16, 16:9).
 */
export function getSupportedAspectRatios(generationType) {
    if (generationType === 'IMAGE_GENERATION') {
        return ['1:1', '3:4', '4:3', '9:16', '16:9'];
    }
    return ['9:16', '16:9'];
}
/** Catalogue group a model key belongs to: from the live snapshot, else the families we know by name. */
function groupNameOfKey(key) {
    const catalog = getCatalogSnapshot();
    if (catalog) {
        for (const group of catalog.videoGroups) {
            if (group.models.some((m) => m.key === key) || group.groupId === key)
                return group.displayName;
        }
    }
    const family = omniFamilyOfKey(key);
    if (family)
        return family === 'abra' ? 'Omni 1.1 Flash' : 'Omni 1.2 Flash';
    if (/^veo_3_1_.*_fast\b|^veo_3_1_.*_fast_/.test(key))
        return 'Veo 3.1 - Fast';
    return null;
}
/**
 * Throws once a model's retirement day has arrived, so a stale project or an old API client cannot keep
 * submitting to a model Google has closed. No-op for unknown keys and for models without a sunset.
 */
export function assertModelOpen(modelKey, now = Date.now()) {
    if (!modelKey)
        return;
    const group = groupNameOfKey(modelKey);
    if (!group)
        return;
    const sunset = sunsetFor(group, loadSunsets());
    if (!sunset || now < Date.parse(`${sunset.closesOn}T00:00:00Z`))
        return;
    throw new Error(`Model "${group}" đã đóng từ ${sunset.closesOn}. Hãy chọn model khác.`);
}
