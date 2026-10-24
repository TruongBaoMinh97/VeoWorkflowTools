export class NonRetryableNodeError extends Error {
    constructor(message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = 'NonRetryableNodeError';
        this.code = options.code ?? 'NODE_NON_RETRYABLE';
    }
}
