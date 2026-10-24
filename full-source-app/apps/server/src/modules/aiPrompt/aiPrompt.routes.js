import { z } from 'zod';
import { beeknoeePromptClient } from '../../integrations/ai/BeeknoeePromptClient.js';
import { appSettingService } from '../appSettings/appSetting.service.js';

const previewSchema = z.object({
    model: z.string().min(1),
    systemMessage: z.string().optional().default(''),
    prompt: z.string().min(1),
    maxTokens: z.number().int().min(1).max(128000).optional().default(1000),
    temperature: z.number().min(0).max(2).optional(),
    stream: z.boolean().optional().default(true),
    thinkingLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
    mediaResolution: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
});

export async function registerAiPromptRoutes(app) {
    app.get('/api/ai-prompt/status', async () => {
        const setting = await appSettingService.get('beeknoee_api_key');
        return {
            configured: Boolean(process.env.BEEKNOEE_API_KEY?.trim()) || setting.configured,
            source: process.env.BEEKNOEE_API_KEY?.trim() ? 'environment' : setting.configured ? 'app-setting' : null,
            masked: process.env.BEEKNOEE_API_KEY?.trim() ? 'environment' : setting.masked,
        };
    });

    app.get('/api/ai-prompt/models', async () => ({
        models: await beeknoeePromptClient.listModels(),
    }));

    app.post('/api/ai-prompt/preview', async (request) => {
        const input = previewSchema.parse(request.body);
        const messages = [];
        if (input.systemMessage.trim())
            messages.push({ role: 'system', content: input.systemMessage.trim() });
        messages.push({ role: 'user', content: input.prompt.trim() });
        const content = await beeknoeePromptClient.complete({
            model: input.model,
            messages,
            maxTokens: input.maxTokens,
            temperature: input.temperature,
            stream: input.stream,
            thinkingLevel: input.thinkingLevel,
            mediaResolution: input.mediaResolution,
        });
        return { content };
    });
}
