import { z } from 'zod';
import { apiKeyRepository } from './apiKey.repository.js';
export const apiKeySchema = z.object({
    name: z.string().min(1, 'Name is required'),
    key: z.string().min(1, 'API key is required').regex(/^AIza[0-9A-Za-z_-]{35}$/, 'Invalid Gemini API key format'),
    profileId: z.string().optional().nullable(),
    isActive: z.boolean().default(false),
});
export const apiKeyService = {
    /**
     * List all API keys
     */
    list: () => apiKeyRepository.list(),
    /**
     * Get API key by ID
     */
    getById: (id) => apiKeyRepository.getById(id),
    /**
     * Get active API key
     */
    getActive: () => apiKeyRepository.getActive(),
    /**
     * Create new API key
     */
    create: async (payload) => {
        return apiKeyRepository.create({
            name: payload.name,
            key: payload.key,
            ...(payload.profileId
                ? { profile: { connect: { id: payload.profileId } } }
                : {}),
            isActive: payload.isActive,
            usageCount: 0,
        });
    },
    /**
     * Update API key
     */
    update: async (id, payload) => {
        return apiKeyRepository.update(id, {
            ...(payload.name !== undefined ? { name: payload.name } : {}),
            ...(payload.key !== undefined ? { key: payload.key } : {}),
            ...(payload.profileId !== undefined
                ? payload.profileId === null
                    ? { profile: { disconnect: true } }
                    : { profile: { connect: { id: payload.profileId } } }
                : {}),
            ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {}),
        });
    },
    /**
     * Delete API key
     */
    delete: (id) => apiKeyRepository.delete(id),
    /**
     * Activate API key (deactivate all others)
     */
    activate: (id) => apiKeyRepository.setActive(id),
    /**
     * Test API key validity
     */
    test: async (key) => {
        try {
            // Test the key by calling Gemini API to list models
            const response = await fetch(`https://generativelanguage.googleapis.com/v1/models?key=${key}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
            });
            if (!response.ok) {
                const errorText = await response.text();
                return {
                    valid: false,
                    message: `API key validation failed: ${response.statusText} - ${errorText.substring(0, 100)}`,
                };
            }
            const data = (await response.json());
            const models = data.models || [];
            const geminiModel = models.find((m) => m.name?.includes('gemini'));
            return {
                valid: true,
                message: 'API key is valid',
                model: geminiModel?.displayName || (models.length > 0 ? 'Models available' : 'Unknown'),
            };
        }
        catch (error) {
            return {
                valid: false,
                message: `Failed to validate API key: ${error.message}`,
            };
        }
    },
    /**
     * Get keys by profile ID
     */
    getByProfileId: (profileId) => apiKeyRepository.getByProfileId(profileId),
    /**
     * Increment usage count
     */
    incrementUsage: (id) => apiKeyRepository.incrementUsage(id),
};
