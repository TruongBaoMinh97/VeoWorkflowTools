import { IntegrationError, PromptModelGatewayContract } from '../../contracts/integration.js';
import { appSettingService } from '../../modules/appSettings/appSetting.service.js';

const API_BASE_URL = 'https://platform.beeknoee.com/v1';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function normalizeContent(value) {
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value)) {
        return value
            .map((part) => typeof part === 'string' ? part : part?.text ?? '')
            .join('');
    }
    return '';
}

async function readError(response) {
    const text = await response.text().catch(() => '');
    try {
        const parsed = JSON.parse(text);
        return parsed?.error?.message ?? parsed?.message ?? text.slice(0, 500);
    }
    catch {
        return text.slice(0, 500) || response.statusText;
    }
}

async function readStreamingContent(response) {
    if (!response.body)
        throw new IntegrationError('AI_PROMPT_STREAM_EMPTY', 'Beeknoee returned an empty stream', { retryable: true });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let truncated = false;
    let streamError = null;

    const consumeLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:'))
            return false;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]')
            return payload === '[DONE]';
        try {
            const event = JSON.parse(payload);
            if (event.error) streamError = event.error.message || 'AI stream failed';
            const choice = event?.choices?.[0];
            if (choice?.finish_reason === 'length') truncated = true;
            content += normalizeContent(choice?.delta?.content ?? choice?.message?.content);
        }
        catch {
            // Ignore heartbeat or provider-specific SSE metadata lines.
        }
        return false;
    };

    let done = false;
    while (!done) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
            if (consumeLine(line)) {
                done = true;
                break;
            }
        }
        if (chunk.done)
            break;
    }
    if (buffer)
        consumeLine(buffer);
    if (streamError) throw new IntegrationError('AI_PROMPT_STREAM_ERROR', streamError, { retryable: false });
    if (truncated) throw new IntegrationError('AI_PROMPT_TRUNCATED', 'Prompt bị cắt. Tăng Max tokens trước khi chạy lại.', { retryable: false });
    return content.trim();
}

export class BeeknoeePromptClient extends PromptModelGatewayContract {
    constructor(options = {}) {
        super();
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.getApiKey = options.getApiKey ?? (async () => (
            process.env.BEEKNOEE_API_KEY?.trim() || await appSettingService.getValue('beeknoee_api_key')
        ));
        this.baseUrl = options.baseUrl ?? API_BASE_URL;
    }

    async resolveApiKey() {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new IntegrationError(
                'BEEKNOEE_API_KEY_MISSING',
                'Chưa cấu hình Beeknoee API key cho node AI Gen Prompt.',
                { retryable: false },
            );
        }
        return apiKey;
    }

    async complete(input) {
        const apiKey = await this.resolveApiKey();
        const stream = input.stream !== false;
        const body = {
            model: input.model,
            messages: input.messages,
            max_tokens: input.maxTokens ?? 1000,
            stream,
        };
        if (input.temperature !== undefined)
            body.temperature = input.temperature;
        if (input.mediaResolution)
            body.media_resolution = input.mediaResolution;
        if (input.thinkingLevel)
            body.thinking_level = input.thinkingLevel;

        let response;
        try {
            response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
            });
        }
        catch (cause) {
            throw new IntegrationError(
                'AI_PROMPT_NETWORK_ERROR',
                `Không kết nối được Beeknoee: ${cause instanceof Error ? cause.message : String(cause)}`,
                { retryable: true, cause },
            );
        }

        if (!response.ok) {
            const message = await readError(response);
            throw new IntegrationError(
                `AI_PROMPT_HTTP_${response.status}`,
                `Beeknoee trả về HTTP ${response.status}: ${message}`,
                { retryable: response.status === 408 || response.status === 429 || response.status >= 500 },
            );
        }

        let content;
        if (stream) {
            content = await readStreamingContent(response);
        }
        else {
            const payload = await response.json();
            if (payload?.choices?.[0]?.finish_reason === 'length')
                throw new IntegrationError('AI_PROMPT_TRUNCATED', 'Prompt bị cắt. Tăng Max tokens trước khi chạy lại.', { retryable: false });
            content = normalizeContent(payload?.choices?.[0]?.message?.content).trim();
        }
        if (!content) {
            throw new IntegrationError('AI_PROMPT_EMPTY_RESPONSE', 'Beeknoee không trả về nội dung prompt.', {
                retryable: true,
            });
        }
        return content;
    }

    async listModels() {
        const apiKey = await this.resolveApiKey();
        const response = await this.fetchImpl(`${this.baseUrl}/models`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) {
            throw new IntegrationError(
                `AI_MODELS_HTTP_${response.status}`,
                `Không lấy được danh sách model: ${await readError(response)}`,
                { retryable: response.status === 429 || response.status >= 500 },
            );
        }
        const payload = await response.json();
        const rows = Array.isArray(payload) ? payload : payload?.data ?? payload?.models ?? [];
        return rows
            .map((item) => item?.providerModelId ?? item?.id ?? item?.model)
            .filter((id) => typeof id === 'string' && id.length > 0);
    }
}

export const beeknoeePromptClient = new BeeknoeePromptClient();
