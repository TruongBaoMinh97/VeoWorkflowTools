/**
 * Fastify Server Builder
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerConfigRoutes } from "./modules/config/config.routes.js";
import { registerProfileRoutes } from "./modules/profiles/profile.routes.js";
import { registerPromptGeneratorRoutes } from "./modules/promptGenerator/promptGenerator.routes.js";
import { registerAdminRoutes } from "./modules/admin/admin.routes.js";
import { registerAuthRoutes } from "./modules/auth/auth.routes.js";
import { registerLicenseRoutes } from "./modules/license/license.routes.js";
import { registerApiKeyRoutes } from "./modules/apiKeys/apiKey.routes.js";
import { registerAiPromptRoutes } from "./modules/aiPrompt/aiPrompt.routes.js";
import { registerGenNormalRoutes } from "./modules/genNormal/genNormal.routes.js";
import { registerPromptRewriteRoutes } from "./modules/genNormal/promptRewrite.routes.js";
import { registerMangaStoryRoutes } from "./modules/genNormal/mangaStory.routes.js";
import { registerFrameExtractorRoutes } from "./modules/frameExtractor/frameExtractor.routes.js";
import { registerRemoveWatermarkRoutes } from "./modules/removeWatermark/removeWatermark.routes.js";
import { registerUpdateRoutes } from "./modules/update/update.routes.js";
import { registerGeminiApiRoutes } from "./modules/geminiApi/geminiApi.routes.js";
import { registerProxyRoutes } from "./modules/proxy/proxy.routes.js";
import { globalProxyManager } from "./lib/GlobalProxyManager.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { authenticateUser } from "./middleware/authMiddleware.js";
import { registerSystemRoutes } from "./routes/system.routes.js";
import { registerFileRoutes } from "./routes/file.routes.js";
import { registerAppSettingRoutes } from "./modules/appSettings/appSetting.routes.js";
import { registerCaptchaBridgeRoutes } from "./modules/captcha/captchaBridge.js";
import { registerWorkflowRoutes } from "./modules/workflow/workflow.routes.js";
import { registerWorkflowBatchRoutes } from "./modules/workflow/workflow.batch.routes.js";
import { registerDoodleVideoRoutes } from "./modules/doodleVideo/doodleVideo.routes.js";
import { registerScriptWriterRoutes } from "./modules/scriptWriter/scriptWriter.routes.js";
import { traceBoot } from "./lib/bootStatus.js";
const PUBLIC_PATHS = [
    "/health",
    "/api/health",
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/exchange",
    "/api/auth/refresh",
    "/api/auth/callback",
    "/api/auth/login-url",
    "/api/auth/forgot-password",
    "/api/auth/reset-password",
    "/api/gemini",
    "/api/internal/captcha",
    "/api/system/extension-status",
    "/api/workflow/media",
    "/docs",
];
export function buildServer() {
    const app = Fastify({
        logger: { level: process.env.LOG_LEVEL || "info" },
        disableRequestLogging: true,
        bodyLimit: 50 * 1024 * 1024,
        // A hung plugin registration must FAIL LOUD (app.listen rejects → we log +
        // exit) instead of hanging forever. Default is 10s; raised to 30s to tolerate
        // slow first-run module loads / AV on-access scans on some Windows machines.
        pluginTimeout: 30000,
    });
    // Swagger + Swagger-UI are docs-only (the /docs page). Skip them in production:
    // end users never need them, and Swagger-UI's static-asset handling during
    // registration is a plausible intermittent event-loop block (AV on-access scan
    // of its bundled assets) on some Windows machines — matching the observed
    // "server reaches core-init but never app.listen()" symptom. Dev keeps /docs.
    // if (process.env.NODE_ENV !== 'production') {
    //   void app.register(swagger as any, {
    //     openapi: {
    //       info: { title: 'Veo3Studio API', description: 'AI-powered video generation API', version: '3.0.0' },
    //       servers: [{ url: 'http://localhost:4000', description: 'Development server' }],
    //       tags: [
    //         { name: 'Profiles', description: 'Profile management endpoints' },
    //         { name: 'Queue', description: 'Job queue management endpoints' },
    //         { name: 'Admin', description: 'Admin and analytics endpoints' },
    //         { name: 'Config', description: 'Configuration endpoints' },
    //         { name: 'API Keys', description: 'API key management endpoints' },
    //       ],
    //     },
    //   } as any);
    //   void app.register(swaggerUI as any, {
    //     routePrefix: '/docs',
    //     uiConfig: { docExpansion: 'list', deepLinking: true, displayRequestDuration: true },
    //     staticCSP: true,
    //   } as any);
    // }
    void app.register(async () => traceBoot("ready-start"));
    void app.register(cors, { origin: true });
    void app.register(async () => traceBoot("after-cors"));
    app.addHook("onRequest", requestLogger);
    app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
        const raw = typeof body === "string" ? body : body.toString("utf8");
        if (!raw || raw.trim().length === 0) {
            done(null, undefined);
            return;
        }
        try {
            done(null, JSON.parse(raw));
        }
        catch (err) {
            done(err, undefined);
        }
    });
    app.addHook("onRequest", async (request, reply) => {
        const url = request.url;
        if (!url.startsWith("/api/"))
            return;
        const isPublic = PUBLIC_PATHS.some((p) => url === p || url.startsWith(p + "/") || url.startsWith(p + "?"));
        if (isPublic)
            return;
        await authenticateUser(request, reply);
    });
    app.get("/health", async () => ({
        status: "ok",
        timestamp: new Date().toISOString(),
    }));
    app.get("/api/health", async () => ({
        status: "ok",
        timestamp: new Date().toISOString(),
    }));
    // Register every route plugin, each preceded by a synchronous boot-status
    // breadcrumb. If a plugin blocks the event loop during Fastify's ready
    // sequence (the "reaches core-init but never app.listen()" bug), boot-status.json
    // is left at `before:<name>` — pinpointing the exact culprit on the next launch.
    // scriptWriter is now a STATIC import (an in-plugin dynamic import() could hang
    // ready on some Windows machines).
    const routePlugins = [
        ["captcha", registerCaptchaBridgeRoutes],
        ["config", registerConfigRoutes],
        ["profile", registerProfileRoutes],
        ["apiKey", registerApiKeyRoutes],
        ["aiPrompt", registerAiPromptRoutes],
        ["genNormal", registerGenNormalRoutes],
        ["promptRewrite", registerPromptRewriteRoutes],
        ["mangaStory", registerMangaStoryRoutes],
        ["update", registerUpdateRoutes],
        ["gemini", registerGeminiApiRoutes],
        ["proxy", registerProxyRoutes],
        ["admin", registerAdminRoutes],
        ["promptGenerator", registerPromptGeneratorRoutes],
        ["auth", registerAuthRoutes],
        ["license", registerLicenseRoutes],
        ["scriptWriter", registerScriptWriterRoutes],
        ["appSetting", registerAppSettingRoutes],
        ["system", registerSystemRoutes],
        ["file", registerFileRoutes],
        ["frameExtractor", registerFrameExtractorRoutes],
        ["removeWatermark", registerRemoveWatermarkRoutes],
        ["workflow", registerWorkflowRoutes],
        ["workflowBatch", registerWorkflowBatchRoutes],
        ["doodle", registerDoodleVideoRoutes],
    ];
    for (const [name, plugin] of routePlugins) {
        void app.register(async () => traceBoot(`before:${name}`));
        void app.register(plugin);
    }
    void app.register(async () => traceBoot('all-plugins-registered'));
    // Background proxy init — fire-and-forget, order-independent (awaits immediately).
    void globalProxyManager
        .init()
        .catch((e) => logger.warn("[ProxyManager] init failed", e));
    app.setErrorHandler(errorHandler);
    return app;
}
import { logger } from "./lib/logger.js";
export { logger };
