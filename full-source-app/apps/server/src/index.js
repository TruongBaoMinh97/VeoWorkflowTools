/**
 * Veo3Studio Backend Server — Entry Point
 */
import 'dotenv/config';
import { buildServer, logger } from './server.js';
import { initializeDatabase } from './database/initialize.js';
import { initializeCoreSystem, shutdownCoreSystem } from './core/init.js';
import { writeBootStatus, traceBoot } from './lib/bootStatus.js';
const start = async () => {
    try {
        // First executable line of the server child. The gap between the Electron
        // spawn() call and this breadcrumb ≈ process-creation + native-module load
        // cost; the mem snapshot flags whether the machine is under memory pressure
        // (the suspected cause of intermittent startup freezes on low-RAM Windows).
        traceBoot('process-start');
        logger.info('Starting Veo3Studio Backend Server...');
        logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
        logger.info(`Platform: ${process.platform} (${process.arch})`);
        // Diagnostic: log version + Chrome detection result (set by Electron main).
        // Use logger.warn so it survives production log-level filtering. Pinpoints
        // version skew issues when user shares only server log (Electron main log
        // is separate file user may not access).
        try {
            // Electron main process sets VEO3_APP_VERSION to the actual app version
            // (root package.json) before spawning server. Server's own
            // package.json shows "1.0.0" (internal — not useful for diag).
            const pkgPath = process.env.npm_package_version
                ? null
                : new URL('../package.json', import.meta.url);
            const appVersion = process.env.VEO3_APP_VERSION ||
                process.env.npm_package_version ||
                (pkgPath
                    ? (await import('node:fs/promises').then((fs) => fs.readFile(pkgPath, 'utf8').then((c) => JSON.parse(c).version)))
                    : 'unknown');
            logger.warn('[Veo3Service] startup diag', {
                appVersion,
                platform: process.platform,
                arch: process.arch,
                chromeMajor: process.env.VEO3_CHROME_MAJOR ?? '(unset)',
                chromeFull: process.env.VEO3_CHROME_FULL ?? '(unset)',
                chromeSource: process.env.VEO3_CHROME_SOURCE ?? '(unset)',
                useExtensionBridge: process.env.USE_EXTENSION_BRIDGE ?? '(unset)',
                browserRuntime: process.env.BROWSER_RUNTIME ?? '(unset)',
                httpDiag: process.env.VEO3_HTTP_DIAG ?? '(unset)',
            });
        }
        catch (e) {
            logger.warn('[Veo3Service] startup diag failed', { err: e?.message });
        }
        // Initialize directories
        const { initializeDefaultDirectories } = await import('./utils/directoryInit.js');
        initializeDefaultDirectories();
        // Initialize database
        await initializeDatabase();
        logger.info('Database initialized');
        // Initialize config from database
        const { config } = await import('./lib/config.js');
        await config.init();
        // Initialize core system (queue manager + workflows)
        await initializeCoreSystem();
        logger.info('Core system initialized');
        writeBootStatus('core-init-done');
        // Build and start server
        const app = buildServer();
        const port = Number(process.env.PORT) || 4000;
        const host = process.env.HOST ?? '127.0.0.1';
        // Fail loud if listen()/plugin-ready never completes. A fully-blocked event
        // loop can defeat this timer, but Fastify's pluginTimeout + the sync
        // boot-status sidecar still capture that case for triage.
        const listenGuard = setTimeout(() => {
            writeBootStatus('listen-timeout');
            logger.error('FATAL: app.listen() did not complete within 60s — forcing exit');
            process.exit(1);
        }, 60000);
        try {
            await app.listen({ port, host });
        }
        finally {
            clearTimeout(listenGuard);
        }
        logger.info(`Server listening on http://${host}:${port}`);
        writeBootStatus('server-listening');
        logger.info('Server started successfully');
    }
    catch (err) {
        writeBootStatus('failed', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
        logger.error('Failed to start server', { error: err });
        process.exit(1);
    }
};
// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down gracefully');
    await shutdownCoreSystem();
    process.exit(0);
});
process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down gracefully');
    await shutdownCoreSystem();
    process.exit(0);
});
void start();
