import { AppError } from '../lib/errors.js';
import { ZodError } from 'zod';
/**
 * Global error handler middleware for Fastify
 */
export function errorHandler(error, request, reply) {
    // Log error
    request.log.error({
        error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
        },
        request: {
            method: request.method,
            url: request.url,
            headers: { ...request.headers, authorization: request.headers.authorization ? '[REDACTED]' : undefined, cookie: request.headers.cookie ? '[REDACTED]' : undefined },
            body: request.url.startsWith('/api/app-settings/') ? '[REDACTED SETTINGS]' : request.body,
        },
    }, 'Request error');
    // Handle custom AppError
    if (error instanceof AppError) {
        return reply.status(error.statusCode).send({
            error: error.name,
            message: error.message,
            code: error.code,
            details: error.details,
        });
    }
    // Handle Zod validation errors
    if (error instanceof ZodError || error.name === 'ZodError') {
        const zodError = error;
        const details = zodError.errors?.map((err) => ({
            field: err.path?.join('.') || 'unknown',
            message: err.message || 'Validation failed',
            code: err.code || 'invalid',
        })) || [];
        return reply.status(400).send({
            error: 'ValidationError',
            message: 'Validation failed',
            code: 'VALIDATION_ERROR',
            details,
        });
    }
    // Handle Fastify validation errors
    const fastifyError = error;
    if (fastifyError.statusCode === 400 && fastifyError.validation) {
        return reply.status(400).send({
            error: 'ValidationError',
            message: error.message,
            code: 'VALIDATION_ERROR',
            details: fastifyError.validation,
        });
    }
    // Handle 404 Not Found
    if (fastifyError.statusCode === 404) {
        return reply.status(404).send({
            error: 'NotFound',
            message: error.message || 'Resource not found',
            code: 'NOT_FOUND',
        });
    }
    // Default to 500 Internal Server Error
    const statusCode = fastifyError.statusCode || 500;
    return reply.status(statusCode).send({
        error: 'InternalServerError',
        message: process.env.NODE_ENV === 'production'
            ? 'An unexpected error occurred'
            : error.message,
        code: 'INTERNAL_ERROR',
        ...(process.env.NODE_ENV !== 'production' && {
            stack: error.stack,
        }),
    });
}
