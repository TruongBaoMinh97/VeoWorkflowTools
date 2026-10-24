import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureDirectoryExists, getAppDataDirectory } from '../utils/directoryInit.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/**
 * Get logs directory path
 * In packaged app: user data folder (has write permission)
 * In development: project logs folder
 */
function getLogsDirectory() {
    const isPackaged = process.env.ELECTRON_RUN_AS_NODE === '1' ||
        process.resourcesPath !== undefined ||
        (process.env.NODE_ENV === 'production' && process.platform === 'win32');
    if (isPackaged) {
        return path.join(getAppDataDirectory(), 'logs');
    }
    else {
        return path.join(__dirname, '../../logs');
    }
}
const appDataDir = getAppDataDirectory();
const appDataCreated = ensureDirectoryExists(appDataDir);
if (!appDataCreated) {
    console.warn(`[Logger] Warning: Could not create app data directory: ${appDataDir}`);
}
const logsDir = getLogsDirectory();
console.log(`[Logger] Logs directory: ${logsDir}`);
const logsDirCreated = ensureDirectoryExists(logsDir);
const MAX_INLINE_LEN = 200; // truncate long inline values
const MAX_BLOCK_LEN = 1500; // truncate large JSON blocks
/**
 * Detects when meta keys are 0..N consecutive integers — Winston spreads
 * strings into char-index maps when callers do logger.info("msg", aString).
 * Reconstructs the original string so logs read normally.
 */
function reconstructSpreadString(meta) {
    const keys = Object.keys(meta);
    if (keys.length === 0)
        return null;
    const indices = keys.map((k) => Number(k));
    if (indices.some((n) => Number.isNaN(n)))
        return null;
    indices.sort((a, b) => a - b);
    for (let i = 0; i < indices.length; i++) {
        if (indices[i] !== i)
            return null;
    }
    // All keys are 0..N-1 → values are likely chars
    const chars = indices.map((idx) => meta[String(idx)]);
    if (!chars.every((c) => typeof c === 'string' && c.length === 1))
        return null;
    return chars.join('');
}
function truncate(str, max) {
    if (str.length <= max)
        return str;
    return `${str.slice(0, max)}…(+${str.length - max} chars)`;
}
function formatMeta(meta) {
    if (!meta || Object.keys(meta).length === 0)
        return '';
    // Reconstruct string-spread (e.g. cookies/url passed as 2nd arg by mistake)
    const reconstructed = reconstructSpreadString(meta);
    if (reconstructed !== null) {
        return ` ${truncate(reconstructed, MAX_INLINE_LEN)}`;
    }
    // Tiny meta → inline; large → block
    try {
        const inline = JSON.stringify(meta);
        if (inline.length <= MAX_INLINE_LEN)
            return ` ${inline}`;
        const pretty = JSON.stringify(meta, null, 2);
        return `\n${truncate(pretty, MAX_BLOCK_LEN)}`;
    }
    catch {
        return ' [unserializable meta]';
    }
}
const printer = winston.format.printf(({ timestamp, level, message, category, ...meta }) => {
    const categoryStr = category ? ` [${category}]` : '';
    const metaStr = formatMeta(meta);
    return `${timestamp} ${level.toUpperCase()}${categoryStr} ${message}${metaStr}`;
});
const transports = [
    new winston.transports.Console({
        format: winston.format.combine(winston.format.colorize(), winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), winston.format.errors({ stack: true }), winston.format.splat(), printer)),
    }),
];
if (logsDirCreated) {
    transports.push(new winston.transports.File({
        filename: path.join(logsDir, 'app.log'),
        level: 'info',
        maxsize: 10 * 1024 * 1024,
        maxFiles: 5,
    }));
    transports.push(new winston.transports.File({
        filename: path.join(logsDir, 'error.log'),
        level: 'error',
        maxsize: 10 * 1024 * 1024,
        maxFiles: 5,
    }));
}
else {
    console.warn(`[Logger] Warning: Could not create logs directory, logging to console only`);
}
const logFormat = winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), winston.format.errors({ stack: true }), winston.format.splat(), printer);
export function runtimeVerboseLogsEnabled() {
    const logLevel = String(process.env.LOG_LEVEL || 'info').toLowerCase();
    return (logLevel === 'debug' ||
        process.env.VEO3_VERBOSE_LOGS === '1' ||
        process.env.VEO3_REAL_CHROME_VERBOSE === '1');
}
export const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: logFormat,
    transports,
});
/**
 * Categorized logger helpers
 */
export const categorizedLogger = {
    queue: (level, message, meta) => logger.log(level, message, { category: 'queue', ...meta }),
    job: (level, message, meta) => logger.log(level, message, { category: 'job', ...meta }),
    profile: (level, message, meta) => logger.log(level, message, { category: 'profile', ...meta }),
    script: (level, message, meta) => logger.log(level, message, { category: 'script', ...meta }),
    provider: (level, message, meta) => logger.log(level, message, { category: 'provider', ...meta }),
    system: (level, message, meta) => logger.log(level, message, { category: 'system', ...meta }),
    db: (level, message, meta) => logger.log(level, message, { category: 'database', ...meta }),
};
export const log = {
    debug: (message, meta) => logger.debug(message, meta),
    info: (message, meta) => logger.info(message, meta),
    warn: (message, meta) => logger.warn(message, meta),
    error: (message, meta) => logger.error(message, meta),
};
