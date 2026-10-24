/**
 * Gemini Official API Routes
 * Provides endpoints for text generation, streaming, and API key management
 */
import { z } from 'zod';
import { geminiApiService, AVAILABLE_MODELS } from './geminiApi.service.js';
export async function registerGeminiApiRoutes(app) {
    // Generate content (non-streaming)
    app.post('/api/gemini/generate', async (request, reply) => {
        try {
            const body = z.object({
                prompt: z.string().min(1),
                model: z.string().optional(),
                base64Images: z.array(z.string()).optional(),
                fileUri: z.string().optional(),
                videoMetadata: z.object({
                    startOffset: z.string().optional(),
                    endOffset: z.string().optional(),
                    fps: z.number().optional(),
                }).optional(),
                responseJsonSchema: z.record(z.string(), z.unknown()).optional(),
                systemInstruction: z.string().optional(),
                maxTokens: z.number().optional(),
            }).parse(request.body);
            const result = await geminiApiService.generate({
                prompt: body.prompt,
                model: body.model,
                base64Images: body.base64Images,
                fileUri: body.fileUri,
                videoMetadata: body.videoMetadata,
                responseJsonSchema: body.responseJsonSchema,
                systemInstruction: body.systemInstruction,
                maxTokens: body.maxTokens,
            });
            return reply.send(result);
        }
        catch (error) {
            if (error.name === 'ZodError') {
                return reply.status(400).send({ success: false, error: 'Invalid request body' });
            }
            return reply.status(500).send({ success: false, error: error.message });
        }
    });
    // Generate content with streaming (SSE)
    app.post('/api/gemini/generate-stream', async (request, reply) => {
        try {
            const body = z.object({
                prompt: z.string().min(1),
                model: z.string().optional(),
                base64Images: z.array(z.string()).optional(),
                fileUri: z.string().optional(),
                systemInstruction: z.string().optional(),
                maxTokens: z.number().optional(),
            }).parse(request.body);
            // Set SSE headers
            reply.raw.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            });
            const result = await geminiApiService.generateStream({
                prompt: body.prompt,
                model: body.model,
                base64Images: body.base64Images,
                systemInstruction: body.systemInstruction,
                maxTokens: body.maxTokens,
            }, (chunk) => {
                reply.raw.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
            });
            if (!result.success) {
                reply.raw.write(`data: ${JSON.stringify({ error: result.error })}\n\n`);
            }
            reply.raw.write(`data: ${JSON.stringify({ done: true, model: result.model })}\n\n`);
            reply.raw.end();
        }
        catch (error) {
            if (!reply.raw.headersSent) {
                return reply.status(500).send({ success: false, error: error.message });
            }
            reply.raw.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
            reply.raw.end();
        }
    });
    // Get available models
    app.get('/api/gemini/models', async (_request, reply) => {
        return reply.send({ success: true, models: AVAILABLE_MODELS });
    });
    // Get daily usage stats
    app.get('/api/gemini/usage', async (_request, reply) => {
        try {
            const stats = await geminiApiService.getUsageStats();
            return reply.send({ success: true, ...stats });
        }
        catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });
    // Get API key status (masked)
    app.get('/api/gemini/api-key-status', async (_request, reply) => {
        try {
            const apiKey = await geminiApiService.getApiKey();
            if (!apiKey) {
                return reply.send({ success: true, configured: false });
            }
            return reply.send({
                success: true,
                configured: true,
                maskedKey: `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}`,
            });
        }
        catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });
    // Save API key
    app.post('/api/gemini/api-key', async (request, reply) => {
        try {
            const body = z.object({
                apiKey: z.string().min(10),
            }).parse(request.body);
            // Validate key first
            const validation = await geminiApiService.validateApiKey(body.apiKey);
            if (!validation.valid) {
                return reply.status(400).send({
                    success: false,
                    error: `API Key không hợp lệ: ${validation.error}`,
                });
            }
            await geminiApiService.saveApiKey(body.apiKey);
            return reply.send({ success: true, message: 'API Key đã được lưu thành công!' });
        }
        catch (error) {
            return reply.status(500).send({ success: false, error: error.message });
        }
    });
}
