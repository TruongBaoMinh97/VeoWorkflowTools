/**
 * Custom error classes for application-level errors
 */
export class AppError extends Error {
    constructor(message, statusCode = 500, code, details) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        this.name = this.constructor.name;
        Error.captureStackTrace(this, this.constructor);
    }
    toJSON() {
        return {
            error: this.name,
            message: this.message,
            code: this.code,
            details: this.details,
            statusCode: this.statusCode,
        };
    }
}
export class ValidationError extends AppError {
    constructor(message, details) {
        super(message, 400, 'VALIDATION_ERROR', details);
    }
}
export class NotFoundError extends AppError {
    constructor(resource, identifier) {
        const message = identifier
            ? `${resource} with identifier '${identifier}' not found`
            : `${resource} not found`;
        super(message, 404, 'NOT_FOUND');
    }
}
export class UnauthorizedError extends AppError {
    constructor(message = 'Unauthorized') {
        super(message, 401, 'UNAUTHORIZED');
    }
}
export class ForbiddenError extends AppError {
    constructor(message = 'Forbidden') {
        super(message, 403, 'FORBIDDEN');
    }
}
export class BadRequestError extends AppError {
    constructor(message, details) {
        super(message, 400, 'BAD_REQUEST', details);
    }
}
export class RateLimitError extends AppError {
    constructor(message = 'Rate limit exceeded') {
        super(message, 429, 'RATE_LIMIT_EXCEEDED');
    }
}
export class CaptchaError extends AppError {
    constructor(message, options = {}) {
        super(message, options.statusCode ?? 503, options.code ?? 'CAPTCHA_ERROR', options.details);
        this.retryable = options.retryable ?? true;
    }
}
