/**
 * Prompt Generator Routes
 * API endpoints for script-based prompt generation
 */
import { z } from 'zod';
import { promptGeneratorService } from './promptGenerator.service.js';
import { logger } from '../../lib/logger.js';
export async function registerPromptGeneratorRoutes(app) {
    /**
     * POST /api/prompt-generator/analyze-characters
     * Analyze script and extract character descriptions
     */
    app.post('/api/prompt-generator/analyze-characters', async (request, reply) => {
        const body = z.object({
            script: z.string().min(1, 'Script is required'),
            style: z.string().optional().default('Professional'),
        }).parse(request.body);
        try {
            const characters = await promptGeneratorService.analyzeCharacters(body.script, body.style);
            reply.send({ characters });
        }
        catch (error) {
            reply.code(500).send({
                error: 'Failed to analyze characters',
                message: error.message
            });
        }
    });
    /**
     * POST /api/prompt-generator/generate-scenes
     * Generate scene breakdowns with image and video prompts
     */
    app.post('/api/prompt-generator/generate-scenes', async (request, reply) => {
        const body = z.object({
            script: z.string().min(1, 'Script is required'),
            characters: z.array(z.object({
                name: z.string(),
                promptEn: z.string(),
            })),
            style: z.string().default('Pixar style'),
            aspectRatio: z.string().default('16:9'),
            duration: z.number().int().positive().default(120),
            sceneCount: z.number().int().positive().default(15),
        }).parse(request.body);
        try {
            const scenes = await promptGeneratorService.generateScenes({
                script: body.script,
                characters: body.characters,
                style: body.style,
                aspectRatio: body.aspectRatio,
                duration: body.duration,
                sceneCount: body.sceneCount,
            });
            reply.send({ scenes });
        }
        catch (error) {
            reply.code(500).send({
                error: 'Failed to generate scenes',
                message: error.message
            });
        }
    });
    /**
     * POST /api/prompt-generator/generate-video-scenes
     * Generate video-only scene breakdowns (for Veo3 tool)
     */
    app.post('/api/prompt-generator/generate-video-scenes', async (request, reply) => {
        const body = z.object({
            script: z.string().min(1, 'Script is required'),
            characters: z.array(z.object({
                name: z.string(),
                promptEn: z.string(),
            })),
            style: z.string().default('****'),
        }).parse(request.body);
        try {
            const scenes = await promptGeneratorService.generateVideoScenes({
                script: body.script,
                characters: body.characters,
                style: body.style,
            });
            reply.send({ scenes });
        }
        catch (error) {
            reply.code(500).send({
                error: 'Failed to generate video scenes',
                message: error.message
            });
        }
    });
    /**
     * POST /api/prompt-generator/reload-keys
     * Reload API key pool (useful after adding new keys)
     */
    app.post('/api/prompt-generator/reload-keys', async (request, reply) => {
        try {
            await promptGeneratorService.reloadKeyPool();
            reply.send({ success: true, message: 'API key pool reloaded' });
        }
        catch (error) {
            reply.code(500).send({
                error: 'Failed to reload key pool',
                message: error.message
            });
        }
    });
    /**
     * POST /api/prompt-generator/thumbnail-ideas
     * Generate thumbnail ideas for YouTube video
     */
    app.post('/api/prompt-generator/thumbnail-ideas', async (request, reply) => {
        const body = z.object({
            title: z.string().optional().default(''),
            content: z.string().min(1, 'Video content is required'),
        }).parse(request.body);
        try {
            const result = await promptGeneratorService.generateThumbnailIdeas({
                title: body.title,
                content: body.content,
            });
            reply.send(result);
        }
        catch (error) {
            reply.code(500).send({
                error: 'Failed to generate thumbnail ideas',
                message: error.message
            });
        }
    });
    /**
     * POST /api/prompt-generator/thumbnail-prompt
     * Generate image prompt for a specific thumbnail idea
     */
    app.post('/api/prompt-generator/thumbnail-prompt', async (request, reply) => {
        const body = z.object({
            title: z.string().optional().default(''),
            content: z.string().min(1, 'Video content is required'),
            idea: z.object({
                text: z.string(),
                colors: z.string(),
                font: z.string(),
                visual: z.string(),
            }),
        }).parse(request.body);
        try {
            const prompt = await promptGeneratorService.generateThumbnailPrompt({
                title: body.title,
                content: body.content,
                idea: body.idea,
            });
            reply.send({ prompt });
        }
        catch (error) {
            reply.code(500).send({
                error: 'Failed to generate thumbnail prompt',
                message: error.message
            });
        }
    });
    /**
     * POST /api/prompt-generator/gemini-prompt-template
     * Build prompt template for Gemini automation (called from renderer)
     */
    app.post('/api/prompt-generator/gemini-prompt-template', async (request, reply) => {
        const body = z.object({
            script: z.string().min(1, 'Script is required'),
            characters: z.array(z.object({
                name: z.string(),
                promptEn: z.string(),
            })),
            style: z.string().default('Pixar style'),
            aspectRatio: z.string().default('16:9'),
            duration: z.number().int().positive().default(120),
            sceneCount: z.number().int().positive().default(15),
            outputType: z.enum(['image', 'video', 'both']).optional().default('both'),
        }).parse(request.body);
        try {
            const prompt = await promptGeneratorService.buildGeminiPromptTemplate({
                script: body.script,
                characters: body.characters,
                style: body.style,
                aspectRatio: body.aspectRatio,
                duration: body.duration,
                sceneCount: body.sceneCount,
                outputType: body.outputType,
            });
            reply.send({ prompt });
        }
        catch (error) {
            reply.code(500).send({
                error: 'Failed to build prompt template',
                message: error.message
            });
        }
    });
    /**
     * POST /api/prompt-generator/expand-prompt-by-style
     * Expand a prompt using Veo3's generateExpandedPrompt API with style guidelines
     *
     * This endpoint takes a Gemini-generated prompt (or any user prompt) and
     * expands it with Veo3 API using the selected style preamble for professional enhancement
     */
    app.post('/api/prompt-generator/expand-prompt-by-style', async (request, reply) => {
        const body = z.object({
            userPrompt: z.string().min(1, 'User prompt is required'),
            style: z.string().default('default'),
            cookies: z.string().min(1, 'Cookies are required for Veo3 API'),
            sessionId: z.string().optional(),
        }).parse(request.body);
        try {
            const expandedPrompt = await promptGeneratorService.expandPromptByStyle({
                userPrompt: body.userPrompt,
                style: body.style,
                cookies: body.cookies,
                sessionId: body.sessionId,
            });
            reply.send({
                expandedPrompt,
                original: body.userPrompt,
                expansion: ((expandedPrompt.length - body.userPrompt.length) / body.userPrompt.length * 100).toFixed(1) + '%'
            });
        }
        catch (error) {
            reply.code(500).send({
                error: 'Failed to expand prompt',
                message: error.message
            });
        }
    });
    /**
     * POST /api/prompt-generator/expand-scenes
     * Expand all scene prompts with Veo3 style-based expansion
     *
     * Takes generated scenes and expands each videoPrompt with Veo3 API
     */
    app.post('/api/prompt-generator/expand-scenes', async (request, reply) => {
        const body = z.object({
            scenes: z.array(z.object({
                sceneName: z.string(),
                sceneDescription: z.string(),
                imagePrompt: z.string(),
                videoPrompt: z.string(),
            })),
            style: z.string().default('default'),
            cookies: z.string().min(1, 'Cookies are required for Veo3 API'),
            sessionId: z.string().optional(),
        }).parse(request.body);
        try {
            // Validate cookies format - must contain Veo3 session token
            if (!body.cookies.includes('__Secure-next-auth.session-token')) {
                return reply.code(400).send({
                    error: 'Invalid cookies format',
                    message: 'Profile cookies are missing or invalid. Please run "🔄 Kiểm tra kết nối" on your profile to refresh cookies, then try again.',
                });
            }
            // Filter essential cookies to avoid HTTP 431 (Request Header Fields Too Large).
            //
            // EXPLICIT ALLOWLIST — no wildcards. A previous wildcard
            // `name.startsWith('__Secure-') || name.startsWith('__Host-')` accidentally
            // pulled in YouTube / Maps / Calendar session cookies when the Chrome
            // profile is also signed into those services, blowing past the 4KB header
            // limit. Must mirror the allowlist in `apps/server/src/lib/cookieJar.ts`
            // so both endpoints behave identically across consumer + workspace
            // account types.
            const ESSENTIAL_COOKIE_PATTERNS = [
                // Core Google auth (consumer + workspace)
                'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
                // First-party SID family (primarily consumer accounts — workspace ships
                // the 1PSID/1PAPISID base but not 1PSIDTS)
                '__Secure-1PSID', '__Secure-1PAPISID', '__Secure-1PSIDTS', '__Secure-1PSIDCC',
                // Third-party SID family (consumer + workspace cross-app session)
                '__Secure-3PSID', '__Secure-3PAPISID', '__Secure-3PSIDTS', '__Secure-3PSIDCC',
                // Workspace SSO essentials — admin (workspace) needs these because it
                // lacks the consumer-only `__Secure-1PSIDTS` trust anchor; without
                // these in the allow-list NextAuth /api/auth/session returns `{}` and
                // reCAPTCHA Enterprise scores subsequent submits as bot → 403.
                'LSID', 'LSOSID', 'OSID', 'S', '__Secure-OSID',
                'SIDCC', 'OGPC', 'OGP', 'ACCOUNT_CHOOSER',
                '__Host-1PLSID', '__Host-3PLSID', '__Host-GAPS',
                // Tracking / continuity (both flows; small footprint)
                'NID', '1P_JAR', '3P_JAR', 'AEC',
                '__Secure-ENID', 'CONSENT', 'SOCS',
                // NextAuth (labs.google session)
                '__Secure-next-auth.session-token',
                '__Secure-next-auth.callback-url',
                '__Host-next-auth.csrf-token',
                // Account identity
                'email', 'EMAIL',
            ];
            const isEssentialCookie = (cookie) => {
                const name = typeof cookie === 'string' ? cookie.split('=')[0].trim() : cookie.name;
                return ESSENTIAL_COOKIE_PATTERNS.includes(name);
            };
            let filteredCookies;
            try {
                // Parse as JSON array (format from browser partition)
                const parsed = JSON.parse(body.cookies.trim());
                if (Array.isArray(parsed)) {
                    const essentialCookies = parsed.filter(isEssentialCookie);
                    filteredCookies = essentialCookies
                        .map((cookie) => `${cookie.name}=${cookie.value}`)
                        .join('; ');
                    logger.info(`[Expand] Filtered cookies (JSON): ${essentialCookies.length}/${parsed.length} (${filteredCookies.length} bytes vs ${body.cookies.length} original)`);
                }
                else {
                    // Not an array, use as-is
                    filteredCookies = body.cookies;
                    logger.info(`[Expand] Cookies not array format, using as-is`);
                }
            }
            catch {
                // Not JSON - assume cookie header string format
                const cookiePairs = body.cookies.split(';').map(c => c.trim());
                const essentialPairs = cookiePairs.filter(isEssentialCookie);
                filteredCookies = essentialPairs.join('; ');
                logger.info(`[Expand] Filtered cookies (string): ${essentialPairs.length}/${cookiePairs.length} (${filteredCookies.length} bytes vs ${body.cookies.length} original)`);
            }
            const expandedScenes = await promptGeneratorService.expandScenes({
                scenes: body.scenes,
                style: body.style,
                cookies: filteredCookies, // Use filtered cookies
                sessionId: body.sessionId,
            });
            // Calculate statistics
            const stats = {
                total: expandedScenes.length,
                success: expandedScenes.filter(s => !s.expansionError).length,
                failed: expandedScenes.filter(s => s.expansionError).length,
            };
            reply.send({
                scenes: expandedScenes,
                stats,
            });
        }
        catch (error) {
            reply.code(500).send({
                error: 'Failed to expand scenes',
                message: error.message || 'An unexpected error occurred during scene expansion.',
            });
        }
    });
    /**
     * POST /api/prompt-generator/gemini-video-prompt-template
     * Build video-only prompt template for Gemini automation (called from renderer)
     */
    app.post('/api/prompt-generator/gemini-video-prompt-template', async (request, reply) => {
        const body = z.object({
            script: z.string().min(1, 'Script is required'),
            characters: z.array(z.object({
                name: z.string(),
                promptEn: z.string(),
            })),
            style: z.string().default('Pixar style'),
            aspectRatio: z.string().default('16:9'),
            duration: z.number().int().positive().default(120),
            sceneCount: z.number().int().positive().default(15),
        }).parse(request.body);
        try {
            const prompt = await promptGeneratorService.buildGeminiVideoPromptTemplate({
                script: body.script,
                characters: body.characters,
                style: body.style,
                aspectRatio: body.aspectRatio,
                duration: body.duration,
                sceneCount: body.sceneCount,
            });
            reply.send({ prompt });
        }
        catch (error) {
            reply.code(500).send({
                error: 'Failed to build video prompt template',
                message: error.message
            });
        }
    });
    /**
     * POST /api/prompt-generator/gemini-short-video-prompt-template
     * Build short video prompt template with exact 8-second segments for Gemini automation
     */
    app.post('/api/prompt-generator/gemini-short-video-prompt-template', async (request, reply) => {
        const body = z.object({
            script: z.string().min(1, 'Script is required'),
            style: z.string().default('Pixar style'),
            aspectRatio: z.string().default('9:16'),
            outputType: z.enum(['image', 'video', 'both']).optional().default('both'),
            contentType: z.enum(['affiliate', 'story', 'lifestyle', 'tutorial', 'dharma', 'normal']).optional(),
        }).parse(request.body);
        try {
            const prompt = await promptGeneratorService.buildGeminiShortVideoPromptTemplate({
                script: body.script,
                style: body.style,
                aspectRatio: body.aspectRatio,
                outputType: body.outputType,
                contentType: body.contentType,
            });
            reply.send({ prompt });
        }
        catch (error) {
            reply.code(500).send({
                error: 'Failed to build short video prompt template',
                message: error.message
            });
        }
    });
    // =============================================
    // PRO EDITOR API ROUTES (Replaces Browser Automation)
    // =============================================
    /**
     * POST /api/prompt-generator/generate-metadata
     * Generate metadata and characters from idea using Gemini API
     */
    app.post('/api/prompt-generator/generate-metadata', async (request, reply) => {
        const body = z.object({
            idea: z.string().min(1, 'Idea is required'),
            genreId: z.string().default('children'),
            visualStyleId: z.string().default('pixar_3d'),
            audience: z.string().default('Kids'),
            dialogueLanguage: z.enum(['vi-VN', 'en-US']).default('vi-VN'),
            sceneCount: z.union([z.number().int().positive(), z.literal('auto')]).default('auto'),
        }).parse(request.body);
        try {
            const metadata = await promptGeneratorService.generateMetadataFromIdea({
                idea: body.idea,
                genreId: body.genreId,
                visualStyleId: body.visualStyleId,
                audience: body.audience,
                dialogueLanguage: body.dialogueLanguage,
                sceneCount: body.sceneCount,
            });
            reply.send({ metadata });
        }
        catch (error) {
            reply.code(500).send({
                error: 'Failed to generate metadata',
                message: error.message
            });
        }
    });
    /**
     * POST /api/prompt-generator/generate-scene-outlines
     * Generate scene outlines from metadata
     */
    app.post('/api/prompt-generator/generate-scene-outlines', async (request, reply) => {
        const body = z.object({
            metadata: z.object({
                title: z.string(),
                genre: z.string(),
                audience: z.string(),
                summary: z.string().optional(),
                mood: z.array(z.string()).optional(),
                sceneCount: z.number(),
                totalDuration: z.number().optional(),
                characters: z.array(z.any()),
            }),
            idea: z.string(),
            audience: z.string(),
            dialogueLanguage: z.enum(['vi-VN', 'en-US']).default('vi-VN'),
            targetSceneCount: z.number().int().positive(),
        }).parse(request.body);
        try {
            const sceneOutlines = await promptGeneratorService.generateSceneOutlines({
                metadata: body.metadata,
                idea: body.idea,
                audience: body.audience,
                dialogueLanguage: body.dialogueLanguage,
                targetSceneCount: body.targetSceneCount,
            });
            reply.send({ sceneOutlines });
        }
        catch (error) {
            reply.code(500).send({
                error: 'Failed to generate scene outlines',
                message: error.message
            });
        }
    });
    /**
     * POST /api/prompt-generator/generate-detailed-scenes
     * Generate detailed scenes with veoPrompt from outlines
     */
    app.post('/api/prompt-generator/generate-detailed-scenes', async (request, reply) => {
        const body = z.object({
            metadata: z.object({
                title: z.string(),
                genre: z.string(),
                audience: z.string(),
                characters: z.array(z.any()),
            }),
            sceneOutlines: z.array(z.object({
                sceneNumber: z.number(),
                title: z.string(),
                description: z.string(),
                characters: z.array(z.string()).optional(),
                emotion: z.string().optional(),
                setting: z.string().optional(),
            })),
            idea: z.string(),
            visualStyleId: z.string(),
            dialogueLanguage: z.enum(['vi-VN', 'en-US']).default('vi-VN'),
        }).parse(request.body);
        try {
            const scenes = await promptGeneratorService.generateDetailedScenes({
                metadata: body.metadata,
                sceneOutlines: body.sceneOutlines,
                idea: body.idea,
                visualStyleId: body.visualStyleId,
                dialogueLanguage: body.dialogueLanguage,
            });
            reply.send({ scenes });
        }
        catch (error) {
            reply.code(500).send({
                error: 'Failed to generate detailed scenes',
                message: error.message
            });
        }
    });
    /**
     * POST /api/prompt-generator/text-to-script
     * Convert raw text to script format
     */
    app.post('/api/prompt-generator/text-to-script', async (request, reply) => {
        const body = z.object({
            text: z.string().min(1, 'Text is required'),
            title: z.string().min(1, 'Title is required'),
            genreId: z.string().default('children'),
            visualStyleId: z.string().default('pixar_3d'),
            audience: z.string().default('Kids'),
        }).parse(request.body);
        try {
            const result = await promptGeneratorService.convertTextToScript({
                text: body.text,
                title: body.title,
                genreId: body.genreId,
                visualStyleId: body.visualStyleId,
                audience: body.audience,
            });
            reply.send(result);
        }
        catch (error) {
            reply.code(500).send({
                error: 'Failed to convert text to script',
                message: error.message
            });
        }
    });
    /**
     * POST /api/prompt-generator/soften-style
     * Get softened style description
     */
    app.post('/api/prompt-generator/soften-style', async (request, reply) => {
        const body = z.object({
            style: z.string().min(1, 'Style is required'),
        }).parse(request.body);
        const description = promptGeneratorService.getSoftenStyle(body.style);
        reply.send({ description });
    });
}
