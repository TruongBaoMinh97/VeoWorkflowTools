import { logger } from '../lib/logger.js';
// Omni Flash (id: "abra") — single tier, adjustable duration
export const OMNI_FLASH_DURATIONS = [4, 6, 8, 10];
const OMNI_FLASH_CREDIT_BY_DURATION = {
    4: 7, 6: 10, 8: 12, 10: 15,
};
const OMNI_FLASH_SUPPORTED_MODES = [
    'TEXT_TO_VIDEO',
    'REFERENCE_TO_VIDEO',
    'REFERENCE_TO_VIDEO_AUDIO',
    'IMAGE_TO_VIDEO',
    'FRAME_TO_FRAME',
];
// Mode → key prefix. Omni Flash có key start-image (`abra_i2v_*`) nhưng KHÔNG có
// end-image key, nên FRAME_TO_FRAME cũng map về `i2v` — frontend ẩn End Frame để
// job luôn submit dạng start-image only.
const OMNI_FLASH_MODE_PREFIX = {
    TEXT_TO_VIDEO: 't2v',
    REFERENCE_TO_VIDEO: 'r2v',
    REFERENCE_TO_VIDEO_AUDIO: 'r2v',
    IMAGE_TO_VIDEO: 'i2v',
    FRAME_TO_FRAME: 'i2v',
};
export function isOmniFlashKey(key) {
    return !!key && (key === 'abra' || key.startsWith('abra_'));
}
function normalizeOmniFlashDuration(duration) {
    if (duration && OMNI_FLASH_DURATIONS.includes(duration)) {
        return duration;
    }
    return 8;
}
/**
 * Image generation model keys
 */
export const IMAGE_GENERATION_MODELS = {
    GEM_PIX_2: 'GEM_PIX_2', // 🍌 Nano Banana Pro
    BELUGA: 'BELUGA', // 🍌 Nano Banana 2.1
    HARBOR_SEAL: 'HARBOR_SEAL', // 🍌 Nano Banana 2 Lite
};
/**
 * Normalize an image model key from DB / flow-node storage.
 * Removed or unknown keys (e.g. legacy 'R2I', 'IMAGEN_3_5') coerce to 'GEM_PIX_2'
 * so old projects/flows never submit an invalid model to the Flow API.
 */
export function normalizeImageModelKey(key) {
    // Flow replaced Nano Banana 2 (NARWHAL) with Nano Banana 2.1 (BELUGA).
    // Migrate saved workflows instead of silently falling back to Pro.
    if (key === 'NARWHAL')
        return 'BELUGA';
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
    const aspectRatioEnum = convertAspectRatioToEnum(aspectRatio);
    const models = [];
    if (generationType === 'IMAGE_GENERATION') {
        return []; // Image generation uses different models
    }
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
    // Veo 3.1 Fast — Ultra (ADVANCED) bills 10 credits, Pro (INTERMEDIATE/ENTRY)
    // bills 20 (confirmed from the real account catalog creditMapping).
    if (aspectModels.fast) {
        models.push({
            key: aspectModels.fast,
            displayName: 'Veo 3.1 - Fast',
            creditCost: userTier === 'ADVANCED' ? 10 : 20,
            videoLengthSeconds: 8,
            videoGenerationTimeSeconds: generationType === 'TEXT_TO_VIDEO' ? 100 : 120,
            isRelaxed: false,
            capabilities: ['VIDEO_MODEL_CAPABILITY_AUDIO'],
        });
    }
    // Veo 3.1 Quality
    if (aspectModels.quality && aspectModels.quality !== aspectModels.fast) {
        models.push({
            key: aspectModels.quality,
            displayName: 'Veo 3.1 - Quality',
            creditCost: 100,
            videoLengthSeconds: 8,
            videoGenerationTimeSeconds: 210,
            isRelaxed: false,
            capabilities: ['VIDEO_MODEL_CAPABILITY_AUDIO'],
        });
    }
    // Omni Flash — single tier with adjustable duration (4/6/8/10s).
    // Only surfaced for the modes Omni Flash actually supports.
    if (OMNI_FLASH_SUPPORTED_MODES.includes(generationType)) {
        models.push({
            key: 'abra',
            displayName: '⚡ Omni Flash',
            creditCost: OMNI_FLASH_CREDIT_BY_DURATION[8],
            videoLengthSeconds: 8,
            videoGenerationTimeSeconds: 240,
            isRelaxed: false,
            capabilities: ['VIDEO_MODEL_CAPABILITY_AUDIO', 'VIDEO_MODEL_CAPABILITY_DURATION_ADJUSTABLE'],
            family: 'omni_flash',
            availableDurations: [...OMNI_FLASH_DURATIONS],
            creditByDuration: { ...OMNI_FLASH_CREDIT_BY_DURATION },
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
export function getAvailableImageModels() {
    // Đúng 3 model gen ảnh Nano Banana theo catalog thật của Flow API.
    // Key được truyền verbatim tới Google làm `imageModelName` (không có bảng map).
    return [
        { key: 'GEM_PIX_2', displayName: '🍌 Nano Banana Pro' },
        { key: 'BELUGA', displayName: '🍌 Nano Banana 2.1' },
        { key: 'HARBOR_SEAL', displayName: '🍌 Nano Banana 2 Lite' },
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
export function getModelKeyForGenerationType(generationType, aspectRatio, quality = 'fast', duration, family = 'veo_3_1') {
    if (family === 'omni_flash') {
        const prefix = OMNI_FLASH_MODE_PREFIX[generationType];
        if (!prefix)
            return null;
        return `abra_${prefix}_${normalizeOmniFlashDuration(duration)}s`;
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
export function resolveVideoModelKey(generationType, aspectRatio, quality = 'fast', duration, family = 'veo_3_1') {
    if (family === 'omni_flash') {
        const prefix = OMNI_FLASH_MODE_PREFIX[generationType];
        const d = normalizeOmniFlashDuration(duration);
        if (!prefix) {
            return {
                modelKey: `abra_t2v_${d}s`,
                isValid: false,
                error: `Omni Flash không hỗ trợ mode ${generationType} (chỉ T2V, R2V, I2V).`,
            };
        }
        const modelKey = `abra_${prefix}_${d}s`;
        logger.info(`[VideoModelResolver] Omni Flash → ${modelKey} (mode=${generationType}, duration=${d}s)`);
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
