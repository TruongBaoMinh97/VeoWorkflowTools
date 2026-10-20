/**
 * GenNormal Queue Manager
 * Simple queue for batch video generation
 */
import os from 'os';
import { sanitizeResultUrl } from '../../utils/resultUrl.js';
import { prisma } from '../../lib/prisma.js';
import { Veo3Service } from '../../services/veo3/veo3Service.js';
import { logger, runtimeVerboseLogsEnabled } from '../../lib/logger.js';
import { genNormalRepository } from './genNormal.repository.js';
import { getProfileCookies } from '../../utils/profileCookies.js';
import { resolveVideoModelKey, convertAspectRatioToEnum, getModelKeyForGenerationType, isOmniFlashKey, toProModelKey, normalizeImageModelKey } from '../../utils/videoModelResolver.js';
import { refreshProfileAccountInfo } from '../profiles/accountInfo.service.js';
import { isNonRetryableError, isRetryableError, getFailedJobDisplayMessage, isHardQuotaExhausted, isTransientTrafficLimit } from '../../services/veo3/veo3ErrorHandler.js';
import { concurrentProfileLimit } from '../../lib/concurrentProfileLimit.js';
import { captchaManager } from '../../lib/captchaManager.js';
import { sessionIdManager } from '../../lib/sessionIdManager.js';
import { isVerificationRejected, VERIFICATION_REQUIRED_MESSAGE } from '../../services/veo3/verificationFailure.js';
import { buildHandleMap, clampTextParts, tokenizePrompt } from '../../utils/referenceHandles.js';
/**
 * Returns true when the Chrome captcha-bridge extension is the captcha source
 * (the only production architecture after the Phase 4 cleanup). Defaults to
 * `true` when the env var is unset so the server behaves correctly even when
 * spawned standalone (e.g. by rundev.sh, before Electron sets the env).
 * Operators can force the legacy serialise-and-cooldown fallback by exporting
 * `USE_EXTENSION_BRIDGE=0` before starting the server.
 */
