import { z, ZodError } from 'zod';
import { ValidationError } from './errors.js';
/**
 * Validation helpers for Zod schemas
 */
export function validateData(schema, data) {
    try {
        return schema.parse(data);
    }
    catch (error) {
        if (error instanceof ZodError) {
            const details = error.errors.map((err) => ({
                field: err.path.join('.'),
                message: err.message,
                code: err.code,
            }));
            throw new ValidationError('Validation failed', details);
        }
        throw error;
    }
}
export function validateDataSafe(schema, data) {
    try {
        const result = schema.parse(data);
        return { success: true, data: result };
    }
    catch (error) {
        if (error instanceof ZodError) {
            const details = error.errors.map((err) => ({
                field: err.path.join('.'),
                message: err.message,
                code: err.code,
            }));
            return {
                success: false,
                error: new ValidationError('Validation failed', details),
            };
        }
        throw error;
    }
}
/**
 * Common validation schemas
 */
export const commonSchemas = {
    id: z.string().min(1, 'ID is required'),
    pagination: z.object({
        skip: z.number().int().nonnegative().optional(),
        take: z.number().int().positive().max(100).optional(),
    }),
    dateRange: z.object({
        fromDate: z.coerce.date().optional(),
        toDate: z.coerce.date().optional(),
    }),
};
