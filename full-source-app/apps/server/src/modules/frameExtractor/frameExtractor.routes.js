import { z } from 'zod';
import { frameExtractorService } from './frameExtractor.service.js';
export async function registerFrameExtractorRoutes(app) {
    // Start frame extraction
    app.post('/api/frame-extractor/extract', async (req) => {
        const body = z.object({
            videoSource: z.string().min(1, 'Video source is required'),
            outputDir: z.string().min(1, 'Output directory is required'),
            mode: z.enum(['interval', 'split-segments']),
            interval: z.number().min(0.5).max(300).optional()
        }).parse(req.body);
        const result = await frameExtractorService.startExtraction(body.videoSource, body.outputDir, {
            mode: body.mode,
            interval: body.interval
        });
        return {
            success: true,
            data: result
        };
    });
    // Get extraction job status
    app.get('/api/frame-extractor/status/:jobId', async (req) => {
        const { jobId } = z.object({
            jobId: z.string().uuid()
        }).parse(req.params);
        const job = frameExtractorService.getJobStatus(jobId);
        if (!job) {
            return {
                success: false,
                message: 'Job not found'
            };
        }
        return {
            success: true,
            data: job
        };
    });
}
