import { NonRetryableNodeError } from '../engine/WorkflowNodeError.js';

export const IMAGE_FALLBACK_MODELS = ['GEM_PIX_2', 'BELUGA', 'HARBOR_SEAL'];
export const IMAGE_MODEL_LABELS = { GEM_PIX_2: 'Nano Banana Pro', BELUGA: 'Nano Banana 2.1', HARBOR_SEAL: 'Nano Banana 2 Lite' };
// A process-local cooldown, not a claim about the provider's reset time.
export const imageQuotaCooldowns = new Map();
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
export function isImageModelDailyQuota(error) {
    const text = [error?.reason, error?.errorText, error?.message].map(v => typeof v === 'object' ? JSON.stringify(v) : v ?? '').join(' ');
    return /\bPUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED\b/.test(text);
}
export function imageModelOrder(primary, enabled = true, configured) {
    const models = enabled ? [primary, ...(Array.isArray(configured) ? configured : IMAGE_FALLBACK_MODELS)] : [primary];
    return [...new Set(models.filter(model => IMAGE_FALLBACK_MODELS.includes(model)))];
}

export async function generateWithImageQuotaFallback({ profileId, primary, enabled = true, models, generate,
    isCancelled = () => false, onModel = async () => {}, cooldowns = imageQuotaCooldowns, now = Date.now }) {
    const history = [];
    for (const model of imageModelOrder(primary, enabled, models)) {
        if (isCancelled()) throw new Error('Run was cancelled');
        const key = JSON.stringify([profileId, model]);
        const blocked = () => {
            const until = cooldowns.get(key);
            if (until > now()) return true;
            cooldowns.delete(key);
            return false;
        };
        if (blocked()) { history.push({ model, reason: 'cached_daily_quota' }); continue; }
        const notice = history.length ? `${history.map(h => IMAGE_MODEL_LABELS[h.model]).join(', ')} hết quota → ${IMAGE_MODEL_LABELS[model]}` : '';
        await onModel({ actualImageModel: model, quotaFallbackHistory: [...history], quotaFallbackNotice: notice });
        try {
            // Check again inside the submission queue: another concurrent job may
            // have discovered quota while this job waited for its launch slot.
            const value = await generate(model, blocked);
            return { value, actualImageModel: model, quotaFallbackHistory: history, quotaFallbackNotice: notice };
        } catch (error) {
            if (isCancelled() || !isImageModelDailyQuota(error)) throw error;
            cooldowns.set(key, now() + COOLDOWN_MS);
            history.push({ model, reason: 'PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED' });
        }
    }
    throw new NonRetryableNodeError(`Hết quota các model ảnh đã chọn: ${history.map(h => IMAGE_MODEL_LABELS[h.model]).join(', ')}. Chờ quota reset hoặc chọn profile khác.`, { code: 'IMAGE_MODELS_QUOTA_EXHAUSTED' });
}
