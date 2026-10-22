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
import { pushFlowTelemetry } from "./flowTelemetryBuffer.js";
import { callFlowRpc, FLOW_RPC, parseCreditsPayload } from "../../lib/flowBoq.js";
import { buildMaseQArgs, detectImageKind, extractUploadedMediaId, flowClientContext, toUploadError, } from "./flowUpload.js";
import { sessionIdManager } from "../../lib/sessionIdManager.js";
import { buildProxyAgents, evictProxyAgent, applyInterProfileJitter, } from "./veo3ProxyManager.js";
import { getHostUa, getHostSecChUa, getHostSecChUaPlatform, } from "../../lib/hostChromeUa.js";
/** Ảnh tới 30MB qua proxy — 30s mặc định của flowBoq không đủ. */
const UPLOAD_IMAGE_TIMEOUT_MS = 120000;
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
        // Keep submit headers aligned with the real Chrome that owns the verification session.
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
     * Push image-gen telemetry events into the per-profile FlowTelemetryBuffer
     * (which batches + flushes on a delay, mirroring real Flow's network signature).
     *
     * Real Flow pattern (verified via captures/flowai-lifecycle-*.json):
     *   - Per gen on the wire: ONLY `flowMedia:batchGenerateImages` + `/clr` (auto)
     *   - `:batchLog` and `/flow:batchLogFrontendEvents` are flushed PERIODICALLY
     *     with N events accumulated (a single capture POST contained 12+ events)
     *
     * Old per-gen-immediate-POST behaviour produced a per-gen telemetry burst
     * (log → log → gen → log → log → log → log) that Google's reCAPTCHA Enterprise
     * scoring flagged as bot, causing PUBLIC_ERROR_UNUSUAL_ACTIVITY 403 after the
     * first 1–2 gens. See `flowTelemetryBuffer.ts` for the batching strategy.
     *
     * NOTE: `phase: 'before'` is intentionally a no-op now — real Flow does NOT
     * fire any pre-gen telemetry tied to the user clicking Generate. The previous
     * pre-gen FLOW_IMAGE_LATENCY with placeholder duration (`?? 300`) was a fake
     * value with no real-browser counterpart and added a per-gen request that
     * Google could fingerprint.
     */
    fireImageGenLogs(params) {
        const { sessionId, imageModelName, aspectRatio, refImageCount, outputsPerPrompt, phase, latencyMs, } = params;
        // Pre-gen: drop on the floor — real Flow does not emit this signal.
        if (phase === "before")
            return;
        const profileId = this.config.profileId;
        if (!profileId)
            return;
        const headers = this.getSandboxHeaders("application/json");
        const userAgent = this.config.userAgent || this.defaultHeaders["User-Agent"];
        const eventTime = new Date().toISOString();
        const currentTimeMs = Date.now();
        const settingsJson = JSON.stringify({
            modelKey: imageModelName,
            aspectRatio,
            outputCount: outputsPerPrompt,
            refImageCount,
        });
        const appEvents = [];
        const frontendEvents = [];
        appEvents.push({
            event: "MEDIA_GENERATION",
            eventProperties: [
                { key: "MEDIA_GENERATION_TYPE", stringValue: "image" },
                { key: "MEDIA_GENERATION_SETTINGS", stringValue: settingsJson },
                {
                    key: "MEDIA_GENERATION_PAYGATE_TIER",
                    stringValue: "PAYGATE_TIER_TWO",
                },
                { key: "USER_AGENT", stringValue: userAgent },
                { key: "IS_DESKTOP", booleanValue: true },
            ],
            eventMetadata: { sessionId },
            eventTime,
        });
        frontendEvents.push({
            eventType: "MEDIA_GENERATION",
            metadata: {
                sessionId,
                createTime: eventTime,
                additionalParams: {
                    MEDIA_GENERATION_TYPE: {
                        "@type": "type.googleapis.com/google.protobuf.StringValue",
                        value: "image",
                    },
                    MEDIA_GENERATION_SETTINGS: {
                        "@type": "type.googleapis.com/google.protobuf.StringValue",
                        value: settingsJson,
                    },
                    MEDIA_GENERATION_PAYGATE_TIER: {
                        "@type": "type.googleapis.com/google.protobuf.StringValue",
                        value: "PAYGATE_TIER_TWO",
                    },
                    IS_DESKTOP: {
                        "@type": "type.googleapis.com/google.protobuf.BoolValue",
                        value: true,
                    },
                },
            },
        });
        if (latencyMs !== undefined) {
            appEvents.push({
                event: "FLOW_IMAGE_LATENCY",
                eventProperties: [
                    { key: "CURRENT_TIME_MS", doubleValue: currentTimeMs },
                    { key: "DURATION_MS", doubleValue: latencyMs },
                    { key: "USER_AGENT", stringValue: userAgent },
                    { key: "IS_DESKTOP", booleanValue: true },
                ],
                eventMetadata: { sessionId },
                eventTime,
            });
            frontendEvents.push({
                eventType: "FLOW_IMAGE_LATENCY",
                metadata: {
                    sessionId,
                    createTime: eventTime,
                    additionalParams: {
                        CURRENT_TIME_MS: {
                            "@type": "type.googleapis.com/google.protobuf.DoubleValue",
                            value: currentTimeMs,
                        },
                        DURATION_MS: {
                            "@type": "type.googleapis.com/google.protobuf.DoubleValue",
                            value: latencyMs,
                        },
                        IS_DESKTOP: {
                            "@type": "type.googleapis.com/google.protobuf.BoolValue",
                            value: true,
                        },
                    },
                },
            });
        }
        pushFlowTelemetry({
            profileId,
            baseUrl: this.sandboxBaseUrl,
            headers,
            veo3ProjectId: this.config.veo3ProjectId,
            locale: this.config.locale,
            appEvents,
            frontendEvents,
        });
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
     * ✅ Get access token từ session với cookies từ profile
     * GET /api/auth/session
     *
     * Lấy access token từ session sử dụng cookies từ profile.
     *
     * @param cookieHeader - Cookie header string (e.g., "name1=value1; name2=value2")
     * @returns Session info bao gồm access_token, user info, và expires time
     */
    async getSessionWithCookies(_cookieHeader) {
        const url = "https://labs.google/fx/api/auth/session";
        // The cookieHeader param is intentionally ignored: googleFetch routes
        // through the browser, which always uses its own session cookies via
        // withCredentials. Param retained for backward call-site compatibility.
        const headers = this.getTrpcHeaders();
        const response = await googleFetch({
            profileId: this.config.profileId,
            veo3ProjectId: this.config.veo3ProjectId,
            locale: this.config.locale,
            url,
            method: "GET",
            headers,
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to get session with cookies: ${response.statusText} - ${errorText}`);
        }
        const sessionData = await response.json();
        return sessionData;
    }
    /**
     * ✅ Helper: Get access token từ session
     * Wrapper method để chỉ lấy access_token
     */
    async getAccessToken() {
        const session = await this.getSession();
        return session.access_token;
    }
    /**
     * ✅ Helper: Get access token và tự động update vào config
     * Tiện lợi để tự động refresh token và update vào service
     */
    async refreshAccessToken() {
        logger.info(`🔄 [Veo3Service] Refreshing access token...`);
        // Use cookies if available, otherwise use existing session
        let session;
        if (this.config.cookies) {
            logger.info(`   Using cookies to get new session...`);
            session = await this.getSessionWithCookies(this.config.cookies);
        }
        else {
            logger.info(`   Using existing session to refresh...`);
            session = await this.getSession();
        }
        const accessToken = session.access_token;
        if (!accessToken) {
            throw new Error("No access_token in session response");
        }
        logger.info(`   New token: ${accessToken.substring(0, 20)}...${accessToken.substring(accessToken.length - 10)}`);
        this.updateConfig({ accessToken });
        logger.info(`   Token updated in config: ${this.config.accessToken?.substring(0, 20)}...`);
        // Notify caller about new token
        if (this.config.onTokenRefreshed) {
            logger.info(`   Calling onTokenRefreshed callback...`);
            await this.config.onTokenRefreshed(accessToken);
        }
        return accessToken;
    }
    /** Get credits and paygate tier from Flow's cookie-authenticated BOQ RPC. */
    async getCredits() {
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
    async fetchMediaLibrary(options) {
        const pageSize = options?.pageSize ?? 18;
        const cursor = options?.cursor ?? null;
        return this.executeWithTokenRefresh(async () => {
            const inputPayload = {
                json: {
                    type: "ASSET_MANAGER",
                    pageSize,
                    responseScope: "RESPONSE_SCOPE_UNSPECIFIED",
                    cursor,
                },
                meta: {
                    values: {
                        cursor: [cursor ?? "undefined"],
                    },
                },
            };
            const url = `${this.baseUrl}/media.fetchUserHistoryDirectly?input=${encodeURIComponent(JSON.stringify(inputPayload))}`;
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
                if (response.status === 401 || response.status === 403) {
                    const error = new Error("UNAUTHORIZED");
                    error.response = response;
                    error.errorText = errorText;
                    throw error;
                }
                throw new Error(`Failed to fetch media library: ${response.statusText} - ${errorText}`);
            }
            return response.json();
        });
    }
    // COMMENTED OUT: fetchMediaDetail is no longer needed
    // After uploading images, we already have all necessary information and save images correctly for each profile
    // No need to verify mediaIds - they are already validated during upload
    // async fetchMediaDetail(mediaName: string): Promise<MediaDetailResponse> {
    //   if (!mediaName) {
    //     throw new Error('mediaName is required to fetch media detail');
    //   }
    //   return this.executeWithTokenRefresh(async () => {
    //     // URL format: /v1/media/{mediaName}?key=...&clientContext.tool=PINHOLE
    //     // The key parameter appears to be a public API key (same for all requests)
    //     const encodedName = encodeURIComponent(mediaName);
    //     // Using the API key from curl example - this appears to be a public key
    //     const apiKey = 'AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY';
    //     const url = `${this.sandboxBaseUrl}/media/${encodedName}?key=${apiKey}&clientContext.tool=PINHOLE`;
    //     const headers = this.getSandboxHeaders('application/json');
    //     // Add authentication headers for sandbox API
    //     if (this.config.accessToken) {
    //       headers['Authorization'] = `Bearer ${this.config.accessToken}`;
    //     }
    //     if (this.config.cookies) {
    //       headers['Cookie'] = this.config.cookies;
    //     }
    //     const response = await fetch(url, {
    //       method: 'GET',
    //       headers,
    //     });
    //     if (!response.ok) {
    //       const errorText = await response.text();
    //       if (response.status === 401 || response.status === 403) {
    //         const error: any = new Error('UNAUTHORIZED');
    //         error.response = response;
    //         error.errorText = errorText;
    //         throw error;
    //       }
    //       // Log detailed error for debugging
    //       logger.error(`[Veo3Service] fetchMediaDetail failed:`, {
    //         mediaName: mediaName.substring(0, 50) + '...',
    //         status: response.status,
    //         statusText: response.statusText,
    //         errorText: errorText.substring(0, 200),
    //         headers: Object.fromEntries(response.headers.entries())
    //       });
    //       throw new Error(`Failed to fetch media detail: ${response.statusText} - ${errorText}`);
    //     }
    //     const result = await response.json();
    //     // Only log if fifeUrl is missing (for debugging)
    //     const hasFifeUrl = result?.image?.fifeUrl || (result as any)?.userUploadedImage?.fifeUrl;
    //     if (!hasFifeUrl) {
    //       logger.warn(`⚠️  [Media Detail] No fifeUrl found. Has image: ${!!result?.image}, Has userUploadedImage: ${!!(result as any)?.userUploadedImage}`);
    //     }
    //     return result;
    //   });
    // }
    /**
     * Fetch user preferences (TRPC API - phụ, không trực tiếp tạo video)
     * GET /api/trpc/general.fetchUserPreferences
     * Chỉ dùng để lấy user preferences, không ảnh hưởng đến video generation
     */
    async fetchUserPreferences() {
        const url = `${this.baseUrl}/general.fetchUserPreferences?input=%7B%22json%22%3Anull%2C%22meta%22%3A%7B%22values%22%3A%5B%22undefined%22%5D%7D%7D`;
        const response = await googleFetch({
            profileId: this.config.profileId,
            veo3ProjectId: this.config.veo3ProjectId,
            locale: this.config.locale,
            url,
            method: "GET",
            headers: this.getTrpcHeaders(),
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch user preferences: ${response.statusText}`);
        }
        return await response.json();
    }
    /**
     * Submit batch log (TRPC API - phụ, chỉ dùng cho analytics/logging)
     * POST /api/trpc/general.submitBatchLog
     * Chỉ dùng để gửi analytics events, không trực tiếp tạo video
     */
    async submitBatchLog(logData) {
        const url = `${this.baseUrl}/general.submitBatchLog`;
        const response = await googleFetch({
            profileId: this.config.profileId,
            veo3ProjectId: this.config.veo3ProjectId,
            locale: this.config.locale,
            url,
            method: "POST",
            headers: this.getTrpcHeaders(),
            body: JSON.stringify({ json: logData }),
        });
        if (!response.ok) {
            throw new Error(`Failed to submit batch log: ${response.statusText}`);
        }
        return await response.json();
    }
    /**
     * ✅ API CHÍNH: Submit job generate video
     * POST /v1/video:batchAsyncGenerateVideoText
     *
     * Đây là API chính để tạo video. Trả về operation name để dùng cho check status.
     *
     * @returns operation name (dùng để poll status)
     */
    async batchAsyncGenerateVideoText(request, onRecaptchaComplete, onSubmitFired) {
        if (!this.config.accessToken) {
            throw new Error("Access token is required for video generation");
        }
        // ⚠️ Sync veo3ProjectId vào config trước khi gọi reCAPTCHA — nếu không, browser
        // sẽ load homepage thay vì project page → action↔location mismatch → 403.
        if (request.clientContext?.projectId) {
            this.updateConfig({ veo3ProjectId: request.clientContext.projectId });
        }
        return this.executeWithTokenRefresh(async () => {
            const url = `${this.sandboxBaseUrl}/video:batchAsyncGenerateVideoText`;
            logger.info(`📤 [API Monitor] Submitting video generation request (Text-to-Video)`, {
                projectId: request.clientContext?.projectId || "N/A",
                requestsCount: request.requests?.length || 0,
            });
            const batchId = crypto.randomUUID();
            const allOperations = [];
            const requestsCount = request.requests?.length || 0;
            // ⚠️ Lấy N token cùng lúc trong 1 browser session — đảm bảo cùng UA, cookies,
            // project page, warmth state. Tránh queue serialize + tránh delay token→API gap dài.
            const batchTokenResult = await this.requestRecaptchaTokens("VIDEO_GENERATION", requestsCount);
            if (batchTokenResult.length < requestsCount) {
                throw new Error(`Batch tokens insufficient for video: got ${batchTokenResult.length}, need ${requestsCount}`);
            }
            // 🔔 Callback ngay khi đã có toàn bộ token (UI cập nhật progress 1 lần thay vì nhiều lần)
            if (onRecaptchaComplete) {
                try {
                    await onRecaptchaComplete();
                }
                catch (_) {
                    /* non-blocking */
                }
            }
            for (let i = 0; i < requestsCount; i++) {
                const reqItem = request.requests[i];
                const tokenForThisRequest = batchTokenResult[i];
                const singleRequestBody = {
                    clientContext: {
                        ...request.clientContext,
                        recaptchaContext: {
                            token: tokenForThisRequest,
                            applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB",
                        },
                    },
                    mediaGenerationContext: {
                        batchId: batchId,
                        audioFailurePreference: request.mediaGenerationContext?.audioFailurePreference ??
                            "BLOCK_SILENCED_VIDEOS",
                    },
                    ...(request.useV2ModelConfig ? { useV2ModelConfig: true } : {}),
                    requests: [
                        {
                            ...reqItem,
                        },
                    ],
                };
                const xhrPromise = googleFetch({
                    profileId: this.config.profileId,
                    veo3ProjectId: this.config.veo3ProjectId,
                    locale: this.config.locale,
                    url,
                    method: "POST",
                    // Cross-origin call to aisandbox-pa.googleapis.com — must use Sandbox
                    // headers (User-Agent matched to mint Chrome version + root Referer).
                    // Previous getTrpcHeaders() left Chrome 148 fallback UA + project URL
                    // referer, both of which Google's reCAPTCHA pipeline scored as bot.
                    headers: this.getSandboxHeaders("application/json"),
                    body: JSON.stringify(singleRequestBody),
                    // Keep submit -> clr in the same page execution block to avoid
                    // out-of-band reset races on the wire.
                });
                // 🔓 Browser captcha lifecycle complete (1st request): XHR fired + clr sent.
                // Release caller's browser lock → next profile's captcha can safely start.
                if (i === 0)
                    onSubmitFired?.();
                let response;
                try {
                    response = await xhrPromise;
                }
                finally {
                }
                if (runtimeVerboseLogsEnabled()) {
                    logger.info(`📥 [API Monitor] Request ${i + 1}/${requestsCount} response status: ${response.status} ${response.statusText}`);
                }
                if (!response.ok) {
                    const errorText = await response.text();
                    const isRecaptcha403 = response.status === 403 &&
                        (errorText.includes("PUBLIC_ERROR_UNUSUAL_ACTIVITY") ||
                            errorText.includes("reCAPTCHA evaluation failed"));
                    if (isRecaptcha403) {
                        logger.warn(`⚠️ [API Monitor] Request ${i + 1}/${requestsCount} → 403 reCAPTCHA (silent retry)`);
                    }
                    else {
                        logger.error(`❌ [API Monitor] Request ${i + 1}/${requestsCount} API Error: ${response.status} - ${errorText.substring(0, 500)}`);
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
                    throw buildVeoApiError(`Failed to generate video (request ${i + 1}/${requestsCount})`, response, errorText);
                }
                const responseData = await response.json();
                // Veo 3.1 lite tier có thể trả `{media:[...]}` thay vì `{operations:[...]}`
                // — fallback sang submit converter để upstream lưu providerJobId đúng.
                if (responseData.operations && responseData.operations.length > 0) {
                    allOperations.push(...responseData.operations);
                }
                else if (Array.isArray(responseData.media) &&
                    responseData.media.length > 0) {
                    const ourSceneId = reqItem?.metadata?.sceneId || "";
                    allOperations.push(...this.convertMediaArrayToSubmitOperations(responseData.media, ourSceneId));
                }
            }
            // "✅ Video generation requests completed" log dropped — TLS Submit
            // already shows transport/status/bytes/duration for each request.
            return { operations: allOperations };
        });
    }
    /**
     * ✅ API: Submit job generate video với reference images
     * POST /v1/video:batchAsyncGenerateVideoReferenceImages
     *
     * Đây là API để tạo video với reference images (đã upload lên Veo3).
     * Sử dụng khi có mediaGenerationId từ characters.
     *
     * API spec: Content-Type: application/json (khác với batchAsyncGenerateVideoText dùng text/plain)
     *
     * @returns operation name (dùng để poll status)
     */
    async batchAsyncGenerateVideoReferenceImages(request, onRecaptchaComplete, onSubmitFired) {
        if (!this.config.accessToken) {
            throw new Error("Access token is required for video generation");
        }
        // ⚠️ Sync veo3ProjectId vào config trước khi gọi reCAPTCHA (xem comment ở batchAsyncGenerateVideoText)
        if (request.clientContext?.projectId) {
            this.updateConfig({ veo3ProjectId: request.clientContext.projectId });
        }
        return this.executeWithTokenRefresh(async () => {
            const url = `${this.sandboxBaseUrl}/video:batchAsyncGenerateVideoReferenceImages`;
            logger.info(`📤 [API Monitor] Submit video (Reference Images) count=${request.requests?.length || 0} project=${request.clientContext?.projectId?.substring(0, 12) || "N/A"}`);
            const batchId = crypto.randomUUID();
            const allOperations = [];
            const requestsCount = request.requests?.length || 0;
            // Lấy N token cùng lúc trong 1 browser session (tránh queue serialize + token gap dài)
            const batchTokenResult = await this.requestRecaptchaTokens("VIDEO_GENERATION", requestsCount);
            if (batchTokenResult.length < requestsCount) {
                throw new Error(`Batch tokens insufficient for video-ref: got ${batchTokenResult.length}, need ${requestsCount}`);
            }
            if (onRecaptchaComplete) {
                try {
                    await onRecaptchaComplete();
                }
                catch (_) {
                    /* non-blocking */
                }
            }
            for (let i = 0; i < requestsCount; i++) {
                const reqItem = request.requests[i];
                const tokenForThisRequest = batchTokenResult[i];
                // Normalize referenceImages to the proven-working Flow contract
                // (flat-UUID mediaId + explicit imageUsageType). See normalizeReferenceImage.
                const normalizedRefs = Array.isArray(reqItem.referenceImages)
                    ? reqItem.referenceImages.map((r) => normalizeReferenceImage(r))
                    : reqItem.referenceImages;
                const singleRequestBody = {
                    clientContext: {
                        ...request.clientContext,
                        recaptchaContext: {
                            token: tokenForThisRequest,
                            applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB",
                        },
                    },
                    mediaGenerationContext: {
                        batchId: batchId,
                        // Default giữ nguyên BLOCK: workflow.engine có caller chỉ gửi `{batchId}` và đang
                        // dựa vào hành vi này — đổi default sẽ âm thầm đổi kết quả Flow workflow.
                        audioFailurePreference: request.mediaGenerationContext?.audioFailurePreference ??
                            "BLOCK_SILENCED_VIDEOS",
                    },
                    ...(request.useV2ModelConfig ? { useV2ModelConfig: true } : {}),
                    requests: [
                        {
                            ...reqItem,
                            ...(normalizedRefs ? { referenceImages: normalizedRefs } : {}),
                        },
                    ],
                };
                // Slim submit log — full body contains a 2KB+ reCAPTCHA token + prompt;
                // dumping it per job spams stdout. Set VEO3_LOG_SUBMIT_BODY=1 if you
                // genuinely need the raw payload for debugging.
                if (process.env.VEO3_LOG_SUBMIT_BODY === "1") {
                    logger.info(JSON.stringify(singleRequestBody));
                }
                else {
                    const firstReq = singleRequestBody.requests?.[0];
                    const refDiag = Array.isArray(firstReq?.referenceImages)
                        ? firstReq.referenceImages
                            .map((r) => `${String(r?.mediaId ?? "?").slice(0, 8)}:${r?.imageUsageType ?? "none"}`)
                            .join(",")
                        : "";
                    logger.info(`📤 [Veo3Service] submit ${firstReq?.videoModelKey ?? "?"} aspect=${firstReq?.aspectRatio ?? "?"} sceneId=${firstReq?.metadata?.sceneId?.slice(0, 8) ?? "?"} refs=${firstReq?.referenceImages?.length ?? 0}[${refDiag}] promptLen=${(firstReq?.textInput?.prompt ?? firstReq?.structuredPrompt?.parts?.[0]?.text ?? "").length}`);
                }
                const xhrPromise2 = googleFetch({
                    profileId: this.config.profileId,
                    veo3ProjectId: this.config.veo3ProjectId,
                    locale: this.config.locale,
                    url,
                    method: "POST",
                    headers: this.getSandboxHeaders("application/json"),
                    body: JSON.stringify(singleRequestBody),
                    // Keep submit -> clr in the same page execution block to avoid
                    // out-of-band reset races on the wire.
                });
                // 🔓 Browser captcha lifecycle complete (1st request): XHR fired + clr sent.
                if (i === 0)
                    onSubmitFired?.();
                let response;
                try {
                    response = await xhrPromise2;
                }
                finally {
                }
                if (runtimeVerboseLogsEnabled()) {
                    logger.info(`📥 [API Monitor] Request ${i + 1}/${requestsCount} response status: ${response.status} ${response.statusText}`);
                }
                if (!response.ok) {
                    const errorText = await response.text();
                    const isRecaptcha403 = response.status === 403 &&
                        (errorText.includes("PUBLIC_ERROR_UNUSUAL_ACTIVITY") ||
                            errorText.includes("reCAPTCHA evaluation failed"));
                    if (isRecaptcha403) {
                        logger.warn(`⚠️ [API Monitor] Request ${i + 1}/${requestsCount} → 403 reCAPTCHA (silent retry)`);
                    }
                    else {
                        logger.error(`❌ [API Monitor] Request ${i + 1}/${requestsCount} API Error: ${response.status} - ${errorText.substring(0, 500)}`);
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
                    throw buildVeoApiError(`Failed to generate video with reference images (request ${i + 1}/${requestsCount})`, response, errorText);
                }
                const responseData = await response.json();
                // Veo 3.1 r2v API trả về shape mới `{remainingCredits, workflows, media}`
                // thay vì `{operations}`. Convert sang legacy operations[] shape để
                // upstream queue manager (sceneIdToJobMap, processVideoStatusResult)
                // không cần biết về shape mới.
                if (responseData.operations && responseData.operations.length > 0) {
                    allOperations.push(...responseData.operations);
                }
                else if (Array.isArray(responseData.media) &&
                    responseData.media.length > 0) {
                    const ourSceneId = reqItem?.metadata?.sceneId || "";
                    allOperations.push(...this.convertMediaArrayToSubmitOperations(responseData.media, ourSceneId));
                }
            }
            // "✅ Video generation reference images completed" log dropped — TLS Submit covers it.
            return { operations: allOperations };
        });
    }
    /**
     * ✅ API: Generate video from start image (image-to-video)
     * POST /v1/video:batchAsyncGenerateVideoStartImage
     *
     * Đây là API để tạo video từ ảnh bắt đầu (start image).
     * Sử dụng khi có mediaId từ frame cuối của video trước đó.
     *
     * API spec: Content-Type: text/plain;charset=UTF-8 (giống batchAsyncGenerateVideoText)
     *
     * @returns operation name (dùng để poll status)
     */
    async batchAsyncGenerateVideoStartImage(request, onRecaptchaComplete, onSubmitFired) {
        if (!this.config.accessToken) {
            throw new Error("Access token is required for video generation");
        }
        // ⚠️ Sync veo3ProjectId vào config trước khi gọi reCAPTCHA
        if (request.clientContext?.projectId) {
            this.updateConfig({ veo3ProjectId: request.clientContext.projectId });
        }
        return this.executeWithTokenRefresh(async () => {
            const url = `${this.sandboxBaseUrl}/video:batchAsyncGenerateVideoStartImage`;
            const firstReqSi = request.requests?.[0];
            logger.info(`📤 [API Monitor] Submit video (Start Image) count=${request.requests?.length || 0} project=${request.clientContext?.projectId?.substring(0, 12) || "N/A"} model=${firstReqSi?.videoModelKey || "N/A"} aspect=${firstReqSi?.aspectRatio || "N/A"} promptLen=${firstReqSi?.textInput?.prompt?.length || 0}${firstReqSi?.startImage?.mediaId ? ` startImg=${firstReqSi.startImage.mediaId.substring(0, 12)}` : ""}`);
            const batchId = crypto.randomUUID();
            const allOperations = [];
            const requestsCount = request.requests?.length || 0;
            const batchTokenResult = await this.requestRecaptchaTokens("VIDEO_GENERATION", requestsCount);
            if (batchTokenResult.length < requestsCount) {
                throw new Error(`Batch tokens insufficient for video-startimage: got ${batchTokenResult.length}, need ${requestsCount}`);
            }
            if (onRecaptchaComplete) {
                try {
                    await onRecaptchaComplete();
                }
                catch (_) {
                    /* non-blocking */
                }
            }
            for (let i = 0; i < requestsCount; i++) {
                const reqItem = request.requests[i];
                const tokenForThisRequest = batchTokenResult[i];
                const singleRequestBody = {
                    clientContext: {
                        ...request.clientContext,
                        recaptchaContext: {
                            token: tokenForThisRequest,
                            applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB",
                        },
                    },
                    mediaGenerationContext: {
                        batchId: batchId,
                        // Trước đây hàm này tự dựng `{ batchId }` và VỨT MẤT audioFailurePreference caller
                        // truyền vào → request lên Google thiếu hẳn field mà browser luôn gửi. Honour caller.
                        audioFailurePreference: request.mediaGenerationContext?.audioFailurePreference ??
                            "BLOCK_SILENCED_VIDEOS",
                    },
                    ...(request.useV2ModelConfig ? { useV2ModelConfig: true } : {}),
                    requests: [
                        {
                            ...reqItem,
                        },
                    ],
                };
                const xhrPromise3 = googleFetch({
                    profileId: this.config.profileId,
                    veo3ProjectId: this.config.veo3ProjectId,
                    locale: this.config.locale,
                    url,
                    method: "POST",
                    headers: this.getSandboxHeaders("text/plain;charset=UTF-8"),
                    body: JSON.stringify(singleRequestBody),
                    // Keep submit -> clr in the same page execution block to avoid
                    // out-of-band reset races on the wire.
                });
                // 🔓 Browser captcha lifecycle complete (1st request): XHR fired + clr sent.
                if (i === 0)
                    onSubmitFired?.();
                let response;
                try {
                    response = await xhrPromise3;
                }
                finally {
                }
                if (runtimeVerboseLogsEnabled()) {
                    logger.info(`📥 [API Monitor] Request ${i + 1}/${requestsCount} response status: ${response.status} ${response.statusText}`);
                }
                if (!response.ok) {
                    const errorText = await response.text();
                    const isRecaptcha403 = response.status === 403 &&
                        (errorText.includes("PUBLIC_ERROR_UNUSUAL_ACTIVITY") ||
                            errorText.includes("reCAPTCHA evaluation failed"));
                    if (isRecaptcha403) {
                        logger.warn(`⚠️ [API Monitor] Request ${i + 1}/${requestsCount} → 403 reCAPTCHA (silent retry)`);
                    }
                    else {
                        logger.error(`❌ [API Monitor] Request ${i + 1}/${requestsCount} API Error: ${response.status} - ${errorText.substring(0, 500)}`);
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
                    throw buildVeoApiError(`Failed to generate video with start image (request ${i + 1}/${requestsCount})`, response, errorText);
                }
                const responseData = await response.json();
                // Veo 3.1 lite tier có thể trả `{media:[...]}` thay vì `{operations:[...]}`
                // — fallback sang submit converter để upstream lưu providerJobId đúng.
                if (responseData.operations && responseData.operations.length > 0) {
                    allOperations.push(...responseData.operations);
                }
                else if (Array.isArray(responseData.media) &&
                    responseData.media.length > 0) {
                    const ourSceneId = reqItem?.metadata?.sceneId || "";
                    allOperations.push(...this.convertMediaArrayToSubmitOperations(responseData.media, ourSceneId));
                }
            }
            // "✅ Video generation start image completed" log dropped — TLS Submit covers it.
            return { operations: allOperations };
        });
    }
    /**
     * ✅ API: Upsample video to 1080p
     * POST /v1/video:batchAsyncGenerateVideoUpsampleVideo
     *
     * Đây là API để upsampling video lên 1080p.
     * Sử dụng model veo_2_1080p_upsampler_8s.
     *
     * API spec: Content-Type: application/json
     *
     * @returns operation name (dùng để poll status)
     */
    async batchAsyncGenerateVideoUpsampleVideo(request) {
        if (!this.config.accessToken) {
            throw new Error("Access token is required for video upsampling");
        }
        // ⚠️ Sync veo3ProjectId vào config trước khi gọi reCAPTCHA
        if (request.clientContext?.projectId) {
            this.updateConfig({ veo3ProjectId: request.clientContext.projectId });
        }
        return this.executeWithTokenRefresh(async () => {
            const url = `${this.sandboxBaseUrl}/video:batchAsyncGenerateVideoUpsampleVideo`;
            logger.info(`📤 [API Monitor] Submit video upsampling count=${request.requests?.length || 0} project=${request.clientContext?.projectId?.substring(0, 12) || "N/A"}`);
            const batchId = crypto.randomUUID();
            const allOperations = [];
            const requestsCount = request.requests?.length || 0;
            const batchTokenResult = await this.requestRecaptchaTokens("VIDEO_GENERATION", requestsCount);
            if (batchTokenResult.length < requestsCount) {
                throw new Error(`Batch tokens insufficient for upsample: got ${batchTokenResult.length}, need ${requestsCount}`);
            }
            for (let i = 0; i < requestsCount; i++) {
                const reqItem = request.requests[i];
                const tokenForThisRequest = batchTokenResult[i];
                const singleRequestBody = {
                    clientContext: {
                        ...request.clientContext,
                        recaptchaContext: {
                            token: tokenForThisRequest,
                            applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB",
                        },
                    },
                    // Merge caller's mediaGenerationContext (e.g. audioFailurePreference
                    // from Veo 3.1 upsampler) — batchId luôn override.
                    mediaGenerationContext: {
                        ...(request.mediaGenerationContext || {}),
                        batchId: batchId,
                    },
                    ...(request.useV2ModelConfig ? { useV2ModelConfig: true } : {}),
                    requests: [
                        {
                            ...reqItem,
                        },
                    ],
                };
                const xhrPromise4 = googleFetch({
                    profileId: this.config.profileId,
                    veo3ProjectId: this.config.veo3ProjectId,
                    locale: this.config.locale,
                    url,
                    method: "POST",
                    headers: this.getSandboxHeaders("application/json"),
                    body: JSON.stringify(singleRequestBody),
                    // Keep submit -> clr in the same page execution block to avoid
                    // out-of-band reset races on the wire.
                });
                // Upsample không nhận onSubmitFired callback — caller (VideoUpsamplingHandler)
                // tự release shared browser lock sau khi promise này resolve.
                let response;
                response = await xhrPromise4;
                if (runtimeVerboseLogsEnabled()) {
                    logger.info(`📥 [API Monitor] Request ${i + 1}/${requestsCount} response status: ${response.status} ${response.statusText}`);
                }
                if (!response.ok) {
                    const errorText = await response.text();
                    const isRecaptcha403 = response.status === 403 &&
                        (errorText.includes("PUBLIC_ERROR_UNUSUAL_ACTIVITY") ||
                            errorText.includes("reCAPTCHA evaluation failed"));
                    if (isRecaptcha403) {
                        logger.warn(`⚠️ [API Monitor] Request ${i + 1}/${requestsCount} → 403 reCAPTCHA (silent retry)`);
                    }
                    else {
                        logger.error(`❌ [API Monitor] Request ${i + 1}/${requestsCount} API Error: ${response.status} - ${errorText.substring(0, 500)}`);
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
                    let detailedMessage = errorText;
                    try {
                        const errorJson = JSON.parse(errorText);
                        if (errorJson.error?.message) {
                            detailedMessage = errorJson.error.message;
                        }
                    }
                    catch (e) { }
                    throw new Error(`Failed to upsample video (request ${i + 1}/${requestsCount}): ${response.statusText} - ${detailedMessage}`);
                }
                const responseData = await response.json();
                // Veo 3.1 lite tier có thể trả `{media:[...]}` thay vì `{operations:[...]}`
                // — fallback sang submit converter để upstream lưu providerJobId đúng.
                if (responseData.operations && responseData.operations.length > 0) {
                    allOperations.push(...responseData.operations);
                }
                else if (Array.isArray(responseData.media) &&
                    responseData.media.length > 0) {
                    const ourSceneId = reqItem?.metadata?.sceneId || "";
                    allOperations.push(...this.convertMediaArrayToSubmitOperations(responseData.media, ourSceneId));
                }
            }
            // "✅ Video upsampling completed" log dropped — TLS Submit covers it.
            return { operations: allOperations };
        });
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
        if (!this.config.accessToken) {
            throw new Error("Access token is required for image upsampling");
        }
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
                    logger.warn(`⚠️ [API Monitor] BOQ RPC (SPrCad) failed (${boqErr?.message || String(boqErr)}), falling back to REST endpoint...`);
                }
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
     * Generate reference images for characters (Imagen/Banana/GemPix)
     * POST /projects/{projectId}/flowMedia:batchGenerateImages
     */
    async generateCharacterImages(options) {
        if (!this.config.accessToken) {
            throw new Error("Access token is required for image generation");
        }
        // ⚠️ Sync veo3ProjectId vào config trước khi gọi reCAPTCHA — nếu không, browser sẽ
        // load homepage `labs.google/fx/tools/flow` thay vì project page → action↔location mismatch.
        if (options.projectId) {
            this.updateConfig({ veo3ProjectId: options.projectId });
        }
        const outputs = Math.min(Math.max(options.outputs ?? 1, 1), 4);
        const aspectRatio = options.imageAspectRatio || "IMAGE_ASPECT_RATIO_LANDSCAPE";
        // SessionId format: ";{timestamp}" - API requires semicolon prefix.
        // \ud83d\udd10 REAL BROWSER: gi\u1eef sessionId c\u1ed1 \u0111\u1ecbnh xuy\u00ean su\u1ed1t browser session
        // per (profile, veo3Project) \u2014 m\u1ed7i project l\u00e0 1 tab ri\u00eang tr\u00ean labs.google.
        const sessionId = options.sessionId ||
            (this.config.profileId
                ? sessionIdManager.get(this.config.profileId, options.projectId)
                : `;${Date.now()}`);
        const seeds = options.seeds && options.seeds.length >= outputs
            ? options.seeds.slice(0, outputs)
            : Array.from({ length: outputs }, () => Math.floor(Math.random() * 1000000));
        // Build imageInputs from referenceImageMediaIds. Veo3 requires UUID format
        // for `imageInputs[].name` — extractUUIDFromMediaId decodes CAMa proto when needed.
        const imageInputs = (options.referenceImageMediaIds || []).map((mediaId) => ({
            name: extractUUIDFromMediaId(mediaId),
            imageInputType: (options.imageInputType ||
                "IMAGE_INPUT_TYPE_REFERENCE"),
        }));
        const batchId = crypto.randomUUID();
        return this.executeWithTokenRefresh(async () => {
            // ⚠️ Lấy TẤT CẢ token cùng lúc trong 1 browser session để đảm bảo:
            //   1. Tất cả token có cùng UA, cookies, project page, warmth state
            //   2. Token gen cách nhau ~30ms thay vì 10-25s (queue serialized)
            //   3. Time gap token→API call ngắn → không bị Google flag stale token
            const batchTokenResult = await this.requestRecaptchaTokens("IMAGE_GENERATION", outputs);
            if (batchTokenResult.length < outputs) {
                throw new Error(`Batch tokens insufficient: got ${batchTokenResult.length}, need ${outputs}`);
            }
            const processSeed = async (seed, index) => {
                const tokenForThisRequest = batchTokenResult[index];
                // ⚠️ Field order khớp real browser: { recaptchaContext, projectId, tool, sessionId }
                // và requests[0]: { clientContext, imageModelName, imageAspectRatio, structuredPrompt, seed, imageInputs }
                const requestBody = {
                    clientContext: {
                        recaptchaContext: {
                            token: tokenForThisRequest,
                            applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB",
                        },
                        projectId: options.projectId,
                        tool: "PINHOLE",
                        sessionId,
                    },
                    mediaGenerationContext: {
                        batchId,
                    },
                    useNewMedia: true,
                    requests: [
                        {
                            clientContext: {
                                recaptchaContext: {
                                    token: tokenForThisRequest,
                                    applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB",
                                },
                                projectId: options.projectId,
                                tool: "PINHOLE",
                                sessionId,
                            },
                            imageModelName: options.imageModelName,
                            imageAspectRatio: aspectRatio,
                            structuredPrompt: {
                                parts: [
                                    {
                                        text: options.prompt,
                                    },
                                ],
                            },
                            seed,
                            imageInputs: imageInputs.length > 0 ? imageInputs : [], // Always include as array
                        },
                    ],
                };
                const url = `${this.sandboxBaseUrl}/projects/${options.projectId}/flowMedia:batchGenerateImages`;
                logger.info(`📸 [Character Images] Generating image ${index + 1}/${outputs} using ${options.imageModelName} (${aspectRatio})`);
                // 🔍 DEBUG: Log exact imageInputs and sessionId being sent
                if (runtimeVerboseLogsEnabled()) {
                    logger.info(`🔍 [imageInputs] imageInputs for seed=${seed}:`, JSON.stringify(imageInputs));
                    logger.info(`🔍 [sessionId] sessionId format: "${sessionId}"`);
                }
                // ⚠️ NO pre-gen telemetry POST. Real Flow does not emit a per-gen
                // pre-log on the wire (see captures/flowai-lifecycle-*.json) — every
                // pre-gen `:batchLog` we used to send was a per-gen burst signal that
                // helped Google reCAPTCHA Enterprise score this profile as bot.
                // Post-gen events go through the buffered FlowTelemetry path instead.
                const submitStartMs = Date.now();
                const xhrPromise = googleFetch({
                    profileId: this.config.profileId,
                    veo3ProjectId: this.config.veo3ProjectId,
                    locale: this.config.locale,
                    url,
                    method: "POST",
                    headers: this.getSandboxHeaders("text/plain"),
                    body: JSON.stringify(requestBody),
                    timeoutMs: Number(process.env.IMAGE_GEN_TIMEOUT_MS) || 240000,
                    // Real-Chrome path: trigger clr from the same in-page JS block
                    // immediately after xhr.send() to guarantee wire order:
                });
                // Release the per-profile mint lock as soon as the submit is on the
                // wire (mint → submit on the wire). Captcha extension handles
                // _grecaptcha strip pre/post mint, so no clr signal needed here.
                options.onSubmitFired?.();
                let response;
                try {
                    response = await xhrPromise;
                }
                finally {
                }
                if (!response.ok) {
                    const errorText = await response.text();
                    logger.error(`❌ [Character Images] Seed #${index} API Error: ${response.status} - ${errorText.substring(0, 200)}`);
                    if (response.status === 429) {
                        // Phân biệt 2 nhóm 429 (xem thêm nhánh batch bên dưới):
                        //  - TOO_MUCH_TRAFFIC: trần tốc độ per-account TẠM THỜI → queue manager nghỉ dài dần (2→5→10 phút) rồi retry.
                        //  - 429 thường (gen quá nhanh): giữ nguyên delay 30s + retry.
                        // Daily-quota-thật trả về PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED_UPGRADEABLE qua status khác.
                        const isTransientTrafficLimit = typeof errorText === "string" &&
                            errorText.includes("PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC");
                        const error = new Error(isTransientTrafficLimit
                            ? `Rate limit (Mã 429 TOO_MUCH_TRAFFIC): Google đang giới hạn tốc độ tài khoản, sẽ tự retry sau vài phút.`
                            : `Rate limit (Mã 429): Gen quá nhanh, sẽ tự retry sau 30s.`);
                        error.response = response;
                        error.errorText = errorText;
                        if (isTransientTrafficLimit)
                            error.isTransientTrafficLimit = true;
                        throw error;
                    }
                    if (response.status >= 500) {
                        const error = new Error(`Lỗi Google (Mã ${response.status}): Hệ thống Google đang gặp sự cố. Vui lòng thử lại sau!`);
                        error.response = response;
                        error.errorText = errorText;
                        error.isGoogleServerError = true; // tag để retry nhanh (5-10s) thay vì 60s
                        throw error;
                    }
                    // 403 + reCAPTCHA failure = browser session score thấp, không phải auth error.
                    if (response.status === 403 &&
                        (errorText.includes("PUBLIC_ERROR_UNUSUAL_ACTIVITY") ||
                            errorText.includes("reCAPTCHA evaluation failed"))) {
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
                    const friendlyMessage = parseVeo3Error(errorText, `Failed to generate character image ${index}: ${response.statusText}`);
                    const error = new Error(friendlyMessage);
                    error.response = response;
                    error.errorText = errorText;
                    throw error;
                }
                const responseJson = await response.json();
                const mediaItems = Array.isArray(responseJson.media)
                    ? responseJson.media
                    : [];
                if (mediaItems.length === 0) {
                    throw new Error(`No media returned for image ${index}`);
                }
                const media = mediaItems[0];
                const generated = media?.image?.generatedImage || media?.generatedImage || {};
                const mediaGenerationId = generated.mediaGenerationId || media?.name || "";
                // Fire-and-forget: post-gen telemetry log với latency
                this.fireImageGenLogs({
                    sessionId,
                    imageModelName: options.imageModelName,
                    aspectRatio,
                    refImageCount: imageInputs.length,
                    outputsPerPrompt: 1,
                    phase: "after",
                    latencyMs: Date.now() - submitStartMs,
                });
                return {
                    name: media?.name,
                    seed: generated.seed,
                    prompt: generated.prompt,
                    aspectRatio: generated.aspectRatio,
                    modelNameType: generated.modelNameType || options.imageModelName,
                    encodedImage: generated.encodedImage,
                    fifeUrl: generated.fifeUrl,
                    mediaGenerationId,
                    veoMediaId: mediaGenerationId,
                };
            };
            const timeoutId = setTimeout(() => {
                throw new Error("Image generation timed out sau 180 giây.");
            }, options.timeoutMs ?? 180000);
            try {
                logger.info(`🚀 [Character Images] Submitting ${outputs} sequential requests with batchId=${batchId}...`);
                // Sequential execution: chạy tuần tự thay vì parallel để tránh concurrent XHR
                // qua cùng 1 browser window. Image gen đồng bộ (30-60s/request) → nhiều XHR
                // chạy cùng lúc → Google phát hiện burst activity → reCAPTCHA score thấp → 403.
                // Video gen dùng sequential for+await và không bị vì mỗi request async chỉ ~1s.
                const results = [];
                for (let i = 0; i < seeds.length; i++) {
                    const result = await processSeed(seeds[i], i);
                    results.push(result);
                }
                logger.info(`✅ [Character Images] successfully grabbed all ${results.length} images.`);
                return results;
            }
            catch (error) {
                if (error?.name === "AbortError" ||
                    error?.message?.includes("timed out")) {
                    throw new Error("Image generation timed out sau 180 giây.");
                }
                throw error;
            }
            finally {
                clearTimeout(timeoutId);
            }
        });
    }
    /**
     * Generate multiple images with DIFFERENT prompts in a single batch request
     * POST /projects/{projectId}/flowMedia:batchGenerateImages
     * Max 4 prompts per batch for optimal performance
     *
     * This is more efficient than calling generateCharacterImages multiple times
     * because it uses a single reCAPTCHA token for multiple images
     */
    async generateBatchImages(options) {
        if (!this.config.accessToken) {
            throw new Error("Access token is required for batch image generation");
        }
        // ⚠️ Sync veo3ProjectId vào config trước khi gọi reCAPTCHA — bắt buộc để Google
        // bind được action ↔ project page (xem comment ở generateCharacterImages).
        if (options.projectId) {
            this.updateConfig({ veo3ProjectId: options.projectId });
        }
        const maxBatchSize = 20;
        if (options.prompts.length > maxBatchSize) {
            throw new Error(`Batch size exceeds maximum of ${maxBatchSize} prompts. Got ${options.prompts.length}`);
        }
        if (options.prompts.length === 0) {
            return [];
        }
        const aspectRatio = options.imageAspectRatio || "IMAGE_ASPECT_RATIO_LANDSCAPE";
        const rawSessionId = options.sessionId ||
            (this.config.profileId
                ? sessionIdManager.get(this.config.profileId, options.projectId)
                : `;${Date.now()}`);
        const sessionId = rawSessionId.startsWith(";")
            ? rawSessionId
            : `;${rawSessionId}`;
        // Mỗi sản phẩm là một request batch riêng; các ảnh đầu ra của chính sản
        // phẩm đó dùng chung batchId này, đúng cơ chế Veo3 Gen.
        const batchId = crypto.randomUUID();
        return this.executeWithTokenRefresh(async () => {
            // ⚠️ Lấy N token cùng lúc để mọi request trong batch có cùng UA, cookies, project page,
            // warmth state. Tránh queue serialize + giảm time gap token→API.
            const promptCount = options.prompts.length;
            const batchTokenResult = await this.requestRecaptchaTokens("IMAGE_GENERATION", promptCount);
            if (batchTokenResult.length < promptCount) {
                throw new Error(`Batch tokens insufficient: got ${batchTokenResult.length}, need ${promptCount}`);
            }
            // 🔔 Callback ngay khi đã có toàn bộ token (UI cập nhật progress)
            if (options.onRecaptchaComplete) {
                try {
                    await options.onRecaptchaComplete();
                }
                catch (_) {
                    /* non-blocking */
                }
            }
            // Create a function to process a single prompt to run them in parallel
            const processPrompt = async (promptConfig, index) => {
                const tokenForThisRequest = batchTokenResult[index];
                const seed = promptConfig.seed ?? Math.floor(Math.random() * 1000000);
                // Build imageInputs if referenceImageMediaIds provided. Veo3 expects UUID
                // format for `imageInputs[].name` — convert CAMa→UUID when needed.
                const imageInputs = (promptConfig.referenceImageMediaIds || []).map((mediaId) => ({
                    name: extractUUIDFromMediaId(mediaId),
                    imageInputType: (promptConfig.imageInputType ||
                        "IMAGE_INPUT_TYPE_REFERENCE"),
                }));
                if (runtimeVerboseLogsEnabled()) {
                    logger.info(`📋 [Batch Images] Request #${index}: seed=${seed}, refImages=${promptConfig.referenceImageMediaIds?.length || 0}`);
                }
                if (imageInputs.length > 0 && runtimeVerboseLogsEnabled()) {
                    logger.info(`🔍 [Batch Images] imageInputs for seed=${seed}:`, JSON.stringify(imageInputs));
                    logger.info(`🔍 [Batch Images] promptConfig.imageInputType:`, promptConfig.imageInputType || "(default)");
                }
                // ⚠️ Field order: { recaptchaContext, projectId, tool, sessionId } — khớp real browser
                // (verified qua capture tool). Tool cũ gửi { recaptchaContext, sessionId, projectId, tool }
                // → server bình thường không care, nhưng safer match thứ tự thật để tránh edge case.
                // requests[0] order: { clientContext, imageModelName, imageAspectRatio, structuredPrompt, seed, imageInputs }.
                const requestBody = {
                    clientContext: {
                        recaptchaContext: {
                            token: tokenForThisRequest,
                            applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB",
                        },
                        projectId: options.projectId,
                        tool: "PINHOLE",
                        sessionId,
                    },
                    mediaGenerationContext: {
                        batchId: batchId,
                    },
                    useNewMedia: true,
                    requests: [
                        {
                            clientContext: {
                                recaptchaContext: {
                                    token: tokenForThisRequest,
                                    applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB",
                                },
                                projectId: options.projectId,
                                tool: "PINHOLE",
                                sessionId,
                            },
                            imageModelName: options.imageModelName,
                            imageAspectRatio: aspectRatio,
                            structuredPrompt: {
                                parts: [
                                    {
                                        text: promptConfig.prompt,
                                    },
                                ],
                            },
                            seed,
                            imageInputs: imageInputs.length > 0 ? imageInputs : [], // Always include as array
                        },
                    ],
                };
                const url = `${this.sandboxBaseUrl}/projects/${options.projectId}/flowMedia:batchGenerateImages`;
                // Full request-body dump (prompt HEAD/MID/TAIL, imageInputs, headers)
                // gated behind VEO3_BATCH_VERBOSE=1 — useful for diagnosing 500
                // INTERNAL from Veo3 imagen but ~6 lines per submit otherwise.
                if (runtimeVerboseLogsEnabled() ||
                    process.env.VEO3_BATCH_VERBOSE === "1") {
                    const promptText = requestBody.requests?.[0]?.structuredPrompt?.parts?.[0]?.text ?? "";
                    logger.info(`[Batch Images] body meta seed=${seed} model=${options.imageModelName} aspect=${aspectRatio} promptLen=${promptText.length} project=${options.projectId} batchId=${batchId}`);
                }
                // \u23f1\ufe0f Image gen API timeout \u2014 default 120s, override via env
                // IMAGE_GEN_TIMEOUT_MS. GEM_PIX_2 normal ~10-15s, BELUGA multi-ref
                // ~30-60s. Bumped 120s \u2192 240s sau khi th\u1ea5y Google response peak load
                // c\u00f3 th\u1ec3 >120s (timeout 125s = 120 + 5s host overhead \u2192 fail oan request
                // h\u1ee3p l\u1ec7 ch\u1eadm). 240s ceiling absorbs slow lane while still capping
                // true browser hang.
                // \u26a0\ufe0f KH\u00d4NG retry inline khi network error \u2014 reCAPTCHA token l\u00e0 SINGLE-USE.
                const IMAGE_GEN_TIMEOUT_MS = Number(process.env.IMAGE_GEN_TIMEOUT_MS) || 240000;
                const abortController = new AbortController();
                const timeoutId = setTimeout(() => abortController.abort(), IMAGE_GEN_TIMEOUT_MS);
                // ⚠️ NO pre-gen telemetry POST — see processSeed in generateCharacterImages
                // for the rationale. Per-gen pre-log was a bot fingerprint absent in real
                // Flow; post-gen events use the buffered FlowTelemetry path now.
                const submitStartMs = Date.now();
                let response;
                try {
                    // Submit via Node TLS (chrome_131_PSK JA3) so the captcha token's
                    // fingerprint matches the request. Pass timeoutMs explicitly because
                    // Google image gen response can run up to ~2 minutes.
                    const xhrPromise = googleFetch({
                        profileId: this.config.profileId,
                        veo3ProjectId: this.config.veo3ProjectId,
                        locale: this.config.locale,
                        url,
                        method: "POST",
                        headers: this.getSandboxHeaders("text/plain"),
                        body: JSON.stringify(requestBody),
                        timeoutMs: IMAGE_GEN_TIMEOUT_MS,
                    });
                    // Fire onSubmitFired at SUBMIT-START (first POST on the wire) so the
                    // inter-batch delay is measured from submit, not batch completion —
                    // this is what enables delay-from-submit pipelining. Only index 0 fires
                    // it, so handleSubmitFired counts ONE submit per burst (matches the
                    // video path's `if (i === 0) onSubmitFired?.()`).
                    if (index === 0)
                        options.onSubmitFired?.();
                    response = await xhrPromise;
                }
                catch (err) {
                    clearTimeout(timeoutId);
                    if (err?.name === "AbortError") {
                        logger.error(`⏱️ [Batch Images] Set #${index} TIMEOUT after ${IMAGE_GEN_TIMEOUT_MS}ms — will retry với token mới`);
                        const error = new Error(`Image gen timeout: Google không phản hồi trong ${IMAGE_GEN_TIMEOUT_MS / 1000}s. Tự động retry với token mới.`);
                        error.isTimeout = true;
                        error.isRetryable = true;
                        throw error;
                    }
                    // Network error — bubble lên để job retry lấy fresh token
                    const errCode = err?.cause?.code || err?.code || err?.message || "unknown";
                    logger.error(`🌐 [Batch Images] Set #${index} network err (${errCode}) — will retry với token mới`);
                    const netError = new Error(`Image gen network error (${errCode}). Token có thể đã bị consume — retry với token mới.`);
                    netError.isRetryable = true;
                    netError.cause = err;
                    throw netError;
                }
                clearTimeout(timeoutId);
                if (!response.ok) {
                    const errorText = await response.text();
                    logger.error(`❌ [Batch Images] Set #${index} API Error: ${response.status} - ${errorText.substring(0, 500)}`);
                    // Diagnostic context dump on ANY error response. Split into multiple
                    // logger.error calls so pino's per-message truncation doesn't drop
                    // the imageInputs and prompt previews (single dump was hitting the
                    // ~900-char limit and we lost everything past imageAspectRatio).
                    const promptText = requestBody.requests?.[0]?.structuredPrompt?.parts?.[0]?.text ?? "";
                    logger.error(`🔍 [Batch Images] Error meta (status=${response.status}, seed=${seed}, model=${options.imageModelName}, aspect=${aspectRatio}, project=${options.projectId}, sessionId=${sessionId}, batchId=${batchId}, recaptchaTokenLen=${tokenForThisRequest?.length ?? 0})`);
                    logger.error(`🔍 [Batch Images] Error imageInputs (count=${imageInputs.length}): ${JSON.stringify(imageInputs.map((i) => ({ name: i.name, type: i.imageInputType })))}`);
                    logger.error(`🔍 [Batch Images] Error prompt (len=${promptText.length}) HEAD: ${promptText.slice(0, 400)}`);
                    logger.error(`🔍 [Batch Images] Error prompt TAIL: ${promptText.slice(-300)}`);
                    if (response.status === 400) {
                        // 400 = prompt vi phạm content policy hoặc invalid argument → không retry
                        const error = new Error(`Prompt bị từ chối (Mã 400): Nội dung không hợp lệ hoặc vi phạm chính sách. Vui lòng sửa prompt.`);
                        error.response = response;
                        error.errorText = errorText;
                        error.isNonRetryable = true;
                        throw error;
                    }
                    if (response.status === 429) {
                        // Phân biệt 2 nhóm 429:
                        //  - TOO_MUCH_TRAFFIC: trần tốc độ per-account TẠM THỜI → queue manager nghỉ dài dần (2→5→10 phút) rồi retry.
                        //  - 429 thường (gen quá nhanh): giữ nguyên delay 30s + retry.
                        const isTransientTrafficLimit = typeof errorText === "string" &&
                            errorText.includes("PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC");
                        const error = new Error(isTransientTrafficLimit
                            ? `Rate limit (Mã 429 TOO_MUCH_TRAFFIC): Google đang giới hạn tốc độ tài khoản, sẽ tự retry sau vài phút.`
                            : `Rate limit (Mã 429): Gen quá nhanh, sẽ tự retry sau 30s.`);
                        error.response = response;
                        error.errorText = errorText;
                        if (isTransientTrafficLimit)
                            error.isTransientTrafficLimit = true;
                        throw error;
                    }
                    if (response.status >= 500) {
                        const error = new Error(`Lỗi Google (Mã ${response.status}): Hệ thống Google đang gặp sự cố. Vui lòng thử lại sau!`);
                        error.response = response;
                        error.errorText = errorText;
                        error.isGoogleServerError = true; // tag để retry nhanh (5-10s) thay vì 60s
                        throw error;
                    }
                    // 403 + reCAPTCHA failure = browser session score quá thấp.
                    // Token refresh KHÔNG giúp — cần force recreate browser để reset score.
                    if (response.status === 403 &&
                        (errorText.includes("PUBLIC_ERROR_UNUSUAL_ACTIVITY") ||
                            errorText.includes("reCAPTCHA evaluation failed"))) {
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
                    throw buildVeoApiError(`Failed to generate batch image ${index}`, response, errorText);
                }
                const responseJson = await response.json();
                const mediaItems = Array.isArray(responseJson.media)
                    ? responseJson.media
                    : [];
                if (mediaItems.length === 0) {
                    throw new Error(`No media returned for batch image ${index}`);
                }
                const media = mediaItems[0];
                const generated = media?.image?.generatedImage || media?.generatedImage || {};
                const mediaGenerationId = generated.mediaGenerationId || media?.name || "";
                // Fire-and-forget: post-gen telemetry log với latency
                this.fireImageGenLogs({
                    sessionId,
                    imageModelName: options.imageModelName,
                    aspectRatio,
                    refImageCount: imageInputs.length,
                    outputsPerPrompt: 1,
                    phase: "after",
                    latencyMs: Date.now() - submitStartMs,
                });
                return {
                    promptIndex: index,
                    name: media?.name,
                    seed: generated.seed,
                    prompt: generated.prompt,
                    aspectRatio: generated.aspectRatio,
                    modelNameType: generated.modelNameType || options.imageModelName,
                    encodedImage: generated.encodedImage,
                    fifeUrl: generated.fifeUrl,
                    mediaGenerationId,
                    veoMediaId: mediaGenerationId,
                };
            };
            try {
                logger.info(`🚀 [Batch Images] Submitting ${options.prompts.length} near-parallel requests with batchId=${batchId}...`);
                // Near-parallel execution — khớp capture THẬT của Veo3: N POST bắn gần như
                // cạnh nhau, CHUNG 1 batchId, mỗi POST 1 token riêng (đã mint sẵn theo lô ở
                // trên). Comment "tuần tự chống burst-403" CŨ đã bị bác bỏ bằng capture:
                // batchId chung mới là tín hiệu an toàn của Google, không phải timing tuần tự.
                // Fallback nếu 403 tăng: thêm `await new Promise(r => setTimeout(r, 30 * i))`
                // ở đầu processPrompt (~30ms stagger, khớp khoảng cách token native).
                // onSubmitFired is fired at submit-START inside processPrompt (index 0),
                // NOT here — so the inter-batch delay counts from submit, enabling the
                // bounded pipeline (batch N+1 may submit delaySeconds after batch N started).
                const settled = await Promise.allSettled(options.prompts.map((prompt, i) => processPrompt(prompt, i)));
                const results = [];
                let firstError = null;
                for (const outcome of settled) {
                    if (outcome.status === "fulfilled") {
                        results.push(outcome.value);
                    }
                    else if (!firstError) {
                        firstError = outcome.reason;
                    }
                }
                if (firstError) {
                    // Toàn burst dùng chung score/session nên 403 thường all-or-nothing;
                    // partial failure (vài ảnh xong + vài ảnh lỗi) hiếm. Giữ hành vi cũ:
                    // ném lỗi đầu tiên → caller requeue cả đợt. (Partial-success reclaim là
                    // follow-up B5, cố tình để ngoài path 403 nhạy cảm.)
                    throw firstError;
                }
                logger.info(`✅ [Batch Images] successfully mapped all ${results.length} images.`);
                return results;
            }
            catch (error) {
                throw error;
            }
        });
    }
    /**
     * ✅ API: Generate video from start and end images (frame-to-frame)
     * POST /v1/video:batchAsyncGenerateVideoStartAndEndImage
     *
     * Đây là API để tạo video từ ảnh bắt đầu và ảnh kết thúc (frame-to-frame).
     * Sử dụng khi có cả startImageMediaId và endImageMediaId.
     *
     * API spec: Content-Type: text/plain;charset=UTF-8
     *
     * @returns operation name (dùng để poll status)
     */
    async batchAsyncGenerateVideoStartAndEndImage(request, // Uses same type frame-to-frame
    onRecaptchaComplete, onSubmitFired) {
        if (!this.config.accessToken) {
            throw new Error("Access token is required for video generation");
        }
        // ⚠️ Sync veo3ProjectId vào config trước khi gọi reCAPTCHA
        if (request.clientContext?.projectId) {
            this.updateConfig({ veo3ProjectId: request.clientContext.projectId });
        }
        return this.executeWithTokenRefresh(async () => {
            const url = `${this.sandboxBaseUrl}/video:batchAsyncGenerateVideoStartAndEndImage`;
            logger.info(`📤 [API Monitor] Submit video (Start+End Image) count=${request.requests?.length || 0} project=${request.clientContext?.projectId?.substring(0, 12) || "N/A"}`);
            const batchId = crypto.randomUUID();
            const allOperations = [];
            const requestsCount = request.requests?.length || 0;
            const batchTokenResult = await this.requestRecaptchaTokens("VIDEO_GENERATION", requestsCount);
            if (batchTokenResult.length < requestsCount) {
                throw new Error(`Batch tokens insufficient for video-startend: got ${batchTokenResult.length}, need ${requestsCount}`);
            }
            if (onRecaptchaComplete) {
                try {
                    await onRecaptchaComplete();
                }
                catch (_) {
                    /* non-blocking */
                }
            }
            for (let i = 0; i < requestsCount; i++) {
                const reqItem = request.requests[i];
                const tokenForThisRequest = batchTokenResult[i];
                const singleRequestBody = {
                    clientContext: {
                        ...request.clientContext,
                        recaptchaContext: {
                            token: tokenForThisRequest,
                            applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB",
                        },
                    },
                    mediaGenerationContext: {
                        batchId: batchId,
                        audioFailurePreference: request.mediaGenerationContext?.audioFailurePreference ??
                            "BLOCK_SILENCED_VIDEOS",
                    },
                    ...(request.useV2ModelConfig ? { useV2ModelConfig: true } : {}),
                    requests: [
                        {
                            ...reqItem,
                        },
                    ],
                };
                const xhrPromise5 = googleFetch({
                    profileId: this.config.profileId,
                    veo3ProjectId: this.config.veo3ProjectId,
                    locale: this.config.locale,
                    url,
                    method: "POST",
                    headers: this.getSandboxHeaders("text/plain;charset=UTF-8"),
                    body: JSON.stringify(singleRequestBody),
                    // Keep submit -> clr in the same page execution block to avoid
                    // out-of-band reset races on the wire.
                });
                // 🔓 Browser captcha lifecycle complete (1st request): XHR fired + clr sent.
                if (i === 0)
                    onSubmitFired?.();
                let response;
                try {
                    response = await xhrPromise5;
                }
                finally {
                }
                if (runtimeVerboseLogsEnabled()) {
                    logger.info(`📥 [API Monitor] Request ${i + 1}/${requestsCount} response status: ${response.status} ${response.statusText}`);
                }
                if (!response.ok) {
                    const errorText = await response.text();
                    const isRecaptcha403 = response.status === 403 &&
                        (errorText.includes("PUBLIC_ERROR_UNUSUAL_ACTIVITY") ||
                            errorText.includes("reCAPTCHA evaluation failed"));
                    if (isRecaptcha403) {
                        logger.warn(`⚠️ [API Monitor] Request ${i + 1}/${requestsCount} → 403 reCAPTCHA (silent retry)`);
                    }
                    else {
                        logger.error(`❌ [API Monitor] Request ${i + 1}/${requestsCount} API Error: ${response.status} - ${errorText.substring(0, 500)}`);
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
                    throw buildVeoApiError(`Failed to generate video with start and end images (request ${i + 1}/${requestsCount})`, response, errorText);
                }
                const responseData = await response.json();
                // Veo 3.1 lite tier có thể trả `{media:[...]}` thay vì `{operations:[...]}`
                // — fallback sang submit converter để upstream lưu providerJobId đúng.
                if (responseData.operations && responseData.operations.length > 0) {
                    allOperations.push(...responseData.operations);
                }
                else if (Array.isArray(responseData.media) &&
                    responseData.media.length > 0) {
                    const ourSceneId = reqItem?.metadata?.sceneId || "";
                    allOperations.push(...this.convertMediaArrayToSubmitOperations(responseData.media, ourSceneId));
                }
            }
            // "✅ Video generation start+end image completed" log dropped — TLS Submit covers it.
            return { operations: allOperations };
        });
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
     * ✅ API CHÍNH: Check status + lấy video URL
     * POST /v1/video:batchCheckAsyncVideoGenerationStatus
     *
     * Đây là API chính để check status và lấy video URL khi hoàn thành.
     *
     * @returns status và videoUrl (nếu đã hoàn thành)
     */
    async batchCheckAsyncVideoGenerationStatus(request, retryCount = 0, maxRetries = 3) {
        if (!this.config.accessToken) {
            throw new Error("Access token is required for status check");
        }
        return this.executeWithTokenRefresh(async () => {
            const url = `${this.sandboxBaseUrl}/video:batchCheckAsyncVideoGenerationStatus`;
            if (runtimeVerboseLogsEnabled()) {
                logger.info(`📤 [Poll Status] Requesting status check`, {
                    url,
                    operationsCount: request.operations?.length || 0,
                    operationNames: request.operations
                        ?.map((op) => op.operation?.name?.substring(0, 20))
                        .join(", ") || "N/A",
                    sceneIds: request.operations?.map((op) => op.sceneId).join(", ") ||
                        "N/A",
                });
            }
            const requestBody = JSON.stringify(request);
            // Log actual request body for debugging (to compare with curl example)
            if (runtimeVerboseLogsEnabled()) {
                logger.info(`📤 [Poll Status] Request body:`, requestBody);
            }
            try {
                const response = await googleFetch({
                    profileId: this.config.profileId,
                    veo3ProjectId: this.config.veo3ProjectId,
                    locale: this.config.locale,
                    url,
                    method: "POST",
                    headers: this.getSandboxHeaders(),
                    body: requestBody,
                });
                if (runtimeVerboseLogsEnabled()) {
                    logger.info(`📥 [Poll Status] Response status: ${response.status} ${response.statusText}`);
                }
                // Check for 500 error and retry
                if (response.status === 500) {
                    if (retryCount < maxRetries) {
                        const waitTime = (retryCount + 1) * 1000; // Exponential backoff: 1s, 2s, 3s
                        logger.warn(`⚠️  [Poll Status] Server error 500, retrying ${retryCount + 1}/${maxRetries} after ${waitTime}ms...`);
                        await new Promise((resolve) => setTimeout(resolve, waitTime));
                        return this.batchCheckAsyncVideoGenerationStatus(request, retryCount + 1, maxRetries);
                    }
                    else {
                        const errorText = await response.text();
                        logger.error(`❌ [Poll Status] Server error 500 after ${maxRetries} retries`);
                        logger.error(`   Error details: ${errorText.substring(0, 200)}...`);
                        throw new Error(`Server error 500 after ${maxRetries} retries: ${errorText}`);
                    }
                }
                if (!response.ok) {
                    const errorText = await response.text();
                    logger.error(`❌ [Poll Status] API Error: ${response.status} - ${errorText}`);
                    if (this.isAuthError(response, errorText)) {
                        const error = new Error("Access token đã hết hạn hoặc không hợp lệ.");
                        error.response = response;
                        error.errorText = errorText;
                        throw error;
                    }
                    throw new Error(`Failed to check video status: ${response.statusText} - ${errorText}`);
                }
                const responseData = await response.json();
                // Backward-compatible response normalization.
                // Một số account/tier (Veo 3.1 r2v lite/ultra) trả `{media:[...]}` thay vì
                // `{operations:[...]}` cho cùng request body. Ưu tiên operations[] (shape cũ);
                // fallback sang media[] đã convert nếu operations[] thiếu/rỗng.
                const hasLegacyOps = Array.isArray(responseData?.operations) &&
                    responseData.operations.length > 0;
                const hasNewMedia = Array.isArray(responseData?.media) && responseData.media.length > 0;
                if (!hasLegacyOps && hasNewMedia) {
                    const nameToSceneId = new Map();
                    for (const op of request.operations || []) {
                        const name = op?.operation?.name;
                        const sceneId = op?.sceneId;
                        if (name && sceneId)
                            nameToSceneId.set(name, sceneId);
                    }
                    responseData.operations = this.convertMediaArrayToPollOperations(responseData.media, nameToSceneId);
                    if (runtimeVerboseLogsEnabled()) {
                        logger.info(`📋 [Poll Status] Detected NEW shape {media}, converted ${responseData.operations.length} entries → legacy {operations}`);
                    }
                }
                else if (hasLegacyOps && hasNewMedia) {
                    // Edge case: cả hai shape đồng thời. Ưu tiên operations[] theo policy.
                    logger.warn(`[Poll Status] Response chứa CẢ operations[] và media[] — dùng operations[] theo policy`);
                }
                if (runtimeVerboseLogsEnabled()) {
                    logger.info(`📋 [Poll Status] Response data:`, {
                        operationsCount: responseData.operations?.length || 0,
                        operations: responseData.operations?.map((op) => ({
                            operationName: op.operation?.name?.substring(0, 20),
                            status: op.status,
                            sceneId: op.sceneId,
                        })) || [],
                    });
                }
                return responseData;
            }
            catch (error) {
                // If it's a 500 error from fetch, retry
                if (error.message &&
                    error.message.includes("500") &&
                    retryCount < maxRetries) {
                    const waitTime = (retryCount + 1) * 1000;
                    logger.warn(`⚠️  [Poll Status] Network error, retrying ${retryCount + 1}/${maxRetries} after ${waitTime}ms...`);
                    await new Promise((resolve) => setTimeout(resolve, waitTime));
                    return this.batchCheckAsyncVideoGenerationStatus(request, retryCount + 1, maxRetries);
                }
                throw error;
            }
        });
    }
    async getMediaUrlRedirect(mediaId, projectId, mediaUrlType) {
        if (!mediaId)
            return null;
        // Explicit type → single call. No type → probe (cached winner first), and
        // only accept a Location that points at the playable /video/ path so a
        // thumbnail (/image/) redirect can never win the probe.
        const cached = Veo3Service.cachedVideoUrlType;
        const types = mediaUrlType
            ? [mediaUrlType]
            : cached
                ? [
                    cached,
                    ...Veo3Service.VIDEO_URL_TYPE_CANDIDATES.filter((t) => t !== cached),
                ]
                : [...Veo3Service.VIDEO_URL_TYPE_CANDIDATES];
        for (const type of types) {
            const location = await this.fetchMediaUrlRedirect(mediaId, projectId, type);
            if (!location)
                continue;
            const trusted = !!mediaUrlType || type === cached;
            if (trusted || /\/video\//.test(location)) {
                if (!mediaUrlType && Veo3Service.cachedVideoUrlType !== type) {
                    Veo3Service.cachedVideoUrlType = type;
                    // An empty type is the winner on the current API, so only announce a
                    // real one — otherwise this prints `mediaUrlType=` on every batch.
                    if (type)
                        logger.info(`[getMediaUrlRedirect] discovered video mediaUrlType=${type}`);
                }
                return location;
            }
        }
        return null;
    }
    /** One `getMediaUrlRedirect` GET; returns the 3xx `Location` header or null. */
    async fetchMediaUrlRedirect(mediaId, projectId, mediaUrlType, retryCount = 0) {
        const url = `${this.baseUrl}/media.getMediaUrlRedirect?name=${encodeURIComponent(mediaId)}` +
            (mediaUrlType ? `&mediaUrlType=${encodeURIComponent(mediaUrlType)}` : "");
        // Match the browser's <img>/media load EXACTLY: cookie auth (added by
        // googleFetch for labs.google) + a project referer, and crucially NO
        // `content-type: application/json` and NO `Authorization: Bearer`. Sending
        // getTrpcHeaders() (which adds both) makes this raw-query GET 400.
        const locale = this.config.locale || "vi";
        const effectiveProjectId = projectId || this.config.veo3ProjectId;
        const referer = effectiveProjectId
            ? `https://labs.google/fx/${locale}/tools/flow/project/${effectiveProjectId}`
            : `https://labs.google/fx/${locale}/tools/flow`;
        try {
            const response = await googleFetch({
                profileId: this.config.profileId,
                veo3ProjectId: effectiveProjectId,
                locale: this.config.locale,
                url,
                method: "GET",
                // Mirror the browser's <video> load: no mediaUrlType (→ primary = video),
                // Range + sec-fetch-dest:video. The 302 Location is the signed /video/ URL.
                headers: {
                    accept: "*/*",
                    referer,
                    range: "bytes=0-",
                    "sec-fetch-dest": "video",
                },
                followRedirects: false,
            });
            // Case-insensitive Location lookup (tls-client header casing varies).
            const locationKey = Object.keys(response.headers).find((k) => k.toLowerCase() === "location");
            const location = locationKey ? response.headers[locationKey] : undefined;
            if (location)
                return location;
            if (runtimeVerboseLogsEnabled()) {
                logger.info(`[getMediaUrlRedirect] ${mediaUrlType} → ${response.status} (no Location) for ${mediaId.substring(0, 12)}…`);
            }
            return null;
        }
        catch (error) {
            // Throw ở đây thường là transient (TlsClient recycle session giữa chừng) —
            // 1 lần retry sau 1.5s là đủ; không retry thì probe rơi về null và job
            // bị hoàn thành thiếu URL.
            if (retryCount === 0) {
                logger.warn(`[getMediaUrlRedirect] ${mediaUrlType || "(no type)"} threw for ${mediaId.substring(0, 12)}… (TLS recycle?), retrying in 1.5s`);
                await new Promise((r) => setTimeout(r, 1500));
                return this.fetchMediaUrlRedirect(mediaId, projectId, mediaUrlType, 1);
            }
            logger.warn(`[getMediaUrlRedirect] ${mediaUrlType || "(no type)"} failed for ${mediaId.substring(0, 12)}…: ${error?.message || error}`);
            return null;
        }
    }
    /**
     * ✅ NEW API SHAPE: Veo 3.1 r2v dùng `{media: [{name, projectId}]}` để
     * check status thay vì `{operations: [{operation: {name}, sceneId, status}]}`.
     * Response cũng đổi sang `{media: [{mediaMetadata: {mediaStatus: {mediaGenerationStatus}}, video: {...}}]}`.
     *
     * Method này gửi format mới rồi convert response về LEGACY shape
     * (`{operations: [...]}`) để downstream `processVideoStatusResult` không
     * phải biết về shape mới.
     */
    async batchCheckMediaGenerationStatus(items) {
        if (!this.config.accessToken) {
            throw new Error("Access token is required for status check");
        }
        if (items.length === 0) {
            return { operations: [] };
        }
        return this.executeWithTokenRefresh(async () => {
            const url = `${this.sandboxBaseUrl}/video:batchCheckAsyncVideoGenerationStatus`;
            const requestBody = JSON.stringify({
                media: items.map((it) => ({ name: it.name, projectId: it.projectId })),
            });
            const response = await googleFetch({
                profileId: this.config.profileId,
                veo3ProjectId: this.config.veo3ProjectId,
                locale: this.config.locale,
                url,
                method: "POST",
                headers: this.getSandboxHeaders(),
                body: requestBody,
            });
            if (!response.ok) {
                const errorText = await response.text();
                logger.error(`❌ [Poll Status:media] API Error: ${response.status} - ${errorText.substring(0, 300)}`);
                if (this.isAuthError(response, errorText)) {
                    const error = new Error("Access token đã hết hạn hoặc không hợp lệ.");
                    error.response = response;
                    error.errorText = errorText;
                    throw error;
                }
                throw new Error(`Failed to check media status: ${response.statusText} - ${errorText}`);
            }
            const responseData = await response.json();
            const mediaArr = Array.isArray(responseData?.media)
                ? responseData.media
                : [];
            // Build map: media.name → original sceneId we passed (so upstream
            // sceneIdToJob matching still works).
            const nameToSceneId = new Map();
            for (const it of items) {
                if (it.sceneId)
                    nameToSceneId.set(it.name, it.sceneId);
            }
            const operations = this.convertMediaArrayToPollOperations(mediaArr, nameToSceneId);
            // Media-endpoint SUCCESSFUL responses do NOT embed a playable URL — resolve
            // it from getMediaUrlRedirect (302 → signed flow-content.google/video URL),
            // exactly as the web app does. Only for finished items missing a URL.
            const nameToProjectId = new Map(items.map((it) => [it.name, it.projectId]));
            await Promise.all(operations.map(async (op) => {
                const video = op?.operation?.metadata?.video;
                if (op?.status === "MEDIA_GENERATION_STATUS_SUCCESSFUL" &&
                    video &&
                    !video.fifeUrl) {
                    const mediaId = video.mediaGenerationId || op?.operation?.metadata?.name;
                    const resolved = await this.getMediaUrlRedirect(mediaId, nameToProjectId.get(mediaId));
                    if (resolved)
                        video.fifeUrl = resolved;
                }
            }));
            if (runtimeVerboseLogsEnabled()) {
                logger.info(`📋 [Poll Status:media] Returned ${operations.length} media entries`, {
                    statuses: operations.map((o) => o.status),
                });
            }
            return { operations };
        });
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
     * Helper: Create batch log for VIDEO_CREATION_TO_VIDEO_COMPLETION timer event
     */
    createVideoCompletionTimerLog(options) {
        const { sessionId = `;${Date.now()}`, timerId = `VIDEO_CREATION_TO_VIDEO_COMPLETION${this.generateId()}`, currentTimeMs = Date.now(), eventTime = new Date().toISOString(), } = options;
        return {
            appEvents: [
                {
                    event: "VIDEO_CREATION_TO_VIDEO_COMPLETION",
                    eventProperties: [
                        { key: "TIMER_ID", stringValue: timerId },
                        { key: "TOOL_NAME", stringValue: "PINHOLE" },
                        { key: "CURRENT_TIME_MS", intValue: currentTimeMs },
                        {
                            key: "USER_AGENT",
                            stringValue: this.config.userAgent || this.defaultHeaders["User-Agent"],
                        },
                        { key: "IS_DESKTOP" },
                    ],
                    activeExperiments: [],
                    eventMetadata: { sessionId },
                    eventTime,
                },
            ],
        };
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
     * Lấy lý do hỏng thật của một operation bằng shape `{media:[...]}`.
     *
     * Hai shape bù trừ nhau: `{operations:[...]}` trả `fifeUrl` nhưng KHÔNG kèm lý do hỏng;
     * `{media:[...]}` trả lý do hỏng (vd `PUBLIC_ERROR_AUDIO_FILTERED`) nhưng không có URL.
     * Poll chính dùng shape đầu để lấy URL, nên chỉ gọi hàm này khi gặp FAILED mà thiếu lý do.
     *
     * Không bao giờ throw ra ngoài — lỗi thì trả null để caller giữ nguyên hành vi cũ.
     */
    async fetchMediaFailureReason(operationName, veo3ProjectId) {
        try {
            const data = await this.executeWithTokenRefresh(async () => {
                const response = await googleFetch({
                    profileId: this.config.profileId,
                    veo3ProjectId: this.config.veo3ProjectId,
                    locale: this.config.locale,
                    url: `${this.sandboxBaseUrl}/video:batchCheckAsyncVideoGenerationStatus`,
                    method: "POST",
                    headers: this.getSandboxHeaders(),
                    body: JSON.stringify({
                        media: [{ name: operationName, projectId: veo3ProjectId }],
                    }),
                });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                return response.json();
            });
            const media = Array.isArray(data?.media) ? data.media[0] : null;
            return readMediaFailureMessage(media?.mediaMetadata?.mediaStatus);
        }
        catch (error) {
            logger.warn(`[Poll Status:media] Không lấy được lý do hỏng cho op ${operationName.substring(0, 12)}: ${error?.message}`);
            return null;
        }
    }
    /**
     * Helper: Create check status request
     */
    createCheckStatusRequest(operationName, sceneId, status = "MEDIA_GENERATION_STATUS_PENDING") {
        return {
            operations: [
                {
                    operation: {
                        name: operationName,
                    },
                    sceneId,
                    status,
                },
            ],
        };
    }
    /**
     * Generate a random ID (similar to UUID format)
     */
    generateId() {
        return `${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 9)}-${Math.random().toString(36).substr(2, 9)}-${Math.random().toString(36).substr(2, 9)}-${Math.random().toString(36).substr(2, 12)}`;
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
                    throw new Error('MEDIA_DELETE_UNAVAILABLE: Google không xoá được media này nữa ' +
                        '(API cũ trả lỗi 500). Ảnh vẫn còn trong thư viện Flow.');
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
    /**
     * Expand a user prompt with a style preamble via Veo3's generateExpandedPrompt
     * API. Falls back to the original prompt on any error.
     */
    async expandPromptByStyle(userPrompt, stylePreamble, sessionId) {
        if (!userPrompt || userPrompt.trim().length === 0) {
            throw new Error("User prompt cannot be empty");
        }
        if (!stylePreamble || stylePreamble.trim().length === 0) {
            throw new Error("Style preamble cannot be empty");
        }
        const cookies = this.config.cookies;
        if (!cookies) {
            throw new Error("Cookies not available for Veo3 prompt expansion");
        }
        const preambleWithLanguageInstruction = `${stylePreamble}

CRITICAL LANGUAGE REQUIREMENT:
- The expanded prompt MUST be written entirely in ENGLISH
- ONLY exception: Keep any Vietnamese dialogue/speech exactly as provided in the original prompt
- All scene descriptions, camera movements, actions, and technical terms MUST be in English
- CRITICAL: All character voices MUST speak in VIETNAMESE language
- Characters must say their dialogue in Vietnamese with voice characteristics described in English
- Example: "character says in warm, gentle voice (in Vietnamese): 'Xin chào bạn!'" ← Vietnamese dialogue with English voice description
- Example: "whispers softly in Vietnamese: 'Mẹ ơi'" ← clear Vietnamese language indication`;
        try {
            const expandedPrompt = await this.callGenerateExpandedPromptAPI(userPrompt, preambleWithLanguageInstruction, cookies, sessionId);
            if (!expandedPrompt || expandedPrompt.trim().length === 0) {
                throw new Error("Expansion resulted in empty prompt");
            }
            return expandedPrompt;
        }
        catch (error) {
            logger.error("[Veo3Service] expandPromptByStyle failed:", error);
            return userPrompt;
        }
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
/**
 * Resolve a media's playable/download URL. Veo 3.1 (useV2ModelConfig) media
 * poll responses are SUCCESSFUL but carry NO embedded fifeUrl — the real
 * browser fetches the URL separately from this labs.google trpc endpoint,
 * which 302-redirects to a signed `flow-content.google/video/<id>?…` URL.
 * We read that `Location` header (followRedirects=false) instead of following
 * it (which would download the media bytes). Returns null on failure.
 */
// The exact mediaUrlType enum that yields the playable /video/ URL is not
// documented; we probe a candidate list once and cache the winner process-wide.
// MEDIA_URL_TYPE_VIDEO / MEDIA_URL_TYPE_ORIGINAL đã bị Google trả 400 ổn định
// (production 2026-09-10) — bỏ khỏi probe, chỉ còn biến thể không-param.
Veo3Service.cachedVideoUrlType = null;
Veo3Service.VIDEO_URL_TYPE_CANDIDATES = [
    "", // NO mediaUrlType → endpoint returns the primary media (the video). This
    // is what the web app's <video> load uses; confirmed 302 → /video/.
];
