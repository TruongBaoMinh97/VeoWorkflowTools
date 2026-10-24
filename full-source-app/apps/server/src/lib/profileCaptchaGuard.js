/**
 * Trạng thái 403 reCAPTCHA theo profile — dùng chung cho mọi luồng chạm Google Flow.
 *
 * Bối cảnh: gen-normal đã tích luỹ cả một tầng phòng vệ 403 qua nhiều sự cố thật
 * (đếm lỗi liên tiếp, cửa sổ trượt 5 phút, cooldown, reset session, reset điểm
 * captcha). Luồng workflow thì không có gì — `grep "403|isRecaptchaFailure|
 * UNUSUAL_ACTIVITY"` trong `workflow.engine.ts` ra 0 kết quả — nên nó retry sau
 * 2s trên đúng session vừa bị Google đánh dấu, và không bao giờ báo cho
 * `captchaManager` biết để kích hoạt `hard_reset`.
 *
 * Module này CỐ Ý không biết gì về job/node/batch/queue, để cả hai luồng dùng
 * được mà không kéo theo mô hình thực thi của nhau. Nó chỉ quyết định "chờ bao
 * lâu" và "có cần reset gì không"; việc gọi `captchaManager` / `sessionIdManager`
 * do caller làm, nhờ vậy module này test được mà không cần mock hai singleton.
 *
 * Các hằng số bên dưới lấy nguyên từ gen-normal (`genNormalQueueManager.ts`),
 * không phải con số mới bịa ra.
 */
import { logger } from './logger.js';
/** Sau 3 lần đầu, chờ lâu hơn hẳn (gen-normal `getEscalatingDelay`). */
const SILENT_RETRY_MAX_FAILURES = 3;
/**
 * 2s cho các lần 403 đầu. An toàn vì ở chế độ CDP, `hard_reset` được áp INLINE
 * ngay trước lần mint kế tiếp (`captchaManager.mintViaCdp` → `consumePendingReset`
 * → `await cdpReset`), nên lần thử lại đã có anchor mới + tab Flow vừa tải lại.
 * Ghi đè bằng `VEO3_RECAPTCHA_SILENT_RETRY_DELAY_SEC` — cùng biến môi trường
 * gen-normal đang dùng, để chỉnh một chỗ là cả hai luồng đổi theo.
 */
function silentRetryMs() {
    const raw = process.env.VEO3_RECAPTCHA_SILENT_RETRY_DELAY_SEC;
    if (raw == null || raw === '')
        return 2000;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0)
        return 2000;
    return Math.floor(parsed) * 1000;
}
/** 20–30s ngẫu nhiên (gen-normal `getEscalatingDelay`). */
function escalatedRetryMs() {
    return (20 + Math.floor(Math.random() * 11)) * 1000;
}
const SLIDING_WINDOW_MS = 5 * 60 * 1000;
const SLIDING_WINDOW_THRESHOLD = 3;
const SLIDING_WINDOW_PENALTY_MS = 120 * 1000;
/** Khoảng lặng tối thiểu sau mỗi 403 trước khi profile được submit tiếp. */
const POST_403_COOLDOWN_MS = 15000;
/**
 * Nhiều lane cùng dính 403 sẽ cùng đòi reset. Cooldown này khiến mỗi profile chỉ
 * chạy một lượt reset nặng trong 45s, tránh churn tab Chrome (gen-normal
 * `PROFILE_RECOVERY_COOLDOWN_MS`).
 */
const RECOVERY_COOLDOWN_MS = Number(process.env.RECAPTCHA_RECOVERY_COOLDOWN_MS) || 45000;
/** Quá ngưỡng này thì ngừng đốt lượt vào profile, nhường cho profile khác. */
const ABANDON_THRESHOLD = 8;
/**
 * 429 `PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC` là trần tốc độ TẠM THỜI của
 * tài khoản, tự khỏi sau vài phút — KHÔNG phải quota ngày. Nghỉ leo thang theo số
 * lần dính liên tiếp (khớp gen-normal `TRAFFIC_LIMIT_BACKOFF_SEC`).
 */
const TRAFFIC_LIMIT_BACKOFF_MS = [120000, 300000, 600000];
function envMs(name, fallback) {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}
/**
 * Khoảng nghỉ giữa hai lần chạm Google Flow của cùng profile. Bốn lane vẫn có
 * thể chuẩn bị song song, nhưng captcha/upload/generate phải lần lượt lấy khe
 * 7–10 giây để không mint token dồn dập.
 */
