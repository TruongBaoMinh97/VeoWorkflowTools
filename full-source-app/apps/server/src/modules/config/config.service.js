import { z } from 'zod';
import { configRepository } from './config.repository.js';
import { logger } from '../../lib/logger.js';
export const directoriesSchema = z.object({
    downloadsDir: z.string().default(''),
    tempDir: z.string().default(''),
});
export const defaultsSchema = z.object({
    maxConcurrency: z.number().int().positive().default(5),
    autoStartQueue: z.boolean().default(false),
});
export const appConfigSchema = z.object({
    directories: directoriesSchema,
    defaults: defaultsSchema,
});
const DEFAULT_CONFIG = {
    directories: {
        downloadsDir: '',
        tempDir: '',
    },
    defaults: {
        maxConcurrency: 5,
        autoStartQueue: false,
    },
};
const CONFIG_KEYS = {
    directories: 'app.directories',
    defaults: 'app.defaults',
};
const parseSetting = (value, schema, fallback) => {
    if (!value)
        return fallback;
    try {
        const parsed = JSON.parse(value);
        return schema.parse(parsed);
    }
    catch (error) {
        logger.warn('[ConfigService] Failed to parse setting', error);
        return fallback;
    }
};
export const configService = {
    async getConfig() {
        const rows = await configRepository.getAll();
        const map = new Map(rows.map((row) => [row.key, row.value]));
        return {
            directories: parseSetting(map.get(CONFIG_KEYS.directories), directoriesSchema, DEFAULT_CONFIG.directories),
            defaults: parseSetting(map.get(CONFIG_KEYS.defaults), defaultsSchema, DEFAULT_CONFIG.defaults),
        };
    },
    async updateConfig(input) {
        const current = await this.getConfig();
        const next = {
            directories: directoriesSchema.parse({
                ...current.directories,
                ...input.directories,
            }),
            defaults: defaultsSchema.parse({
                ...current.defaults,
                ...input.defaults,
            }),
        };
        await configRepository.upsert([
            {
                key: CONFIG_KEYS.directories,
                value: JSON.stringify(next.directories),
            },
            {
                key: CONFIG_KEYS.defaults,
                value: JSON.stringify(next.defaults),
            },
        ]);
        return next;
    },
};
