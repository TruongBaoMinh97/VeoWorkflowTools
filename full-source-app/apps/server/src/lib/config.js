import { z } from 'zod';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
/**
 * Application configuration schema with validation
 */
const configSchema = z.object({
    // Queue settings
    MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(5),
    GLOBAL_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
    DEFAULT_TOKEN_CONCURRENCY: z.coerce.number().int().positive().default(1),
    // Job settings
    JOB_RETRY_ATTEMPTS: z.coerce.number().int().nonnegative().default(3),
    JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(600000), // 10 minutes
    JOB_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000), // 1 second
    // Scheduler settings
    SCHEDULER_TICK_INTERVAL_MS: z.coerce.number().int().positive().default(1000), // 1 second
    SCHEDULER_AUTO_START: z.coerce.boolean().default(false),
    // Storage settings
    LOGS_DIR: z.string().default('./logs'),
    // Provider settings
    DEFAULT_PROVIDER_ID: z.string().default('veo3'),
    MOCK_PROVIDER_ENABLED: z.coerce.boolean().default(false),
    // Server settings
    PORT: z.coerce.number().int().positive().default(4000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    // Database
    DATABASE_URL: z.string().default('file:./prisma/dev.db'),
});
/**
 * Configuration manager
 * Loads config from environment variables and database
 */
class ConfigManager {
    constructor() {
        this.dbConfig = new Map();
        this.initialized = false;
        // Initialize with env vars
        this.config = configSchema.parse(process.env);
    }
    /**
     * Load configuration from database
     * DB values override env vars
     */
    async init() {
        if (this.initialized)
            return;
        try {
            const settings = await prisma.appSetting.findMany();
            for (const setting of settings) {
                this.dbConfig.set(setting.key, setting.value);
            }
            // Merge DB config with env config (DB takes precedence)
            const merged = { ...this.config };
            for (const [key, value] of this.dbConfig.entries()) {
                if (key in merged) {
                    merged[key] = value;
                }
            }
            this.config = configSchema.parse(merged);
            this.initialized = true;
            logger.info('Configuration loaded successfully', {
                source: 'env + database',
                settingsCount: settings.length,
            });
        }
        catch (error) {
            logger.error('Failed to load configuration from database', { error });
            // Continue with env-only config
            this.initialized = true;
        }
    }
    /**
     * Get configuration value by key
     */
    get(key) {
        return this.config[key];
    }
    /**
     * Get all configuration
     */
    getAll() {
        return { ...this.config };
    }
    /**
     * Update configuration value (in-memory and database)
     */
    async set(key, value) {
        try {
            // Validate new value
            const partial = { [key]: value };
            const validated = configSchema.partial().parse(partial);
            // Update in-memory
            this.config[key] = validated[key];
            // Update in database
            await prisma.appSetting.upsert({
                where: { key: key },
                update: { value: String(value) },
                create: { key: key, value: String(value) },
            });
            logger.info(`Configuration updated: ${key} = ${value}`);
        }
        catch (error) {
            logger.error(`Failed to update configuration: ${key}`, { error });
            throw error;
        }
    }
    /**
     * Update multiple configuration values
     */
    async setMany(values) {
        const validated = configSchema.partial().parse(values);
        for (const [key, value] of Object.entries(validated)) {
            if (value !== undefined) {
                await this.set(key, value);
            }
        }
    }
    /**
     * Reload configuration from database
     */
    async reload() {
        this.initialized = false;
        this.dbConfig.clear();
        await this.init();
    }
}
// Singleton instance
export const config = new ConfigManager();
// Note: config.init() should be called manually after database is initialized
// DO NOT auto-init here as database may not exist yet on first run