export const MIN_RECAPTCHA_GAP_MS = envMs('WORKFLOW_RECAPTCHA_GAP_MIN_MS', 7000);
export const MAX_RECAPTCHA_GAP_MS = Math.max(MIN_RECAPTCHA_GAP_MS, envMs('WORKFLOW_RECAPTCHA_GAP_MAX_MS', 10000));
/** VIDEO có ảnh đầu vào cần khoảng cách rộng hơn. */
export const MIN_RECAPTCHA_GAP_VIDEO_REF_MS = Math.max(MIN_RECAPTCHA_GAP_MS, envMs('WORKFLOW_RECAPTCHA_VIDEO_GAP_MS', 12000));
/** Sinh khoảng nghỉ mới cho từng khe để tránh nhịp request đều máy móc. */
export function nextRecaptchaGapMs(nodeType = 'image') {
    if (nodeType === 'video')
        return MIN_RECAPTCHA_GAP_VIDEO_REF_MS;
    if (MAX_RECAPTCHA_GAP_MS === MIN_RECAPTCHA_GAP_MS)
        return MIN_RECAPTCHA_GAP_MS;
    return MIN_RECAPTCHA_GAP_MS
        + Math.floor(Math.random() * (MAX_RECAPTCHA_GAP_MS - MIN_RECAPTCHA_GAP_MS + 1));
}
/** Khoảng cách nhẹ cho upload/các thao tác phụ bên trong Batch kiểu Veo3 Gen. */
export const BATCH_RECAPTCHA_GAP_MS = 1000;
function emptyState() {
    return {
        failures: 0,
        timestamps: [],
        blockedUntil: 0,
        trafficBlockedUntil: 0,
        trafficStrikes: 0,
        recoveryCooldownUntil: 0,
        lastFailureAt: null,
        nextSubmitAt: 0,
    };
}
class ProfileCaptchaGuard {
    constructor() {
        this.states = new Map();
    }
    stateOf(profileId) {
        let s = this.states.get(profileId);
        if (!s) {
            s = emptyState();
            this.states.set(profileId, s);
        }
        return s;
    }
    /**
     * Số ms phải chờ trước khi profile được phép submit tiếp — gộp cả hình phạt
     * 403 lẫn khoảng giãn nhịp thông thường.
     *
     * Cập nhật `nextSubmitAt` ĐỒNG BỘ trước khi trả về, nên nhiều lane gọi song
     * song sẽ nhận các khe thời gian khác nhau thay vì cùng lao đi một lúc.
     */
    reserveSlot(profileId, gapMs = MIN_RECAPTCHA_GAP_MS) {
        const s = this.stateOf(profileId);
        const now = Date.now();
        const earliest = Math.max(now, s.blockedUntil, s.trafficBlockedUntil, s.nextSubmitAt);
        s.nextSubmitAt = earliest + Math.max(0, gapMs);
        return earliest - now;
    }
    /** Ghi nhận thành công nhưng vẫn giữ các khe mà lane khác đã đặt trước. */
    onSuccess(profileId) {
        const s = this.states.get(profileId);
        if (!s)
            return;
        s.failures = 0;
        // A late success must not erase a concurrent rejection or its cooldown.
        s.timestamps = s.timestamps.filter(t => Date.now() - t < SLIDING_WINDOW_MS);
        // Không kéo nextSubmitAt về hiện tại: các lane chạy song song đã đặt khe
        // kế tiếp ở đây. Xoá lịch đó sau một lượt thành công sẽ khiến 3–4 request
        // còn lại cùng mint captcha ngay lập tức.
        // trafficBlockedUntil CỐ Ý không bị xoá — khoảng nghỉ 429 phải sống sót qua
        // lần thành công song song của lane khác. reserveSlot vẫn max với nó.
        s.trafficStrikes = 0;
        s.lastFailureAt = null;
    }
    /** Ghi nhận một lần 403 reCAPTCHA và quyết định phải làm gì tiếp. */
    onRecaptcha403(profileId) {
        const s = this.stateOf(profileId);
        const now = Date.now();
        const msSincePrevious = s.lastFailureAt === null ? null : now - s.lastFailureAt;
        s.failures += 1;
        s.lastFailureAt = now;
        s.timestamps = s.timestamps.filter((t) => now - t < SLIDING_WINDOW_MS);
        s.timestamps.push(now);
        const windowCount = s.timestamps.length;
        // Chỉ lượt gọi đầu trong mỗi chu kỳ cooldown mới thực sự reset — các lane
        // còn lại vẫn phải chờ, nhưng không churn thêm tab Chrome.
        const mayRecover = now >= s.recoveryCooldownUntil;
        if (mayRecover)
            s.recoveryCooldownUntil = now + RECOVERY_COOLDOWN_MS;
        if (s.failures >= ABANDON_THRESHOLD) {
            s.blockedUntil = now + SLIDING_WINDOW_PENALTY_MS;
            s.nextSubmitAt = Math.max(s.nextSubmitAt, s.blockedUntil);
            return {
                // `abandon` là LỜI KHUYÊN "nhường hàng đợi cho profile khác", KHÔNG phải
                // "bỏ luôn việc". Caller vẫn chờ rồi thử tiếp — nếu chỉ có một profile
                // thì bỏ hẳn nghĩa là mất việc, mà chờ thì vẫn còn cơ hội.
                action: 'abandon',
                waitMs: SLIDING_WINDOW_PENALTY_MS,
                resetScore: mayRecover,
                resetSession: mayRecover,
                failures: s.failures,
                windowCount,
                msSincePrevious,
                reason: `403 liên tiếp ${s.failures} lần — chờ dài, nhường lượt cho profile khác`,
            };
        }
        let waitMs = s.failures <= SILENT_RETRY_MAX_FAILURES ? silentRetryMs() : escalatedRetryMs();
        waitMs = Math.max(waitMs, POST_403_COOLDOWN_MS);
        let reason = `403 lần ${s.failures}`;
        if (windowCount >= SLIDING_WINDOW_THRESHOLD) {
            waitMs += SLIDING_WINDOW_PENALTY_MS;
            reason += ` · ${windowCount} lần trong 5 phút → phạt thêm ${SLIDING_WINDOW_PENALTY_MS / 1000}s`;
        }
        s.blockedUntil = now + waitMs;
        s.nextSubmitAt = Math.max(s.nextSubmitAt, s.blockedUntil);
        return {
            action: 'retry',
            waitMs,
            resetScore: mayRecover,
            resetSession: mayRecover,
            failures: s.failures,
            windowCount,
            msSincePrevious,
            reason,
        };
    }
    /**
     * 429 TOO_MUCH_TRAFFIC — trần tốc độ tạm thời. Reset trình duyệt vô ích, chỉ
     * cần nghỉ. Trả về số ms caller phải chờ trước khi thử lại.
     */
    onTrafficLimit(profileId) {
        const s = this.stateOf(profileId);
        s.trafficStrikes += 1;
        const idx = Math.min(s.trafficStrikes, TRAFFIC_LIMIT_BACKOFF_MS.length) - 1;
        const waitMs = TRAFFIC_LIMIT_BACKOFF_MS[idx];
        s.trafficBlockedUntil = Math.max(s.trafficBlockedUntil, Date.now() + waitMs);
        logger.warn(`[CaptchaGuard] profile ${profileId.slice(0, 8)} dính 429 TOO_MUCH_TRAFFIC lần ${s.trafficStrikes} — nghỉ ${waitMs / 1000}s`);
        return { waitMs, strikes: s.trafficStrikes };
    }
    /** Ảnh chụp trạng thái cho log chẩn đoán. Không đổi gì. */
    snapshot(profileId) {
        const s = this.states.get(profileId);
        const now = Date.now();
        if (!s)
            return { failures: 0, windowCount: 0, blockedForMs: 0, msSinceLast403: null };
        return {
            failures: s.failures,
            windowCount: s.timestamps.filter((t) => now - t < SLIDING_WINDOW_MS).length,
            blockedForMs: Math.max(0, s.blockedUntil - now, s.trafficBlockedUntil - now),
            msSinceLast403: s.lastFailureAt === null ? null : now - s.lastFailureAt,
        };
    }
    /** Chỉ dùng cho test. */
    reset(profileId) {
        if (profileId)
            this.states.delete(profileId);
        else
            this.states.clear();
    }
}
export const profileCaptchaGuard = new ProfileCaptchaGuard();
export const GUARD_LIMITS = {
    SILENT_RETRY_MAX_FAILURES,
    SLIDING_WINDOW_MS,
    SLIDING_WINDOW_THRESHOLD,
    SLIDING_WINDOW_PENALTY_MS,
    POST_403_COOLDOWN_MS,
    RECOVERY_COOLDOWN_MS,
    ABANDON_THRESHOLD,
    TRAFFIC_LIMIT_BACKOFF_MS,
};
