import { scriptWriterService } from './scriptWriter.service.js';
export async function registerScriptWriterRoutes(fastify) {
    // Expand idea into screenplay
    fastify.post('/api/script/expand-idea', async (request) => {
        const { idea, targetMinutes, style } = request.body;
        if (!idea?.trim())
            throw new Error('idea is required');
        return scriptWriterService.expandIdea(idea, { targetMinutes, style });
    });
    // Rewrite/enhance script
    fastify.post('/api/script/rewrite', async (request) => {
        const { script, style } = request.body;
        if (!script?.trim())
            throw new Error('script is required');
        return scriptWriterService.rewriteScript(script, { style });
    });
    // Segment script into timed scenes
    fastify.post('/api/script/segment', async (request) => {
        const { script, targetDuration } = request.body;
        if (!script?.trim())
            throw new Error('script is required');
        return scriptWriterService.segmentScript(script, { targetDuration });
    });
}
