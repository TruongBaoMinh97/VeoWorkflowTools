// @ts-nocheck
/**
 * Veo3 API Service
 * Browser-like request simulation for Veo3 Flow API interaction
 */
import * as fs from "fs";
import * as path from "path";
import { logger, runtimeVerboseLogsEnabled } from "../../lib/logger.js";
import { parseVeo3Error, isNonRetryableError } from "./veo3ErrorHandler.js";
import { isVerificationRejected, verificationRequiredError } from "./verificationFailure.js";
import { cookieTokenService } from "../../lib/cookieTokenService.js";
import { captchaManager } from "../../lib/captchaManager.js";
import { buildProxyUrl } from "../../utils/proxyUtils.js";
import { extractVerifiedBase64Image } from "../../utils/imagePayload.js";
import { extractUUIDFromMediaId, normalizeReferenceImage, } from "../../utils/referenceImage.js";
import { globalProxyManager } from "../../lib/GlobalProxyManager.js";
import { googleFetch } from "./veo3HttpClient.js";
import { callFlowRpc, FlowRpcError, FLOW_RPC, parseCreditsPayload } from "../../lib/flowBoq.js";
import { buildVideoSubmitArgs, buildUpscaleArgs, parseMediaRow, parsePollResponse, parseVideoSubmitResponse, readUploadedImageSize, rememberImageSize, flowVideoModelKeyCandidates, modelKeySlot, acceptedKeyFor, rememberAcceptedKey, upscaledMediaId, upscaleResolutionOf, videoAspectCode, VIDEO_SUBMIT_RPC, } from "./flowVideoGen.js";
import { buildGenerateImageArgs, classifyFlowGenError, classifyImageGenError, parseGenerateImageResponse, resolveAspectCode, UnsupportedFlowImageOptionError, } from "./flowImageGen.js";
import { buildMaseQArgs, detectImageKind, extractUploadedMediaId, flowClientContext, toUploadError, } from "./flowUpload.js";
import { sessionIdManager } from "../../lib/sessionIdManager.js";
import { buildProxyAgents, evictProxyAgent, applyInterProfileJitter, } from "./veo3ProxyManager.js";
import { getHostUa, getHostSecChUa, getHostSecChUaPlatform, } from "../../lib/hostChromeUa.js";
const UPLOAD_IMAGE_TIMEOUT_MS = 120000;
const VIDEO_SUBMIT_TIMEOUT_MS = 120000;
const FLOW_POLL_TIMEOUT_MS = 30000;
/**
 * Decode UUID from CAMa proto-base64 mediaId.
 * mediaId UUID extraction + referenceImages normalization live in a standalone
 * util so they can be unit-tested without dragging in the network/captcha/proxy
 * graph. Re-exported here for the existing call sites (VideoUpsamplingHandler,
 * workflow.engine) that import them from this module.
 */
export { extractUUIDFromMediaId, normalizeReferenceImage };
/**
 * Extracts a meaningful reason string from a Veo3/Flow API error response body.
 * Order: details[].reason (e.g. PUBLIC_ERROR_MODEL_ACCESS_DENIED) → error.message
 * → first 200 chars of raw text. Used to enrich thrown Errors so downstream
 * classifiers (`isNonRetryableError`) can match on reason codes — without this,
 * `response.statusText` from XHR is often empty and the error body is lost.
 */
function extractVeoErrorReason(errorText) {
    if (!errorText)
        return "unknown";
    try {
        const parsed = JSON.parse(errorText);
        const reason = parsed?.error?.details?.[0]?.reason;
        if (typeof reason === "string" && reason)
            return reason;
        const message = parsed?.error?.message;
        if (typeof message === "string" && message)
            return message.slice(0, 200);
    }
    catch {
        // not JSON — fall through
    }
    return errorText.slice(0, 200);
}
function buildVeoApiError(baseMessage, response, errorText) {
    const reason = extractVeoErrorReason(errorText);
    // Tài khoản không đủ gói cho model đã chọn. Gắn sentinel theo đúng quy ước sẵn
    // có (DAILY_QUOTA_REACHED: / QUOTA_UPGRADEABLE: / RESOLUTION_UNAVAILABLE:) để
    // renderer dịch được; mã thô của Google vẫn nằm trong err.errorText cho log.
    const message = reason === "PUBLIC_ERROR_MODEL_ACCESS_DENIED"
        ? "MODEL_ACCESS_DENIED:Tài khoản không dùng được model đã chọn. Đổi sang Lite hoặc Omni Flash để mọi tài khoản chạy được."
        : `${baseMessage}: [${response.status}] ${reason}`;
    const err = new Error(message);
    err.response = response;
    err.errorText = errorText;
    err.status = response.status;
    // Phân loại retry phải dựa trên MÃ THÔ, không dựa vào câu chữ của .message:
    // sentinel ở trên đã thay câu chữ, nên nơi nào còn dò chuỗi trong .message sẽ
    // phân loại nhầm thành "thử lại được" và đốt sạch lượt retry.
    err.isNonRetryable = isNonRetryableError(reason);
    return err;
}
/**
 * Pull the voice catalogue out of the `Zzl0ze` payload.
 *
 * Shape (positional, captured from the live client):
 *   payload[3] = [ [ mediaId, 3, displayName,
 *                    [ mediaId, …9 nulls…, [[ name, description, isPreset, sampleUrl ]] ] ], … ]
 */
export function parseFlowVoicePresets(payload) {
    const entries = Array.isArray(payload) ? payload[3] : null;
    if (!Array.isArray(entries))
        return [];
    const voices = [];
    for (const entry of entries) {
        if (!Array.isArray(entry))
            continue;
        const mediaId = typeof entry[0] === "string" ? entry[0] : "";
        if (!mediaId)
            continue;
        const meta = Array.isArray(entry[3]) ? entry[3][10] : null;
        const detail = Array.isArray(meta) && Array.isArray(meta[0]) ? meta[0] : [];
        const displayName = (typeof detail[0] === "string" && detail[0]) ||
            (typeof entry[2] === "string" ? entry[2] : mediaId);
        voices.push({
            mediaId,
            displayName,
            description: typeof detail[1] === "string" ? detail[1] : "",
            audioSamplePath: typeof detail[3] === "string" ? detail[3] : "",
        });
    }
    return voices;
}
/**
 * Veo3 native voice catalogue, captured from the live Flow client on 2026-09-17.
 *
 * Only a fallback: `listFlowVoicePresets` reads the catalogue from Flow on every
 * call. It is kept accurate (ids, descriptions and sample URLs verbatim from the
 * API) so a failed fetch still gives the picker something real to show — the
 * previous hand-written list carried ids Flow does not have and described some
 * voices as the wrong gender.
 */
const HARDCODED_VEO3_VOICE_PRESETS = [
    {
        mediaId: "achernar",
        displayName: "Achernar",
        description: "Female, soft, high pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Achernar.wav",
    },
    {
        mediaId: "achird",
        displayName: "Achird",
        description: "Male, friendly, mid pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Achird.wav",
    },
    {
        mediaId: "algenib",
        displayName: "Algenib",
        description: "Male, gravelly, low pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Algenib.wav",
    },
    {
        mediaId: "algieba",
        displayName: "Algieba",
        description: "Male, easy-going, mid-low pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Algieba.wav",
    },
    {
        mediaId: "alnilam",
        displayName: "Alnilam",
        description: "Male, firm, mid-low pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Alnilam.wav",
    },
    {
        mediaId: "aoede",
        displayName: "Aoede",
        description: "Female, breezy, mid pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Aoede.wav",
    },
    {
        mediaId: "autonoe",
        displayName: "Autonoe",
        description: "Female, bright, mid pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Autonoe.wav",
    },
    {
        mediaId: "callirrhoe",
        displayName: "Callirrhoe",
        description: "Female, easy-going, mid pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Callirrhoe.wav",
    },
    {
        mediaId: "charon",
        displayName: "Charon",
        description: "Male, informative, lower pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Charon.wav",
    },
    {
        mediaId: "despina",
        displayName: "Despina",
        description: "Female, smooth, mid pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Despina.wav",
    },
    {
        mediaId: "enceladus",
        displayName: "Enceladus",
        description: "Male, breathy, lower pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Enceladus.wav",
    },
    {
        mediaId: "erinome",
        displayName: "Erinome",
        description: "Female, clear, mid pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Erinome.wav",
    },
    {
        mediaId: "fenrir",
        displayName: "Fenrir",
        description: "Male, excitable, younger pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Fenrir.wav",
    },
    {
        mediaId: "gacrux",
        displayName: "Gacrux",
        description: "Female, mature, mid pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Gacrux.wav",
    },
    {
        mediaId: "iapetus",
        displayName: "Iapetus",
        description: "Male, clear, mid-low pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Iapetus.wav",
    },
    {
        mediaId: "kore",
        displayName: "Kore",
        description: "Female, firm, mid pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Kore.wav",
    },
    {
        mediaId: "laomedeia",
        displayName: "Laomedeia",
        description: "Female, upbeat, mid-high pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Laomedeia.wav",
    },
    {
        mediaId: "leda",
        displayName: "Leda",
        description: "Female, youthful, mid-high pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Leda.wav",
    },
    {
        mediaId: "orus",
        displayName: "Orus",
        description: "Male, firm, mid-low pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Orus.wav",
    },
    {
        mediaId: "puck",
        displayName: "Puck",
        description: "Male, upbeat, mid pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Puck.wav",
    },
    {
        mediaId: "pulcherrima",
        displayName: "Pulcherrima",
        description: "Ungendered, forward, mid-high pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Pulcherrima.wav",
    },
    {
        mediaId: "rasalgethi",
        displayName: "Rasalgethi",
        description: "Male, informative, mid pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Rasalgethi.wav",
    },
    {
        mediaId: "sadachbia",
        displayName: "Sadachbia",
        description: "Male, lively, low pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Sadachbia.wav",
    },
    {
        mediaId: "sadaltager",
        displayName: "Sadaltager",
        description: "Male, knowledgeable, mid pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Sadaltager.wav",
    },
    {
        mediaId: "schedar",
        displayName: "Schedar",
        description: "Male, even, mid-low pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Schedar.wav",
    },
    {
        mediaId: "sulafat",
        displayName: "Sulafat",
        description: "Female, warm, mid pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Sulafat.wav",
    },
    {
        mediaId: "umbriel",
        displayName: "Umbriel",
        description: "Male, smooth, lower pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Umbriel.wav",
    },
    {
        mediaId: "vindemiatrix",
        displayName: "Vindemiatrix",
        description: "Female, gentle, mid pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Vindemiatrix.wav",
    },
    {
        mediaId: "zephyr",
        displayName: "Zephyr",
        description: "Female, bright, mid-high pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Zephyr.wav",
    },
    {
        mediaId: "zubenelgenubi",
        displayName: "Zubenelgenubi",
        description: "Male, casual, mid-low pitch",
        audioSamplePath: "https://gstatic.com/aitestkitchen/voices/samples/Zubenelgenubi.wav",
    },
];
/**
 * Đọc lý do hỏng thật từ `mediaMetadata.mediaStatus`. Google trả `failureReasons` (MẢNG);
 * `failureReason` số ít chỉ còn để phòng shape cũ.
 */
function readMediaFailureMessage(mediaStatus) {
    const reasons = mediaStatus?.failureReasons;
    return (mediaStatus?.error?.message ||
        (Array.isArray(reasons) && reasons.length ? reasons.join(", ") : null) ||
        mediaStatus?.failureReason ||
        null);
}
/**
 * Veo3 API Service Class
 */
