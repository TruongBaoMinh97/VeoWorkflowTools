/**
 * Gemini Official API Service
 * Uses @google/genai SDK for direct API access
 * Supports text generation with streaming, image analysis
 *
 * Auto-fallback: gemini-2.5-flash (20 RPD) → gemini-2.5-flash-lite (500 RPD)
 * Tracks daily usage per model, auto-switches when quota exhausted
 */
import { GoogleGenAI } from '@google/genai';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
// Model priority chain: best quality first, fallback to high-quota model
const MODEL_CHAIN = [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', rpd: 20, rpm: 5 },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', rpd: 500, rpm: 15 },
];
const DEFAULT_MODEL = MODEL_CHAIN[0].id;
const FALLBACK_MODEL = MODEL_CHAIN[1].id;
// Available models for UI display
export const AVAILABLE_MODELS = [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', rpm: 5, rpd: 20, tpm: 250000, description: 'Mạnh nhất, suy luận tốt (mặc định)' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', rpm: 15, rpd: 500, tpm: 250000, description: 'Nhanh, 500 req/ngày (auto-fallback)' },
];
class GeminiApiService {
    constructor() {
        this.client = null;
        this.apiKey = null;
        this.dailyUsage = { date: '', counts: {} };
    }
    getClient(apiKey) {
        if (this.client && this.apiKey === apiKey) {
            return this.client;
        }
        this.client = new GoogleGenAI({ apiKey });
        this.apiKey = apiKey;
        return this.client;
    }
    /**
     * Get today's date string for usage tracking
     */
    getToday() {
        return new Date().toISOString().split('T')[0];
    }
    /**
     * Load daily usage from database
     */
    async loadDailyUsage() {
        const today = this.getToday();
        if (this.dailyUsage.date === today)
            return; // Already loaded for today
        try {
            const setting = await prisma.appSetting.findUnique({
                where: { key: 'gemini_daily_usage' }
            });
            if (setting?.value) {
                const saved = JSON.parse(setting.value);
                if (saved.date === today) {
                    this.dailyUsage = saved;
                    return;
                }
            }
        }
        catch {
            // Ignore parse errors
        }
        // New day or no data → reset
        this.dailyUsage = { date: today, counts: {} };
    }
    /**
     * Save daily usage to database
     */
    async saveDailyUsage() {
        try {
            await prisma.appSetting.upsert({
                where: { key: 'gemini_daily_usage' },
                update: { value: JSON.stringify(this.dailyUsage) },
                create: { key: 'gemini_daily_usage', value: JSON.stringify(this.dailyUsage) }
            });
        }
        catch {
            // Non-critical, usage tracking is best-effort
        }
    }
    /**
     * Record a request for a model
     */
    async recordUsage(modelId) {
        await this.loadDailyUsage();
        this.dailyUsage.counts[modelId] = (this.dailyUsage.counts[modelId] || 0) + 1;
        await this.saveDailyUsage();
    }
    /**
     * Get the best available model based on daily usage
     * Returns DEFAULT_MODEL if under quota, FALLBACK_MODEL if exhausted
     */
    async pickModel(requestedModel) {
        // If user explicitly requested a model, use it
        if (requestedModel && requestedModel !== DEFAULT_MODEL) {
            return requestedModel;
        }
        await this.loadDailyUsage();
        // Check each model in priority chain
        for (const model of MODEL_CHAIN) {
            const used = this.dailyUsage.counts[model.id] || 0;
            if (used < model.rpd) {
                if (model.id !== DEFAULT_MODEL && used === 0) {
                    logger.info(`[GeminiApi] Auto-switched to ${model.name} (${DEFAULT_MODEL} quota exhausted: ${this.dailyUsage.counts[DEFAULT_MODEL] || 0}/${MODEL_CHAIN[0].rpd})`);
                }
                return model.id;
            }
        }
        // All models exhausted — still try fallback (server may have higher limits)
        logger.warn(`[GeminiApi] All model quotas exhausted for today. Trying ${FALLBACK_MODEL} anyway.`);
        return FALLBACK_MODEL;
    }
    /**
     * Get current usage stats
     */
    async getUsageStats() {
        await this.loadDailyUsage();
        return {
            date: this.dailyUsage.date || this.getToday(),
            models: MODEL_CHAIN.map(m => ({
                id: m.id,
                name: m.name,
                used: this.dailyUsage.counts[m.id] || 0,
                limit: m.rpd,
            }))
        };
    }
    async getApiKey() {
        if (process.env.GEMINI_API_KEY) {
            return process.env.GEMINI_API_KEY;
        }
        try {
            const setting = await prisma.appSetting.findUnique({
                where: { key: 'gemini_api_key' }
            });
            if (setting?.value)
                return setting.value;
        }
        catch { /* ignore */ }
        return null;
    }
    async saveApiKey(apiKey) {
        await prisma.appSetting.upsert({
            where: { key: 'gemini_api_key' },
            update: { value: apiKey },
            create: { key: 'gemini_api_key', value: apiKey }
        });
        this.client = null;
        this.apiKey = null;
    }
    async validateApiKey(apiKey) {
        try {
            const client = new GoogleGenAI({ apiKey });
            const response = await client.models.generateContent({
                model: DEFAULT_MODEL,
                contents: 'Say "OK" in one word.',
            });
            return { valid: !!response.text };
        }
        catch (error) {
            return { valid: false, error: error.message };
        }
    }
    /**
     * Generate content — auto-picks model and falls back on 429
     */
    async generate(options) {
        const { prompt, model: requestedModel, base64Images, fileUri, videoMetadata, responseJsonSchema, systemInstruction, maxTokens } = options;
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            return { success: false, error: 'Chưa cấu hình Gemini API Key. Vào Cài đặt để thêm.' };
        }
        // Pick best available model
        const model = await this.pickModel(requestedModel);
        try {
            const client = this.getClient(apiKey);
            // Build content parts (video/images first, text last per Google docs)
            const parts = [];
            // Support fileUri (YouTube URLs, Google Cloud Storage, etc.)
            if (fileUri) {
                const filePart = {
                    fileData: {
                        fileUri,
                        mimeType: 'video/*',
                    },
                };
                // Add videoMetadata for time-range analysis or custom FPS
                if (videoMetadata) {
                    if (videoMetadata.startOffset)
                        filePart.videoMetadata = { ...filePart.videoMetadata, startOffset: videoMetadata.startOffset };
                    if (videoMetadata.endOffset)
                        filePart.videoMetadata = { ...filePart.videoMetadata, endOffset: videoMetadata.endOffset };
                    if (videoMetadata.fps)
                        filePart.videoMetadata = { ...filePart.videoMetadata, fps: videoMetadata.fps };
                }
                parts.push(filePart);
                logger.info('[GeminiApi] Using fileData', { fileUri: fileUri.substring(0, 60), videoMetadata });
            }
            if (base64Images && base64Images.length > 0) {
                for (const base64 of base64Images) {
                    const match = base64.match(/^data:([^;]+);base64,(.+)$/);
                    if (match) {
                        parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
                    }
                }
            }
            // Text prompt goes AFTER media per Google docs
            parts.push({ text: prompt });
            const config = {};
            if (maxTokens)
                config.maxOutputTokens = maxTokens;
            if (systemInstruction)
                config.systemInstruction = systemInstruction;
            // Structured output: force valid JSON response matching schema
            if (responseJsonSchema) {
                config.responseMimeType = 'application/json';
                config.responseJsonSchema = responseJsonSchema;
                logger.info('[GeminiApi] Using structured JSON output');
            }
            const response = await client.models.generateContent({
                model,
                contents: parts.length === 1 ? prompt : [{ role: 'user', parts }],
                config,
            });
            const text = response.text;
            if (!text) {
                return { success: false, error: 'Gemini không trả về nội dung. Có thể prompt vi phạm chính sách.', model };
            }
            // Record successful usage
            await this.recordUsage(model);
            logger.info(`[GeminiApi] ✅ Generated with ${model} (${(this.dailyUsage.counts[model] || 0)}/${MODEL_CHAIN.find(m => m.id === model)?.rpd || '?'} today)`);
            return { success: true, text, model };
        }
        catch (error) {
            const errMsg = error.message || '';
            // 429 / RESOURCE_EXHAUSTED → could be RPM (per-minute) or RPD (per-day)
            if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
                // Try fallback model if we're on primary
                if (model !== FALLBACK_MODEL) {
                    // Mark primary as exhausted for today
                    const modelInfo = MODEL_CHAIN.find(m => m.id === model);
                    if (modelInfo) {
                        this.dailyUsage.counts[model] = modelInfo.rpd;
                        await this.saveDailyUsage();
                    }
                    logger.info(`[GeminiApi] 🔄 ${model} rate limited, falling back to ${FALLBACK_MODEL}`);
                    return this.generate({ ...options, model: FALLBACK_MODEL });
                }
                // Fallback model hit 429 — likely RPM limit (not RPD).
                // Wait and retry once instead of marking as fully exhausted.
                const retryAttempt = options._retryCount || 0;
                if (retryAttempt < 2) {
                    const waitSec = 15 + retryAttempt * 10; // 15s, 25s
                    logger.info(`[GeminiApi] ⏳ ${model} RPM limited, waiting ${waitSec}s before retry (attempt ${retryAttempt + 1}/2)`);
                    await new Promise(r => setTimeout(r, waitSec * 1000));
                    return this.generate({ ...options, model: FALLBACK_MODEL, _retryCount: retryAttempt + 1 });
                }
                // After 2 retries, mark as exhausted
                const fallbackInfo = MODEL_CHAIN.find(m => m.id === FALLBACK_MODEL);
                if (fallbackInfo) {
                    this.dailyUsage.counts[FALLBACK_MODEL] = fallbackInfo.rpd;
                    await this.saveDailyUsage();
                }
                return { success: false, error: 'Đã hết hạn mức tất cả models miễn phí trong ngày. Vui lòng thử lại ngày mai.', model };
            }
            // 503 / UNAVAILABLE → model overloaded, try fallback then retry with backoff
            if (errMsg.includes('503') || errMsg.includes('UNAVAILABLE') || errMsg.includes('overloaded')) {
                if (model !== FALLBACK_MODEL) {
                    logger.info(`[GeminiApi] 🔄 ${model} overloaded (503), falling back to ${FALLBACK_MODEL}`);
                    return this.generate({ ...options, model: FALLBACK_MODEL });
                }
                const retryAttempt = options._retryCount || 0;
                if (retryAttempt < 3) {
                    const waitSec = 5 * Math.pow(2, retryAttempt); // 5s, 10s, 20s
                    logger.info(`[GeminiApi] ⏳ ${model} overloaded, waiting ${waitSec}s before retry (attempt ${retryAttempt + 1}/3)`);
                    await new Promise(r => setTimeout(r, waitSec * 1000));
                    return this.generate({ ...options, model: FALLBACK_MODEL, _retryCount: retryAttempt + 1 });
                }
                return { success: false, error: 'Gemini đang quá tải. Vui lòng thử lại sau vài phút.', model };
            }
            if (errMsg.includes('403') || errMsg.includes('PERMISSION_DENIED')) {
                return { success: false, error: 'API Key không hợp lệ hoặc không có quyền truy cập.', model };
            }
            if (errMsg.includes('400') || errMsg.includes('INVALID_ARGUMENT')) {
                return { success: false, error: 'Yêu cầu không hợp lệ. Kiểm tra lại prompt hoặc hình ảnh.', model };
            }
            logger.error('[GeminiApi] Generate error:', { error: errMsg, model });
            return { success: false, error: errMsg, model };
        }
    }
    /**
     * Generate content with streaming — auto-picks model and falls back on 429
     */
    async generateStream(options, onChunk) {
        const { prompt, model: requestedModel, base64Images, systemInstruction, maxTokens } = options;
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            return { success: false, error: 'Chưa cấu hình Gemini API Key.' };
        }
        const model = await this.pickModel(requestedModel);
        try {
            const client = this.getClient(apiKey);
            const parts = [];
            if (base64Images && base64Images.length > 0) {
                for (const base64 of base64Images) {
                    const match = base64.match(/^data:([^;]+);base64,(.+)$/);
                    if (match) {
                        parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
                    }
                }
            }
            parts.push({ text: prompt });
            const config = {};
            if (maxTokens)
                config.maxOutputTokens = maxTokens;
            if (systemInstruction)
                config.systemInstruction = systemInstruction;
            const response = await client.models.generateContentStream({
                model,
                contents: parts.length === 1 ? prompt : [{ role: 'user', parts }],
                config,
            });
            let fullText = '';
            for await (const chunk of response) {
                const chunkText = chunk.text || '';
                fullText += chunkText;
                if (chunkText)
                    onChunk(chunkText);
            }
            if (!fullText) {
                return { success: false, error: 'Không nhận được phản hồi từ Gemini.', model };
            }
            await this.recordUsage(model);
            return { success: true, text: fullText, model };
        }
        catch (error) {
            const errMsg = error.message || '';
            if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
                const modelInfo = MODEL_CHAIN.find(m => m.id === model);
                if (modelInfo) {
                    this.dailyUsage.counts[model] = modelInfo.rpd;
                    await this.saveDailyUsage();
                }
                if (model !== FALLBACK_MODEL) {
                    logger.info(`[GeminiApi] 🔄 Stream: ${model} rate limited, falling back to ${FALLBACK_MODEL}`);
                    return this.generateStream({ ...options, model: FALLBACK_MODEL }, onChunk);
                }
                return { success: false, error: 'Đã hết hạn mức tất cả models trong ngày.', model };
            }
            if (errMsg.includes('503') || errMsg.includes('UNAVAILABLE') || errMsg.includes('overloaded')) {
                if (model !== FALLBACK_MODEL) {
                    logger.info(`[GeminiApi] 🔄 Stream: ${model} overloaded (503), falling back to ${FALLBACK_MODEL}`);
                    return this.generateStream({ ...options, model: FALLBACK_MODEL }, onChunk);
                }
                const retryAttempt = options._retryCount || 0;
                if (retryAttempt < 3) {
                    const waitSec = 5 * Math.pow(2, retryAttempt);
                    logger.info(`[GeminiApi] ⏳ Stream: ${model} overloaded, waiting ${waitSec}s (retry ${retryAttempt + 1}/3)`);
                    await new Promise(r => setTimeout(r, waitSec * 1000));
                    return this.generateStream({ ...options, model: FALLBACK_MODEL, _retryCount: retryAttempt + 1 }, onChunk);
                }
                return { success: false, error: 'Gemini đang quá tải. Vui lòng thử lại sau vài phút.', model };
            }
            logger.error('[GeminiApi] Stream error:', { error: errMsg, model });
            return { success: false, error: errMsg, model };
        }
    }
}
export const geminiApiService = new GeminiApiService();
