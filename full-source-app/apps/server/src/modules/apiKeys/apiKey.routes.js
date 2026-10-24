import { z } from 'zod';
import { apiKeySchema, apiKeyService } from './apiKey.service.js';
export async function registerApiKeyRoutes(app) {
    // List all API keys
    app.get('/api/api-keys', async (request, reply) => {
        const apiKeys = await apiKeyService.list();
        // Mask keys for security (show only first 10 and last 5 chars)
        const maskedKeys = apiKeys.map((key) => ({
            ...key,
            key: `${key.key.substring(0, 10)}...${key.key.substring(key.key.length - 5)}`,
        }));
        reply.send(maskedKeys);
    });
    // Get API key by ID
    app.get('/api/api-keys/:id', async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).parse(request.params);
        const apiKey = await apiKeyService.getById(params.id);
        if (!apiKey) {
            reply.code(404).send({ error: 'API key not found' });
            return;
        }
        // Mask key
        reply.send({
            ...apiKey,
            key: `${apiKey.key.substring(0, 10)}...${apiKey.key.substring(apiKey.key.length - 5)}`,
        });
    });
    // Get active API key
    app.get('/api/api-keys/active/current', async (request, reply) => {
        const apiKey = await apiKeyService.getActive();
        if (!apiKey) {
            reply.code(404).send({ error: 'No active API key found' });
            return;
        }
        reply.send({
            ...apiKey,
            key: `${apiKey.key.substring(0, 10)}...${apiKey.key.substring(apiKey.key.length - 5)}`,
        });
    });
    // Create new API key
    app.post('/api/api-keys', async (request, reply) => {
        const body = apiKeySchema.parse(request.body);
        const apiKey = await apiKeyService.create(body);
        reply.code(201).send({
            ...apiKey,
            key: `${apiKey.key.substring(0, 10)}...${apiKey.key.substring(apiKey.key.length - 5)}`,
        });
    });
    // Update API key
    app.put('/api/api-keys/:id', async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).parse(request.params);
        const rawBody = request.body;
        // Build update schema - only validate fields that are being updated
        const updateSchema = z.object({
            name: z.string().min(1, 'Name is required').optional(),
            key: z.string().min(1, 'API key is required').regex(/^AIza[0-9A-Za-z_-]{35}$/, 'Invalid Gemini API key format').optional(),
            profileId: z.string().optional().nullable(),
            isActive: z.boolean().optional(),
        });
        // Filter out empty string keys (don't update key if empty)
        const bodyToUpdate = {};
        if (rawBody.name !== undefined)
            bodyToUpdate.name = rawBody.name;
        if (rawBody.key && rawBody.key.trim() !== '')
            bodyToUpdate.key = rawBody.key;
        if (rawBody.profileId !== undefined)
            bodyToUpdate.profileId = rawBody.profileId;
        if (rawBody.isActive !== undefined)
            bodyToUpdate.isActive = rawBody.isActive;
        const body = updateSchema.parse(bodyToUpdate);
        const apiKey = await apiKeyService.update(params.id, body);
        reply.send({
            ...apiKey,
            key: `${apiKey.key.substring(0, 10)}...${apiKey.key.substring(apiKey.key.length - 5)}`,
        });
    });
    // Delete API key
    app.delete('/api/api-keys/:id', async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).parse(request.params);
        await apiKeyService.delete(params.id);
        reply.code(204).send();
    });
    // Activate API key
    app.post('/api/api-keys/:id/activate', async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).parse(request.params);
        const apiKey = await apiKeyService.activate(params.id);
        reply.send({
            ...apiKey,
            key: `${apiKey.key.substring(0, 10)}...${apiKey.key.substring(apiKey.key.length - 5)}`,
        });
    });
    // Test API key
    app.post('/api/api-keys/:id/test', async (request, reply) => {
        const params = z.object({ id: z.string().min(1) }).parse(request.params);
        const apiKey = await apiKeyService.getById(params.id);
        if (!apiKey) {
            reply.code(404).send({ error: 'API key not found' });
            return;
        }
        const result = await apiKeyService.test(apiKey.key);
        reply.send(result);
    });
    // Test raw API key (for validation before saving)
    app.post('/api/api-keys/test-raw', async (request, reply) => {
        const body = z.object({ key: z.string().min(1) }).parse(request.body);
        const result = await apiKeyService.test(body.key);
        reply.send(result);
    });
    // Get keys by profile ID
    app.get('/api/profiles/:profileId/api-keys', async (request, reply) => {
        const params = z.object({ profileId: z.string().min(1) }).parse(request.params);
        const apiKeys = await apiKeyService.getByProfileId(params.profileId);
        // Mask keys
        const maskedKeys = apiKeys.map((key) => ({
            ...key,
            key: `${key.key.substring(0, 10)}...${key.key.substring(key.key.length - 5)}`,
        }));
        reply.send(maskedKeys);
    });
}
