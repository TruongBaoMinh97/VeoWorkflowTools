import { PrismaClient } from '@prisma/client';
import { logger } from './logger.js';
const isDevelopment = process.env.NODE_ENV === 'development';
const createPrismaClient = () => {
    // Log DATABASE_URL for debugging (mask most of path for security)
    const dbUrl = process.env.DATABASE_URL || 'NOT SET';
    const maskedUrl = dbUrl.length > 30
        ? `${dbUrl.substring(0, 15)}...${dbUrl.substring(dbUrl.length - 15)}`
        : dbUrl;
    logger.info('[Prisma] Creating client with DATABASE_URL:', maskedUrl);
    const client = new PrismaClient({
        log: isDevelopment
            ? [
                { level: 'query', emit: 'event' },
                { level: 'error', emit: 'event' },
                { level: 'warn', emit: 'event' },
            ]
            : [{ level: 'error', emit: 'event' }],
    });
    // Log Prisma queries in development
    if (isDevelopment) {
        client.$on('query', (e) => {
            logger.debug('Prisma Query', {
                query: e.query,
                params: e.params,
                duration: `${e.duration}ms`,
            });
        });
    }
    client.$on('error', (e) => {
        logger.error('Prisma Error', { error: e });
    });
    client.$on('warn', (e) => {
        logger.warn('Prisma Warning', { message: e.message });
    });
    return client;
};
/**
 * Get or create the Prisma client instance
 * Uses lazy initialization to ensure database is ready before connecting
 */
function getPrismaClient() {
    if (!global.__prismaClient) {
        logger.info('[Prisma] Initializing Prisma client...');
        global.__prismaClient = createPrismaClient();
    }
    return global.__prismaClient;
}
/**
 * Mark Prisma as initialized (called after database setup)
 */
export function markPrismaInitialized() {
    global.__prismaInitialized = true;
    logger.info('[Prisma] Database initialization confirmed');
}
/**
 * Check if Prisma has been initialized
 */
export function isPrismaInitialized() {
    return global.__prismaInitialized === true;
}
// Export a proxy that lazily initializes the client
// This allows imports to happen before database is ready
export const prisma = new Proxy({}, {
    get(target, prop) {
        const client = getPrismaClient();
        const value = client[prop];
        if (typeof value === 'function') {
            return value.bind(client);
        }
        return value;
    },
});
if (process.env.NODE_ENV !== 'production') {
    global.__prismaClient = global.__prismaClient;
}
