/**
 * File Routes
 * Static file server for serving local files (audio, video, images)
 */
import path from 'path';
import fs from 'fs';
const CONTENT_TYPES = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.srt': 'text/plain; charset=utf-8',
    '.vtt': 'text/vtt; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
};
export async function registerFileRoutes(app) {
    // Serve local file by path: GET /api/files?path=/path/to/file.mp3
    app.get('/api/files', async (req, reply) => {
        const { path: filePath } = req.query;
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
        const ext = path.extname(normalizedPath).toLowerCase();
        const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
        const stats = fs.statSync(normalizedPath);
        const stream = fs.createReadStream(normalizedPath);
        return reply
            .header('Content-Length', stats.size)
            .type(contentType)
            .send(stream);
    });
}
