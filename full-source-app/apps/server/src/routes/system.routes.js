/**
 * System Routes
 * Database status, reset, Python status, and file reading endpoints
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { logger } from '../lib/logger.js';
import { resolvePythonBinary, resolvePythonScript } from '../utils/pythonResolver.js';
import { resolveFfmpegBinary, resolveFfprobeBinary } from '../utils/ffmpegResolver.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.join(__dirname, '..');
export async function registerSystemRoutes(app) {
    // Database status
    app.get('/api/system/database-status', async (_request, reply) => {
        try {
            const dbUrl = process.env.DATABASE_URL || 'NOT SET';
            let dbPath = 'unknown';
            if (dbUrl.startsWith('file:///')) {
                dbPath = dbUrl.substring(8);
            }
            else if (dbUrl.startsWith('file://')) {
                dbPath = dbUrl.substring(7);
            }
            else if (dbUrl.startsWith('file:')) {
                dbPath = dbUrl.substring(5);
            }
            const dbExists = dbPath !== 'unknown' && fs.existsSync(dbPath);
            const dbSize = dbExists ? fs.statSync(dbPath).size : 0;
            const templatePath = path.join(SERVER_ROOT, 'prisma', 'template.db');
            const templateExists = fs.existsSync(templatePath);
            const templateSize = templateExists ? fs.statSync(templatePath).size : 0;
            let queryWorks = false;
            let queryError = '';
            try {
                const { prisma } = await import('../lib/prisma.js');
                await prisma.$queryRaw `SELECT 1`;
                queryWorks = true;
            }
            catch (e) {
                queryError = e.message || String(e);
            }
            return reply.send({
                databaseUrl: dbUrl.length > 50 ? `${dbUrl.substring(0, 25)}...${dbUrl.substring(dbUrl.length - 20)}` : dbUrl,
                databasePath: dbPath,
                databaseExists: dbExists,
                databaseSize: `${(dbSize / 1024).toFixed(2)} KB`,
                templatePath,
                templateExists,
                templateSize: `${(templateSize / 1024).toFixed(2)} KB`,
                queryWorks,
                queryError: queryError || null,
                __dirname: SERVER_ROOT,
                platform: process.platform,
                isPackaged: process.env.ELECTRON_RUN_AS_NODE === '1',
            });
        }
        catch (error) {
            return reply.status(500).send({
                error: error.message || 'Failed to get database status',
            });
        }
    });
    // Database reset
    app.post('/api/system/reset-database', async (_request, reply) => {
        try {
            const { forceResetDatabase } = await import('../lib/databaseSchemaChecker.js');
            const dbUrl = process.env.DATABASE_URL || 'file:./prisma/dev.db';
            let dbPath;
            if (dbUrl.startsWith('file:///')) {
                dbPath = dbUrl.substring(8);
            }
            else if (dbUrl.startsWith('file://')) {
                dbPath = dbUrl.substring(7);
            }
            else if (dbUrl.startsWith('file:')) {
                dbPath = dbUrl.substring(5);
            }
            else {
                dbPath = dbUrl;
            }
            if (!path.isAbsolute(dbPath)) {
                dbPath = path.join(SERVER_ROOT, dbPath);
            }
            const templateDbPath = path.join(SERVER_ROOT, 'prisma', 'template.db');
            logger.info('Database reset requested', { dbPath, templateDbPath });
            const success = forceResetDatabase(dbPath, templateDbPath);
            if (success) {
                return reply.send({
                    success: true,
                    message: 'Database reset successfully. Please restart the application.',
                    note: 'Old database has been backed up.',
                });
            }
            return reply.status(500).send({
                success: false,
                error: 'Failed to reset database. Check logs for details.',
            });
        }
        catch (error) {
            logger.error('Database reset error:', error);
            return reply.status(500).send({
                success: false,
                error: error.message || 'Failed to reset database',
            });
        }
    });
    // Python environment status
    app.get('/api/system/python-status', async (_request, reply) => {
        const pythonBinary = resolvePythonBinary();
        const frameExtractorScript = resolvePythonScript('frame_extractor.py');
        const removeWatermarkScript = resolvePythonScript('remove_watermark_batch.py');
        const removeVideoWatermarkScript = resolvePythonScript('remove_video_watermark_batch.py');
        const setupScriptName = process.platform === 'win32' ? 'setup-venv.bat' : 'setup-venv.sh';
        const setupScriptPath = path.join(SERVER_ROOT, 'python', setupScriptName);
        const setupScriptExists = fs.existsSync(setupScriptPath);
        const ffmpegBinary = resolveFfmpegBinary();
        const ffprobeBinary = resolveFfprobeBinary();
        return reply.send({
            available: pythonBinary !== null,
            pythonPath: pythonBinary,
            ffmpeg: {
                available: ffmpegBinary !== null,
                ffmpegPath: ffmpegBinary,
                ffprobePath: ffprobeBinary,
            },
            features: {
                frameExtractor: {
                    available: pythonBinary !== null && frameExtractorScript !== null && ffmpegBinary !== null,
                    scriptPath: frameExtractorScript,
                    ffmpegAvailable: ffmpegBinary !== null,
                },
                removeWatermark: {
                    available: pythonBinary !== null && removeWatermarkScript !== null,
                    scriptPath: removeWatermarkScript,
                    videoAvailable: pythonBinary !== null &&
                        removeVideoWatermarkScript !== null &&
                        ffmpegBinary !== null &&
                        ffprobeBinary !== null,
                    note: 'Xóa watermark ảnh/video (OpenCV + FFmpeg)',
                },
                tts: { available: pythonBinary !== null, note: 'Edge TTS (auto-installed)' },
                videoAnalysis: { available: pythonBinary !== null, note: 'OpenCV + SceneDetect (auto-installed)' },
            },
            setupScript: {
                name: setupScriptName,
                exists: setupScriptExists,
                relativePath: `apps/server/python/${setupScriptName}`,
            },
            platform: process.platform,
            message: pythonBinary
                ? 'Python environment is available'
                : 'Python not found. Please install Python 3.9+ and run the setup script.',
        });
    });
    // Read local file as base64
    app.get('/api/system/read-file-base64', async (request, reply) => {
        try {
            const { path: filePath } = request.query;
            if (!filePath) {
                return reply.code(400).send({ error: 'Path parameter required' });
            }
            const normalizedPath = path.normalize(filePath);
            if (normalizedPath.includes('..')) {
                return reply.code(403).send({ error: 'Directory traversal not allowed' });
            }
            if (!fs.existsSync(normalizedPath)) {
                return reply.code(404).send({ error: 'File not found' });
            }
            const fileBuffer = fs.readFileSync(normalizedPath);
            const base64Data = fileBuffer.toString('base64');
            const ext = path.extname(normalizedPath).toLowerCase();
            const mimeTypes = {
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.webp': 'image/webp',
                '.gif': 'image/gif',
                '.mp4': 'video/mp4',
                '.webm': 'video/webm',
                '.mov': 'video/quicktime',
                '.avi': 'video/x-msvideo',
                '.mkv': 'video/x-matroska',
            };
            const mimeType = mimeTypes[ext] || 'application/octet-stream';
            const dataUrl = `data:${mimeType};base64,${base64Data}`;
            return reply.send({ success: true, dataUrl, size: fileBuffer.length });
        }
        catch (error) {
            return reply.code(500).send({ error: error.message || 'Failed to read file' });
        }
    });
}