export class Veo3Service {
    constructor(config = {}) {
        this.baseUrl = "https://labs.google/fx/api/trpc";
        this.sandboxBaseUrl = "https://aisandbox-pa.googleapis.com/v1";
        // Default browser headers — version derived from host Chrome (VEO3_CHROME_FULL/MAJOR env).
        this.defaultHeaders = {
            "User-Agent": getHostUa(),
            "sec-ch-ua": getHostSecChUa(),
            "sec-ch-ua-platform": getHostSecChUaPlatform(),
            "sec-ch-ua-mobile": "?0",
            "content-type": "application/json",
        };
        this.config = {
            userAgent: this.defaultHeaders["User-Agent"],
            ...config,
        };
    }
    /**
     * Update configuration
     */
    updateConfig(config) {
        this.config = { ...this.config, ...config };
        // Prefer global rotating proxy when enabled; fall back to per-profile static.
        const globalProxyUrl = globalProxyManager.isEnabled()
            ? globalProxyManager.getCurrentHttpProxyUrl()
            : null;
        if (this.config.proxyConfig || globalProxyUrl) {
            const proxyUrl = globalProxyUrl || buildProxyUrl(this.config.proxyConfig);
            if (proxyUrl) {
                // Only rebuild log khi proxy URL thực sự đổi. Trước đây mỗi updateConfig
                // đều log "Activated proxy agent" → spam + rò dispatcher. Giờ reuse cache.
                const previousProxyUrl = this.config.__activeProxyUrl;
                const isNewProxy = previousProxyUrl !== proxyUrl;
                if (previousProxyUrl && isNewProxy) {
                    // Proxy thực sự rotate → evict old pair để tránh leak
                    evictProxyAgent(previousProxyUrl);
                }
                const pair = buildProxyAgents(proxyUrl);
                if (pair) {
                    this.config.agent = pair.dispatcher;
                    this.config.httpAgent = pair.httpAgent;
                    this.config.__activeProxyUrl = proxyUrl;
                    if (isNewProxy) {
                        const origin = globalProxyUrl
                            ? "global-rotating"
                            : `${this.config.proxyConfig?.proxyHost}:${this.config.proxyConfig?.proxyPort}`;
                        logger.info(`[Veo3Service] Activated proxy for profile ${this.config.profileId} (${origin})`);
                    }
                }
                else {
                    logger.warn(`[Veo3Service] Failed to build proxy agent pair — no proxy will be used`);
                    this.config.agent = undefined;
                    this.config.httpAgent = undefined;
                    this.config.__activeProxyUrl = undefined;
                }
            }
            else {
                logger.warn(`[Veo3Service] Invalid proxy config for profile ${this.config.profileId} — no agent set`);
                this.config.agent = undefined;
                this.config.httpAgent = undefined;
                this.config.__activeProxyUrl = undefined;
            }
        }
        else if (config.proxyConfig === null) {
            const previousProxyUrl = this.config.__activeProxyUrl;
            if (previousProxyUrl)
                evictProxyAgent(previousProxyUrl);
            this.config.agent = undefined;
            this.config.__activeProxyUrl = undefined;
        }
    }
    /**
     * Refresh access token from cookies using /api/auth/session
     * Uses cookieTokenService to handle different cookie formats (JSON array, header string, etc.)
     * @returns New access token
     */
    async refreshAccessTokenFromCookies() {
        if (!this.config.cookies) {
            throw new Error("No cookies available to refresh access token");
        }
        // Clear cache before refreshing to force getting a fresh token from cookies
        // This is important because cached token might be expired on Google's side
        // even though our TTL hasn't expired yet
        if (this.config.profileId) {
            cookieTokenService.clearCache(this.config.profileId);
            logger.info(`🗑️  [Token Refresh] Cleared cached token for profile ${this.config.profileId} to force fresh token`);
        }
        // Use cookieTokenService which handles different cookie formats (JSON array, header string, etc.)
        // This ensures compatibility with any changes in how cookies are extracted from browser
        const { accessToken } = await cookieTokenService.getAccessTokenFromCookies(this.config.cookies, this.config.profileId, this.config.userAgent);
        if (!accessToken) {
            throw new Error("No access_token returned from cookieTokenService");
        }
        // Update config with new token
        this.updateConfig({ accessToken });
        return accessToken;
    }
    /**
     * Check if error is an authentication error (401/403)
     * NOTE: 403 with PUBLIC_ERROR_MODEL_ACCESS_DENIED is NOT an auth error —
     * it means the account lacks permission for this model. Token refresh won't help.
     */
    isAuthError(response, errorText) {
        if (response.status === 401) {
            return true;
        }
        if (response.status === 403) {
            // MODEL_ACCESS_DENIED = account doesn't have access to this model, not an auth issue
            if (errorText && errorText.includes("PUBLIC_ERROR_MODEL_ACCESS_DENIED")) {
                return false;
            }
            // UNUSUAL_ACTIVITY = reCAPTCHA score too low, not auth. Token refresh won't help —
            // browser session needs to be reset (force recreate) to improve score.
            if (errorText && errorText.includes("PUBLIC_ERROR_UNUSUAL_ACTIVITY")) {
                return false;
            }
            if (errorText && errorText.includes("reCAPTCHA evaluation failed")) {
                return false;
            }
            return true;
        }
        // Check error message for UNAUTHORIZED
        if (errorText) {
            try {
                const errorJson = JSON.parse(errorText);
                if (errorJson.error?.json?.message === "UNAUTHORIZED" ||
                    errorJson.error?.json?.code === -32001) {
                    return true;
                }
            }
            catch (e) {
                // Not JSON, check text
                if (errorText.includes("UNAUTHORIZED") ||
                    errorText.includes("unauthorized")) {
                    return true;
                }
            }
        }
        return false;
    }
    /**
     * Mint N fresh reCAPTCHA Enterprise tokens by calling the user's Chrome
     * extension (via captchaManager) sequentially. Each token is single-use
     * and action-bound: reusing or mixing actions trips PUBLIC_ERROR_UNUSUAL_ACTIVITY.
     *
     * Throughput is bounded by Google's reCAPTCHA SDK (~1-3s/mint), not by
     * our parallelism — the extension serialises mints inside one Flow tab.
     *
     * @param action 'IMAGE_GENERATION' or 'VIDEO_GENERATION' (must match endpoint kind)
     * @param count number of tokens (1..N)
     */
    async requestRecaptchaTokens(action, count) {
        const requestId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const startTime = Date.now();
        const tokens = [];
        try {
            // todo update logic gen capcha
            for (let i = 0; i < count; i++) {
                const result = await captchaManager.requestToken(action);
                if (!result.token || result.token.trim().length === 0) {
                    throw new Error(`Batch token ${i + 1}/${count} returned empty`);
                }
                tokens.push(result.token);
            }
            const elapsed = Date.now() - startTime;
            logger.info(`✅ [reCAPTCHA Batch] [${requestId}] Done`, {
                received: tokens.length,
                requested: count,
                elapsedMs: elapsed,
                avgMsPerToken: Math.round(elapsed / Math.max(tokens.length, 1)),
            });
            return tokens;
        }
        catch (error) {
            logger.error(`❌ [reCAPTCHA Batch] [${requestId}] Failed:`, error);
            throw new Error(`Failed to obtain ${count} reCAPTCHA tokens: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Execute API call with automatic token refresh on auth errors
     * @param apiCall - Function that makes the API call
     * @param retryOnAuthError - Whether to retry once after refreshing token (default: true)
     */
    async executeWithTokenRefresh(apiCall, retryOnAuthError = true) {
        await applyInterProfileJitter();
        try {
            return await apiCall();
        }
        catch (error) {
            // Check if it's an auth error and we have cookies to refresh
            if (isVerificationRejected(error)) {
                logger.warn('[Flow] Verification rejected; waiting for user verification on Google Flow.');
                throw verificationRequiredError(error);
            }
            if (retryOnAuthError && this.config.cookies && error?.response) {
                const response = error.response;
                const errorText = error.errorText || "";
                // Check if this is reCAPTCHA evaluation failure (different from auth error)
                const { isRecaptchaEvaluationFailure } = await import("./veo3ErrorHandler.js");
                const isRecaptchaFailure = isRecaptchaEvaluationFailure(errorText);
                if (isRecaptchaFailure) {
                    // reCAPTCHA evaluation failed - this is NOT an auth error
                    // Don't try to refresh access token, just throw with friendly message
                    logger.error("❌ [reCAPTCHA] Google rejected reCAPTCHA token - will retry with delay");
                    const { parseVeo3Error } = await import("./veo3ErrorHandler.js");
                    const friendlyMessage = parseVeo3Error(errorText, "reCAPTCHA evaluation failed");
                    const error = new Error(friendlyMessage);
                    error.response = response;
                    error.errorText = errorText;
                    error.isRecaptchaFailure = true; // Mark for special retry logic
                    throw error;
                }
                if (this.isAuthError(response, errorText)) {
                    logger.info("🔄 [Token Refresh] Access token expired, refreshing from cookies...", {
                        status: response.status,
                        hasCookies: !!this.config.cookies,
                        cookiesLength: this.config.cookies?.length || 0,
                    });
                    try {
                        const newToken = await this.refreshAccessTokenFromCookies();
                        logger.info("✅ [Token Refresh] Access token refreshed successfully, retrying API call...", {
                            newTokenLength: newToken?.length || 0,
                            newTokenPrefix: newToken?.substring(0, 20) || "N/A",
                        });
                        // Update token in database if callback is provided
                        if (this.config.onTokenRefreshed) {
                            try {
                                await this.config.onTokenRefreshed(newToken);
                                logger.info("✅ Access token updated in database");
                            }
                            catch (dbError) {
                                logger.error("⚠️ Failed to update token in database:", dbError);
                                // Don't throw - token refresh was successful, just DB update failed
                            }
                        }
                        // Retry the API call once with new token
                        try {
                            return await apiCall();
                        }
                        catch (retryError) {
                            if (isVerificationRejected(retryError))
                                throw verificationRequiredError(retryError);
                            const retryErrorText = retryError?.errorText || "";
                            // Check if retry error is reCAPTCHA failure (NOT an auth error)
                            const { isRecaptchaEvaluationFailure } = await import("./veo3ErrorHandler.js");
                            const isRetryRecaptchaFailure = isRecaptchaEvaluationFailure(retryErrorText);
                            if (isRetryRecaptchaFailure) {
                                // reCAPTCHA evaluation failed on retry - this is NOT cookies expired
                                logger.error("❌ [reCAPTCHA] Google rejected reCAPTCHA token on retry - will retry with delay");
                                const { parseVeo3Error } = await import("./veo3ErrorHandler.js");
                                const friendlyMessage = parseVeo3Error(retryErrorText, "reCAPTCHA evaluation failed");
                                const error = new Error(friendlyMessage);
                                error.response = retryError.response;
                                error.errorText = retryErrorText;
                                error.isRecaptchaFailure = true; // Mark for special retry logic
                                throw error;
                            }
                            // If retry still fails with 401, it might be:
                            // 1. Token is valid but doesn't have permission for this resource
                            // 2. Resource doesn't exist (e.g., mediaId not in project)
                            // 3. Cookies are invalid/expired (token refresh worked but token itself is invalid)
                            const isStillAuthError = retryError?.response?.status === 401 ||
                                retryError?.response?.status === 403;
                            if (isStillAuthError) {
                                logger.error("❌ API call failed after token refresh:", {
                                    status: retryError?.response?.status,
                                    errorText: retryErrorText.substring(0, 200),
                                });
                                throw new Error("Access token đã được refresh nhưng vẫn không có quyền truy cập. Có thể resource không tồn tại hoặc cookies đã hết hạn. Vui lòng cập nhật cookies trong Profile Manager.");
                            }
                            // Non-auth error, rethrow as-is
                            throw retryError;
                        }
                    }
                    catch (refreshError) {
                        if (isVerificationRejected(refreshError))
                            throw verificationRequiredError(refreshError);
                        logger.error("❌ Failed to refresh access token:", refreshError);
                        throw new Error("Access token đã hết hạn và không thể refresh từ cookies. Vui lòng cập nhật cookies trong Profile Manager.");
                    }
                }
            }
            throw error;
        }
    }
    /**
     * Headers for TRPC API requests. Issued via the tlsClient Chrome 131 PSK
     * profile — User-Agent, Cookie, sec-ch-ua*, sec-fetch-* must align with the
     * fingerprint or reCAPTCHA Enterprise scoring will downgrade the call.
     */
    getTrpcHeaders() {
        const locale = this.config.locale || "vi";
        const acceptLanguage = locale === "vi"
            ? "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7"
            : "en-US,en;q=0.9";
        const defaultReferer = this.config.veo3ProjectId
            ? `https://labs.google/fx/${locale}/tools/flow/project/${this.config.veo3ProjectId}`
            : `https://labs.google/fx/${locale}/tools/flow`;
        const headers = {
            accept: "*/*",
            "accept-language": acceptLanguage,
            "content-type": "application/json",
            origin: "https://labs.google",
            priority: "u=1, i",
            referer: this.config.referer || defaultReferer,
        };
        // Match the Chrome that minted the reCAPTCHA token (extension content
        // script in real Chrome) — see getSandboxHeaders for the full rationale.
        // TRPC endpoints are same-origin (labs.google → labs.google) so they
        // tolerate UA mismatches better than sandbox, but consistency across the
        // call surface avoids subtle fingerprint drift on auth/session refresh.
        if (this.config.userAgent) {
            headers["User-Agent"] = this.config.userAgent;
        }
        if (this.config.accessToken) {
            headers["Authorization"] = `Bearer ${this.config.accessToken}`;
        }
        return headers;
    }
    /**
     * Headers for Google AI Sandbox API requests. Same browser-owned-headers
     * policy as getTrpcHeaders.
     *
     * CRITICAL: User-Agent must match the Chrome that minted the reCAPTCHA token.
     * In the single-shared-browser model the user-installed Chrome extension
     * mints inside the user's real Chrome (whatever version they have). Our
     * submit Node lane should declare a sec-ch-ua close to that — but since
     * we no longer know the master Chrome's exact version, we fall back to a
     * stable UA in veo3HttpClient.deriveChromeMajor / deriveSecChUa when the
     * caller doesn't pass one. Score is typically fine because the action
     * + IP + token signature dominate, not the sec-ch-ua minor mismatch.
     *
     * Referer is intentionally set to the labs.google root (matches real Chrome
     * captures of manual gen — Chrome strips the path on cross-origin POST to
     * googleapis.com, leaving only the origin). Earlier code sent the full
     * project-page URL which Google's reCAPTCHA pipeline flagged as a
     * non-browser submission.
     */
    getSandboxHeaders(contentType = "text/plain") {
        const locale = this.config.locale || "vi";
        const acceptLanguage = locale === "vi"
            ? "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7"
            : "en-US,en;q=0.9";
        const headers = {
            accept: "*/*",
            "accept-language": acceptLanguage,
            "Content-Type": contentType === "application/json"
                ? "application/json"
                : "text/plain;charset=UTF-8",
            origin: "https://labs.google",
            priority: "u=1, i",
            Referer: "https://labs.google/",
        };
        if (this.config.userAgent) {
            headers["User-Agent"] = this.config.userAgent;
        }
        if (this.config.accessToken) {
            headers["Authorization"] = `Bearer ${this.config.accessToken}`;
        }
        return headers;
    }
    /**
     * ✅ Get access token từ session
     * GET /api/auth/session
     *
     * Lấy access token từ session hiện tại. API này cần cookies từ browser session.
     * Thường được gọi từ browser context với cookies đã được set.
     *
     * @returns Session info bao gồm access_token, user info, và expires time
     */
    async getSession() {
        const url = "https://labs.google/fx/api/auth/session";
        const response = await googleFetch({
            profileId: this.config.profileId,
            veo3ProjectId: this.config.veo3ProjectId,
            locale: this.config.locale,
            url,
            method: "GET",
            headers: this.getTrpcHeaders(),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to get session: ${response.statusText} - ${errorText}`);
        }
        return await response.json();
    }
    /**
     * ✅ Get Credits and Paygate Tier (Flow BOQ `nzlxg`)
     */
    async getCredits() {
        // aisandbox-pa /credits needs the ya29 Bearer, whose source (labs auth/session)
        // answers 410. Flow's own `nzlxg` RPC returns the same numbers with cookies only.
        const profileId = this.config.profileId;
        if (!profileId)
            throw new Error("Thiếu profileId — không thể lấy credits từ Flow");
        const payload = await callFlowRpc(profileId, FLOW_RPC.credits, [], {
            userAgent: this.config.userAgent,
        });
        return parseCreditsPayload(payload);
    }
    /**
     * Create a Flow project.
     *
     * Runs on the flow.google.com BOQ transport: Google disabled the labs.google
     * tRPC `project.createProject` in Sept 2026 ("Flow RPCs have been deprecated
     * and disabled"). This lane authenticates with the profile's Google cookies,
     * not the ya29 Bearer, so there is no token-refresh retry here — a failure
     * means the profile is signed out of Flow, which only a re-login fixes.
     *
     * @returns the new project's UUID and the display name Flow echoed back
     */
    async createProject(projectTitle, toolName = "PINHOLE") {
        const profileId = this.config.profileId;
        if (!profileId) {
            throw new Error("Thiếu profileId — không thể tạo project trên Flow");
        }
        // The BOQ args carry the product as an undocumented enum, so only the tool
        // that enum was captured for can be honoured. Say so rather than silently
        // creating a Flow project for a caller that asked for something else.
        if (toolName !== Veo3Service.FLOW_PRODUCT_TOOL) {
            throw new Error(`Flow BOQ chỉ hỗ trợ tool "${Veo3Service.FLOW_PRODUCT_TOOL}", không tạo được project cho "${toolName}"`);
        }
        logger.info(`🔹 [Veo3Service] Creating Flow project "${projectTitle}"`, {
            profileId: profileId.substring(0, 8),
            toolName,
        });
        const payload = await callFlowRpc(profileId, FLOW_RPC.createProject, [
            "projects/*",
            [null, [projectTitle]],
            [null, Veo3Service.FLOW_PRODUCT_SLOT],
        ], { userAgent: this.config.userAgent });
        if (!Array.isArray(payload) || typeof payload[0] !== "string") {
            throw new Error(`Flow trả về dữ liệu tạo project không hợp lệ: ${JSON.stringify(payload).slice(0, 200)}`);
        }
        const projectId = payload[0];
        if (!Veo3Service.UUID_PATTERN.test(projectId)) {
            throw new Error(`Flow trả về projectId không đúng định dạng UUID: ${projectId}`);
        }
        const echoedTitle = Array.isArray(payload[1])
            ? String(payload[1][0] ?? projectTitle)
            : projectTitle;
        logger.info(`✅ [Veo3Service] Flow project created: ${projectId}`);
        return { projectId, projectTitle: echoedTitle };
    }
    /**
     * ✅ Helper: Create project và trả về projectId
     * Wrapper method để dễ sử dụng hơn
     */
    async createProjectAndGetId(projectTitle, toolName = "PINHOLE") {
        const { projectId } = await this.createProject(projectTitle, toolName);
        return projectId;
    }
    /**
     * Fetch the list of preset audio voices ("externalReferenceMedia" with
     * mediaType=AUDIO) attached to a Veo3 project.
     *
     * Endpoint: `GET /api/trpc/flow.projectInitialData?input={"json":{"projectId":"<veo3ProjectId>"}}`
     *
     * The voice list is the same across all Veo3 projects of an account, but
     * Flow only exposes it through the per-project initial-data call. We
     * fetch with profile cookies + access token and parse the
     * `externalReferenceMedia` array. Each entry's `mediaId` (e.g.
     * `"achernar"`) is what gets passed back to Veo's video reference API
     * as `referenceAudio[].mediaId` — see `GenerateVideoReferenceImagesRequest`.
     *
     * @param veo3ProjectId Project id used to anchor the request URL/referer.
     *                      Caller must have already populated `config.cookies`
     *                      and/or `config.accessToken` for this profile.
     */
    async listFlowVoicePresets(veo3ProjectId) {
        // Flow rejects a malformed project path outright; catch it here so the error
        // names the caller's bad input instead of surfacing as an opaque RPC failure.
        if (!veo3ProjectId || !Veo3Service.UUID_PATTERN.test(veo3ProjectId)) {
            const err = new Error(`Invalid veo3ProjectId for voice presets: "${veo3ProjectId}"`);
            err.isVoicePresetUnavailable = true;
            throw err;
        }
        const profileId = this.config.profileId;
        if (!profileId) {
            logger.warn("[Voice Presets] thiếu profileId — dùng danh sách dự phòng");
            return HARDCODED_VEO3_VOICE_PRESETS;
        }
        let payload;
        try {
            payload = await callFlowRpc(profileId, FLOW_RPC.projectData, [`projects/${veo3ProjectId}`, null, null, null, [1]], {
                userAgent: this.config.userAgent,
                sourcePath: `/project/${veo3ProjectId}`,
            });
        }
        catch (error) {
            // Being signed out is the one case the fallback cannot paper over: the
            // user has to act, and every other Flow call will fail too.
            if (error?.code === "FLOW_SIGNED_OUT")
                throw error;
            logger.warn(`⚠️ [Voice Presets] không lấy được danh sách từ Flow (${error?.message ?? error}) — dùng danh sách dự phòng`, { veo3ProjectId, profileId });
            return HARDCODED_VEO3_VOICE_PRESETS;
        }
        const voices = parseFlowVoicePresets(payload);
        if (voices.length === 0) {
            logger.warn("[Voice Presets] Flow trả về danh sách rỗng — dùng danh sách dự phòng", { veo3ProjectId });
            return HARDCODED_VEO3_VOICE_PRESETS;
        }
        logger.info(`🔊 [Voice Presets] ${voices.length} giọng từ Flow`);
        return voices;
    }
    /**
     * Shared submit for the four generation modes. One reCAPTCHA token per request (single
     * use, so a retry inside `callFlowRpc` mints a new one); requests go out one after
     * another like the web client's.
     */
    async submitVideoViaFlow(mode, request, onRecaptchaComplete, onSubmitFired) {
        const profileId = this.config.profileId;
        if (!profileId)
            throw new Error("Thiếu profileId — không thể gen video trên Flow");
        const projectId = request.clientContext?.projectId;
        if (!projectId)
            throw new Error("Thiếu Veo3 projectId — không thể gen video trên Flow");
        // reCAPTCHA is bound to the project page the browser loads.
        this.updateConfig({ veo3ProjectId: projectId });
        const count = request.requests.length;
        const tokens = await this.requestRecaptchaTokens("VIDEO_GENERATION", count);
        if (tokens.length < count) {
            throw new Error(`Batch tokens insufficient for video: got ${tokens.length}, need ${count}`);
        }
        if (onRecaptchaComplete) {
            try {
                await onRecaptchaComplete();
            }
            catch (_) {
                /* non-blocking */
            }
        }
        const operations = [];
        for (let i = 0; i < count; i++) {
            const item = request.requests[i];
            const prompt = item.textInput.prompt ?? (item.textInput.structuredPrompt?.parts ?? []).map((p) => p.text).join("");
            const aspectCode = videoAspectCode(item.aspectRatio);
            const slot = modelKeySlot(mode, item.videoModelKey);
            const remembered = acceptedKeyFor(slot);
            const candidates = remembered
                ? [{ key: remembered, verified: true }]
                : flowVideoModelKeyCandidates({ legacyKey: item.videoModelKey, mode });
            // A key Flow does not know is refused with INVALID_ARGUMENT before anything is
            // charged, so walk the candidates; every attempt needs its own single-use token.
            let payload;
            let usedKey = candidates[0].key;
            for (let c = 0; c < candidates.length; c++) {
                const { key, verified } = candidates[c];
                usedKey = key;
                if (!verified)
                    logger.warn(`[Video] thử khoá model ${key} (từ ${item.videoModelKey}) — chưa kiểm chứng với Flow`);
                // The pre-minted token serves the very first send only; every later send needs a new one.
                let premintConsumed = c > 0;
                const buildArgs = async () => {
                    const recaptchaToken = premintConsumed ? (await this.requestRecaptchaTokens("VIDEO_GENERATION", 1))[0] : tokens[i];
                    premintConsumed = true;
                    return buildVideoSubmitArgs({
                        mode,
                        projectId,
                        prompt,
                        modelKey: key,
                        aspectCode,
                        recaptchaToken,
                        startMediaId: item.startImage ? extractUUIDFromMediaId(item.startImage.mediaId) : undefined,
                        endMediaId: item.endImage ? extractUUIDFromMediaId(item.endImage.mediaId) : undefined,
                        referenceMediaIds: item.referenceImages?.map((r) => extractUUIDFromMediaId(r.mediaId)),
                        referenceAudioIds: item.referenceAudio?.map((a) => a.mediaId),
                    });
                };
                if (i === 0 && c === 0)
                    onSubmitFired?.();
                try {
                    payload = await callFlowRpc(profileId, VIDEO_SUBMIT_RPC[mode], buildArgs, {
                        userAgent: this.config.userAgent,
                        sourcePath: `/project/${projectId}`,
                        timeoutMs: VIDEO_SUBMIT_TIMEOUT_MS,
                    });
                    break;
                }
                catch (err) {
                    // 3 = INVALID_ARGUMENT, 5 = NOT_FOUND: both are how Flow refuses an unknown model key.
                    const rejectedKey = err instanceof FlowRpcError && (err.status === 3 || err.status === 5) && c < candidates.length - 1;
                    if (rejectedKey) {
                        logger.warn(`[Video] Flow từ chối khoá ${key} (mã ${err.status}) — thử khoá kế tiếp`);
                        continue;
                    }
                    const classified = classifyFlowGenError(err);
                    logger.error(`❌ [Video] ${mode} request ${i + 1}/${count} lỗi: ${classified?.message ?? classified}`, {
                        model: key,
                        project: projectId,
                    });
                    throw classified;
                }
            }
            rememberAcceptedKey(slot, usedKey);
            const parsed = parseVideoSubmitResponse(payload);
            if (parsed.operations.length === 0) {
                throw new Error(`Flow không trả operation cho video: ${JSON.stringify(payload)?.slice(0, 160)}`);
            }
            const sceneId = item.metadata?.sceneId ?? "";
            operations.push(...this.convertMediaArrayToSubmitOperations(parsed.operations.map((o) => ({ name: o.operationId, projectId, workflowId: o.workflowId })), sceneId));
        }
        return { operations };
    }
    /**
     * Submit video generation (text-to-video) through Flow's `generateVideoText` batchexecute rpc
     * (cookie-authenticated; aisandbox-pa and its Bearer are gone).
     *
     * @returns operations to poll — same shape the queue already consumes
     */
    async batchAsyncGenerateVideoText(request, onRecaptchaComplete, onSubmitFired) {
        return this.submitVideoViaFlow("t2v", request, onRecaptchaComplete, onSubmitFired);
    }
    /**
     * Submit video generation (reference-to-video) through Flow's `generateVideoReferences` batchexecute rpc
     * (cookie-authenticated; aisandbox-pa and its Bearer are gone).
     *
     * @returns operations to poll — same shape the queue already consumes
     */
    async batchAsyncGenerateVideoReferenceImages(request, onRecaptchaComplete, onSubmitFired) {
        return this.submitVideoViaFlow("r2v", request, onRecaptchaComplete, onSubmitFired);
    }
    /**
     * Submit video generation (image-to-video) through Flow's `generateVideoStartImage` batchexecute rpc
     * (cookie-authenticated; aisandbox-pa and its Bearer are gone).
     *
     * @returns operations to poll — same shape the queue already consumes
     */
    async batchAsyncGenerateVideoStartImage(request, onRecaptchaComplete, onSubmitFired) {
        return this.submitVideoViaFlow("i2v", request, onRecaptchaComplete, onSubmitFired);
    }
    /**
     * Upscale a generated video to 1080p or 4K through Flow's `p0UkFb` rpc (cookie-authenticated).
     * 1080p costs nothing on Ultra, 4K costs 50 credits. The upscaled copy gets the id
     * `<source>_upsampled` / `<source>_4k_upsampled` and is polled like any other media.
     *
     * @returns operations to poll
     */
    async batchAsyncGenerateVideoUpsampleVideo(request) {
        const profileId = this.config.profileId;
        if (!profileId)
            throw new Error("Thiếu profileId — không thể upscale video trên Flow");
        const projectId = request.clientContext?.projectId ?? this.config.veo3ProjectId;
        if (!projectId)
            throw new Error("Thiếu Veo3 projectId — không thể upscale video trên Flow");
        this.updateConfig({ veo3ProjectId: projectId });
        const count = request.requests.length;
        const tokens = await this.requestRecaptchaTokens("VIDEO_GENERATION", count);
        if (tokens.length < count) {
            throw new Error(`Batch tokens insufficient for upscale: got ${tokens.length}, need ${count}`);
        }
        const operations = [];
        for (let i = 0; i < count; i++) {
            const item = request.requests[i];
            const workflowId = item.metadata?.workflowId;
            if (!workflowId) {
                throw new Error("Upscale video cần metadata.workflowId của video nguồn (Flow không nhận sceneId).");
            }
            const resolution = upscaleResolutionOf(item.resolution, item.videoModelKey);
            const sourceMediaId = extractUUIDFromMediaId(item.videoInput.mediaId);
            // The upscale must carry the SOURCE video's aspect. Flow does not cross-check it, so a
            // wrong value (e.g. the project setting changed after the video was made) yields a
            // stretched output. Ask the media itself; fall back to the request only if that fails.
            const sourceAspect = await this.readSourceAspect(profileId, sourceMediaId);
            const requestedAspect = (() => {
                try {
                    return videoAspectCode(item.aspectRatio);
                }
                catch {
                    return undefined;
                }
            })();
            if (sourceAspect && requestedAspect && sourceAspect !== requestedAspect) {
                logger.warn(`[Upscale] tỉ lệ yêu cầu (${requestedAspect}) khác tỉ lệ video nguồn (${sourceAspect}) — dùng tỉ lệ của video nguồn`, { sourceMediaId });
            }
            const aspectCode = sourceAspect ?? requestedAspect ?? 2;
            let firstAttempt = true;
            const buildArgs = async () => {
                const recaptchaToken = firstAttempt
                    ? tokens[i]
                    : (await this.requestRecaptchaTokens("VIDEO_GENERATION", 1))[0];
                firstAttempt = false;
                return buildUpscaleArgs({ projectId, sourceMediaId, workflowId, resolution, aspectCode, recaptchaToken });
            };
            let payload;
            try {
                payload = await callFlowRpc(profileId, FLOW_RPC.upsampleVideo, buildArgs, {
                    userAgent: this.config.userAgent,
                    sourcePath: `/project/${projectId}`,
                    timeoutMs: VIDEO_SUBMIT_TIMEOUT_MS,
                });
            }
            catch (err) {
                const classified = classifyFlowGenError(err);
                logger.error(`❌ [Upscale] video ${resolution} lỗi: ${classified?.message ?? classified}`, { projectId });
                throw classified;
            }
            const parsed = parseVideoSubmitResponse(payload);
            const op = parsed.operations[0] ?? { operationId: upscaledMediaId(sourceMediaId, resolution), workflowId };
            operations.push(...this.convertMediaArrayToSubmitOperations([{ name: op.operationId, projectId, workflowId: op.workflowId ?? workflowId }], item.metadata?.sceneId ?? ""));
        }
        return { operations };
    }
    /**
     * ✅ API: Upsample Image to 2K/4K
     * POST /v1/flow/upsampleImage
     *
     * @param mediaId - The mediaId of the image to upsample (CAMSJ... or similar)
     * @param targetResolution - UPSAMPLE_IMAGE_RESOLUTION_2K or UPSAMPLE_IMAGE_RESOLUTION_4K
     * @param projectId - The project ID (UUID format) required for clientContext
     */
    async upsampleImage(mediaId, targetResolution, projectId,
    // Optional account tier. googleFetch strips cookies for all googleapis.com
    // cross-origin calls, so Google cannot infer the tier from the session. Ultra
    // accounts (PAYGATE_TIER_TWO) must pass it explicitly or Google gates output
    // to free-tier quality (watermarked / blurred). genNormal omits it because
    // standard (PAYGATE_TIER_ONE) accounts observe no difference.
    userPaygateTier) {
        // ⚠️ Sync veo3ProjectId vào config trước khi gọi reCAPTCHA
        if (projectId) {
            this.updateConfig({ veo3ProjectId: projectId });
        }
        return this.executeWithTokenRefresh(async () => {
            const url = `${this.sandboxBaseUrl}/flow/upsampleImage`;
            // ⚠️ Google binds action ↔ endpoint: upsampleImage là image op → phải dùng
            // IMAGE_GENERATION. Dùng VIDEO_GENERATION → PUBLIC_ERROR_UNUSUAL_ACTIVITY 403.
            // ⚠️ Token single-use: Google ghi nhận token ngay khi BOQ chạm server, kể cả
            // lúc BOQ lỗi. Nên mint riêng cho từng lượt gọi thay vì dùng chung một token.
            const mintRecaptchaToken = async () => {
                const [token] = await this.requestRecaptchaTokens("IMAGE_GENERATION", 1);
                return token;
            };
            // Mode code: 1 = 2K, 2 = 4K (observed in BOQ SPrCad RPC)
            const modeCode = targetResolution.includes("4K") ? 2 : 1;
            // 1. Primary: Try new BOQ RPC (SPrCad) if profileId is available
            let boqFailure = null;
            if (this.config.profileId) {
                // Mint NGOÀI try: cầu captcha hỏng là lỗi riêng, đừng ghi nhầm thành
                // "BOQ RPC failed" rồi đẩy tiếp sang REST (REST cũng cần token).
                const boqRecaptchaToken = await mintRecaptchaToken();
                try {
                    logger.info(`📤 [API Monitor] Submitting image upsampling request via BOQ RPC (SPrCad)`);
                    logger.info(`   🖼️ Media ID: ${mediaId.substring(0, 30)}...`);
                    logger.info(`   📏 Resolution: ${targetResolution} (modeCode=${modeCode})`);
                    const boqArgs = [
                        mediaId,
                        modeCode,
                        flowClientContext(projectId, boqRecaptchaToken),
                    ];
                    const boqResult = await callFlowRpc(this.config.profileId, FLOW_RPC.upsampleImage, boqArgs, {
                        userAgent: this.config.userAgent,
                        sourcePath: `/project/${projectId}`,
                    });
                    logger.info(`✅ [API Monitor] Image upsampling BOQ RPC (SPrCad) succeeded!`);
                    // ⚠️ Nhận dạng ảnh bằng MAGIC BYTES, không bằng độ dài chuỗi.
                    // Phản hồi SPrCad có vọng lại prompt gốc; heuristic cũ ("chuỗi đầu
                    // tiên dài > 500 ký tự") trả về prompt, rồi caller base64-decode nó
                    // thành vài trăm byte rác và ghi đè lên ảnh thật. Đo trên máy thật:
                    // prompt 1009 ký tự → 621 byte rác, 9 ảnh ra 9 file giống hệt nhau.
                    const verified = extractVerifiedBase64Image(boqResult);
                    if (verified) {
                        logger.info(`🖼️ [API Monitor] Ảnh upscale hợp lệ (${verified.buf.length} byte, ${verified.mime})`);
                        // verifiedBuf/ext đi kèm để handler khỏi giải mã lại payload vài MB.
                        return {
                            encodedImage: verified.base64,
                            verifiedBuf: verified.buf,
                            ext: verified.ext,
                            raw: boqResult,
                        };
                    }
                    logger.error(`❌ [API Monitor] Phản hồi BOQ không chứa ảnh hợp lệ: ${JSON.stringify(boqResult).slice(0, 400)}`);
                    const corrupt = new Error("UPSCALE_CORRUPT_PAYLOAD: Máy chủ trả về dữ liệu không phải ảnh — bỏ qua để giữ nguyên ảnh gốc.");
                    corrupt.isCorruptPayload = true;
                    throw corrupt;
                }
                catch (boqErr) {
                    // RPC gọi được nhưng nội dung sai kiểu KHÔNG phải lỗi truyền tải —
                    // REST không chữa được vấn đề ngữ nghĩa, mà mỗi lần thử lại đều tốn
                    // một token reCAPTCHA và một lượt gọi API (đã trừ credit). Ném tiếp.
                    if (boqErr?.isCorruptPayload)
                        throw boqErr;
                    boqFailure = boqErr;
                    logger.warn(`⚠️ [API Monitor] BOQ RPC (SPrCad) failed (${boqErr?.message || String(boqErr)}), falling back to REST endpoint...`);
                }
            }
            // The REST fallback still belongs to the retired Bearer lane. When no
            // cached legacy token exists, preserve the real BOQ error instead of
            // masking it with an impossible "access token required" recovery.
            if (!this.config.accessToken) {
                if (boqFailure)
                    throw boqFailure;
                const retired = new Error('Google đã tắt access token cũ; không thể dùng REST fallback cho upscale ảnh.');
                retired.code = 'FLOW_AUTH_RETIRED';
                throw retired;
            }
            // 2. Fallback: REST endpoint /flow/upsampleImage
            const restRecaptchaToken = await mintRecaptchaToken();
            const requestBody = {
                mediaId: mediaId,
                targetResolution: targetResolution,
                clientContext: {
                    recaptchaContext: {
                        token: restRecaptchaToken,
                        applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB",
                    },
                    sessionId: this.config.profileId
                        ? sessionIdManager.get(this.config.profileId, projectId)
                        : `;${Date.now()}`,
                    projectId: projectId,
                    tool: "PINHOLE",
                    ...(userPaygateTier ? { userPaygateTier } : {}),
                },
            };
            logger.info(`📤 [API Monitor] Submitting image upsampling request via REST fallback`);
            logger.info(`   🔗 URL: ${url}`);
            logger.info(`   🖼️ Media ID: ${mediaId.substring(0, 30)}...`);
            logger.info(`   📏 Resolution: ${targetResolution}`);
            // 4K upsampling: Google processes ~10-30s + response body ~11MB → dùng 120s timeout
            const UPSAMPLE_TIMEOUT_MS = 120000;
            const upsampleXhrPromise = googleFetch({
                profileId: this.config.profileId,
                veo3ProjectId: this.config.veo3ProjectId,
                locale: this.config.locale,
                url,
                method: "POST",
                // Real web app posts JSON as text/plain;charset=UTF-8 (set by
                // getSandboxHeaders("text/plain")) — not application/json.
                headers: this.getSandboxHeaders("text/plain"),
                body: JSON.stringify(requestBody),
                timeoutMs: UPSAMPLE_TIMEOUT_MS,
                // Keep submit -> clr in the same page execution block to avoid
                // out-of-band reset races on the wire.
            });
            const response = await upsampleXhrPromise;
            if (runtimeVerboseLogsEnabled()) {
                logger.info(`📥 [API Monitor] Response status: ${response.status} ${response.statusText}`);
            }
            if (!response.ok) {
                const errorText = await response.text();
                const isRecaptcha403 = response.status === 403 &&
                    (errorText.includes("PUBLIC_ERROR_UNUSUAL_ACTIVITY") ||
                        errorText.includes("reCAPTCHA evaluation failed"));
                if (isRecaptcha403) {
                    logger.warn(`⚠️ [API Monitor] 403 reCAPTCHA (silent retry)`);
                }
                else {
                    logger.error(`❌ [API Monitor] API Error: ${response.status} - ${errorText.substring(0, 500)}`);
                }
                if (isRecaptcha403) {
                    const error = new Error(`reCAPTCHA bị Google từ chối (Mã 403): Browser session score thấp. Profile sẽ được reset và thử lại.`);
                    error.response = response;
                    error.errorText = errorText;
                    error.isRecaptchaFailure = true;
                    throw error;
                }
                if (this.isAuthError(response, errorText)) {
                    const error = new Error("Access token đã hết hạn hoặc không hợp lệ.");
                    error.response = response;
                    error.errorText = errorText;
                    throw error;
                }
                const { parseVeo3Error } = await import("./veo3ErrorHandler.js");
                const friendlyMessage = parseVeo3Error(errorText, `Failed to upsample image: ${response.statusText}`);
                const error = new Error(friendlyMessage);
                error.response = response;
                error.errorText = errorText;
                throw error;
            }
            const responseData = await response.json();
            logger.info(`✅ [API Monitor] Image upsampling request submitted successfully!`);
            // Assuming response contains operations or similar, consistent with other APIs
            // Based on curl, it returns operation object directly or similar structure?
            // "operations": [ { "name": "operations/..." } ]
            // Let's log it to be sure
            logger.info(`   📦 Response data keys: ${Object.keys(responseData).join(", ")}`);
            return responseData;
        });
    }
    /**
     * Reference images for characters: `outputs` images of one prompt, each with its own seed,
     * generated through the same Flow rpc as {@link generateBatchImages}.
     */
    async generateCharacterImages(options) {
        const outputs = Math.min(Math.max(options.outputs ?? 1, 1), 4);
        const seeds = options.seeds && options.seeds.length >= outputs
            ? options.seeds.slice(0, outputs)
            : Array.from({ length: outputs }, () => Math.floor(Math.random() * 1000000000));
        return this.generateBatchImages({
            projectId: options.projectId,
            imageModelName: options.imageModelName,
            imageAspectRatio: options.imageAspectRatio,
            timeoutMs: options.timeoutMs,
            onSubmitFired: options.onSubmitFired,
            prompts: seeds.map((seed) => ({
                prompt: options.prompt,
                seed,
                referenceImageMediaIds: options.referenceImageMediaIds,
                imageInputType: options.imageInputType,
            })),
        });
    }
    /**
     * Generate images with DIFFERENT prompts in parallel (max 20).
     *
     * Runs on Flow's `ogiZ0b` batchexecute RPC — cookie-authenticated, synchronous, and
     * answers with the finished image URL. The old aisandbox-pa `batchGenerateImages`
     * needed a ya29 Bearer that can no longer be issued (labs auth/session answers 410).
     * One reCAPTCHA token per prompt; the token is single-use, so a request that fails
     * after it was spent is surfaced as retryable instead of being re-sent inline.
     */
    async generateBatchImages(options) {
        const profileId = this.config.profileId;
        if (!profileId)
            throw new Error("Thiếu profileId — không thể gen ảnh trên Flow");
        // ⚠️ Sync veo3ProjectId vào config trước khi gọi reCAPTCHA — bắt buộc để Google
        // bind được action ↔ project page.
        if (options.projectId) {
            this.updateConfig({ veo3ProjectId: options.projectId });
        }
        const maxBatchSize = 20;
        if (options.prompts.length > maxBatchSize) {
            throw new Error(`Batch size exceeds maximum of ${maxBatchSize} prompts. Got ${options.prompts.length}`);
        }
        if (options.prompts.length === 0)
            return [];
        // Only the plain "reference" input type was captured (flag 1); editing a base image
        // (IMAGE_INPUT_TYPE_BASE_IMAGE) has no known code yet.
        if (options.prompts.some((p) => (p.referenceImageMediaIds?.length ?? 0) > 0 &&
            p.imageInputType === "IMAGE_INPUT_TYPE_BASE_IMAGE")) {
            throw new UnsupportedFlowImageOptionError("Sửa ảnh gốc (BASE_IMAGE) chưa hỗ trợ trên Flow mới — mới bắt được ảnh tham chiếu thường.");
        }
        const aspectRatio = options.imageAspectRatio || "IMAGE_ASPECT_RATIO_LANDSCAPE";
        const aspect = resolveAspectCode(aspectRatio);
        if (!aspect.verified) {
            logger.warn(`[Batch Images] mã tỉ lệ ${aspectRatio} (=${aspect.code}) chưa được kiểm chứng với Flow`);
        }
        const promptCount = options.prompts.length;
        const tokens = await this.requestRecaptchaTokens("IMAGE_GENERATION", promptCount);
        if (tokens.length < promptCount) {
            throw new Error(`Batch tokens insufficient: got ${tokens.length}, need ${promptCount}`);
        }
        if (options.onRecaptchaComplete) {
            try {
                await options.onRecaptchaComplete();
            }
            catch (_) {
                /* non-blocking */
            }
        }
        const timeoutMs = options.timeoutMs ?? (Number(process.env.IMAGE_GEN_TIMEOUT_MS) || 240000);
        const sourcePath = `/project/${options.projectId}`;
        const generateOne = async (promptConfig, index) => {
            const seed = promptConfig.seed ?? Math.floor(Math.random() * 1000000000);
            const startedAt = Date.now();
            // Args are rebuilt per attempt: callFlowRpc re-runs them if it re-bootstraps the
            // session, and a reCAPTCHA token must never be sent twice.
            let firstAttempt = true;
            const buildArgs = async () => {
                const recaptchaToken = firstAttempt
                    ? tokens[index]
                    : (await this.requestRecaptchaTokens("IMAGE_GENERATION", 1))[0];
                firstAttempt = false;
                return buildGenerateImageArgs({
                    projectId: options.projectId,
                    prompt: promptConfig.prompt,
                    seed,
                    aspectCode: aspect.code,
                    imageModelName: options.imageModelName,
                    recaptchaToken,
                    referenceMediaIds: promptConfig.referenceImageMediaIds?.map(extractUUIDFromMediaId),
                });
            };
            // Fired at SUBMIT-START so the inter-batch delay counts from submit.
            if (index === 0)
                options.onSubmitFired?.();
            let payload;
            try {
                payload = await callFlowRpc(profileId, FLOW_RPC.generateImage, buildArgs, {
                    userAgent: this.config.userAgent,
                    sourcePath,
                    timeoutMs,
                });
            }
            catch (err) {
                const classified = classifyImageGenError(err);
                logger.error(`❌ [Batch Images] Set #${index} ogiZ0b lỗi: ${classified?.message ?? classified}`, { project: options.projectId, model: options.imageModelName, aspect: aspectRatio, seed });
                throw classified;
            }
            const result = parseGenerateImageResponse(payload, {
                promptIndex: index,
                imageModelName: options.imageModelName,
                aspectRatio,
            });
            return result;
        };
        logger.info(`🚀 [Batch Images] Gen ${promptCount} ảnh qua Flow ogiZ0b...`);
        const settled = await Promise.allSettled(options.prompts.map(generateOne));
        const results = [];
        let firstError = null;
        for (const outcome of settled) {
            if (outcome.status === "fulfilled")
                results.push(outcome.value);
            else if (!firstError)
                firstError = outcome.reason;
        }
        // Same contract as before: all-or-nothing — the caller requeues the whole burst.
        if (firstError)
            throw firstError;
        logger.info(`✅ [Batch Images] ${results.length} ảnh đã xong.`);
        return results;
    }
    /**
     * Submit video generation (frame-to-frame) through Flow's `generateVideoStartAndEndImage` batchexecute rpc
     * (cookie-authenticated; aisandbox-pa and its Bearer are gone).
     *
     * @returns operations to poll — same shape the queue already consumes
     */
    async batchAsyncGenerateVideoStartAndEndImage(request, onRecaptchaComplete, onSubmitFired) {
        return this.submitVideoViaFlow("f2f", request, onRecaptchaComplete, onSubmitFired);
    }
    /**
     * Convert Veo 3.1 SUBMIT response shape `{media:[{name, projectId, workflowId,...}]}`
     * sang legacy `operations[{sceneId, status, operation:{name, metadata:{...}}}]` shape.
     *
     * Submit-side: mỗi request chỉ gửi 1 reqItem → 1 `ourSceneId`. Khác poll-side
     * (N requests → N name→sceneId map → dùng `convertMediaArrayToPollOperations`).
     *
     * Pattern lấy từ inline converter cũ ở r2v submit — extract DRY để áp dụng cho
     * t2v / i2v / f2f / upsample (các mode lite tier Google trả `{media:[...]}` thay
     * vì `{operations:[...]}`).
     *
     * Giữ extras `__mediaName / __projectId / __workflowId` cho upstream queue manager
     * lưu `flowWorkflowId` (cần cho upsample request sau này — xem
     * genNormalQueueManager.ts xử lý workflowId).
     */
    convertMediaArrayToSubmitOperations(mediaArr, ourSceneId) {
        return mediaArr.map((m) => {
            const mediaStatus = m?.mediaMetadata?.mediaStatus?.mediaGenerationStatus ||
                "MEDIA_GENERATION_STATUS_SCHEDULED";
            return {
                sceneId: ourSceneId,
                status: mediaStatus,
                operation: {
                    name: m.name,
                    metadata: {
                        name: m.name,
                        video: {
                            mediaGenerationId: m.name,
                            fifeUrl: m?.video?.fifeUrl ?? null,
                        },
                    },
                },
                __mediaName: m.name,
                __projectId: m.projectId,
                __workflowId: m.workflowId,
            };
        });
    }
    /**
     * Convert Veo 3.1 `{media:[...]}` response shape into legacy `{operations:[...]}`
     * shape so downstream poll consumers (`processVideoStatusResult`,
     * `processUpsamplingStatusResult`) không phải biết về shape mới.
     *
     * @param mediaArr      `responseData.media` array từ Google response
     * @param nameToSceneId Map: `media.name` (UUID Google sinh) → `sceneId` mình gửi
     *                      (giúp upstream `sceneIdToJob` matching vẫn work)
     */
    convertMediaArrayToPollOperations(mediaArr, nameToSceneId) {
        return mediaArr.map((m) => {
            const mediaStatus = m?.mediaMetadata?.mediaStatus?.mediaGenerationStatus ||
                "MEDIA_GENERATION_STATUS_ACTIVE";
            const errorMessage = readMediaFailureMessage(m?.mediaMetadata?.mediaStatus);
            // Try multiple known field paths for the playable URL. Google's
            // SUCCESSFUL r2v response sometimes lacks fifeUrl right after status
            // flips — fall back to any known URL location.
            const fifeUrl = m?.video?.fifeUrl ||
                m?.video?.generatedVideo?.fifeUrl ||
                m?.video?.signedUri ||
                m?.video?.videoUrl ||
                m?.video?.servingUrl ||
                m?.video?.downloadUrl ||
                m?.video?.generatedVideo?.signedUri ||
                m?.video?.generatedVideo?.videoUrl ||
                m?.video?.generatedVideo?.servingUrl ||
                m?.video?.generatedVideo?.downloadUrl ||
                null;
            if (mediaStatus === "MEDIA_GENERATION_STATUS_SUCCESSFUL" && !fifeUrl) {
                logger.debug(`[Poll Status:media] ${String(m.name).substring(0, 8)}… SUCCESSFUL chưa kèm URL — sẽ resolve qua getMediaUrlRedirect`);
            }
            return {
                sceneId: nameToSceneId.get(m.name) || "",
                status: mediaStatus,
                operation: {
                    name: m?.video?.operation?.name || m.name,
                    metadata: {
                        name: m.name,
                        video: {
                            mediaGenerationId: m.name,
                            fifeUrl,
                            error: errorMessage ? { message: errorMessage } : undefined,
                        },
                    },
                },
            };
        });
    }
    /**
     * Check the state of generation operations (video, upscale) through Flow's `jwpduf`
     * poll rpc; a finished media's URL is read with `getMedia`.
     */
    async batchCheckAsyncVideoGenerationStatus(request) {
        const items = request.operations.map((op) => ({
            name: op.operation.name,
            sceneId: String(op.sceneId || ""),
        }));
        return this.pollFlowOperations(items);
    }
    /** Media-shape poll used by Veo 3.1 jobs; identical on Flow's rpc (the id is all it needs). */
    async batchCheckMediaGenerationStatus(items) {
        return this.pollFlowOperations(items.map((it) => ({ name: it.name, sceneId: it.sceneId })));
    }
    async pollFlowOperations(items) {
        if (items.length === 0)
            return { operations: [] };
        const profileId = this.config.profileId;
        if (!profileId)
            throw new Error("Thiếu profileId — không thể kiểm tra trạng thái video trên Flow");
        const states = await Promise.all(items.map((it) => this.readFlowMediaState(profileId, it.name)));
        const mediaArr = states.map((state, i) => ({
            name: items[i].name,
            mediaMetadata: { mediaStatus: { mediaGenerationStatus: state?.status ?? "MEDIA_GENERATION_STATUS_PENDING" } },
            video: { fifeUrl: state?.videoUrl ?? null },
        }));
        const nameToSceneId = new Map(items.filter((it) => it.sceneId).map((it) => [it.name, it.sceneId]));
        const operations = this.convertMediaArrayToPollOperations(mediaArr, nameToSceneId);
        operations.forEach((op, i) => {
            const error = states[i]?.error;
            if (error && op.operation?.metadata?.video)
                op.operation.metadata.video.error = { message: error };
        });
        return { operations };
    }
    /** One media's state via `jwpduf`; a finished one without a URL is completed from `getMedia`. */
    async readFlowMediaState(profileId, mediaId) {
        const callOpts = { userAgent: this.config.userAgent, sourcePath: this.flowSourcePath(), timeoutMs: FLOW_POLL_TIMEOUT_MS };
        const payload = await callFlowRpc(profileId, FLOW_RPC.pollVideo, [null, null, [[mediaId]]], callOpts);
        const rows = parsePollResponse(payload);
        const state = rows.find((r) => r.operationId === mediaId) ?? rows[0] ?? null;
        if (state && state.status === "MEDIA_GENERATION_STATUS_SUCCESSFUL" && !state.videoUrl) {
            const media = parseMediaRow(await callFlowRpc(profileId, FLOW_RPC.getMedia, [mediaId], callOpts));
            if (media?.videoUrl)
                state.videoUrl = media.videoUrl;
        }
        return state;
    }
    /** Aspect code (1 = 9:16, 2 = 16:9) of an existing media, read from Flow; undefined when unknown. */
    async readSourceAspect(profileId, mediaId) {
        try {
            const row = parseMediaRow(await callFlowRpc(profileId, FLOW_RPC.getMedia, [mediaId], {
                userAgent: this.config.userAgent,
                sourcePath: this.flowSourcePath(),
                timeoutMs: FLOW_POLL_TIMEOUT_MS,
            }));
            return row?.aspectCode;
        }
        catch (err) {
            logger.warn(`[Upscale] không đọc được tỉ lệ video nguồn ${mediaId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
            return undefined;
        }
    }
    flowSourcePath() {
        return this.config.veo3ProjectId ? `/project/${this.config.veo3ProjectId}` : "/";
    }
    async getMediaUrlRedirect(mediaId) {
        const profileId = this.config.profileId;
        if (!mediaId || !profileId)
            return null;
        try {
            const row = parseMediaRow(await callFlowRpc(profileId, FLOW_RPC.getMedia, [mediaId], {
                userAgent: this.config.userAgent,
                sourcePath: this.flowSourcePath(),
                timeoutMs: FLOW_POLL_TIMEOUT_MS,
            }));
            // Video rows carry a status code and a video url; image rows have neither a status
            // nor a video, only their own signed image url.
            return (row?.statusCode === undefined ? row?.thumbnailUrl : row?.videoUrl) ?? null;
        }
        catch (err) {
            logger.warn(`[getMediaUrlRedirect] getMedia lỗi cho ${mediaId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
            return null;
        }
    }
    /**
     * ✅ Helper: Poll video status và trả về status + videoUrl
     * Wrapper method để dễ sử dụng hơn
     */
    async pollVideoStatus(operationName, sceneId) {
        if (runtimeVerboseLogsEnabled()) {
            logger.info(`🔍 [Poll Status] Checking status for operation: ${operationName.substring(0, 20)}..., sceneId: ${sceneId} (type: ${typeof sceneId})`);
        }
        const results = await this.pollVideoStatuses([{ operationName, sceneId }]);
        if (results.length === 0) {
            throw new Error("No operation returned from status check");
        }
        const result = results[0];
        if (runtimeVerboseLogsEnabled()) {
            logger.info(`📊 [Poll Status] Result:`, {
                status: result.status,
                hasVideoUrl: !!result.videoUrl,
                hasMediaId: !!result.mediaId,
                hasError: !!result.error,
                error: result.error,
            });
        }
        return result;
    }
    /**
     * Poll multiple video statuses at once (operations array)
     */
    async pollVideoStatuses(operations) {
        if (operations.length === 0) {
            return [];
        }
        // Veo 3.1 (useV2ModelConfig) jobs store a media UUID as the operation name and
        // MUST be polled via the media-shape endpoint `{media:[{name, projectId}]}` —
        // sending that UUID to the legacy `{operations:[...]}` endpoint 400s. Callers
        // that supply a projectId per op (workflow engine) opt into the media poll;
        // its response is normalized back to the same `{operations:[...]}` shape, so
        // the parsing below is identical for both. Callers without projectId keep the
        // legacy endpoint (still correct for legacy operation names).
        const useMediaShape = operations.every((op) => !!op.projectId);
        const response = useMediaShape
            ? await this.batchCheckMediaGenerationStatus(operations.map((op) => ({
                name: op.operationName,
                projectId: op.projectId,
                sceneId: String(op.sceneId || op.operationName),
            })))
            : await this.batchCheckAsyncVideoGenerationStatus({
                operations: operations.map((op) => ({
                    operation: { name: op.operationName },
                    // Veo3 API requires sceneId to be a STRING for status check as well
                    sceneId: String(op.sceneId || ""),
                    // Must send ACTIVE status for videos that are still being processed
                    status: "MEDIA_GENERATION_STATUS_ACTIVE",
                })),
            });
        if (!response.operations || response.operations.length === 0) {
            logger.error(`❌ [API Monitor] No operation returned from status check`);
            throw new Error("No operation returned from status check");
        }
        const results = [];
        for (const operation of response.operations) {
            const name = operation.operation?.name;
            if (!name) {
                continue;
            }
            const match = operations.find((op) => op.operationName === name);
            const videoUrl = this.extractVideoUrlFromOperation(operation);
            const mediaId = this.extractMediaIdFromOperation(operation);
            // sceneId from response can be number or string, convert to string for consistency
            const responseSceneId = operation.sceneId
                ? String(operation.sceneId)
                : match?.sceneId
                    ? String(match.sceneId)
                    : "";
            // Log status for all operations
            if (runtimeVerboseLogsEnabled()) {
                logger.info(`📊 [Poll Status] Operation: ${name.substring(0, 30)}...`, {
                    status: operation.status,
                    sceneId: responseSceneId,
                    sceneIdType: typeof operation.sceneId,
                    hasVideoUrl: !!videoUrl,
                    hasMediaId: !!mediaId,
                });
            }
            if (operation.status === "MEDIA_GENERATION_STATUS_SUCCESSFUL") {
                if (videoUrl) {
                    logger.info(`🎉 [API Monitor] Status: ${operation.status} for ${name.substring(0, 50)}...`);
                    if (runtimeVerboseLogsEnabled()) {
                        logger.info(`   🎬 URL: ${videoUrl.substring(0, 100)}...`);
                    }
                }
                else {
                    logger.warn(`❌ [API Monitor] SUCCESSFUL but no video URL for ${name.substring(0, 50)}...`);
                    if (runtimeVerboseLogsEnabled()) {
                        logger.info(`   📋 Operation:`, JSON.stringify(operation, null, 2));
                    }
                }
            }
            else if (operation.status === "MEDIA_GENERATION_STATUS_FAILED") {
                // Extract error details from operation
                const operationAny = operation?.operation;
                let errorMessage = "Video generation failed";
                // DEBUG: Log full operation object to find error structure
                if (runtimeVerboseLogsEnabled()) {
                    logger.error(`\n🔍 [DEBUG FAILED] Full operation object for ${name.substring(0, 30)}...:`);
                    logger.error(JSON.stringify(operation, null, 2));
                }
                // Try to extract error from various possible locations
                const errorPaths = [
                    () => operationAny?.error?.message,
                    () => operationAny?.error?.error?.message,
                    () => operationAny?.response?.error?.message,
                    () => operationAny?.metadata?.error?.message,
                    () => operationAny?.metadata?.failureReason,
                    () => operationAny?.result?.error?.message,
                    () => operation.error?.message,
                    () => operation.error,
                    () => operation.failureReason,
                    () => operation.errorDetails,
                ];
                for (const getError of errorPaths) {
                    try {
                        const err = getError();
                        if (err && typeof err === "string" && err.trim().length > 0) {
                            errorMessage = err;
                            break;
                        }
                    }
                    catch {
                        // ignore
                    }
                }
                // Format error message: remove escape sequences and extract key information
                let formattedError = errorMessage;
                try {
                    // Remove escape sequences
                    formattedError = formattedError
                        .replace(/\\n/g, "\n")
                        .replace(/\\'/g, "'")
                        .replace(/\\"/g, '"')
                        .replace(/\\\\/g, "\\");
                    // Try to extract a more user-friendly message
                    // Look for patterns like "I'm sorry" or "cannot fulfill" which indicate Gemini rejection
                    const geminiRejectionMatch = formattedError.match(/I['"]m sorry[^"]*"([^"]+)"/);
                    if (geminiRejectionMatch && geminiRejectionMatch[1]) {
                        formattedError = `Prompt không khớp với hình ảnh: ${geminiRejectionMatch[1]}`;
                    }
                    else {
                        // Extract the main error reason
                        const mainErrorMatch = formattedError.match(/message:\s*"([^"]+)"/);
                        if (mainErrorMatch && mainErrorMatch[1]) {
                            const mainMsg = mainErrorMatch[1]
                                .replace(/\\n/g, " ")
                                .replace(/\\'/g, "'")
                                .substring(0, 200); // Limit length
                            formattedError = mainMsg;
                        }
                        else {
                            // Fallback: take first 200 chars
                            formattedError = formattedError.substring(0, 200);
                        }
                    }
                }
                catch {
                    // If formatting fails, use original but limit length
                    formattedError = errorMessage.substring(0, 200);
                }
                logger.error(`\n❌ [API Monitor] Status: ${operation.status} for ${name.substring(0, 50)}...`);
                logger.error(`   📋 Error (formatted): ${formattedError}`);
                if (runtimeVerboseLogsEnabled()) {
                    logger.error(`   📋 Error (raw, first 500 chars): ${errorMessage.substring(0, 500)}...`);
                }
                // sceneId from response can be number or string, convert to string for consistency
                const resultSceneId = operation.sceneId
                    ? String(operation.sceneId)
                    : match?.sceneId
                        ? String(match.sceneId)
                        : "";
                results.push({
                    operationName: name,
                    sceneId: resultSceneId,
                    status: operation.status,
                    videoUrl,
                    mediaId: mediaId || undefined,
                    remainingCredits: response.remainingCredits,
                    error: formattedError, // Use formatted error instead of raw
                });
                continue;
            }
            // sceneId from response can be number or string, convert to string for consistency
            const resultSceneId = operation.sceneId
                ? String(operation.sceneId)
                : match?.sceneId
                    ? String(match.sceneId)
                    : "";
            results.push({
                operationName: name,
                sceneId: resultSceneId,
                status: operation.status,
                videoUrl,
                mediaId: mediaId || undefined,
                remainingCredits: response.remainingCredits,
            });
        }
        return results;
    }
    extractVideoUrlFromOperation(operation) {
        const operationAny = operation?.operation;
        const possiblePaths = [
            () => operation.operation?.metadata?.video?.fifeUrl,
            () => operationAny?.metadata?.video?.videoUrl,
            () => operationAny?.metadata?.video?.url,
            () => operationAny?.response?.video?.fifeUrl,
            () => operationAny?.response?.video?.videoUrl,
            () => operationAny?.response?.video?.url,
            () => operationAny?.metadata?.fifeUrl,
            () => operationAny?.metadata?.videoUrl,
            () => operationAny?.response?.fifeUrl,
            () => operationAny?.response?.videoUrl,
            () => operationAny?.result?.video?.fifeUrl,
            () => operationAny?.result?.video?.videoUrl,
            () => operationAny?.result?.fifeUrl,
            () => operationAny?.result?.videoUrl,
            () => operationAny?.metadata?.result?.video?.fifeUrl,
            () => operationAny?.metadata?.result?.video?.videoUrl,
            () => operationAny?.response?.result?.video?.fifeUrl,
            () => operationAny?.response?.result?.video?.videoUrl,
        ];
        for (let i = 0; i < possiblePaths.length; i++) {
            try {
                const url = possiblePaths[i]();
                if (url && typeof url === "string" && url.trim().length > 0) {
                    return url;
                }
            }
            catch {
                // ignore missing paths
            }
        }
        return null;
    }
    /**
     * Extract mediaId (name) from operation response
     * MediaId is in operation.operation.metadata.name
     */
    extractMediaIdFromOperation(operation) {
        const operationAny = operation?.operation;
        const possiblePaths = [
            () => operation.operation?.metadata?.name,
            () => operationAny?.metadata?.name,
            () => operationAny?.name,
        ];
        for (let i = 0; i < possiblePaths.length; i++) {
            try {
                const mediaId = possiblePaths[i]();
                if (mediaId &&
                    typeof mediaId === "string" &&
                    mediaId.trim().length > 0) {
                    return mediaId;
                }
            }
            catch {
                // ignore missing paths
            }
        }
        return null;
    }
    /**
     * Helper: Convert aspect ratio string to API enum format
     * Converts "16:9", "9:16" to VIDEO_ASPECT_RATIO_* enum
     * @public - Exposed for use by veo3JobProcessorService
     */
    convertAspectRatioToEnum(aspectRatio) {
        if (!aspectRatio) {
            return "VIDEO_ASPECT_RATIO_LANDSCAPE";
        }
        // If already in enum format, return as-is
        if (aspectRatio.startsWith("VIDEO_ASPECT_RATIO_")) {
            return aspectRatio;
        }
        // Convert string format to enum
        const ratioMap = {
            "16:9": "VIDEO_ASPECT_RATIO_LANDSCAPE",
            "9:16": "VIDEO_ASPECT_RATIO_PORTRAIT",
        };
        return ratioMap[aspectRatio] || "VIDEO_ASPECT_RATIO_LANDSCAPE";
    }
    /**
     * Why a generation failed, for the poller's retry classification. Flow's status row only
     * carries a numeric state, so this reports that state; a real failure reason has not been
     * captured yet.
     */
    async fetchMediaFailureReason(operationName, _veo3ProjectId) {
        const profileId = this.config.profileId;
        if (!profileId)
            return null;
        try {
            return (await this.readFlowMediaState(profileId, operationName))?.error ?? null;
        }
        catch (error) {
            logger.warn(`[Poll Status:media] Không lấy được lý do hỏng cho op ${operationName.substring(0, 12)}: ${error?.message}`);
            return null;
        }
    }
    /**
     * Upload ảnh vào project Flow, trả về mediaId (UUID) dùng cho imageInputs /
     * referenceImages.
     *
     * Đi qua BOQ RPC `maseQ` trên flow.google.com (cookie + reCAPTCHA), KHÔNG còn
     * REST `aisandbox-pa …/v1/flow/uploadImage` — endpoint đó trả 400 từ 2026-09.
     */
    async uploadUserImage(imagePath, projectId) {
        const profileId = this.config.profileId;
        if (!profileId) {
            throw new Error("Thiếu profileId — upload ảnh qua Flow cần cookie của profile");
        }
        if (!projectId) {
            throw new Error("Thiếu Veo3 projectId — upload ảnh Flow bắt buộc gắn với project. Hãy tạo lại project.");
        }
        if (!fs.existsSync(imagePath)) {
            throw new Error(`Image file not found: ${imagePath}`);
        }
        this.updateConfig({ veo3ProjectId: projectId });
        const buf = fs.readFileSync(path.resolve(imagePath));
        const { mime, ext } = detectImageKind(buf);
        const base64 = buf.toString("base64");
        logger.info(`📤 [Upload Image] BOQ maseQ project=${projectId} ${buf.length} byte ${mime}`);
        try {
            const payload = await callFlowRpc(profileId, FLOW_RPC.uploadImage, async () => {
                // Upload là thao tác ảnh → IMAGE_GENERATION (giống SPrCad). Token
                // single-use nên mint trong builder: flowBoq gọi lại builder mỗi lượt thử.
                const [recaptchaToken] = await this.requestRecaptchaTokens("IMAGE_GENERATION", 1);
                return buildMaseQArgs({
                    projectId,
                    recaptchaToken,
                    base64,
                    mime,
                    fileName: `image.${ext}`,
                });
            }, {
                userAgent: this.config.userAgent,
                sourcePath: `/project/${projectId}`,
                timeoutMs: UPLOAD_IMAGE_TIMEOUT_MS,
            });
            const mediaId = extractUploadedMediaId(payload);
            const size = readUploadedImageSize(payload);
            if (size)
                rememberImageSize(mediaId, size.width, size.height);
            logger.info(`✅ [Upload Image] mediaId: ${mediaId}`);
            return mediaId;
        }
        catch (err) {
            logger.warn(`❌ [Upload Image] maseQ thất bại: ${err instanceof Error ? err.message : String(err)}`);
            throw toUploadError(err);
        }
    }
    /**
     * Delete Veo3 project
     * POST /api/trpc/project.deleteProject
     *
     * @param projectId - Veo3 project ID to delete
     * @returns true if successful
     */
    async deleteProject(projectId) {
        if (!this.config.accessToken) {
            throw new Error("Access token is required for deleting project");
        }
        if (!projectId) {
            throw new Error("Project ID is required");
        }
        return this.executeWithTokenRefresh(async () => {
            const url = `${this.baseUrl}/project.deleteProject`;
            const body = {
                json: {
                    projectToDeleteId: projectId,
                },
            };
            const headers = this.getTrpcHeaders();
            const response = await googleFetch({
                profileId: this.config.profileId,
                veo3ProjectId: this.config.veo3ProjectId,
                locale: this.config.locale,
                url,
                method: "POST",
                headers,
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                const errorText = await response.text();
                if (this.isAuthError(response, errorText)) {
                    const error = new Error("Access token đã hết hạn hoặc không hợp lệ.");
                    error.response = response;
                    error.errorText = errorText;
                    throw error;
                }
                throw new Error(`Failed to delete project: ${response.statusText} - ${errorText}`);
            }
            const result = await response.json();
            logger.info(`✅ [Delete Project] Successfully deleted project: ${projectId}`);
            return true;
        });
    }
    /**
     * Delete media from Veo3 cloud
     * POST /api/trpc/media.deleteMedia
     *
     * @param mediaNames - Array of media IDs (CAMaJ... format) to delete
     * @returns true if successful
     */
    async deleteMedia(mediaNames) {
        if (!this.config.accessToken) {
            throw new Error("Access token is required for deleting media");
        }
        if (!mediaNames || mediaNames.length === 0) {
            throw new Error("At least one media name is required");
        }
        return this.executeWithTokenRefresh(async () => {
            const url = `${this.baseUrl}/media.deleteMedia`;
            const body = {
                json: {
                    names: mediaNames,
                },
            };
            const headers = this.getTrpcHeaders();
            const response = await googleFetch({
                profileId: this.config.profileId,
                veo3ProjectId: this.config.veo3ProjectId,
                locale: this.config.locale,
                url,
                method: "POST",
                headers,
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                const errorText = await response.text();
                if (this.isAuthError(response, errorText)) {
                    const error = new Error("Access token đã hết hạn hoặc không hợp lệ.");
                    error.response = response;
                    error.errorText = errorText;
                    throw error;
                }
                // labs.google/media.deleteMedia trả 500 INTERNAL_SERVER_ERROR cho media
                // tạo theo shape mới (verify 2026-09-23: thử cả UUID lẫn tên dài đều 500).
                // Nhiều khả năng nó chỉ còn hiểu media đời cũ; web client hiện dùng
                // BOQ `cz8Z4b` = /FlowService.BatchDeleteAssets. Nói thẳng ra để UI
                // không báo "đã xoá" trong khi Google vẫn giữ nguyên file.
                if (response.status === 500) {
                    throw new Error("MEDIA_DELETE_UNAVAILABLE: Google không xoá được media này nữa " +
                        "(API cũ trả lỗi 500). Ảnh vẫn còn trong thư viện Flow.");
                }
                throw new Error(`Failed to delete media: ${response.statusText} - ${errorText}`);
            }
            const result = await response.json();
            logger.info(`✅ [Delete Media] Successfully deleted ${mediaNames.length} media(s)`);
            return true;
        });
    }
    /**
     * Call Veo3 generateExpandedPrompt API
     *
     * This API takes a user prompt and style preamble and returns a professional
     * expanded prompt suitable for video generation.
     *
     * Endpoint: POST https://labs.google/fx/api/trpc/videoFx.generateExpandedPrompt
     *
     * @param userPrompt - Original user prompt (e.g., "Chú sói trắng đang chạy...")
     * @param preamble - Style preamble with guidelines (e.g., Film Noir formatting)
     * @param cookies - Cookie header string for authentication
     * @param sessionId - Optional session ID for tracking
     * @returns Expanded prompt string
     */
    async callGenerateExpandedPromptAPI(userPrompt, preamble, cookies, sessionId) {
        const url = "https://labs.google/fx/api/trpc/videoFx.generateExpandedPrompt";
        try {
            logger.info("[Veo3Service] Calling generateExpandedPrompt API", {
                userPromptLength: userPrompt.length,
                preambleLength: preamble.length,
                sessionId: sessionId || "not-provided",
            });
            // Prepare request payload (following the format from curl examples)
            const requestPayload = {
                json: {
                    userPrompt: userPrompt,
                    preamble: preamble,
                    dataUrlImages: null,
                    mode: "TEXT_TO_VIDEO",
                    sessionId: sessionId
                        ? `;${sessionId}`
                        : this.config.profileId
                            ? sessionIdManager.get(this.config.profileId, this.config.veo3ProjectId)
                            : `;${Date.now()}`,
                },
                meta: {
                    values: {
                        dataUrlImages: ["undefined"],
                    },
                },
            };
            const headers = {
                Accept: "application/json",
                "Accept-Language": "en-US,en;q=0.9",
                "Content-Type": "application/json",
                Origin: "https://labs.google",
                Priority: "u=1, i",
                Referer: "https://labs.google/fx/tools/flow",
            };
            if (this.config.accessToken) {
                headers["Authorization"] = `Bearer ${this.config.accessToken}`;
            }
            const response = await googleFetch({
                profileId: this.config.profileId,
                veo3ProjectId: this.config.veo3ProjectId,
                locale: this.config.locale,
                url,
                method: "POST",
                headers,
                body: JSON.stringify(requestPayload),
            });
            if (!response.ok) {
                const errorText = await response.text();
                logger.error("[Veo3Service] generateExpandedPrompt API failed", {
                    statusCode: response.status,
                    statusText: response.statusText,
                    errorText: errorText.substring(0, 200),
                });
                // Return original prompt if expansion fails
                return userPrompt;
            }
            // Parse response
            const responseText = await response.text();
            // Remove TRPC prefix if present: )]}'\n
            let cleanedText = responseText;
            if (cleanedText.startsWith(")]}'")) {
                cleanedText = cleanedText.substring(4).trim();
            }
            // Parse JSON
            let expandedPrompt = userPrompt;
            try {
                const responseData = JSON.parse(cleanedText);
                // Extract expanded prompt from JSON response
                // Response format: { result: { data: { json: "markdown text..." } } }
                if (responseData?.result?.data?.json) {
                    // The 'json' field contains markdown text, not JSON string
                    const jsonData = responseData.result.data.json;
                    if (typeof jsonData === "string" && jsonData.trim().length > 0) {
                        expandedPrompt = jsonData.trim();
                        logger.info("[Veo3Service] Extracted from result.data.json", {
                            expandedLength: expandedPrompt.length,
                        });
                    }
                }
                else if (responseData?.result?.data?.expandedPrompt) {
                    // Alternative format: { result: { data: { expandedPrompt: "..." } } }
                    expandedPrompt = responseData.result.data.expandedPrompt;
                }
            }
            catch (parseError) {
                // Not JSON - check if it's plain text/markdown response
                // Sometimes API returns markdown directly (e.g., "## Phân Cảnh 1...")
                if (cleanedText && cleanedText.trim().length > 0) {
                    // If response starts with markdown or looks like expanded content, use it
                    if (cleanedText.startsWith("##") ||
                        cleanedText.length > userPrompt.length) {
                        logger.info("[Veo3Service] Received plain text response (not JSON)", {
                            responseLength: cleanedText.length,
                            firstChars: cleanedText.substring(0, 50),
                        });
                        expandedPrompt = cleanedText.trim();
                    }
                    else {
                        logger.warn("[Veo3Service] Failed to parse response, using original prompt", {
                            responseLength: cleanedText.length,
                            firstChars: cleanedText.substring(0, 100),
                        });
                        expandedPrompt = userPrompt;
                    }
                }
                else {
                    logger.warn("[Veo3Service] Empty response, using original prompt");
                    expandedPrompt = userPrompt;
                }
            }
            logger.info("[Veo3Service] generateExpandedPrompt success", {
                originalLength: userPrompt.length,
                expandedLength: expandedPrompt.length,
                expansion: (((expandedPrompt.length - userPrompt.length) / userPrompt.length) *
                    100).toFixed(1) + "%",
            });
            return expandedPrompt;
        }
        catch (error) {
            logger.error("[Veo3Service] generateExpandedPrompt error", {
                error: error.message,
                stack: error.stack?.substring(0, 200),
            });
            // Return original prompt on error
            return userPrompt;
        }
    }
    /**
     * Upload an image into the Flow project and return its mediaId (UUID).
     * `_options` chỉ giữ cho tương thích — mọi trường đều bị bỏ qua: mime nhận theo
     * magic bytes, tỉ lệ khung do Flow tự suy từ ảnh.
     */
    async uploadImageAndExtractMediaId(imagePath, projectId, _options) {
        return this.uploadUserImage(imagePath, projectId);
    }
    /**
     * Poll a single video generation status and normalize the Veo3 enum into a
     * caller-friendly shape (PENDING / PROCESSING / COMPLETED / FAILED).
     */
    async pollVideoStatusNormalized(operationId, sceneId) {
        const result = await this.pollVideoStatus(operationId, sceneId);
        let status = "PENDING";
        if (result.status === "MEDIA_GENERATION_STATUS_PENDING")
            status = "PENDING";
        else if (result.status === "MEDIA_GENERATION_STATUS_ACTIVE")
            status = "PROCESSING";
        else if (result.status === "MEDIA_GENERATION_STATUS_PROCESSING")
            status = "PROCESSING";
        else if (result.status === "MEDIA_GENERATION_STATUS_SUCCESSFUL")
            status = "COMPLETED";
        else if (result.status === "MEDIA_GENERATION_STATUS_FAILED")
            status = "FAILED";
        const errorMessage = status === "FAILED"
            ? result.error || "Video generation failed"
            : undefined;
        const progress = status === "COMPLETED"
            ? 100
            : status === "PROCESSING" || status === "PENDING"
                ? 50
                : 0;
        return {
            status,
            videoUrl: result.videoUrl || undefined,
            mediaId: result.mediaId,
            error: errorMessage,
            progress,
            remainingCredits: result.remainingCredits,
        };
    }
}
/**
 * Product slot in the createProject args. Captured verbatim from the live web
 * client for Flow (`PINHOLE`); the enum is not documented, so there is no
 * mapping for any other tool.
 */
Veo3Service.FLOW_PRODUCT_SLOT = 22;
Veo3Service.FLOW_PRODUCT_TOOL = "PINHOLE";
Veo3Service.UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
