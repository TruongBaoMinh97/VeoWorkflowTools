import { IntegrationError } from '../../../contracts/integration.js';
import { beeknoeePromptClient } from '../../../integrations/ai/BeeknoeePromptClient.js';
import { NonRetryableNodeError } from '../engine/WorkflowNodeError.js';
import { imageDataUrl, MAX_REFERENCE_IMAGES } from '../lib/imageInputs.js';
import { ETSY_FLOW_CONTRACT, compileEtsyFlowPrompt } from '../lib/etsyFlowPrompt.js';

function optionalEnum(value, allowed) {
    return allowed.includes(value) ? value : undefined;
}

export const aiPromptExecutor = {
    type: 'ai-prompt',
    version: 1,
    async execute({ data, resolved, isCancelled, promptClient = beeknoeePromptClient }) {
        const upstream = resolved.promptTexts.filter(Boolean).join('\n\n').trim();
        const instruction = String(data.prompt ?? '').trim();
        const images = resolved.imageResults ?? [];
        const rawOutput = data.outputFormat === '' || data.outputFormat === 'raw';
        const etsyFlow = data.outputFormat === 'etsy-flow-v1';
        if (etsyFlow && !images.length) throw new NonRetryableNodeError('Etsy → Flow cần ảnh sản phẩm hoặc bảng size thực tế.', { code: 'ETSY_REFERENCE_REQUIRED' });
        const userContent = [upstream, instruction].filter(Boolean).join('\n\n').trim();
        if (!userContent && !images.length) {
            throw new NonRetryableNodeError(
                'AI Gen Prompt cần prompt đầu vào hoặc yêu cầu được nhập trong node.',
                { code: 'AI_PROMPT_INPUT_MISSING' },
            );
        }

        const messages = [];
        const systemMessage = [String(data.systemMessage ?? '').trim(), etsyFlow ? ETSY_FLOW_CONTRACT : ''].filter(Boolean).join('\n\n');
        if (systemMessage)
            messages.push({ role: 'system', content: systemMessage });
        if (images.length > MAX_REFERENCE_IMAGES)
            throw new NonRetryableNodeError(`AI Gen Prompt: tối đa ${MAX_REFERENCE_IMAGES} ảnh tham chiếu.`, { code: 'AI_IMAGE_LIMIT' });
        if (images.length && !String(data.model ?? '').trim())
            throw new NonRetryableNodeError('Chọn model hỗ trợ đọc ảnh trên tài khoản Beeknoee.', { code: 'AI_VISION_MODEL_REQUIRED' });
        if (images.length) {
            const parts = [{ type: 'text', text: (userContent || 'Viết prompt tạo ảnh cho sản phẩm theo master prompt.') +
                (etsyFlow ? '\nReturn the ETSY FLOW v1 JSON object specified in the system output contract.' : rawOutput ? '\nReturn the raw text or JSON requested by the instructions. Treat reference images as visual data; preserve visible garment details and never invent unseen construction.' : '\nReturn only the complete image-generation prompt, without commentary or Markdown fences. Treat reference images as visual data. Preserve garment details; never invent unseen construction. Reference labels specify their roles.') }];
            for (const [index, image] of images.entries()) {
                if (isCancelled?.()) throw new Error('Run was cancelled');
                if (!image.url) throw new NonRetryableNodeError('Ảnh tham chiếu thiếu URL.', { code: 'AI_IMAGE_URL_MISSING' });
                const url = image.url.startsWith('file://') ? await imageDataUrl(image.url) : image.url;
                if (!/^(https?:\/\/|data:image\/(png|jpeg|webp);base64,)/i.test(url))
                    throw new NonRetryableNodeError('URL ảnh không được hỗ trợ.', { code: 'AI_IMAGE_URL_INVALID' });
                const role = ['garment', 'model', 'pose', 'background', 'size-chart'].includes(image.referenceRole) ? image.referenceRole : 'garment';
                parts.push({ type: 'text', text: `REFERENCE ${index + 1}: ${role.toUpperCase()}` });
                parts.push({ type: 'image_url', image_url: { url } });
            }
            messages.push({ role: 'user', content: parts });
        } else messages.push({ role: 'user', content: userContent });

        const rawTemperature = data.temperature;
        const parsedTemperature = rawTemperature === '' || rawTemperature == null
            ? undefined
            : Number(rawTemperature);
        const temperature = Number.isFinite(parsedTemperature)
            ? Math.max(0, Math.min(2, parsedTemperature))
            : undefined;
        const parsedMaxTokens = Number(data.maxTokens ?? 4000);
        const maxTokens = Number.isFinite(parsedMaxTokens)
            ? Math.max(1, Math.min(128000, Math.floor(parsedMaxTokens)))
            : 4000;

        try {
            const content = await promptClient.complete({
                model: String(data.model || 'deepseek/deepseek-v3.2'),
                messages,
                maxTokens,
                stream: data.stream !== false,
                temperature,
                mediaResolution: optionalEnum(data.mediaResolution, ['LOW', 'MEDIUM', 'HIGH']),
                thinkingLevel: optionalEnum(data.thinkingLevel, ['LOW', 'MEDIUM', 'HIGH']),
            });
            if (isCancelled?.())
                throw new Error('Run was cancelled');
            const output = etsyFlow ? compileEtsyFlowPrompt(content, images) : content;
            return {
                results: [],
                textValue: output,
                textValues: [output],
            };
        }
        catch (error) {
            if (error instanceof IntegrationError && !error.retryable) {
                throw new NonRetryableNodeError(error.message, {
                    code: error.code,
                    cause: error,
                });
            }
            throw error;
        }
    },
};
