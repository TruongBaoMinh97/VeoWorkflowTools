// @ts-nocheck
import { prisma } from '../../lib/prisma.js';
export const apiKeyRepository = {
    /**
     * List all API keys
     */
    list: async () => {
        return prisma.apiKey.findMany({
            orderBy: [
                { isActive: 'desc' }, // Active keys first
                { createdAt: 'desc' }
            ],
            include: {
                profile: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            }
        });
    },
    /**
     * Get API key by ID
     */
    getById: async (id) => {
        return prisma.apiKey.findUnique({
            where: { id },
            include: {
                profile: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            }
        });
    },
    /**
     * Get active API key
     */
    getActive: async () => {
        return prisma.apiKey.findFirst({
            where: { isActive: true }
        });
    },
    /**
     * Create API key
     */
    create: async (data) => {
        return prisma.apiKey.create({
            data,
            include: {
                profile: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            }
        });
    },
    /**
     * Update API key
     */
    update: async (id, data) => {
        return prisma.apiKey.update({
            where: { id },
            data,
            include: {
                profile: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            }
        });
    },
    /**
     * Delete API key
     */
    delete: async (id) => {
        return prisma.apiKey.delete({
            where: { id }
        });
    },
    /**
     * Set active API key (deactivate all others)
     */
    setActive: async (id) => {
        // Deactivate all keys first
        await prisma.apiKey.updateMany({
            where: { isActive: true },
            data: { isActive: false }
        });
        // Activate the selected key
        return prisma.apiKey.update({
            where: { id },
            data: { isActive: true },
            include: {
                profile: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            }
        });
    },
    /**
     * Increment usage count and update last used timestamp
     */
    incrementUsage: async (id) => {
        await prisma.apiKey.update({
            where: { id },
            data: {
                usageCount: { increment: 1 },
                lastUsed: new Date()
            }
        });
    },
    /**
     * Get keys by profile ID
     */
    getByProfileId: async (profileId) => {
        return prisma.apiKey.findMany({
            where: { profileId },
            orderBy: { createdAt: 'desc' }
        });
    }
};
