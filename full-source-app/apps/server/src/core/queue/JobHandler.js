/**
 * Job Handler Interface
 * Defines contract for processing different job types
 */
import { JobType } from '../jobs/JobTypes.js';
/**
 * Base implementation with default retry logic
 */
export class BaseJobHandler {
    canRetry(job, error) {
        // Don't retry on auth errors (401) - handled by token refresh
        if (error.message.includes('401') || error.message.includes('Unauthorized')) {
            return false;
        }
        // Don't retry on bad requests (400) - invalid input
        if (error.message.includes('400') || error.message.includes('Bad Request')) {
            return false;
        }
        // Retry if attempts remaining
        return job.attempts < job.maxAttempts;
    }
    getRetryDelay(attempt, _error) {
        // Exponential backoff: 2s, 4s, 8s, 16s...
        return Math.pow(2, attempt) * 1000;
    }
}