function isExtensionBridgeMode() {
    const raw = process.env.USE_EXTENSION_BRIDGE;
    if (raw == null || raw === '')
        return true;
    if (raw === '0' || /^false$/i.test(raw))
        return false;
    return raw === '1' || /^true$/i.test(raw);
}
// ── Daily-quota error marker constants ──────────────────────────────────────
// Frontend detects via: err.startsWith('DAILY_QUOTA_REACHED:') || err.startsWith('QUOTA_UPGRADEABLE:')
const ERR_DAILY_QUOTA_REACHED = 'DAILY_QUOTA_REACHED:Profile đã chạm quota ngày của Veo3 cho model này (PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED). Chỉ đợt gen này bị dừng — các job khác vẫn chạy tiếp.';
const ERR_QUOTA_UPGRADEABLE = 'QUOTA_UPGRADEABLE:Profile cần nâng cấp gói Veo3 để tiếp tục (quota model đã hết). Đợt gen này đã dừng — vui lòng thay hoặc nâng cấp tài khoản.';
// 429 TOO_MUCH_TRAFFIC = trần tốc độ per-account, tự khỏi sau vài phút → nghỉ dài
// dần theo số lần dính liên tiếp (reset khi submit thành công), thay vì 30-60s của
// 429 thường vốn quá ngắn để trần này hạ xuống.
const TRAFFIC_LIMIT_BACKOFF_SEC = [120, 300, 600];
class GenNormalQueueManager {
    constructor() {
        this.profileQueues = new Map();
        // Cache provider per profile — avoids creating new instance per job (~15KB cookies + config each)
        this.profileProviders = new Map();
        this.pollInterval = null;
        this.watchdogInterval = null;
        // Job coi như stuck nếu đã ở PROCESSING quá STUCK_JOB_TIMEOUT_MS mà không complete.
        // Image gen ~15-60s, video gen ~60-180s (+poll), upscale ~30-120s.
        // Set 10 phút để an toàn cho mọi loại — nếu thực sự chạy lâu hơn đây là bug khác.
        this.STUCK_JOB_TIMEOUT_MS = 5 * 60 * 1000;
        this.lastGlobalSubmitTime = 0; // Track last submission time across all profiles
        // ✅ TRUE PARALLEL: Per-profile reCAPTCHA gap - each profile completely independent
        // This allows true parallel processing - each profile has its own 15s gap
        this.lastRecaptchaTimePerProfile = new Map();
        this.projectConcurrency = new Map(); // Store concurrency per project
        this.projectMaxActiveProfiles = new Map(); // Store MAX ACTIVE PROFILES per project (concurrency setting)
        this.projectBatchSize = new Map(); // Store batch size per project
        this.projectDelaySeconds = new Map(); // Store delay per project
        this.queueCreationTime = 0; // Track when queue was created for initial stagger delay
        // ✅ TRUE PARALLEL: Per-profile submission processing (NOT global queue)
        // Each profile processes its own queue independently without waiting for other profiles
        this.profileProcessingActive = new Map(); // Track if profile is actively processing
        // 🚫 REMOVED: Global round-robin submission queue - replaced with per-profile independent processing
        // private globalSubmissionQueue: Array<{ profileId: string; jobId: string }> = [];
        // private isGlobalSubmitting: boolean = false; // Global lock for round-robin submission
        this.lastSubmittedProfileId = null; // Track last profile that submitted for round-robin (for logging)
        // Track cancelled projects to abort in-flight submissions
        this.cancelledProjects = new Set();
        // Track current batch jobs being processed (for error handling - requeue all batch jobs on 403)
        this.currentBatchJobs = new Map(); // key = first job ID
        // Track consecutive 403 failures per profile for escalating delay
        // Reset to 0 when successful submission
        this.profile403FailureCount = new Map();
        this.profileTrafficLimitStrikes = new Map();
        // Track consecutive HostTimeout failures per profile \u2014 khi Google silent-drop
        // requests (kh\u00f4ng tr\u1ea3 403 nh\u01b0ng API hang), c\u1ea7n force-reset browser.
        // Reset to 0 when submission success.
        this.profileHostTimeoutCount = new Map();
        this.HOST_TIMEOUT_RESET_THRESHOLD = 2; // Reset browser after 2 consecutive timeouts
        // 🪟 P1: Sliding window của timestamps 403 trong 5 phút gần nhất (song song counter trên)
        this.profile403Timestamps = new Map();
        this.SLIDING_WINDOW_MS = 5 * 60 * 1000;
        this.SLIDING_WINDOW_THRESHOLD = 3;
        this.SLIDING_WINDOW_PENALTY_MS = 120 * 1000;
        this.POST_403_COOLDOWN_MS = 15 * 1000;
        this.profileSlidingPenaltyUntil = new Map();
        // P1 #5: Throttle delay log noise. Chỉ log 1 lần mỗi 30s khi profile đang chờ delay.
        // Trước đó log in mỗi polling tick (3s) → 20 dòng cho 1 delay cycle → spam.
        this.profileDelayLogLastAt = new Map();
        this.DELAY_LOG_THROTTLE_MS = 30000;
        // Cooldown for heavy 403 recovery actions (reset/prewarm/UA rotate).
        // Without this, many failing jobs can trigger duplicate recoveries in parallel
        // and churn Chrome tabs, which hurts submit throughput.
        this.profileRecoveryCooldownUntil = new Map();
        this.PROFILE_RECOVERY_COOLDOWN_MS = Number(process.env.RECAPTCHA_RECOVERY_COOLDOWN_MS) || 45000;
        this.DEFERRED_UA_ROTATION_GUARD_MS = Number(process.env.DEFERRED_UA_ROTATION_GUARD_MS) || 30000;
        this.BROWSER_RECOVERY_TIMEOUT_MS = Number(process.env.BROWSER_RECOVERY_TIMEOUT_MS) || 3 * 60000;
        this.BROWSER_RECOVERY_RETRY_COOLDOWN_MS = Number(process.env.BROWSER_RECOVERY_RETRY_COOLDOWN_MS) || 45000;
        // 🔴 CIRCUIT BREAKER (P0 #7): Track profiles temporarily disabled due to repeated failures.
        // Escalation ladder theo attempt count:
        //   1:   30s delay (transient, có thể unlucky timing)
        //   2:   60s delay + rotate UA (thử UA khác)
        //   3:  300s delay (5min — profile có thể bị Google soft-flag, nghỉ ngắn)
        //   4:  900s delay + DEGRADED (15min — mark skip, ưu tiên profile khác)
        //   5+: 3600s delay + DEAD (60min — cần user re-login hoặc chờ Google clear flag)
        //
        // Rotate UA KHÔNG fix được 403 sau 2 lần — Google flag qua cookies/IP, không phải UA.
        // Thay vì spin vô tận, escalate rồi bỏ qua profile, để system tập trung profile khác.
        this.circuitBreakerState = new Map();
        this.profilesNeedingRelogin = new Set(); // Profiles with expired cookies
        this.CIRCUIT_BREAKER_DEGRADED_THRESHOLD = 4; // Mark degraded after 4 failures
        this.CIRCUIT_BREAKER_DEAD_THRESHOLD = 5; // Mark dead after 5 failures
        this.CIRCUIT_BREAKER_DEGRADED_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
        this.CIRCUIT_BREAKER_DEAD_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes
        // Backward compat aliases (old code may still reference these)
        this.CIRCUIT_BREAKER_THRESHOLD = this.CIRCUIT_BREAKER_DEGRADED_THRESHOLD;
        this.CIRCUIT_BREAKER_COOLDOWN_MS = this.CIRCUIT_BREAKER_DEGRADED_COOLDOWN_MS;
        // Option 1 patch — giảm 3 → 1 để tránh 403 burst. User có thể override qua
        // project.concurrency nếu muốn scale lên; scale HORIZONTAL (nhiều profile ×
        // concurrency=1) tốt hơn VERTICAL (1 profile × concurrency cao) vì Google flag
        // per-account + per-session, không flag per-IP.
        this.DEFAULT_CONCURRENT_PER_PROFILE = 1; // Default active profiles (concurrency setting)
        this.MAX_GLOBAL_RUNNING_JOBS = 30; // Hard cap: max total running jobs across ALL profiles to prevent Electron OOM
        // Image generation is sensitive to stacked in-flight submits. After the Chrome
        // version-alignment fix, higher concurrency is stable — but 16 tipped into 429
        // (RESOURCE_EXHAUSTED throttle) + occasional 403 + LOW MEMORY. Cap = 12 is the
        // sweet spot for this account/machine. Override via env.
        this.MAX_IMAGE_GEN_INFLIGHT_PER_PROFILE = Number(process.env.IMAGE_GEN_MAX_INFLIGHT_PER_PROFILE) || 12;
        // How many image BURST batches may be in-flight per profile at once.
        //   K=1 → serial: each 4-POST batch waits for completion (~20s) before the next.
        //   K=3 → pipeline: up to 3 batches overlap → peak batchSize×K = 12 concurrent POSTs.
        // Bounded by MAX_IMAGE_GEN_INFLIGHT_PER_PROFILE. Drop back toward 2 if 403/429 returns.
        this.IMAGE_PIPELINE_MAX_BATCHES = Number(process.env.IMAGE_PIPELINE_MAX_BATCHES) || 3;
        // Per-profile in-flight ceiling for VIDEO (async submit → poll). Video jobs stay
        // in `runningJobs` until the poller completes them (~minutes), so without a cap
        // `concurrency × batchSize` stacks 20+ simultaneous Veo3 gens → 429 HIGH_TRAFFIC +
        // LOW MEMORY. Cap = 12 (matches the image/luồng cap). Override via env.
        this.MAX_VIDEO_INFLIGHT_PER_PROFILE = Number(process.env.VIDEO_MAX_INFLIGHT_PER_PROFILE) || 12;
        // ✅ TRUE PARALLEL: Per-profile reCAPTCHA gap (NOT global)
        // 3 profiles với 15s gap mỗi cái = 3 profiles chạy song song hoàn toàn độc lập
        //
        // ⚠️ Video với reference/start image nặng hơn IMAGE gen hoặc text-to-video (cần
        // upload + process image + gen video) → Google rate-limit gấp hơn. Session log
        // thấy cluster 429 khi dùng 15s gap cho REFERENCE_TO_VIDEO → tăng 15s → 20s cho
        // các mode này để giảm 429. Các mode nhẹ (IMAGE_GENERATION, TEXT_TO_VIDEO) giữ 15s.
        this.MIN_RECAPTCHA_GAP_MS = 1000; // 1s — kh\u1edbp y\u00eau c\u1ea7u "delay 1-2s clear captcha token"
        this.MIN_RECAPTCHA_GAP_VIDEO_REF_MS = 2000; // 2s cho VIDEO có image input
        this.MIN_GLOBAL_SUBMIT_GAP_MS = 500; // 500ms minimum gap (reduced - profiles are independent)
        this.MAX_GLOBAL_SUBMIT_GAP_MS = 1000; // 1s max gap (reduced - profiles are independent)
        this.DEFAULT_BATCH_SIZE = 4; // Default batch size per thread (user configurable 1-10)
        this.BATCH_INTERVAL_MS = 0; // Disabled - human simulation (20-40s) already provides enough delay
        // Track last batch submission time per profile for 30s interval
        this.lastBatchTimePerProfile = new Map();
    }
    /**
     * Get per-profile reCAPTCHA gap based on job mode.
     * VIDEO với reference/start image dùng gap dài hơn vì API heavy hơn → dễ trigger
     * Google rate limit (429 PUBLIC_ERROR_HIGH_TRAFFIC).
     */
    getMinGapMsForMode(mode) {
        if (mode === 'REFERENCE_TO_VIDEO' || mode === 'REFERENCE_TO_VIDEO_AUDIO' || mode === 'IMAGE_TO_VIDEO') {
            return this.MIN_RECAPTCHA_GAP_VIDEO_REF_MS;
        }
        return this.MIN_RECAPTCHA_GAP_MS;
    }
    /**
     * Get per-profile reCAPTCHA gap based on the full queued job.
     *
     * Fix A (Nguyên nhân 9): IMAGE_GENERATION có reference images cũng cần gap dài
     * vì browser session token score suy giảm nhanh khi gen nhiều batch liên tiếp
     * cùng action. Log cho thấy batch N+1 (sau batch N) bị fail Set #1/#3 với
     * PUBLIC_ERROR_UNUSUAL_ACTIVITY. Tăng gap → giãn thời gian giữa batches → cho
     * Google assessment reset score.
     */
    getMinGapMsForJob(queuedJob) {
        const mode = queuedJob.mode;
        if (mode === 'REFERENCE_TO_VIDEO' || mode === 'REFERENCE_TO_VIDEO_AUDIO' || mode === 'IMAGE_TO_VIDEO') {
            return this.MIN_RECAPTCHA_GAP_VIDEO_REF_MS;
        }
        if (mode === 'IMAGE_GENERATION' && queuedJob.hasReferenceImages) {
            return this.MIN_RECAPTCHA_GAP_VIDEO_REF_MS;
        }
        return this.MIN_RECAPTCHA_GAP_MS;
    }
    /**
     * Default per-profile inter-submit delay.
     *
     * 2-3s → 0s: captcha gen serialize đã tự throttle (~1-2s/captcha + 5-15s human-sim mỗi
     * lần warm). Thêm delay nhân tạo chỉ làm chậm pipeline 12-luồng.
     *
     * Rate-limit delay (429/403/500) vẫn được set riêng qua `setProfileRateLimitDelay`,
     * không bị ảnh hưởng.
     *
     * User vẫn có thể override per-project qua field `project.delaySeconds` (UI).
     */
    getRandomDelay() {
        // Throttle 2-3s \u0111\u1ec3 \u0111\u1ea1t 10-15 job \u0111ang process in-flight/profile v\u1edbi batchSize=1.
        // Cycle th\u1ef1c t\u1ebf = max(delaySeconds, captcha_time + captcha_gap) \u2248 2-3s.
        // User c\u00f3 th\u1ec3 override qua `project.delaySeconds` (UI) n\u1ebfu g\u1eb7p 403.
        return 2 + Math.floor(Math.random() * 2); // 2-3 seconds
    }
    timelineLogsEnabled() {
        const logLevel = String(process.env.LOG_LEVEL || 'info').toLowerCase();
        return (process.env.VEO3_TIMELINE_LOGS === '1' ||
            process.env.VEO3_VERBOSE_LOGS === '1' ||
            logLevel === 'debug');
    }
    logTimeline(profileId, event, detail = {}) {
        if (!this.timelineLogsEnabled())
            return;
        logger.info(`[GenNormalTimeline] ${event}`, {
            profileId,
            ts: new Date().toISOString(),
            ...detail,
        });
    }
    getWaveCooldownConfig(mode) {
        const isRealChrome = process.env.BROWSER_RUNTIME === 'chrome';
        // When the UpKit Bridge extension is active, the per-submit captcha mint
        // happens inside MAIN-world grecaptcha (~200ms, high score). Wave cooldown
        // is pure throughput loss when scores stay high, so disable by default in
        // that mode; operators can re-enable with `VEO3_WAVE_COOLDOWN_EVERY=8`.
        const defaultEvery = isExtensionBridgeMode() ? 0 : 8;
        const every = Math.max(0, Number(process.env.VEO3_WAVE_COOLDOWN_EVERY ?? defaultEvery));
        const seconds = Math.max(0, Number(process.env.VEO3_WAVE_COOLDOWN_SECONDS) || 60);
        const refreshRaw = String(process.env.VEO3_WAVE_COOLDOWN_REFRESH ?? '1').toLowerCase();
        const refresh = refreshRaw !== '0' && refreshRaw !== 'false';
        return {
            enabled: isRealChrome && mode === 'IMAGE_GENERATION' && every > 0 && seconds > 0,
            every,
            seconds,
            refresh,
        };
    }
    videoBackgroundWarmEnabled() {
        return (process.env.VEO3_VIDEO_BACKGROUND_WARM === '1' ||
            /^true$/i.test(String(process.env.VEO3_VIDEO_BACKGROUND_WARM ?? '')));
    }
    getOtherRunningJobs(queue, jobsBeingHandled) {
        return Math.max(0, (queue?.runningJobs.size ?? 0) - jobsBeingHandled);
    }
    scheduleBrowserRecovery(profileId, queue, options) {
        queue.pendingBrowserRecovery = true;
        queue.pendingBrowserRecoveryVeo3ProjectId =
            options.veo3ProjectId || queue.pendingBrowserRecoveryVeo3ProjectId || queue.veo3ProjectId;
        queue.pendingBrowserRecoveryLocale = options.locale || queue.pendingBrowserRecoveryLocale;
        queue.pendingBrowserRecoveryContext = queue.pendingBrowserRecoveryContext || options.context;
        const otherRunningJobs = this.getOtherRunningJobs(queue, options.jobsBeingHandled);
        if (queue.browserRecoveryInFlight || queue.uaRotationInFlight || queue.isSubmitting || otherRunningJobs > 0) {
            logger.info(`[GenNormal] ⏸️ Defer recovery ${profileId.substring(0, 8)} (running=${otherRunningJobs}, queued=${queue.queuedJobs.length})`);
            return;
        }
        this.triggerPendingBrowserRecovery(profileId, queue);
    }
    triggerPendingBrowserRecovery(profileId, queue) {
        if (!queue.pendingBrowserRecovery || queue.browserRecoveryInFlight || queue.uaRotationInFlight) {
            return;
        }
        if (queue.isSubmitting || queue.runningJobs.size > 0) {
            return;
        }
        if (queue.browserRecoveryRetryAfter && queue.browserRecoveryRetryAfter > Date.now()) {
            return;
        }
        const context = queue.pendingBrowserRecoveryContext || 'unknown';
        const veo3ProjectId = queue.pendingBrowserRecoveryVeo3ProjectId || queue.veo3ProjectId;
        const locale = queue.pendingBrowserRecoveryLocale;
        queue.pendingBrowserRecovery = false;
        queue.pendingBrowserRecoveryVeo3ProjectId = undefined;
        queue.pendingBrowserRecoveryLocale = undefined;
        queue.pendingBrowserRecoveryContext = undefined;
        queue.browserRecoveryInFlight = true;
        queue.browserRecoveryStartedAt = Date.now();
        logger.info(`[GenNormal] ▶️ Triggering deferred browser recovery for ${profileId.substring(0, 8)}`, {
            profileId,
            context,
            veo3ProjectId,
            queuedJobs: queue.queuedJobs.length,
        });
        captchaManager.notifyFailure();
        queue.browserRecoveryRetryAfter = undefined;
        queue.browserRecoveryFailureCount = 0;
        queue.browserRecoveryInFlight = false;
        queue.browserRecoveryStartedAt = undefined;
        logger.info(`[GenNormal] notified captcha failure for ${profileId.substring(0, 8)} (context=${context})`);
    }
    async rotateUaProfileNow(profileId, failureCount, _context) {
        captchaManager.notifyFailure();
        logger.info(`[GenNormal] notified captcha failure (UA rotation no-op) for ${profileId.substring(0, 8)} attempt=${failureCount}`);
    }
    deferUaRotation(profileId, queue, failureCount, jobsBeingHandled, context) {
        const otherRunningJobs = this.getOtherRunningJobs(queue, jobsBeingHandled);
        queue.pendingUaRotation = true;
        queue.pendingUaRotationFailureCount = Math.max(queue.pendingUaRotationFailureCount || 0, failureCount);
        logger.info(`[GenNormal] ⏸️ Deferring UA rotation for ${profileId.substring(0, 8)} until profile is idle`, {
            profileId,
            context,
            failureCount,
            otherRunningJobs,
            runningJobs: queue.runningJobs.size,
            queuedJobs: queue.queuedJobs.length,
            isSubmitting: queue.isSubmitting,
        });
    }
    maybeTriggerPendingUaRotation(profileId, queue) {
        if (!queue.pendingUaRotation) {
            return false;
        }
        if (queue.isSubmitting || queue.runningJobs.size > 0 || queue.uaRotationInFlight) {
            return false;
        }
        const now = Date.now();
        const guardUntil = now + this.DEFERRED_UA_ROTATION_GUARD_MS;
        if (!queue.rateLimitUntil || queue.rateLimitUntil < guardUntil) {
            queue.rateLimitUntil = guardUntil;
            queue.rateLimitType = '403';
            logger.info(`[GenNormal] ⏳ Applied deferred UA rotation guard for ${profileId.substring(0, 8)} (${this.DEFERRED_UA_ROTATION_GUARD_MS / 1000}s)`, {
                profileId,
                rateLimitUntil: new Date(queue.rateLimitUntil).toISOString(),
            });
        }
        const failureCount = queue.pendingUaRotationFailureCount || this.profile403FailureCount.get(profileId) || 0;
        queue.pendingUaRotation = false;
        queue.pendingUaRotationFailureCount = undefined;
        queue.uaRotationInFlight = true;
        logger.info(`[GenNormal] ▶️ Triggering deferred UA rotation for ${profileId.substring(0, 8)} after profile became idle`, {
            profileId,
            failureCount,
            queuedJobs: queue.queuedJobs.length,
        });
        void this.rotateUaProfileNow(profileId, failureCount, 'deferred-idle')
            .catch((rotateError) => {
            queue.pendingUaRotation = true;
            queue.pendingUaRotationFailureCount = Math.max(queue.pendingUaRotationFailureCount || 0, failureCount);
            logger.warn(`[GenNormal] ⚠️ Deferred UA rotation failed:`, rotateError?.message || rotateError);
        })
            .finally(() => {
            queue.uaRotationInFlight = false;
        });
        return true;
    }
    handleSubmitFired(queuedJob) {
        const liveQueue = this.profileQueues.get(queuedJob.profileId);
        const submitFiredAt = Date.now();
        if (!liveQueue)
            return;
        liveQueue.lastSubmitTime = submitFiredAt;
        const waveConfig = this.getWaveCooldownConfig(queuedJob.mode);
        if (waveConfig.enabled) {
            liveQueue.waveSubmitCount += 1;
        }
        this.logTimeline(queuedJob.profileId, 'submit-fired', {
            jobId: queuedJob.jobId,
            projectId: queuedJob.projectId,
            mode: queuedJob.mode,
            waveSubmitCount: liveQueue.waveSubmitCount,
        });
        if (waveConfig.enabled && liveQueue.waveSubmitCount % waveConfig.every === 0) {
            liveQueue.waveCooldownUntil = submitFiredAt + waveConfig.seconds * 1000;
            liveQueue.pendingWaveSafeRefresh = waveConfig.refresh;
            logger.info(`[GenNormal] 🌊 Wave cooldown started for ${queuedJob.profileId.substring(0, 8)} after ${liveQueue.waveSubmitCount} submits`, {
                profileId: queuedJob.profileId,
                projectId: queuedJob.projectId,
                waveSubmitCount: liveQueue.waveSubmitCount,
                cooldownEveryNSubmits: waveConfig.every,
                cooldownSeconds: waveConfig.seconds,
                safeRefreshEnabled: waveConfig.refresh,
                cooldownUntil: new Date(liveQueue.waveCooldownUntil).toISOString(),
            });
            this.logTimeline(queuedJob.profileId, 'wave-cooldown-start', {
                jobId: queuedJob.jobId,
                projectId: queuedJob.projectId,
                waveSubmitCount: liveQueue.waveSubmitCount,
                cooldownSeconds: waveConfig.seconds,
                cooldownUntil: new Date(liveQueue.waveCooldownUntil).toISOString(),
            });
        }
    }
    maybeTriggerWaveCooldownMaintenance(profileId, queue) {
        if (!queue.pendingWaveSafeRefresh || !queue.waveCooldownUntil || queue.waveCooldownUntil <= Date.now()) {
            return;
        }
        const projectId = queue.projectId || queue.queuedJobs[0]?.projectId;
        const veo3ProjectId = queue.veo3ProjectId || queue.queuedJobs[0]?.veo3ProjectId;
        if (queue.isSubmitting || queue.runningJobs.size > 0) {
            this.logTimeline(profileId, 'wave-cooldown-refresh-deferred', {
                projectId,
                veo3ProjectId,
                runningJobs: queue.runningJobs.size,
                isSubmitting: queue.isSubmitting,
                waveSubmitCount: queue.waveSubmitCount,
                cooldownUntil: new Date(queue.waveCooldownUntil).toISOString(),
            });
            return;
        }
        if (!veo3ProjectId) {
            this.logTimeline(profileId, 'wave-cooldown-refresh-skipped-no-veo3-project', {
                projectId,
                waveSubmitCount: queue.waveSubmitCount,
                cooldownUntil: new Date(queue.waveCooldownUntil).toISOString(),
            });
            return;
        }
        queue.pendingWaveSafeRefresh = false;
        this.logTimeline(profileId, 'wave-cooldown-refresh-queued', {
            projectId,
            veo3ProjectId,
            waveSubmitCount: queue.waveSubmitCount,
            cooldownUntil: new Date(queue.waveCooldownUntil).toISOString(),
        });
        void (async () => {
            try {
                const { flushNow } = await import('../../services/veo3/flowTelemetryBuffer.js');
                await flushNow(profileId).catch(() => { });
                this.logTimeline(profileId, 'wave-cooldown-refresh-triggered', {
                    projectId,
                    veo3ProjectId,
                    waveSubmitCount: queue.waveSubmitCount,
                    cooldownUntil: queue.waveCooldownUntil != null
                        ? new Date(queue.waveCooldownUntil).toISOString()
                        : 'cleared',
                });
            }
            catch (error) {
                logger.warn(`[GenNormal] ⚠️ Wave cooldown refresh failed for ${profileId.substring(0, 8)}: ${error?.message || error}`);
            }
        })();
    }
    /**
     * Count active profiles for a project (profiles processing jobs)
     */
    countActiveProfiles(projectId) {
        let count = 0;
        for (const queue of this.profileQueues.values()) {
            if (queue.projectId === projectId && queue.runningJobs.size > 0) {
                count++;
            }
        }
        return count;
    }
    /**
     * Count total active jobs for a project across ALL profiles
     */
    countProjectActiveJobs(projectId) {
        let count = 0;
        for (const queue of this.profileQueues.values()) {
            if (queue.projectId === projectId) {
                count += queue.runningJobs.size;
            }
        }
        return count;
    }
    /**
     * Get batch size for a profile's project (default 4)
     */
    getProjectBatchSize(profileId) {
        // Resolve THIS profile's project (the old code returned the first Map entry,
        // which picked the wrong batchSize when >1 project ran concurrently).
        const projectId = this.profileQueues.get(profileId)?.projectId;
        if (projectId) {
            const batchSize = this.projectBatchSize.get(projectId);
            if (batchSize !== undefined)
                return batchSize;
        }
        // Project batchSize not populated yet (initializeProject still in-flight):
        // fall back to 1 (no burst) rather than DEFAULT_BATCH_SIZE, so a batchSize=1
        // project can never briefly collect a burst of 4 on an early submit tick.
        return 1;
    }
    /**
     * Get random global submit gap between 7-15 seconds
     * @returns Random gap in milliseconds
     */
    /**
     * Get or create queue for a profile
     */
    getProfileQueue(profileId) {
        if (!this.profileQueues.has(profileId)) {
            this.profileQueues.set(profileId, {
                profileId,
                veo3ProjectId: undefined,
                runningJobs: new Set(),
                queuedJobs: [],
                lastSubmitTime: 0,
                initialDelayMs: 0,
                isSubmitting: false,
                submissionQueue: [],
                waveSubmitCount: 0,
                pendingWaveSafeRefresh: false,
                pendingUaRotation: false,
                uaRotationInFlight: false,
                pendingBrowserRecovery: false,
                browserRecoveryInFlight: false,
                browserRecoveryFailureCount: 0,
            });
        }
        return this.profileQueues.get(profileId);
    }
    /**
     * FLAT DELAY (user y\u00eau c\u1ea7u): lu\u00f4n 20-30s b\u1ea5t k\u1ec3 s\u1ed1 l\u1ea7n 403 li\u00ean ti\u1ebfp.
     * \u0110\u1ed5i t\u1eeb escalating ladder (30/60/300/900/3600s) sang flat v\u00ec:
     *  - User quan s\u00e1t: ch\u1edd 5-60 ph\u00fat kh\u00f4ng gi\u1ea3i quy\u1ebft \u0111\u01b0\u1ee3c 403, ch\u1ec9 l\u00e0m ch\u1eadm pipeline
     *  - Ngu\u1ed3n 403 th\u1ef1c: session/token score th\u1ea5p, reset browser + \u0111\u1ee3i ng\u1eafn l\u00e0 \u0111\u1ee7
     * Return gi\u00e1 tr\u1ecb SECONDS.
     */
    getEscalatingDelay(_profileId) {
        return 20 + Math.floor(Math.random() * 11); // 20-30 seconds
    }
    /**
     * Delay in seconds between silent reCAPTCHA retries (failure count <= 3).
     *
     * Default 2s: post-submit Page.reload (reloadScheduler) and per-403 TLS
     * session recycle already flush both the Chrome page state AND the HTTP/2
     * connection — by the time the retry fires, the bot-scoring window has
     * effectively been "slid" by an entire fresh page. The legacy 5s/30s waits
     * were a substitute for not having those resets; with them in place, 2s is
     * plenty for the next mint to score high.
     *
     * Operators can override via `VEO3_RECAPTCHA_SILENT_RETRY_DELAY_SEC`
     * (set to `5` to restore the previous default, `30` for legacy, `0` for
     * immediate retry). Min clamp: 0, no max.
     */
    /** Delay (giây) cho lỗi rate-limit: 30-60s với 429 thường, leo thang với TOO_MUCH_TRAFFIC. */
    getRateLimitDelaySec(profileId, errorMessage, error) {
        const jitter = Math.floor(Math.random() * 31);
        if (!isTransientTrafficLimit(errorMessage, error))
            return 30 + jitter;
        const strikes = (this.profileTrafficLimitStrikes.get(profileId) ?? 0) + 1;
        this.profileTrafficLimitStrikes.set(profileId, strikes);
        const base = TRAFFIC_LIMIT_BACKOFF_SEC[Math.min(strikes, TRAFFIC_LIMIT_BACKOFF_SEC.length) - 1];
        logger.warn(`[GenNormal] 🚦 Profile ${profileId.substring(0, 8)}... 429 TOO_MUCH_TRAFFIC lần ${strikes} liên tiếp → nghỉ ${base + jitter}s rồi tự retry`);
        return base + jitter;
    }
    getRecaptchaSilentRetryDelaySec() {
        const raw = process.env.VEO3_RECAPTCHA_SILENT_RETRY_DELAY_SEC;
        if (raw == null || raw === '')
            return 2;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0)
            return 2;
        return Math.floor(parsed);
    }
    /**
     * Return the configured delay verbatim. The previous default added ±2s
     * jitter to mask the cadence, but that contradicted the user's UI value
     * ("set 5s → actual 3-7s"). Operators who want anti-bot jitter can opt
     * back in by exporting `VEO3_DELAY_JITTER_SEC=2` (or any positive number).
     */
    jitterDelaySec(baseSec, _plusMinusSec = 0) {
        const rawJ = process.env.VEO3_DELAY_JITTER_SEC;
        const jitterCap = rawJ == null || rawJ === '' ? 0 : Math.max(0, Number(rawJ) || 0);
        if (jitterCap === 0)
            return Math.max(1, Math.floor(baseSec));
        const j = (Math.random() * 2 - 1) * jitterCap; // [-jitterCap, +jitterCap]
        return Math.max(1, Math.floor(baseSec + j));
    }
    /**
     * On a sustained reCAPTCHA-403 streak (score dead, not a transient blip), ask the
     * captcha extension to clear the _GRECAPTCHA anchor cookie + reload the Flow tab —
     * the only thing that resets the reCAPTCHA Enterprise score in extension-bridge
     * mode — and drop the reused sessionId. Logs the connected extension version so a
     * stale (pre-1.5.0, no cookie-clear) extension is immediately obvious in the logs.
     */
    triggerExtensionAnchorReset(profileId, streak) {
        if (!isExtensionBridgeMode())
            return;
        const stats = captchaManager.stats();
        // Provider 'cdp' has no extension: the reset is applied by the app's own
        // browser before the next mint. Skip the version nagging, which would
        // otherwise always read "v? — extension is OLD" and send the user chasing
        // an extension that is not in play.
        if (stats.provider === 'cdp') {
            logger.warn(`[Anchor] 🔑 reCAPTCHA 403 streak=${streak} for ${profileId.substring(0, 8)}… → ` +
                `hard reset trên trình duyệt lấy mã (provider=cdp)`);
            captchaManager.notifyRecaptchaScoreDead();
            sessionIdManager.reset(profileId);
            return;
        }
        const version = stats.extensionVersion;
        const liveness = captchaManager.extensionLiveness();
        const [maj, min] = (version ?? '0.0').split('.').map((n) => Number(n) || 0);
        const isStaleExt = maj < 1 || (maj === 1 && min < 5);
        logger.warn(`[Anchor] 🔑 reCAPTCHA 403 streak=${streak} for ${profileId.substring(0, 8)}… → ` +
            `requesting extension anchor reset (clear _GRECAPTCHA cookie + reload Flow tab). ` +
            `extension=v${version ?? '?'} (${liveness})`);
        if (isStaleExt) {
            logger.warn(`[Anchor] ⚠️ Extension v${version ?? '?'} is OLD — it CANNOT clear the _GRECAPTCHA cookie, so the ` +
                `403 cliff will persist. Reload the extension at chrome://extensions to v1.5.0+.`);
        }
        captchaManager.notifyRecaptchaScoreDead();
        sessionIdManager.reset(profileId);
    }
    /**
     * Increment 403 failure count for a profile
     * Also checks and triggers circuit breaker if threshold reached
     */
    increment403FailureCount(profileId) {
        const current = this.profile403FailureCount.get(profileId) || 0;
        const newCount = current + 1;
        this.profile403FailureCount.set(profileId, newCount);
        logger.warn(`[GenNormal] 📊 403 failure count for profile ${profileId.substring(0, 8)}...: ${newCount}`, {
            profileId,
            failureCount: newCount,
            nextDelay: this.getEscalatingDelay(profileId)
        });
        // Circuit breaker DISABLED theo y\u00eau c\u1ea7u user: ch\u1ec9 delay flat 20-30s,
        // kh\u00f4ng mark profile degraded/dead khi 403 li\u00ean ti\u1ebfp.
        // N\u1ebfu mu\u1ed1n b\u1eadt l\u1ea1i, un-comment block d\u01b0\u1edbi + \u0111i\u1ec1u ch\u1ec9nh threshold.
        // if (newCount >= this.CIRCUIT_BREAKER_DEAD_THRESHOLD) {
        //   this.tripCircuitBreaker(profileId, newCount, 'dead');
        // } else if (newCount >= this.CIRCUIT_BREAKER_DEGRADED_THRESHOLD) {
        //   this.tripCircuitBreaker(profileId, newCount, 'degraded');
        // }
        return newCount;
    }
    /**
     * Best-effort: when a batch fails with PUBLIC_ERROR_MODEL_ACCESS_DENIED, the
     * paygateTier on the underlying GenNormalProject is likely stale (account
     * upgraded/downgraded since last sync). Drop the in-memory cache so the
     */
    async invalidatePaygateTierIfModelAccessDenied(errorMessage, _projectId) {
        if (!errorMessage.includes('PUBLIC_ERROR_MODEL_ACCESS_DENIED'))
            return;
        // FarmVideo bridge removed; no per-project cache to invalidate. Job will
        // surface MODEL_ACCESS_DENIED to the user via normal failure path.
    }
    /**
     * Hard ceiling for batch-requeue paths. Splits a batch into (retryable,
     * exhausted): jobs whose retryCount has hit maxRetries get marked FAILED
     * here so the caller can requeue only the survivors. Without this, certain
     * branches (browser race / "other retryable" / rate-limit) requeue without
     * incrementing or checking retryCount, producing unbounded loops every 1-3s
     * (see logs 09:33:34-09:33:48 with `Batch failed (retryable)` repeating).
     *
     * Returns the subset of jobs still eligible to retry. Caller should iterate
     * only over the returned array when re-pushing to the queue.
     */
    async enforceBatchRetryCeiling(batchJobs, errorMessage) {
        const survivors = [];
        for (const bj of batchJobs) {
            const bjData = await prisma.genNormalJob.findUnique({
                where: { id: bj.jobId },
                select: { retryCount: true, maxRetries: true },
            });
            const retryCount = bjData?.retryCount ?? 0;
            const maxRetries = bjData?.maxRetries ?? 10;
            if (retryCount >= maxRetries) {
                await prisma.genNormalJob.update({
                    where: { id: bj.jobId },
                    data: {
                        status: 'FAILED',
                        error: `Exhausted ${maxRetries} retries: ${errorMessage.substring(0, 200)}`,
                        completedAt: new Date(),
                    },
                });
                const queue = this.profileQueues.get(bj.profileId);
                if (queue)
                    queue.runningJobs.delete(bj.jobId);
                logger.error(`[GenNormal] 🛑 Job ${bj.jobId} exceeded ${maxRetries} retries — marking FAILED instead of requeue`);
            }
            else {
                survivors.push(bj);
            }
        }
        return survivors;
    }
    /**
     * Reset 403 failure count for a profile (called on successful submission)
     * Also resets circuit breaker state
     */
    reset403FailureCount(profileId) {
        this.profileTrafficLimitStrikes.delete(profileId);
        const previous = this.profile403FailureCount.get(profileId) || 0;
        if (previous > 0) {
            this.profile403FailureCount.set(profileId, 0);
            logger.info(`[GenNormal] ✅ Reset 403 failure count for profile ${profileId.substring(0, 8)}... (was ${previous})`);
        }
        // Reset HostTimeout counter tr\u00ean submission success
        const timeoutPrev = this.profileHostTimeoutCount.get(profileId) || 0;
        if (timeoutPrev > 0) {
            this.profileHostTimeoutCount.set(profileId, 0);
            logger.info(`[GenNormal] \u2705 Reset HostTimeout count for profile ${profileId.substring(0, 8)}... (was ${timeoutPrev})`);
        }
        // Also reset circuit breaker and needs-relogin flag
        if (this.circuitBreakerState.has(profileId)) {
            this.circuitBreakerState.delete(profileId);
            logger.info(`[GenNormal] ✅ Circuit breaker reset for profile ${profileId.substring(0, 8)}...`);
        }
        if (this.profilesNeedingRelogin.has(profileId)) {
            this.profilesNeedingRelogin.delete(profileId);
            logger.info(`[GenNormal] ✅ Needs-relogin cleared for profile ${profileId.substring(0, 8)}...`);
        }
        this.profileRecoveryCooldownUntil.delete(profileId);
    }
    shouldRunRecovery(profileId, reason) {
        const now = Date.now();
        const cooldownUntil = this.profileRecoveryCooldownUntil.get(profileId) ?? 0;
        if (now < cooldownUntil) {
            const remainingSec = Math.max(1, Math.ceil((cooldownUntil - now) / 1000));
            logger.info(`[GenNormal] ⏭️ Skip duplicate recovery (${reason}) for ${profileId.substring(0, 8)}... (${remainingSec}s cooldown left)`);
            return false;
        }
        this.profileRecoveryCooldownUntil.set(profileId, now + this.PROFILE_RECOVERY_COOLDOWN_MS);
        return true;
    }
    /**
     * Clear needs-relogin flag for a profile (called when cookies are updated)
     */
    clearNeedsRelogin(profileId) {
        this.profilesNeedingRelogin.delete(profileId);
        this.circuitBreakerState.delete(profileId);
        this.profile403FailureCount.set(profileId, 0);
        logger.info(`[GenNormal] ✅ Profile ${profileId.substring(0, 8)}... cleared for re-login — ready for new jobs`);
    }
    /**
     * 🔴 CIRCUIT BREAKER (P0 #7): Trip with severity level (degraded | dead).
     * - degraded: 15 phút cooldown, profile skip trong lúc đó
     * - dead: 60 phút cooldown, profile cần user intervention
     */
    tripCircuitBreaker(profileId, failureCount, level) {
        const cooldownMs = level === 'dead'
            ? this.CIRCUIT_BREAKER_DEAD_COOLDOWN_MS
            : this.CIRCUIT_BREAKER_DEGRADED_COOLDOWN_MS;
        const disabledUntil = Date.now() + cooldownMs;
        this.circuitBreakerState.set(profileId, { disabledUntil, failureCount, level });
        // Mark dead cần relogin
        if (level === 'dead') {
            this.profilesNeedingRelogin.add(profileId);
        }
        logger.error(`[GenNormal] 🔴 CIRCUIT BREAKER TRIPPED (${level.toUpperCase()}) for profile ${profileId.substring(0, 8)}...`, {
            profileId,
            failureCount,
            level,
            disabledUntil: new Date(disabledUntil).toISOString(),
            cooldownMinutes: cooldownMs / 60000,
            note: level === 'dead'
                ? 'Profile bị Google flag nặng. Cần user re-login hoặc chờ Google clear flag tự nhiên.'
                : 'Profile tạm skip, system sẽ ưu tiên profile khác. Tự động unlock sau cooldown.'
        });
    }
    /**
     * 🔴 CIRCUIT BREAKER: Check if profile is disabled
     * Returns true if profile should skip processing
     */
    isCircuitBreakerOpen(profileId) {
        const state = this.circuitBreakerState.get(profileId);
        if (!state)
            return false;
        const now = Date.now();
        if (now >= state.disabledUntil) {
            // Cooldown expired - reset circuit breaker
            this.circuitBreakerState.delete(profileId);
            this.profile403FailureCount.set(profileId, 0); // Reset failure count too
            logger.info(`[GenNormal] ✅ Circuit breaker cooldown expired for profile ${profileId.substring(0, 8)}..., re-enabling`);
            // 🔥 Re-warm browser after cooldown so it's ready for next token request
            return false;
        }
        const remainingMs = state.disabledUntil - now;
        logger.debug(`[GenNormal] 🔴 Profile ${profileId.substring(0, 8)}... circuit breaker open, ${Math.ceil(remainingMs / 1000)}s remaining`);
        return true;
    }
    /**
     * Collect IMAGE_GENERATION jobs from PROFILE'S PENDING QUEUE for batch processing
     * Returns up to IMAGE_BATCH_SIZE (6) jobs from the same profile
     *
     * ✅ FIX: Collect from queuedJobs (profile's pending jobs) instead of globalSubmissionQueue
     * because other jobs may not be in globalSubmissionQueue yet (waiting for delay)
     */
    async collectImageBatchJobs(profileId, firstJobId) {
        const queue = this.profileQueues.get(profileId);
        if (!queue)
            return [];
        // Check if first job is IMAGE_GENERATION
        const firstJob = await prisma.genNormalJob.findUnique({
            where: { id: firstJobId },
            select: { mode: true, projectId: true }
        });
        if (firstJob?.mode !== 'IMAGE_GENERATION')
            return [];
        // B3: claim candidate jobs SYNCHRONOUSLY before any further await. In extension
        // mode the poll loop submits in parallel, so a concurrent cycle could otherwise
        // steal jobs 2..N between our per-candidate DB lookups → double-submit once
        // batchSize > 1. Claim now (remove from queuedJobs + add to runningJobs), then
        // validate via DB and release any that no longer qualify.
        const batchLimit = this.getProjectBatchSize(profileId);
        const candidates = queue.queuedJobs
            .filter((item) => item.jobId !== firstJobId && item.mode === 'IMAGE_GENERATION')
            .slice(0, Math.max(0, batchLimit - 1));
        if (candidates.length > 0) {
            const claimedIds = new Set(candidates.map((item) => item.jobId));
            queue.queuedJobs = queue.queuedJobs.filter((item) => !claimedIds.has(item.jobId));
            for (const item of candidates)
                queue.runningJobs.add(item.jobId);
        }
        // Start with the first job that triggered this batch
        const batchJobs = [{
                jobId: firstJobId,
                profileId,
                projectId: firstJob.projectId,
                index: 0,
                mode: 'IMAGE_GENERATION',
                addedAt: Date.now()
            }];
        // Validate each claimed candidate; release non-eligible ones back to the queue.
        const jobsToRemoveFromQueue = [];
        for (const candidate of candidates) {
            const job = await prisma.genNormalJob.findUnique({
                where: { id: candidate.jobId },
                select: { mode: true, projectId: true, status: true }
            });
            // Only batch QUEUED IMAGE_GENERATION jobs from same project
            if (job?.mode === 'IMAGE_GENERATION' &&
                job.projectId === firstJob.projectId &&
                job.status === 'QUEUED') {
                batchJobs.push({
                    jobId: candidate.jobId,
                    profileId,
                    projectId: job.projectId,
                    index: batchJobs.length,
                    mode: 'IMAGE_GENERATION',
                    addedAt: Date.now()
                });
                jobsToRemoveFromQueue.push(candidate.jobId);
            }
            else {
                // No longer eligible — release the claim. Re-insert at the FRONT: these
                // were the next-in-line candidates, so restoring at head keeps their
                // relative priority (push-to-tail would cause a priority inversion).
                queue.runningJobs.delete(candidate.jobId);
                queue.queuedJobs.unshift(candidate);
            }
        }
        if (jobsToRemoveFromQueue.length > 0) {
            logger.info(`[GenNormal] 📦 Collected ${batchJobs.length} IMAGE_GENERATION jobs for batch processing`, {
                profileId: profileId.substring(0, 8) + '...',
                jobIds: batchJobs.map(j => j.jobId),
                removedFromProfileQueue: jobsToRemoveFromQueue.length,
                remainingInProfileQueue: queue.queuedJobs.length
            });
        }
        return batchJobs;
    }
    /**
     * Collect VIDEO jobs from PROFILE'S PENDING QUEUE for batch processing
     * Returns up to batchSize jobs of the SAME MODE from the same profile
     *
     * ✅ BATCH VIDEO: Only batches jobs with same mode (TEXT_TO_VIDEO, REFERENCE_TO_VIDEO, etc.)
     * Does NOT mix different video modes in same batch
     */
    async collectVideoBatchJobs(profileId, firstJobId, firstJobMode) {
        const queue = this.profileQueues.get(profileId);
        if (!queue)
            return [];
        // Only batch video modes
        const videoBatchModes = ['TEXT_TO_VIDEO', 'REFERENCE_TO_VIDEO', 'REFERENCE_TO_VIDEO_AUDIO', 'IMAGE_TO_VIDEO', 'FRAME_TO_FRAME'];
        if (!videoBatchModes.includes(firstJobMode))
            return [];
        // Get first job details
        const firstJob = await prisma.genNormalJob.findUnique({
            where: { id: firstJobId },
            select: { mode: true, projectId: true }
        });
        if (!firstJob || firstJob.mode !== firstJobMode)
            return [];
        // Start with the first job that triggered this batch
        const batchJobs = [{
                jobId: firstJobId,
                profileId,
                projectId: firstJob.projectId,
                index: 0,
                mode: firstJobMode,
                addedAt: Date.now()
            }];
        // Collect more jobs of SAME MODE from PROFILE'S PENDING QUEUE (queuedJobs)
        const jobsToRemoveFromQueue = [];
        for (const queuedJob of queue.queuedJobs) {
            if (batchJobs.length >= this.getProjectBatchSize(profileId))
                break;
            if (queuedJob.jobId === firstJobId)
                continue; // Skip first job (already added)
            const job = await prisma.genNormalJob.findUnique({
                where: { id: queuedJob.jobId },
                select: { mode: true, projectId: true, status: true }
            });
            // Only batch QUEUED jobs of SAME MODE from same project
            if (job?.mode === firstJobMode &&
                job.projectId === firstJob.projectId &&
                job.status === 'QUEUED') {
                batchJobs.push({
                    jobId: queuedJob.jobId,
                    profileId,
                    projectId: job.projectId,
                    index: batchJobs.length,
                    mode: firstJobMode,
                    addedAt: Date.now()
                });
                jobsToRemoveFromQueue.push(queuedJob.jobId);
            }
        }
        // Remove batched jobs from profile's queue (they will be processed in batch)
        if (jobsToRemoveFromQueue.length > 0) {
            const jobIdsToRemove = new Set(jobsToRemoveFromQueue);
            queue.queuedJobs = queue.queuedJobs.filter(item => !jobIdsToRemove.has(item.jobId));
            // Mark these jobs as "running" so they don't get picked up again
            for (const jobId of jobsToRemoveFromQueue) {
                queue.runningJobs.add(jobId);
            }
            logger.info(`[GenNormal] 🎬 Collected ${batchJobs.length} ${firstJobMode} jobs for batch processing`, {
                profileId: profileId.substring(0, 8) + '...',
                jobIds: batchJobs.map(j => j.jobId),
                mode: firstJobMode,
                removedFromProfileQueue: jobsToRemoveFromQueue.length,
                remainingInProfileQueue: queue.queuedJobs.length
            });
        }
        return batchJobs;
    }
    /**
     * Generate UUID v4 for sceneId (as per Veo3 API requirements)
     * Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
     */
    generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }
    /**
     * Initialize queue for a project
     */
    async initializeProject(projectId) {
        logger.debug(`[GenNormal] Initializing queue for project: ${projectId}`);
        // Clear cancelled status if user returns to this project
        if (this.cancelledProjects.has(projectId)) {
            this.clearCancelledStatus(projectId);
            logger.info(`[GenNormal] ✅ Cleared cancelled status for project (user returned)`, { projectId });
        }
        // Set queue creation time for initial stagger delay calculation
        this.queueCreationTime = Date.now();
        const project = await prisma.genNormalProject.findUnique({
            where: { id: projectId },
            include: {
                profiles: true,
                jobs: {
                    where: { status: 'QUEUED' },
                    orderBy: { jobIndex: 'asc' }
                }
            }
        });
        if (!project) {
            throw new Error('Project not found');
        }
        // Safety ceiling mode-aware (theo yêu cầu user):
        //   IMAGE_GENERATION       → tối đa 10
        //   VIDEO_GENERATION (bất kỳ T2V/I2V/ITV) → tối đa 20
        //
        // Mode detect từ queued jobs: nếu bất kỳ job nào là video → dùng cap video
        // (ưu tiên cap lớn hơn). Image-only project → cap 10.
        //
        // Để tắt override hoàn toàn, set env SAFE_CAP_OVERRIDE=0.
        const SAFE_CAP_ENABLED = process.env.SAFE_CAP_OVERRIDE !== '0';
        const MAX_CONCURRENCY_IMAGE = 12; // matches the UI cap (12 luồng) so a 12 setting isn't clamped
        const MAX_CONCURRENCY_VIDEO = 15;
        const jobModes = (project.jobs ?? []).map((j) => j.mode || 'TEXT_TO_VIDEO');
        const hasVideoJob = jobModes.some((m) => m !== 'IMAGE_GENERATION' && m !== 'IMAGE_UPSAMPLING');
        // Mode-aware batchSize cap. Image gen supports burst-of-4 (kh\u1edbp capture native
        // Veo3: 4 POST g\u1ea7n nh\u01b0 song song, CHUNG 1 batchId, m\u1ed7i POST 1 token ri\u00eang).
        // Video gi\u1eef b\u1ea3o th\u1ee7 = 1. Override cap \u1ea3nh qua env MAX_BATCH_SIZE_SAFE_IMAGE.
        const MAX_BATCH_SIZE_SAFE_IMAGE = Number(process.env.MAX_BATCH_SIZE_SAFE_IMAGE) || 4;
        // Video batch (same batchId+sessionId, N sequential POSTs, sceneId/operation
        // mapping) is now enabled for testing. Kept CONSERVATIVE: video is async +
        // heavier and has no per-profile in-flight ceiling (unlike image), so
        // concurrency × batchSize could stack many submits. Default 2, env-raisable
        // (route still caps at 4). Set MAX_BATCH_SIZE_SAFE_VIDEO=1 to disable.
        const MAX_BATCH_SIZE_SAFE_VIDEO = Number(process.env.MAX_BATCH_SIZE_SAFE_VIDEO) || 2;
        const MAX_BATCH_SIZE_SAFE = hasVideoJob
            ? MAX_BATCH_SIZE_SAFE_VIDEO
            : MAX_BATCH_SIZE_SAFE_IMAGE;
        const MAX_CONCURRENCY_PER_PROFILE_SAFE = hasVideoJob
            ? MAX_CONCURRENCY_VIDEO
            : MAX_CONCURRENCY_IMAGE;
        const rawConcurrency = project.concurrency || this.DEFAULT_CONCURRENT_PER_PROFILE;
        const concurrency = SAFE_CAP_ENABLED
            ? Math.min(rawConcurrency, MAX_CONCURRENCY_PER_PROFILE_SAFE)
            : rawConcurrency;
        if (SAFE_CAP_ENABLED && rawConcurrency > concurrency) {
            logger.warn(`[GenNormal] ⚠️  Project ${projectId} concurrency ${rawConcurrency} capped to ${concurrency} (mode=${hasVideoJob ? 'video' : 'image'})`);
        }
        this.projectMaxActiveProfiles.set(projectId, concurrency);
        const rawBatchSize = project.batchSize || this.DEFAULT_BATCH_SIZE;
        const batchSize = SAFE_CAP_ENABLED
            ? Math.min(rawBatchSize, MAX_BATCH_SIZE_SAFE)
            : rawBatchSize;
        if (SAFE_CAP_ENABLED && rawBatchSize > batchSize) {
            logger.warn(`[GenNormal] ⚠️  Project ${projectId} batchSize ${rawBatchSize} capped to ${batchSize} (safety ceiling)`);
        }
        this.projectBatchSize.set(projectId, batchSize);
        // Per-profile concurrency limit = concurrency (số batch) × batchSize (jobs/batch)
        // Each profile runs independently with its own full set of batches
        this.projectConcurrency.set(projectId, concurrency * batchSize);
        // Throttle giữa mỗi submit/profile. Floor 0s cho extension mode (captcha
        // mint MAIN-world rẻ + score cao nên burst không trip bot detection), 2s
        // cho non-extension fallback. User vẫn có thể set explicit qua UI.
        const MIN_DELAY_SECONDS_SAFE = isExtensionBridgeMode() ? 0 : 2;
        const projectDelay = project.delaySeconds;
        let delaySeconds = projectDelay || this.getRandomDelay();
        if (SAFE_CAP_ENABLED && delaySeconds < MIN_DELAY_SECONDS_SAFE) {
            logger.warn(`[GenNormal] ⚠️  Project ${projectId} delaySeconds ${delaySeconds} raised to ${MIN_DELAY_SECONDS_SAFE}s (safety floor)`);
            delaySeconds = MIN_DELAY_SECONDS_SAFE;
        }
        this.projectDelaySeconds.set(projectId, delaySeconds);
        logger.info(`[GenNormal] Init queue ${projectId} (concurrency=${concurrency} batch=${batchSize} delay=${delaySeconds}s jobs=${project.jobs.length} profiles=${project.profiles.length})`);
        // Initialize profile queues with staggered start delays
        // Profile 0: NO delay (starts immediately), Profile 1: 5s delay, Profile 2: 10s delay, etc.
        const PROFILE_STAGGER_DELAY_MS = 5000; // 5 seconds between each profile start
        let profileIndex = 0;
        for (const pp of project.profiles) {
            // First profile starts immediately (0 delay), subsequent profiles get staggered delay
            const baseDelay = profileIndex * PROFILE_STAGGER_DELAY_MS;
            const randomVariation = profileIndex === 0
                ? 0 // No delay for first profile
                : Math.random() * 2000; // 0-2s variation for other profiles
            const initialDelayMs = Math.floor(baseDelay + randomVariation);
            if (!this.profileQueues.has(pp.profileId)) {
                this.profileQueues.set(pp.profileId, {
                    projectId: projectId,
                    veo3ProjectId: pp.veo3ProjectId || undefined,
                    profileId: pp.profileId,
                    runningJobs: new Set(),
                    queuedJobs: [],
                    lastSubmitTime: 0,
                    initialDelayMs: initialDelayMs,
                    isSubmitting: false,
                    submissionQueue: [],
                    waveSubmitCount: 0,
                    pendingWaveSafeRefresh: false,
                    pendingUaRotation: false,
                    uaRotationInFlight: false,
                    pendingBrowserRecovery: false,
                    browserRecoveryInFlight: false,
                    browserRecoveryFailureCount: 0,
                });
                logger.debug(`[GenNormal] Created queue for profile ${pp.profileId} (initialDelay=${initialDelayMs}ms)`);
            }
            else {
                // Update existing queue - FULL RESET for resume scenario
                // 🔴 FIX: Must reset ALL state to prevent queue getting stuck after pause/resume
                const existingQueue = this.profileQueues.get(pp.profileId);
                existingQueue.projectId = projectId; // Ensure projectId is up to date
                existingQueue.veo3ProjectId = pp.veo3ProjectId || undefined;
                existingQueue.queuedJobs = [];
                existingQueue.initialDelayMs = initialDelayMs;
                existingQueue.isSubmitting = false; // Reset submission lock
                existingQueue.submissionQueue = []; // Clear submission queue
                // 🔴 FIX: Clear rate limit state on resume - this is crucial!
                // Without this, queue stays stuck waiting for rate limit that was set before pause
                existingQueue.rateLimitUntil = undefined;
                existingQueue.rateLimitType = undefined;
                existingQueue.lastSubmitTime = 0; // Reset so first job can start immediately
                existingQueue.waveSubmitCount = 0;
                existingQueue.waveCooldownUntil = undefined;
                existingQueue.pendingWaveSafeRefresh = false;
                existingQueue.pendingUaRotation = false;
                existingQueue.pendingUaRotationFailureCount = undefined;
                existingQueue.uaRotationInFlight = false;
                existingQueue.pendingBrowserRecovery = false;
                existingQueue.browserRecoveryInFlight = false;
                existingQueue.pendingBrowserRecoveryVeo3ProjectId = undefined;
                existingQueue.pendingBrowserRecoveryLocale = undefined;
                existingQueue.pendingBrowserRecoveryContext = undefined;
                existingQueue.browserRecoveryStartedAt = undefined;
                existingQueue.browserRecoveryRetryAfter = undefined;
                existingQueue.browserRecoveryFailureCount = 0;
                // 🔴 FIX: Clear stale running jobs - they are no longer valid after pause/cleanup
                // Jobs from before pause may still be in runningJobs but were never properly cleared
                const staleRunningCount = existingQueue.runningJobs.size;
                existingQueue.runningJobs.clear();
                logger.debug(`[GenNormal] Reset existing queue for profile ${pp.profileId} (delay=${existingQueue.initialDelayMs}ms staleRunning=${staleRunningCount})`);
            }
            profileIndex++;
        }
        // Add jobs to queues
        let jobsAdded = 0;
        for (const job of project.jobs) {
            const queue = this.profileQueues.get(job.profileId);
            if (queue) {
                // Fix A: determine hasReferenceImages from DB field để getMinGapMsForJob
                // biết job này cần gap 20s hay 15s. referenceImageMediaIds lưu JSON string
                // hoặc array; coi là "có ref" khi parse ra mảng non-empty.
                let hasReferenceImages = false;
                const refRaw = job.referenceImageMediaIds;
                if (refRaw) {
                    try {
                        const parsed = typeof refRaw === 'string' ? JSON.parse(refRaw) : refRaw;
                        hasReferenceImages = Array.isArray(parsed) && parsed.length > 0;
                    }
                    catch {
                        // non-JSON string → treat as single ref id
                        hasReferenceImages = typeof refRaw === 'string' && refRaw.trim().length > 0;
                    }
                }
                queue.queuedJobs.push({
                    jobId: job.id,
                    profileId: job.profileId,
                    projectId: project.id,
                    veo3ProjectId: job.veo3ProjectId || undefined,
                    index: job.jobIndex,
                    mode: job.mode || 'TEXT_TO_VIDEO',
                    addedAt: Date.now(),
                    hasReferenceImages,
                });
                jobsAdded++;
            }
            else {
                logger.warn(`[GenNormal] No queue found for profile ${job.profileId}, job ${job.id} not added`);
            }
        }
        logger.debug(`[GenNormal] Added ${jobsAdded}/${project.jobs.length} jobs across ${this.profileQueues.size} queue(s)`);
        // Start processing
        if (!this.pollInterval) {
            logger.debug('[GenNormal] Starting queue processor');
            this.startProcessing();
        }
        // 🔥 AGGRESSIVE WARMING: Trigger background warm for ALL profiles immediately
        logger.info(`[GenNormal] Queue ready for ${projectId} (${project.jobs.length} jobs)`);
    }
    /**
     * Start processing loop
     */
    startProcessing() {
        if (this.pollInterval)
            return;
        logger.info('[GenNormal] Starting queue processor');
        // Process queue every 1 second (submit new jobs). 1s poll + 4-6s delay
        // \u0111\u1ea3m b\u1ea3o cycle ti\u1ebfp theo kh\u00f4ng b\u1ecb delay th\u00eam do poll t\u1ea7n s\u1ed1 ch\u1eadm.
        this.pollInterval = setInterval(() => {
            this.processQueues().catch(err => {
                logger.error('[GenNormal] Queue processing error:', err);
            });
        }, 1000);
        // 🛡️ Watchdog: scan runningJobs Set mỗi 60s. Nếu job đã PROCESSING quá
        // STUCK_JOB_TIMEOUT_MS mà chưa complete → force fail + dọn Set để queue không bị block.
        this.watchdogInterval = setInterval(() => {
            this.runStuckJobWatchdog().catch(err => {
                logger.error('[GenNormal] Watchdog error:', err);
            });
        }, 60000);
        // Note: Status polling is now handled by GenNormalStatusPoller (core/queue/GenNormalStatusPoller.ts)
    }
    /**
     * Sweep TẤT CẢ per-profile state khi profile bị xóa hoặc idle quá lâu.
     * Memory critical: nếu không gọi → các Map keyed theo profileId grow vô hạn.
     *
     * Gọi từ:
     *  - profile delete handler (user xóa profile)
     *  - watchdog định kỳ với profile không còn trong DB
     *  - profile re-login (clear circuit breaker state)
     */
    removeProfileState(profileId) {
        this.profileQueues.delete(profileId);
        this.profileProviders.delete(profileId);
        this.lastRecaptchaTimePerProfile.delete(profileId);
        this.lastBatchTimePerProfile.delete(profileId);
        this.profileProcessingActive.delete(profileId);
        this.profile403FailureCount.delete(profileId);
        this.profile403Timestamps.delete(profileId);
        this.profileSlidingPenaltyUntil.delete(profileId);
        this.profileDelayLogLastAt.delete(profileId);
        // Compound throttle-log keys share this map — clean them too, or stale
        // timestamps from a prior lifecycle leak and mis-throttle on re-add.
        this.profileDelayLogLastAt.delete(`_stagger_${profileId}`);
        this.profileDelayLogLastAt.delete(`_ua_rotation_${profileId}`);
        this.profileDelayLogLastAt.delete(`_recovery_${profileId}`);
        this.profileHostTimeoutCount.delete(profileId);
        this.profileRecoveryCooldownUntil.delete(profileId);
        this.circuitBreakerState.delete(profileId);
        this.profilesNeedingRelogin.delete(profileId);
        logger.info(`[GenNormal] 🧹 Removed all state for profile ${profileId.substring(0, 8)}...`);
    }
    /**
     * Clear all 403/captcha throttling state for a profile WITHOUT touching its
     * queue/jobs. Used by the "Reset & tiếp tục" button so a user stuck behind
     * repeated captcha 403s can resume immediately instead of waiting out the
     * escalating delay.
     */
    clearProfileThrottle(profileId) {
        this.profile403FailureCount.delete(profileId);
        this.profile403Timestamps.delete(profileId);
        this.profileHostTimeoutCount.delete(profileId);
        this.profileSlidingPenaltyUntil.delete(profileId);
        this.circuitBreakerState.delete(profileId);
        const queue = this.profileQueues.get(profileId);
        if (queue) {
            queue.rateLimitUntil = undefined;
            queue.pendingUaRotationFailureCount = undefined;
        }
        logger.info(`[GenNormal] 🔄 Cleared captcha/403 throttle for profile ${profileId.substring(0, 8)}...`);
    }
    /**
     * Sweep TẤT CẢ per-project state khi project bị xóa.
     * `cleanupProjectQueue` chỉ filter jobs trong queue, không xóa các Map cấu hình.
     */
    removeProjectState(projectId) {
        this.projectConcurrency.delete(projectId);
        this.projectMaxActiveProfiles.delete(projectId);
        this.projectBatchSize.delete(projectId);
        this.projectDelaySeconds.delete(projectId);
        this.cancelledProjects.delete(projectId);
        logger.info(`[GenNormal] 🧹 Removed all state for project ${projectId}`);
    }
    /**
     * Watchdog: phát hiện job stuck (Set runningJobs có entry nhưng DB đã done,
     * hoặc job PROCESSING quá lâu). Force-fail và dọn Set để queue unblock.
     */
    async runStuckJobWatchdog() {
        const cutoff = new Date(Date.now() - this.STUCK_JOB_TIMEOUT_MS);
        for (const [profileId, queue] of this.profileQueues) {
            if (queue.runningJobs.size === 0)
                continue;
            const runningJobIds = Array.from(queue.runningJobs);
            for (const jobId of runningJobIds) {
                const job = await prisma.genNormalJob.findUnique({
                    where: { id: jobId },
                    select: { id: true, status: true, startedAt: true, jobIndex: true, projectId: true },
                }).catch(() => null);
                if (!job) {
                    // Job không còn trong DB — dọn khỏi Set
                    queue.runningJobs.delete(jobId);
                    logger.warn(`[GenNormal] 🧹 Watchdog: removed orphan jobId ${jobId} from runningJobs (not in DB)`, { profileId });
                    continue;
                }
                // DB đã done nhưng Set còn → desync, dọn
                if (job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'CANCELLED') {
                    queue.runningJobs.delete(jobId);
                    logger.warn(`[GenNormal] 🧹 Watchdog: Set desync, removed job #${job.jobIndex} (DB status=${job.status})`, {
                        jobId,
                        profileId,
                        remainingRunningJobs: queue.runningJobs.size,
                    });
                    continue;
                }
                // PROCESSING nhưng startedAt quá lâu → treo
                if (job.status === 'PROCESSING' && job.startedAt && job.startedAt < cutoff) {
                    const ageMs = Date.now() - job.startedAt.getTime();
                    logger.error(`[GenNormal] 🚨 Watchdog: job #${job.jobIndex} STUCK in PROCESSING for ${Math.round(ageMs / 1000)}s → force FAIL`, {
                        jobId,
                        profileId,
                        projectId: job.projectId,
                        stuckDurationSec: Math.round(ageMs / 1000),
                    });
                    await prisma.genNormalJob.update({
                        where: { id: jobId },
                        data: {
                            status: 'FAILED',
                            error: `Job treo quá lâu (${Math.round(ageMs / 1000)}s không có phản hồi từ Google) nên đã tự dừng. ` +
                                `Bấm gen lại để thử lần nữa.`,
                            completedAt: new Date(),
                        },
                    }).catch(err => logger.error('[GenNormal] Watchdog DB update failed:', err));
                    queue.runningJobs.delete(jobId);
                    queue.lastSubmitTime = Date.now();
                }
            }
        }
        // 🧹 Memory sweep: clear state cho profile idle > 30 phút (no running jobs, no queued).
        // Tránh leak Map keyed theo profileId khi user xóa profile hoặc switch project khác.
        const IDLE_THRESHOLD_MS = 30 * 60 * 1000;
        const now = Date.now();
        for (const [profileId, queue] of this.profileQueues) {
            if (queue.runningJobs.size > 0 || queue.queuedJobs.length > 0)
                continue;
            const lastActivity = Math.max(queue.lastSubmitTime, this.lastRecaptchaTimePerProfile.get(profileId) ?? 0);
            if (lastActivity === 0)
                continue; // never active, skip
            if (now - lastActivity > IDLE_THRESHOLD_MS) {
                logger.info(`[GenNormal] 🧹 Watchdog: cleaning idle profile state ${profileId.substring(0, 8)}... (${Math.round((now - lastActivity) / 60000)}min idle)`);
                this.removeProfileState(profileId);
            }
        }
    }
    /**
     * Stop processing
     */
    stopProcessing() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        if (this.watchdogInterval) {
            clearInterval(this.watchdogInterval);
            this.watchdogInterval = null;
        }
        logger.info('[GenNormal] Queue processor stopped');
    }
    /**
     * Clear all jobs for a specific project from queues
     * This method is called when stopping/cancelling a project
     */
    /**
     * Tier của tài khoản chạy job.
     *
     * `Profile.paygateTier` có thể null (tài khoản chưa từng lấy credit). Lúc đó
     * TRA thật qua accountInfo — hàm này có cache riêng nên không chạm đường nóng
     * khi tier đã biết. KHÔNG đoán là Ultra: đoán Ultra chính là tái tạo lại lỗi
     * 403 trên tài khoản Pro. Cùng đường không tra được thì lùi về tier dự án, rồi
     * cuối cùng là Pro — hỏng kiểu "model thấp hơn" nhẹ hơn hỏng kiểu "mất job".
     */
    async resolveProfileTier(job, profileId) {
        const stored = job?.profile?.paygateTier;
        if (stored)
            return stored;
        try {
            const info = await refreshProfileAccountInfo(profileId);
            if (info.tier === 'ultra')
                return 'PAYGATE_TIER_TWO';
            if (info.tier === 'pro' || info.tier === 'free')
                return 'PAYGATE_TIER_ONE';
        }
        catch (err) {
            logger.warn(`[GenNormal] Không tra được tier cho profile ${profileId.substring(0, 8)}: ${err?.message ?? err}`);
        }
        return job?.project?.paygateTier ?? 'PAYGATE_TIER_ONE';
    }
    async clearProjectJobs(projectId) {
        let clearedQueuedCount = 0;
        let clearedRunningCount = 0;
        for (const [profileId, queue] of this.profileQueues) {
            // Clear queued jobs
            const beforeQueuedCount = queue.queuedJobs.length;
            queue.queuedJobs = queue.queuedJobs.filter(job => job.projectId !== projectId);
            const afterQueuedCount = queue.queuedJobs.length;
            clearedQueuedCount += (beforeQueuedCount - afterQueuedCount);
            // Clear submission queue as well
            queue.submissionQueue = queue.submissionQueue.filter(job => job.projectId !== projectId);
            // ✅ FIX: Remove running jobs by querying DB to get projectId for each jobId
            const runningJobIds = Array.from(queue.runningJobs);
            for (const jobId of runningJobIds) {
                // Query DB to check if this job belongs to the project being stopped
                const job = await prisma.genNormalJob.findUnique({
                    where: { id: jobId },
                    select: { projectId: true }
                });
                if (job && job.projectId === projectId) {
                    queue.runningJobs.delete(jobId);
                    clearedRunningCount++;
                    logger.info(`[GenNormal] ✅ Removed running job ${jobId} from profile ${profileId} queue`, {
                        jobId,
                        profileId,
                        projectId
                    });
                }
            }
        }
        logger.info(`[GenNormal] Cleared ${clearedQueuedCount} queued jobs and ${clearedRunningCount} running jobs for project ${projectId}`, {
            projectId,
            clearedQueuedCount,
            clearedRunningCount
        });
    }
    /**
     * Process all profile queues
     * ✅ TRUE PARALLEL: Each profile processes independently without waiting for other profiles
     */
    async processQueues() {
        const now = Date.now();
        // Debug: Log queue status
        const totalQueued = Array.from(this.profileQueues.values()).reduce((sum, q) => sum + q.queuedJobs.length, 0);
        const totalRunning = Array.from(this.profileQueues.values()).reduce((sum, q) => sum + q.runningJobs.size, 0);
        if (totalQueued > 0 || totalRunning > 0) {
            logger.debug(`[GenNormal] Processing queues: ${totalQueued} queued, ${totalRunning} running`, {
                queues: Array.from(this.profileQueues.entries()).map(([pid, q]) => ({
                    profileId: pid,
                    queued: q.queuedJobs.length,
                    running: q.runningJobs.size
                }))
            });
        }
        // ✅ TRUE PARALLEL: Start independent processing for each profile (fire and forget)
        // Each profile runs its own processing loop without blocking other profiles
        for (const [profileId, queue] of this.profileQueues) {
            // Skip if profile is already actively processing
            if (this.profileProcessingActive.get(profileId)) {
                continue;
            }
            // Skip if no jobs to process
            if (queue.queuedJobs.length === 0) {
                continue;
            }
            // 🔴 CIRCUIT BREAKER: Skip if profile is disabled
            if (this.isCircuitBreakerOpen(profileId)) {
                continue;
            }
            // 🔐 Skip if profile needs re-login (cookies expired)
            if (this.profilesNeedingRelogin.has(profileId)) {
                continue;
            }
            // Start independent processing for this profile (async, no await)
            this.processProfileQueueIndependently(profileId, queue).catch(err => {
                logger.error(`[GenNormal] Profile ${profileId.substring(0, 8)}... processing error:`, err);
                this.profileProcessingActive.set(profileId, false);
            });
        }
    }
    /**
     * ✅ TRUE PARALLEL: Process a single profile's queue independently
     * This runs completely independently from other profiles
     * Multiple profiles can run this method simultaneously
     */
    async processProfileQueueIndependently(profileId, queue) {
        // Mark profile as actively processing
        this.profileProcessingActive.set(profileId, true);
        const now = Date.now();
        const activeCount = queue.runningJobs.size; // Track running jobs count
        try {
            // Get concurrency and delay settings for this profile's project.
            // 2026-05-16: Bỏ auto-cap concurrency=2 khi 429 (rateLimitConcurrencyOverride).
            // Profile dính 429 nay chỉ bị `setProfileRateLimitDelay` 30-60s nghỉ riêng,
            // các profile khác chạy bình thường theo `projectConcurrency` user cấu hình.
            let maxConcurrency = this.DEFAULT_CONCURRENT_PER_PROFILE;
            let delaySeconds = this.getRandomDelay();
            let projectId;
            if (queue.queuedJobs.length > 0) {
                const firstJob = queue.queuedJobs[0];
                if (firstJob) {
                    projectId = firstJob.projectId;
                    // Check if project is paused or stopped
                    const project = await prisma.genNormalProject.findUnique({
                        where: { id: projectId },
                        select: { status: true }
                    });
                    if (project?.status === 'PAUSED' || project?.status === 'STOPPED') {
                        logger.info(`[GenNormal] Project ${projectId} is ${project.status}, skipping queue processing`);
                        return; // Skip this profile
                    }
                    maxConcurrency = this.projectConcurrency.get(projectId) || this.DEFAULT_CONCURRENT_PER_PROFILE;
                    delaySeconds = this.projectDelaySeconds.get(projectId) || this.getRandomDelay();
                }
            }
            else if (queue.runningJobs.size > 0) {
                // If no queued jobs, try to find projectId from running jobs
                const runningJobId = Array.from(queue.runningJobs)[0];
                if (runningJobId) {
                    const runningJob = await prisma.genNormalJob.findUnique({
                        where: { id: runningJobId },
                        select: { projectId: true }
                    });
                    if (runningJob?.projectId) {
                        projectId = runningJob.projectId;
                        maxConcurrency = this.projectConcurrency.get(projectId) || this.DEFAULT_CONCURRENT_PER_PROFILE;
                        delaySeconds = this.projectDelaySeconds.get(projectId) || this.getRandomDelay();
                    }
                }
            }
            // Check initial stagger delay (only applies to first job if no jobs have run yet)
            if (queue.lastSubmitTime === 0 && queue.runningJobs.size === 0 && queue.initialDelayMs > 0) {
                // This is the first job for this profile - check if initial delay has passed
                const queueCreationTime = this.queueCreationTime || now;
                const timeSinceQueueCreation = now - queueCreationTime;
                if (timeSinceQueueCreation < queue.initialDelayMs) {
                    const remainingStaggerDelay = Math.ceil((queue.initialDelayMs - timeSinceQueueCreation) / 1000);
                    const staggerLogKey = `_stagger_${profileId}`;
                    const lastStaggerLog = this.profileDelayLogLastAt.get(staggerLogKey) || 0;
                    if (runtimeVerboseLogsEnabled() || now - lastStaggerLog >= this.DELAY_LOG_THROTTLE_MS) {
                        this.profileDelayLogLastAt.set(staggerLogKey, now);
                        logger.info(`[GenNormal] ⏳ Profile ${profileId} waiting for initial stagger delay (${remainingStaggerDelay}s remaining)`, {
                            profileId,
                            projectId,
                            initialDelayMs: queue.initialDelayMs,
                            timeSinceQueueCreation: Math.floor(timeSinceQueueCreation / 1000),
                            remainingDelaySeconds: remainingStaggerDelay,
                            queuedJobs: queue.queuedJobs.length
                        });
                    }
                    return; // Exit, will retry on next cycle
                }
            }
            // ⚠️ GLOBAL CAP: prevent Electron OOM by limiting total running jobs across all profiles.
            // Each running job holds a reCAPTCHA browser session → too many = memory explosion.
            const totalRunningGlobal = Array.from(this.profileQueues.values()).reduce((sum, q) => sum + q.runningJobs.size, 0);
            if (totalRunningGlobal >= this.MAX_GLOBAL_RUNNING_JOBS) {
                // Only log once per 30s to avoid spam
                const lastGlobalCapLog = this.profileDelayLogLastAt.get('_global_cap') || 0;
                if (now - lastGlobalCapLog > 30000) {
                    this.profileDelayLogLastAt.set('_global_cap', now);
                    logger.warn(`[GenNormal] ⏸️ Global cap reached (${totalRunningGlobal}/${this.MAX_GLOBAL_RUNNING_JOBS} running). Waiting for jobs to complete before submitting more.`, {
                        profileId,
                        totalRunningGlobal,
                        maxGlobal: this.MAX_GLOBAL_RUNNING_JOBS,
                        queuedJobs: queue.queuedJobs.length
                    });
                }
                return; // Wait for running jobs to complete
            }
            // ⚠️ MEMORY GUARD: pause submissions when system free memory is critically low.
            // macOS aggressively caches files → `os.freemem()` often shows very low values
            // even when plenty of memory is reclaimable. Use a low threshold (128MB) to only
            // pause when truly critical, and require significant running load before pausing.
            const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
            const MIN_FREE_MEM_MB = 128; // Only pause when critically low
            if (freeMemMB < MIN_FREE_MEM_MB && totalRunningGlobal > 10) {
                const lastMemLog = this.profileDelayLogLastAt.get('_mem_warn') || 0;
                if (now - lastMemLog > 30000) {
                    this.profileDelayLogLastAt.set('_mem_warn', now);
                    logger.error(`[GenNormal] ⚠️ LOW MEMORY: ${freeMemMB}MB free (min ${MIN_FREE_MEM_MB}MB). Pausing submissions to prevent crash.`, {
                        freeMemMB,
                        totalRunningGlobal,
                        heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
                    });
                }
                return;
            }
            // Check regular delay between jobs for this profile - skip if not enough time has passed.
            // Apply ±2s jitter so the inter-submit cadence does not look like a uniform bot clock.
            // (Set VEO3_DELAY_JITTER_SEC=0 to disable.)
            const jitteredDelaySec = this.jitterDelaySec(delaySeconds, 2);
            const delayMs = jitteredDelaySec * 1000;
            const timeSinceLastSubmit = now - queue.lastSubmitTime;
            // Check if profile is in rate limit delay period (429 error)
            const rateLimitUntil = queue.rateLimitUntil;
            const isRateLimited = rateLimitUntil !== undefined && rateLimitUntil > now;
            const rateLimitRemainingMs = isRateLimited ? rateLimitUntil - now : 0;
            const waveCooldownUntil = queue.waveCooldownUntil;
            const isWaveCoolingDown = waveCooldownUntil !== undefined && waveCooldownUntil > now;
            const waveCooldownRemainingMs = isWaveCoolingDown ? waveCooldownUntil - now : 0;
            // Calculate remaining delay: rate-limit / wave-cooldown windows override normal spacing.
            const specialDelayUntil = Math.max(rateLimitUntil ?? 0, waveCooldownUntil ?? 0);
            const specialDelayActive = specialDelayUntil > now;
            const delayState = specialDelayActive
                ? (rateLimitRemainingMs >= waveCooldownRemainingMs ? 'rate-limit' : 'wave-cooldown')
                : 'normal';
            const remainingDelayMs = specialDelayActive
                ? specialDelayUntil - now
                : (queue.lastSubmitTime > 0 && timeSinceLastSubmit < delayMs)
                    ? delayMs - timeSinceLastSubmit
                    : 0;
            if (this.maybeTriggerPendingUaRotation(profileId, queue)) {
                return;
            }
            if (queue.uaRotationInFlight) {
                const uaRotationLogKey = `_ua_rotation_${profileId}`;
                const lastUaRotationLog = this.profileDelayLogLastAt.get(uaRotationLogKey) || 0;
                if (runtimeVerboseLogsEnabled() || now - lastUaRotationLog >= this.DELAY_LOG_THROTTLE_MS) {
                    this.profileDelayLogLastAt.set(uaRotationLogKey, now);
                    logger.info(`[GenNormal] 🔄 Profile ${profileId} đang chờ UA rotation hoàn tất`, {
                        profileId,
                        projectId,
                        queuedJobs: queue.queuedJobs.length,
                        runningJobs: queue.runningJobs.size,
                        pendingUaRotation: queue.pendingUaRotation,
                    });
                }
                return;
            }
            this.triggerPendingBrowserRecovery(profileId, queue);
            if (queue.pendingBrowserRecovery || queue.browserRecoveryInFlight) {
                const recoveryLogKey = `_recovery_${profileId}`;
                const lastRecoveryLog = this.profileDelayLogLastAt.get(recoveryLogKey) || 0;
                if (runtimeVerboseLogsEnabled() || now - lastRecoveryLog >= this.DELAY_LOG_THROTTLE_MS) {
                    this.profileDelayLogLastAt.set(recoveryLogKey, now);
                    logger.info(queue.browserRecoveryInFlight
                        ? `[GenNormal] 🔄 ${profileId.substring(0, 8)} chờ browser recovery hoàn tất`
                        : `[GenNormal] ⏸️ ${profileId.substring(0, 8)} chờ browser recovery (idle)`);
                }
                return;
            }
            if (remainingDelayMs > 0) {
                if (delayState === 'wave-cooldown') {
                    this.maybeTriggerWaveCooldownMaintenance(profileId, queue);
                }
                // Use tracked error type for accurate delay reason
                const delayReason = queue.rateLimitType === '403'
                    ? 'reCAPTCHA rejected (403)'
                    : queue.rateLimitType === '500'
                        ? 'Google server error (500)'
                        : 'rate limit (429/PUBLIC_ERROR_HIGH_TRAFFIC)';
                // P1 #5: Throttle log — chỉ in 1 lần mỗi DELAY_LOG_THROTTLE_MS per profile.
                // Tránh spam 20+ dòng cho 1 delay cycle trong polling loop.
                const lastLoggedAt = this.profileDelayLogLastAt.get(profileId) || 0;
                const shouldLog = now - lastLoggedAt >= this.DELAY_LOG_THROTTLE_MS;
                if (shouldLog) {
                    this.profileDelayLogLastAt.set(profileId, now);
                    const remainSec = Math.ceil(remainingDelayMs / 1000);
                    const queuedJobs = queue.queuedJobs.length;
                    const shortPid = profileId.slice(0, 12);
                    if (delayState === 'rate-limit') {
                        logger.warn(`[GenNormal] Profile ${shortPid} rate-limited (${delayReason}) — ${remainSec}s remaining, queued=${queuedJobs}`);
                    }
                    else if (delayState === 'wave-cooldown') {
                        logger.info(`[GenNormal] Profile ${shortPid} wave cooldown — ${remainSec}s remaining, queued=${queuedJobs}`);
                    }
                    // Regular inter-submit delay (~5s) is expected and not logged.
                }
                return; // Exit, will retry on next cycle
            }
            else {
                // Delay đã hết — clear throttle để lần delay sau log ngay từ đầu
                this.profileDelayLogLastAt.delete(profileId);
            }
            // If rate limit delay has passed, clear it
            if (queue.rateLimitUntil && queue.rateLimitUntil <= now) {
                queue.rateLimitUntil = undefined;
                logger.info(`[GenNormal] ✅ Rate limit delay cleared for profile ${profileId}`);
            }
            if (queue.waveCooldownUntil && queue.waveCooldownUntil <= now) {
                queue.waveCooldownUntil = undefined;
                queue.pendingWaveSafeRefresh = false;
                logger.info(`[GenNormal] ✅ Wave cooldown cleared for profile ${profileId}`, {
                    profileId,
                    projectId,
                    waveSubmitCount: queue.waveSubmitCount,
                });
                this.logTimeline(profileId, 'wave-cooldown-cleared', {
                    projectId,
                    waveSubmitCount: queue.waveSubmitCount,
                });
            }
            // Per-profile concurrency: gen + upscale share the same maxConcurrency pool.
            // Only reserve slots for upscale when upscale jobs are actually running/queued.
            // When no upscale → gen uses full capacity. When upscale active → gen yields 1 batch.
            const batchSize = (projectId && this.projectBatchSize.get(projectId)) || this.DEFAULT_BATCH_SIZE;
            let activeUpscaleJobs = 0;
            let queuedUpscaleJobs = 0;
            try {
                [activeUpscaleJobs, queuedUpscaleJobs] = await Promise.all([
                    prisma.queueJob.count({
                        where: { profileId, status: 'processing', type: { in: ['video-upsampling', 'image-upsampling'] } }
                    }),
                    prisma.queueJob.count({
                        where: { profileId, status: 'queued', type: { in: ['video-upsampling', 'image-upsampling'] } }
                    })
                ]);
            }
            catch (_) { /* ignore */ }
            const hasUpscaleWork = activeUpscaleJobs > 0 || queuedUpscaleJobs > 0;
            const reservedUpscaleSlots = hasUpscaleWork ? batchSize : 0;
            const genLimit = Math.max(1, maxConcurrency - reservedUpscaleSlots);
            const nextQueuedMode = queue.queuedJobs[0]?.mode;
            const isImageGenQueued = nextQueuedMode === 'IMAGE_GENERATION';
            const isVideoQueued = nextQueuedMode != null &&
                ['TEXT_TO_VIDEO', 'REFERENCE_TO_VIDEO', 'REFERENCE_TO_VIDEO_AUDIO', 'IMAGE_TO_VIDEO', 'FRAME_TO_FRAME'].includes(nextQueuedMode);
            // Image BURST (batchSize>1): allow up to K batches in-flight per profile
            // (bounded pipeline). K=1 → serial (1 batch, 4 concurrent POSTs). K=2 →
            // pipeline (2 batches, 8 concurrent). Bounded by MAX_IMAGE_GEN_INFLIGHT so a
            // large K can't unbound the burst (>2 in-flight risks 403 unless score healthy).
            // VIDEO: async jobs linger in runningJobs until poll-complete, so cap at
            // MAX_VIDEO_INFLIGHT (else concurrency×batchSize stacks 20+ gens → 429 + OOM).
            const cappedGenLimit = isImageGenQueued
                ? (batchSize > 1
                    ? Math.min(batchSize * this.IMAGE_PIPELINE_MAX_BATCHES, this.MAX_IMAGE_GEN_INFLIGHT_PER_PROFILE)
                    : Math.max(1, Math.min(genLimit, this.MAX_IMAGE_GEN_INFLIGHT_PER_PROFILE)))
                : isVideoQueued
                    ? Math.max(1, Math.min(genLimit, this.MAX_VIDEO_INFLIGHT_PER_PROFILE))
                    : genLimit;
            const totalActiveForProfile = activeCount + activeUpscaleJobs;
            // For image/video in-flight caps, cappedGenLimit (checked via activeCount) is the
            // real ceiling; keep effectiveMax ≥ it so the upscale-aware second gate never
            // blocks below the cap even when project concurrency is low.
            const effectiveMax = (isImageGenQueued || isVideoQueued)
                ? Math.max(maxConcurrency, cappedGenLimit + reservedUpscaleSlots)
                : maxConcurrency;
            if (activeCount >= cappedGenLimit || totalActiveForProfile >= effectiveMax) {
                logger.debug(`[GenNormal] Profile ${profileId} at concurrency limit (gen=${activeCount}/${cappedGenLimit}, upscale=${activeUpscaleJobs}+${queuedUpscaleJobs}q, total=${totalActiveForProfile}/${maxConcurrency}), skipping`, {
                    profileId,
                    projectId,
                    activeCount,
                    activeUpscaleJobs,
                    queuedUpscaleJobs,
                    genLimit,
                    cappedGenLimit,
                    imageGenInflightCap: this.MAX_IMAGE_GEN_INFLIGHT_PER_PROFILE,
                    nextQueuedMode,
                    totalActiveForProfile,
                    maxConcurrency
                });
                return; // Exit, at concurrency limit
            }
            // Check if queue has jobs
            if (queue.queuedJobs.length === 0) {
                return; // Exit, no jobs to process
            }
            // 🔒 Per-profile captcha+submit serialization (fallback default).
            // Pattern: gen captcha → submit → gen captcha → submit. Jobs already
            // submitted continue polling in parallel up to concurrency cap. If
            // another job is in captcha+submit phase, skip this cycle.
            //
            // EXTENSION MODE: When `USE_EXTENSION_BRIDGE=1` (default), captcha is
            // minted in MAIN-world grecaptcha at ~200ms with high score, so
            // concurrent submits are safe — parallel ON. Operators can still force
            // serialize with `VEO3_PARALLEL_SUBMIT_PER_PROFILE=0`.
            const parallelEnv = process.env.VEO3_PARALLEL_SUBMIT_PER_PROFILE;
            const parallelSubmitEnabled = parallelEnv == null || parallelEnv === ''
                ? isExtensionBridgeMode()
                : parallelEnv === '1' || /^true$/i.test(parallelEnv);
            if (!parallelSubmitEnabled && queue.isSubmitting) {
                logger.debug(`[GenNormal] Profile ${profileId} đang submit job khác, skip cycle`, {
                    profileId,
                    projectId,
                    runningJobs: queue.runningJobs.size,
                    queuedJobs: queue.queuedJobs.length,
                });
                return;
            }
            // Submit next job for this profile (ONLY ONE per cycle to ensure proper delay)
            const nextJob = queue.queuedJobs.shift();
            if (nextJob) {
                // Check if job has retry delay (from error field: "RETRY:retryAtISO:errorMessage" or "RATE_LIMIT_RETRY:retryAtISO:errorMessage")
                const job = await prisma.genNormalJob.findUnique({
                    where: { id: nextJob.jobId },
                    select: { error: true, status: true }
                });
                if (job && job.error) {
                    // IMPORTANT: Check if error is non-retryable FIRST before processing retry delay
                    // This handles cases where job was queued for retry but error is actually non-retryable
                    // (e.g., PUBLIC_ERROR_UNSAFE_GENERATION, PUBLIC_ERROR_AUDIO_FILTERED, PUBLIC_ERROR_MINOR_UPLOAD)
                    if (isNonRetryableError(job.error)) {
                        logger.error(`[GenNormal] ❌ Job #${nextJob.index} has non-retryable error in queue. Marking as FAILED.`, {
                            jobId: nextJob.jobId,
                            error: job.error.substring(0, 200)
                        });
                        await prisma.genNormalJob.update({
                            where: { id: nextJob.jobId },
                            data: {
                                status: 'FAILED',
                                error: job.error.includes(':') ? job.error.split(':').slice(2).join(':') : job.error, // Extract actual error message
                                completedAt: new Date()
                            }
                        });
                        // Update project stats
                        const jobData = await prisma.genNormalJob.findUnique({
                            where: { id: nextJob.jobId },
                            select: { projectId: true }
                        });
                        if (jobData) {
                            await this.updateProjectStats(jobData.projectId);
                        }
                        return; // Skip this job, process next cycle
                    }
                    let retryAt = null;
                    // Check for RATE_LIMIT_RETRY format
                    if (job.error.startsWith('RATE_LIMIT_RETRY:')) {
                        const parts = job.error.split(':');
                        if (parts.length >= 3) {
                            try {
                                const retryAtISO = parts.slice(1, -1).join(':'); // Handle ISO string with colons
                                retryAt = new Date(retryAtISO).getTime();
                            }
                            catch (e) {
                                // Invalid date, ignore
                            }
                        }
                    }
                    // Check for RETRY format (non-rate-limit retry)
                    else if (job.error.startsWith('RETRY:')) {
                        const parts = job.error.split(':');
                        if (parts.length >= 3) {
                            try {
                                const retryAtISO = parts.slice(1, -1).join(':'); // Handle ISO string with colons
                                retryAt = new Date(retryAtISO).getTime();
                            }
                            catch (e) {
                                // Invalid date, ignore
                            }
                        }
                    }
                    // If job has retry delay and it hasn't expired yet, put it back and skip
                    if (retryAt && retryAt > now) {
                        const remainingMs = retryAt - now;
                        const remainingSeconds = Math.ceil(remainingMs / 1000);
                        // Put job back at the front of queue (it will be checked again next cycle)
                        queue.queuedJobs.unshift(nextJob);
                        logger.debug(`[GenNormal] Job #${nextJob.index} waiting for retry delay (${remainingSeconds}s remaining)`, {
                            jobId: nextJob.jobId,
                            profileId,
                            retryAt: new Date(retryAt).toISOString(),
                            remainingSeconds
                        });
                        return; // Exit this profile's processing, will retry on next cycle
                    }
                }
                // Add job to running set immediately (it's being submitted)
                queue.runningJobs.add(nextJob.jobId);
                // 🔒 Acquire per-profile submission lock. Chỉ 1 job được ở pha captcha+API/profile.
                // Job đã submit xong (đang POLL kết quả) vẫn nằm trong runningJobs song song bình thường.
                queue.isSubmitting = true;
                // 🕒 Reserve the delay slot NOW. `handleSubmitFired` will refresh it
                // when captcha actually completes, but the poll loop runs every 1s,
                // so without this tentative timestamp three sibling cycles could fire
                // in quick succession while waiting for the first captcha (~3s cold
                // start) — bypassing the per-profile `delaySeconds` entirely.
                queue.lastSubmitTime = now;
                const submitMode = parallelSubmitEnabled ? 'parallel' : '1-at-a-time';
                logger.info(`[GenNormal] 🚀 ${profileId.substring(0, 8)}... submit #${nextJob.index} (${submitMode}, active=${queue.runningJobs.size}, queued=${queue.queuedJobs.length})`);
                // 🔥 PIPELINING: For IMAGE_GENERATION and VIDEO (TEXT/IMAGE), we DETACH the submission (don't await)
                const isPipelinedMode = nextJob.mode === 'IMAGE_GENERATION' ||
                    nextJob.mode === 'TEXT_TO_VIDEO' ||
                    nextJob.mode === 'IMAGE_TO_VIDEO' ||
                    nextJob.mode === 'REFERENCE_TO_VIDEO' ||
                    nextJob.mode === 'REFERENCE_TO_VIDEO_AUDIO' ||
                    nextJob.mode === 'FRAME_TO_FRAME';
                // `isSubmitting` stays true until `executeJobSubmission` finishes (including full
                // browser XHR for image/video submit on real Chrome). Do not release after captcha only.
                // Safety net: nếu submitJob throw trước khi API return (vd: captcha fail)
                // → finally vẫn release để queue không treo.
                // ⚠️ KHÔNG reset403FailureCount ở .then() — submitJob catch 403 internally và
                // requeue (không throw out). Nếu reset ở đây, counter mãi mãi = 1, circuit breaker
                // không bao giờ trigger với profile lỗi liên tục.
                // Reset đã được call ở vị trí thực sự success (lines 2580, 2768) sau khi API trả OK.
                if (isPipelinedMode) {
                    this.executeJobSubmission(nextJob, queue)
                        .catch(error => {
                        this.handleSubmissionError(error, nextJob, queue, profileId);
                    })
                        .finally(() => {
                        if (queue.isSubmitting)
                            queue.isSubmitting = false;
                    });
                }
                else {
                    try {
                        await this.executeJobSubmission(nextJob, queue);
                    }
                    catch (error) {
                        await this.handleSubmissionError(error, nextJob, queue, profileId);
                    }
                    finally {
                        if (queue.isSubmitting)
                            queue.isSubmitting = false;
                    }
                }
            }
        }
        finally {
            // Mark profile as no longer actively processing
            this.profileProcessingActive.set(profileId, false);
        }
    }
    /**
     * Handle submission errors (extracted to support both awaited and detached execution)
     */
    async handleSubmissionError(error, nextJob, queue, profileId) {
        // Handle submission error - remove from running jobs
        queue.runningJobs.delete(nextJob.jobId);
        // Check if this is a cancellation error (project was cancelled during execution)
        if (this.isProjectCancelled(nextJob.projectId)) {
            logger.info(`[GenNormal] 🚫 Job ${nextJob.jobId} aborted - project was cancelled during execution`);
            return;
        }
        logger.error(`[GenNormal] ❌ Profile ${profileId.substring(0, 8)}... submission error for job ${nextJob.jobId}:`, error);
        // Check if it's a daily quota or traffic limit exhausted error - DO NOT RETRY
        const isUpgradeable = error?.message?.includes('PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED_UPGRADEABLE');
        const isDailyQuotaExhausted = isUpgradeable || isHardQuotaExhausted(error?.message, error);
        if (isDailyQuotaExhausted) {
            const errorMsg = isUpgradeable ? ERR_QUOTA_UPGRADEABLE : ERR_DAILY_QUOTA_REACHED;
            logger.error(`[GenNormal] 🚫 Profile ${profileId.substring(0, 8)}... DAILY QUOTA — failing this job only (other jobs keep running).`, {
                profileId,
                projectId: nextJob.projectId,
                jobId: nextJob.jobId,
                isUpgradeable,
            });
            // runningJobs.delete already called earlier in this function; helper is idempotent for that.
            await this.failJobsOnHardQuota(profileId, nextJob.projectId, [{ jobId: nextJob.jobId }], errorMsg);
            return;
        }
        // 🔐 Check if cookies/token expired (UNAUTHORIZED) — trip circuit breaker immediately
        const isUnauthorizedError = error?.message?.includes('UNAUTHORIZED') ||
            error?.message?.includes('không thể refresh từ cookies') ||
            error?.message?.includes('cookies đã hết hạn') ||
            error?.message?.includes('Vui lòng cập nhật cookies') ||
            error?.message?.includes('Token mới vẫn bị reject');
        if (isUnauthorizedError) {
            logger.warn(`[GenNormal] 🔐 Profile ${profileId.substring(0, 8)}... UNAUTHORIZED — attempting auto-recovery (browser refresh)...`, {
                profileId,
                jobId: nextJob.jobId
            });
            let recovered = false;
            try {
                captchaManager.notifyFailure();
                const { getProfileCookies } = await import('../../utils/profileCookies.js');
                const freshCookies = await getProfileCookies(profileId);
                if (freshCookies) {
                    const { refreshAccessTokenFromCookies } = await import('../../providers/utils/cookieAuth.js');
                    const { accessToken, expiresAt } = await refreshAccessTokenFromCookies(freshCookies, profileId);
                    if (accessToken) {
                        await prisma.profile.update({
                            where: { id: profileId },
                            data: { accessToken, accessTokenExpires: expiresAt }
                        });
                        recovered = true;
                        logger.info(`[GenNormal] auto-recovered profile ${profileId.substring(0, 8)} — token refreshed, requeuing job`);
                    }
                }
            }
            catch (recoveryErr) {
                logger.warn(`[GenNormal] auto-recovery failed for ${profileId.substring(0, 8)}: ${recoveryErr.message}`);
            }
            if (recovered) {
                // Recovery success — requeue job instead of failing
                await genNormalRepository.updateJob(nextJob.jobId, {
                    status: 'QUEUED',
                    error: null,
                    progress: 0
                });
                return;
            }
            // Recovery failed — trip circuit breaker + mark needs re-login
            // Auto-recovery fail = cookies hết hạn → 'dead' level ngay (cần re-login)
            logger.error(`[GenNormal] 🔐 Profile ${profileId.substring(0, 8)}... auto-recovery FAILED. Circuit breaker tripped (DEAD).`);
            this.tripCircuitBreaker(profileId, this.CIRCUIT_BREAKER_DEAD_THRESHOLD, 'dead');
            this.profile403FailureCount.set(profileId, this.CIRCUIT_BREAKER_DEAD_THRESHOLD);
            this.profilesNeedingRelogin.add(profileId);
            await genNormalRepository.updateJob(nextJob.jobId, {
                status: 'FAILED',
                error: 'Cookies/token đã hết hạn. Auto-recovery thất bại. Vui lòng cập nhật cookies trong Profile Manager.'
            });
            return;
        }
        // Check if it's a rate limit error
        const isRateLimitError = error?.message?.includes('429') ||
            error?.message?.includes('Too Many Requests') ||
            isTransientTrafficLimit(error?.message, error);
        const is403Error = error?.message?.includes('403') ||
            error?.message?.includes('evaluation failed') ||
            error?.message?.includes('reCAPTCHA');
        // \ud83d\udea8 HostTimeout detection: Google silent-drop request (no 403, no OK, just hang).
        // browser-fetch trong Electron tr\u1ea3 `HostTimeout` khi executeJavaScript timeout.
        // Sau N l\u1ea7n li\u00ean ti\u1ebfp \u2192 browser/session \u0111ang b\u1ecb soft-flag \u2192 auto force-reset.
        const isHostTimeout = error?.message?.includes('HostTimeout')
            || error?.message?.includes('executeJavaScript timeout')
            || error?.message?.includes('Image gen timeout');
        if (isHostTimeout) {
            const timeoutCount = (this.profileHostTimeoutCount.get(profileId) || 0) + 1;
            this.profileHostTimeoutCount.set(profileId, timeoutCount);
            logger.warn(`[GenNormal] \u23f1\ufe0f HostTimeout count for profile ${profileId.substring(0, 8)}...: ${timeoutCount}/${this.HOST_TIMEOUT_RESET_THRESHOLD}`, {
                profileId,
                jobId: nextJob.jobId,
                timeoutCount,
            });
            if (timeoutCount >= this.HOST_TIMEOUT_RESET_THRESHOLD) {
                logger.error(`[GenNormal] Profile ${profileId.substring(0, 8)} hit ${timeoutCount} HostTimeouts \u2192 captcha notify + 60s pause`);
                this.profileHostTimeoutCount.set(profileId, 0);
                captchaManager.notifyFailure();
                this.setProfileRateLimitDelay(profileId, 60, '403');
            }
            return;
        }
        if (isRateLimitError || is403Error) {
            const errorType = is403Error ? '403' : '429';
            let delaySeconds = 60;
            if (is403Error) {
                // Increment 403 failure count and get flat 20-30s delay
                const failureCount = this.increment403FailureCount(profileId);
                delaySeconds = this.getEscalatingDelay(profileId);
                // \ud83d\udd04 Rotate UA profile on 403. Hands off to rotateUaProfileNow /
                // deferUaRotation which schedule a captcha hard_reset via the
                // extension bridge \u2014 no browser-side reset needed here.
                try {
                    const queue = this.profileQueues.get(profileId);
                    if (queue && (queue.isSubmitting || queue.runningJobs.size > 0)) {
                        this.deferUaRotation(profileId, queue, failureCount, 0, 'profile-403');
                    }
                    else {
                        await this.rotateUaProfileNow(profileId, failureCount, 'profile-403');
                    }
                }
                catch (rotateError) {
                    logger.warn(`[GenNormal] ⚠️ UA rotation failed:`, rotateError.message);
                }
                // \ud83d\udd12 Fix #3: Sau force-reset do 403 burst, pause profile \u0111\u1ee7 l\u00e2u \u0111\u1ec3
                // browser m\u1edbi warm xong + Google clear flag; min 60s.
                // T\u0103ng l\u00ean max(delaySeconds, 60) \u0111\u1ec3 tr\u00e1nh job \u0111ang in-flight ti\u1ebfp t\u1ee5c 403.
                delaySeconds = Math.max(delaySeconds, 60);
            }
            this.setProfileRateLimitDelay(profileId, delaySeconds, errorType);
            logger.warn(`[GenNormal] \u26a0\ufe0f Setting ${delaySeconds}s delay for profile ${profileId.substring(0, 8)}...`, {
                profileId,
                errorType: is403Error ? '403 reCAPTCHA' : '429 Rate Limit',
                delaySeconds,
                failureCount: this.profile403FailureCount.get(profileId) || 0,
                note: is403Error ? 'Pause 60s sau force-reset \u0111\u1ec3 drain in-flight jobs + browser warm' : undefined,
            });
        }
    }
    /**
     * Quota ngày thật: chỉ FAIL đúng các job của đợt submit vừa lỗi. KHÔNG huỷ job
     * khác của profile, KHÔNG khoá profile — job đang PROCESSING (đã gửi Google),
     * upscale và tải về phải chạy tiếp bình thường; đợt sau Google tự quyết.
     * Caller phải tự xoá entry currentBatchJobs TRƯỚC khi gọi.
     */
    async failJobsOnHardQuota(profileId, projectId, jobsToFail, errorMsg) {
        const jobIds = jobsToFail.map((j) => j.jobId);
        await prisma.genNormalJob.updateMany({
            where: { id: { in: jobIds } },
            data: { status: 'FAILED', error: errorMsg, completedAt: new Date() },
        });
        const queue = this.profileQueues.get(profileId);
        for (const jobId of jobIds)
            queue?.runningJobs.delete(jobId);
        await this.updateProjectStats(projectId);
    }
    /**
     * Execute actual job submission (reCAPTCHA + API call)
     * ✅ TRUE PARALLEL: Per-profile reCAPTCHA gap allows true parallel processing
     * Different profiles can submit simultaneously, each with their own 15s reCAPTCHA gap
     */
    async executeJobSubmission(queuedJob, _queue) {
        this.logTimeline(queuedJob.profileId, 'submit-phase-start', {
            jobId: queuedJob.jobId,
            projectId: queuedJob.projectId,
            mode: queuedJob.mode,
        });
        // ✅ PER-PROFILE reCAPTCHA rate limit (instead of global)
        // This enables true parallel processing - Profile A can submit while Profile B waits for its own gap
        // ⚠️ Gap phụ thuộc job: VIDEO với reference/start image VÀ IMAGE_GENERATION có
        // reference images đều dùng 20s thay vì 15s. Xem getMinGapMsForJob.
        const minGapMs = this.getMinGapMsForJob(queuedJob);
        const lastRecaptchaTime = this.lastRecaptchaTimePerProfile.get(queuedJob.profileId) || 0;
        const timeSinceLastRecaptcha = Date.now() - lastRecaptchaTime;
        if (timeSinceLastRecaptcha < minGapMs) {
            const waitTime = minGapMs - timeSinceLastRecaptcha;
            // Per-profile reCAPTCHA gap log dropped — low signal (fires on every submit cycle).
            // Set LOG_LEVEL=debug to recover the waitTime/minGapMs details.
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        // NOTE: queue.isSubmitting được set/release ở processProfile (caller) để bao phủ toàn bộ
        // executeJobSubmission. Không set ở đây tránh race với detached promise wrapper.
        this.lastRecaptchaTimePerProfile.set(queuedJob.profileId, Date.now());
        // captchaManager serialises mints globally; the per-profile browser
        // submit lock was needed only in the deleted per-profile-Chrome model.
        // We still acquire a global concurrent-profile slot here.
        const releaseConcurrentSlot = await concurrentProfileLimit.acquire(queuedJob.profileId);
        try {
            await this.submitJob(queuedJob);
        }
        finally {
            this.logTimeline(queuedJob.profileId, 'submit-phase-finished', {
                jobId: queuedJob.jobId,
                projectId: queuedJob.projectId,
                mode: queuedJob.mode,
            });
            releaseConcurrentSlot();
        }
    }
    async submitJob(queuedJob) {
        try {
            // 🚫 Check if project has been cancelled before starting
            if (this.isProjectCancelled(queuedJob.projectId)) {
                logger.info(`[GenNormal] 🚫 Job ${queuedJob.jobId} skipped - project cancelled before submission`);
                return;
            }
            // Get job from database with project profile info
            const job = await prisma.genNormalJob.findUnique({
                where: { id: queuedJob.jobId },
                include: {
                    project: {
                        include: {
                            profiles: {
                                where: { profileId: queuedJob.profileId },
                                include: {
                                    profile: true
                                }
                            }
                        }
                    },
                    profile: true
                }
            });
            if (!job) {
                logger.warn(`[GenNormal] Job ${queuedJob.jobId} not found`);
                return;
            }
            // 🚫 Double-check cancellation after DB fetch
            if (this.isProjectCancelled(job.projectId)) {
                logger.info(`[GenNormal] 🚫 Job ${queuedJob.jobId} skipped - project cancelled during DB fetch`);
                return;
            }
            // Determine job mode early to decide if we should mark PROCESSING now or later
            const jobMode = job.mode || 'TEXT_TO_VIDEO';
            // ALL video modes AND IMAGE_GENERATION use batch - DON'T mark PROCESSING before API call
            // Jobs will be marked PROCESSING only AFTER successful API submission
            const allBatchModes = ['TEXT_TO_VIDEO', 'REFERENCE_TO_VIDEO', 'REFERENCE_TO_VIDEO_AUDIO', 'IMAGE_TO_VIDEO', 'FRAME_TO_FRAME', 'IMAGE_GENERATION'];
            const isBatchMode = allBatchModes.includes(jobMode);
            // For ALL BATCH modes (video + image): DON'T mark PROCESSING here
            // Jobs will be marked PROCESSING only after successful API response
            // This ensures status stays QUEUED if reCAPTCHA token fails or API errors
            if (isBatchMode) {
                // "Queued for batch processing" log dropped — the subsequent
                // "Submitting job to Veo3 API" line already announces this job.
            }
            else {
                // Only non-batch modes (if any) mark PROCESSING early
                // Clear retry error if this is a retry (rate limit or general retry)
                const updateData = {
                    status: 'PROCESSING',
                    startedAt: new Date(),
                    progress: 5
                };
                // Clear error if it was a retry (job is being retried)
                if (job.error && (job.error.startsWith('RATE_LIMIT_RETRY:') || job.error.startsWith('RETRY:'))) {
                    updateData.error = null; // Clear error on successful retry
                    logger.info(`[GenNormal] Clearing retry error for job ${job.id} - retry successful`, {
                        jobId: job.id,
                        jobIndex: job.jobIndex,
                        retryCount: job.retryCount,
                        wasRateLimit: job.error.startsWith('RATE_LIMIT_RETRY:')
                    });
                }
                await prisma.genNormalJob.update({
                    where: { id: job.id },
                    data: updateData
                });
                logger.info(`[GenNormal] Job ${job.id} (index ${job.jobIndex}) started processing`);
            }
            // Get Veo3 project ID for this profile
            // CRITICAL: For jobs with startImageMediaId/referenceImageMediaIds, MUST use the veo3ProjectId
            // where the images were uploaded/generated. Using a different project will cause 400 error.
            let veo3ProjectId = job.veo3ProjectId || undefined;
            // Log if job already has veo3ProjectId (set during creation)
            if (veo3ProjectId) {
                if (runtimeVerboseLogsEnabled()) {
                    logger.info(`[GenNormal] Using job's stored veo3ProjectId (set during creation)`, {
                        jobId: job.id,
                        profileId: job.profileId,
                        veo3ProjectId,
                        mode: job.mode,
                        hasStartImage: !!job.startImageMediaId,
                        hasReferenceImages: !!job.referenceImageMediaIds
                    });
                }
            }
            // For edit jobs (IMAGE_GENERATION with reference images), try to get veo3ProjectId from the original job
            if (!veo3ProjectId && job.mode === 'IMAGE_GENERATION' && job.referenceImageMediaIds) {
                try {
                    const refImageMediaIds = typeof job.referenceImageMediaIds === 'string'
                        ? JSON.parse(job.referenceImageMediaIds)
                        : job.referenceImageMediaIds;
                    if (Array.isArray(refImageMediaIds) && refImageMediaIds.length > 0) {
                        // Check if this is an edit job (has a completed job with same jobIndex)
                        const originalJob = await prisma.genNormalJob.findFirst({
                            where: {
                                projectId: job.projectId,
                                jobIndex: job.jobIndex,
                                status: 'COMPLETED',
                                mode: 'IMAGE_GENERATION',
                                id: { not: job.id }
                            },
                            orderBy: { completedAt: 'desc' }
                        });
                        if (originalJob?.veo3ProjectId) {
                            veo3ProjectId = originalJob.veo3ProjectId;
                            logger.info(`[GenNormal] Using original job's Veo3 project ID for edit job`, {
                                jobId: job.id,
                                originalJobId: originalJob.id,
                                veo3ProjectId,
                                baseImageMediaId: refImageMediaIds[0]?.substring(0, 50) + '...'
                            });
                        }
                    }
                }
                catch (error) {
                    logger.warn(`[GenNormal] Failed to check for original job, will try project profile`, {
                        jobId: job.id,
                        error: error.message
                    });
                }
            }
            // If still no veo3ProjectId, get from project profile
            // This is the FALLBACK for legacy jobs created before veo3ProjectId was stored
            if (!veo3ProjectId) {
                const refreshedProject = await genNormalRepository.getProject(job.projectId);
                if (!refreshedProject) {
                    throw new Error(`Project ${job.projectId} not found`);
                }
                const projectProfile = refreshedProject.profiles.find((p) => p.profileId === job.profileId);
                // CRITICAL: If profile is deleted from project, fail the job immediately
                if (!projectProfile) {
                    const errorMsg = `Profile ${job.profileId} has been removed from this project. Job cannot proceed.`;
                    logger.error(`[GenNormal] ERROR: ${errorMsg}`, {
                        jobId: job.id,
                        projectId: job.projectId,
                        profileId: job.profileId,
                        availableProfiles: refreshedProject.profiles.map(p => ({ profileId: p.profileId, veo3ProjectId: p.veo3ProjectId, name: p.profile.name })) || []
                    });
                    // Mark job as FAILED
                    await prisma.genNormalJob.update({
                        where: { id: job.id },
                        data: {
                            status: 'FAILED',
                            error: errorMsg,
                            completedAt: new Date()
                        }
                    });
                    // Remove from running jobs
                    const queue = this.profileQueues.get(queuedJob.profileId);
                    if (queue) {
                        queue.runningJobs.delete(queuedJob.jobId);
                    }
                    await this.updateProjectStats(job.projectId);
                    return; // Exit early - job is failed
                }
                if (!projectProfile.veo3ProjectId) {
                    logger.error(`[GenNormal] ERROR: No Veo3 project ID found for profile ${job.profileId}`, {
                        jobId: job.id,
                        projectId: job.projectId,
                        profileId: job.profileId,
                        projectProfileExists: !!projectProfile,
                        availableProfiles: refreshedProject.profiles.map(p => ({ profileId: p.profileId, veo3ProjectId: p.veo3ProjectId, name: p.profile.name })) || []
                    });
                    throw new Error(`No Veo3 project ID found for profile ${job.profileId}`);
                }
                veo3ProjectId = projectProfile.veo3ProjectId;
                logger.info(`[GenNormal] Resolved Veo3 project ID from project profile (fallback for legacy job)`, {
                    jobId: job.id,
                    profileId: job.profileId,
                    veo3ProjectId,
                    note: 'Job was created before veo3ProjectId storage was implemented'
                });
            }
            // Ensure veo3ProjectId is defined
            if (!veo3ProjectId) {
                throw new Error(`Failed to resolve Veo3 project ID for job ${job.id}`);
            }
            const liveQueue = this.profileQueues.get(queuedJob.profileId);
            if (liveQueue) {
                liveQueue.veo3ProjectId = veo3ProjectId;
            }
            const refreshedProject = await genNormalRepository.getProject(job.projectId);
            const projectProfile = refreshedProject?.profiles.find((p) => p.profileId === job.profileId);
            if (runtimeVerboseLogsEnabled()) {
                logger.info(`[GenNormal] Using Veo3 project ID: ${veo3ProjectId}`, {
                    jobId: job.id,
                    profileId: job.profileId,
                    profileName: job.profile.name,
                    source: job.veo3ProjectId ? 'from_job' : 'from_project_profile',
                    allProjectProfiles: job.project.profiles.map(p => ({
                        profileId: p.profileId,
                        veo3ProjectId: p.veo3ProjectId,
                        name: p.profile.name
                    }))
                });
            }
            // Get cookies from partition
            const cookiesString = await getProfileCookies(job.profile.id);
            // Reuse cached provider per profile — one instance handles all jobs for a profile.
            // Each profile has its own provider with its own credentials, so no race condition.
            let provider = this.profileProviders.get(job.profile.id);
            if (!provider) {
                provider = new Veo3Service();
                this.profileProviders.set(job.profile.id, provider);
                logger.info(`[GenNormal] Created provider for profile ${job.profile.name} (cached for reuse)`, {
                    profileId: job.profile.id,
                    profileName: job.profile.name
                });
            }
            // Get proxy configuration OBJECT (for HttpsProxyAgent, not string form)
            let proxyConfig = null;
            try {
                const { profileService } = await import('../profiles/profile.service.js');
                proxyConfig = await profileService.getProxyConfigObject(job.profile.id);
            }
            catch (e) {
                // Non-critical — continue without proxy
            }
            // Update provider config with latest credentials (token may have been refreshed)
            provider.updateConfig({
                accessToken: job.profile.accessToken || undefined,
                cookies: cookiesString,
                profileId: job.profile.id,
                veo3ProjectId: veo3ProjectId,
                proxyConfig,
                onTokenRefreshed: async (newToken) => {
                    await prisma.profile.update({
                        where: { id: job.profileId },
                        data: {
                            accessToken: newToken,
                            accessTokenExpires: new Date(Date.now() + 55 * 60 * 1000)
                        }
                    });
                }
            });
            // 🚫 Check cancellation before making expensive API call
            if (this.isProjectCancelled(job.projectId)) {
                logger.info(`[GenNormal] 🚫 Job ${job.id} aborted - project cancelled before Veo3 API call`);
                return;
            }
            // Submit job to Veo3 API using generateVideo with actual Veo3 project ID
            // Handle different modes
            // Note: jobMode already defined above for batch mode check
            // Resolve correct video model key based on generation type and aspect ratio
            // Handle aspect ratio: can be either format (9:16, 16:9) or enum (VIDEO_ASPECT_RATIO_PORTRAIT, VIDEO_ASPECT_RATIO_LANDSCAPE)
            const projectAspectRatio = job.project.aspectRatio || 'VIDEO_ASPECT_RATIO_LANDSCAPE';
            let aspectRatio;
            let aspectRatioEnum;
            if (projectAspectRatio.startsWith('VIDEO_ASPECT_RATIO_')) {
                // Already in enum format
                aspectRatioEnum = projectAspectRatio;
                const aspectRatioMap = {
                    'VIDEO_ASPECT_RATIO_PORTRAIT': '9:16',
                    'VIDEO_ASPECT_RATIO_LANDSCAPE': '16:9'
                };
                aspectRatio = aspectRatioMap[aspectRatioEnum] || '16:9';
            }
            else {
                // In format (9:16, 16:9) - convert to enum
                aspectRatio = (projectAspectRatio === '9:16' || projectAspectRatio === '16:9')
                    ? projectAspectRatio
                    : '16:9';
                aspectRatioEnum = convertAspectRatioToEnum(aspectRatio);
            }
            // Determine generation type for model resolution
            let generationType = 'TEXT_TO_VIDEO';
            if (jobMode === 'FRAME_TO_FRAME') {
                generationType = 'FRAME_TO_FRAME'; // Có cả start và end image
            }
            else if (jobMode === 'IMAGE_TO_VIDEO') {
                generationType = 'IMAGE_TO_VIDEO'; // Chỉ có start image
            }
            else if (jobMode === 'REFERENCE_TO_VIDEO') {
                generationType = 'REFERENCE_TO_VIDEO';
            }
            else if (jobMode === 'REFERENCE_TO_VIDEO_AUDIO') {
                generationType = 'REFERENCE_TO_VIDEO_AUDIO'; // r2v models + referenceAudio at request time
            }
            // Resolve video model key based on generation type and project settings
            // All types use getModelKeyForGenerationType for consistency
            // Step 1: Detect family + quality from project.videoModelKey (if exists)
            // 2026-05-16: Flow API removed "Fast [Lower Priority]" (`*_ultra_relaxed`).
            // Legacy projects still carrying that suffix fall back to `fast` so the
            // submit no longer hits a deprecated key.
            // 2026-05-25: Added Omni Flash family — single tier, duration-driven.
            const projectModelKey = job.project.videoModelKey || '';
            const isOmniFlash = isOmniFlashKey(projectModelKey);
            const family = isOmniFlash ? 'omni_flash' : 'veo_3_1';
            let quality = 'fast'; // default
            if (!isOmniFlash) {
                const isLite = projectModelKey.includes('_lite') || projectModelKey.includes('interpolation_lite');
                if (isLite && projectModelKey.includes('_low_priority')) {
                    quality = 'lite_relaxed';
                }
                else if (isLite) {
                    quality = 'lite';
                }
                else if (projectModelKey && !projectModelKey.includes('_ultra') && !projectModelKey.includes('_fast')) {
                    quality = 'quality';
                }
            }
            // Omni Flash duration: prefer per-job snapshot, fall back to project default, then 8s.
            const duration = job.videoDurationSeconds ?? job.project.videoDurationSeconds ?? undefined;
            // Step 2: Get correct model key from model maps
            // This ensures IMAGE_TO_VIDEO and FRAME_TO_FRAME get correct _fl suffix (Veo 3.1),
            // and abra_{t2v,r2v}_${duration}s (Omni Flash).
            let videoModelKey = getModelKeyForGenerationType(generationType, aspectRatioEnum, quality, duration, family);
            // Step 3: Fallback to project model key if lookup fails
            if (!videoModelKey) {
                videoModelKey = projectModelKey || resolveVideoModelKey(generationType, aspectRatio, quality, duration, family).modelKey;
            }
            if (runtimeVerboseLogsEnabled()) {
                logger.info(`[GenNormal] Resolved video model key`, {
                    jobId: job.id,
                    videoModelKey,
                    generationType,
                    family,
                    quality,
                    duration,
                    aspectRatio: aspectRatioEnum,
                    projectModelKey: projectModelKey || null
                });
            }
            // For IMAGE_TO_VIDEO and FRAME_TO_FRAME: sceneId will come from API response
            // We can optionally send a sceneId in request, but API will return the actual sceneId to use
            // For other modes: sceneId is optional
            let generateVideoOptions = {
                projectId: veo3ProjectId,
                prompt: job.prompt,
                aspectRatio: job.project.aspectRatio,
                videoModelKey: videoModelKey, // Use project videoModelKey or resolved model key
                // sceneId: Optional - can send UUID, but API response will contain the actual sceneId to use
                // For IMAGE_TO_VIDEO/FRAME_TO_FRAME, we'll get sceneId from API response
                sceneId: job.sceneId || this.generateUUID() // Send UUID if available, otherwise generate one
            };
            // Handle IMAGE_GENERATION mode separately with BATCH support
            if (jobMode === 'IMAGE_GENERATION') {
                // Try to collect more IMAGE_GENERATION jobs from same profile for batch processing
                const batchJobs = await this.collectImageBatchJobs(queuedJob.profileId, queuedJob.jobId);
                const isBatchMode = batchJobs.length > 1;
                logger.info(`[GenNormal] Processing IMAGE_GENERATION ${isBatchMode ? `BATCH of ${batchJobs.length} jobs` : `single job ${job.id}`} (idx=${job.jobIndex}, profile=${job.profile.name}, promptLen=${job.prompt.length}${job.referenceImageMediaIds ? ', refs' : ''})`);
                // Convert aspect ratio for image generation API. Supports 5 ratios:
                // 16:9, 9:16, 1:1, 3:4, 4:3 — matches Flow API's IMAGE_ASPECT_RATIO_* enum.
                const rawAspectRatio = job.project.aspectRatio || aspectRatio || '16:9';
                const imageAspectRatioMap = {
                    '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
                    '3:4': 'IMAGE_ASPECT_RATIO_PORTRAIT_3_4',
                    '4:3': 'IMAGE_ASPECT_RATIO_LANDSCAPE_4_3',
                    '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT',
                    '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
                    'VIDEO_ASPECT_RATIO_PORTRAIT': 'IMAGE_ASPECT_RATIO_PORTRAIT',
                    'VIDEO_ASPECT_RATIO_LANDSCAPE': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
                };
                const imageAspectRatio = imageAspectRatioMap[rawAspectRatio] ?? 'IMAGE_ASPECT_RATIO_LANDSCAPE';
                const veo3Service = provider;
                // For IMAGE_GENERATION: prefer dedicated imageModelKey; legacy projects may
                // have the user choice persisted in videoModelKey, so fall back to that.
                // Normalize: removed/unknown keys (e.g. legacy 'R2I', 'IMAGEN_3_5') → 'GEM_PIX_2'.
                const imageModelName = normalizeImageModelKey(job.project.imageModelKey ||
                    job.project.videoModelKey);
                if (isBatchMode) {
                    // BATCH MODE: Process multiple jobs in single API call
                    logger.info(`[GenNormal] 📦 BATCH MODE: Processing ${batchJobs.length} IMAGE_GENERATION jobs in single API call`, {
                        profileId: job.profileId,
                        jobIds: batchJobs.map(j => j.jobId)
                    });
                    // 🔴 Track batch jobs for error handling (requeue all on 403)
                    this.currentBatchJobs.set(queuedJob.jobId, batchJobs);
                    // Load all job details for batch
                    const batchJobDetails = await Promise.all(batchJobs.map(async (qj) => {
                        const jobDetail = await prisma.genNormalJob.findUnique({
                            where: { id: qj.jobId },
                            include: {
                                profile: true,
                                project: true
                            }
                        });
                        return { queuedJob: qj, job: jobDetail };
                    }));
                    // 🚫 Check cancellation before starting reCAPTCHA
                    if (this.isProjectCancelled(job.projectId)) {
                        logger.info(`[GenNormal] 🚫 Image batch aborted - project cancelled before reCAPTCHA`, {
                            projectId: job.projectId,
                            batchSize: batchJobs.length
                        });
                        return;
                    }
                    // 🟢 IMAGE_GENERATION STEP 1: Mark all batch jobs as PROCESSING 5% (starting reCAPTCHA)
                    logger.info(`[GenNormal] 🖼️ IMAGE_GENERATION: Marking ${batchJobs.length} jobs as PROCESSING 5% (starting reCAPTCHA)`);
                    await Promise.all(batchJobDetails.map(async ({ job: jobDetail }) => {
                        if (jobDetail) {
                            await prisma.genNormalJob.update({
                                where: { id: jobDetail.id },
                                data: {
                                    status: 'PROCESSING',
                                    progress: 5,
                                    error: null
                                }
                            });
                        }
                    }));
                    await this.updateProjectStats(job.projectId);
                    // Build prompts array for batch API with UNIQUE SEED per job for tracking
                    // Use jobIndex as seed base to ensure uniqueness and traceability
                    const seedToJobMap = new Map();
                    const prompts = batchJobDetails.map(({ job: jobDetail, queuedJob: qj }) => {
                        if (!jobDetail)
                            return null;
                        // Generate unique seed based on jobIndex (ensures reproducibility and tracking)
                        const seed = (jobDetail.jobIndex + 1) * 1000 + Math.floor(Math.random() * 999);
                        seedToJobMap.set(seed, { job: jobDetail, queuedJob: qj });
                        // Get reference image media IDs
                        let refImageMediaIds = [];
                        try {
                            if (jobDetail.referenceImageMediaIds) {
                                refImageMediaIds = typeof jobDetail.referenceImageMediaIds === 'string'
                                    ? JSON.parse(jobDetail.referenceImageMediaIds)
                                    : jobDetail.referenceImageMediaIds;
                            }
                        }
                        catch (e) {
                            logger.warn(`[GenNormal] Failed to parse referenceImageMediaIds for batch job ${jobDetail.id}`);
                        }
                        const uniqueRefImageMediaIds = [...new Set(refImageMediaIds)];
                        return {
                            prompt: jobDetail.prompt,
                            seed, // ✅ Unique seed for tracking
                            referenceImageMediaIds: uniqueRefImageMediaIds.length > 0 ? uniqueRefImageMediaIds : undefined,
                            imageInputType: uniqueRefImageMediaIds.length > 0 ? 'IMAGE_INPUT_TYPE_REFERENCE' : undefined,
                        };
                    }).filter(p => p !== null);
                    // Compact one-liner (was a multi-line JSON block per batch). Full detail
                    // only under verbose logs.
                    if (runtimeVerboseLogsEnabled()) {
                        logger.info(`[GenNormal] 📦 Batch seeds mapping:`, {
                            seeds: Array.from(seedToJobMap.entries()).map(([seed, { job }]) => ({
                                seed,
                                jobId: job?.id,
                                jobIndex: job?.jobIndex,
                            })),
                        });
                    }
                    else {
                        logger.info(`[GenNormal] 📦 Batch: ${seedToJobMap.size} jobs, seeds=[${Array.from(seedToJobMap.keys()).join(',')}]`);
                    }
                    // 🚫 Check cancellation before expensive image batch API call
                    if (this.isProjectCancelled(job.projectId)) {
                        logger.info(`[GenNormal] 🚫 Image batch aborted - project cancelled before API call`, {
                            projectId: job.projectId,
                            batchSize: batchJobs.length
                        });
                        return;
                    }
                    let batchResults;
                    try {
                        // Call batch API with progress callback
                        batchResults = await veo3Service.generateBatchImages({
                            projectId: veo3ProjectId,
                            imageModelName,
                            imageAspectRatio: imageAspectRatio,
                            prompts,
                            // 🟢 IMAGE_GENERATION STEP 2: Mark all batch jobs as PROCESSING 25% after reCAPTCHA success
                            onRecaptchaComplete: async () => {
                                // "reCAPTCHA success! Marking …" log dropped — prior
                                // "✅ [reCAPTCHA Batch] … Done" already announces success.
                                // Avoid warm bursts right between token mint and submit on real-Chrome.
                                // Those bursts can still perturb timing/score and increase sporadic 403.
                                const allowWarmNearSubmit = process.env.VEO3_ALLOW_WARM_ON_RECAPTCHA === '1' ||
                                    /^true$/i.test(String(process.env.VEO3_ALLOW_WARM_ON_RECAPTCHA ?? ''));
                                await Promise.all(batchJobDetails.map(async ({ job: jobDetail }) => {
                                    if (jobDetail) {
                                        await prisma.genNormalJob.update({
                                            where: { id: jobDetail.id },
                                            data: {
                                                progress: 25
                                            }
                                        });
                                    }
                                }));
                            },
                            // 🔓 Start the inter-submit cooldown only after captcha -> submit -> clr
                            // has actually happened in the browser context.
                            onSubmitFired: () => {
                                this.handleSubmitFired(queuedJob);
                            }
                        });
                    }
                    catch (batchError) {
                        if (isVerificationRejected(batchError)) {
                            await this.failJobsForVerification(queuedJob, batchJobs);
                            return;
                        }
                        // Handle batch API error - decide FAILED or RETRY for all jobs in batch
                        const errorMessage = batchError.message || 'Unknown batch error';
                        const isUpgradeable = errorMessage.includes('PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED_UPGRADEABLE');
                        const isDailyQuotaExhausted = isUpgradeable || isHardQuotaExhausted(errorMessage, batchError);
                        if (isDailyQuotaExhausted) {
                            const errorMsg = isUpgradeable ? ERR_QUOTA_UPGRADEABLE : ERR_DAILY_QUOTA_REACHED;
                            logger.error(`[GenNormal] 🚫 Batch daily quota — failing this batch only (${batchJobs.length} jobs).`, {
                                jobIds: batchJobs.map(j => j.jobId),
                                profileId: queuedJob.profileId,
                                isUpgradeable,
                            });
                            this.currentBatchJobs.delete(queuedJob.jobId);
                            await this.failJobsOnHardQuota(queuedJob.profileId, queuedJob.projectId, batchJobs.map(j => ({ jobId: j.jobId })), errorMsg);
                            return;
                        }
                        const isNonRetryable = isNonRetryableError(errorMessage) || batchError?.isNonRetryable === true;
                        // Browser race: NOT a real 403 — just retry quickly
                        const isBrowserRaceErrorImg = errorMessage.includes('Object has been destroyed') ||
                            errorMessage.includes('Browser was destroyed') ||
                            errorMessage.includes('Browser destroyed before') ||
                            errorMessage.includes('ERR_FAILED (-2)');
                        const isRecaptchaFailure = !isBrowserRaceErrorImg && (batchError?.isRecaptchaFailure ||
                            errorMessage.includes('reCAPTCHA evaluation failed') ||
                            errorMessage.includes('Xác thực reCAPTCHA thất bại') ||
                            errorMessage.includes('Failed to obtain reCAPTCHA') ||
                            errorMessage.includes('grecaptcha not available') ||
                            errorMessage.includes('reCAPTCHA token request timeout') ||
                            errorMessage.includes('reCAPTCHA token timeout'));
                        const isRateLimit = errorMessage.includes('429') ||
                            errorMessage.includes('rate limit') ||
                            errorMessage.includes('RESOURCE_EXHAUSTED') ||
                            errorMessage.includes('Quota Exceeded') ||
                            errorMessage.includes('PUBLIC_ERROR_USER_REQUESTS_THROTTLED') ||
                            errorMessage.includes('PUBLIC_ERROR_HIGH_TRAFFIC') ||
                            batchError?.status === 429 ||
                            batchError?.errorText?.includes('PUBLIC_ERROR_USER_REQUESTS_THROTTLED') ||
                            // TOO_MUCH_TRAFFIC: trần tốc độ tạm thời — delay per-profile + retry (cap 3), KHÔNG dừng project.
                            isTransientTrafficLimit(errorMessage, batchError);
                        logger.error(`[GenNormal] ❌ Batch Image API failed for ${batchJobs.length} jobs:`, {
                            error: errorMessage.substring(0, 300),
                            isNonRetryable,
                            isRecaptchaFailure,
                            isRateLimit,
                            errorStatus: batchError?.status,
                            jobIds: batchJobs.map(j => j.jobId)
                        });
                        if (isNonRetryable) {
                            await this.invalidatePaygateTierIfModelAccessDenied(errorMessage, queuedJob.projectId);
                            // Mark ALL jobs in batch as FAILED
                            for (const bj of batchJobs) {
                                await prisma.genNormalJob.update({
                                    where: { id: bj.jobId },
                                    data: {
                                        status: 'FAILED',
                                        error: errorMessage,
                                        completedAt: new Date()
                                    }
                                });
                                const queue = this.profileQueues.get(bj.profileId);
                                if (queue)
                                    queue.runningJobs.delete(bj.jobId);
                            }
                            logger.error(`[GenNormal] ❌ Batch Image FAILED (non-retryable): ${batchJobs.length} jobs marked FAILED`);
                        }
                        else if (isBrowserRaceErrorImg) {
                            // Browser race — quick silent retry, no rotation. Ceiling prevents
                            // unbounded loop if browser race keeps recurring.
                            const survivors = await this.enforceBatchRetryCeiling(batchJobs, errorMessage);
                            logger.warn(`[GenNormal] 🔄 Browser race (image batch) — ${survivors.length}/${batchJobs.length} jobs back to queue (3s, no rotation)`);
                            const queue = this.profileQueues.get(queuedJob.profileId);
                            for (const bj of survivors) {
                                const bjData = await prisma.genNormalJob.findUnique({
                                    where: { id: bj.jobId },
                                    select: { retryCount: true }
                                });
                                await prisma.genNormalJob.update({
                                    where: { id: bj.jobId },
                                    data: { status: 'QUEUED', error: null, progress: 0, retryCount: (bjData?.retryCount ?? 0) + 1 }
                                });
                                if (queue) {
                                    queue.runningJobs.delete(bj.jobId);
                                    queue.queuedJobs.push({ jobId: bj.jobId, profileId: bj.profileId, projectId: bj.projectId, veo3ProjectId: bj.veo3ProjectId, index: bj.index, mode: bj.mode, addedAt: Date.now() });
                                }
                            }
                            this.setProfileRateLimitDelay(queuedJob.profileId, 3, '403');
                            await this.updateProjectStats(queuedJob.projectId);
                        }
                        else {
                            // Retryable error - put jobs back to queue with proper status and delay
                            const queue = this.profileQueues.get(queuedJob.profileId);
                            if (isRateLimit || isRecaptchaFailure) {
                                const errorType = isRecaptchaFailure ? '403' : '429';
                                const RATE_LIMIT_MAX_RETRIES = 3;
                                let delaySeconds;
                                if (isRecaptchaFailure) {
                                    const failureCount = this.increment403FailureCount(queuedJob.profileId);
                                    const isSilentRetry = failureCount <= 3;
                                    if (isSilentRetry) {
                                        delaySeconds = this.getRecaptchaSilentRetryDelaySec();
                                        logger.warn(`[GenNormal] 🔄 Silent reCAPTCHA retry #${failureCount}/3 (image batch) for profile ${queuedJob.profileId.substring(0, 8)}... - retrying in ${delaySeconds}s without notifying user`);
                                    }
                                    else {
                                        delaySeconds = this.getEscalatingDelay(queuedJob.profileId);
                                        logger.warn(`[GenNormal] ⚠️ reCAPTCHA failed ${failureCount} times (image batch), escalating delay to ${delaySeconds}s and notifying user`);
                                    }
                                    if (failureCount >= 3) {
                                        // Sustained streak = score death → have the extension clear the anchor cookie + reload.
                                        this.triggerExtensionAnchorReset(queuedJob.profileId, failureCount);
                                    }
                                    if (failureCount >= 3 && this.shouldRunRecovery(queuedJob.profileId, 'rotate-ua-image-batch')) {
                                        try {
                                            if (queue && (queue.isSubmitting || this.getOtherRunningJobs(queue, batchJobs.length) > 0)) {
                                                this.deferUaRotation(queuedJob.profileId, queue, failureCount, batchJobs.length, 'image-batch-403');
                                            }
                                            else {
                                                await this.rotateUaProfileNow(queuedJob.profileId, failureCount, 'image-batch');
                                            }
                                        }
                                        catch (rotateError) {
                                            logger.warn(`[GenNormal] ⚠️ UA rotation failed:`, rotateError.message);
                                        }
                                    }
                                }
                                else {
                                    delaySeconds = this.getRateLimitDelaySec(queuedJob.profileId, errorMessage, batchError);
                                    logger.warn(`[GenNormal] ⏰ 429 rate limit (image batch) for profile ${queuedJob.profileId.substring(0, 8)}... - pausing profile queue for ${delaySeconds}s`);
                                }
                                const delayRetryAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
                                const failureCount403 = this.profile403FailureCount.get(queuedJob.profileId) || 0;
                                const isSilentRetryBatch = isRecaptchaFailure && failureCount403 <= 3;
                                for (const bj of batchJobs) {
                                    const bjData = await prisma.genNormalJob.findUnique({
                                        where: { id: bj.jobId },
                                        select: { retryCount: true }
                                    });
                                    const retryCount = (bjData?.retryCount || 0) + 1;
                                    if (retryCount > RATE_LIMIT_MAX_RETRIES) {
                                        await prisma.genNormalJob.update({
                                            where: { id: bj.jobId },
                                            data: {
                                                status: 'FAILED',
                                                error: `Đã retry ${RATE_LIMIT_MAX_RETRIES} lần do ${errorType === '429' ? 'rate limit (429)' : 'reCAPTCHA (403)'}. ${errorMessage.substring(0, 150)}`,
                                                completedAt: new Date()
                                            }
                                        });
                                        if (queue)
                                            queue.runningJobs.delete(bj.jobId);
                                        logger.error(`[GenNormal] 🛑 Image job ${bj.jobId} exceeded ${RATE_LIMIT_MAX_RETRIES} rate-limit retries — marking FAILED`);
                                        continue;
                                    }
                                    const errorMessage403 = isSilentRetryBatch
                                        ? null
                                        : `RATE_LIMIT_RETRY:${delayRetryAt}:${isRecaptchaFailure ? '403 - reCAPTCHA evaluation failed' : '429 - Rate limited'}`;
                                    await prisma.genNormalJob.update({
                                        where: { id: bj.jobId },
                                        data: {
                                            status: 'QUEUED',
                                            error: errorMessage403,
                                            progress: 0,
                                            retryCount
                                        }
                                    });
                                    if (queue) {
                                        queue.runningJobs.delete(bj.jobId);
                                    }
                                }
                                if (queue) {
                                    for (const bj of batchJobs.slice().reverse()) {
                                        const jobDetail = await prisma.genNormalJob.findUnique({
                                            where: { id: bj.jobId },
                                            select: { mode: true, projectId: true, jobIndex: true, status: true }
                                        });
                                        if (jobDetail && jobDetail.status === 'QUEUED') {
                                            queue.queuedJobs.unshift({
                                                jobId: bj.jobId,
                                                profileId: bj.profileId,
                                                projectId: jobDetail.projectId,
                                                index: jobDetail.jobIndex,
                                                mode: jobDetail.mode || 'IMAGE_GENERATION',
                                                addedAt: Date.now()
                                            });
                                        }
                                    }
                                }
                                this.setProfileRateLimitDelay(queuedJob.profileId, delaySeconds, errorType);
                            }
                            else {
                                // Not rate limit/captcha - generic retry if allowed
                                const isServerError = errorMessage.includes('500') || errorMessage.includes('503') ||
                                    errorMessage.includes('INTERNAL') || errorMessage.includes('UNAVAILABLE');
                                const singleRetryDelay = isServerError ? 10 : 60;
                                const errorTypeLabel = isServerError ? '500 Server Error' : 'Generic Error';
                                const errorMessageGeneric = errorMessage.substring(0, 200);
                                logger.warn(`[GenNormal] ⚠️ ${errorTypeLabel} (image batch). Retrying jobs in ${singleRetryDelay}s`);
                                const delayRetryAt = new Date(Date.now() + singleRetryDelay * 1000).toISOString();
                                for (const bj of batchJobs) {
                                    const bjData = await prisma.genNormalJob.findUnique({
                                        where: { id: bj.jobId },
                                        select: { retryCount: true, maxRetries: true }
                                    });
                                    const canRetry = (bjData?.retryCount || 0) < (bjData?.maxRetries || 10);
                                    if (canRetry) {
                                        await prisma.genNormalJob.update({
                                            where: { id: bj.jobId },
                                            data: {
                                                status: 'QUEUED',
                                                error: `RETRY:${delayRetryAt}:${errorMessageGeneric}`,
                                                progress: 0,
                                                retryCount: (bjData?.retryCount || 0) + 1
                                            }
                                        });
                                        if (queue)
                                            queue.runningJobs.delete(bj.jobId);
                                    }
                                    else {
                                        await prisma.genNormalJob.update({
                                            where: { id: bj.jobId },
                                            data: {
                                                status: 'FAILED',
                                                error: errorMessageGeneric,
                                                completedAt: new Date()
                                            }
                                        });
                                        if (queue)
                                            queue.runningJobs.delete(bj.jobId);
                                    }
                                }
                                if (queue) {
                                    for (const bj of batchJobs.slice().reverse()) {
                                        const jobDetail = await prisma.genNormalJob.findUnique({
                                            where: { id: bj.jobId },
                                            select: { mode: true, projectId: true, jobIndex: true, status: true }
                                        });
                                        if (jobDetail && jobDetail.status === 'QUEUED') {
                                            queue.queuedJobs.unshift({
                                                jobId: bj.jobId,
                                                profileId: bj.profileId,
                                                projectId: jobDetail.projectId,
                                                index: jobDetail.jobIndex,
                                                mode: jobDetail.mode || 'IMAGE_GENERATION',
                                                addedAt: Date.now()
                                            });
                                        }
                                    }
                                }
                                this.setProfileRateLimitDelay(queuedJob.profileId, singleRetryDelay, isServerError ? '500' : '429');
                            }
                        }
                        this.currentBatchJobs.delete(queuedJob.jobId);
                        await this.updateProjectStats(job.projectId);
                        return; // Exit after handling batch error
                    }
                    logger.info(`[GenNormal] 📦 Batch API returned ${batchResults.length} results for ${batchJobs.length} jobs`, {
                        returnedSeeds: batchResults.map(r => r.seed),
                        expectedSeeds: Array.from(seedToJobMap.keys())
                    });
                    // Process results by matching SEED (not index) for accurate job mapping
                    let matchedCount = 0;
                    let unmatchedCount = 0;
                    for (const result of batchResults) {
                        // Find job by seed
                        const matchedJob = seedToJobMap.get(result.seed);
                        if (!matchedJob || !matchedJob.job) {
                            logger.warn(`[GenNormal] ⚠️ Batch result with seed ${result.seed} not matched to any job`);
                            unmatchedCount++;
                            continue;
                        }
                        const { queuedJob: batchQueuedJob, job: batchJobDetail } = matchedJob;
                        const queue = this.profileQueues.get(batchQueuedJob.profileId);
                        const imageUrl = sanitizeResultUrl(result.fifeUrl || result.encodedImage || '', batchJobDetail.id);
                        const mediaId = result.name || result.mediaGenerationId || 'N/A';
                        // 🚫 Race-guard: project bị cancel khi batch image API in-flight → skip write COMPLETED
                        if (this.isProjectCancelled(batchJobDetail.projectId)) {
                            logger.warn(`[GenNormal] 🚫 Batch image job #${batchJobDetail.jobIndex} CANCELLED giữa lúc API in-flight — skip COMPLETED`, { jobId: batchJobDetail.id, mediaId });
                            continue;
                        }
                        await prisma.genNormalJob.update({
                            where: { id: batchJobDetail.id },
                            data: {
                                status: 'COMPLETED',
                                resultUrl: imageUrl,
                                progress: 100,
                                completedAt: new Date(),
                                providerJobId: mediaId,
                                veo3ProjectId: veo3ProjectId
                            }
                        });
                        logger.info(`[GenNormal] ✅ Batch image (seed=${result.seed}) → job #${batchJobDetail.jobIndex} completed`, {
                            jobId: batchJobDetail.id,
                            seed: result.seed,
                            imageUrl: imageUrl.substring(0, 80) + '...',
                            mediaId: mediaId.substring(0, 30) + '...'
                        });
                        // Emit job:completed for PipelineOrchestrator (lazy import to avoid circular dependency)
                        try {
                            const { genNormalStatusPoller } = await import('../../core/queue/GenNormalStatusPoller.js');
                            genNormalStatusPoller.emit('job:completed', batchJobDetail.id, {
                                resultUrl: imageUrl,
                                mediaId,
                                seed: result.seed,
                            });
                        }
                        catch (emitErr) {
                            logger.warn(`[GenNormal] ⚠️ Failed to emit job:completed for pipeline`, emitErr.message);
                        }
                        // Auto-upscale image if enabled (centralized via StatusPoller, fire-and-forget)
                        import('../../core/queue/GenNormalStatusPoller.js')
                            .then(({ triggerAutoUpscaleIfEnabled }) => {
                            triggerAutoUpscaleIfEnabled(batchJobDetail.id, batchJobDetail.projectId, batchJobDetail.mode || 'IMAGE_GENERATION').catch(() => { });
                        }).catch(() => { });
                        matchedCount++;
                        // Remove from running jobs
                        if (queue) {
                            queue.runningJobs.delete(batchQueuedJob.jobId);
                        }
                        // Remove from seedToJobMap to track unmatched
                        seedToJobMap.delete(result.seed);
                    }
                    // Mark unmatched jobs as failed
                    for (const [seed, { queuedJob: batchQueuedJob, job: batchJobDetail }] of seedToJobMap.entries()) {
                        if (!batchJobDetail)
                            continue;
                        const queue = this.profileQueues.get(batchQueuedJob.profileId);
                        await prisma.genNormalJob.update({
                            where: { id: batchJobDetail.id },
                            data: {
                                status: 'FAILED',
                                error: `No result returned from batch API (seed=${seed})`
                            }
                        });
                        logger.error(`[GenNormal] ❌ Batch image (seed=${seed}) → job #${batchJobDetail.jobIndex} - no result`);
                        // Emit job:failed for PipelineOrchestrator (lazy import to avoid circular dependency)
                        try {
                            const { genNormalStatusPoller } = await import('../../core/queue/GenNormalStatusPoller.js');
                            genNormalStatusPoller.emit('job:failed', batchJobDetail.id, new Error(`No result returned from batch API (seed=${seed})`));
                        }
                        catch (emitErr) {
                            logger.warn(`[GenNormal] ⚠️ Failed to emit job:failed for pipeline`, emitErr.message);
                        }
                        // Remove from running jobs
                        if (queue) {
                            queue.runningJobs.delete(batchQueuedJob.jobId);
                        }
                    }
                    logger.info(`[GenNormal] 📦 Batch processing summary: ${matchedCount} matched, ${unmatchedCount} unmatched results, ${seedToJobMap.size} failed jobs`);
                    // Keep submit cooldown anchored to the actual submit time.
                    // Resetting `lastSubmitTime` on success makes the queue wait a full
                    // extra `delaySeconds` after the API response, which slows throughput.
                    // 🔥 OPTIMIZATION: Trigger background warm for NEXT batch
                    // This runs human simulation in background while current batch is processing
                    // Update project stats
                    await this.updateProjectStats(job.projectId);
                    logger.info(`[GenNormal] ✅ BATCH of ${batchJobs.length} images completed in single API call`, {
                        profileId: job.profileId,
                        successCount: matchedCount,
                        failedCount: seedToJobMap.size,
                        jobIds: batchJobs.map(j => j.jobId)
                    });
                    // 🔴 Clear batch tracking after successful completion
                    this.currentBatchJobs.delete(queuedJob.jobId);
                    // ✅ Reset 403 failure count on success - profile is working again
                    this.reset403FailureCount(queuedJob.profileId);
                    // ✅ Notify captcha manager that this mint+submit cycle succeeded —
                    // clears global `consecutiveFailures` so the next failure starts at
                    // 1 instead of compounding into a soft/hard reset escalation.
                    captchaManager.notifySuccess();
                    return; // Batch processing complete
                }
                // SINGLE JOB MODE: Original logic for single image generation
                // Get reference image media IDs
                let refImageMediaIds = [];
                try {
                    if (job.referenceImageMediaIds) {
                        refImageMediaIds = typeof job.referenceImageMediaIds === 'string'
                            ? JSON.parse(job.referenceImageMediaIds)
                            : job.referenceImageMediaIds;
                        if (runtimeVerboseLogsEnabled()) {
                            logger.info(`[GenNormal] Parsed referenceImageMediaIds for job ${job.id}:`, {
                                count: refImageMediaIds.length,
                                mediaIds: refImageMediaIds.map((id) => id.substring(0, 50) + '...')
                            });
                        }
                    }
                }
                catch (e) {
                    const rawValueStr = typeof job.referenceImageMediaIds === 'string'
                        ? job.referenceImageMediaIds.substring(0, 200)
                        : JSON.stringify(job.referenceImageMediaIds).substring(0, 200);
                    logger.error(`[GenNormal] Failed to parse referenceImageMediaIds for job ${job.id}:`, {
                        error: e.message,
                        rawValue: rawValueStr
                    });
                }
                if (runtimeVerboseLogsEnabled()) {
                    logger.info(`[GenNormal] Generating single image for job ${job.id}`, {
                        prompt: job.prompt.substring(0, 100),
                        aspectRatio: imageAspectRatio,
                        referenceImageCount: refImageMediaIds.length,
                        imageModelName
                    });
                }
                // Deduplicate refImageMediaIds (avoid duplicate inputs)
                const uniqueRefImageMediaIds = [...new Set(refImageMediaIds)];
                if (uniqueRefImageMediaIds.length !== refImageMediaIds.length) {
                    logger.warn(`[GenNormal] Deduplicated IMAGE_GENERATION reference images: ${refImageMediaIds.length} → ${uniqueRefImageMediaIds.length}`, {
                        jobId: job.id
                    });
                }
                // Check if this is an edit job (has referenceImageMediaIds and there's a completed job with same jobIndex)
                let isEditJob = false;
                if (refImageMediaIds.length > 0) {
                    const existingCompletedJob = await prisma.genNormalJob.findFirst({
                        where: {
                            projectId: job.projectId,
                            jobIndex: job.jobIndex,
                            status: 'COMPLETED',
                            mode: 'IMAGE_GENERATION',
                            id: { not: job.id } // Exclude current job
                        }
                    });
                    isEditJob = !!existingCompletedJob;
                }
                // Use BASE_IMAGE input type for edit jobs, REFERENCE when refs present, NONE otherwise
                const imageInputType = isEditJob
                    ? 'IMAGE_INPUT_TYPE_BASE_IMAGE'
                    : (uniqueRefImageMediaIds.length > 0 ? 'IMAGE_INPUT_TYPE_REFERENCE' : 'NONE');
                if (runtimeVerboseLogsEnabled()) {
                    logger.info(`[GenNormal] Image generation type: ${isEditJob ? 'EDIT' : (uniqueRefImageMediaIds.length > 0 ? 'NEW_WITH_REF' : 'NEW_TEXT_ONLY')}`, {
                        jobId: job.id,
                        isEditJob,
                        imageInputType,
                        referenceImageCount: uniqueRefImageMediaIds.length,
                        baseImageMediaId: isEditJob ? refImageMediaIds[0]?.substring(0, 50) + '...' : 'N/A'
                    });
                }
                // 🟢 IMAGE_GENERATION STEP 1: Mark job as PROCESSING 5% (starting reCAPTCHA)
                if (runtimeVerboseLogsEnabled()) {
                    logger.info(`[GenNormal] 🖼️ IMAGE_GENERATION: Marking job ${job.id} as PROCESSING 5% (starting reCAPTCHA)`);
                }
                await prisma.genNormalJob.update({
                    where: { id: job.id },
                    data: {
                        status: 'PROCESSING',
                        progress: 5,
                        error: null
                    }
                });
                await this.updateProjectStats(job.projectId);
                // Generate single image using batch API (with 1 prompt)
                const imageResults = await veo3Service.generateBatchImages({
                    projectId: veo3ProjectId,
                    imageModelName,
                    imageAspectRatio: imageAspectRatio,
                    prompts: [{
                            prompt: job.prompt,
                            referenceImageMediaIds: uniqueRefImageMediaIds.length > 0 ? uniqueRefImageMediaIds : undefined,
                            imageInputType: uniqueRefImageMediaIds.length > 0 ? imageInputType : undefined
                        }],
                    // 🟢 IMAGE_GENERATION STEP 2: Mark job as PROCESSING 25% after reCAPTCHA success
                    onRecaptchaComplete: async () => {
                        await prisma.genNormalJob.update({
                            where: { id: job.id },
                            data: {
                                progress: 25
                            }
                        });
                    },
                    // 🔓 Start the inter-submit cooldown only after captcha -> submit -> clr
                    // has actually happened in the browser context.
                    onSubmitFired: () => {
                        this.handleSubmitFired(queuedJob);
                    }
                });
                if (imageResults.length === 0) {
                    throw new Error('No images generated');
                }
                const imageResult = imageResults[0];
                const imageUrl = sanitizeResultUrl(imageResult.fifeUrl || imageResult.encodedImage || '', job.id);
                // Update job with result
                const mediaId = imageResult.name || imageResult.mediaGenerationId || 'N/A';
                // 🚫 Race-guard: nếu project bị cancel trong lúc image gen API in-flight,
                // KHÔNG ghi đè status CANCELLED → COMPLETED.
                if (this.isProjectCancelled(job.projectId)) {
                    logger.warn(`[GenNormal] 🚫 Image job #${job.jobIndex} đã CANCELLED giữa lúc API in-flight — bỏ qua write COMPLETED`, { jobId: job.id, mediaId });
                }
                else {
                    await prisma.genNormalJob.update({
                        where: { id: job.id },
                        data: {
                            status: 'COMPLETED',
                            resultUrl: imageUrl,
                            progress: 100,
                            completedAt: new Date(),
                            providerJobId: mediaId,
                            veo3ProjectId: veo3ProjectId
                        }
                    });
                }
                // Update project stats
                await this.updateProjectStats(job.projectId);
                logger.info(`[GenNormal] ✅ image done ${job.id.slice(0, 12)} url=${imageUrl.substring(0, 80)}`);
                // Auto-upscale image if enabled (centralized via StatusPoller, fire-and-forget)
                import('../../core/queue/GenNormalStatusPoller.js')
                    .then(({ triggerAutoUpscaleIfEnabled }) => {
                    triggerAutoUpscaleIfEnabled(job.id, job.projectId, job.mode || 'IMAGE_GENERATION').catch(() => { });
                }).catch(() => { });
                // Remove from running jobs. Keep delay timer anchored to submit time.
                const queue = this.profileQueues.get(queuedJob.profileId);
                if (queue) {
                    queue.runningJobs.delete(queuedJob.jobId);
                    const delaySeconds = this.projectDelaySeconds.get(job.projectId) || this.getRandomDelay();
                    logger.info(`[GenNormal] ✅ Image job #${job.jobIndex} removed from running queue (${queue.runningJobs.size} remaining, delay=${delaySeconds}s)`);
                }
                // ✅ Reset 403 failure count on success
                this.reset403FailureCount(queuedJob.profileId);
                captchaManager.notifySuccess();
                return; // Image generation is synchronous, no polling needed
            }
            // ✅ BATCH VIDEO: For ALL video modes, try to batch up to 4 jobs of same mode
            // Each mode uses different API endpoint but all support batch of same mode
            const videoBatchModes = ['TEXT_TO_VIDEO', 'REFERENCE_TO_VIDEO', 'REFERENCE_TO_VIDEO_AUDIO', 'IMAGE_TO_VIDEO', 'FRAME_TO_FRAME'];
            if (videoBatchModes.includes(jobMode)) {
                // 🔥 OPTIMIZATION: Removed artificial blocking check.
                // Previously waited for all processing jobs to finish, now relies on global concurrency limits.
                // This allows true pipelined submission for video batches.
                // Check 30s delay between batch submissions for this profile
                const lastBatchTime = this.lastBatchTimePerProfile.get(queuedJob.profileId) || 0;
                const timeSinceLastBatch = Date.now() - lastBatchTime;
                if (timeSinceLastBatch < this.BATCH_INTERVAL_MS) {
                    const waitTime = this.BATCH_INTERVAL_MS - timeSinceLastBatch;
                    logger.info(`[GenNormal] ⏳ Waiting ${Math.ceil(waitTime / 1000)}s before next batch for profile ${queuedJob.profileId.substring(0, 8)}...`, {
                        profileId: queuedJob.profileId,
                        timeSinceLastBatchMs: timeSinceLastBatch,
                        waitTimeMs: waitTime
                    });
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                }
                // Try to collect more TEXT_TO_VIDEO jobs from same profile for batch processing
                const batchJobs = await this.collectVideoBatchJobs(queuedJob.profileId, queuedJob.jobId, jobMode);
                const isBatchMode = batchJobs.length > 1;
                logger.info(`[GenNormal] 🎬 Processing VIDEO ${isBatchMode ? `BATCH of ${batchJobs.length} jobs` : `single job ${job.id}`} (idx=${job.jobIndex}, profile=${job.profile.name})`);
                const veo3Service = provider;
                // Load all job details for batch (DO NOT mark PROCESSING yet - wait for API success)
                const batchJobDetails = await Promise.all(batchJobs.map(async (qj) => {
                    const jobDetail = await prisma.genNormalJob.findUnique({
                        where: { id: qj.jobId },
                        include: {
                            profile: true,
                            project: true
                        }
                    });
                    return { queuedJob: qj, job: jobDetail };
                }));
                // Build batch request with sceneId for tracking each job
                // Request structure depends on mode:
                // - TEXT_TO_VIDEO: textInput only
                // - REFERENCE_TO_VIDEO: textInput + referenceImages
                // - IMAGE_TO_VIDEO: textInput + startImage
                // - FRAME_TO_FRAME: textInput + startImage + endImage
                const sceneIdToJobMap = new Map();
                // Tier phải lấy từ TÀI KHOẢN chạy job, không phải từ dự án: một dự án có
                // thể trộn Pro và Ultra, mà khoá model Ultra bị Google từ chối trên tài
                // khoản Pro (403 PUBLIC_ERROR_MODEL_ACCESS_DENIED). Batch luôn đồng nhất
                // một profile (gom theo profileId) nên một tier cho cả batch là đủ.
                const batchProfileTier = await this.resolveProfileTier(batchJobDetails[0]?.job, queuedJob.profileId);
                const requests = await Promise.all(batchJobDetails.map(async ({ job: jobDetail, queuedJob: qj }) => {
                    if (!jobDetail)
                        return null;
                    // Generate unique sceneId for tracking this job
                    const sceneId = jobDetail.sceneId || this.generateUUID();
                    sceneIdToJobMap.set(sceneId, { job: jobDetail, queuedJob: qj });
                    // Convert aspect ratio format: "16:9" -> "VIDEO_ASPECT_RATIO_LANDSCAPE", "9:16" -> "VIDEO_ASPECT_RATIO_PORTRAIT"
                    const projectAspectRatio = jobDetail.project.aspectRatio || '16:9';
                    let batchAspectRatio;
                    if (projectAspectRatio.startsWith('VIDEO_ASPECT_RATIO_')) {
                        batchAspectRatio = projectAspectRatio;
                    }
                    else if (projectAspectRatio === '9:16') {
                        batchAspectRatio = 'VIDEO_ASPECT_RATIO_PORTRAIT';
                    }
                    else {
                        batchAspectRatio = 'VIDEO_ASPECT_RATIO_LANDSCAPE';
                    }
                    // Sanitize prompt: remove control characters and limit length
                    let sanitizedPrompt = jobDetail.prompt
                        .replace(/\0/g, '') // Remove null bytes
                        .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
                        .trim();
                    // Limit length (Veo3 API accepts up to ~2000 chars for video prompts)
                    const MAX_PROMPT_LENGTH = 2000;
                    if (sanitizedPrompt.length > MAX_PROMPT_LENGTH) {
                        logger.warn(`[GenNormal] Prompt truncated from ${sanitizedPrompt.length} to ${MAX_PROMPT_LENGTH} chars`, {
                            jobId: jobDetail.id
                        });
                        sanitizedPrompt = sanitizedPrompt.substring(0, MAX_PROMPT_LENGTH).trim();
                    }
                    const isProTier = batchProfileTier === 'PAYGATE_TIER_ONE';
                    // Pro accounts can't use Ultra-only keys (incl. F2F `_ultra_fl`).
                    // toProModelKey maps via an explicit dict; tier-invariant keys
                    // (lite/quality/omni) pass through unchanged.
                    let actualVideoModelKey = isProTier ? toProModelKey(videoModelKey) : videoModelKey;
                    // Named COMPONENTS refs: bind each @handle to its image at the exact
                    // position it was written, so Flow expands it to `<image id="image_N" />`
                    // inline instead of leaving the model to guess which name is which face.
                    // Opt-in until the wire shape is confirmed against a real submit body —
                    // without the flag this whole path is inert and the two branches below
                    // behave exactly as they always have.
                    let namedRefParts = null;
                    let namedRefImages = null;
                    if (process.env.VEO3_R2V_STRUCTURED_HANDLES === '1' &&
                        (jobMode === 'REFERENCE_TO_VIDEO' || jobMode === 'REFERENCE_TO_VIDEO_AUDIO') &&
                        jobDetail.referenceImageHandles) {
                        try {
                            const stored = typeof jobDetail.referenceImageHandles === 'string'
                                ? JSON.parse(jobDetail.referenceImageHandles)
                                : jobDetail.referenceImageHandles;
                            const handleMap = buildHandleMap(stored ?? []);
                            if (handleMap.size > 0) {
                                // Last line of defence before the wire; the renderer and repository
                                // both cap below this. Omni Flash takes 7 references, Veo 3.1 only 3
                                // — sending more comes back 500 INTERNAL.
                                const wireCap = isOmniFlashKey(actualVideoModelKey) ? 7 : 3;
                                // Tokenize the untruncated prompt: slicing at 2000 chars first can
                                // cut through an @handle and silently drop that image binding.
                                const rawPrompt = jobDetail.prompt
                                    .replace(/\0/g, '')
                                    .replace(/[\x00-\x1F\x7F]/g, '')
                                    .trim();
                                const { parts, bound, unknown } = tokenizePrompt(rawPrompt, handleMap, wireCap);
                                if (unknown.length > 0) {
                                    logger.warn(`[GenNormal] structured-handle job ${jobDetail.id} mentions unknown handle(s) [${unknown.join(', ')}] — left as literal text`);
                                }
                                if (bound.length > 0) {
                                    const kept = bound.slice(0, wireCap);
                                    if (kept.length < bound.length) {
                                        logger.warn(`[GenNormal] structured-handle job ${jobDetail.id} binds ${bound.length} images but ${actualVideoModelKey} accepts ${wireCap} — dropping [${bound.slice(wireCap).join(', ')}]`);
                                    }
                                    // Drop the reference parts for handles the cap excluded: a part
                                    // pointing at a mediaId that is not in referenceImages[] desyncs
                                    // the `<image id="image_N" />` indices Flow derives from it.
                                    const keptKeys = new Set(kept.map((handle) => handle.toLowerCase()));
                                    const keptParts = parts.filter((part) => !('reference' in part) ||
                                        keptKeys.has(part.reference.media.handle.toLowerCase()));
                                    namedRefParts = clampTextParts(keptParts, MAX_PROMPT_LENGTH);
                                    namedRefImages = kept.map((handle) => ({
                                        mediaId: handleMap.get(handle.toLowerCase()).mediaId,
                                        imageUsageType: 'IMAGE_USAGE_TYPE_ASSET',
                                    }));
                                }
                            }
                        }
                        catch (error) {
                            logger.warn(`[GenNormal] structured-handle build failed for job ${jobDetail.id}: ${error} — falling back to flat prompt`);
                            namedRefParts = null;
                            namedRefImages = null;
                        }
                    }
                    let textInput;
                    if (namedRefParts) {
                        textInput = { structuredPrompt: { parts: namedRefParts } };
                    }
                    else if (isProTier) {
                        textInput = {
                            structuredPrompt: {
                                parts: [
                                    { text: sanitizedPrompt }
                                ]
                            }
                        };
                    }
                    else {
                        textInput = {
                            prompt: sanitizedPrompt
                        };
                    }
                    // Base request structure (common for all modes)
                    const baseRequest = {
                        aspectRatio: batchAspectRatio,
                        seed: Math.floor(Math.random() * 100000),
                        textInput,
                        videoModelKey: actualVideoModelKey,
                        metadata: {
                            sceneId: sceneId
                        }
                    };
                    // Set before the mode-specific block so its `!baseRequest.referenceImages`
                    // guard sees them and leaves the per-position binding intact.
                    if (namedRefImages) {
                        baseRequest.referenceImages = namedRefImages;
                        if (namedRefImages.length > 1) {
                            baseRequest.videoModelCapabilities = ['VIDEO_MODEL_CAPABILITY_MULTI_REFERENCE'];
                        }
                    }
                    // DEBUG: Log full prompt for first job in batch
                    if (sceneIdToJobMap.size === 1 && process.env.GEN_NORMAL_VERBOSE === '1') {
                        // First-job DEBUG block gated behind GEN_NORMAL_VERBOSE — full
                        // prompt + sceneId only useful when reproducing a specific failure.
                        logger.info(`[GenNormal] 🔍 DEBUG - First job request details:`, {
                            jobId: jobDetail.id,
                            aspectRatio: batchAspectRatio,
                            videoModelKey: videoModelKey,
                            promptLength: sanitizedPrompt.length,
                            promptPreview: sanitizedPrompt.substring(0, 100),
                            promptFull: sanitizedPrompt.length <= 600 ? sanitizedPrompt : undefined,
                            sceneId: sceneId
                        });
                    }
                    // Add mode-specific fields
                    if (jobMode === 'REFERENCE_TO_VIDEO' || jobMode === 'REFERENCE_TO_VIDEO_AUDIO') {
                        // Parse reference images
                        let refImages = [];
                        try {
                            if (jobDetail.referenceImageMediaIds) {
                                refImages = typeof jobDetail.referenceImageMediaIds === 'string'
                                    ? JSON.parse(jobDetail.referenceImageMediaIds)
                                    : jobDetail.referenceImageMediaIds;
                            }
                        }
                        catch (e) {
                            logger.warn(`[GenNormal] Failed to parse referenceImageMediaIds for batch job ${jobDetail.id}`);
                        }
                        // Deduplicate and format reference images. Skipped when the named-ref
                        // path already bound them in mention order — re-deriving from the flat
                        // mediaId list would reorder them and desync the `<image id="image_N" />`
                        // indices from the structured prompt. The audio attachment below still
                        // runs either way.
                        const uniqueRefImages = [...new Set(refImages)];
                        if (!baseRequest.referenceImages && uniqueRefImages.length > 0) {
                            baseRequest.referenceImages = uniqueRefImages.map(mediaId => ({
                                imageUsageType: 'IMAGE_USAGE_TYPE_ASSET',
                                mediaId
                            }));
                        }
                        // Audio mode: attach the voice preset id (e.g. "achernar"). Field shape
                        // verified against real Flow request: `referenceAudio: [{ mediaId }]`.
                        // The shared `audioFailurePreference: 'BLOCK_SILENCED_VIDEOS'` is set at
                        // the batch level below (see mediaGenerationContext) — no extra work here.
                        if (jobMode === 'REFERENCE_TO_VIDEO_AUDIO' && jobDetail.audioMediaId) {
                            baseRequest.referenceAudio = [{ mediaId: jobDetail.audioMediaId }];
                        }
                    }
                    else if (jobMode === 'IMAGE_TO_VIDEO') {
                        // Add start image
                        if (jobDetail.startImageMediaId) {
                            baseRequest.startImage = {
                                mediaId: jobDetail.startImageMediaId
                            };
                        }
                    }
                    else if (jobMode === 'FRAME_TO_FRAME') {
                        // Add start and end images
                        if (jobDetail.startImageMediaId) {
                            baseRequest.startImage = {
                                mediaId: jobDetail.startImageMediaId
                            };
                        }
                        if (jobDetail.endImageMediaId) {
                            baseRequest.endImage = {
                                mediaId: jobDetail.endImageMediaId
                            };
                        }
                    }
                    // TEXT_TO_VIDEO: no additional fields needed
                    return baseRequest;
                }));
                // Filter out null requests
                const validRequests = requests.filter(r => r !== null);
                // Batch sceneIds mapping log dropped — sceneId echoed in
                // "Batch API returned" + per-job "submitted successfully" lines.
                // Tier của tài khoản chạy batch — cũng là giá trị gửi lên Google trong
                // clientContext.userPaygateTier bên dưới, nên sai ở đây là khai sai tier.
                const isUltraUser = batchProfileTier === 'PAYGATE_TIER_TWO';
                const userPaygateTier = isUltraUser ? 'PAYGATE_TIER_TWO' : 'PAYGATE_TIER_ONE';
                // Build batch request with correct API format
                // tool: PINHOLE
                // \ud83d\udd10 sessionId gi\u1eef c\u1ed1 \u0111\u1ecbnh per (profile, veo3Project) \u2014 m\u1ed7i project
                // l\u00e0 1 tab ri\u00eang tr\u00ean labs.google. Cross-check user curl:
                // `sessionId: ;1776698893354` tr\u00f9ng qua 3 requests video c\u00f9ng project.
                const { sessionIdManager } = await import('../../lib/sessionIdManager.js');
                const videoSessionId = sessionIdManager.get(queuedJob.profileId, veo3ProjectId);
                const batchRequest = {
                    clientContext: {
                        sessionId: videoSessionId,
                        projectId: veo3ProjectId,
                        tool: 'PINHOLE',
                        userPaygateTier: userPaygateTier
                    },
                    requests: validRequests
                };
                // Real browser sends `useV2ModelConfig: true` on EVERY video request,
                // including PAYGATE_TIER_TWO (Ultra). Verified in user-captured curl
                // for both r2v and r2v_audio. Missing this on Ultra reportedly causes
                // intermittent `PUBLIC_ERROR_VIDEO_GENERATION_TIMED_OUT` failures on
                // the audio model family — keep parity with the browser payload.
                batchRequest.useV2ModelConfig = true;
                if (userPaygateTier === 'PAYGATE_TIER_ONE') {
                    // PRO downgrade (defense-in-depth): map any Ultra-only key to its Pro
                    // equivalent. Redundant with the per-job map above but cheap; both
                    // now share toProModelKey so they cannot diverge.
                    batchRequest.requests.forEach((r) => {
                        if (r.videoModelKey) {
                            r.videoModelKey = toProModelKey(r.videoModelKey);
                        }
                    });
                }
                // Assign a common batchId to all requests in this batch submission
                const { randomUUID } = await import('crypto');
                const generatedBatchId = randomUUID();
                // \ud83c\udfa7 audioFailurePreference: m\u1eb7c \u0111\u1ecbnh real browser d\u00f9ng BLOCK_SILENCED_VIDEOS
                // \u2192 kh\u1edbp payload xu\u1ea5t hi\u1ec7n trong user curl traces.
                // 🎧 Công tắc audio của project (khớp Flow web). BẬT (mặc định) → BLOCK_SILENCED_VIDEOS:
                // audio bị content-filter thì Google huỷ luôn video (PUBLIC_ERROR_AUDIO_FILTERED).
                // TẮT → RETURN_SILENCED_VIDEOS: trả video câm, job vẫn thành công thay vì mất trắng.
                batchRequest.mediaGenerationContext = {
                    batchId: generatedBatchId,
                    audioFailurePreference: (job.project?.audioEnabled ?? true)
                        ? 'BLOCK_SILENCED_VIDEOS'
                        : 'RETURN_SILENCED_VIDEOS',
                };
                // 🚫 Check cancellation before starting reCAPTCHA
                if (this.isProjectCancelled(job.projectId)) {
                    logger.info(`[GenNormal] 🚫 Video batch aborted - project cancelled before reCAPTCHA`, {
                        projectId: job.projectId,
                        batchSize: batchJobs.length
                    });
                    return;
                }
                // 🟢 VIDEO_GENERATION STEP 1: Mark all batch jobs as PROCESSING 5% (starting reCAPTCHA)
                // "Marking … PROCESSING 5%" log dropped — DB progress update is silent;
                // the upstream "Processing VIDEO" line already announces the batch.
                await Promise.all(batchJobDetails.map(async ({ job: jobDetail }) => {
                    if (jobDetail) {
                        await prisma.genNormalJob.update({
                            where: { id: jobDetail.id },
                            data: {
                                status: 'PROCESSING',
                                progress: 5,
                                error: null
                            }
                        });
                    }
                }));
                // Call appropriate batch API based on mode (single reCAPTCHA for all jobs)
                // - TEXT_TO_VIDEO: batchAsyncGenerateVideoText
                // - REFERENCE_TO_VIDEO: batchAsyncGenerateVideoReferenceImages
                // - IMAGE_TO_VIDEO: batchAsyncGenerateVideoStartImage (only start image)
                // - FRAME_TO_FRAME: batchAsyncGenerateVideoStartAndEndImage (start + end images)
                let batchResponse;
                const onRecaptchaComplete = async () => {
                    await Promise.all(batchJobDetails.map(async ({ job: jobDetail }) => {
                        if (jobDetail) {
                            await prisma.genNormalJob.update({
                                where: { id: jobDetail.id },
                                data: {
                                    progress: 25
                                }
                            });
                        }
                    }));
                };
                const onSubmitFired = () => {
                    this.handleSubmitFired(queuedJob);
                };
                // 🚫 Check cancellation before expensive batch API call
                if (this.isProjectCancelled(job.projectId)) {
                    logger.info(`[GenNormal] 🚫 Batch aborted - project cancelled before API call`, {
                        projectId: job.projectId,
                        batchSize: batchJobs.length,
                        jobIds: batchJobs.map(j => j.jobId)
                    });
                    return;
                }
                try {
                    if (jobMode === 'TEXT_TO_VIDEO') {
                        // "Calling batchAsyncGenerateVideo…" lines dropped — upstream
                        // "Processing VIDEO" + downstream "[API Monitor] Submit video"
                        // already mark this dispatch with mode + count.
                        batchResponse = await veo3Service.batchAsyncGenerateVideoText(batchRequest, onRecaptchaComplete, onSubmitFired);
                    }
                    else if (jobMode === 'REFERENCE_TO_VIDEO' || jobMode === 'REFERENCE_TO_VIDEO_AUDIO') {
                        batchResponse = await veo3Service.batchAsyncGenerateVideoReferenceImages(batchRequest, onRecaptchaComplete, onSubmitFired);
                    }
                    else if (jobMode === 'FRAME_TO_FRAME') {
                        batchResponse = await veo3Service.batchAsyncGenerateVideoStartAndEndImage(batchRequest, onRecaptchaComplete, onSubmitFired);
                    }
                    else if (jobMode === 'IMAGE_TO_VIDEO') {
                        batchResponse = await veo3Service.batchAsyncGenerateVideoStartImage(batchRequest, onRecaptchaComplete, onSubmitFired);
                    }
                    else {
                        throw new Error(`Unknown video mode: ${jobMode}`);
                    }
                }
                catch (batchError) {
                    if (isVerificationRejected(batchError)) {
                        await this.failJobsForVerification(queuedJob, batchJobs);
                        return;
                    }
                    // Handle batch API error - decide FAILED or RETRY for all jobs in batch
                    const errorMessage = batchError.message || 'Unknown batch error';
                    const isUpgradeable = errorMessage.includes('PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED_UPGRADEABLE');
                    const isDailyQuotaExhausted = isUpgradeable || isHardQuotaExhausted(errorMessage, batchError);
                    if (isDailyQuotaExhausted) {
                        const errorMsg = isUpgradeable ? ERR_QUOTA_UPGRADEABLE : ERR_DAILY_QUOTA_REACHED;
                        logger.error(`[GenNormal] 🚫 Batch daily quota — failing this batch only (${batchJobs.length} jobs).`, {
                            jobIds: batchJobs.map(j => j.jobId),
                            profileId: queuedJob.profileId,
                            isUpgradeable,
                        });
                        this.currentBatchJobs.delete(queuedJob.jobId);
                        await this.failJobsOnHardQuota(queuedJob.profileId, queuedJob.projectId, batchJobs.map(j => ({ jobId: j.jobId })), errorMsg);
                        return;
                    }
                    // Theo đúng image-batch (dòng ~3000): `errorText` giữ nguyên body gốc của
                    // Google nên vẫn chứa mã PUBLIC_ERROR_* kể cả khi .message đã bị thay
                    // bằng sentinel; cờ isNonRetryable là chốt chặn cuối.
                    const isNonRetryable = isNonRetryableError(errorMessage) ||
                        isNonRetryableError(batchError?.errorText ?? '') ||
                        batchError?.isNonRetryable === true;
                    // Browser race condition errors: browser destroyed while another job was using it.
                    // NOT a real 403 — just retry quickly without rotation.
                    const isBrowserRaceError = errorMessage.includes('Object has been destroyed') ||
                        errorMessage.includes('Browser was destroyed') ||
                        errorMessage.includes('Browser destroyed before') ||
                        errorMessage.includes('ERR_FAILED (-2)');
                    const isRecaptchaFailure = !isBrowserRaceError && (batchError?.isRecaptchaFailure ||
                        errorMessage.includes('reCAPTCHA evaluation failed') ||
                        errorMessage.includes('Xác thực reCAPTCHA thất bại') ||
                        errorMessage.includes('Failed to obtain reCAPTCHA') ||
                        errorMessage.includes('grecaptcha not available') ||
                        errorMessage.includes('reCAPTCHA token request timeout') ||
                        errorMessage.includes('reCAPTCHA token timeout'));
                    const isRateLimit = errorMessage.includes('429') ||
                        errorMessage.includes('rate limit') ||
                        errorMessage.includes('RESOURCE_EXHAUSTED') ||
                        errorMessage.includes('Quota Exceeded') ||
                        errorMessage.includes('PUBLIC_ERROR_USER_REQUESTS_THROTTLED') ||
                        errorMessage.includes('PUBLIC_ERROR_HIGH_TRAFFIC') ||
                        batchError?.status === 429 ||
                        batchError?.errorText?.includes('PUBLIC_ERROR_USER_REQUESTS_THROTTLED') ||
                        // TOO_MUCH_TRAFFIC: trần tốc độ tạm thời — delay per-profile + retry (cap 3), KHÔNG dừng project.
                        isTransientTrafficLimit(errorMessage, batchError);
                    if (isRecaptchaFailure) {
                        logger.warn(`[GenNormal] ⚠️ Batch 403 reCAPTCHA (${batchJobs.length} jobs) — will retry`);
                    }
                    else if (isRateLimit) {
                        logger.warn(`[GenNormal] ⚠️ Batch 429 rate limit (${batchJobs.length} jobs) — will retry`);
                    }
                    else {
                        logger.error(`[GenNormal] ❌ Batch API failed (${batchJobs.length} jobs, status=${batchError?.status}): ${errorMessage.substring(0, 200)}`);
                    }
                    if (isNonRetryable) {
                        await this.invalidatePaygateTierIfModelAccessDenied(errorMessage, queuedJob.projectId);
                        // Mark ALL jobs in batch as FAILED
                        for (const bj of batchJobs) {
                            await prisma.genNormalJob.update({
                                where: { id: bj.jobId },
                                data: {
                                    status: 'FAILED',
                                    error: errorMessage,
                                    completedAt: new Date()
                                }
                            });
                            const queue = this.profileQueues.get(bj.profileId);
                            if (queue)
                                queue.runningJobs.delete(bj.jobId);
                        }
                        logger.error(`[GenNormal] ❌ Batch FAILED (non-retryable): ${batchJobs.length} jobs marked FAILED`, {
                            error: errorMessage.substring(0, 200)
                        });
                    }
                    else if (isBrowserRaceError) {
                        // Browser race condition — another job reset the browser while this one was waiting.
                        // Quick silent retry (3s), NO UA rotation, NO 403 counter increment.
                        const survivors = await this.enforceBatchRetryCeiling(batchJobs, errorMessage);
                        logger.warn(`[GenNormal] 🔄 Browser race condition — ${survivors.length}/${batchJobs.length} jobs back to queue (3s delay, no rotation)`, {
                            jobIds: survivors.map(j => j.jobId)
                        });
                        const queue = this.profileQueues.get(queuedJob.profileId);
                        for (const bj of survivors) {
                            const bjData = await prisma.genNormalJob.findUnique({
                                where: { id: bj.jobId },
                                select: { retryCount: true }
                            });
                            await prisma.genNormalJob.update({
                                where: { id: bj.jobId },
                                data: { status: 'QUEUED', error: null, progress: 0, retryCount: (bjData?.retryCount ?? 0) + 1 }
                            });
                            if (queue) {
                                queue.runningJobs.delete(bj.jobId);
                                queue.queuedJobs.push({ jobId: bj.jobId, profileId: bj.profileId, projectId: bj.projectId, veo3ProjectId: bj.veo3ProjectId, index: bj.index, mode: bj.mode, addedAt: Date.now() });
                            }
                        }
                        this.setProfileRateLimitDelay(queuedJob.profileId, 3, '403');
                        await this.updateProjectStats(queuedJob.projectId);
                    }
                    else {
                        // Retryable error - put jobs back to queue with proper status and delay
                        const queue = this.profileQueues.get(queuedJob.profileId);
                        if (isRateLimit || isRecaptchaFailure) {
                            const errorType = isRecaptchaFailure ? '403' : '429';
                            const RATE_LIMIT_MAX_RETRIES = 3;
                            let delaySeconds;
                            if (isRecaptchaFailure) {
                                const failureCount = this.increment403FailureCount(queuedJob.profileId);
                                const isSilentRetry = failureCount <= 3;
                                if (isSilentRetry) {
                                    delaySeconds = this.getRecaptchaSilentRetryDelaySec();
                                    logger.warn(`[GenNormal] 🔄 Silent reCAPTCHA retry #${failureCount}/3 (batch) for profile ${queuedJob.profileId.substring(0, 8)}... - retrying in ${delaySeconds}s without notifying user`);
                                }
                                else {
                                    delaySeconds = this.getEscalatingDelay(queuedJob.profileId);
                                    logger.warn(`[GenNormal] ⚠️ reCAPTCHA failed ${failureCount} times (batch), escalating delay to ${delaySeconds}s and notifying user`);
                                }
                                if (failureCount >= 3 && this.shouldRunRecovery(queuedJob.profileId, 'rotate-ua-batch')) {
                                    try {
                                        if (queue && (queue.isSubmitting || this.getOtherRunningJobs(queue, batchJobs.length) > 0)) {
                                            this.deferUaRotation(queuedJob.profileId, queue, failureCount, batchJobs.length, 'video-batch-403');
                                        }
                                        else {
                                            await this.rotateUaProfileNow(queuedJob.profileId, failureCount, 'video-batch');
                                        }
                                    }
                                    catch (rotateError) {
                                        logger.warn(`[GenNormal] ⚠️ UA rotation failed:`, rotateError.message);
                                    }
                                }
                            }
                            else {
                                delaySeconds = this.getRateLimitDelaySec(queuedJob.profileId, errorMessage, batchError);
                                logger.warn(`[GenNormal] ⏰ 429 rate limit (batch) for profile ${queuedJob.profileId.substring(0, 8)}... - pausing profile queue for ${delaySeconds}s`);
                            }
                            const delayRetryAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
                            const failureCount403 = this.profile403FailureCount.get(queuedJob.profileId) || 0;
                            const isSilentRetryBatch = isRecaptchaFailure && failureCount403 <= 3;
                            for (const bj of batchJobs) {
                                const bjData = await prisma.genNormalJob.findUnique({
                                    where: { id: bj.jobId },
                                    select: { retryCount: true }
                                });
                                const retryCount = (bjData?.retryCount || 0) + 1;
                                if (retryCount > RATE_LIMIT_MAX_RETRIES) {
                                    await prisma.genNormalJob.update({
                                        where: { id: bj.jobId },
                                        data: {
                                            status: 'FAILED',
                                            error: `Đã retry ${RATE_LIMIT_MAX_RETRIES} lần do ${errorType === '429' ? 'rate limit (429)' : 'reCAPTCHA (403)'}. ${errorMessage.substring(0, 150)}`,
                                            completedAt: new Date()
                                        }
                                    });
                                    if (queue)
                                        queue.runningJobs.delete(bj.jobId);
                                    logger.error(`[GenNormal] 🛑 Job ${bj.jobId} exceeded ${RATE_LIMIT_MAX_RETRIES} rate-limit retries — marking FAILED`);
                                    continue;
                                }
                                const errorMessage403 = isSilentRetryBatch
                                    ? null
                                    : `RATE_LIMIT_RETRY:${delayRetryAt}:${isRecaptchaFailure ? '403 - reCAPTCHA evaluation failed' : '429 - Rate limited'}`;
                                await prisma.genNormalJob.update({
                                    where: { id: bj.jobId },
                                    data: {
                                        status: 'QUEUED',
                                        error: errorMessage403,
                                        progress: 0,
                                        retryCount
                                    }
                                });
                                if (queue) {
                                    queue.runningJobs.delete(bj.jobId);
                                }
                            }
                            if (queue) {
                                for (const bj of batchJobs.slice().reverse()) {
                                    const jobDetail = await prisma.genNormalJob.findUnique({
                                        where: { id: bj.jobId },
                                        select: { mode: true, projectId: true, jobIndex: true, status: true }
                                    });
                                    if (jobDetail && jobDetail.status === 'QUEUED') {
                                        queue.queuedJobs.unshift({
                                            jobId: bj.jobId,
                                            profileId: bj.profileId,
                                            projectId: jobDetail.projectId,
                                            index: jobDetail.jobIndex,
                                            mode: jobDetail.mode || 'TEXT_TO_VIDEO',
                                            addedAt: Date.now()
                                        });
                                    }
                                }
                            }
                            this.setProfileRateLimitDelay(queuedJob.profileId, delaySeconds, errorType);
                            logger.warn(`[GenNormal] ⏰ Batch ${isRecaptchaFailure ? 'reCAPTCHA' : '429 rate limit'} retry scheduled with ${delaySeconds}s delay`, {
                                profileId: queuedJob.profileId,
                                failureCount: this.profile403FailureCount.get(queuedJob.profileId) || 0,
                                delaySeconds
                            });
                            if (isRecaptchaFailure && this.shouldRunRecovery(queuedJob.profileId, 'reset-prewarm-batch')) {
                                try {
                                    const { accountLocaleService } = await import('../../lib/accountLocaleService.js');
                                    const cachedLocale = accountLocaleService.getCachedLocale(queuedJob.profileId);
                                    if (queue) {
                                        this.scheduleBrowserRecovery(queuedJob.profileId, queue, {
                                            veo3ProjectId,
                                            locale: cachedLocale,
                                            context: 'reset-prewarm-batch',
                                            jobsBeingHandled: batchJobs.length,
                                        });
                                    }
                                }
                                catch (resetError) {
                                    logger.warn(`[GenNormal] ⚠️ Browser force reset failed:`, resetError.message);
                                }
                            }
                            logger.warn(`[GenNormal] 🔄 ${isRecaptchaFailure ? `403 reCAPTCHA${isSilentRetryBatch ? ' silent' : ''}` : '429 rate limit'} — ${batchJobs.length} jobs requeued (+${delaySeconds}s)`);
                        }
                        else {
                            // Other retryable error - enforce ceiling AND add minimum delay to prevent infinite loop
                            const survivors = await this.enforceBatchRetryCeiling(batchJobs, errorMessage);
                            const safetyDelaySeconds = 10;
                            if (queue) {
                                for (const bj of survivors.slice().reverse()) {
                                    const jobDetail = await prisma.genNormalJob.findUnique({
                                        where: { id: bj.jobId },
                                        select: { mode: true, projectId: true, jobIndex: true, retryCount: true }
                                    });
                                    if (jobDetail) {
                                        await prisma.genNormalJob.update({
                                            where: { id: bj.jobId },
                                            data: { retryCount: (jobDetail.retryCount ?? 0) + 1 }
                                        });
                                        queue.queuedJobs.unshift({
                                            jobId: bj.jobId,
                                            profileId: bj.profileId,
                                            projectId: jobDetail.projectId,
                                            index: jobDetail.jobIndex,
                                            mode: jobDetail.mode || 'TEXT_TO_VIDEO',
                                            addedAt: Date.now()
                                        });
                                    }
                                    queue.runningJobs.delete(bj.jobId);
                                }
                            }
                            this.setProfileRateLimitDelay(queuedJob.profileId, safetyDelaySeconds, '500');
                            logger.warn(`[GenNormal] 🔄 Batch failed (retryable) - ${survivors.length}/${batchJobs.length} jobs back to queue (${safetyDelaySeconds}s delay)`);
                        }
                    }
                    await this.updateProjectStats(job.projectId);
                    return; // Exit batch processing
                }
                // Update lastBatchTime for this profile
                this.lastBatchTimePerProfile.set(queuedJob.profileId, Date.now());
                logger.info(`[GenNormal] 🎬 Batch API returned ${batchResponse.operations?.length || 0}/${batchJobs.length} results`);
                // Process results by matching sceneId for accurate job mapping
                let matchedCount = 0;
                let unmatchedCount = 0;
                if (batchResponse.operations && batchResponse.operations.length > 0) {
                    for (const operation of batchResponse.operations) {
                        const matchedJob = sceneIdToJobMap.get(operation.sceneId);
                        if (!matchedJob || !matchedJob.job) {
                            logger.warn(`[GenNormal] ⚠️ Batch result with sceneId ${operation.sceneId} not matched to any job`);
                            unmatchedCount++;
                            continue;
                        }
                        const { queuedJob: batchQueuedJob, job: batchJobDetail } = matchedJob;
                        const queue = this.profileQueues.get(batchQueuedJob.profileId);
                        // Extract operationName from response
                        const operationName = operation.operation?.name || '';
                        const responseSceneId = operation.sceneId;
                        // Check if job failed immediately
                        if (operation.status === 'MEDIA_GENERATION_STATUS_FAILED' ||
                            operation.status === 'FAILED') {
                            // Mark job as FAILED immediately
                            await prisma.genNormalJob.update({
                                where: { id: batchJobDetail.id },
                                data: {
                                    status: 'FAILED',
                                    error: `Video generation failed: ${operation.status}`,
                                    completedAt: new Date(),
                                    providerJobId: operationName,
                                    sceneId: responseSceneId,
                                    progress: 0
                                }
                            });
                            if (queue) {
                                queue.runningJobs.delete(batchQueuedJob.jobId);
                            }
                            logger.error(`[GenNormal] ❌ Batch job #${batchJobDetail.jobIndex} FAILED immediately`, {
                                jobId: batchJobDetail.id,
                                sceneId: responseSceneId,
                                status: operation.status
                            });
                        }
                        else {
                            // 🚫 Race-guard: nếu project bị Cancel TRONG khi API call đang in-flight,
                            // KHÔNG được ghi đè status thành PROCESSING (sẽ phá CANCELLED đã set bởi
                            // stop endpoint). Giữ nguyên CANCELLED trong DB, log warning.
                            if (this.isProjectCancelled(batchJobDetail.projectId)) {
                                logger.warn(`[GenNormal] 🚫 Job #${batchJobDetail.jobIndex} đã CANCELLED giữa lúc API in-flight — bỏ qua write PROCESSING`, {
                                    jobId: batchJobDetail.id,
                                    operationName: operationName.substring(0, 30),
                                    sceneId: responseSceneId,
                                });
                                // (Optional) gọi Veo3 cancel API để giải phóng resource trên Google
                                // — TODO: implement nếu cần. Hiện chỉ skip ghi DB.
                            }
                            else {
                                // ✅ API SUCCESS: NOW mark job as PROCESSING with operationName and sceneId
                                // Only mark PROCESSING after successful API response (with reCAPTCHA + 200 OK)
                                // Veo 3.1 r2v parser also surfaces __workflowId (from media[].workflowId);
                                // lưu vào DB để upsample request có sẵn (metadata.workflowId).
                                const flowWorkflowId = operation.__workflowId || null;
                                // Điều kiện nằm NGAY trong câu ghi, không dựa vào cờ in-memory: removeProjectState()
                                // xoá `cancelledProjects` ngay khi stop, nên guard isProjectCancelled ở trên có thể
                                // đã hết hiệu lực trước lúc response in-flight này về → job vừa CANCELLED bị hồi sinh.
                                const marked = await prisma.genNormalJob.updateMany({
                                    where: {
                                        id: batchJobDetail.id,
                                        status: { notIn: ['CANCELLED', 'FAILED', 'COMPLETED'] },
                                    },
                                    data: {
                                        status: 'PROCESSING',
                                        startedAt: new Date(),
                                        progress: 30, // Was 10, but since recaptcha already set it to 25%, bumping to 30% to avoid dropping UI progress
                                        providerJobId: operationName,
                                        sceneId: responseSceneId,
                                        ...(flowWorkflowId ? { flowWorkflowId } : {}),
                                    }
                                });
                                if (marked.count === 0) {
                                    logger.warn(`[GenNormal] 🚫 Job #${batchJobDetail.jobIndex} đã kết thúc/huỷ giữa lúc API in-flight — bỏ qua write PROCESSING (op=${operationName.substring(0, 12)})`, { jobId: batchJobDetail.id });
                                }
                                else {
                                    logger.info(`[GenNormal] ✅ Batch job #${batchJobDetail.jobIndex} → PROCESSING (op=${operationName.substring(0, 12)}${flowWorkflowId ? ` wf=${flowWorkflowId.substring(0, 8)}` : ''})`);
                                }
                            }
                        }
                        matchedCount++;
                    }
                }
                if (unmatchedCount > 0) {
                    // Only log batch summary when there are unmatched results — the matched
                    // case is already announced by per-job "submitted successfully" lines.
                    logger.warn(`[GenNormal] 🎬 Batch submission: ${matchedCount} matched, ${unmatchedCount} unmatched (batchSize=${batchJobs.length})`);
                }
                // ✅ Reset 403 failure counter — captcha worked, profile is healthy.
                // Without this, the count from a previous failed run carries over and
                // the next batch starts already in penalty territory.
                if (matchedCount > 0) {
                    this.reset403FailureCount(job.profileId);
                    captchaManager.notifySuccess();
                }
                // Update project stats
                await this.updateProjectStats(job.projectId);
                return;
            }
            // Job status will be polled by GenNormalStatusPoller (core/queue/GenNormalStatusPoller.ts)
            // No need to start individual monitoring
        }
        catch (error) {
            // Extract detailed error message
            if (isVerificationRejected(error)) {
                await this.failJobsForVerification(queuedJob, this.currentBatchJobs.get(queuedJob.jobId));
                return;
            }
            let errorMessage = 'Unknown error';
            if (error.message) {
                errorMessage = error.message;
                // Try to extract more details from nested error objects
                if (error.message.includes('{') && error.message.includes('error')) {
                    try {
                        const errorMatch = error.message.match(/\{[\s\S]*\}/);
                        if (errorMatch) {
                            const errorObj = JSON.parse(errorMatch[0]);
                            if (errorObj.error?.message) {
                                errorMessage = errorObj.error.message;
                            }
                            else if (errorObj.error?.code) {
                                errorMessage = `${errorObj.error.code}: ${errorObj.error.message || errorMessage}`;
                            }
                        }
                    }
                    catch {
                        // Keep original error message if parsing fails
                    }
                }
            }
            const { briefVeo3Error } = await import('../../services/veo3/veo3ErrorHandler.js');
            logger.error(`[GenNormal] Job ${queuedJob.jobId} failed to submit: ${errorMessage}`, briefVeo3Error(error));
            // Browser race condition: browser destroyed by concurrent job — NOT a real 403.
            const isBrowserRaceErrorSingle = errorMessage.includes('Object has been destroyed') ||
                errorMessage.includes('Browser was destroyed') ||
                errorMessage.includes('Browser destroyed before') ||
                errorMessage.includes('ERR_FAILED (-2)');
            // Real reCAPTCHA failures (403 from Google, token timeout, etc.)
            const isRecaptchaFailure = !isBrowserRaceErrorSingle && (error?.isRecaptchaFailure ||
                errorMessage.includes('reCAPTCHA evaluation failed') ||
                errorMessage.includes('Xác thực reCAPTCHA thất bại') ||
                errorMessage.includes('Failed to obtain reCAPTCHA') ||
                errorMessage.includes('grecaptcha not available') ||
                errorMessage.includes('reCAPTCHA token request timeout') ||
                errorMessage.includes('reCAPTCHA token timeout'));
            const isRateLimit = errorMessage.includes('429') ||
                errorMessage.includes('rate limit') ||
                errorMessage.includes('RESOURCE_EXHAUSTED') ||
                errorMessage.includes('Quota Exceeded') ||
                errorMessage.includes('PUBLIC_ERROR_USER_REQUESTS_THROTTLED') ||
                errorMessage.includes('PUBLIC_ERROR_HIGH_TRAFFIC') ||
                error?.status === 429 ||
                error?.errorText?.includes('PUBLIC_ERROR_USER_REQUESTS_THROTTLED');
            // 🚫 Check if it's a daily quota exhausted error (Ultra account expired) - DO NOT RETRY
            const isUpgradeable = errorMessage.includes('PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED_UPGRADEABLE');
            const isDailyQuotaExhausted = isUpgradeable || isHardQuotaExhausted(errorMessage, error);
            if (isDailyQuotaExhausted) {
                const batchJobs = this.currentBatchJobs.get(queuedJob.jobId);
                const jobsToFail = batchJobs && batchJobs.length > 1 ? batchJobs : [queuedJob];
                const errorMsg = isUpgradeable ? ERR_QUOTA_UPGRADEABLE : ERR_DAILY_QUOTA_REACHED;
                logger.error(`[GenNormal] 🚫 ${jobsToFail.length} job(s) daily quota — failing this batch only.`, {
                    jobIds: jobsToFail.map(j => j.jobId),
                    profileId: queuedJob.profileId,
                    isUpgradeable,
                });
                if (batchJobs)
                    this.currentBatchJobs.delete(queuedJob.jobId);
                await this.failJobsOnHardQuota(queuedJob.profileId, queuedJob.projectId, jobsToFail.map(j => ({ jobId: j.jobId })), errorMsg);
                return;
            }
            // 🚦 TOO_MUCH_TRAFFIC: coi như 429 thường (gộp vào isRateLimitError bên dưới) — delay
            // per-profile + retry (cap 3), KHÔNG dừng project. Cờ này set từ veo3Service.
            const isTrafficOverload = isTransientTrafficLimit(errorMessage, error);
            // Check if error should NOT be retried (400 content policy, prominent people, etc.)
            // Skip check for reCAPTCHA failures (403) — those have their own retry logic.
            // Also check error.isNonRetryable flag set by veo3Service (backup nếu pattern miss).
            const isNonRetryable = !isRecaptchaFailure && (isNonRetryableError(errorMessage) || error?.isNonRetryable === true);
            if (isNonRetryable) {
                // 🔴 Mark ALL batch jobs as FAILED (not just the first one)
                const batchJobs = this.currentBatchJobs.get(queuedJob.jobId);
                const jobsToFail = batchJobs && batchJobs.length > 1 ? batchJobs : [queuedJob];
                logger.error(`[GenNormal] ❌ ${jobsToFail.length} job(s) failed with non-retryable error (e.g., audio filtered, content policy). Marking as FAILED.`, {
                    jobIds: jobsToFail.map(j => j.jobId),
                    error: errorMessage.substring(0, 200)
                });
                for (const jobToFail of jobsToFail) {
                    await prisma.genNormalJob.update({
                        where: { id: jobToFail.jobId },
                        data: {
                            status: 'FAILED',
                            error: errorMessage,
                            completedAt: new Date()
                        }
                    });
                    // Remove from running jobs
                    const queue = this.profileQueues.get(jobToFail.profileId);
                    if (queue) {
                        queue.runningJobs.delete(jobToFail.jobId);
                    }
                }
                // Clear batch tracking
                if (batchJobs) {
                    this.currentBatchJobs.delete(queuedJob.jobId);
                }
                await this.updateProjectStats(queuedJob.projectId);
                return;
            }
            // Browser race: quick silent retry (3s), no rotation, no 403 counter
            if (isBrowserRaceErrorSingle) {
                logger.warn(`[GenNormal] 🔄 Browser race (single job #${queuedJob.index}) — back to queue (3s, no rotation)`);
                await prisma.genNormalJob.update({
                    where: { id: queuedJob.jobId },
                    data: { status: 'QUEUED', error: null, progress: 0 }
                });
                const raceQueue = this.profileQueues.get(queuedJob.profileId);
                if (raceQueue) {
                    raceQueue.runningJobs.delete(queuedJob.jobId);
                    raceQueue.queuedJobs.push({ jobId: queuedJob.jobId, profileId: queuedJob.profileId, projectId: queuedJob.projectId, veo3ProjectId: queuedJob.veo3ProjectId, index: queuedJob.index, mode: queuedJob.mode || 'TEXT_TO_VIDEO', addedAt: Date.now() });
                }
                this.setProfileRateLimitDelay(queuedJob.profileId, 3, '403');
                await this.updateProjectStats(queuedJob.projectId);
                return;
            }
            if (isRecaptchaFailure) {
                // reCAPTCHA failures (real 403 from Google, token timeout, etc.)
                // Count failures FIRST to decide whether to rotate
                const failureCount403Single = this.increment403FailureCount(queuedJob.profileId);
                logger.warn(`[GenNormal] 🔐 Job #${queuedJob.index} reCAPTCHA failed (attempt #${failureCount403Single}). ${failureCount403Single >= 3 ? 'Running browser recovery.' : 'Retrying without recovery.'}`, {
                    jobId: queuedJob.jobId,
                    error: errorMessage.substring(0, 200),
                    profileId: queuedJob.profileId
                });
                // Sustained streak = score death → have the extension clear the anchor cookie + reload.
                if (failureCount403Single >= 3) {
                    this.triggerExtensionAnchorReset(queuedJob.profileId, failureCount403Single);
                }
                // Only run heavy browser recovery after 3+ consecutive real 403 failures.
                // First 1-2 failures: just wait and retry with same browser.
                if (failureCount403Single >= 3 && this.shouldRunRecovery(queuedJob.profileId, 'reset-prewarm-single')) {
                    try {
                        let veo3ProjectId;
                        try {
                            const project = await genNormalRepository.getProject(queuedJob.projectId);
                            if (project) {
                                const projectProfile = project.profiles.find((p) => p.profileId === queuedJob.profileId);
                                veo3ProjectId = projectProfile?.veo3ProjectId || undefined;
                            }
                        }
                        catch (e) {
                            logger.warn(`[GenNormal] Could not get veo3ProjectId for profile ${queuedJob.profileId}`);
                        }
                        logger.info(`[GenNormal] 🔄 Force resetting + prewarming browser for profile ${queuedJob.profileId} after ${failureCount403Single} failures...`);
                        const { accountLocaleService } = await import('../../lib/accountLocaleService.js');
                        const cachedLocale = accountLocaleService.getCachedLocale(queuedJob.profileId);
                        const queue = this.profileQueues.get(queuedJob.profileId);
                        if (queue) {
                            this.scheduleBrowserRecovery(queuedJob.profileId, queue, {
                                veo3ProjectId,
                                locale: cachedLocale,
                                context: 'reset-prewarm-single',
                                jobsBeingHandled: 1,
                            });
                        }
                    }
                    catch (refreshError) {
                        logger.error(`[GenNormal] ❌ Browser reset+prewarm error:`, refreshError.message);
                    }
                }
                // Requeue ALL batch jobs when 403 occurs (not just the first job)
                // failureCount403Single already incremented above
                // 🔴 MAX BATCH RETRY: If circuit breaker is open, FAIL jobs instead of infinite retry
                if (this.isCircuitBreakerOpen(queuedJob.profileId)) {
                    const batchJobs = this.currentBatchJobs.get(queuedJob.jobId);
                    const allJobs = batchJobs && batchJobs.length > 1 ? batchJobs : [queuedJob];
                    logger.error(`[GenNormal] 🛑 Circuit breaker open — marking ${allJobs.length} batch jobs as FAILED (profile ${queuedJob.profileId.substring(0, 8)}...)`, {
                        failureCount: failureCount403Single,
                        jobIds: allJobs.map(j => j.jobId)
                    });
                    for (const batchJob of allJobs) {
                        await this.requeueJobForRateLimitRetry(batchJob.jobId, batchJob.profileId, 'reCAPTCHA liên tục thất bại. Profile tạm dừng, vui lòng thử lại sau.', 0, false);
                    }
                    this.currentBatchJobs.delete(queuedJob.jobId);
                    return;
                }
                const isSilentRetrySingle = failureCount403Single <= 3;
                const singleRetryDelay = isSilentRetrySingle ? this.getRecaptchaSilentRetryDelaySec() : this.getEscalatingDelay(queuedJob.profileId);
                const batchJobs = this.currentBatchJobs.get(queuedJob.jobId);
                if (batchJobs && batchJobs.length > 1) {
                    logger.warn(`[GenNormal] 🔄 Batch 403: Requeueing ALL ${batchJobs.length} jobs in batch (silent=${isSilentRetrySingle}, attempt #${failureCount403Single}, delay=${singleRetryDelay}s)`, {
                        batchJobIds: batchJobs.map(j => j.jobId),
                        profileId: queuedJob.profileId
                    });
                    // Requeue all batch jobs: silent if <=3 failures (no visible error), escalating if >3
                    for (const batchJob of batchJobs) {
                        await this.requeueJobForRateLimitRetry(batchJob.jobId, batchJob.profileId, isSilentRetrySingle ? '' : errorMessage, singleRetryDelay, isSilentRetrySingle);
                    }
                    // Clear batch tracking
                    this.currentBatchJobs.delete(queuedJob.jobId);
                }
                else {
                    // Single job - silent retry if <=3 failures
                    await this.requeueJobForRateLimitRetry(queuedJob.jobId, queuedJob.profileId, isSilentRetrySingle ? '' : errorMessage, singleRetryDelay, isSilentRetrySingle);
                }
                // Set rate limit delay for this profile to prevent immediate retry of other jobs
                // Use short 30s delay for silent retries (<=3), escalating for 3+ failures
                const currentFailureCount = this.profile403FailureCount.get(queuedJob.profileId) || 0;
                const rateLimitDelay = currentFailureCount <= 3 ? this.getRecaptchaSilentRetryDelaySec() : this.getEscalatingDelay(queuedJob.profileId);
                this.setProfileRateLimitDelay(queuedJob.profileId, rateLimitDelay, '403');
                return;
            }
            // Check if error is due to reCAPTCHA rejection (403) - fallback for other 403 errors
            const isRecaptchaError = errorMessage.includes('403') &&
                !errorMessage.includes('reCAPTCHA evaluation failed'); // Avoid double handling
            const isRateLimitError = isRateLimit ||
                errorMessage.includes('Too Many Requests') ||
                error?.status === 429 ||
                isTrafficOverload;
            if (isRecaptchaError) {
                // Option 1 patch — 60s → 300s (5 phút). Google session score sau 403 mất
                // ~5-10 phút để phục hồi; retry sớm (60s) gần như luôn fail tiếp → waste
                // browser reset cost. 300s đủ cho 1 chu kỳ reCAPTCHA + cookies rotate.
                const RECAPTCHA_403_COOLDOWN_SECONDS = 60;
                logger.warn(`[GenNormal] 🤖 Job #${queuedJob.index} hit reCAPTCHA rejection (403). Force resetting + prewarming browser and retrying after ${RECAPTCHA_403_COOLDOWN_SECONDS}s.`, {
                    jobId: queuedJob.jobId,
                    projectId: queuedJob.projectId,
                    profileId: queuedJob.profileId,
                    index: queuedJob.index,
                    error: errorMessage,
                    delaySeconds: RECAPTCHA_403_COOLDOWN_SECONDS
                });
                // 🔴 CRITICAL: Force reset browser AND prewarm it (BLOCKS until browser ready)
                if (this.shouldRunRecovery(queuedJob.profileId, 'reset-prewarm-fallback')) {
                    try {
                        // Get veo3ProjectId for this profile
                        let veo3ProjectId;
                        try {
                            const project = await genNormalRepository.getProject(queuedJob.projectId);
                            if (project) {
                                const projectProfile = project.profiles.find((p) => p.profileId === queuedJob.profileId);
                                veo3ProjectId = projectProfile?.veo3ProjectId || undefined;
                            }
                        }
                        catch (e) {
                            logger.warn(`[GenNormal] Could not get veo3ProjectId for profile ${queuedJob.profileId}`);
                        }
                        logger.info(`[GenNormal] 🔄 Force resetting + prewarming browser for profile ${queuedJob.profileId}...`);
                        // ⚠️ P0 #2: pass cached account locale
                        const { accountLocaleService: _als2 } = await import('../../lib/accountLocaleService.js');
                        const cachedLocale2 = _als2.getCachedLocale(queuedJob.profileId);
                        const queue = this.profileQueues.get(queuedJob.profileId);
                        if (queue) {
                            this.scheduleBrowserRecovery(queuedJob.profileId, queue, {
                                veo3ProjectId,
                                locale: cachedLocale2,
                                context: 'reset-prewarm-fallback',
                                jobsBeingHandled: 1,
                            });
                        }
                    }
                    catch (refreshError) {
                        logger.error(`[GenNormal] ❌ Error during browser reset+prewarm for profile ${queuedJob.profileId}:`, refreshError);
                        // Continue with retry even if reset fails
                    }
                }
                // Get job to check retry count
                const recaptchaJob = await prisma.genNormalJob.findUnique({
                    where: { id: queuedJob.jobId },
                    select: { retryCount: true }
                });
                // Option 1 patch — 60s → 300s (5 phút), match RECAPTCHA_403_COOLDOWN_SECONDS ở trên.
                this.setProfileRateLimitDelay(queuedJob.profileId, 300, '403');
                // Create retry timestamp (300s from now)
                const retryAt = new Date(Date.now() + 300 * 1000).toISOString();
                // 🔴 Circuit breaker check for fallback 403
                if (this.isCircuitBreakerOpen(queuedJob.profileId)) {
                    const batchJobs = this.currentBatchJobs.get(queuedJob.jobId);
                    const allJobs = batchJobs && batchJobs.length > 1 ? batchJobs : [queuedJob];
                    logger.error(`[GenNormal] 🛑 Circuit breaker open (fallback) — stopping ${allJobs.length} jobs for profile ${queuedJob.profileId.substring(0, 8)}...`);
                    this.currentBatchJobs.delete(queuedJob.jobId);
                    return;
                }
                // 🔴 CRITICAL: Requeue ALL batch jobs when 403 occurs (not just the first job)
                const batchJobs = this.currentBatchJobs.get(queuedJob.jobId);
                if (batchJobs && batchJobs.length > 1) {
                    logger.warn(`[GenNormal] 🔄 Batch 403 (fallback): Requeueing ALL ${batchJobs.length} jobs in batch`, {
                        batchJobIds: batchJobs.map(j => j.jobId),
                        profileId: queuedJob.profileId
                    });
                    // Requeue all batch jobs
                    for (const batchJob of batchJobs) {
                        const batchJobData = await prisma.genNormalJob.findUnique({
                            where: { id: batchJob.jobId },
                            select: { retryCount: true, mode: true, projectId: true, jobIndex: true }
                        });
                        await prisma.genNormalJob.update({
                            where: { id: batchJob.jobId },
                            data: {
                                status: 'QUEUED',
                                error: `RATE_LIMIT_RETRY:${retryAt}:403 - reCAPTCHA evaluation failed`,
                                progress: 0,
                                retryCount: (batchJobData?.retryCount || 0) + 1
                            }
                        });
                        this.requeueJob(batchJob.jobId, batchJob.profileId, batchJobData.projectId, batchJobData.jobIndex, batchJobData.mode || 'TEXT_TO_VIDEO', true);
                    }
                    // Clear batch tracking
                    this.currentBatchJobs.delete(queuedJob.jobId);
                }
                else {
                    // Single job - update and requeue just this job
                    await prisma.genNormalJob.update({
                        where: { id: queuedJob.jobId },
                        data: {
                            status: 'QUEUED',
                            error: `RATE_LIMIT_RETRY:${retryAt}:403 - reCAPTCHA evaluation failed`,
                            progress: 0,
                            retryCount: (recaptchaJob?.retryCount || 0) + 1
                        }
                    });
                    this.requeueJob(queuedJob.jobId, queuedJob.profileId, queuedJob.projectId, queuedJob.index, queuedJob.mode, true);
                }
                return;
            }
            if (isRateLimitError) {
                const RATE_LIMIT_MAX_RETRIES = 3;
                const job = await prisma.genNormalJob.findUnique({
                    where: { id: queuedJob.jobId },
                    select: { retryCount: true, maxRetries: true, mode: true }
                });
                if (job && job.retryCount < RATE_LIMIT_MAX_RETRIES) {
                    const delaySeconds = this.getRateLimitDelaySec(queuedJob.profileId, errorMessage, error);
                    const retryAt = Date.now() + delaySeconds * 1000;
                    logger.warn(`[GenNormal] ⏰ Job #${queuedJob.index} hit rate limit (429). Pausing profile queue for ${delaySeconds}s (retry ${job.retryCount + 1}/${RATE_LIMIT_MAX_RETRIES}).`, {
                        jobId: queuedJob.jobId,
                        error: errorMessage.substring(0, 200),
                        profileId: queuedJob.profileId
                    });
                    const retryAtISO = new Date(retryAt).toISOString();
                    const rateLimitError = `RATE_LIMIT_RETRY:${retryAtISO}:${errorMessage.substring(0, 200)}`;
                    await prisma.genNormalJob.update({
                        where: { id: queuedJob.jobId },
                        data: {
                            status: 'QUEUED',
                            error: rateLimitError,
                            progress: 0,
                            retryCount: (job.retryCount || 0) + 1
                        }
                    });
                    const queue = this.profileQueues.get(queuedJob.profileId);
                    if (queue) {
                        queue.runningJobs.delete(queuedJob.jobId);
                        queue.queuedJobs.unshift({
                            jobId: queuedJob.jobId,
                            profileId: queuedJob.profileId,
                            projectId: queuedJob.projectId,
                            index: queuedJob.index,
                            mode: job.mode || 'TEXT_TO_VIDEO',
                            addedAt: Date.now()
                        });
                    }
                    this.setProfileRateLimitDelay(queuedJob.profileId, delaySeconds, '429');
                    await this.updateProjectStats(queuedJob.projectId);
                    return;
                }
                else {
                    logger.error(`[GenNormal] 🛑 Job #${queuedJob.index} exceeded ${RATE_LIMIT_MAX_RETRIES} rate-limit retries — marking FAILED`, {
                        jobId: queuedJob.jobId,
                        retryCount: job?.retryCount || 0,
                        maxRetries: RATE_LIMIT_MAX_RETRIES
                    });
                }
            }
            // For non-rate-limit errors, also retry automatically (up to maxRetries)
            // Get job to check retry count
            const job = await prisma.genNormalJob.findUnique({
                where: { id: queuedJob.jobId },
                select: { retryCount: true, maxRetries: true, jobIndex: true, projectId: true, mode: true }
            });
            if (job && job.retryCount < (job.maxRetries || 10)) {
                const retryAttempt = (job.retryCount || 0) + 1;
                // Detect Google 5xx (server sập / INTERNAL). Không phải reCAPTCHA issue,
                // không cần backoff lâu — retry sau 5-10s là Google thường khôi phục.
                const isGoogle5xx = error?.isGoogleServerError === true
                    || errorMessage.includes('Mã 500')
                    || errorMessage.includes('Mã 502')
                    || errorMessage.includes('Mã 503')
                    || errorMessage.includes('Mã 504')
                    || errorMessage.includes('Internal error encountered');
                let baseDelaySeconds;
                let maxDelaySeconds;
                if (isGoogle5xx) {
                    baseDelaySeconds = 5; // attempt 1: 5s
                    maxDelaySeconds = 30; // attempt 3+: capped 30s
                    logger.warn(`[GenNormal] ⚡ Google 5xx detected → fast-retry (base=${baseDelaySeconds}s, max=${maxDelaySeconds}s)`);
                }
                else {
                    baseDelaySeconds = 60; // reCAPTCHA / other: backoff longer
                    maxDelaySeconds = 600;
                }
                const retryDelaySeconds = Math.min(baseDelaySeconds * Math.pow(2, retryAttempt - 1), maxDelaySeconds);
                const retryDelayMs = retryDelaySeconds * 1000;
                const retryAt = Date.now() + retryDelayMs;
                const retryAtISO = new Date(retryAt).toISOString();
                // 🔴 CRITICAL: Requeue ALL batch jobs when error occurs (not just the first job)
                const batchJobs = this.currentBatchJobs.get(queuedJob.jobId);
                if (batchJobs && batchJobs.length > 1) {
                    logger.warn(`[GenNormal] 🔄 Batch error: Requeueing ALL ${batchJobs.length} jobs in batch for retry`, {
                        batchJobIds: batchJobs.map(j => j.jobId),
                        profileId: queuedJob.profileId,
                        retryAttempt,
                        retryDelaySeconds,
                        error: errorMessage.substring(0, 200)
                    });
                    // Requeue all batch jobs
                    const queue = this.profileQueues.get(queuedJob.profileId);
                    for (const batchJob of batchJobs) {
                        const batchJobData = await prisma.genNormalJob.findUnique({
                            where: { id: batchJob.jobId },
                            select: { retryCount: true, maxRetries: true, mode: true, projectId: true, veo3ProjectId: true, jobIndex: true }
                        });
                        const batchRetryAttempt = (batchJobData?.retryCount || 0) + 1;
                        await prisma.genNormalJob.update({
                            where: { id: batchJob.jobId },
                            data: {
                                status: 'QUEUED',
                                error: `RETRY:${retryAtISO}:${errorMessage.substring(0, 200)}`,
                                progress: 0,
                                retryCount: batchRetryAttempt
                            }
                        });
                        if (queue) {
                            queue.runningJobs.delete(batchJob.jobId);
                            const newQueuedJob = {
                                jobId: batchJob.jobId,
                                profileId: batchJob.profileId,
                                projectId: batchJobData.projectId,
                                veo3ProjectId: batchJobData?.veo3ProjectId || undefined,
                                index: batchJobData.jobIndex,
                                mode: batchJobData.mode || 'TEXT_TO_VIDEO',
                                addedAt: Date.now()
                            };
                            if (retryDelaySeconds < 120) {
                                queue.queuedJobs.unshift(newQueuedJob);
                            }
                            else {
                                queue.queuedJobs.push(newQueuedJob);
                            }
                        }
                    }
                    // Clear batch tracking
                    this.currentBatchJobs.delete(queuedJob.jobId);
                    logger.warn(`[GenNormal] 🔄 All ${batchJobs.length} batch jobs requeued for retry. Will retry after ${retryDelaySeconds}s.`, {
                        profileId: queuedJob.profileId,
                        retryAt: retryAtISO,
                        retryDelaySeconds,
                        error: errorMessage.substring(0, 200)
                    });
                }
                else {
                    // Single job - update and requeue just this job
                    await prisma.genNormalJob.update({
                        where: { id: queuedJob.jobId },
                        data: {
                            status: 'QUEUED',
                            error: `RETRY:${retryAtISO}:${errorMessage.substring(0, 200)}`,
                            progress: 0,
                            retryCount: retryAttempt
                        }
                    });
                    // Remove from running jobs
                    const queue = this.profileQueues.get(queuedJob.profileId);
                    if (queue) {
                        queue.runningJobs.delete(queuedJob.jobId);
                        // Add job to queue with delay (add to front if retry delay is short, otherwise add to end)
                        const newQueuedJob = {
                            jobId: queuedJob.jobId,
                            profileId: queuedJob.profileId,
                            projectId: queuedJob.projectId,
                            veo3ProjectId: queuedJob.veo3ProjectId,
                            index: queuedJob.index,
                            mode: job.mode || 'TEXT_TO_VIDEO',
                            addedAt: Date.now()
                        };
                        if (retryDelaySeconds < 120) {
                            queue.queuedJobs.unshift(newQueuedJob);
                        }
                        else {
                            queue.queuedJobs.push(newQueuedJob);
                        }
                        logger.warn(`[GenNormal] 🔄 Job #${queuedJob.index} requeued for retry (attempt ${retryAttempt}/${job.maxRetries || 10}). Will retry after ${retryDelaySeconds}s.`, {
                            jobId: queuedJob.jobId,
                            profileId: queuedJob.profileId,
                            projectId: queuedJob.projectId,
                            retryAt: retryAtISO,
                            retryDelaySeconds,
                            retryCount: retryAttempt,
                            error: errorMessage.substring(0, 200),
                            note: `Job sẽ được retry tự động sau ${retryDelaySeconds} giây (exponential backoff).`
                        });
                    }
                }
                // Update project stats
                await this.updateProjectStats(queuedJob.projectId);
                return; // Don't mark as FAILED, will retry
            }
            else {
                // Max retries reached, mark as FAILED
                // 🔴 CRITICAL: Mark ALL batch jobs as FAILED when max retries reached
                const batchJobs = this.currentBatchJobs.get(queuedJob.jobId);
                if (batchJobs && batchJobs.length > 1) {
                    logger.error(`[GenNormal] ❌ Batch error: ALL ${batchJobs.length} jobs exceeded max retries. Marking all as FAILED.`, {
                        batchJobIds: batchJobs.map(j => j.jobId),
                        retryCount: job?.retryCount || 0,
                        maxRetries: job?.maxRetries || 10,
                        error: errorMessage.substring(0, 200)
                    });
                    // Mark ALL batch jobs as FAILED
                    for (const batchJob of batchJobs) {
                        await prisma.genNormalJob.update({
                            where: { id: batchJob.jobId },
                            data: {
                                status: 'FAILED',
                                error: errorMessage,
                                completedAt: new Date()
                            }
                        });
                        // Remove from running jobs
                        const queue = this.profileQueues.get(batchJob.profileId);
                        if (queue) {
                            queue.runningJobs.delete(batchJob.jobId);
                        }
                    }
                    // Clear batch tracking
                    this.currentBatchJobs.delete(queuedJob.jobId);
                    // Update project stats
                    await this.updateProjectStats(queuedJob.projectId);
                    return; // All batch jobs marked FAILED
                }
                else {
                    logger.error(`[GenNormal] ❌ Job #${queuedJob.index} exceeded max retries (${job?.retryCount || 0}/${job?.maxRetries || 10}). Marking as FAILED.`, {
                        jobId: queuedJob.jobId,
                        retryCount: job?.retryCount || 0,
                        maxRetries: job?.maxRetries || 10,
                        error: errorMessage.substring(0, 200)
                    });
                }
            }
            // Update status to FAILED (max retries reached) - for single job only
            await prisma.genNormalJob.update({
                where: { id: queuedJob.jobId },
                data: {
                    status: 'FAILED',
                    error: errorMessage,
                    completedAt: new Date()
                }
            });
            // Update project stats
            await this.updateProjectStats(queuedJob.projectId);
            // Remove from running jobs
            // NOTE: lastSubmitTime was already updated when job was submitted
            // No need to update again here - delay is calculated from submission time
            // Rate limit errors are handled separately with rateLimitUntil
            const queue = this.profileQueues.get(queuedJob.profileId);
            if (queue) {
                queue.runningJobs.delete(queuedJob.jobId);
                // Rate limit errors are handled by setProfileRateLimitDelay which sets rateLimitUntil
                // and updates lastSubmitTime appropriately
            }
        }
        // Note: Job stays in runningJobs until it completes (handled by GenNormalStatusPoller)
    }
    /**
     * Mark job as completed/failed and remove from running queue
     * Called by GenNormalStatusPoller when job status changes
     *
     * NOTE: lastSubmitTime is now updated when job is SUBMITTED (not when completed)
     * to ensure delay between submissions, not between completions.
     * This allows each profile to run independently like separate browsers.
     */
    markJobCompleted(jobId, profileId) {
        const queue = this.profileQueues.get(profileId);
        if (queue) {
            const wasRunning = queue.runningJobs.delete(jobId);
            if (wasRunning) {
                // NOTE: lastSubmitTime is NOT updated here anymore
                // It's updated when job is submitted to ensure delay between submissions
                // This prevents multiple jobs from submitting simultaneously
                logger.info(`[GenNormal] Job ${jobId.slice(0, 12)} removed from running queue (running=${queue.runningJobs.size}, queued=${queue.queuedJobs.length})`);
                if (!this.maybeTriggerPendingUaRotation(profileId, queue) && !queue.uaRotationInFlight) {
                    this.triggerPendingBrowserRecovery(profileId, queue);
                }
            }
        }
    }
    /**
     * Set rate limit delay for a profile after error
     * @param profileId Profile ID to set delay for
     * @param delaySeconds Delay in seconds (default: 180s for rate limit, can be higher for reCAPTCHA)
     * @param errorType Type of error ('403' for reCAPTCHA, '429' for rate limit)
     */
    /**
     * 🪟 P1: Record a 403 in sliding window; return true if sliding penalty just tripped.
     * Also fires P5 notify so Electron main can adjust dynamic MAX_BATCHES threshold.
     */
    recordSliding403(profileId) {
        captchaManager.notifyFailure();
        const now = Date.now();
        const cutoff = now - this.SLIDING_WINDOW_MS;
        const timestamps = (this.profile403Timestamps.get(profileId) || []).filter(t => t >= cutoff);
        timestamps.push(now);
        this.profile403Timestamps.set(profileId, timestamps);
        if (timestamps.length >= this.SLIDING_WINDOW_THRESHOLD) {
            const penaltyUntil = now + this.SLIDING_WINDOW_PENALTY_MS;
            const existing = this.profileSlidingPenaltyUntil.get(profileId) || 0;
            if (penaltyUntil > existing) {
                this.profileSlidingPenaltyUntil.set(profileId, penaltyUntil);
                logger.warn(`[GenNormal] 🪟 Sliding window 403 count=${timestamps.length} within 5min → extra penalty ${this.SLIDING_WINDOW_PENALTY_MS / 1000}s for profile ${profileId.substring(0, 8)}...`);
                return true;
            }
        }
        return false;
    }
    setProfileRateLimitDelay(profileId, delaySeconds = 180, errorType = '429') {
        const queue = this.profileQueues.get(profileId);
        if (queue) {
            // \u26d4 User y\u00eau c\u1ea7u: lo\u1ea1i b\u1ecf logic sliding-window + adaptive delay extra penalty.
            // Ch\u1ec9 delay 20-30s fixed theo `delaySeconds` caller truy\u1ec1n t\u1eeb getEscalatingDelay().
            // Sliding window v\u1eabn record \u0111\u1ec3 notify Electron, nh\u01b0ng kh\u00f4ng cho ph\u00e9p t\u0103ng delay.
            if (errorType === '403') {
                this.recordSliding403(profileId); // record-only, kh\u00f4ng extra penalty
            }
            const delayMs = delaySeconds * 1000;
            queue.rateLimitUntil = Date.now() + delayMs;
            queue.rateLimitType = errorType;
            // Update lastSubmitTime to NOW so that when rateLimitUntil expires,
            // the normal delay (10s) will still apply before submitting next job
            queue.lastSubmitTime = Date.now();
            logger.warn(`[GenNormal] ⏰ Rate limit delay ${delaySeconds}s set for profile ${profileId.slice(0, 12)} (until ${new Date(queue.rateLimitUntil).toISOString().substring(11, 19)})`);
        }
        else {
            logger.warn(`[GenNormal] Cannot set rate limit delay: queue not found for profile ${profileId}`);
        }
    }
    /**
     * Add a job back to queue (for retry purposes)
     * This is a public method to allow requeuing jobs from external modules
     */
    async requeueJob(jobId, profileId, projectId, jobIndex, mode, addToFront = false) {
        const queue = this.profileQueues.get(profileId);
        if (queue) {
            const queuedJob = {
                jobId,
                profileId,
                projectId,
                index: jobIndex,
                mode: mode || 'TEXT_TO_VIDEO',
                addedAt: Date.now()
            };
            if (addToFront) {
                queue.queuedJobs.unshift(queuedJob);
            }
            else {
                queue.queuedJobs.push(queuedJob);
            }
            logger.debug(`[GenNormal] Job requeued`, {
                jobId,
                profileId,
                projectId,
                jobIndex,
                addToFront,
                queueLength: queue.queuedJobs.length
            });
        }
        else {
            logger.warn(`[GenNormal] Cannot requeue job: queue not found for profile ${profileId}`);
        }
    }
    /**
     * Requeue a job for retry after rate limit error
     * This is called when a job fails due to rate limit during status polling
     * @param delaySeconds Retry delay in seconds (default: 60s for rate limit, can be 120s for reCAPTCHA)
     */
    async requeueJobForRateLimitRetry(jobId, profileId, errorMessage, delaySeconds = 60, isSilent = false) {
        const job = await prisma.genNormalJob.findUnique({
            where: { id: jobId },
            select: { retryCount: true, maxRetries: true, jobIndex: true, projectId: true, mode: true }
        });
        if (!job) {
            logger.warn(`[GenNormal] Cannot requeue job: job not found ${jobId}`);
            return;
        }
        const effectiveMaxRetries = Math.min(job.maxRetries || 10, 3);
        if (job.retryCount >= effectiveMaxRetries) {
            const trimmedUserErr = errorMessage?.trim()
                ? errorMessage.substring(0, 150)
                : 'reCAPTCHA / rate-limit';
            const failMsg = `Đã retry ${effectiveMaxRetries} lần do reCAPTCHA (403) hoặc rate limit (429). ${trimmedUserErr}`;
            logger.error(`[GenNormal] 🛑 Job ${jobId} exceeded ${effectiveMaxRetries} rate-limit/recaptcha retries — marking FAILED`, {
                jobId,
                retryCount: job.retryCount,
                maxRetries: effectiveMaxRetries,
            });
            await prisma.genNormalJob.update({
                where: { id: jobId },
                data: {
                    status: 'FAILED',
                    error: failMsg,
                    completedAt: new Date(),
                    progress: 0,
                },
            });
            const queue = this.profileQueues.get(profileId);
            if (queue) {
                queue.runningJobs.delete(jobId);
            }
            await this.updateProjectStats(job.projectId);
            return;
        }
        // Determine error type based on error message
        const is403Error = errorMessage.includes('403') ||
            errorMessage.includes('reCAPTCHA evaluation failed') ||
            errorMessage.includes('Xác thực reCAPTCHA thất bại');
        const errorType = is403Error ? '403' : '429';
        // Set rate limit delay for this profile (use provided delaySeconds)
        this.setProfileRateLimitDelay(profileId, delaySeconds, errorType);
        // Set rate limit retry info in error field
        // If isSilent: error = null (invisible to user, just QUEUED again)
        // If not silent: error = RATE_LIMIT_RETRY message (user can see it)
        const RATE_LIMIT_DELAY_MS = delaySeconds * 1000;
        const retryAt = Date.now() + RATE_LIMIT_DELAY_MS;
        const retryAtISO = new Date(retryAt).toISOString();
        const rateLimitError = isSilent
            ? null // Silent retry: no visible error
            : `RATE_LIMIT_RETRY:${retryAtISO}:${errorMessage.substring(0, 200)}`;
        // Update job to QUEUED status with rate limit retry info.
        // Xoá luôn op cũ: giữ lại providerJobId/sceneId của lần hỏng khiến chu kỳ poll sau có thể
        // đọc lại đúng phán quyết FAILED đó và tính thêm một retry nữa cho cùng một lần hỏng.
        // (An toàn với restoreState: nhánh cancel PROCESSING+providerJobId=null yêu cầu status
        // PROCESSING, còn job QUEUED vốn đã bị cancel khi restart bất kể providerJobId.)
        await prisma.genNormalJob.update({
            where: { id: jobId },
            data: {
                status: 'QUEUED',
                error: rateLimitError,
                progress: 0,
                retryCount: (job.retryCount || 0) + 1,
                providerJobId: null,
                sceneId: null,
                startedAt: null
            }
        });
        // Add job to queue (at the front) so it gets retried first after delay expires
        const queue = this.profileQueues.get(profileId);
        if (queue) {
            // Remove from running jobs if it was there
            queue.runningJobs.delete(jobId);
            // Add to front of queue for retry
            queue.queuedJobs.unshift({
                jobId,
                profileId,
                projectId: job.projectId,
                index: job.jobIndex,
                mode: job.mode || 'TEXT_TO_VIDEO',
                addedAt: Date.now()
            });
            logger.warn(`[GenNormal] 🔄 Job #${job.jobIndex} requeued for rate limit retry (delay=${delaySeconds}s, retryCount=${job.retryCount + 1}, err="${errorMessage.substring(0, 80)}")`);
        }
        else {
            logger.warn(`[GenNormal] Cannot requeue job: queue not found for profile ${profileId}`);
        }
    }
    // Note: pollJobsStatus() method has been removed - status polling is now handled by GenNormalStatusPoller
    // See: core/queue/GenNormalStatusPoller.ts
    /** Stop only the rejected jobs and retain the actionable provider error. */
    async failJobsForVerification(queuedJob, batchJobs) {
        const jobs = batchJobs?.length ? batchJobs : [queuedJob];
        for (const job of jobs) {
            await prisma.genNormalJob.update({
                where: { id: job.jobId },
                data: { status: 'FAILED', error: VERIFICATION_REQUIRED_MESSAGE, completedAt: new Date(), progress: 0 },
            });
            const queue = this.profileQueues.get(job.profileId);
            if (queue) {
                queue.runningJobs.delete(job.jobId);
                queue.queuedJobs = queue.queuedJobs.filter(pending => pending.jobId !== job.jobId);
            }
        }
        this.currentBatchJobs.delete(queuedJob.jobId);
        logger.warn(`[GenNormal] Verification rejected; ${jobs.length} job(s) stopped pending user action on Google Flow.`);
        await this.updateProjectStats(queuedJob.projectId);
    }
    /** Update project statistics. */
    async updateProjectStats(projectId) {
        // ⚡ Memory optim: dùng groupBy thay vì findMany. findMany load TẤT CẢ row vào RAM
        // (1000+ jobs × N project × N call/giây → memory spike). groupBy chỉ trả 3-5 row count
        // tổng hợp ở DB level. Hàm này được gọi mỗi job complete → giảm áp lực memory + DB.
        const [statusCounts, project] = await Promise.all([
            prisma.genNormalJob.groupBy({
                by: ['status'],
                where: { projectId },
                _count: { _all: true }
            }),
            prisma.genNormalProject.findUnique({
                where: { id: projectId },
                select: { source: true }
            })
        ]);
        const countByStatus = {};
        for (const row of statusCounts) {
            countByStatus[row.status] = row._count._all;
        }
        const completedJobs = countByStatus['COMPLETED'] ?? 0;
        const failedJobs = countByStatus['FAILED'] ?? 0;
        const processingJobs = countByStatus['PROCESSING'] ?? 0;
        const totalJobs = Object.values(countByStatus).reduce((sum, n) => sum + n, 0);
        const stats = { totalJobs, completedJobs, failedJobs, processingJobs };
        // Pipeline projects: don't auto-set COMPLETED based on job count alone
        // pipelineService.checkProjectCompletion() handles pipeline completion
        const updateData = { ...stats };
        if (project?.source !== 'pipeline') {
            let projectStatus = 'GENERATING';
            if (stats.completedJobs === stats.totalJobs) {
                projectStatus = 'COMPLETED';
            }
            else if (stats.failedJobs + stats.completedJobs === stats.totalJobs) {
                projectStatus = stats.completedJobs > 0 ? 'COMPLETED' : 'FAILED';
            }
            updateData.status = projectStatus;
            if (projectStatus === 'COMPLETED') {
                updateData.completedAt = new Date();
            }
        }
        await prisma.genNormalProject.update({
            where: { id: projectId },
            data: updateData
        });
    }
    /**
     * Cancel all jobs in project (called by Stop button)
     */
    async cancelProject(projectId) {
        logger.info(`[GenNormal] Stopping project`, { projectId });
        // ✅ Step 1: Cancel all QUEUED and PROCESSING jobs in DB
        const cancelledJobs = await prisma.genNormalJob.updateMany({
            where: {
                projectId,
                status: { in: ['QUEUED', 'PROCESSING'] }
            },
            data: {
                status: 'CANCELLED',
                completedAt: new Date()
            }
        });
        logger.info(`[GenNormal] Cancelled ${cancelledJobs.count} jobs in database`, {
            projectId,
            count: cancelledJobs.count
        });
        // ✅ Step 2: Update project status to STOPPED
        await prisma.genNormalProject.update({
            where: { id: projectId },
            data: { status: 'STOPPED' }
        });
        // ✅ Step 3: Clear ALL jobs (queued + running) from in-memory queues
        await this.clearProjectJobs(projectId);
        logger.info(`[GenNormal] Project stopped successfully`, { projectId });
    }
    /**
     * Pause project (stop submitting new jobs + mark running jobs as QUEUED)
     */
    async pauseProject(projectId) {
        logger.info(`[GenNormal] Pausing project`, { projectId });
        // ✅ Step 1: Update project status to PAUSED
        await prisma.genNormalProject.update({
            where: { id: projectId },
            data: { status: 'PAUSED' }
        });
        // ✅ Step 2: Mark all PROCESSING jobs as QUEUED (so they can resume later)
        const pausedJobs = await prisma.genNormalJob.updateMany({
            where: {
                projectId,
                status: 'PROCESSING'
            },
            data: {
                status: 'QUEUED'
            }
        });
        logger.info(`[GenNormal] Marked ${pausedJobs.count} PROCESSING jobs as QUEUED`, {
            projectId,
            count: pausedJobs.count
        });
        // ✅ Step 3: Remove running jobs from in-memory queues (they're back to QUEUED now)
        for (const [profileId, queue] of this.profileQueues) {
            const runningJobIds = Array.from(queue.runningJobs);
            let removedCount = 0;
            for (const jobId of runningJobIds) {
                const job = await prisma.genNormalJob.findUnique({
                    where: { id: jobId },
                    select: { projectId: true, status: true }
                });
                if (job && job.projectId === projectId) {
                    queue.runningJobs.delete(jobId);
                    removedCount++;
                    // Re-add to queued jobs if status is QUEUED
                    if (job.status === 'QUEUED') {
                        const queuedJob = await prisma.genNormalJob.findUnique({
                            where: { id: jobId },
                            select: { id: true, profileId: true, projectId: true, veo3ProjectId: true, jobIndex: true, mode: true }
                        });
                        if (queuedJob) {
                            queue.queuedJobs.push({
                                jobId: queuedJob.id,
                                profileId: queuedJob.profileId,
                                projectId: queuedJob.projectId,
                                veo3ProjectId: queuedJob.veo3ProjectId || undefined,
                                index: queuedJob.jobIndex,
                                mode: queuedJob.mode || 'TEXT_TO_VIDEO',
                                addedAt: Date.now()
                            });
                        }
                    }
                }
            }
            if (removedCount > 0) {
                logger.info(`[GenNormal] Removed ${removedCount} running jobs from profile ${profileId} queue`, {
                    profileId,
                    projectId,
                    removedCount
                });
            }
        }
        logger.info(`[GenNormal] Project paused successfully`, { projectId });
    }
    /**
     * Resume project
     */
    async resumeProject(projectId) {
        logger.info(`[GenNormal] Resuming project: ${projectId}`);
        // Legacy: TOO_MUCH_TRAFFIC nay không còn dừng project (xử lý như 429 → delay/retry), nên job
        // MỚI không mang marker này. Giữ lại để dọn các job CŨ đã bị PAUSE dở từ trước khi đổi hành vi.
        await prisma.genNormalJob.updateMany({
            where: { projectId, status: 'QUEUED', error: { startsWith: 'TRAFFIC_OVERLOAD:' } },
            data: { error: null },
        });
        await prisma.genNormalProject.update({
            where: { id: projectId },
            data: { status: 'GENERATING' }
        });
        // Re-initialize queue
        await this.initializeProject(projectId);
    }
    /**
     * Get rate limit info for a project (aggregated from all profiles in the project)
     * This is used by pollJobs to return rate limit status to frontend
     */
    getProjectRateLimitInfo(projectId) {
        const now = Date.now();
        const profiles = [];
        let hasRateLimit = false;
        for (const [profileId, queue] of this.profileQueues) {
            // Check if this profile has any jobs for this project
            const hasProjectJobs = queue.queuedJobs.some(j => j.projectId === projectId) ||
                queue.submissionQueue.some(j => j.projectId === projectId);
            if (!hasProjectJobs && queue.runningJobs.size === 0) {
                continue; // Skip profiles not related to this project
            }
            const isRateLimited = queue.rateLimitUntil !== undefined && queue.rateLimitUntil > now;
            const remainingMs = isRateLimited ? queue.rateLimitUntil - now : 0;
            if (isRateLimited) {
                hasRateLimit = true;
            }
            profiles.push({
                profileId,
                isRateLimited,
                rateLimitType: isRateLimited ? queue.rateLimitType : undefined,
                rateLimitUntil: isRateLimited && queue.rateLimitUntil ? new Date(queue.rateLimitUntil).toISOString() : undefined,
                remainingSeconds: isRateLimited ? Math.ceil(remainingMs / 1000) : undefined,
                queuedJobs: queue.queuedJobs.filter(j => j.projectId === projectId).length,
                runningJobs: queue.runningJobs.size
            });
        }
        return { hasRateLimit, profiles };
    }
    /**
     * Check if a project has been cancelled (user navigated away)
     */
    isProjectCancelled(projectId) {
        return this.cancelledProjects.has(projectId);
    }
    /**
     * Clear cancelled status for a project (when user returns and reinitializes)
     */
    clearCancelledStatus(projectId) {
        this.cancelledProjects.delete(projectId);
    }
    /**
     * Cleanup project queue when user navigates away
     * This clears in-memory queues AND marks project as cancelled to abort in-flight submissions
     * Jobs remain in QUEUED/PROCESSING state in DB so they can be resumed later
     */
    async cleanupProjectQueue(projectId) {
        logger.info(`[GenNormal] Cleaning up in-memory queue for project`, { projectId });
        // Mark project as cancelled to abort any in-flight submissions
        this.cancelledProjects.add(projectId);
        logger.info(`[GenNormal] 🚫 Project marked as cancelled - in-flight submissions will be aborted`, { projectId });
        let clearedQueuedCount = 0;
        let clearedRunningCount = 0;
        let clearedSubmissionCount = 0;
        for (const [profileId, queue] of this.profileQueues) {
            // Clear queued jobs from in-memory queue
            const beforeQueuedCount = queue.queuedJobs.length;
            queue.queuedJobs = queue.queuedJobs.filter(job => job.projectId !== projectId);
            const afterQueuedCount = queue.queuedJobs.length;
            clearedQueuedCount += (beforeQueuedCount - afterQueuedCount);
            // Clear submission queue as well
            const beforeSubmissionCount = queue.submissionQueue.length;
            queue.submissionQueue = queue.submissionQueue.filter(job => job.projectId !== projectId);
            const afterSubmissionCount = queue.submissionQueue.length;
            clearedSubmissionCount += (beforeSubmissionCount - afterSubmissionCount);
            // Check running jobs and clear those belonging to this project
            const runningJobIds = Array.from(queue.runningJobs);
            for (const jobId of runningJobIds) {
                try {
                    const job = await prisma.genNormalJob.findUnique({
                        where: { id: jobId },
                        select: { projectId: true }
                    });
                    if (job && job.projectId === projectId) {
                        queue.runningJobs.delete(jobId);
                        clearedRunningCount++;
                    }
                }
                catch (error) {
                    // Job might have been deleted, just remove from running set
                    queue.runningJobs.delete(jobId);
                }
            }
        }
        logger.info(`[GenNormal] ✅ Cleaned up in-memory queue for project`, {
            projectId,
            clearedQueuedCount,
            clearedRunningCount,
            clearedSubmissionCount
        });
        return {
            success: true,
            clearedQueuedCount,
            clearedRunningCount,
            clearedSubmissionCount
        };
    }
    /**
     * Restore queue state from database on server startup
     * This handles "Exit and Re-enter" persistence
     */
    async restoreState() {
        logger.info('[GenNormal] 🔄 Restoring queue state from database...');
        try {
            // 1. Cancel interrupted PROCESSING jobs (no providerJobId = never submitted to Google)
            const interruptedJobs = await prisma.genNormalJob.updateMany({
                where: {
                    status: 'PROCESSING',
                    providerJobId: null
                },
                data: {
                    status: 'CANCELLED',
                    completedAt: new Date(),
                    error: 'Cancelled: interrupted by app shutdown'
                }
            });
            if (interruptedJobs.count > 0) {
                logger.warn(`[GenNormal] Cancelled ${interruptedJobs.count} interrupted jobs (PROCESSING but no providerJobId)`);
            }
            // 2. Cancel orphaned QUEUED jobs (leftover from previous session)
            // These should NOT auto-restore — user must explicitly start them
            const orphanedQueued = await prisma.genNormalJob.updateMany({
                where: {
                    status: 'QUEUED'
                },
                data: {
                    status: 'CANCELLED',
                    completedAt: new Date(),
                    error: 'Cancelled: leftover from previous session'
                }
            });
            if (orphanedQueued.count > 0) {
                logger.warn(`[GenNormal] Cancelled ${orphanedQueued.count} orphaned QUEUED jobs from previous session`);
            }
            // 3. Cancel orphaned upsampling queue jobs
            const orphanedQueueJobs = await prisma.queueJob.updateMany({
                where: {
                    type: { in: ['video-upsampling', 'image-upsampling'] },
                    status: { in: ['queued', 'processing'] }
                },
                data: {
                    status: 'cancelled',
                    completedAt: new Date()
                }
            });
            if (orphanedQueueJobs.count > 0) {
                logger.warn(`[GenNormal] Cancelled ${orphanedQueueJobs.count} orphaned upsampling queue jobs`);
            }
            // NOTE: PROCESSING jobs WITH providerJobId are left as-is
            // The Poller will pick them up and check their status with Google API
            logger.info('[GenNormal] No queued jobs to restore.');
        }
        catch (error) {
            logger.error(`[GenNormal] ❌ Failed to restore state:`, error);
        }
    }
}
export const genNormalQueueManager = new GenNormalQueueManager();
